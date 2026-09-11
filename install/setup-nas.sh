#!/usr/bin/env bash
#
# musicbox — setup-nas.sh
#
# Interactively mounts the music library from a NAS. Supports SMB/CIFS and NFS.
#
# Run order:
#   setup.sh -> setup-hardware.sh -> install.sh -> setup-nas.sh -> setup-kiosk.sh
#
# THIS SCRIPT INSTALLS NOTHING. The clients (cifs-utils, nfs-common, smbclient)
# come from install.sh. If one is missing this exits pointing you there.
#
# THE RULE THAT GOVERNS THE FSTAB ENTRY
#   setup.sh masks NetworkManager-wait-online, which is only safe because
#   nothing in fstab waits for the network. A plain _netdev mount here would
#   reintroduce the boot delay and can hang boot entirely when the NAS is off.
#
#   So the entry is always lazy:
#       noauto,x-systemd.automount,x-systemd.idle-timeout=600,nofail
#
#   systemd creates an automount unit and mounts on first access. Boot never
#   waits. Do not "simplify" this to a normal mount.
#
# The share is mounted READ-ONLY: MPD only ever reads, and this removes any
# chance of the Pi damaging the library.
#
# Usage:
#   sudo ./setup-nas.sh                 # interactive
#   sudo ./setup-nas.sh --dry-run
#   sudo ./setup-nas.sh --revert
#
#   ./setup-nas.sh --emit-fstab --protocol smb --host nas --share Music \
#                  --mountpoint /srv/music
#       Print the generated fstab line and exit. Touches nothing; used by tests.

set -euo pipefail

readonly SCRIPT_VERSION="1.0.0"
readonly BLOCK_BEGIN="# >>> musicbox setup-nas.sh managed block >>>"
readonly BLOCK_END="# <<< musicbox setup-nas.sh managed block <<<"
readonly FSTAB="/etc/fstab"
readonly CONF_DIR="/etc/musicbox"
readonly CREDS="${CONF_DIR}/nas.credentials"
readonly STATE_DIR="/var/lib/musicbox"

# Lazy-mount options. Shared by both protocols. See the rule above.
readonly LAZY_OPTS="noauto,x-systemd.automount,x-systemd.idle-timeout=600,_netdev,nofail"

DRY_RUN=0
MODE="apply"
PROTO=""
HOST=""
SHARE=""
MOUNTPOINT="/srv/music"
USERNAME=""
PASSWORD=""

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

usage() { sed -n '3,40p' "$0" | sed 's/^# \{0,1\}//'; }

# ---------------------------------------------------------------------------
# fstab generation — pure, so --emit-fstab and the tests exercise the real code
# ---------------------------------------------------------------------------

# fstab uses whitespace as the field separator, so literal spaces in a path or
# share name MUST be written \040. Synology shares routinely contain spaces.
fstab_escape() {
    printf '%s' "$1" | sed -e 's/\\/\\134/g' -e 's/ /\\040/g' -e 's/\t/\\011/g'
}

smb_options() {
    # uid/gid + file_mode/dir_mode make the tree world-readable. MPD's user does
    # not exist yet and would never match a NAS uid anyway; read-only means
    # world-readable is harmless.
    # cache=loose is a real win on a read-only share.
    printf 'ro,credentials=%s,uid=0,gid=0,file_mode=0444,dir_mode=0555,iocharset=utf8,cache=loose,%s' \
        "$CREDS" "$LAZY_OPTS"
}

nfs_options() {
    # soft is not optional: with a hard mount, processes block forever when the
    # NAS disappears.
    printf 'ro,soft,timeo=50,retrans=3,%s' "$LAZY_OPTS"
}

# build_fstab_line <proto> <host> <share> <mountpoint>
build_fstab_line() {
    local proto="$1" host="$2" share="$3" mp="$4" src opts fstype

    case "$proto" in
        smb)
            src="//${host}/${share}"
            fstype="cifs"
            opts="$(smb_options)"
            ;;
        nfs)
            src="${host}:${share}"
            fstype="nfs"
            opts="$(nfs_options)"
            ;;
        *) die "unknown protocol: ${proto}" ;;
    esac

    printf '%s\t%s\t%s\t%s\t0\t0\n' \
        "$(fstab_escape "$src")" "$(fstab_escape "$mp")" "$fstype" "$opts"
}

write_managed_block() {
    local file="$1" content="$2" tmp trimmed
    tmp="$(mktemp)"
    if [[ -f "$file" ]]; then
        awk -v b="$BLOCK_BEGIN" -v e="$BLOCK_END" '
            $0 == b { skip = 1; next }
            $0 == e { skip = 0; next }
            !skip   { print }
        ' "$file" > "$tmp"
        trimmed="$(mktemp)"
        printf '%s\n' "$(< "$tmp")" > "$trimmed"
        mv "$trimmed" "$tmp"
    fi
    {
        printf '\n%s\n' "$BLOCK_BEGIN"
        # printf '%s\n', not '%s': callers pass "$(build_fstab_line ...)" and
        # command substitution strips the trailing newline. Without this the
        # closing marker lands on the end of the fstab record and the entry
        # parses as 12 fields instead of 6.
        printf '%s\n' "${content%$'\n'}"
        printf '%s\n' "$BLOCK_END"
    } >> "$tmp"
    printf '%s' "$tmp"
}

strip_managed_block() {
    local file="$1" tmp trimmed
    tmp="$(mktemp)"
    awk -v b="$BLOCK_BEGIN" -v e="$BLOCK_END" '
        $0 == b { skip = 1; next }
        $0 == e { skip = 0; next }
        !skip   { print }
    ' "$file" > "$tmp"
    trimmed="$(mktemp)"
    printf '%s\n' "$(< "$tmp")" > "$trimmed"
    mv "$trimmed" "$tmp"
    printf '%s' "$tmp"
}

# ---------------------------------------------------------------------------
# Interactive helpers
# ---------------------------------------------------------------------------
require_root() { [[ "$(id -u)" -eq 0 ]] || die "must run as root (try: sudo $0)"; }

need_binary() {
    local bin="$1" pkg="$2"
    command -v "$bin" >/dev/null 2>&1 && return 0
    die "${bin} not found (package: ${pkg}).
       Package installation lives in install.sh — run that first:
         sudo ./install/install.sh"
}

port_open() {
    local host="$1" port="$2"
    timeout 4 bash -c "exec 3<>/dev/tcp/${host}/${port}" 2>/dev/null
}

ask() {  # ask <prompt> <default> -> echoes answer
    local prompt="$1" def="${2:-}" reply
    if [[ -n "$def" ]]; then
        read -r -p "    ${prompt} [${def}]: " reply </dev/tty
        printf '%s' "${reply:-$def}"
    else
        read -r -p "    ${prompt}: " reply </dev/tty
        printf '%s' "$reply"
    fi
}

choose_from() {  # choose_from <item>... -> echoes chosen item
    local -a items=("$@")
    local i n
    for i in "${!items[@]}"; do
        printf '      %2d) %s\n' "$((i + 1))" "${items[$i]}" >&2
    done
    while true; do
        read -r -p "    Select [1-${#items[@]}]: " n </dev/tty
        if [[ "$n" =~ ^[0-9]+$ ]] && (( n >= 1 && n <= ${#items[@]} )); then
            printf '%s' "${items[$((n - 1))]}"
            return 0
        fi
        printf '    not a valid choice\n' >&2
    done
}

discover_smb() {  # -> share names on stdout
    command -v smbclient >/dev/null 2>&1 || return 1
    smbclient -L "//${HOST}" -U "${USERNAME}%${PASSWORD}" -g 2>/dev/null \
        | awk -F'|' '$1 == "Disk" && $2 !~ /\$$/ { print $2 }'
}

showmount_bin() {
    command -v showmount 2>/dev/null && return 0
    [[ -x /sbin/showmount ]] && { printf '/sbin/showmount'; return 0; }
    [[ -x /usr/sbin/showmount ]] && { printf '/usr/sbin/showmount'; return 0; }
    return 1
}

discover_nfs() {  # -> export paths on stdout
    local sm
    sm="$(showmount_bin)" || return 1
    timeout 10 "$sm" -e "$HOST" 2>/dev/null | awk 'NR > 1 { print $1 }'
}

# "access denied by server" is indistinguishable between "your IP is not in the
# rule" and "there are no exports at all". Asking the server which it is turns a
# dead end into an actionable message.
nfs_diagnose() {
    local sm exports
    sm="$(showmount_bin)" || return 0
    exports="$(timeout 10 "$sm" -e "$HOST" 2>/dev/null | awk 'NR > 1')"

    printf '\n'
    if [[ -z "$exports" ]]; then
        warn "The NFS server exports NOTHING at all:"
        log  "  \$ showmount -e ${HOST}   ->   (empty list)"
        log  ""
        log  "  NFS is running on the NAS, but no shared folder has an NFS rule."
        log  "  On a Synology: Control Panel > Shared Folder > select the folder"
        log  "  > Edit > NFS Permissions > Create"
        log  "      Hostname/IP : $(ip route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')"
        log  "      Privilege   : Read-only"
        log  "      Squash      : Map all users to admin"
        log  "  Then use the 'Mount path' that dialog shows at the bottom."
    else
        warn "The server does export shares, but not to this host:"
        printf '%s\n' "$exports" | sed 's/^/      /'
        log  ""
        log  "  This machine is $(ip route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')."
        log  "  Check the client list above includes it (or its subnet)."
    fi
    log ""
    log "  SMB needs no NAS-side configuration - re-run and choose smb instead."
}

# ---------------------------------------------------------------------------
do_apply() {
    require_root
    phase "Protocol"
    if [[ -z "$PROTO" ]]; then
        log "SMB is the easier default on a Synology; NFS is faster to scan and"
        log "stores no credentials on this device."
        PROTO="$(choose_from smb nfs)"
    fi
    [[ "$PROTO" == "smb" || "$PROTO" == "nfs" ]] || die "protocol must be smb or nfs"
    ok "using ${PROTO}"

    if [[ "$PROTO" == "smb" ]]; then
        need_binary mount.cifs cifs-utils
    else
        need_binary mount.nfs nfs-common
    fi

    phase "NAS"
    [[ -n "$HOST" ]] || HOST="$(ask 'NAS hostname or IP')"
    [[ -n "$HOST" ]] || die "no host given"

    local port=445
    [[ "$PROTO" == "nfs" ]] && port=2049
    if port_open "$HOST" "$port"; then
        ok "${HOST}:${port} reachable"
    else
        die "cannot reach ${HOST} on port ${port}.
       Check the hostname, and that the service is enabled in DSM
       (SMB: Control Panel > File Services > SMB; NFS: same page, NFS tab
        plus an NFS rule on the shared folder)."
    fi

    if [[ "$PROTO" == "smb" ]]; then
        [[ -n "$USERNAME" ]] || USERNAME="$(ask 'NAS username')"
        if [[ -z "$PASSWORD" ]]; then
            read -r -s -p "    NAS password: " PASSWORD </dev/tty; echo
        fi
        [[ -n "$USERNAME" && -n "$PASSWORD" ]] || die "username and password are required"
    fi

    phase "Share"
    if [[ -z "$SHARE" ]]; then
        local -a found=()
        while IFS= read -r line; do [[ -n "$line" ]] && found+=("$line"); done < <(
            if [[ "$PROTO" == "smb" ]]; then discover_smb; else discover_nfs; fi
        )
        if [[ ${#found[@]} -gt 0 ]]; then
            log "shares found on ${HOST}:"
            SHARE="$(choose_from "${found[@]}")"
        else
            warn "could not list shares (discovery tool missing, or none exported)"
            if [[ "$PROTO" == "smb" ]]; then
                SHARE="$(ask 'Share name (e.g. music)')"
            else
                SHARE="$(ask 'Export path (e.g. /volume1/music)')"
            fi
        fi
    fi
    [[ -n "$SHARE" ]] || die "no share given"
    ok "share: ${SHARE}"

    phase "Mount point"
    MOUNTPOINT="$(ask 'Mount point' "$MOUNTPOINT")"
    [[ "$MOUNTPOINT" == /* ]] || die "mount point must be an absolute path"

    # --- test mount before writing anything --------------------------------
    phase "Test mount"
    local line
    line="$(build_fstab_line "$PROTO" "$HOST" "$SHARE" "$MOUNTPOINT")"
    log "fstab entry that will be written:"
    printf '      %s\n' "$(printf '%s' "$line" | tr '\t' ' ')"

    if dry; then
        printf '\n    %sDry run — nothing was changed.%s\n' "${C_BOLD}" "${C_RESET}"
        return 0
    fi

    local tmpmnt rc=0
    tmpmnt="$(mktemp -d)"
    if [[ "$PROTO" == "smb" ]]; then
        mount -t cifs "//${HOST}/${SHARE}" "$tmpmnt" \
            -o "ro,username=${USERNAME},password=${PASSWORD},iocharset=utf8" 2>/tmp/nasmount.err || rc=$?
    else
        mount -t nfs "${HOST}:${SHARE}" "$tmpmnt" -o ro,soft,timeo=50 2>/tmp/nasmount.err || rc=$?
    fi

    if [[ "$rc" -ne 0 ]]; then
        rmdir "$tmpmnt" 2>/dev/null || true
        warn "test mount failed — nothing was written"
        sed 's/^/      /' /tmp/nasmount.err 2>/dev/null
        if [[ "$PROTO" == "nfs" ]] && grep -q 'access denied' /tmp/nasmount.err 2>/dev/null; then
            nfs_diagnose
        fi
        die "aborted; the system is unchanged"
    fi

    ok "mounted, first few entries:"
    find "$tmpmnt" -maxdepth 1 -mindepth 1 2>/dev/null | head -5 | sed 's|.*/|      |'
    local count
    count="$(find "$tmpmnt" -maxdepth 1 -mindepth 1 2>/dev/null | wc -l)"
    log "${count} entries at the top level"
    umount "$tmpmnt" 2>/dev/null || true
    rmdir "$tmpmnt" 2>/dev/null || true

    # --- commit -------------------------------------------------------------
    phase "Writing configuration"
    mkdir -p "$STATE_DIR"
    cp -a "$FSTAB" "${STATE_DIR}/fstab.before-nas-$(date +%Y%m%d-%H%M%S)"
    ok "fstab backed up"

    if [[ "$PROTO" == "smb" ]]; then
        install -d -m 0755 "$CONF_DIR"
        local ctmp
        ctmp="$(mktemp)"
        printf 'username=%s\npassword=%s\n' "$USERNAME" "$PASSWORD" > "$ctmp"
        install -m 0600 -o root -g root "$ctmp" "$CREDS"
        rm -f "$ctmp"
        ok "credentials written to ${CREDS} (0600 root:root)"
    fi

    install -d -m 0755 "$MOUNTPOINT"
    local newfstab
    newfstab="$(write_managed_block "$FSTAB" "$line")"
    install -m 0644 "$newfstab" "$FSTAB"
    rm -f "$newfstab"
    ok "fstab updated"

    systemctl daemon-reload
    ok "systemd reloaded"

    # daemon-reload GENERATES the automount unit from fstab but does not start
    # it. Without this the trigger does not exist until the next boot, and the
    # mount point just looks like an empty directory.
    local aunit
    aunit="$(systemd-escape --path "$MOUNTPOINT").automount"
    if systemctl start "$aunit" 2>/dev/null; then
        ok "${aunit} started"
    else
        warn "could not start ${aunit}"
    fi

    phase "Verifying"
    if [[ "$(systemctl is-active "$aunit" 2>/dev/null)" != "active" ]]; then
        warn "${aunit} is not active — the share will not mount on access"
        warn "check: systemctl status ${aunit}"
    elif ls "$MOUNTPOINT" >/dev/null 2>&1 && findmnt -no SOURCE "$MOUNTPOINT" >/dev/null 2>&1; then
        ok "automount triggered — ${MOUNTPOINT} is mounted and readable"
        findmnt -no SOURCE,FSTYPE,OPTIONS "$MOUNTPOINT" 2>/dev/null | sed 's/^/      /' || true
        log "$(find "$MOUNTPOINT" -maxdepth 1 -mindepth 1 2>/dev/null | wc -l) entries at the top level"
    else
        warn "${MOUNTPOINT} did not mount on access — check: journalctl -u $(systemd-escape --path "$MOUNTPOINT").mount"
    fi

    cat <<EOF

    ${C_BOLD}Done.${C_RESET} The share mounts on first access, not at boot, so an
    unreachable NAS cannot delay or hang startup.

    Check it survives a reboot with the NAS switched off — that is the whole
    point of the automount design.

    To undo:  sudo $0 --revert
EOF
}

do_revert() {
    require_root
    phase "Removing the NAS mount"
    grep -qF "$BLOCK_BEGIN" "$FSTAB" || { skip "nothing of ours in fstab"; return 0; }

    local mp
    mp="$(awk -v b="$BLOCK_BEGIN" -v e="$BLOCK_END" '
        $0 == b { s = 1; next } $0 == e { s = 0; next }
        s && $0 !~ /^[[:space:]]*#/ && NF >= 2 { print $2; exit }' "$FSTAB")"

    if [[ -n "$mp" ]]; then
        local real="${mp//\\040/ }"
        umount "$real" 2>/dev/null || true
        log "unmounted ${real}"
    fi

    local newfstab
    newfstab="$(strip_managed_block "$FSTAB")"
    if dry; then
        diff -u "$FSTAB" "$newfstab" 2>/dev/null | tail -n +3 | sed 's/^/      /' || true
        rm -f "$newfstab"
        printf '\n    %sDry run — nothing was changed.%s\n' "${C_BOLD}" "${C_RESET}"
        return 0
    fi
    install -m 0644 "$newfstab" "$FSTAB"
    rm -f "$newfstab"
    rm -f "$CREDS"
    systemctl daemon-reload
    ok "fstab entry and credentials removed"
}

main() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --dry-run)     DRY_RUN=1 ;;
            --revert)      MODE="revert" ;;
            --emit-fstab)  MODE="emit" ;;
            --protocol)    PROTO="${2:?--protocol needs smb|nfs}"; shift ;;
            --host)        HOST="${2:?--host needs a value}"; shift ;;
            --share)       SHARE="${2:?--share needs a value}"; shift ;;
            --mountpoint)  MOUNTPOINT="${2:?--mountpoint needs a value}"; shift ;;
            --username)    USERNAME="${2:?--username needs a value}"; shift ;;
            -h|--help)     usage; exit 0 ;;
            *)             usage >&2; die "unknown option: $1" ;;
        esac
        shift
    done

    case "$MODE" in
        emit)
            [[ -n "$PROTO" && -n "$HOST" && -n "$SHARE" ]] \
                || die "--emit-fstab needs --protocol, --host and --share"
            build_fstab_line "$PROTO" "$HOST" "$SHARE" "$MOUNTPOINT"
            ;;
        revert)
            printf '%smusicbox setup-nas.sh %s%s\n' "${C_BOLD}" "${SCRIPT_VERSION}" "${C_RESET}"
            do_revert
            ;;
        *)
            printf '%smusicbox setup-nas.sh %s%s\n' "${C_BOLD}" "${SCRIPT_VERSION}" "${C_RESET}"
            dry && printf '%sDRY RUN — no changes will be made%s\n' "${C_YELLOW}" "${C_RESET}"
            do_apply
            ;;
    esac
}

main "$@"
