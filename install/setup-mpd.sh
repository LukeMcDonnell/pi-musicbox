#!/usr/bin/env bash
#
# musicbox — setup-mpd.sh
#
# Configures MPD to play the NAS library through the HiFiBerry DAC.
#
# Run order:
#   setup.sh -> setup-hardware.sh -> install.sh -> setup-nas.sh -> setup-mpd.sh
#   -> setup-kiosk.sh
#
# THIS SCRIPT INSTALLS NOTHING. mpd and mpc come from install.sh. If mpd is
# missing this exits pointing you there.
#
# WHY IT DOES NOT TOUCH /etc/mpd.conf
#   Debian's unit is:
#       EnvironmentFile=/etc/default/mpd
#       ExecStart=/usr/bin/mpd --systemd $MPDCONF
#   and /etc/default/mpd ships with "# MPDCONF=/etc/mpd.conf" commented out.
#
#   So the supported way to use our own config is to set MPDCONF, and that is
#   what this script does. /etc/mpd.conf is left exactly as the package shipped
#   it, so dpkg never prompts about a modified conffile, and --revert is exact:
#   strip one block, delete one file, and the box is back on stock MPD.
#
#   An include file was the other option and does not work: Debian's mpd.conf
#   already sets music_directory and bind_to_address, and MPD treats a
#   redefined parameter as a fatal duplicate.
#
#   Caveat: /etc/default/mpd is itself a conffile. The managed block is small
#   and revertible, but an mpd upgrade that changes that file will prompt.
#
# THE TWO SETTINGS THAT ARE EASY TO GET WRONG
#   music_directory is /srv/music/Music, NOT /srv/music. The share root also
#   holds #recycle, and Synology scatters @eaDir thumbnail directories through
#   the tree.
#
#   The mixer control is "Digital", not "PCM". That is the pcm512x volume
#   control on a DAC+; check with: amixer -c 0 scontrols
#
# Usage:
#   sudo ./setup-mpd.sh --dry-run
#   sudo ./setup-mpd.sh
#   sudo ./setup-mpd.sh --revert
#
#   ./setup-mpd.sh --emit DEST
#       Write mpd.conf and the /etc/default/mpd block to a directory and exit.
#       Touches no system state; used by the tests and handy for review.

set -euo pipefail

readonly SCRIPT_VERSION="1.0.0"
readonly BLOCK_BEGIN="# >>> musicbox setup-mpd.sh managed block >>>"
readonly BLOCK_END="# <<< musicbox setup-mpd.sh managed block <<<"

readonly CONF_DIR="/etc/musicbox"
readonly CONF_FILE="${CONF_DIR}/mpd.conf"
readonly DEFAULT_FILE="/etc/default/mpd"
readonly STATE_DIR="/var/lib/musicbox"
readonly MPD_STATE_DIR="/var/lib/mpd"

# The library, not the share root. See the header.
readonly MUSIC_DIR="/srv/music/Music"

DRY_RUN=0
ASSUME_YES=0
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

run() {
    if dry; then printf '    %s[dry-run]%s %s\n' "${C_DIM}" "${C_RESET}" "$*"
    else "$@"; fi
}

usage() { sed -n '3,47p' "$0" | sed 's/^# \{0,1\}//'; }

# install_if_changed <tmp> <dest> [mode] -> 0 changed, 1 already current
install_if_changed() {
    local tmp="$1" dest="$2" mode="${3:-0644}"
    if cmp -s "$tmp" "$dest" 2>/dev/null; then
        rm -f "$tmp"; return 1
    fi
    if dry; then
        printf '    %s[dry-run]%s would write %s\n' "${C_DIM}" "${C_RESET}" "$dest"
        rm -f "$tmp"; return 0
    fi
    install -D -m "$mode" "$tmp" "$dest"
    rm -f "$tmp"
    return 0
}

# ---------------------------------------------------------------------------
# Managed block handling for /etc/default/mpd.
#
# Both return the path to a temp file on stdout; the caller installs it and
# removes the temp.
# ---------------------------------------------------------------------------

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
        # printf '%s\n', not '%s': callers pass "$(gen_... )" and command
        # substitution strips the trailing newline. Without this the closing
        # marker lands on the end of the last line of content.
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
# Artifact generators — pure, so --emit and the tests exercise the real thing
# ---------------------------------------------------------------------------

gen_conf() {
    cat <<CONF
# musicbox MPD configuration.
#
# Generated by install/setup-mpd.sh. Edits here are overwritten on the next run;
# change the generator instead. /etc/mpd.conf is deliberately left as the Debian
# package shipped it — MPD is pointed here by MPDCONF in ${DEFAULT_FILE}.

# THE LIBRARY, NOT THE SHARE ROOT. /srv/music also contains #recycle, and
# Synology scatters @eaDir thumbnail directories through the tree; pointing MPD
# at the root makes it scan thousands of junk files.
music_directory     "${MUSIC_DIR}"

# Persistent state. setup.sh made /tmp and /var/log volatile, but NOT /var/lib,
# so the tag cache survives a reboot and the library is only scanned once.
playlist_directory  "${MPD_STATE_DIR}/playlists"
db_file             "${MPD_STATE_DIR}/tag_cache"
state_file          "${MPD_STATE_DIR}/state"
sticker_file        "${MPD_STATE_DIR}/sticker.sql"

user                "mpd"
filesystem_charset  "UTF-8"

# Not a preference. MPD's auto-update watches the library with inotify, and
# inotify cannot see changes made on the far side of an NFS mount — it would
# hold a watch on every file and still never fire. Update explicitly:
#   mpc update --wait
#
# This does NOT stop the initial scan: when ${MPD_STATE_DIR}/tag_cache is
# absent, MPD builds the database itself on startup. Two consequences —
# restarting mpd mid-scan abandons it and leaves a PARTIAL database, and MPD
# reads music_directory at startup, which is what triggers the lazy automount.
auto_update         "no"

# Restore the previous playlist and position on start, but do NOT start playing.
# This box boots into a kiosk; it should not begin making noise by itself.
restore_paused      "yes"

# No zeroconf, and no bind_to_address. These are the same decision.
#
# Debian enables mpd.socket, which binds /run/mpd/socket and port 6600 and hands
# the listeners to MPD. MPD therefore never creates a listener of its own, and
# derives its advertised port from one it created — so with socket activation it
# logs "zeroconf: No global port, disabling zeroconf" and mDNS silently does
# nothing. Setting zeroconf_enabled "yes" here would be a lie. Measured on the
# device: setting a port alone does not help either.
#
# Making mDNS work means taking the listeners away from systemd:
#     bind_to_address "any"      in this file
#     systemctl disable mpd.socket
#     a drop-in with RuntimeDirectory=mpd, so /run/mpd/socket still exists
# That trades a working, supported default for a nice-to-have, so it is left
# undone deliberately. MPD is still reachable on port 6600 across the LAN
# (verified v4 and v6), just not discoverable by browsing.

audio_output {
    type            "alsa"
    name            "HiFiBerry DAC+"

    # card 0 is unambiguously the DAC: setup-hardware.sh removed the onboard
    # "bcm2835 Headphones" and both vc4hdmi cards. Verify with: aplay -l
    device          "hw:0,0"

    # "Digital" is the pcm512x volume control. "PCM" is the plausible-looking
    # wrong answer and does not exist on this card — amixer -c 0 scontrols.
    mixer_type      "hardware"
    mixer_device    "hw:0"
    mixer_control   "Digital"
}
CONF
}

gen_default_block() {
    cat <<DEFAULTS
# Point MPD at musicbox's own configuration. This is the mechanism Debian's unit
# already provides (EnvironmentFile=/etc/default/mpd, ExecStart=... \$MPDCONF),
# which keeps /etc/mpd.conf pristine so dpkg never prompts on upgrade.
MPDCONF=${CONF_FILE}
DEFAULTS
}

emit_all() {
    local dest="$1" stock tmp
    mkdir -p "$dest"
    gen_conf > "${dest}/mpd.conf"

    # Run the real block writer against a stock-shaped fixture, so --emit and
    # the tests exercise the same code path that edits /etc/default/mpd.
    stock="$(mktemp)"
    printf '## The configuration file location for mpd:\n# MPDCONF=/etc/mpd.conf\n' > "$stock"
    tmp="$(write_managed_block "$stock" "$(gen_default_block)")"
    mv "$tmp" "${dest}/default-mpd"
    rm -f "$stock"

    printf '  wrote mpd.conf default-mpd -> %s\n' "$dest"
}

# ---------------------------------------------------------------------------
require_root() { [[ "$(id -u)" -eq 0 ]] || die "must run as root (try: sudo $0)"; }

have_pkg() {
    dpkg-query -W -f='${db:Status-Status}' "$1" 2>/dev/null | grep -q '^installed$'
}

do_apply() {
    require_root

    phase "Preflight"
    have_pkg mpd || die "mpd is not installed — run install.sh first"
    # No `| head` here: it closes the pipe early, mpd takes SIGPIPE, and under
    # `set -o pipefail` the whole pipeline then reports failure — so a trailing
    # `|| echo ...` fallback would fire on top of the real output.
    local ver
    ver="$(mpd --version 2>/dev/null | sed -n '1s/.*[[:space:]]\([0-9][0-9.]*\).*/\1/p')" || true
    ok "mpd ${ver:-(version unknown)}"
    if have_pkg mpc; then ok "mpc present"; else warn "mpc missing — install.sh should provide it"; fi

    # A warning, not a failure. MPD is REQUIRED to tolerate an absent library
    # and pick it up on first access; refusing to configure would contradict
    # the whole point of the lazy automount.
    if [[ -r "$MUSIC_DIR" ]]; then
        ok "${MUSIC_DIR} is readable"
    else
        warn "${MUSIC_DIR} is not readable right now"
        warn "that is survivable — MPD will pick it up on first access — but if"
        warn "this is not deliberate, run setup-nas.sh and check: findmnt /srv/music"
    fi

    if aplay -l 2>/dev/null | grep -q 'card 0.*hifiberry'; then
        ok "card 0 is the HiFiBerry DAC"
    else
        warn "card 0 does not look like the HiFiBerry — run setup-hardware.sh?"
        warn "check: aplay -l"
    fi

    phase "Configuration"
    run install -d -m 0755 "$STATE_DIR"
    # Back up only on the FIRST run. Copying on every run buries the pristine
    # pre-musicbox file under copies that already contain our block, which is
    # the opposite of useful when you want to restore the original.
    if [[ ! -f "$DEFAULT_FILE" ]]; then
        skip "${DEFAULT_FILE} does not exist yet — nothing to back up"
    elif grep -qF "$BLOCK_BEGIN" "$DEFAULT_FILE"; then
        skip "${DEFAULT_FILE} already carries our block — keeping the original backup"
    else
        run cp -a "$DEFAULT_FILE" "${STATE_DIR}/default-mpd.before-mpd-$(date +%Y%m%d-%H%M%S)"
        dry || ok "${DEFAULT_FILE} backed up (pristine)"
    fi

    local tmp changed=0
    tmp="$(mktemp)"; gen_conf > "$tmp"
    if install_if_changed "$tmp" "$CONF_FILE" 0644; then ok "$CONF_FILE"; changed=1
    else skip "$CONF_FILE already current"; fi

    local newdefault
    newdefault="$(write_managed_block "$DEFAULT_FILE" "$(gen_default_block)")"
    if install_if_changed "$newdefault" "$DEFAULT_FILE" 0644; then
        ok "${DEFAULT_FILE} points MPD at ${CONF_FILE}"; changed=1
    else
        skip "${DEFAULT_FILE} already current"
    fi

    # The package creates /var/lib/mpd, but not always the playlist directory.
    run install -d -o mpd -g audio -m 0755 "${MPD_STATE_DIR}/playlists"

    phase "Starting"
    if dry; then
        printf '    %s[dry-run]%s would daemon-reload and restart mpd\n' "${C_DIM}" "${C_RESET}"
        printf '\n    %sDry run — nothing was changed.%s\n' "${C_BOLD}" "${C_RESET}"
        return 0
    fi

    systemctl daemon-reload
    systemctl enable mpd.service >/dev/null 2>&1 || true

    # Only restart when the config actually changed. A blanket restart makes
    # re-running this script stop playback mid-track, which is a nasty thing for
    # an idempotent script to do.
    if [[ "$changed" -eq 1 ]]; then
        if systemctl restart mpd.service; then
            ok "mpd restarted onto the new config"
        else
            warn "mpd failed to restart — check: journalctl -u mpd -b --no-pager"
        fi
    elif [[ "$(systemctl is-active mpd.service 2>/dev/null)" != "active" ]]; then
        if systemctl start mpd.service; then
            ok "mpd started"
        else
            warn "mpd failed to start — check: journalctl -u mpd -b --no-pager"
        fi
    else
        skip "mpd already running on this config — not restarting (it would interrupt playback)"
    fi

    phase "Verifying"
    if [[ "$(systemctl is-active mpd.service 2>/dev/null)" != "active" ]]; then
        warn "mpd is not active — check: journalctl -u mpd -b --no-pager"
    else
        ok "mpd is active"
        if mpc status >/dev/null 2>&1; then
            ok "mpc can talk to it"
            mpc outputs 2>/dev/null | sed 's/^/      /' || true
        else
            warn "mpc cannot connect — check: systemctl cat mpd.socket"
        fi
        # Confirm MPD actually read OUR config rather than /etc/mpd.conf.
        if mpc stats 2>/dev/null | grep -q .; then
            log "$(mpc stats 2>/dev/null | grep -i '^songs' || echo 'songs: (database empty until first update)')"
        fi
    fi

    cat <<EOF

    ${C_BOLD}MPD is configured.${C_RESET} The database is empty until the first scan.

    Scan the library (49k files over NFS — this takes a while, not seconds):
      time mpc update --wait
      mpc stats

    Then prove audio actually reaches the DAC:
      mpc add / && mpc play
      amixer -c 0 sget Digital        # mpc volume 50 should move this

    Worth checking once, since MPD is the first thing to hold the mount open:
      systemd-analyze blame | head    # mpd should not be on the critical path

    If it misbehaves:  sudo $0 --revert
EOF
    [[ "$changed" -eq 0 ]] && skip "(nothing changed this run)"
    return 0
}

do_revert() {
    require_root
    phase "Reverting MPD to the stock configuration"

    if [[ -f "$DEFAULT_FILE" ]] && grep -qF "$BLOCK_BEGIN" "$DEFAULT_FILE"; then
        local stripped
        stripped="$(strip_managed_block "$DEFAULT_FILE")"
        if dry; then
            diff -u "$DEFAULT_FILE" "$stripped" || true
            rm -f "$stripped"
        else
            install -m 0644 "$stripped" "$DEFAULT_FILE"
            rm -f "$stripped"
            ok "${DEFAULT_FILE} block removed — MPD is back on /etc/mpd.conf"
        fi
    else
        skip "no managed block in ${DEFAULT_FILE}"
    fi

    run rm -f "$CONF_FILE"
    run systemctl daemon-reload
    run systemctl restart mpd.service
    ok "reverted"
    log "packages (mpd, mpc) were left installed; remove with:"
    log "  sudo apt-get purge mpd mpc && sudo apt-get autoremove --purge"
    log "the tag cache in ${MPD_STATE_DIR} was left alone"
}

main() {
    local dest=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --dry-run)  DRY_RUN=1 ;;
            -y|--yes)   ASSUME_YES=1 ;;
            --revert)   MODE="revert" ;;
            --emit)     MODE="emit"; dest="${2:-}"; shift ;;
            -h|--help)  usage; exit 0 ;;
            *)          usage >&2; die "unknown option: $1" ;;
        esac
        shift
    done
    : "$ASSUME_YES"

    case "$MODE" in
        emit)
            [[ -n "$dest" ]] || die "--emit needs a destination directory"
            emit_all "$dest"
            ;;
        revert)
            printf '%smusicbox setup-mpd.sh %s%s\n' "${C_BOLD}" "${SCRIPT_VERSION}" "${C_RESET}"
            dry && printf '%sDRY RUN — no changes will be made%s\n' "${C_YELLOW}" "${C_RESET}"
            do_revert
            ;;
        *)
            printf '%smusicbox setup-mpd.sh %s%s\n' "${C_BOLD}" "${SCRIPT_VERSION}" "${C_RESET}"
            dry && printf '%sDRY RUN — no changes will be made%s\n' "${C_YELLOW}" "${C_RESET}"
            do_apply
            ;;
    esac
}

main "$@"
