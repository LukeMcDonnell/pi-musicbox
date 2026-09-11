#!/usr/bin/env bash
#
# musicbox — migrate-network.sh
#
# Moves NetworkManager connection storage from netplan YAML to NM's native
# keyfiles, so nothing invokes netplan at boot.
#
# WHY THIS EXISTS
#   Raspberry Pi Imager provisions via cloud-init, which writes netplan, which
#   backs NetworkManager. On startup NM round-trips every connection through
#   netplan's YAML store, and each write triggers a full systemd daemon-reload
#   (~720ms on a Pi 4). Four connections cost ~5.3s before DHCP even starts.
#
#   netplan.io CANNOT simply be purged: network-manager depends on it on Pi OS,
#   so removing it takes NetworkManager with it. Instead we move the connection
#   *storage* and leave the package in place.
#
#   Measured on a Pi 4B: NetworkManager.service 6.0s -> 2.3s,
#   netplan generate calls 4 -> 0, total boot 14.6s -> 8.7s.
#
# SAFETY
#   This rewrites the network config of the machine you are probably connected
#   through. It backs everything up first, and installs a watchdog that reverts
#   and reboots if the network is still down some seconds after the next boot.
#   Run --finish once you are satisfied, or --revert to roll back by hand.
#
# Usage:
#   sudo ./migrate-network.sh --dry-run     # show what would change
#   sudo ./migrate-network.sh               # migrate, arm the watchdog
#   sudo reboot
#   sudo ./migrate-network.sh --finish      # disarm the watchdog
#   sudo ./migrate-network.sh --revert      # restore the pre-migration config
#
#   ./migrate-network.sh --convert-only SRC DEST
#       Pure conversion of netplan YAML in SRC to keyfiles in DEST. Touches no
#       system state; used by the test-suite and for inspecting output first.

set -euo pipefail

readonly SCRIPT_VERSION="1.0.0"
readonly NETPLAN_DIR="/etc/netplan"
readonly KEYFILE_DIR="/etc/NetworkManager/system-connections"
readonly STATE_DIR="/var/lib/musicbox"
readonly DISABLED_DIR="${STATE_DIR}/netplan-disabled"
readonly WATCHDOG_BIN="/usr/local/sbin/musicbox-net-watchdog"
readonly WATCHDOG_UNIT="/etc/systemd/system/musicbox-net-watchdog.service"
readonly WATCHDOG_TIMER="/etc/systemd/system/musicbox-net-watchdog.timer"
readonly BASE_NETPLAN="/lib/netplan/00-network-manager-all.yaml"

# Seconds after boot before the watchdog checks connectivity.
WATCHDOG_DELAY=120

DRY_RUN=0
ASSUME_YES=0
MODE="migrate"

if [[ -t 1 ]]; then
    C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
    C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'
else
    C_RESET=""; C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""
fi

phase() { printf '\n%s==> %s%s\n' "${C_BOLD}${C_BLUE}" "$*" "${C_RESET}"; }
log()   { printf '    %s\n' "$*"; }
ok()    { printf '    %s+%s %s\n' "${C_GREEN}" "${C_RESET}" "$*"; }
skip()  { printf '    %s.%s %s\n' "${C_DIM}" "${C_RESET}" "${C_DIM}$*${C_RESET}"; }
warn()  { printf '    %s!%s %s\n' "${C_YELLOW}" "${C_RESET}" "$*" >&2; }
die()   { printf '\n%sERROR:%s %s\n' "${C_RED}${C_BOLD}" "${C_RESET}" "$*" >&2; exit 1; }
dry()   { [[ "$DRY_RUN" -eq 1 ]]; }

run() {
    if dry; then printf '    %s[dry-run]%s %s\n' "${C_DIM}" "${C_RESET}" "$*"
    else "$@"; fi
}

usage() { sed -n '3,32p' "$0" | sed 's/^# \{0,1\}//'; }

# ---------------------------------------------------------------------------
# Conversion: netplan YAML -> NM keyfiles. Pure; no system state touched.
# ---------------------------------------------------------------------------
convert_netplan_dir() {
    local src="$1" dest="$2"
    python3 - "$src" "$dest" <<'PYCONV'
import glob, os, sys, uuid

try:
    import yaml
except ImportError:
    sys.stderr.write("ERROR: python3-yaml is required\n")
    sys.exit(2)

src, dest = sys.argv[1], sys.argv[2]
os.makedirs(dest, exist_ok=True)
os.chmod(dest, 0o700)


def ip_section(family, cfg):
    """Build an [ipvN] section from a netplan interface config."""
    lines = ["", f"[{family}]"]
    dhcp_key = "dhcp4" if family == "ipv4" else "dhcp6"
    addrs = [a for a in (cfg.get("addresses") or [])
             if (":" in str(a)) == (family == "ipv6")]

    if cfg.get(dhcp_key):
        lines.append("method=auto")
    elif addrs:
        lines.append("method=manual")
        for i, a in enumerate(addrs, 1):
            lines.append(f"address{i}={a}")
    else:
        lines.append("method=auto" if family == "ipv4" else "method=auto")

    ns = ((cfg.get("nameservers") or {}).get("addresses") or [])
    ns = [n for n in ns if (":" in str(n)) == (family == "ipv6")]
    if ns:
        lines.append("dns=" + ";".join(str(n) for n in ns) + ";")
        lines.append("ignore-auto-dns=true")

    if family == "ipv6":
        lines.append("addr-gen-mode=default")
    return lines


def write_conn(dest, name, lines):
    path = os.path.join(dest, f"{name}.nmconnection")
    with open(path, "w") as fh:
        fh.write("\n".join(lines).lstrip("\n") + "\n")
    # NM SILENTLY IGNORES keyfiles that are not 0600 root-owned.
    os.chmod(path, 0o600)
    return path


count = 0
for path in sorted(glob.glob(os.path.join(src, "*.yaml"))):
    with open(path) as fh:
        doc = yaml.safe_load(fh) or {}
    net = doc.get("network") or {}

    for kind, key in (("ethernet", "ethernets"), ("wifi", "wifis")):
        for iface, cfg in (net.get(key) or {}).items():
            cfg = cfg or {}
            nm = cfg.get("networkmanager") or {}

            if kind == "wifi":
                aps = cfg.get("access-points") or {}
                if not aps:
                    sys.stderr.write(f"  skip {iface}: wifi with no access-points\n")
                    continue
            else:
                aps = {None: {}}

            for ssid, ap in aps.items():
                ap = ap or {}
                apnm = ap.get("networkmanager") or nm
                cid = apnm.get("name") or nm.get("name") or f"musicbox-{iface}"
                cuuid = apnm.get("uuid") or nm.get("uuid") or str(uuid.uuid4())

                lines = ["[connection]",
                         f"id={cid}",
                         f"uuid={cuuid}",
                         f"type={'wifi' if kind == 'wifi' else 'ethernet'}",
                         f"interface-name={iface}",
                         "autoconnect=true",
                         f"autoconnect-priority={100 if kind == 'wifi' else 200}"]

                if kind == "wifi":
                    lines += ["", "[wifi]", "mode=infrastructure", f"ssid={ssid}"]
                    auth = ap.get("auth") or {}
                    psk = auth.get("password") or ap.get("password")
                    keymgmt = (auth.get("key-management") or "psk").lower()
                    if psk:
                        nmkey = {"psk": "wpa-psk", "sae": "sae",
                                 "eap": "wpa-eap"}.get(keymgmt, "wpa-psk")
                        lines += ["", "[wifi-security]",
                                  f"key-mgmt={nmkey}", f"psk={psk}"]

                lines += ip_section("ipv4", cfg)
                lines += ip_section("ipv6", cfg)

                fname = cid if cid else f"{iface}"
                write_conn(dest, fname, lines)
                label = f"ssid={ssid}" if ssid else "dhcp"
                print(f"  converted {kind:8s} {iface:8s} {label:28s} -> {fname}.nmconnection")
                count += 1

print(f"  {count} connection(s) converted")
if count == 0:
    sys.exit(3)
PYCONV
}

# ---------------------------------------------------------------------------
# Watchdog
# ---------------------------------------------------------------------------
install_watchdog() {
    local backup="$1"

    if dry; then
        printf '    %s[dry-run]%s would install revert-watchdog firing %ss after boot\n' \
            "${C_DIM}" "${C_RESET}" "$WATCHDOG_DELAY"
        return
    fi

    cat > "$WATCHDOG_BIN" <<WD
#!/bin/bash
# Installed by migrate-network.sh. If the network did not come up after the
# migration, restore the previous config and reboot. Removed by --finish.
set -u
BACKUP="${backup}"
LOG=/run/musicbox-net-watchdog.log
exec >>"\$LOG" 2>&1
echo "[\$(date -Is)] watchdog check"

state=\$(nmcli -t -f STATE general 2>/dev/null | head -1)
route=\$(ip route show default 2>/dev/null | head -1)
echo "  nmcli state: '\$state'  default route: '\$route'"

if [ "\$state" = "connected" ] && [ -n "\$route" ]; then
    echo "  network OK - no action"
    exit 0
fi

echo "  NETWORK DOWN - reverting"
systemctl disable --now musicbox-net-watchdog.timer || true
rm -f ${KEYFILE_DIR}/*.nmconnection
if [ -d "\$BACKUP/etc-netplan" ]; then
    cp -a "\$BACKUP/etc-netplan/." ${NETPLAN_DIR}/
fi
sync
echo "  reverted - rebooting"
systemctl reboot
WD
    chmod 0755 "$WATCHDOG_BIN"

    cat > "$WATCHDOG_UNIT" <<'UNIT'
[Unit]
Description=musicbox network migration watchdog (revert if network is down)
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/musicbox-net-watchdog
UNIT

    cat > "$WATCHDOG_TIMER" <<TIMER
[Unit]
Description=Run musicbox network watchdog after boot
[Timer]
OnBootSec=${WATCHDOG_DELAY}
AccuracySec=5s
Unit=musicbox-net-watchdog.service
[Install]
WantedBy=timers.target
TIMER

    systemctl daemon-reload
    systemctl enable musicbox-net-watchdog.timer >/dev/null 2>&1
    ok "watchdog armed — reverts and reboots if the network is down ${WATCHDOG_DELAY}s after boot"
}

remove_watchdog() {
    local found=0
    if [[ -f "$WATCHDOG_TIMER" || -f "$WATCHDOG_UNIT" || -f "$WATCHDOG_BIN" ]]; then
        found=1
    fi
    if [[ "$found" -eq 0 ]]; then
        skip "watchdog not installed"
        return
    fi
    run systemctl disable --now musicbox-net-watchdog.timer
    run rm -f "$WATCHDOG_TIMER" "$WATCHDOG_UNIT" "$WATCHDOG_BIN"
    run systemctl daemon-reload
    ok "watchdog removed"
}

# ---------------------------------------------------------------------------
# Modes
# ---------------------------------------------------------------------------
require_root() { [[ "$(id -u)" -eq 0 ]] || die "must run as root (try: sudo $0)"; }

do_revert() {
    require_root
    phase "Reverting network migration"

    local backup
    [[ -f "${STATE_DIR}/netbackup-latest" ]] || die "no backup pointer at ${STATE_DIR}/netbackup-latest"
    backup="$(cat "${STATE_DIR}/netbackup-latest")"
    [[ -d "$backup" ]] || die "backup directory $backup is missing"

    log "restoring from $backup"
    run rm -f "${KEYFILE_DIR}"/*.nmconnection
    run cp -a "${backup}/etc-netplan/." "${NETPLAN_DIR}/"
    remove_watchdog
    run nmcli connection reload
    ok "reverted — reboot to confirm"
}

do_finish() {
    require_root
    phase "Finishing migration"
    remove_watchdog
    log "netplan YAMLs remain in ${DISABLED_DIR} and can be deleted once you are happy"
}

do_migrate() {
    require_root
    phase "Preflight"

    command -v python3 >/dev/null || die "python3 is required"
    python3 -c 'import yaml' 2>/dev/null || die "python3-yaml is required (apt install python3-yaml)"
    command -v nmcli >/dev/null   || die "NetworkManager (nmcli) not found"

    local -a yamls=()
    while IFS= read -r f; do yamls+=("$f"); done < <(find "$NETPLAN_DIR" -maxdepth 1 -name '*.yaml' 2>/dev/null | sort)

    if [[ ${#yamls[@]} -eq 0 ]]; then
        skip "no YAML in ${NETPLAN_DIR} — already migrated, or nothing to do"
        exit 0
    fi
    log "found ${#yamls[@]} netplan file(s): ${yamls[*]##*/}"

    # --- preview the conversion before changing anything -------------------
    phase "Converting netplan YAML to NM keyfiles"
    local staging
    staging="$(mktemp -d)"
    # shellcheck disable=SC2064  # expand staging now, not at trap time
    trap "rm -rf '$staging'" EXIT

    convert_netplan_dir "$NETPLAN_DIR" "$staging" \
        || die "conversion produced no connections — refusing to continue"

    if dry; then
        phase "Keyfiles that would be written (secrets masked)"
        local f
        for f in "$staging"/*.nmconnection; do
            printf '    %s--- %s ---%s\n' "${C_DIM}" "$(basename "$f")" "${C_RESET}"
            sed -E 's/^(psk|password)=.*/\1=<MASKED>/' "$f" | sed 's/^/      /'
        done
        phase "Would then"
        log "back up ${NETPLAN_DIR}, ${KEYFILE_DIR} and NM config"
        log "install keyfiles 0600 into ${KEYFILE_DIR}"
        log "move netplan YAMLs to ${DISABLED_DIR}"
        log "chmod 0600 ${BASE_NETPLAN}"
        log "arm the revert watchdog (${WATCHDOG_DELAY}s after boot)"
        return
    fi

    if [[ "$ASSUME_YES" -ne 1 ]]; then
        printf '\n%sThis rewrites the network config of the machine you are probably connected through.%s\n' "${C_BOLD}" "${C_RESET}"
        printf 'A watchdog will revert and reboot if the network is down %ss after next boot.\n\n' "$WATCHDOG_DELAY"
        read -r -p "Continue? [y/N] " reply
        [[ "$reply" =~ ^[Yy]$ ]] || die "aborted by user"
    fi

    # --- backup ------------------------------------------------------------
    phase "Backup"
    local backup
    backup="${STATE_DIR}/netbackup-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$backup"
    cp -a "$NETPLAN_DIR" "${backup}/etc-netplan" 2>/dev/null || true
    cp -a /etc/NetworkManager "${backup}/etc-NetworkManager" 2>/dev/null || true
    nmcli -t connection show > "${backup}/nmcli-connections.txt" 2>/dev/null || true
    echo "$backup" > "${STATE_DIR}/netbackup-latest"
    ok "backed up to $backup"

    # --- install ------------------------------------------------------------
    phase "Installing keyfiles"
    install -d -m 0700 "$KEYFILE_DIR"
    local f
    for f in "$staging"/*.nmconnection; do
        install -m 0600 -o root -g root "$f" "${KEYFILE_DIR}/$(basename "$f")"
        ok "$(basename "$f")"
    done

    phase "Retiring netplan connection YAMLs"
    mkdir -p "$DISABLED_DIR"
    for f in "${yamls[@]}"; do
        mv "$f" "${DISABLED_DIR}/"
        ok "moved $(basename "$f") -> ${DISABLED_DIR}/"
    done

    if [[ -f "$BASE_NETPLAN" ]] && [[ "$(stat -c %a "$BASE_NETPLAN")" != "600" ]]; then
        chmod 0600 "$BASE_NETPLAN"
        ok "tightened ${BASE_NETPLAN} to 0600 (silences a per-generate warning)"
    fi

    phase "Watchdog"
    install_watchdog "$backup"

    phase "Verifying NM accepts the keyfiles"
    nmcli connection reload || warn "nmcli connection reload failed"
    sleep 2
    nmcli -t -f NAME,UUID,TYPE,DEVICE connection show | sed 's/^/    /'

    cat <<EOF

    ${C_BOLD}Next:${C_RESET}
      sudo reboot
      # if it comes back on the network:
      sudo $0 --finish
      # if something is wrong:
      sudo $0 --revert

    The watchdog reverts and reboots automatically if the network is still
    down ${WATCHDOG_DELAY}s after boot, so a mistake should self-heal.
EOF
}

# ---------------------------------------------------------------------------
main() {
    local conv_src="" conv_dest=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --dry-run)      DRY_RUN=1 ;;
            -y|--yes)       ASSUME_YES=1 ;;
            --finish)       MODE="finish" ;;
            --revert)       MODE="revert" ;;
            --convert-only) MODE="convert"; conv_src="${2:-}"; conv_dest="${3:-}"; shift 2 ;;
            --watchdog-delay) WATCHDOG_DELAY="${2:-120}"; shift ;;
            -h|--help)      usage; exit 0 ;;
            *)              usage >&2; die "unknown option: $1" ;;
        esac
        shift
    done

    printf '%smusicbox migrate-network.sh %s%s\n' "${C_BOLD}" "${SCRIPT_VERSION}" "${C_RESET}"
    dry && printf '%sDRY RUN — no changes will be made%s\n' "${C_YELLOW}" "${C_RESET}"

    case "$MODE" in
        convert)
            [[ -n "$conv_src" && -n "$conv_dest" ]] || die "--convert-only needs SRC and DEST"
            [[ -d "$conv_src" ]] || die "SRC directory not found: $conv_src"
            convert_netplan_dir "$conv_src" "$conv_dest"
            ;;
        finish) do_finish ;;
        revert) do_revert ;;
        *)      do_migrate ;;
    esac
}

main "$@"
