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
#    tools/dev-push.sh — the Pi is never a build machine.
#
#    NODE COMES FROM NODESOURCE, NOT DEBIAN. Trixie ships node 20, and the
#    backend stores its state in SQLite through node:sqlite, which is built into
#    the runtime from 22.5 and needs no flag from 24. The alternatives were a
#    native module (breaks the single-file bundle — the same verdict already
#    recorded for sharp) or a WASM engine (a second runtime dependency and a
#    .wasm to ship). Taking it from the runtime costs neither.
#
#    The server unit is deliberately NOT ordered after mpd.service: mpd takes
#    ~6s at boot and is on the critical path. Do not "fix" that ordering.
#
# 6. BLUETOOTH AUDIO
#
#    bluez is already on the image and setup.sh keeps it running. This script
#    adds the A2DP sink (bluez-alsa-utils) and a pairing agent (bluez-tools);
#    install/setup-bluetooth.sh configures them.
#
#    BlueALSA rather than PipeWire, on measured grounds: neither Debian build
#    links fdk-aac, so both offer exactly the same sink codecs, and BlueALSA is
#    one daemon where PipeWire is a session bus, wireplumber and a user session.
#    It also leaves MPD holding hw:0,0 raw, which is what keeps the bit-perfect
#    passthrough measured in .claude/docs/device.md true.
#
# 7. STILL TO DO HERE
#      - USB CD audio playback and ripping
#      - the web UI service
#      - optional: read-only root via `raspi-config nonint enable_overlayfs`
#
# ===========================================================================

set -euo pipefail

readonly SCRIPT_VERSION="1.1.0"

# Node, from NodeSource rather than Debian — see contract note 5 above.
#
# `nodistro` is NodeSource's single distribution-agnostic suite; there is no
# trixie-specific one to track. The pin is not strictly needed today (24 > 20,
# so apt would prefer it on version alone) and is there to say which archive is
# meant to win, rather than leaving it to arithmetic.
readonly NODE_MAJOR=24
readonly NODE_KEY_URL="https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key"
# .pgp, armoured, matching the Signed-By convention the image already uses for
# debian.sources — so no gpg --dearmor step and nothing binary to verify.
readonly NODE_KEYRING="/usr/share/keyrings/nodesource.pgp"
readonly NODE_SOURCE="/etc/apt/sources.list.d/nodesource.sources"
readonly NODE_PIN="/etc/apt/preferences.d/nodesource"

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

    # Bluetooth A2DP sink; configured by setup-bluetooth.sh. bluez itself is
    # already on the image and setup.sh keeps it. These two are small — the
    # codec libraries (libfreeaptx, libsbc, liblc3, libldacbt) come as Depends.
    bluez-alsa-utils  # the sink daemon and bluealsa-aplay
    bluez-tools       # bt-agent: a just-works pairing agent, for a box with no keyboard
)

# NOTE: nodejs only, and never Debian's npm — which is 363 packages, because it
# unbundles every npm dependency into its own node-* package. The Pi does not
# need it: both halves are built on the dev machine and the device receives a
# single bundled server.js plus static files.
#
# Be precise about what changed with NodeSource, though. Its nodejs is ONE
# package that Provides: and Conflicts: npm, and npm's files come inside it. So
# npm is present on disk where Debian's node 20 left it absent. What the rule is
# actually about still holds — one package depending only on libc6, libstdc++6
# and python3, against Debian's 12, and nothing is ever built here.

# TODO, next pass: cdparanoia / libcdio-utils for the CD source.
#
# NOT installed, deliberately: libfdk-aac2t64. It is the only way to get AAC into
# a Bluetooth sink, and Debian's bluez-alsa is not linked against it because it
# is non-free — so having the library changes nothing without rebuilding the
# package. That trade (a pinned local .deb apt will never update, for iPhones
# moving from SBC-XQ to AAC) was considered and declined; see
# .claude/docs/bluetooth.md.

DRY_RUN=0
ASSUME_YES=0
REVERT=0

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
# Artifact generators — pure, so --emit and the tests exercise the real thing
# ---------------------------------------------------------------------------

gen_node_source() {
    cat <<EOF
# musicbox: node ${NODE_MAJOR} for the web server. See install.sh.
Types: deb
URIs: https://deb.nodesource.com/node_${NODE_MAJOR}.x
Suites: nodistro
Components: main
Signed-By: ${NODE_KEYRING}
EOF
}

gen_node_pin() {
    cat <<EOF
# musicbox: nodejs comes from NodeSource, never from Debian. See install.sh.
Package: nodejs
Pin: origin deb.nodesource.com
Pin-Priority: 600
EOF
}

emit_all() {
    local dest="$1"
    mkdir -p "$dest"
    gen_node_source > "${dest}/nodesource.sources"
    gen_node_pin    > "${dest}/nodesource.preferences"
    printf '  wrote nodesource.sources nodesource.preferences -> %s\n' "$dest"
}

# ---------------------------------------------------------------------------

# The installed node's major version, or nothing at all when node is absent.
node_major() {
    local version
    version="$(node --version 2>/dev/null)" || return 0
    version="${version#v}"
    printf '%s' "${version%%.*}"
}

# The NodeSource archive, its key and its pin. Idempotent: each file is written
# only when its content differs, and apt is only re-read when something did.
install_node_source() {
    local changed=0 tmp

    if [[ ! -s "$NODE_KEYRING" ]]; then
        if dry; then
            # curl is NOT required here. A dry run must change nothing and must
            # not fail on a tool it would only reach for when doing the real thing.
            printf '    %s[dry-run]%s would fetch %s -> %s\n' \
                "${C_DIM}" "${C_RESET}" "$NODE_KEY_URL" "$NODE_KEYRING"
        else
            command -v curl >/dev/null 2>&1 || die "curl is needed to fetch the NodeSource key"
            tmp="$(mktemp)"
            curl -fsSL --retry 3 "$NODE_KEY_URL" -o "$tmp" \
                || { rm -f "$tmp"; die "could not fetch the NodeSource signing key"; }
            # An armoured key apt will not read is worse than none: it fails at
            # update time, pointing at the archive rather than at this line.
            grep -q 'BEGIN PGP PUBLIC KEY BLOCK' "$tmp" \
                || { rm -f "$tmp"; die "NodeSource key is not an armoured PGP key"; }
            install -D -m 0644 "$tmp" "$NODE_KEYRING"
            rm -f "$tmp"
            ok "signing key -> ${NODE_KEYRING}"
        fi
        changed=1
    else
        skip "signing key already present"
    fi

    tmp="$(mktemp)"; gen_node_source > "$tmp"
    if install_if_changed "$tmp" "$NODE_SOURCE"; then
        dry || ok "apt source -> ${NODE_SOURCE}"
        changed=1
    else
        skip "apt source already current"
    fi

    tmp="$(mktemp)"; gen_node_pin > "$tmp"
    if install_if_changed "$tmp" "$NODE_PIN"; then
        dry || ok "apt pin -> ${NODE_PIN}"
        changed=1
    else
        skip "apt pin already current"
    fi

    [[ "$changed" -eq 1 ]] && run env DEBIAN_FRONTEND=noninteractive apt-get update
    return 0
}

remove_node_source() {
    local f removed=0
    for f in "$NODE_SOURCE" "$NODE_PIN" "$NODE_KEYRING"; do
        if [[ -e "$f" ]]; then run rm -f "$f"; ok "removed ${f}"; removed=1
        else skip "${f} is not there"; fi
    done
    [[ "$removed" -eq 1 ]] && run env DEBIAN_FRONTEND=noninteractive apt-get update
    return 0
}

usage() {
    cat <<'USAGE'
musicbox install.sh - installs packages for the music player stack

Usage: sudo ./install.sh [options]

Options:
  --dry-run    Show what would be installed, change nothing
  --yes, -y    Skip the confirmation prompt
  --emit DIR   Write the apt source and pin to DIR and exit. No root, no
               changes; this is what the tests read.
  --revert     Remove the NodeSource apt source, pin and key. Packages are
               left installed — see below.
  --help, -h   This message

--revert removes what this script CONFIGURES, not what it installed. Removing
mpd, node or the NAS clients from a working box is not something a script
should decide to do; apt-get purge is there for that, deliberately by hand.

Run order:
  setup.sh -> setup-hardware.sh -> install.sh -> setup-nas.sh -> setup-mpd.sh
  -> setup-server.sh -> setup-kiosk.sh
USAGE
}

main() {
    local emit_dest=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --dry-run)  DRY_RUN=1 ;;
            -y|--yes)   ASSUME_YES=1 ;;
            --emit)     shift; emit_dest="${1:-}"; [[ -n "$emit_dest" ]] || die "--emit needs a destination directory" ;;
            --revert)   REVERT=1 ;;
            -h|--help)  usage; exit 0 ;;
            *)          usage >&2; die "unknown option: $1" ;;
        esac
        shift
    done

    if [[ -n "$emit_dest" ]]; then
        emit_all "$emit_dest"
        exit 0
    fi

    printf '%smusicbox install.sh %s%s\n' "${C_BOLD}" "${SCRIPT_VERSION}" "${C_RESET}"
    dry && printf '%sDRY RUN - no changes will be made%s\n' "${C_YELLOW}" "${C_RESET}"

    [[ "$(id -u)" -eq 0 ]] || die "must run as root (try: sudo $0)"

    if [[ "$REVERT" -eq 1 ]]; then
        phase "Removing the NodeSource apt source"
        remove_node_source
        phase "Summary"
        log "The apt source, pin and key are gone. Packages were left alone:"
        log "node ${NODE_MAJOR} stays installed until apt is told otherwise."
        return 0
    fi

    phase "Node ${NODE_MAJOR} apt source"
    install_node_source

    phase "Packages"
    local p need=() major
    for p in "${PACKAGES[@]}"; do
        # nodejs is the one package where PRESENT is not the same as CURRENT:
        # the image ships Debian's node 20 and the backend needs node:sqlite.
        if [[ "$p" == "nodejs" ]]; then
            major="$(node_major)"
            if [[ -z "$major" ]]; then
                need+=("$p")
            elif [[ "$major" -lt "$NODE_MAJOR" ]]; then
                log "node ${major} is installed, ${NODE_MAJOR} is required — will upgrade"
                need+=("$p")
            else
                skip "nodejs ${major} already installed"
            fi
            continue
        fi
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
      sudo ./install/setup-bluetooth.sh  # Bluetooth A2DP sink

    Installing mpd does NOT configure or enable it. On Trixie the package leaves
    mpd.service and mpd.socket disabled and inactive, on a default config
    pointing at /var/lib/mpd/music. setup-mpd.sh is what makes it useful.

    Not implemented yet: USB CD.
EOF
}

main "$@"
