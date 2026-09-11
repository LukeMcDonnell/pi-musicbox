#!/usr/bin/env bash
#
# musicbox — setup.sh
#
# First script to run on a freshly-flashed Raspberry Pi OS Lite (Trixie) image.
# Strips packages/services this appliance will never use and cuts boot time.
#
# Deliberately DOES NOT configure hardware. No DAC overlay, no DSI panel, no
# hostname — those belong to install.sh. See README.md.
#
# Target: Raspberry Pi 4B / Pi OS Lite Trixie (Debian 13, kernel 6.12)
#         HiFiBerry DAC+ Standard (I2S HAT, has an EEPROM)
#         DFRobot DFR0550 5" 800x480 DSI touchscreen
#         Music library on an NFS/SMB share
#
# Safe to re-run: every change is guarded and idempotent.

set -euo pipefail

readonly SCRIPT_VERSION="1.0.0"
readonly BLOCK_BEGIN="# >>> musicbox setup.sh managed block >>>"
readonly BLOCK_END="# <<< musicbox setup.sh managed block <<<"

readonly BOOT_DIR="/boot/firmware"
readonly CONFIG_TXT="${BOOT_DIR}/config.txt"
readonly CMDLINE_TXT="${BOOT_DIR}/cmdline.txt"
readonly FSTAB="/etc/fstab"
readonly JOURNALD_DROPIN="/etc/systemd/journald.conf.d/musicbox.conf"
readonly STATE_DIR="/var/lib/musicbox"
readonly LOG_DIR="/var/log/musicbox-setup"
readonly BOOTREPORT="/usr/local/bin/musicbox-bootreport"
readonly CLOUD_INIT_DISABLED="/etc/cloud/cloud-init.disabled"

# ---------------------------------------------------------------------------
# Tunables
# ---------------------------------------------------------------------------

# Appliance trade-off: masking apt's timers stops the random disk churn of
# background updates, but also stops automatic security updates. Set to 0 to
# keep them.
MASK_APT_TIMERS=1

# Raspberry Pi Imager provisions via cloud-init, which then re-runs on every
# boot to reach the same conclusion (~2.3s, and it gates sysinit.target). Once
# first boot has completed, everything it configured is already persisted in
# /etc. Set to 0 to leave it running.
DISABLE_CLOUD_INIT=1

# Bootloader boot order. Empty means "leave the bootloader's own default alone",
# which is the right choice unless you have a specific reason to change it:
# boot modes are tried in order and stop on success, so the stock SD-then-USB
# order costs nothing while the SD card works, and it keeps a USB recovery path
# if the card ever fails. Set e.g. "0xf1" (SD only) to override.
BOOT_ORDER=""

DRY_RUN=0
ASSUME_YES=0
DO_EEPROM=1
SD_OVERCLOCK=0
FORCE=0

CHANGED=0
SKIPPED=0
declare -a NOTES=()

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

if [[ -t 1 ]]; then
    C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
    C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'
else
    C_RESET=""; C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""
fi

phase()  { printf '\n%s==> %s%s\n' "${C_BOLD}${C_BLUE}" "$*" "${C_RESET}"; }
log()    { printf '    %s\n' "$*"; }
ok()     { printf '    %s+%s %s\n' "${C_GREEN}" "${C_RESET}" "$*"; }
skip()   { printf '    %s.%s %s\n' "${C_DIM}" "${C_RESET}" "${C_DIM}$*${C_RESET}"; SKIPPED=$((SKIPPED + 1)); }
warn()   { printf '    %s!%s %s\n' "${C_YELLOW}" "${C_RESET}" "$*" >&2; }
die()    { printf '\n%sERROR:%s %s\n' "${C_RED}${C_BOLD}" "${C_RESET}" "$*" >&2; exit 1; }
note()   { NOTES+=("$*"); }

dry()    { [[ "$DRY_RUN" -eq 1 ]]; }

# Run a command, or describe it under --dry-run.
run() {
    if dry; then
        printf '    %s[dry-run]%s %s\n' "${C_DIM}" "${C_RESET}" "$*"
    else
        "$@"
    fi
}

usage() {
    cat <<'USAGE'
musicbox setup.sh — OS cleanup and boot optimisation for Raspberry Pi OS Lite

Usage: sudo ./setup.sh [options]

Options:
  --dry-run        Show every change that would be made, change nothing.
                   Run this first on a new image.
  --yes, -y        Skip the confirmation prompt
  --no-eeprom      Skip the bootloader EEPROM phase (Phase 5)
  --sd-overclock   Opt in to sdtweak overclock_50=100 (card-dependent)
  --force          Continue even if the board/OS check fails
  --help, -h       This message

Safe to re-run. Re-running reports no changes on an already-configured system.
USAGE
}

# ---------------------------------------------------------------------------
# Predicates
# ---------------------------------------------------------------------------

# Installed packages matching a name or glob, one per line.
pkgs_matching() {
    dpkg-query -W -f='${Package} ${db:Status-Status}\n' "$1" 2>/dev/null \
        | awk '$2 == "installed" { print $1 }' || true
}

unit_exists() {
    systemctl list-unit-files --no-pager --no-legend -- "$1" 2>/dev/null | grep -q .
}

unit_is_enabled() {
    local state
    state="$(systemctl is-enabled -- "$1" 2>/dev/null || true)"
    [[ "$state" == "enabled" || "$state" == "enabled-runtime" ]]
}

unit_is_masked() {
    [[ "$(systemctl is-enabled -- "$1" 2>/dev/null || true)" == "masked" ]]
}

# ---------------------------------------------------------------------------
# Mutation helpers — idempotency lives here, not at the call sites
# ---------------------------------------------------------------------------

# install_if_changed <tmpfile> <dest> [mode]
# Returns 0 if it changed (or would), 1 if already up to date.
install_if_changed() {
    local tmp="$1" dest="$2" mode="${3:-0644}"

    if cmp -s "$tmp" "$dest" 2>/dev/null; then
        rm -f "$tmp"
        return 1
    fi

    if dry; then
        printf '    %s[dry-run]%s would update %s:\n' "${C_DIM}" "${C_RESET}" "$dest"
        if [[ -f "$dest" ]]; then
            diff -u -- "$dest" "$tmp" 2>/dev/null | tail -n +3 | sed 's/^/        /' || true
        else
            sed 's/^/        + /' "$tmp"
        fi
        rm -f "$tmp"
        return 0
    fi

    install -D -m "$mode" "$tmp" "$dest"
    rm -f "$tmp"
    CHANGED=$((CHANGED + 1))
    return 0
}

# write_managed_block <file> <content>
# Replaces our delimited block in place, or appends it. Everything outside the
# delimiters is preserved byte-for-byte.
write_managed_block() {
    local file="$1" content="$2" tmp
    tmp="$(mktemp)"

    if [[ -f "$file" ]]; then
        awk -v b="$BLOCK_BEGIN" -v e="$BLOCK_END" '
            $0 == b { skip = 1; next }
            $0 == e { skip = 0; next }
            !skip   { print }
        ' "$file" > "$tmp"
        # Collapse trailing blank lines left behind by a removed block.
        local trimmed
        trimmed="$(mktemp)"
        printf '%s\n' "$(< "$tmp")" > "$trimmed"
        mv "$trimmed" "$tmp"
    fi

    {
        printf '\n%s\n' "$BLOCK_BEGIN"
        printf '%s\n' "$content"
        printf '%s\n' "$BLOCK_END"
    } >> "$tmp"

    install_if_changed "$tmp" "$file"
}

# cmdline.txt is a single line of space-separated tokens.
cmdline_has_token() {
    local want="$1" tok
    for tok in $(tr -s '[:space:]' ' ' < "$CMDLINE_TXT"); do
        [[ "$tok" == "$want" ]] && return 0
    done
    return 1
}

purge_packages() {
    local pattern pkg
    local -a found=()

    for pattern in "$@"; do
        while IFS= read -r pkg; do
            [[ -n "$pkg" ]] && found+=("$pkg")
        done < <(pkgs_matching "$pattern")
    done

    if [[ ${#found[@]} -eq 0 ]]; then
        return 1
    fi

    log "found: ${found[*]}"
    run env DEBIAN_FRONTEND=noninteractive apt-get -y purge "${found[@]}"
    dry || CHANGED=$((CHANGED + 1))
    return 0
}

disable_unit() {
    local unit="$1"

    if ! unit_exists "$unit"; then
        return 1
    fi
    if ! unit_is_enabled "$unit"; then
        skip "$unit already disabled"
        return 1
    fi

    run systemctl disable --now -- "$unit"
    dry || CHANGED=$((CHANGED + 1))
    ok "disabled $unit"
    return 0
}

mask_unit() {
    local unit="$1"

    if ! unit_exists "$unit"; then
        return 1
    fi
    if unit_is_masked "$unit"; then
        skip "$unit already masked"
        return 1
    fi

    run systemctl mask -- "$unit"
    dry || CHANGED=$((CHANGED + 1))
    ok "masked $unit"
    return 0
}

# ---------------------------------------------------------------------------
# Phase 0 — preflight and baseline measurement
# ---------------------------------------------------------------------------

# systemd-analyze only sees kernel + userspace. On a Pi the firmware stage
# underneath is often the largest of the three, and `vclog --msg` is the only
# view of it: timestamps are milliseconds since power-on. The first line marks
# roughly when the bootloader began (everything before it is BootROM and DRAM
# training, which is not improvable), and "Starting ARM" marks the hand-off to
# the kernel. Without these figures no EEPROM or config.txt change can be
# verified at all.
firmware_timings() {
    if ! command -v vclog >/dev/null 2>&1; then
        echo "vclog unavailable — pre-kernel stage cannot be measured"
        return 0
    fi

    local log
    log="$(vclog --msg 2>/dev/null)" || true
    if [[ -z "$log" ]]; then
        echo "vclog produced no output (needs root, or unsupported firmware)"
        return 0
    fi

    local first arm
    first="$(printf '%s\n' "$log" | head -n 1 | cut -d: -f1)"
    arm="$(printf '%s\n' "$log" | awk -F: '/Starting ARM/ { print $1; exit }')"

    printf 'bootloader_start_ms=%s\n' "${first:-unknown}"
    printf 'starting_arm_ms=%s\n'     "${arm:-unknown}"
    if [[ -n "$first" && -n "$arm" ]]; then
        awk -v a="$first" -v b="$arm" \
            'BEGIN { printf "firmware_stage_ms=%.0f\n", (b - a) }'
    fi
}

preflight() {
    phase "Phase 0 — preflight and baseline"

    [[ "$(id -u)" -eq 0 ]] || die "must run as root (try: sudo $0)"

    local model="unknown" codename="unknown"
    [[ -r /proc/device-tree/model ]] && model="$(tr -d '\0' < /proc/device-tree/model)"
    # shellcheck source=/dev/null
    [[ -r /etc/os-release ]] && codename="$(. /etc/os-release && printf '%s' "${VERSION_CODENAME:-unknown}")"

    log "board: ${model}"
    log "os:    ${codename}"

    local mismatch=0
    [[ "$model"    == *"Raspberry Pi 4"* ]] || { warn "not a Raspberry Pi 4B"; mismatch=1; }
    [[ "$codename" == "trixie"           ]] || { warn "not Raspberry Pi OS Trixie"; mismatch=1; }

    if [[ "$mismatch" -eq 1 && "$FORCE" -ne 1 ]]; then
        die "hardware/OS check failed. This script assumes a Pi 4B on Trixie. Re-run with --force to override."
    fi

    [[ -d "$BOOT_DIR"     ]] || die "$BOOT_DIR not found — is this Raspberry Pi OS?"
    [[ -f "$CONFIG_TXT"   ]] || die "$CONFIG_TXT not found"
    [[ -f "$CMDLINE_TXT"  ]] || die "$CMDLINE_TXT not found"

    # Measure before changing anything — the Raspberry Pi boot-time whitepaper is
    # emphatic that an unmeasured "optimisation" is a guess.
    local stamp baseline
    stamp="$(date +%Y%m%d-%H%M%S)"
    baseline="${LOG_DIR}/baseline-${stamp}.txt"

    if dry; then
        printf '    %s[dry-run]%s would record boot baseline to %s\n' "${C_DIM}" "${C_RESET}" "$baseline"
    else
        mkdir -p "$LOG_DIR" "$STATE_DIR"
        {
            echo "musicbox setup.sh ${SCRIPT_VERSION} — baseline ${stamp}"
            echo "board: ${model}"
            echo "os:    ${codename}"
            echo
            echo "=== systemd-analyze time ==="
            systemd-analyze time 2>&1 || echo "(unavailable)"
            echo
            echo "=== systemd-analyze blame ==="
            systemd-analyze blame 2>&1 | head -n 40 || echo "(unavailable)"
            echo
            echo "=== systemd-analyze critical-chain ==="
            systemd-analyze critical-chain 2>&1 || echo "(unavailable)"
            echo
            echo "=== firmware ==="
            vcgencmd version 2>&1 || echo "(unavailable)"
            echo
            echo "=== pre-kernel (firmware) stage ==="
            firmware_timings
            echo
            echo "=== vclog --msg (raw) ==="
            vclog --msg 2>/dev/null || echo "(vclog unavailable)"
        } > "$baseline"
        ln -sfn "$baseline" "${LOG_DIR}/baseline-latest.txt"
        ok "baseline recorded: ${baseline}"

        systemd-analyze time 2>/dev/null | sed 's/^/    /' || true
    fi
}

confirm() {
    [[ "$ASSUME_YES" -eq 1 ]] && return 0
    dry && return 0

    cat <<EOF

${C_BOLD}This will modify the running system:${C_RESET}
  - purge unused packages and disable unused services
  - edit ${CONFIG_TXT} and ${CMDLINE_TXT}
  - edit ${FSTAB} and make the systemd journal volatile
$( [[ "$DO_EEPROM" -eq 1 ]] && echo "  - update the bootloader EEPROM configuration" )

SSH, Bluetooth, NetworkManager and avahi-daemon are kept — this box needs them.

EOF
    read -r -p "Continue? [y/N] " reply
    [[ "$reply" =~ ^[Yy]$ ]] || die "aborted by user"
}

# ---------------------------------------------------------------------------
# Phase 1 — package purge
# ---------------------------------------------------------------------------

phase_packages() {
    phase "Phase 1 — package purge"

    # Only ever removed if dpkg confirms it is actually installed. The exact
    # package set of a Trixie Lite image is discovered, never assumed.
    local -a candidates=(
        triggerhappy            # GPIO/keyboard hotkey daemon
        modemmanager            # pulled in by NetworkManager; no cellular here
        rpi-connect             # remote access; we use SSH
        rpi-connect-lite
        'cups*'                 # no printing on a music box
        'printer-driver-*'
    )

    [[ "$MASK_APT_TIMERS" -eq 1 ]] && candidates+=(unattended-upgrades)

    if purge_packages "${candidates[@]}"; then
        ok "purged unused packages"
    else
        skip "no purge candidates installed"
    fi

    log "running autoremove"
    run env DEBIAN_FRONTEND=noninteractive apt-get -y autoremove --purge
    run apt-get clean

    log "${C_DIM}retained on purpose: bluez, avahi-daemon, network-manager, openssh-server, wireless firmware${C_RESET}"
}

# ---------------------------------------------------------------------------
# Phase 2 — service and timer trimming
# ---------------------------------------------------------------------------

# cloud-init re-runs every boot even though first boot is long finished. Only
# disabled once it reports "done" — disabling a first boot mid-flight would
# leave the machine half-provisioned.
disable_cloud_init() {
    if [[ "$DISABLE_CLOUD_INIT" -ne 1 ]]; then
        skip "cloud-init left enabled (DISABLE_CLOUD_INIT=0)"
        return
    fi
    if [[ -z "$(pkgs_matching cloud-init)" ]] && ! command -v cloud-init >/dev/null 2>&1; then
        return
    fi
    if [[ -f "$CLOUD_INIT_DISABLED" ]]; then
        skip "cloud-init already disabled"
        return
    fi

    local status
    # `cloud-init status` exits non-zero for some states. Without `|| true` the
    # pipeline failure would abort the whole script under `set -e -o pipefail`,
    # and the empty-status branch below could never be reached.
    status="$(cloud-init status 2>/dev/null | awk -F': *' '/^status:/ { print $2; exit }')" || true
    case "$status" in
        done|disabled)
            ;;
        "")
            warn "cloud-init present but status unreadable — not disabling"
            return
            ;;
        *)
            warn "cloud-init status is '${status}', not 'done' — not disabling (first boot may be incomplete)"
            return
            ;;
    esac

    run touch "$CLOUD_INIT_DISABLED"
    dry || CHANGED=$((CHANGED + 1))
    ok "cloud-init disabled (first boot already completed)"
    note "cloud-init is disabled via /etc/cloud/cloud-init.disabled. Delete that file to re-enable it; the package is left installed."
}


phase_services() {
    phase "Phase 2 — services and timers"

    disable_cloud_init

    # The single biggest win on this image. Safe here only because the NFS/SMB
    # mount must be declared with x-systemd.automount (install.sh's job) so that
    # nothing blocks boot waiting for the network.
    mask_unit NetworkManager-wait-online.service \
        && note "NetworkManager-wait-online is masked — install.sh MUST mount the music share with x-systemd.automount, not a blocking mount."

    local unit
    for unit in \
        rpi-eeprom-update.service \
        ModemManager.service \
        rpi-connect.service \
        rpi-connect-lite.service \
        man-db.timer
    do
        disable_unit "$unit" || true
    done

    if [[ "$MASK_APT_TIMERS" -eq 1 ]]; then
        for unit in apt-daily.timer apt-daily-upgrade.timer; do
            disable_unit "$unit" || true
        done
        note "apt auto-update timers are disabled: no automatic security updates. Set MASK_APT_TIMERS=0 in this script to keep them."
    else
        skip "apt timers left enabled (MASK_APT_TIMERS=0)"
    fi

    log "${C_DIM}kept running: bluetooth, hciuart, avahi-daemon, NetworkManager, ssh, systemd-timesyncd, fstrim.timer${C_RESET}"
}

# ---------------------------------------------------------------------------
# Phase 3 — /boot/firmware/config.txt
# ---------------------------------------------------------------------------

phase_config_txt() {
    phase "Phase 3 — ${CONFIG_TXT}"

    # The leading [all] matters: stock config.txt ends inside a model-specific
    # section filter, so an unqualified append would silently apply to the wrong
    # model (or to none).
    local block
    block="[all]
# Boot-time only. Hardware enablement (DAC+ overlay, DSI panel, audio) is
# deliberately left to install.sh.
disable_splash=1
boot_delay=0
camera_auto_detect=0
disable_poe_fan=1
initial_turbo=30

# NOT set, on purpose:
#   force_eeprom_read=0   general HAT-detection hazard; harmless on this
#                         particular DAC+, whose ID EEPROM is unprogrammed
#   max_framebuffers=0    headless-only; a DSI panel is attached
#   disable_fw_kms_setup  headless-only; a DSI panel is attached
#   display_auto_detect   DSI enablement belongs to install.sh
#   dtparam=audio=off     hardware enablement; install.sh"

    if [[ "$SD_OVERCLOCK" -eq 1 ]]; then
        block+="

dtoverlay=sdtweak,overclock_50=100"
        note "SD overclock enabled. If the card is not UHS-1 or better this can corrupt the filesystem — remove the sdtweak line from config.txt if boot becomes unreliable."
    fi

    if write_managed_block "$CONFIG_TXT" "$block"; then
        ok "managed block written to config.txt"
    else
        skip "config.txt already up to date"
    fi
}

# ---------------------------------------------------------------------------
# Phase 4 — /boot/firmware/cmdline.txt
# ---------------------------------------------------------------------------

phase_cmdline() {
    phase "Phase 4 — ${CMDLINE_TXT}"

    local current updated tmp
    current="$(tr -s '[:space:]' ' ' < "$CMDLINE_TXT" | sed 's/^ *//; s/ *$//')"
    updated="$current"

    local token
    for token in quiet logo.nologo; do
        if cmdline_has_token "$token"; then
            skip "cmdline already has '${token}'"
        else
            updated+=" ${token}"
            ok "adding '${token}'"
        fi
    done

    # Left alone on purpose: fsck.repair=yes and console=serial0,115200.
    # Both are recovery paths and worth more than the milliseconds they cost.

    if [[ "$updated" == "$current" ]]; then
        skip "cmdline.txt already up to date"
        return
    fi

    # Must stay exactly one line.
    tmp="$(mktemp)"
    printf '%s\n' "$updated" > "$tmp"
    install_if_changed "$tmp" "$CMDLINE_TXT" && ok "cmdline.txt updated"
}

# ---------------------------------------------------------------------------
# Phase 5 — bootloader EEPROM
# ---------------------------------------------------------------------------

# eeprom_merge_key <file> <key> <value>
# Sets key=value in an rpi-eeprom-config file: replaces the first occurrence,
# drops any duplicates, appends if absent.
eeprom_merge_key() {
    local file="$1" key="$2" val="$3"

    awk -v k="$key" -v v="$val" '
        BEGIN { done = 0 }
        $0 ~ "^[[:space:]]*" k "=" {
            if (!done) { print k "=" v; done = 1 }
            next
        }
        { print }
        END { if (!done) print k "=" v }
    ' "$file" > "${file}.new" && mv "${file}.new" "$file"
}

phase_eeprom() {
    phase "Phase 5 — bootloader EEPROM"

    if [[ "$DO_EEPROM" -ne 1 ]]; then
        skip "skipped (--no-eeprom)"
        return
    fi

    if ! command -v rpi-eeprom-config >/dev/null 2>&1; then
        warn "rpi-eeprom-config not found — skipping EEPROM phase"
        return
    fi

    local current tmp stamp saved
    current="$(rpi-eeprom-config 2>/dev/null || true)"

    if [[ -z "$current" ]]; then
        warn "could not read current EEPROM config — skipping"
        return
    fi

    tmp="$(mktemp)"
    printf '%s\n' "$current" > "$tmp"

    # Merge our keys into whatever is already there. BOOT_ORDER is only touched
    # when explicitly configured — see the tunable at the top of this file.
    local -a keys=("BOOT_UART=0" "NET_INSTALL_ENABLED=0" "NET_INSTALL_AT_POWER_ON=0")
    # Explicit `if` rather than `[[ ]] && …`: the latter returns 1 when the test
    # fails, which aborts the caller under `set -e` if it ever ends up last in a
    # function.
    if [[ -n "$BOOT_ORDER" ]]; then
        keys+=("BOOT_ORDER=${BOOT_ORDER}")
    fi

    local kv
    for kv in "${keys[@]}"; do
        eeprom_merge_key "$tmp" "${kv%%=*}" "${kv#*=}"
    done

    if [[ "$(cat "$tmp")" == "$current" ]]; then
        skip "EEPROM config already up to date"
        rm -f "$tmp"
        return
    fi

    log "changes:"
    diff -u <(printf '%s\n' "$current") "$tmp" 2>/dev/null | tail -n +3 | sed 's/^/        /' || true

    if dry; then
        printf '    %s[dry-run]%s would apply the above with rpi-eeprom-config --apply\n' "${C_DIM}" "${C_RESET}"
        rm -f "$tmp"
        return
    fi

    # Saving the current config is intrinsic to this operation, not general
    # backup machinery — it is the only rollback path for the bootloader.
    stamp="$(date +%Y%m%d-%H%M%S)"
    saved="${STATE_DIR}/eeprom-config.before-${stamp}.txt"
    mkdir -p "$STATE_DIR"
    printf '%s\n' "$current" > "$saved"
    ok "previous EEPROM config saved to ${saved}"

    if rpi-eeprom-config --apply "$tmp"; then
        CHANGED=$((CHANGED + 1))
        ok "EEPROM update staged — applied by the bootloader on next boot"
        note "EEPROM rollback: sudo rpi-eeprom-config --apply ${saved}"
    else
        warn "rpi-eeprom-config --apply failed; EEPROM left unchanged"
    fi

    rm -f "$tmp"
}

# ---------------------------------------------------------------------------
# Phase 6 — filesystem and write reduction
# ---------------------------------------------------------------------------

fstab_add_noatime() {
    local mp="$1" tmp
    tmp="$(mktemp)"

    awk -v mp="$mp" '
        BEGIN { OFS = "\t" }
        /^[[:space:]]*#/ { print; next }
        NF >= 4 && $2 == mp {
            if ($4 !~ /(^|,)noatime(,|$)/) $4 = $4 ",noatime"
            print; next
        }
        { print }
    ' "$FSTAB" > "$tmp"

    if install_if_changed "$tmp" "$FSTAB"; then
        ok "noatime on ${mp}"
    else
        skip "${mp} already has noatime (or is not in fstab)"
    fi
}

phase_filesystem() {
    phase "Phase 6 — filesystem and write reduction"

    fstab_add_noatime "/"
    fstab_add_noatime "$BOOT_DIR"

    # tmpfs for scratch space, inside a managed block so it can be lifted out.
    local block
    block="tmpfs	/tmp		tmpfs	defaults,noatime,nosuid,nodev,size=128M	0	0
tmpfs	/var/tmp	tmpfs	defaults,noatime,nosuid,nodev,size=64M	0	0"

    if grep -qE '^[^#]*[[:space:]]/tmp[[:space:]]' "$FSTAB" \
       && ! grep -qF "$BLOCK_BEGIN" "$FSTAB"; then
        skip "/tmp already has an fstab entry we did not write — leaving it alone"
    elif write_managed_block "$FSTAB" "$block"; then
        ok "tmpfs entries for /tmp and /var/tmp"
    else
        skip "fstab tmpfs entries already present"
    fi

    # Journal flushing at boot is a real cost on slow SD storage.
    local tmp
    tmp="$(mktemp)"
    cat > "$tmp" <<'JOURNALD'
# musicbox: keep the journal in RAM. Logs do not survive reboot — that is the
# point on an appliance running from an SD card.
[Journal]
Storage=volatile
RuntimeMaxUse=32M
JOURNALD

    if install_if_changed "$tmp" "$JOURNALD_DROPIN"; then
        ok "journald set to volatile storage"
    else
        skip "journald drop-in already up to date"
    fi

    check_swap

    log "${C_DIM}overlayfs (read-only root) is deliberately not enabled yet.${C_RESET}"
    log "${C_DIM}Once the stack is installed: sudo raspi-config nonint enable_overlayfs${C_RESET}"
}

check_swap() {
    local swaps
    swaps="$(swapon --show=NAME,TYPE --noheadings 2>/dev/null || true)"

    if [[ -z "$swaps" ]]; then
        skip "no swap active"
        return
    fi

    if grep -q 'zram' <<<"$swaps"; then
        skip "swap is zram-backed (in RAM, no SD wear) — left alone"
        return
    fi

    warn "disk-backed swap is active:"
    # shellcheck disable=SC2001  # per-line prefix; parameter expansion can't do this
    sed 's/^/        /' <<<"$swaps"

    if unit_exists dphys-swapfile.service; then
        disable_unit dphys-swapfile.service || true
        run swapoff -a
    else
        note "Disk-backed swap found but it is not dphys-swapfile. Disable it by hand — it causes constant SD card writes. Active: $(tr '\n' ' ' <<<"$swaps")"
    fi
}

# ---------------------------------------------------------------------------
# Phase 7 — report tooling and summary
# ---------------------------------------------------------------------------

install_bootreport() {
    local tmp
    tmp="$(mktemp)"
    cat > "$tmp" <<'BOOTREPORT'
#!/usr/bin/env bash
# musicbox-bootreport — compare the current boot against the baseline that
# setup.sh recorded before it made any changes.
set -euo pipefail

BASELINE="/var/log/musicbox-setup/baseline-latest.txt"

if [[ ! -f "$BASELINE" ]]; then
    echo "No baseline found at ${BASELINE}. Was setup.sh run?" >&2
    exit 1
fi

firmware_now() {
    command -v vclog >/dev/null 2>&1 || { echo "vclog unavailable"; return; }
    local log first arm
    log="$(vclog --msg 2>/dev/null)" || true
    [[ -n "$log" ]] || { echo "vclog produced no output (try: sudo $0)"; return; }
    first="$(printf '%s\n' "$log" | head -n 1 | cut -d: -f1)"
    arm="$(printf '%s\n' "$log" | awk -F: '/Starting ARM/ { print $1; exit }')"
    printf 'bootloader_start_ms=%s\n' "${first:-unknown}"
    printf 'starting_arm_ms=%s\n'     "${arm:-unknown}"
    [[ -n "$first" && -n "$arm" ]] && \
        awk -v a="$first" -v b="$arm" 'BEGIN { printf "firmware_stage_ms=%.0f\n", (b - a) }'
}

echo "=============================================="
echo " BEFORE (recorded by setup.sh)"
echo "=============================================="
sed -n '/=== systemd-analyze time ===/,/^$/p' "$BASELINE"
echo "--- pre-kernel (firmware) stage ---"
sed -n '/=== pre-kernel (firmware) stage ===/,/^$/p' "$BASELINE" | tail -n +2

echo "=============================================="
echo " NOW"
echo "=============================================="
systemd-analyze time || true
echo
echo "--- pre-kernel (firmware) stage ---"
firmware_now
echo
echo "NOTE: systemd-analyze cannot see the firmware stage. EEPROM and most
config.txt changes move only the figures above it, never the ones below."
echo
echo "--- slowest units now ---"
systemd-analyze blame 2>/dev/null | head -n 15 || true
echo
echo "--- critical chain now ---"
systemd-analyze critical-chain 2>/dev/null || true
BOOTREPORT

    if install_if_changed "$tmp" "$BOOTREPORT" 0755; then
        ok "installed ${BOOTREPORT}"
    else
        skip "${BOOTREPORT} already up to date"
    fi
}

write_stamp() {
    dry && return 0
    mkdir -p "$STATE_DIR"
    cat > "${STATE_DIR}/setup-stamp" <<EOF
script_version=${SCRIPT_VERSION}
last_run=$(date -Is)
boot_order=${BOOT_ORDER:-bootloader-default}
eeprom_applied=${DO_EEPROM}
mask_apt_timers=${MASK_APT_TIMERS}
EOF
}

summary() {
    phase "Summary"

    if dry; then
        printf '    %sDry run — nothing was changed.%s\n' "${C_BOLD}" "${C_RESET}"
        printf '    Re-run without --dry-run to apply.\n'
        return
    fi

    printf '    %d change(s) applied, %d already in place.\n' "$CHANGED" "$SKIPPED"

    if [[ ${#NOTES[@]} -gt 0 ]]; then
        printf '\n    %sNotes:%s\n' "${C_BOLD}${C_YELLOW}" "${C_RESET}"
        local n
        for n in "${NOTES[@]}"; do
            printf '      - %s\n' "$n"
        done
    fi

    if [[ "$CHANGED" -gt 0 ]]; then
        cat <<EOF

    ${C_BOLD}Reboot required.${C_RESET}   sudo reboot

    Then check the result:
      musicbox-bootreport

    And confirm nothing this box needs was broken:
      nmcli general status                 # network
      avahi-resolve -n "\$(hostname).local" # mDNS for the web UI
      bluetoothctl show                    # Bluetooth controller present
      aplay -l | grep hifiberry            # DAC+ (needs install.sh overlay first)
      lsblk                                # USB CD drive
EOF
    fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --dry-run)      DRY_RUN=1 ;;
            -y|--yes)       ASSUME_YES=1 ;;
            --no-eeprom)    DO_EEPROM=0 ;;
            --sd-overclock) SD_OVERCLOCK=1 ;;
            --force)        FORCE=1 ;;
            -h|--help)      usage; exit 0 ;;
            *)              usage >&2; die "unknown option: $1" ;;
        esac
        shift
    done

    printf '%smusicbox setup.sh %s%s\n' "${C_BOLD}" "${SCRIPT_VERSION}" "${C_RESET}"
    dry && printf '%sDRY RUN — no changes will be made%s\n' "${C_YELLOW}" "${C_RESET}"

    preflight
    confirm

    phase_packages
    phase_services
    phase_config_txt
    phase_cmdline
    phase_eeprom
    phase_filesystem

    phase "Phase 7 — report tooling"
    install_bootreport
    write_stamp

    summary
}

main "$@"
