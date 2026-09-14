#!/usr/bin/env bash
#
# musicbox — setup-bluetooth.sh
#
# Turns the box into a Bluetooth speaker: a phone pairs with no prompt, connects,
# and plays through the HiFiBerry DAC.
#
# Run order:
#   setup.sh -> setup-hardware.sh -> install.sh -> setup-nas.sh -> setup-mpd.sh
#   -> setup-server.sh -> setup-bluetooth.sh -> setup-kiosk.sh
#
# THIS SCRIPT INSTALLS NOTHING. bluez-alsa-utils and bluez-tools come from
# install.sh; bluez is already on the image and setup.sh keeps it running.
#
# THE ONE HARD CONSTRAINT: hw:0,0 IS EXCLUSIVE
#   MPD opens the DAC raw, with no dmix and no sound server, because that is what
#   makes the bit-perfect passthrough measured in .claude/docs/device.md true. So
#   exactly one of MPD and Bluetooth can hold the card, and both directions of the
#   handoff race:
#
#     a phone connects   bluealsa-aplay opens hw:0,0 while MPD still has it
#     play is pressed    MPD opens hw:0,0 while bluealsa-aplay still has it
#
#   bluealsa-aplay has no retry when the device is busy, so this cannot be left to
#   chance. /usr/local/bin/musicbox-bt is the single component that sequences
#   release-then-acquire in both directions, and it is the ONLY thing permitted to
#   start musicbox-bt-audio.service. Debian's own bluealsa-aplay.service is masked
#   for exactly that reason.
#
# WHY THE ARBITER IS NOT IN THE WEB SERVER
#   It has to keep working while the server is being redeployed, and when someone
#   drives MPD with mpc directly. Playback must not depend on the web UI being
#   alive. The server only READS /run/musicbox/bluetooth.json; see
#   src/backend/src/bluetooth.ts.
#
# CODECS
#   Debian's bluez-alsa is not linked against fdk-aac (it is non-free), so there
#   is no AAC and an iPhone lands on SBC-XQ. PipeWire is built the same way, so
#   this is not a stack choice. aptX and aptX HD are NOT enabled by default and
#   are asked for explicitly below. Fallback is not code: as a sink we advertise
#   capabilities and the phone picks. See .claude/docs/bluetooth.md.
#
# PAIRING IS OPEN
#   Always discoverable, just-works pairing, no keyboard on the box. Anyone in
#   radio range can pair. That is commodity-speaker behaviour and it is a
#   deliberate choice, not an oversight.
#
# Usage:
#   sudo ./setup-bluetooth.sh --dry-run
#   sudo ./setup-bluetooth.sh
#   sudo ./setup-bluetooth.sh --revert
#
#   ./setup-bluetooth.sh --emit DEST
#       Write every generated artifact to a directory and exit. Touches no system
#       state, needs no root; used by the tests and handy for review.

set -euo pipefail

readonly SCRIPT_VERSION="1.0.0"
readonly BLOCK_BEGIN="# >>> musicbox setup-bluetooth.sh managed block >>>"
readonly BLOCK_END="# <<< musicbox setup-bluetooth.sh managed block <<<"

readonly CONF_DIR="/etc/musicbox"
readonly STATE_DIR="/var/lib/musicbox"

# BlueZ's own configuration. GKeyFile merges duplicate sections with later keys
# winning, so an appended block overrides the defaults above it — verified
# against GLib.KeyFile rather than assumed.
readonly MAIN_CONF="/etc/bluetooth/main.conf"

# A systemd DROP-IN, not /etc/default/bluez-alsa.
#
# That file exists on the system and is a decoy: Debian's bluealsa.service has no
# EnvironmentFile at all and a hardcoded
# ExecStart=/usr/bin/bluealsa -S -p a2dp-source -p a2dp-sink, so anything written
# there is read by nothing. Verified on the device — the daemon was running with
# none of our options after a first attempt did exactly that.
#
# The unit's own comments name the supported route: override ExecStart in a
# drop-in, clearing it first. A whole file we own also means no managed block and
# an exact revert.
readonly OVERRIDE_DIR="/etc/systemd/system/bluealsa.service.d"
readonly OVERRIDE_FILE="${OVERRIDE_DIR}/musicbox.conf"

readonly ARBITER_BIN="/usr/local/bin/musicbox-bt"
readonly MONITOR_UNIT="/etc/systemd/system/musicbox-bt-monitor.service"
readonly AUDIO_UNIT="/etc/systemd/system/musicbox-bt-audio.service"
readonly AGENT_UNIT="/etc/systemd/system/musicbox-bt-agent.service"

# Read by the web server. /run is a tmpfs, deliberately: which phone is connected
# is true only for this boot. Must match DEFAULT_STATE_PATH in
# src/backend/src/bluetooth.ts — the tests assert the two agree.
readonly RUN_DIR="/run/musicbox"
readonly STATE_FILE="${RUN_DIR}/bluetooth.json"

# The web server writes playback commands here; the arbiter reads them.
#
# A FIFO rather than the server calling BlueZ itself. Its user is in fact allowed
# to (BlueZ's shipped policy has `context="default"` send access), but the server
# is deliberately kept free of subprocesses so a bug there cannot reach the audio
# path — and `disconnect` has to be decided here anyway, since it hands the DAC
# back. Group-writable by the server's user, nothing wider.
readonly CONTROL_FIFO="${RUN_DIR}/control"
readonly CONTROL_GROUP="musicbox"

# Card 0 is unambiguously the DAC: setup-hardware.sh removed the onboard and both
# vc4hdmi cards. Same device string as setup-mpd.sh's audio_output.
readonly CARD="0"
readonly ALSA_DEVICE="hw:0,0"

# How the arbiter tells whether the card has actually been released. When nobody
# holds it this file reads "closed"; while it is open it carries "state: ...".
readonly PCM_STATUS="/proc/asound/card${CARD}/pcm0p/sub0/status"

# The Class of Device a phone uses to decide we are a speaker: Audio/Video major
# (0x04), Loudspeaker minor (0x05 << 2).
#
# The service-class bits are deliberately ZERO. main.conf says "Only the major
# and minor device class bits are considered" — BlueZ derives the service bits
# from the profiles actually registered, so writing them here would be decoration
# that the running adapter contradicts. Observed on the device: this yields
# Class: 0x004c0414.
readonly DEVICE_CLASS="0x000414"

readonly ADAPTER_NAME="musicbox"

# Overridable so the tests can point the rfkill scan at a fixture tree.
RFKILL_ROOT="/sys/class/rfkill"

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

usage() { sed -n '3,56p' "$0" | sed 's/^# \{0,1\}//'; }

require_root() { [[ "$(id -u)" -eq 0 ]] || die "this needs root — run with sudo"; }

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
# Managed block handling. Shared shape with setup-mpd.sh and setup-nas.sh; both
# return the path to a temp file on stdout for the caller to install.
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
        # printf '%s\n', not '%s': callers pass a command substitution, which
        # strips the trailing newline, and the closing marker would otherwise land
        # glued to the last line of content. This bug has shipped once already.
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
# The radio.
#
# Found soft-blocked on the real box, with bluetoothd logging "Failed to set
# mode: Failed (0x03)" at every boot and the adapter reporting
# PowerState: off-blocked. Nothing in this repo did it, and `rfkill` the command
# is not installed — so the block is cleared through sysfs, which systemd-rfkill
# then persists across reboots.
#
# Scans by type rather than by index: rfkill numbering is not stable, and
# rfkill0 being Bluetooth on this board today is not a contract.
# ---------------------------------------------------------------------------

unblock_bluetooth() {
    local d kind name changed=0 found=0
    for d in "${RFKILL_ROOT}"/rfkill*; do
        [[ -r "${d}/type" ]] || continue
        kind="$(cat "${d}/type" 2>/dev/null)" || continue
        [[ "$kind" == "bluetooth" ]] || continue
        found=1
        name="$(cat "${d}/name" 2>/dev/null || echo "${d##*/}")"
        if [[ "$(cat "${d}/hard" 2>/dev/null || echo 0)" != "0" ]]; then
            warn "${name} is HARD-blocked — that is a physical switch, not something software can clear"
            continue
        fi
        if [[ "$(cat "${d}/soft" 2>/dev/null || echo 0)" == "0" ]]; then
            skip "${name} already unblocked"
            continue
        fi
        if dry; then
            printf '    %s[dry-run]%s would unblock %s\n' "${C_DIM}" "${C_RESET}" "$name"
        else
            printf '0' > "${d}/soft" || { warn "could not unblock ${name}"; continue; }
            ok "${name} unblocked"
        fi
        changed=1
    done
    (( found )) || warn "no Bluetooth rfkill switch found under ${RFKILL_ROOT} — is the radio present?"
    return $(( changed ? 0 : 1 ))
}

# ---------------------------------------------------------------------------
# Artifact generators — pure, so --emit and the tests exercise the real thing
# ---------------------------------------------------------------------------

gen_mainconf_block() {
    cat <<CONF
# BlueZ is configured here rather than at runtime so the settings survive a
# reboot and a bluetoothd restart. Duplicate sections are legal: GKeyFile merges
# them and the later key wins, which is what lets this block override the
# defaults above without editing them in place.
[General]
# What the phone shows in its Bluetooth list.
Name = ${ADAPTER_NAME}
# Audio + Rendering service, Audio/Video major, Loudspeaker minor. Without this
# the box advertises class 0 and phones offer to pair with it as a generic
# peripheral rather than a speaker.
Class = ${DEVICE_CLASS}
# Zero means "no timeout", not "off". A speaker that stops being findable after
# three minutes is a speaker nobody can pair with, and this box has no screen to
# say so and no keyboard to fix it.
DiscoverableTimeout = 0
PairableTimeout = 0
AlwaysPairable = true

[Policy]
# Power the adapter at boot. Necessary but not sufficient: it stays down while
# the rfkill soft block is set, which is how this box shipped.
AutoEnable = true
CONF
}

gen_bluealsa_override() {
    cat <<CONF
# Drop-in for Debian's bluealsa.service. Generated by install/setup-bluetooth.sh.
#
# ExecStart is cleared before being set: systemd APPENDS to a list-valued
# directive otherwise, and two ExecStart lines in a Type=dbus unit is an error.
# Debian's unit documents this same dance in its own comments.
#
# -p a2dp-sink        we RECEIVE audio; the phone is the source. Debian's default
#                     also enables a2dp-source, which this box has no use for.
# -c aptX -c aptX-HD  neither is on by default — bluealsa enables only SBC (the
#                     device reports "a2dp-sink: SBC, MP3, aptX, aptX-HD,
#                     FastStream, Opus", and no AAC, because Debian cannot link
#                     the non-free fdk-aac). Without these two the expensive
#                     codec support silently does not happen.
# --sbc-quality=xq    raises the SBC capabilities we advertise. This is the one
#                     that matters for iPhones, which support only SBC and AAC
#                     and cannot have AAC here.
# --a2dp-volume       the phone attenuates BEFORE encoding and nothing on this
#                     box touches the signal. The alternative is bluealsa
#                     applying a software volume, which would attenuate a second
#                     time and fight musicbox-dac-unity.service.
# -S                  log to syslog, as Debian's unit does.
[Service]
ExecStart=
ExecStart=/usr/bin/bluealsa -S -p a2dp-sink -c aptX -c aptX-HD --sbc-quality=xq --a2dp-volume
CONF
}

gen_audio_unit() {
    cat <<UNIT
[Unit]
Description=musicbox Bluetooth audio output
Documentation=https://github.com/LukeMcDonnell/pi-musicbox
#
# THERE IS NO [Install] SECTION, AND THAT IS THE POINT.
#
# This unit opens ${ALSA_DEVICE} exclusively. Starting it at boot, or on a
# transport appearing, would race MPD for the card and lose — bluealsa-aplay does
# not retry a busy device. musicbox-bt starts it only after MPD has been paused
# and the card has actually gone quiet, and stops it before MPD is allowed back.
#
# Debian's own bluealsa-aplay.service is masked by setup-bluetooth.sh for the
# same reason. If you find yourself enabling this unit, read the script header
# first.
#
After=bluealsa.service
BindsTo=bluealsa.service

[Service]
Type=simple
User=root
Group=audio
#
# --single-audio  without it a second connected phone opens its own handle on
#                 ${ALSA_DEVICE} and fails, because the device is exclusive.
# --volume=none   leave the local mixer alone; the phone owns volume, and
#                 musicbox-dac-unity.service owns the DAC's gain stages.
# -D              the DAC explicitly, never "default".
ExecStart=/usr/bin/bluealsa-aplay -S -D ${ALSA_DEVICE} --profile-a2dp --single-audio --volume=none
# Restart=no, deliberately: if this exits because the card was busy, restarting
# into the same race just fills the journal. musicbox-bt owns the retry decision.
Restart=no
StandardOutput=journal
StandardError=journal
SyslogIdentifier=musicbox-bt-audio
UNIT
}

gen_agent_unit() {
    cat <<UNIT
[Unit]
Description=musicbox Bluetooth pairing agent
Documentation=https://github.com/LukeMcDonnell/pi-musicbox
#
# BlueZ needs a registered agent to accept a pairing request. This box has no
# keyboard and no way to display a passkey, so the capability is NoInputNoOutput:
# "just works" pairing, which is what every commodity Bluetooth speaker does.
#
After=bluetooth.service
Wants=bluetooth.service

[Service]
Type=simple
ExecStart=/usr/bin/bt-agent --capability=NoInputNoOutput
Restart=always
RestartSec=2
#
# bt-agent catches SIGTERM and then never exits, so every shutdown paid the full
# 90s stop timeout. It does exit on SIGINT, unregistering from BlueZ on the way
# out; TimeoutStopSec bounds it if that ever stops being true.
#
KillSignal=SIGINT
TimeoutStopSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=musicbox-bt-agent

[Install]
WantedBy=multi-user.target
UNIT
}

gen_monitor_unit() {
    cat <<UNIT
[Unit]
Description=musicbox Bluetooth source arbiter
Documentation=https://github.com/LukeMcDonnell/pi-musicbox
#
# Owns the handoff of ${ALSA_DEVICE} between MPD and Bluetooth, in both
# directions. Runs as root because it starts units and disconnects devices; the
# web server only reads the file it publishes.
#
# NOT ordered after musicbox-server.service and NOT wanted by it: the handoff has
# to keep working while the server is being redeployed. That independence is the
# whole reason this lives here instead of in the backend.
#
After=bluetooth.service bluealsa.service mpd.service
Wants=bluetooth.service bluealsa.service

[Service]
Type=simple
ExecStart=${ARBITER_BIN} monitor
Restart=always
RestartSec=2

# Creates ${RUN_DIR} at 0755 so the unprivileged web server can read the state
# file and write to the control FIFO.
#
# PRESERVED ACROSS RESTARTS, and that is load-bearing. Without this systemd
# deletes the directory on stop and makes a new one on start, and the web server's
# inotify watch — which is on the directory, because the state file is replaced by
# rename — is left pointing at a dead inode. Observed on the device: after a
# redeploy the arbiter published correctly and the API showed nothing at all until
# the next slow poll. The server also re-arms on a changed inode, so this is the
# belt to that braces.
RuntimeDirectory=musicbox
RuntimeDirectoryMode=0755
RuntimeDirectoryPreserve=yes

StandardOutput=journal
StandardError=journal
SyslogIdentifier=musicbox-bt

[Install]
WantedBy=multi-user.target
UNIT
}

gen_arbiter() {
    # Two heredocs on purpose. The preamble is UNQUOTED so the paths above are
    # substituted; it therefore contains bare assignments and nothing else — no
    # backticks, no command substitution, no prose. Everything that could contain
    # either lives in the quoted heredoc below, where the shell cannot touch it.
    # An unquoted heredoc executing its own comments has shipped twice in this
    # repo; tests/test-bluetooth-config.sh asserts --emit writes nothing to stderr.
    cat <<PREAMBLE
#!/usr/bin/env bash
#
# musicbox-bt — the Bluetooth source arbiter.
#
# Generated by install/setup-bluetooth.sh. Do not edit here; edit the generator.
#
STATE_FILE="${STATE_FILE}"
CONTROL_FIFO="${CONTROL_FIFO}"
CONTROL_GROUP="${CONTROL_GROUP}"
RUN_DIR="${RUN_DIR}"
PCM_STATUS="${PCM_STATUS}"
ALSA_DEVICE="${ALSA_DEVICE}"
AUDIO_UNIT="musicbox-bt-audio.service"
PREAMBLE
    cat <<'ARBITER'

# set -e is DELIBERATELY ABSENT. This is a long-lived daemon reacting to two
# event streams it does not control: bluetoothctl, mpc and bluealsa-cli all fail
# transiently when their services restart, and -e would turn each of those into a
# dead arbiter and a box that silently stops switching sources. Failures are
# handled where they happen instead.
set -uo pipefail

# How long to wait for the card to actually go quiet after asking the current
# owner to let go. Generous: an NFS-backed MPD can take a moment, and overshooting
# costs a slightly longer gap while undershooting costs a failed handoff.
readonly RELEASE_TIMEOUT_S=5

# The phone currently holding the DAC, or empty. Name and codec are kept
# alongside the address because the 1Hz AVRCP tick republishes the whole document
# and would otherwise have to re-derive them from BlueZ every second.
ACTIVE_ADDR=""
ACTIVE_PATH=""
ACTIVE_NAME=""
ACTIVE_CODEC=""

log() { printf 'musicbox-bt: %s\n' "$*"; }

# --- publishing -------------------------------------------------------------

# JSON-escape a string. Device names are user-chosen: apostrophes, quotes,
# backslashes and emoji all turn up. Raw UTF-8 is valid JSON, so only the two
# structural characters and the control range need handling.
json_string() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="$(printf '%s' "$s" | tr -d '\000-\037')"
    printf '"%s"' "$s"
}

# Write the state file by rename, never in place.
#
# The reader is a Node fs.watch in the web server. An in-place write is visible
# half-finished, and the reader would parse a truncated document; the rename makes
# the swap atomic. The reader watches the DIRECTORY for the same reason — a rename
# replaces the inode and a watch on the file itself goes deaf.
publish_raw() {
    local body="$1" tmp
    mkdir -p "$RUN_DIR" 2>/dev/null
    tmp="${STATE_FILE}.tmp"
    printf '%s\n' "$body" > "$tmp" 2>/dev/null || { log "cannot write ${tmp}"; return 1; }
    chmod 0644 "$tmp" 2>/dev/null
    mv -f "$tmp" "$STATE_FILE" 2>/dev/null || { log "cannot publish ${STATE_FILE}"; return 1; }
}

# Append `,"key":value` only when the value is non-empty, so absent stays absent
# rather than becoming an empty string the reader has to special-case.
json_field() {
    local key="$1" value="$2"
    [[ -n "$value" ]] || return 0
    printf ',%s:%s' "$(json_string "$key")" "$(json_string "$value")"
}

json_number() {
    local key="$1" value="$2"
    # Digits only. Anything else is dropped rather than emitted, because a
    # malformed number would make the whole document unparseable and lose the
    # device along with it.
    [[ "$value" =~ ^[0-9]+$ ]] || return 0
    printf ',%s:%s' "$(json_string "$key")" "$value"
}

# publish_device <name> <addr> <codec> [status title artist album durationMs positionMs trackNumber numberOfTracks repeat shuffle]
#
# Everything after the codec is AVRCP and therefore optional: it arrives after the
# transport does, and some players report almost nothing.
publish_device() {
    local name="$1" addr="$2" codec="$3" body
    body="{$(json_string name):$(json_string "$name"),$(json_string address):$(json_string "$addr")"
    # Omitted rather than null when absent: the reader treats a missing codec as
    # "not negotiated yet", which is exactly what this is.
    body="${body}$(json_field codec "$codec")"
    body="${body}$(json_field status "${4:-}")"
    body="${body}$(json_field title "${5:-}")"
    body="${body}$(json_field artist "${6:-}")"
    body="${body}$(json_field album "${7:-}")"
    body="${body}$(json_number durationMs "${8:-}")"
    body="${body}$(json_number positionMs "${9:-}")"
    body="${body}$(json_number trackNumber "${10:-}")"
    body="${body}$(json_number numberOfTracks "${11:-}")"
    body="${body}$(json_field repeat "${12:-}")"
    body="${body}$(json_field shuffle "${13:-}")"
    publish_raw "${body}}"
}

publish_none() { publish_raw '{}'; }

# --- the DAC ----------------------------------------------------------------

# True while somebody holds the card. The status file reads "closed" when it is
# free and carries "state: ..." when it is open.
dac_busy() { grep -qs '^state:' "$PCM_STATUS"; }

# Wait for the current owner to actually let go. Asking is not the same as it
# having happened, and handing the card over early is the whole failure this
# script exists to prevent.
wait_for_dac() {
    local waited=0
    while dac_busy; do
        if (( waited >= RELEASE_TIMEOUT_S * 10 )); then
            log "WARNING: ${ALSA_DEVICE} still busy after ${RELEASE_TIMEOUT_S}s"
            return 1
        fi
        sleep 0.1
        waited=$((waited + 1))
    done
    return 0
}

# Wait for bluealsa-aplay to actually be gone.
#
# This is a DIFFERENT question from "is the card free", and conflating the two
# broke the reverse handoff once. When MPD is taking the card back, MPD is
# supposed to end up holding it — so waiting for the card to go quiet waits for
# the wrong thing, times out, and then fires a corrective action on a box that was
# about to be fine. What has to be true before MPD can succeed is only that OUR
# player has exited.
wait_for_aplay() {
    local waited=0
    while pgrep -x bluealsa-aplay >/dev/null 2>&1; do
        if (( waited >= RELEASE_TIMEOUT_S * 10 )); then
            log "WARNING: bluealsa-aplay still running after ${RELEASE_TIMEOUT_S}s"
            return 1
        fi
        sleep 0.1
        waited=$((waited + 1))
    done
    return 0
}

# --- BlueZ ------------------------------------------------------------------

# Keep the adapter powered, findable and pairable.
#
# Re-asserted after every disconnect, not just at startup: a phone that has just
# wandered off is the moment another one is most likely to go looking, and BlueZ
# has been known to drop discoverability when a client that set it goes away.
assert_adapter() {
    # Only the two RUNTIME properties. Pairability is owned by main.conf's
    # AlwaysPairable, so calling `bluetoothctl pairable on` here was redundant —
    # and bluetoothctl 5.82 was observed segfaulting on exactly that invocation
    # once on this box. Harmless, because this script deliberately has no `set -e`,
    # but a call that cannot help is not worth the exposure.
    bluetoothctl power on        >/dev/null 2>&1
    bluetoothctl discoverable on >/dev/null 2>&1
}

# The phone's own name. Alias first because that is what BlueZ shows and what the
# user renamed it to; Name is the raw advertised value.
device_name() {
    local addr="$1" name
    name="$(bluetoothctl info "$addr" 2>/dev/null | sed -n 's/^[[:space:]]*Alias:[[:space:]]*//p' | head -1)"
    [[ -n "$name" ]] || name="$(bluetoothctl info "$addr" 2>/dev/null | sed -n 's/^[[:space:]]*Name:[[:space:]]*//p' | head -1)"
    # Never empty: the reader rejects a nameless device, and an address is a
    # better thing to show than nothing at all.
    printf '%s' "${name:-$addr}"
}

# The negotiated A2DP codec, or empty if it cannot be read yet. Empty is fine —
# it publishes as "not negotiated" and the next event fills it in.
device_codec() {
    local path="$1"
    bluealsa-cli info "$path" 2>/dev/null \
        | sed -n 's/^[[:space:]]*Selected codec:[[:space:]]*//Ip' | head -1
}

# --- AVRCP ------------------------------------------------------------------
#
# What the phone is playing, and the buttons that control it, come from
# org.bluez.MediaPlayer1 on /org/bluez/hciN/dev_<addr>/playerM.
#
# POLLED, NOT SUBSCRIBED. Every property is emits-change, so `busctl monitor`
# would be the event-driven answer — but it needs org.freedesktop.DBus.Monitoring
# and even root's access to that is worth not depending on. A one-second poll only
# runs while a phone is connected, is a couple of milliseconds of work, and is
# proven. Revisit with a measurement, not a preference.
#
# The player path is discovered rather than assumed: the object only exists while
# connected, and the index is not always 0.
avrcp_path() {
    local addr="$1" dev
    dev="dev_${addr//:/_}"
    busctl --list tree org.bluez 2>/dev/null \
        | sed -n "s#^\(/org/bluez/hci[0-9]*/${dev}/player[0-9]*\)\$#\1#p" | head -1
}

# Read every MediaPlayer1 property in ONE call and flatten it to tab-separated
# fields, in a fixed order:
#
#   status  title  artist  album  durationMs  positionMs  trackNumber  numberOfTracks  repeat  shuffle
#
# WHY python3 AND NOT sed. busctl's JSON nests every value as
# {"type":...,"data":...}, and the obvious sed for it truncates at the first comma
# or quote inside a song title — which is most of them. python3 is in the base
# image (python3.13-minimal, and `json` comes with it) and this is one invocation
# per poll. A silently wrong title is worse than a dependency that is already
# installed; preflight checks for it.
avrcp_read() {
    local path="$1"
    busctl --json=short call org.bluez "$path" \
        org.freedesktop.DBus.Properties GetAll s org.bluez.MediaPlayer1 2>/dev/null \
        | python3 -c '
import json, sys

def unwrap(node):
    """busctl wraps every value as {"type": ..., "data": ...}."""
    return node.get("data") if isinstance(node, dict) and "data" in node else None

try:
    payload = unwrap(json.load(sys.stdin))
except Exception:
    sys.exit(0)

# GetAll comes back as a one-element array holding the dict.
if isinstance(payload, list):
    payload = payload[0] if payload else {}
if not isinstance(payload, dict):
    sys.exit(0)

props = {k: unwrap(v) for k, v in payload.items()}
track = props.get("Track")
track = {k: unwrap(v) for k, v in track.items()} if isinstance(track, dict) else {}

def text(value):
    # Tabs and newlines would break the field split on the way back into bash.
    return "" if value is None else str(value).replace("\t", " ").replace("\n", " ")

print("\t".join(text(v) for v in (
    props.get("Status"),
    track.get("Title"),
    track.get("Artist"),
    track.get("Album"),
    track.get("Duration"),
    props.get("Position"),
    track.get("TrackNumber"),
    track.get("NumberOfTracks"),
    props.get("Repeat"),
    props.get("Shuffle"),
)))
' 2>/dev/null
}

# Read everything AVRCP knows and publish it, but ONLY IF SOMETHING CHANGED.
#
# The change check is the whole reason this is not expensive. Rewriting the state
# file every second would push an SSE frame to every client and repaint the panel
# at 1Hz, and repaints here go through the vc4 commit path that has hard-locked
# this board. Position is deliberately NOT part of the comparison for the same
# reason: the client interpolates it, exactly as it does for MPD.
LAST_AVRCP=""
avrcp_publish() {
    local name="$1" addr="$2" codec="$3" path line
    path="$(avrcp_path "$addr")"
    if [[ -z "$path" ]]; then
        # No player object: the phone connected A2DP without AVRCP, or has not got
        # round to it yet. The device is still published, just bare.
        [[ "$LAST_AVRCP" == "none" ]] && return 0
        LAST_AVRCP="none"
        publish_device "$name" "$addr" "$codec"
        return 0
    fi

    line="$(avrcp_read "$path")"
    if [[ -z "$line" ]]; then
        [[ "$LAST_AVRCP" == "silent" ]] && return 0
        LAST_AVRCP="silent"
        publish_device "$name" "$addr" "$codec"
        return 0
    fi

    local status title artist album duration position number total repeat shuffle
    IFS=$'\t' read -r status title artist album duration position number total repeat shuffle <<<"$line"

    local sig="${status}|${title}|${artist}|${album}|${duration}|${number}|${total}|${repeat}|${shuffle}"
    [[ "$sig" == "$LAST_AVRCP" ]] && return 0
    LAST_AVRCP="$sig"
    publish_device "$name" "$addr" "$codec" "$status" "$title" "$artist" "$album" \
        "$duration" "$position" "$number" "$total" "$repeat" "$shuffle"
}

# Send one transport command to the phone.
#
# The backend's own user could make this call directly — BlueZ allows it — but it
# is routed here so the backend stays free of subprocesses and never has to learn
# D-Bus object paths. See the header.
avrcp_command() {
    local method="$1" path
    [[ -n "$ACTIVE_ADDR" ]] || { log "no device to send ${method} to"; return 1; }
    path="$(avrcp_path "$ACTIVE_ADDR")"
    [[ -n "$path" ]] || { log "no AVRCP player for ${ACTIVE_ADDR}"; return 1; }
    busctl call org.bluez "$path" org.bluez.MediaPlayer1 "$method" >/dev/null 2>&1 \
        || { log "AVRCP ${method} was refused"; return 1; }
    log "AVRCP ${method}"
}

# AA:BB:CC:DD:EE:FF out of /org/bluealsa/hci0/dev_AA_BB_CC_DD_EE_FF/a2dpsrc/sink
addr_from_path() {
    local path="$1" dev
    dev="$(printf '%s' "$path" | sed -n 's#.*/dev_\([0-9A-Fa-f_]\{17\}\).*#\1#p')"
    printf '%s' "${dev//_/:}"
}

# --- the handoff ------------------------------------------------------------

# A phone connected. MPD gets out of the way, then Bluetooth takes the card.
#
# The order is the entire point: pause, WAIT, then start. Starting the audio unit
# first means bluealsa-aplay opens a busy device, gets EBUSY, and exits without
# retrying — silence, with both sides thinking they did their job.
take_for_bluetooth() {
    local path="$1" addr name codec
    addr="$(addr_from_path "$path")"
    [[ -n "$addr" ]] || { log "could not read an address out of ${path}"; return 1; }

    ACTIVE_ADDR="$addr"
    ACTIVE_PATH="$path"
    name="$(device_name "$addr")"
    ACTIVE_NAME="$name"
    ACTIVE_CODEC=""
    log "connected: ${name} (${addr})"

    # Publish before the handoff, so the UI reflects what is happening while it
    # happens rather than after. The codec is not known this early.
    publish_device "$name" "$addr" ""

    # pause, not stop: it keeps the queue position, so the panel's play button
    # resumes in place. Failure here is normal — MPD may be stopped already.
    mpc pause >/dev/null 2>&1

    wait_for_dac || log "starting ${AUDIO_UNIT} anyway; it may fail to open the card"
    systemctl start "$AUDIO_UNIT" >/dev/null 2>&1 || log "failed to start ${AUDIO_UNIT}"

    # The codec is only decided once the transport is up, so this is a second
    # publish rather than a delayed first one.
    codec="$(device_codec "$path")"
    [[ -n "$codec" ]] && log "codec: ${codec}"
    ACTIVE_CODEC="$codec"

    # Straight into the AVRCP path rather than a bare publish, so the first
    # snapshot a client sees already carries whatever the phone is playing. It
    # also primes LAST_AVRCP, so the tick that follows a second later is a no-op.
    LAST_AVRCP=""
    avrcp_publish "$name" "$addr" "$codec"
}

# Bluetooth is done with the card, either because the phone went away or because
# MPD is taking it back.
#
# MPD IS NOT RESUMED. A phone going out of range or running out of battery must
# not start the speaker playing to an empty room.
release_bluetooth() {
    systemctl stop "$AUDIO_UNIT" >/dev/null 2>&1
    ACTIVE_ADDR=""
    ACTIVE_PATH=""
    ACTIVE_NAME=""
    ACTIVE_CODEC=""
    LAST_AVRCP=""
    publish_none
    assert_adapter
}

# MPD started playing while a phone held the card. Bluetooth loses.
#
# BY THE TIME THIS RUNS, MPD HAS ALREADY FAILED. It was told to play, found the
# card held by bluealsa-aplay, logged "exception: Failed to open audio output" and
# PAUSED ITSELF. Measured on the device. So this is not just a matter of getting
# out of the way: MPD has to be actively restarted, and in this order:
#
#   1. disconnect the phone
#   2. stop our player and wait for it to be GONE (not for the card to be free —
#      MPD is the one that should end up holding it)
#   3. toggle the output, because MPD has cached the failed open and will not
#      retry it promptly
#   4. play, because MPD paused itself
#
# Step 4 is not a violation of "never auto-resume". That rule is about a phone
# wandering off on its own; here the user explicitly asked for playback and MPD
# failed to deliver it. Finishing what was asked for is the whole job.
take_for_mpd() {
    local addr="$ACTIVE_ADDR"
    log "MPD is playing — disconnecting ${addr}"
    bluetoothctl disconnect "$addr" >/dev/null 2>&1
    release_bluetooth
    wait_for_aplay || log "WARNING: taking ${ALSA_DEVICE} for MPD anyway"

    mpc disable 1 >/dev/null 2>&1
    mpc enable 1  >/dev/null 2>&1
    # Resumes rather than restarts: MPD is paused, not stopped, so the position is
    # where the user left it.
    mpc play >/dev/null 2>&1
    log "MPD has ${ALSA_DEVICE}: $(mpc status 2>/dev/null | sed -n 2p)"
}

# End the session because someone asked, not because the phone went away.
#
# MPD IS NOT RESUMED, which is the same rule as a phone wandering out of range:
# this gives the speaker back, it does not start playing to an empty room. MPD is
# still paused where it was, so the next press of play resumes in place.
#
# No output toggle needed either, unlike take_for_mpd: MPD never tried to open the
# card during the session, so it has no cached failure to clear.
ctl_disconnect() {
    if [[ -z "$ACTIVE_ADDR" ]]; then
        log "disconnect requested but nothing is connected"
        return 0
    fi
    log "disconnect requested: ${ACTIVE_ADDR}"
    bluetoothctl disconnect "$ACTIVE_ADDR" >/dev/null 2>&1
    release_bluetooth
}

# --- event handling ---------------------------------------------------------

handle_bt() {
    local line="$1" event path
    event="${line%% *}"
    path="${line#* }"
    case "$event" in
        PCMAdded)
            # Only A2DP. The same daemon also publishes HFP/HSP PCMs for hands-free
            # profiles, which are 8kHz voice and must never reach the DAC.
            [[ "$path" == *a2dp* ]] || return 0
            [[ -z "$ACTIVE_ADDR" ]] || return 0
            take_for_bluetooth "$path"
            ;;
        PCMRemoved)
            [[ "$path" == *a2dp* ]] || return 0
            [[ -n "$ACTIVE_ADDR" ]] || return 0
            log "disconnected: ${ACTIVE_ADDR}"
            release_bluetooth
            ;;
        ServiceStopped)
            # bluealsa went away and took every transport with it.
            [[ -n "$ACTIVE_ADDR" ]] || return 0
            log "bluealsa stopped — releasing the card"
            release_bluetooth
            ;;
    esac
}

handle_mpd() {
    [[ -n "$ACTIVE_ADDR" ]] || return 0
    local state
    state="$(mpc status 2>/dev/null | sed -n 's/^\[\([a-z]*\)\].*/\1/p' | head -1)"
    [[ "$state" == "playing" ]] || return 0
    take_for_mpd
}

# One line from the web server's control FIFO.
#
# The verbs are a closed set, matching CONTROL_VERBS in
# src/backend/src/bluetooth.ts. Anything else is logged and dropped: this is a
# line from another process being fed into a shell, and "whatever arrived" has no
# business reaching a command.
handle_ctl() {
    local verb="$1"
    case "$verb" in
        play)       avrcp_command Play ;;
        pause)      avrcp_command Pause ;;
        stop)       avrcp_command Stop ;;
        next)       avrcp_command Next ;;
        previous)   avrcp_command Previous ;;
        disconnect) ctl_disconnect ;;
        *)          log "ignoring unknown control verb: ${verb}" ;;
    esac
}

# The 1Hz tick, which only does work while a phone is connected.
#
# The tick itself is unconditional because the emitting subshell cannot see
# ACTIVE_ADDR — it is a background job, and the variable lives in the reader's
# shell. Costing one read and one test per second when idle is cheaper than any
# scheme for starting and stopping the ticker.
handle_tick() {
    [[ -n "$ACTIVE_ADDR" ]] || return 0
    avrcp_publish "$ACTIVE_NAME" "$ACTIVE_ADDR" "$ACTIVE_CODEC"
}

avrcp_ticker() {
    while :; do
        printf 'poll\n'
        sleep 1
    done
}

# Tag and restart one event source forever.
#
# Both streams are long-lived pipes from services that get restarted, so each has
# to come back by itself. The tag is what lets a single reader multiplex them; the
# lines are short enough that two writers on one FIFO stay atomic.
feed() {
    local tag="$1"; shift
    while :; do
        "$@" 2>/dev/null | while IFS= read -r line; do
            [[ -n "$line" ]] && printf '%s %s\n' "$tag" "$line"
        done
        sleep 2
    done
}

do_monitor() {
    local fifo
    fifo="$(mktemp -u "${TMPDIR:-/tmp}/musicbox-bt.XXXXXX")"
    mkfifo "$fifo" || { log "cannot create ${fifo}"; exit 1; }

    # The web server's way in. Group-writable so the unprivileged server can send
    # a line, and nothing wider — this feeds a shell's read loop.
    #
    # Recreated every start rather than reused: a FIFO left by a previous run may
    # hold a half-written line, and inheriting one command from a dead arbiter is
    # a strange thing to do.
    rm -f "$CONTROL_FIFO"
    mkdir -p "$RUN_DIR" 2>/dev/null
    if mkfifo -m 0620 "$CONTROL_FIFO" 2>/dev/null; then
        chgrp "$CONTROL_GROUP" "$CONTROL_FIFO" 2>/dev/null \
            || log "WARNING: no ${CONTROL_GROUP} group — the web server cannot send commands"
        # HOLD IT OPEN FOR READING, and do not remove this.
        #
        # `cat` on a FIFO returns EOF as soon as the last writer closes, so each
        # command the server sent would end the feed and the restart loop would
        # leave a two-second window where the next one gets ENXIO — a button press
        # that does nothing, intermittently. Keeping our own descriptor open means
        # there is always a writer, so the reader never sees EOF.
        exec 9<>"$CONTROL_FIFO"
    else
        log "WARNING: could not create ${CONTROL_FIFO}; playback control from the web UI will not work"
    fi

    # Clearing the state on the way out matters now that the directory is
    # preserved across restarts: a stopped arbiter that left a device behind would
    # have the UI naming a phone that is not there.
    # shellcheck disable=SC2064
    trap "rm -f '$fifo' '$CONTROL_FIFO'; printf '{}\n' > '$STATE_FILE' 2>/dev/null; systemctl stop '$AUDIO_UNIT' >/dev/null 2>&1" EXIT

    # Start from a known state: nothing connected, nothing holding the card. A
    # restarted arbiter must not inherit a stale belief from the last one.
    systemctl stop "$AUDIO_UNIT" >/dev/null 2>&1
    publish_none
    assert_adapter
    log "watching for Bluetooth sources; ${ALSA_DEVICE} is MPD's until one arrives"

    feed bt   bluealsa-cli monitor        > "$fifo" &
    feed mpd  mpc idleloop player         > "$fifo" &
    feed ctl  cat "$CONTROL_FIFO"         > "$fifo" &
    feed tick avrcp_ticker                > "$fifo" &

    local tag rest
    while IFS=' ' read -r tag rest; do
        case "$tag" in
            bt)   handle_bt  "$rest" ;;
            mpd)  handle_mpd ;;
            ctl)  handle_ctl "$rest" ;;
            tick) handle_tick ;;
        esac
    done < "$fifo"
}

# --- entry point ------------------------------------------------------------

main() {
    case "${1:-help}" in
        monitor)
            do_monitor
            ;;
        status)
            cat "$STATE_FILE" 2>/dev/null || printf '{}\n'
            ;;
        release)
            # Hand the card back to MPD by force. For --revert and for getting out
            # of a wedged state by hand.
            [[ -n "${2:-}" ]] && bluetoothctl disconnect "$2" >/dev/null 2>&1
            systemctl stop "$AUDIO_UNIT" >/dev/null 2>&1
            publish_none
            ;;
        publish)
            # A TEST AND DEBUG HOOK, not part of the handoff: fake a connected
            # device so the whole UI path can be exercised without a phone, and so
            # the bash suite can assert the JSON escaping against awkward names.
            #
            #   musicbox-bt publish "Some Phone" AA:BB:CC:DD:EE:FF "aptX HD"
            #   musicbox-bt publish "Phone" AA:BB:CC:DD:EE:FF aptX-HD playing \
            #       "Title" "Artist" "Album" 329307 75388 1 8 off off
            #   musicbox-bt publish
            #
            # Every argument after the name is forwarded, so the AVRCP half can be
            # exercised too. Getting this wrong once meant the extra fields were
            # silently dropped and the JSON looked correct.
            if [[ -n "${2:-}" ]]; then
                shift
                publish_device "$1" "${2:-00:00:00:00:00:00}" "${3:-}" \
                    "${4:-}" "${5:-}" "${6:-}" "${7:-}" "${8:-}" "${9:-}" \
                    "${10:-}" "${11:-}" "${12:-}" "${13:-}"
            else
                publish_none
            fi
            cat "$STATE_FILE" 2>/dev/null
            ;;
        *)
            printf 'usage: musicbox-bt {monitor|status|release [ADDR]|publish [NAME ADDR [CODEC]]}\n'
            ;;
    esac
}

main "$@"
ARBITER
}

# ---------------------------------------------------------------------------
# Emit mode — no root, no system state, exactly the generators used by do_apply
# ---------------------------------------------------------------------------

emit_all() {
    local dest="$1"
    mkdir -p "$dest"
    gen_mainconf_block > "${dest}/main.conf.block"
    gen_bluealsa_override > "${dest}/bluealsa-override.conf"
    gen_arbiter        > "${dest}/musicbox-bt"
    gen_monitor_unit   > "${dest}/musicbox-bt-monitor.service"
    gen_audio_unit     > "${dest}/musicbox-bt-audio.service"
    gen_agent_unit     > "${dest}/musicbox-bt-agent.service"
    chmod 0755 "${dest}/musicbox-bt"

    # Run the REAL block writer against stock-shaped fixtures, so --emit exercises
    # the code path that edits the live files rather than only the generators.
    # setup-mpd.sh does the same; it is what catches marker-placement bugs.
    local fixture out
    fixture="${dest}/main.conf.fixture"
    printf '[General]\n#Name = BlueZ\n\n[Policy]\n#AutoEnable=false\n' > "$fixture"
    out="$(write_managed_block "$fixture" "$(gen_mainconf_block)")"
    mv "$out" "${dest}/main.conf.merged"

    printf '  wrote main.conf.block bluealsa-override.conf musicbox-bt musicbox-bt-monitor.service musicbox-bt-audio.service musicbox-bt-agent.service -> %s\n' "$dest"
}

# ---------------------------------------------------------------------------
# Apply
# ---------------------------------------------------------------------------

have_pkg() {
    dpkg-query -W -f='${db:Status-Status}' "$1" 2>/dev/null | grep -q '^installed$'
}

backup_once() {
    local file="$1" label="$2"
    if [[ ! -f "$file" ]]; then
        skip "${file} does not exist yet — nothing to back up"
    elif grep -qF "$BLOCK_BEGIN" "$file"; then
        skip "${file} already carries our block — keeping the original backup"
    else
        run cp -a "$file" "${STATE_DIR}/${label}.before-bluetooth-$(date +%Y%m%d-%H%M%S)"
        dry || ok "${file} backed up (pristine)"
    fi
}

do_apply() {
    require_root

    phase "Preflight"
    have_pkg bluez || die "bluez is not installed — it should be on the image"
    have_pkg bluez-alsa-utils || die "bluez-alsa-utils is not installed — run install.sh first"
    have_pkg bluez-tools || die "bluez-tools is not installed — run install.sh first"
    have_pkg mpc || warn "mpc missing — the arbiter needs it to see MPD; run install.sh"
    # Used by the arbiter to parse AVRCP metadata out of busctl's JSON. In the base
    # image, so this is a check rather than a dependency to install — but without
    # it the phone's title and artist silently never appear.
    if command -v python3 >/dev/null 2>&1; then
        ok "packages present"
    else
        warn "python3 is missing — Bluetooth track metadata will not be read"
        warn "the audio path still works; install python3 to get titles and artists"
    fi

    if [[ -d /sys/class/bluetooth/hci0 ]]; then
        ok "hci0 present"
    else
        warn "no hci0 — check that setup-hardware.sh did not disable the radio"
        warn "check: dmesg | grep -i bluetooth"
    fi

    if aplay -l 2>/dev/null | grep -q "card ${CARD}.*hifiberry"; then
        ok "card ${CARD} is the HiFiBerry DAC"
    else
        warn "card ${CARD} does not look like the HiFiBerry — run setup-hardware.sh?"
        warn "check: aplay -l"
    fi

    phase "Radio"
    unblock_bluetooth || true

    phase "Configuration"
    run install -d -m 0755 "$STATE_DIR"
    run install -d -m 0755 "$CONF_DIR"
    backup_once "$MAIN_CONF" "bluetooth-main.conf"

    local tmp merged changed=0

    merged="$(write_managed_block "$MAIN_CONF" "$(gen_mainconf_block)")"
    if install_if_changed "$merged" "$MAIN_CONF" 0644; then
        ok "${MAIN_CONF} — name, class, always pairable"; changed=1
    else
        skip "${MAIN_CONF} already current"
    fi

    tmp="$(mktemp)"; gen_bluealsa_override > "$tmp"
    if install_if_changed "$tmp" "$OVERRIDE_FILE" 0644; then
        ok "${OVERRIDE_FILE} — a2dp-sink, aptX, aptX HD, SBC XQ"; changed=1
    else
        skip "${OVERRIDE_FILE} already current"
    fi

    tmp="$(mktemp)"; gen_arbiter > "$tmp"
    if install_if_changed "$tmp" "$ARBITER_BIN" 0755; then ok "$ARBITER_BIN"; changed=1
    else skip "$ARBITER_BIN already current"; fi

    tmp="$(mktemp)"; gen_monitor_unit > "$tmp"
    if install_if_changed "$tmp" "$MONITOR_UNIT" 0644; then ok "$MONITOR_UNIT"; changed=1
    else skip "$MONITOR_UNIT already current"; fi

    tmp="$(mktemp)"; gen_audio_unit > "$tmp"
    if install_if_changed "$tmp" "$AUDIO_UNIT" 0644; then ok "$AUDIO_UNIT"; changed=1
    else skip "$AUDIO_UNIT already current"; fi

    tmp="$(mktemp)"; gen_agent_unit > "$tmp"
    if install_if_changed "$tmp" "$AGENT_UNIT" 0644; then ok "$AGENT_UNIT"; changed=1
    else skip "$AGENT_UNIT already current"; fi

    phase "Enabling"
    if dry; then
        printf '    %s[dry-run]%s would mask bluealsa-aplay.service and enable the musicbox units\n' \
            "${C_DIM}" "${C_RESET}"
        printf '\n    %sDry run — nothing was changed.%s\n' "${C_BOLD}" "${C_RESET}"
        return 0
    fi

    # THE MASK IS LOAD-BEARING. Debian's bluealsa-aplay.service opens the DAC the
    # moment a transport appears, which races MPD and loses. musicbox-bt is the
    # only thing allowed to start the audio path. Masking rather than disabling,
    # because a disabled unit can still be pulled in by a dependency.
    #
    # STOPPED FIRST, AND THAT ORDER MATTERS. `systemctl mask` prevents future
    # starts and does nothing to a running instance. apt enables AND starts the
    # unit at install time, so on a fresh box there is already a bluealsa-aplay
    # running when this script gets here — masking alone leaves it there,
    # competing for the DAC, and it survives until the next reboot. Observed on
    # the device: a stale `bluealsa-aplay -S` was still running after a mask.
    systemctl stop bluealsa-aplay.service >/dev/null 2>&1 || true
    systemctl disable bluealsa-aplay.service >/dev/null 2>&1 || true
    systemctl mask bluealsa-aplay.service >/dev/null 2>&1 || true
    ok "bluealsa-aplay.service stopped, disabled and masked — musicbox-bt owns the audio path"

    systemctl daemon-reload
    systemctl enable bluetooth.service >/dev/null 2>&1 || true
    systemctl enable bluealsa.service >/dev/null 2>&1 || true
    systemctl enable musicbox-bt-agent.service >/dev/null 2>&1 || true
    systemctl enable musicbox-bt-monitor.service >/dev/null 2>&1 || true

    # bluetoothd must re-read main.conf for the name and class to take effect, and
    # bluealsa must re-read its options for the codecs to. Restarting bluealsa
    # drops any active transport, which is why this only happens when something
    # actually changed.
    if (( changed )); then
        systemctl restart bluetooth.service >/dev/null 2>&1 || warn "bluetooth.service failed to restart"
        systemctl restart bluealsa.service >/dev/null 2>&1 || warn "bluealsa.service failed to restart"
        ok "bluetoothd and bluealsa restarted with the new configuration"
    else
        skip "configuration unchanged — services left alone"
    fi

    systemctl restart musicbox-bt-agent.service >/dev/null 2>&1 \
        || warn "musicbox-bt-agent failed — check: journalctl -u musicbox-bt-agent -b"
    systemctl restart musicbox-bt-monitor.service >/dev/null 2>&1 \
        || warn "musicbox-bt failed — check: journalctl -u musicbox-bt-monitor -b"

    phase "Result"
    local powered
    powered="$(bluetoothctl show 2>/dev/null | sed -n 's/^[[:space:]]*Powered:[[:space:]]*//p' | head -1)"
    if [[ "$powered" == "yes" ]]; then
        ok "adapter powered"
    else
        warn "adapter is not powered (Powered: ${powered:-unknown})"
        warn "check: bluetoothctl show   — and for a block: cat /sys/class/rfkill/*/soft"
    fi
    log ""
    log "Pair from the phone: look for '${ADAPTER_NAME}'. No confirmation is needed here."
    log "Watch it happen:  journalctl -u musicbox-bt-monitor -f"
    log "Which codec:      ${ARBITER_BIN} status"
}

# ---------------------------------------------------------------------------
# Revert
# ---------------------------------------------------------------------------

do_revert() {
    require_root
    phase "Removing Bluetooth audio"

    local u
    for u in musicbox-bt-monitor.service musicbox-bt-agent.service musicbox-bt-audio.service; do
        if systemctl list-unit-files "$u" >/dev/null 2>&1; then
            run systemctl disable --now "$u" >/dev/null 2>&1 || true
        fi
    done
    run systemctl unmask bluealsa-aplay.service >/dev/null 2>&1 || true
    run systemctl disable --now bluealsa.service >/dev/null 2>&1 || true

    local stripped
    if [[ -f "$MAIN_CONF" ]] && grep -qF "$BLOCK_BEGIN" "$MAIN_CONF"; then
        stripped="$(strip_managed_block "$MAIN_CONF")"
        if install_if_changed "$stripped" "$MAIN_CONF" 0644; then ok "${MAIN_CONF} block removed"; fi
    else
        skip "${MAIN_CONF} carries no block"
    fi

    run rm -f "$ARBITER_BIN" "$MONITOR_UNIT" "$AUDIO_UNIT" "$AGENT_UNIT" \
        "$STATE_FILE" "$CONTROL_FIFO" "$OVERRIDE_FILE"
    # rmdir, not rm -rf: if anything else ever drops a file in there, leave it.
    run rmdir "$OVERRIDE_DIR" 2>/dev/null || true
    run systemctl daemon-reload
    run systemctl restart bluetooth.service >/dev/null 2>&1 || true
    ok "units, arbiter and configuration removed"

    log "the radio was left UNBLOCKED — reverting that would be a different change"
    log "packages were left installed; remove with:"
    log "  sudo apt-get purge bluez-alsa-utils bluez-tools && sudo apt-get autoremove --purge"
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
            printf '%smusicbox setup-bluetooth.sh %s%s\n' "${C_BOLD}" "${SCRIPT_VERSION}" "${C_RESET}"
            dry && printf '%sDRY RUN — no changes will be made%s\n' "${C_YELLOW}" "${C_RESET}"
            do_revert
            ;;
        *)
            printf '%smusicbox setup-bluetooth.sh %s%s\n' "${C_BOLD}" "${SCRIPT_VERSION}" "${C_RESET}"
            dry && printf '%sDRY RUN — no changes will be made%s\n' "${C_YELLOW}" "${C_RESET}"
            do_apply
            ;;
    esac
}

main "$@"
