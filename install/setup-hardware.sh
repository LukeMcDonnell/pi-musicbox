#!/usr/bin/env bash
#
# musicbox — setup-hardware.sh
#
# Brings up this box's hardware in /boot/firmware/config.txt:
#   - HiFiBerry DAC+ Standard (I2S)
#   - DFRobot DFR0550 5" 800x480 DSI touchscreen
#   - suppresses the two unused HDMI ports
#
# Run AFTER setup.sh (OS cleanup + boot tuning) and BEFORE install.sh (the music
# stack). Safe to re-run; --revert undoes everything it does.
#
# WHY THE HDMI WORK MATTERS
#   Both HDMI connectors report "disconnected", yet the firmware performs 8
#   failed EDID reads between 005949-006735 ms of boot, with a 1537 ms gap right
#   after hdmi_pixel_freq_limit. The pre-kernel stage is ~11s on this board —
#   larger than kernel and userspace combined — and `systemd-analyze` cannot see
#   any of it. Measure with `sudo vclog --msg` (ms since power-on).
#
# TWO LAYERS, AND WHY BOTH ARE NEEDED
#   The EDID reads happen at ~006000 ms. The kernel does not start until
#   ~011247 ms. They are therefore a FIRMWARE-stage cost, and no device-tree
#   parameter can touch them:
#     firmware  display_auto_detect=0, hdmi_ignore_edid, hdmi_ignore_hotplug
#               -> these are what can remove the EDID probing
#     kernel    dtoverlay=vc4-kms-v3d,nohdmi,noaudio
#               -> removes the HDMI connectors and the vc4hdmi ALSA cards,
#                  which also makes MPD's card selection unambiguous later
#
# ORDERING TRAPS
#   1. vc4-kms-dsi-7inch "Requires vc4-kms-v3d to be loaded" — the base overlay
#      must come FIRST in config.txt.
#   2. display_auto_detect=1 is currently what loads the DSI overlay. Setting it
#      to 0 without pinning the overlay leaves the panel dead. Both are written
#      in one atomic block, so this is satisfied by construction.
#
# Usage:
#   sudo ./setup-hardware.sh --dry-run
#   sudo ./setup-hardware.sh
#   sudo reboot
#   sudo ./setup-hardware.sh --revert     # undo
#
#   ./setup-hardware.sh --emit-config SRC DEST
#   ./setup-hardware.sh --emit-revert SRC DEST
#       Pure transforms of a config.txt. Touch no system state; used by tests
#       and handy for inspecting the result before applying it.

set -euo pipefail

readonly SCRIPT_VERSION="1.0.0"
readonly BLOCK_BEGIN="# >>> musicbox setup-hardware.sh managed block >>>"
readonly BLOCK_END="# <<< musicbox setup-hardware.sh managed block <<<"
# Distinct from setup.sh's marker on purpose: the two scripts must never fight
# over the same region of config.txt.
readonly DISABLED_TAG="#musicbox-hw# "

readonly CONFIG_TXT="/boot/firmware/config.txt"
readonly STATE_DIR="/var/lib/musicbox"

DRY_RUN=0
ASSUME_YES=0
FORCE=0
DO_DAC=1
DO_DISPLAY=1
SUPPRESS_HDMI=1
MODE="apply"

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

usage() { sed -n '3,45p' "$0" | sed 's/^# \{0,1\}//'; }

# ---------------------------------------------------------------------------
# Settings in config.txt that would conflict with our block.
#
# Duplicate keys in config.txt are NOT reliably last-wins, so these must be
# neutralised rather than shadowed. Each entry is an extended regex matching the
# whole line.
# ---------------------------------------------------------------------------
conflicting_patterns() {
    if [[ "$DO_DAC" -eq 1 ]]; then
        printf '%s\n' '^[[:space:]]*dtparam=audio='
    fi
    if [[ "$DO_DISPLAY" -eq 1 ]]; then
        printf '%s\n' '^[[:space:]]*display_auto_detect='
        printf '%s\n' '^[[:space:]]*max_framebuffers='
        # Must be re-declared WITH parameters; a second dtoverlay line for the
        # same overlay would try to load it twice.
        printf '%s\n' '^[[:space:]]*dtoverlay=vc4-kms-v3d([,[:space:]]|$)'
        printf '%s\n' '^[[:space:]]*dtoverlay=vc4-kms-dsi-7inch([,[:space:]]|$)'
        if [[ "$SUPPRESS_HDMI" -eq 1 ]]; then
            printf '%s\n' '^[[:space:]]*hdmi_ignore_edid='
            printf '%s\n' '^[[:space:]]*hdmi_ignore_hotplug='
        fi
    fi
}

# The block we install. Leading [all] matters: stock config.txt ends inside a
# model-specific section filter, so an unqualified append would apply to the
# wrong model or to none.
build_block() {
    printf '%s\n' "[all]"

    if [[ "$DO_DISPLAY" -eq 1 ]]; then
        printf '%s\n' "# --- graphics: DSI panel only ---"
        if [[ "$SUPPRESS_HDMI" -eq 1 ]]; then
            printf '%s\n' "dtoverlay=vc4-kms-v3d,nohdmi,noaudio"
        else
            printf '%s\n' "dtoverlay=vc4-kms-v3d"
        fi
        # MUST follow vc4-kms-v3d: the panel overlay depends on it.
        printf '%s\n' "dtoverlay=vc4-kms-dsi-7inch"
        printf '%s\n' "display_auto_detect=0"
        printf '%s\n' "max_framebuffers=1"
        if [[ "$SUPPRESS_HDMI" -eq 1 ]]; then
            printf '%s\n' "# firmware-stage: stops the EDID probing of two unused ports"
            printf '%s\n' "hdmi_ignore_edid=0xa5000080"
            printf '%s\n' "hdmi_ignore_hotplug=1"
        fi
    fi

    if [[ "$DO_DAC" -eq 1 ]]; then
        [[ "$DO_DISPLAY" -eq 1 ]] && printf '\n'
        printf '%s\n' "# --- HiFiBerry DAC+ Standard (I2S, no HAT ID EEPROM) ---"
        printf '%s\n' "dtparam=audio=off"
        printf '%s\n' "dtoverlay=hifiberry-dacplus-std"
    fi
}

# emit_config <src> <dest> — pure transform, no system state touched.
emit_config() {
    local src="$1" dest="$2" tmp
    tmp="$(mktemp)"

    # 1. strip any previous block of ours, and un-comment our own tags, so the
    #    transform is idempotent and always builds from a clean base.
    awk -v b="$BLOCK_BEGIN" -v e="$BLOCK_END" -v tag="$DISABLED_TAG" '
        $0 == b { skip = 1; next }
        $0 == e { skip = 0; next }
        skip    { next }
        index($0, tag) == 1 { print substr($0, length(tag) + 1); next }
        { print }
    ' "$src" > "$tmp"

    # 2. comment out conflicting stock settings
    local pat
    while IFS= read -r pat; do
        [[ -n "$pat" ]] || continue
        awk -v re="$pat" -v tag="$DISABLED_TAG" '
            /^[[:space:]]*#/ { print; next }
            $0 ~ re         { print tag $0; next }
            { print }
        ' "$tmp" > "${tmp}.n" && mv "${tmp}.n" "$tmp"
    done < <(conflicting_patterns)

    # 3. collapse trailing blank lines, then append the block
    local trimmed
    trimmed="$(mktemp)"
    printf '%s\n' "$(< "$tmp")" > "$trimmed"
    mv "$trimmed" "$tmp"

    {
        printf '\n%s\n' "$BLOCK_BEGIN"
        build_block
        printf '%s\n' "$BLOCK_END"
    } >> "$tmp"

    mv "$tmp" "$dest"
}

# revert_config <src> <dest> — remove our block, restore commented lines.
revert_config() {
    local src="$1" dest="$2" tmp
    tmp="$(mktemp)"
    awk -v b="$BLOCK_BEGIN" -v e="$BLOCK_END" -v tag="$DISABLED_TAG" '
        $0 == b { skip = 1; next }
        $0 == e { skip = 0; next }
        skip    { next }
        index($0, tag) == 1 { print substr($0, length(tag) + 1); next }
        { print }
    ' "$src" > "$tmp"
    # our block was appended after a blank line; drop the trailing blank
    local trimmed
    trimmed="$(mktemp)"
    printf '%s\n' "$(< "$tmp")" > "$trimmed"
    mv "$trimmed" "$tmp"
    mv "$tmp" "$dest"
}

# ---------------------------------------------------------------------------
require_root() { [[ "$(id -u)" -eq 0 ]] || die "must run as root (try: sudo $0)"; }

dsi_connected() {
    local f
    for f in /sys/class/drm/card*-DSI-*/status; do
        [[ -e "$f" ]] || continue
        [[ "$(cat "$f" 2>/dev/null)" == "connected" ]] && return 0
    done
    return 1
}

show_diff() {
    local old="$1" new="$2"
    diff -u -- "$old" "$new" 2>/dev/null | tail -n +3 | sed 's/^/      /' || true
}

backup_config() {
    local backup
    backup="${STATE_DIR}/config.txt.before-hw-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$STATE_DIR"
    cp -a "$CONFIG_TXT" "$backup"
    ok "backed up to $backup"
}

do_apply() {
    require_root
    phase "Preflight"
    [[ -f "$CONFIG_TXT" ]] || die "$CONFIG_TXT not found — is this Raspberry Pi OS?"

    if [[ "$DO_DISPLAY" -eq 1 ]]; then
        if dsi_connected; then
            ok "DSI panel detected"
        elif [[ "$FORCE" -eq 1 ]]; then
            warn "no DSI panel detected, continuing anyway (--force)"
        else
            die "No connected DSI panel found, but this would set display_auto_detect=0.
       That combination leaves you with no display at all. Re-run with --force
       if you are certain, or with --skip-display."
        fi
    fi

    local overlay
    for overlay in vc4-kms-dsi-7inch hifiberry-dacplus-std; do
        if [[ -e "/boot/firmware/overlays/${overlay}.dtbo" ]]; then
            ok "overlay present: ${overlay}"
        else
            warn "overlay MISSING: ${overlay}.dtbo"
        fi
    done

    phase "Proposed changes to ${CONFIG_TXT}"
    local new
    new="$(mktemp)"
    emit_config "$CONFIG_TXT" "$new"

    if cmp -s "$CONFIG_TXT" "$new"; then
        skip "config.txt already up to date — nothing to do"
        rm -f "$new"
        return 0
    fi
    show_diff "$CONFIG_TXT" "$new"

    if dry; then
        rm -f "$new"
        printf '\n    %sDry run — nothing was changed.%s\n' "${C_BOLD}" "${C_RESET}"
        return 0
    fi

    if [[ "$ASSUME_YES" -ne 1 ]]; then
        printf '\n%sThis changes display and audio hardware config. A reboot is required.%s\n' "${C_BOLD}" "${C_RESET}"
        printf 'Networking is untouched, so SSH recovery remains available.\n\n'
        read -r -p "Continue? [y/N] " reply
        [[ "$reply" =~ ^[Yy]$ ]] || die "aborted by user"
    fi

    phase "Applying"
    backup_config
    install -m 0755 "$new" "$CONFIG_TXT"
    rm -f "$new"
    ok "config.txt updated"

    cat <<EOF

    ${C_BOLD}Reboot required.${C_RESET}   sudo reboot

    Then verify:
      aplay -l                       # expect snd_rpi_hifiberry_dacplus
      cat /sys/class/drm/card*-DSI-1/status    # expect: connected
      sudo vclog --msg | grep -ci edid         # expect: fewer/zero EDID reads
      musicbox-bootreport                      # firmware stage before/after

    If the panel misbehaves:  sudo $0 --revert && sudo reboot
EOF
}

do_revert() {
    require_root
    phase "Reverting hardware config"
    [[ -f "$CONFIG_TXT" ]] || die "$CONFIG_TXT not found"

    local new
    new="$(mktemp)"
    revert_config "$CONFIG_TXT" "$new"

    if cmp -s "$CONFIG_TXT" "$new"; then
        skip "nothing of ours in config.txt — already reverted"
        rm -f "$new"
        return 0
    fi
    show_diff "$CONFIG_TXT" "$new"

    if dry; then
        rm -f "$new"
        printf '\n    %sDry run — nothing was changed.%s\n' "${C_BOLD}" "${C_RESET}"
        return 0
    fi

    backup_config
    install -m 0755 "$new" "$CONFIG_TXT"
    rm -f "$new"
    ok "reverted — reboot to apply"
}

main() {
    local src="" dest=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --dry-run)      DRY_RUN=1 ;;
            -y|--yes)       ASSUME_YES=1 ;;
            --force)        FORCE=1 ;;
            --skip-dac)     DO_DAC=0 ;;
            --skip-display) DO_DISPLAY=0 ;;
            --keep-hdmi)    SUPPRESS_HDMI=0 ;;
            --revert)       MODE="revert" ;;
            --emit-config)  MODE="emit"; src="${2:-}"; dest="${3:-}"; shift 2 ;;
            --emit-revert)  MODE="emit-revert"; src="${2:-}"; dest="${3:-}"; shift 2 ;;
            -h|--help)      usage; exit 0 ;;
            *)              usage >&2; die "unknown option: $1" ;;
        esac
        shift
    done

    if [[ "$DO_DAC" -eq 0 && "$DO_DISPLAY" -eq 0 ]]; then
        die "--skip-dac and --skip-display together leave nothing to do"
    fi

    case "$MODE" in
        emit)
            [[ -n "$src" && -n "$dest" ]] || die "--emit-config needs SRC and DEST"
            [[ -f "$src" ]] || die "SRC not found: $src"
            emit_config "$src" "$dest"
            ;;
        emit-revert)
            [[ -n "$src" && -n "$dest" ]] || die "--emit-revert needs SRC and DEST"
            [[ -f "$src" ]] || die "SRC not found: $src"
            revert_config "$src" "$dest"
            ;;
        revert)
            printf '%smusicbox setup-hardware.sh %s%s\n' "${C_BOLD}" "${SCRIPT_VERSION}" "${C_RESET}"
            do_revert
            ;;
        *)
            printf '%smusicbox setup-hardware.sh %s%s\n' "${C_BOLD}" "${SCRIPT_VERSION}" "${C_RESET}"
            dry && printf '%sDRY RUN — no changes will be made%s\n' "${C_YELLOW}" "${C_RESET}"
            do_apply
            ;;
    esac
}

main "$@"
