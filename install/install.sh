#!/usr/bin/env bash
#
# musicbox — install.sh
#
# Installs packages for the music player stack.
#
# Run order:
#   setup.sh -> setup-hardware.sh -> install.sh -> setup-nas.sh -> setup-mpd.sh
#   -> setup-server.sh -> setup-kiosk.sh
#
# THIS is where apt installs live. The setup-*.sh scripts configure; they do not
# install. The one deliberate exception is setup-kiosk.sh, which installs cage
# and chromium itself so the entire kiosk can be removed by deleting that one
# script if this ever goes headless.
#
# ===========================================================================
# CONTRACT WITH setup.sh — read before writing anything here
# ===========================================================================
#
# 1. THE MUSIC SHARE MUST NOT BLOCK BOOT.
#
#    setup.sh masks NetworkManager-wait-online.service, which is the single
#    biggest boot-time win on this image. That is only safe if nothing in
#    fstab waits on the network. Mount the NFS/SMB library lazily:
#
#      //nas/music  /srv/music  cifs  x-systemd.automount,x-systemd.idle-timeout=600,_netdev,noauto,...  0 0
#
#    A plain _netdev mount here will reintroduce the boot delay (and can hang
#    boot entirely when the NAS is off). MPD must also tolerate the library
#    being absent at start and pick it up on first access.
#
# 2. HARDWARE IS HANDLED BY setup-hardware.sh, NOT HERE.
#
#    The DAC+, the DSI panel and HDMI suppression all moved into
#    install/setup-hardware.sh. Run order is:
#
#      setup.sh  ->  setup-hardware.sh  ->  install.sh
#
#    Do NOT write dtoverlay/dtparam lines into config.txt from this script. If
#    you must, use a DIFFERENT managed-block marker so the three scripts never
#    fight over the same region of the file.
#
#    What setup-hardware.sh already guarantees by the time you run:
#      - card 0 is snd_rpi_hifiberry_dacplus (pcm512x). The onboard
#        "bcm2835 Headphones" and the vc4hdmi0/vc4hdmi1 cards are GONE, so any
#        MPD config assuming card 0 = Headphones is wrong.
#      - the DSI panel is pinned via dtoverlay=vc4-kms-dsi-7inch and no longer
#        depends on display_auto_detect.
#      - HDMI is suppressed at both the firmware and kernel layers.
#
# 3. THE KIOSK IS HANDLED BY setup-kiosk.sh.
#
#    A fullscreen chromium under cage is already running on the panel from boot.
#    To point it at the web UI once it exists:
#
#      sed -i 's|^KIOSK_URL=.*|KIOSK_URL="http://localhost:PORT/"|' \\
#          /etc/musicbox/kiosk.conf
#      systemctl restart musicbox-kiosk
#
#    Do NOT write a second kiosk unit or a second compositor.
#
#    Note: the wrapper passes --mute-audio, because MPD is meant to own the DAC
#    exclusively and chromium holding the ALSA device would stop MPD starting.
#    If the web UI ever needs to make sound, the fix is a shared audio layer
#    (dmix or PipeWire), not just removing the flag.
#
# 4. MPD IS CONFIGURED BY setup-mpd.sh, NOT HERE.
#
#    This script installs mpd and mpc; install/setup-mpd.sh writes the config.
#    Two things it gets right that are easy to get wrong by hand:
#      - music_directory is /srv/music/Music, NOT /srv/music. The share root
#        also holds #recycle and Synology's @eaDir thumbnail directories.
#      - the ALSA mixer control is "Digital", not "PCM".
#
#    It does not touch /etc/mpd.conf. Debian's unit reads MPDCONF from
#    /etc/default/mpd, so the config lives at /etc/musicbox/mpd.conf and the
#    package conffile stays pristine.
#
# 5. THE WEB SERVER IS CONFIGURED BY setup-server.sh, NOT HERE.
#
#    This script installs nodejs; install/setup-server.sh writes the units. The
#    application itself is built on the DEV MACHINE and pushed with
#    tools/dev-push.sh — the Pi is never a build machine and never needs npm.
#
#    The server unit is deliberately NOT ordered after mpd.service: mpd takes
#    ~6s at boot and is on the critical path. Do not "fix" that ordering.
#
# 6. STILL TO DO HERE
#      - Bluetooth audio (bluez + a BlueALSA/PipeWire sink)
#      - USB CD audio playback and ripping
#      - the web UI service
#      - optional: read-only root via `raspi-config nonint enable_overlayfs`
#
# ===========================================================================

set -euo pipefail

readonly SCRIPT_VERSION="1.0.0"

# Packages installed now.
#
# setup-nas.sh needs all three NAS entries: the protocol is chosen interactively
# at run time, so both clients must already be present, and smbclient provides
# share discovery.
#
# mpd is heavy — 118 packages with --no-install-recommends, all hard Depends:
# the full ffmpeg stack, fluidsynth and a soundfont, OpenAL, JACK, PipeWire,
# PulseAudio, sndio, libupnp. That sits oddly beside setup.sh stripping the OS,
# and it is accepted deliberately: they are shared libraries rather than
# services, so they cost disk (which is not scarce here) and not boot time
# (which is). The alternative was a source build, and owning that rebuild
# forever is worse than 350MB on a 29G card.
PACKAGES=(
    cifs-utils      # SMB/CIFS mounting
    nfs-common      # NFS mounting + showmount for export discovery
    smbclient       # SMB share discovery
    mpd             # the player itself; configured by setup-mpd.sh
    mpc             # CLI client, and how setup-mpd.sh verifies the result
    nodejs          # runtime for the web server; configured by setup-server.sh
)

# NOTE: nodejs only, NEVER npm. The runtime is 12 packages; Debian's npm is 363,
# because it unbundles every npm dependency into its own node-* package. The Pi
# does not need npm: the frontend and backend are built on the dev machine and
# the device receives a single bundled server.js plus static files.

# TODO, next pass: bluez-alsa-utils, cdparanoia / libcdio-utils, and whatever
# the web UI needs.

DRY_RUN=0
ASSUME_YES=0

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
die()   { printf '\n%sERROR:%s %s\n' "${C_RED}${C_BOLD}" "${C_RESET}" "$*" >&2; exit 1; }
dry()   { [[ "$DRY_RUN" -eq 1 ]]; }

run() {
    if dry; then printf '    %s[dry-run]%s %s\n' "${C_DIM}" "${C_RESET}" "$*"
    else "$@"; fi
}

have_pkg() {
    dpkg-query -W -f='${db:Status-Status}' "$1" 2>/dev/null | grep -q '^installed$'
}

usage() {
    cat <<'USAGE'
musicbox install.sh - installs packages for the music player stack

Usage: sudo ./install.sh [options]

Options:
  --dry-run    Show what would be installed, change nothing
  --yes, -y    Skip the confirmation prompt
  --help, -h   This message

Run order:
  setup.sh -> setup-hardware.sh -> install.sh -> setup-nas.sh -> setup-mpd.sh
  -> setup-server.sh -> setup-kiosk.sh
USAGE
}

main() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --dry-run)  DRY_RUN=1 ;;
            -y|--yes)   ASSUME_YES=1 ;;
            -h|--help)  usage; exit 0 ;;
            *)          usage >&2; die "unknown option: $1" ;;
        esac
        shift
    done

    printf '%smusicbox install.sh %s%s\n' "${C_BOLD}" "${SCRIPT_VERSION}" "${C_RESET}"
    dry && printf '%sDRY RUN - no changes will be made%s\n' "${C_YELLOW}" "${C_RESET}"

    [[ "$(id -u)" -eq 0 ]] || die "must run as root (try: sudo $0)"

    phase "Packages"
    local p need=()
    for p in "${PACKAGES[@]}"; do
        if have_pkg "$p"; then skip "$p already installed"; else need+=("$p"); fi
    done

    if [[ ${#need[@]} -eq 0 ]]; then
        skip "nothing to install"
    else
        log "will install: ${need[*]}"
        if printf '%s\n' "${need[@]}" | grep -qx mpd; then
            log "(mpd pulls in ~118 packages; this takes a few minutes)"
        fi
        if [[ "$ASSUME_YES" -ne 1 ]] && ! dry; then
            read -r -p "    Continue? [y/N] " reply
            [[ "$reply" =~ ^[Yy]$ ]] || die "aborted by user"
        fi
        run env DEBIAN_FRONTEND=noninteractive apt-get update
        run env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${need[@]}"
        dry || ok "installed: ${need[*]}"
    fi

    phase "Summary"
    if dry; then
        log "Dry run - nothing was changed."
        return 0
    fi
    cat <<EOF
    Packages are ready. Next:

      sudo ./install/setup-nas.sh     # mount the music share
      sudo ./install/setup-mpd.sh     # configure MPD against it
      sudo ./install/setup-server.sh  # web server + API

    Installing mpd does NOT configure or enable it. On Trixie the package leaves
    mpd.service and mpd.socket disabled and inactive, on a default config
    pointing at /var/lib/mpd/music. setup-mpd.sh is what makes it useful.

    Not implemented yet: Bluetooth audio, USB CD.
EOF
}

main "$@"
