#!/usr/bin/env bash
#
# musicbox — setup-server.sh
#
# Installs the systemd units for the web server: one process that serves the
# Angular build AND the API that bridges it to MPD.
#
# Run order:
#   setup.sh -> setup-hardware.sh -> install.sh -> setup-nas.sh -> setup-mpd.sh
#   -> setup-server.sh -> setup-kiosk.sh
#
# THIS SCRIPT INSTALLS NOTHING. node comes from install.sh. The application
# itself comes from tools/dev-push.sh, which builds on the dev machine and
# rsyncs the result here — the Pi is never a build machine.
#
# IT IS NOT ORDERED AFTER mpd.service, AND THAT IS DELIBERATE
#   mpd.service takes ~6s at boot (loading a 3.4M tag cache and its decoder
#   plugins) and sits on the critical path. Ordering this behind it would add
#   that 6s to the web UI's start for no benefit. The server starts in parallel
#   and treats MPD being absent as a normal state: it reconnects with backoff
#   and reports status "unavailable" until MPD answers.
#
#   The kiosk IS ordered after this one, because chromium loading KIOSK_URL
#   before anything is listening shows an error page.
#
# PORT 80 WITHOUT ROOT
#   AmbientCapabilities=CAP_NET_BIND_SERVICE lets the service bind 80 while
#   running as an ordinary user, so the UI is at http://musicbox.local/ with no
#   port suffix.
#
# WHY IT RUNS AS THE musicbox USER
#   /home/musicbox is 0700, so a dedicated service user could not read the
#   deploy directory. That user is also already in audio, cdrom, input and
#   video, which matters when Bluetooth and CD arrive.
#
# HOW A NEW BUILD IS PICKED UP
#   musicbox-server.path watches the backend bundle AND frontend/index.html, and
#   restarts the service when either changes, so a deploy is just an rsync — no
#   sudo, no second round trip.
#
#   Watching the frontend looks odd until you see why: the restart drops every
#   SSE stream, and each client then re-reads the server's build id and reloads
#   itself if it changed. That is the only thing that updates the kiosk, which
#   loads the page once at boot and has no keyboard to reload it.
#
# Usage:
#   sudo ./setup-server.sh --dry-run
#   sudo ./setup-server.sh
#   sudo ./setup-server.sh --revert
#
#   ./setup-server.sh --emit DEST
#       Write the three units and server.conf to a directory and exit. Touches
#       no system state; used by the tests and handy for review.

set -euo pipefail

readonly SCRIPT_VERSION="1.1.0"

# The backend needs node:sqlite, which arrived in 22.5 and is flagless from 24.
# install.sh is what puts a node this new on the box; this is the assertion.
readonly NODE_MIN_MAJOR=24

readonly CONF_DIR="/etc/musicbox"
readonly CONF_FILE="${CONF_DIR}/server.conf"
readonly UNIT_DIR="/etc/systemd/system"
readonly SERVICE="${UNIT_DIR}/musicbox-server.service"
readonly RESTART_UNIT="${UNIT_DIR}/musicbox-server-restart.service"
readonly PATH_UNIT="${UNIT_DIR}/musicbox-server.path"
# Restart and shutdown. The server cannot reboot the box itself — NoNewPrivileges
# and a capability set of exactly CAP_NET_BIND_SERVICE see to that, and the
# backend has no child_process by design — so it drops a file and a root path
# unit acts on it. Same shape as the deploy restart above.
readonly POWER_HELPER="/usr/local/bin/musicbox-power"
readonly POWER_UNIT="${UNIT_DIR}/musicbox-power.service"
readonly POWER_PATH_UNIT="${UNIT_DIR}/musicbox-power.path"
readonly POWER_TMPFILES="/etc/tmpfiles.d/musicbox-power.conf"
readonly POWER_DIR="/run/musicbox-power"
# Restore from a backup uploaded in the web UI. Same shape again: the server
# stages a validated payload, root stops MPD and the server and swaps the files.
readonly RESTORE_HELPER="/usr/local/bin/musicbox-restore"
readonly RESTORE_UNIT="${UNIT_DIR}/musicbox-restore.service"
readonly RESTORE_PATH_UNIT="${UNIT_DIR}/musicbox-restore.path"
readonly RESTORE_TMPFILES="/etc/tmpfiles.d/musicbox-restore.conf"
readonly RESTORE_DIR="/run/musicbox-restore"
# Must match install/setup-mpd.sh and mpdStateDir in src/backend/src/config.ts.
readonly MPD_STATE_DIR="/var/lib/mpd"

# Cover thumbnails: the server asks, this helper builds. See src/backend/src/thumbs.ts.
readonly THUMBS_HELPER="/usr/local/bin/musicbox-thumbs"
readonly THUMBS_UNIT="${UNIT_DIR}/musicbox-thumbs.service"
readonly THUMBS_PATH_UNIT="${UNIT_DIR}/musicbox-thumbs.path"
readonly THUMBS_TMPFILES="/etc/tmpfiles.d/musicbox-thumbs.conf"
readonly THUMBS_DIR="/run/musicbox-thumbs"

DRY_RUN=0
ASSUME_YES=0
MODE="apply"
APP_USER="musicbox"
DEPLOY_DIR="/home/musicbox/musicbox"
# The database lives here, owned by the app user. /var/lib/musicbox itself stays
# root-owned: it holds this repo's config backups and the kiosk's chromium
# profile, so the server gets a subdirectory rather than the lot.
DATA_DIR="/var/lib/musicbox/data"
PORT="80"
MPD_HOST="127.0.0.1"
MPD_PORT="6600"

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

usage() { sed -n '3,50p' "$0" | sed 's/^# \{0,1\}//'; }

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

gen_conf() {
    cat <<CONF
# musicbox server configuration.
#
# Read by the backend at startup. Environment variables of the same name win,
# which is what lets a backend running on a dev machine point at this Pi's MPD
# without editing anything here.
#
# Restart after editing:  sudo systemctl restart musicbox-server

# Port 80 needs no suffix in the URL. The unit grants CAP_NET_BIND_SERVICE so
# this works without running as root.
MUSICBOX_PORT=${PORT}
MUSICBOX_HOST=0.0.0.0

# MPD is local. The server tolerates it being down and reconnects.
MUSICBOX_MPD_HOST=${MPD_HOST}
MUSICBOX_MPD_PORT=${MPD_PORT}

# Where tools/dev-push.sh puts the Angular build.
MUSICBOX_WEB_ROOT=${DEPLOY_DIR}/frontend

# The box's own state: settings now, favourites and recent plays later.
#
# NOT under ${DEPLOY_DIR}/backend — dev-push.sh rsyncs that with --delete and
# would erase it on the next deploy. /var/lib survives a reboot where /tmp and
# /var/log do not (setup.sh made those tmpfs).
MUSICBOX_DB=${DATA_DIR}/musicbox.db

# fatal | error | warn | info | debug  (debug also logs every request)
MUSICBOX_LOG_LEVEL=info
CONF
}

gen_service() {
    cat <<UNIT
[Unit]
Description=musicbox web server and MPD bridge
Documentation=https://github.com/LukeMcDonnell/pi-musicbox
#
# NOTE THE ABSENCE OF After=mpd.service — THIS IS LOAD-BEARING.
# mpd.service takes ~6s at boot and is on the critical path; ordering this
# behind it would add that delay to the web UI for no benefit. The server
# handles MPD being absent itself, reconnecting with backoff.
#
# network.target is deliberately omitted too: it is not reached until
# NetworkManager has started (~6s on this box), and binding 0.0.0.0 does not
# require an interface to be up first.
#

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${DEPLOY_DIR}
ExecStart=/usr/bin/node ${DEPLOY_DIR}/backend/server.js
Restart=on-failure
RestartSec=2

# A belt-and-braces bound on shutdown. The application ends its SSE streams on
# SIGTERM so this should never be reached — but /api/events is a connection that
# never finishes on its own, and when that wedged close() the service sat in
# 'deactivating' for systemd's default 90s. Ten seconds is plenty.
TimeoutStopSec=10

# Bind port 80 without running as root.
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes

# ProtectHome is NOT set: the deploy directory lives under /home/musicbox.
ProtectSystem=full
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes

StandardOutput=journal
StandardError=journal
SyslogIdentifier=musicbox-server

[Install]
WantedBy=multi-user.target
UNIT
}

gen_restart_unit() {
    cat <<UNIT
[Unit]
Description=Restart musicbox-server after a new build is deployed
# A .path unit can only START a unit, and the service is already running, so
# restarting needs this one-shot in between.

[Service]
Type=oneshot
ExecStart=/usr/bin/systemctl restart musicbox-server.service
UNIT
}

gen_path_unit() {
    cat <<UNIT
[Unit]
Description=Watch for a newly deployed musicbox-server build

[Path]
# rsync and install(1) write a temp file and rename it, so this fires once, on
# the finished file — never on a half-written one.
PathChanged=${DEPLOY_DIR}/backend/server.js
# The FRONTEND is watched too, and the restart is the point rather than a side
# effect: restarting drops every SSE stream, and each client then re-reads the
# server's build id and reloads itself if it changed. Without this the kiosk —
# which loads the page at boot and never navigates again, having no keyboard —
# runs the old bundle forever after a frontend deploy. Observed: a 14-hour-old
# page while the correct files sat on disk being served.
#
# index.html is the right file to watch because Angular content-hashes its
# bundles and rewrites index.html to name them, so it changes whenever anything
# in the frontend does. rsync only rewrites it when the content really differs,
# so an unchanged deploy still triggers nothing.
PathChanged=${DEPLOY_DIR}/frontend/index.html
Unit=musicbox-server-restart.service

[Install]
WantedBy=multi-user.target
UNIT
}

gen_power_tmpfiles() {
    cat <<CONF
# musicbox: where the server asks for a restart or a shutdown. See setup-server.sh.
#
# On /run, which is tmpfs, and that is load-bearing: a request file that survived
# a power cut would shut the box down again at every boot. systemd-tmpfiles
# creates it, not RuntimeDirectory= on the server unit, so it does not come and
# go with each deploy — a path unit whose parent directory is deleted and
# recreated is exactly the trap decisions.md records for the arbiter watch.
d ${POWER_DIR} 0750 ${APP_USER} ${APP_USER} -
CONF
}

gen_power_helper() {
    cat <<'HELPER'
#!/usr/bin/env bash
#
# musicbox — act on a power request from the web server.
#
# Started by musicbox-power.path when one of the request files appears. Runs as
# root; the server that asked cannot.
#
# THE REQUEST IS THE FILE NAME, NOT ITS CONTENTS. There is nothing to parse and
# so nothing to inject: either /run/musicbox-power/restart exists or
# /run/musicbox-power/shutdown does, and anything else is ignored. Compare the
# Bluetooth arbiter, which does read a verb and therefore has to police a closed
# set on both sides.
set -euo pipefail

readonly DIR="/run/musicbox-power"

restart=0
shutdown=0
[[ -e "${DIR}/restart" ]] && restart=1
[[ -e "${DIR}/shutdown" ]] && shutdown=1

# REMOVED BEFORE ACTING, both of them, always. A request left behind would
# re-trigger the path unit the moment the box came back up, and a box that
# shuts itself down every boot is not one you can fix over ssh.
rm -f "${DIR}/restart" "${DIR}/shutdown"

if [[ "$shutdown" -eq 1 ]]; then
    logger -t musicbox-power "shutdown requested by the web server"
    exec systemctl poweroff
elif [[ "$restart" -eq 1 ]]; then
    logger -t musicbox-power "restart requested by the web server"
    exec systemctl reboot
fi

# Triggered with nothing to do: the file went away between the path unit firing
# and this running. Not an error.
logger -t musicbox-power "no power request found; nothing to do"
HELPER
}

gen_power_unit() {
    cat <<UNIT
[Unit]
Description=musicbox restart/shutdown requested from the web UI

[Service]
Type=oneshot
ExecStart=${POWER_HELPER}
UNIT
}

gen_power_path_unit() {
    cat <<UNIT
[Unit]
Description=Watch for a restart or shutdown request from the web UI

[Path]
# Two files rather than one with a verb in it: the request is the NAME, so there
# is nothing to parse and nothing to inject. Either fires the same helper, which
# works out which appeared.
PathExists=${POWER_DIR}/restart
PathExists=${POWER_DIR}/shutdown
Unit=musicbox-power.service

[Install]
WantedBy=multi-user.target
UNIT
}

gen_restore_tmpfiles() {
    cat <<CONF
# musicbox: where the server stages a restore. On /run so a request cannot
# survive a reboot and replay itself. See setup-server.sh.
d ${RESTORE_DIR} 0750 ${APP_USER} ${APP_USER} -
CONF
}

gen_restore_helper() {
    cat <<HEADER
#!/usr/bin/env bash
#
# musicbox — restore a backup the web server has staged.
#
# Started by musicbox-restore.path. The server validated the archive, but this
# runs as root on files a less trusted user wrote, so it checks them again.
set -euo pipefail

readonly DIR="\${MUSICBOX_RESTORE_DIR:-${RESTORE_DIR}}"
readonly MPD_DIR="\${MUSICBOX_MPD_DIR:-${MPD_STATE_DIR}}"
readonly DB_DIR="\${MUSICBOX_DB_DIR:-${DATA_DIR}}"
readonly PREVIOUS="\${MUSICBOX_RESTORE_PREVIOUS:-/var/lib/musicbox/restore-previous}"
readonly APP_USER="${APP_USER}"
HEADER
    cat <<'HELPER'
readonly PAYLOAD="${DIR}/payload"

log() { logger -t musicbox-restore "$*"; }

# Removed before acting: a request left behind would restore again at boot.
rm -f "${DIR}/request"

# Only regular files, only the names the server may stage. Mirrors backup.ts.
valid_payload() {
    local path rel
    [[ -d "$PAYLOAD" && ! -L "$PAYLOAD" ]] || return 1
    while IFS= read -r -d '' path; do
        rel="${path#"$PAYLOAD"/}"
        [[ ! -L "$path" ]] || return 1
        if [[ -d "$path" ]]; then
            [[ "$rel" == mpd || "$rel" == mpd/playlists ]] || return 1
            continue
        fi
        [[ -f "$path" ]] || return 1
        case "$rel" in
            musicbox.db|mpd/state|mpd/tag_cache|mpd/sticker.sql) ;;
            mpd/playlists/.*) return 1 ;;
            mpd/playlists/*.m3u) [[ "${rel#mpd/playlists/}" != */* ]] || return 1 ;;
            *) return 1 ;;
        esac
    done < <(find "$PAYLOAD" -mindepth 1 -print0)
    [[ -f "${PAYLOAD}/musicbox.db" && -f "${PAYLOAD}/mpd/state" ]]
}

stopped=0
finish() {
    local status=$?
    rm -rf "$PAYLOAD" "${DIR}"/payload.tmp-*
    if [[ "$stopped" -eq 1 ]]; then
        systemctl start mpd.service musicbox-server.service || status=1
    fi
    if [[ "$status" -eq 0 ]]; then
        log "restore complete; the previous state is in ${PREVIOUS}"
    else
        log "restore FAILED (exit ${status}); the previous state is in ${PREVIOUS}"
    fi
}
trap finish EXIT

if ! valid_payload; then
    log "refusing a staged payload that is missing, incomplete or has unexpected files"
    exit 1
fi

# Both stopped: MPD rewrites its state file on exit, and the server holds the db open.
stopped=1
systemctl stop musicbox-server.service mpd.service

rm -rf "$PREVIOUS"
mkdir -p "${PREVIOUS}/mpd"
for f in state tag_cache sticker.sql; do
    if [[ -f "${MPD_DIR}/${f}" ]]; then cp -p "${MPD_DIR}/${f}" "${PREVIOUS}/mpd/"; fi
done
if [[ -d "${MPD_DIR}/playlists" ]]; then cp -rp "${MPD_DIR}/playlists" "${PREVIOUS}/mpd/"; fi
for f in "${DB_DIR}"/musicbox.db*; do
    if [[ -f "$f" ]]; then cp -p "$f" "${PREVIOUS}/"; fi
done

# A backup without tag_cache or stickers leaves the box's own copies alone.
for f in state tag_cache sticker.sql; do
    if [[ -f "${PAYLOAD}/mpd/${f}" ]]; then
        install -o mpd -g audio -m 0644 "${PAYLOAD}/mpd/${f}" "${MPD_DIR}/${f}"
    fi
done
install -d -o mpd -g audio -m 0755 "${MPD_DIR}/playlists"
find "${MPD_DIR}/playlists" -maxdepth 1 -type f -name '*.m3u' -delete
for p in "${PAYLOAD}"/mpd/playlists/*.m3u; do
    if [[ -f "$p" ]]; then install -o mpd -g audio -m 0644 "$p" "${MPD_DIR}/playlists/${p##*/}"; fi
done

rm -f "${DB_DIR}/musicbox.db-wal" "${DB_DIR}/musicbox.db-shm"
install -o "$APP_USER" -g "$APP_USER" -m 0644 "${PAYLOAD}/musicbox.db" "${DB_DIR}/musicbox.db"
HELPER
}

gen_restore_unit() {
    cat <<UNIT
[Unit]
Description=musicbox restore from a backup uploaded in the web UI

[Service]
Type=oneshot
ExecStart=${RESTORE_HELPER}
UNIT
}

gen_restore_path_unit() {
    cat <<UNIT
[Unit]
Description=Watch for a restore staged by the web UI

[Path]
PathExists=${RESTORE_DIR}/request
Unit=musicbox-restore.service

[Install]
WantedBy=multi-user.target
UNIT
}

gen_thumbs_tmpfiles() {
    cat <<CONF
# musicbox: where the server asks for cover thumbnails. On tmpfs, like the power requests.
d ${THUMBS_DIR} 0750 ${APP_USER} ${APP_USER} -
CONF
}

gen_thumbs_helper() {
    cat <<HEAD
#!/usr/bin/env bash
#
# musicbox — build cover thumbnails for the web server. Installed by setup-server.sh.
#
# Started by musicbox-thumbs.path when the server drops a request; throttled by its
# unit (Nice, CPUQuota, idle I/O). The server serves what is here and never runs a
# process itself. The request is the file's NAME: \`library\` is a full pass, \`cd\`
# the CD covers only. See src/backend/src/thumbs.ts and .claude/docs/decisions.md.
set -euo pipefail

readonly DEFAULT_DATA_DIR="${DATA_DIR}"
readonly REQ_DIR="\${MUSICBOX_THUMB_REQUEST_DIR:-${THUMBS_DIR}}"
HEAD
    cat <<'BODY'
data_dir="$(dirname "${MUSICBOX_DB:-${DEFAULT_DATA_DIR}/musicbox.db}")"
readonly THUMB_DIR="${MUSICBOX_THUMB_DIR:-${data_dir}/thumbs}"
readonly CD_ART_DIR="${MUSICBOX_CD_ART_DIR:-${data_dir}/cd-art}"
readonly MUSIC_ROOT="${MUSICBOX_MUSIC_ROOT:-/srv/music/Music}"
export MPD_HOST="${MUSICBOX_MPD_HOST:-127.0.0.1}" MPD_PORT="${MUSICBOX_MPD_PORT:-6600}"
readonly EDGE=280
# The same names in the same order as ART_FILENAMES in src/backend/src/art.ts.
readonly NAMES=(cover.jpg cover.jpeg cover.png folder.jpg folder.jpeg folder.png front.jpg front.png)

full=0 what="cd"
[[ -e "${REQ_DIR}/library" ]] && full=1 what="library"
# Removed before working, so a request made during this pass starts another.
rm -f "${REQ_DIR}/library" "${REQ_DIR}/cd"
mkdir -p "$THUMB_DIR"

built=0 current=0 without=0 failed=0 pruned=0 library=0 progress=0 total=0
declare -A keep=()
started="$(date +%s)"

# One line the server reads for the Status tab: replaced whole, never appended to.
status() {
    { printf '%s\n' "$*" > "${REQ_DIR}/.status.tmp" && mv -f "${REQ_DIR}/.status.tmp" "${REQ_DIR}/status"; } 2>/dev/null || true
}

step() {
    progress=$((progress + 1))
    if (( progress % 50 == 0 )); then status running $$ "$started" "$progress" "$total" "$what"; fi
}

# thumb <kind> <key> <cover file, or empty>
thumb() {
    local name tag recorded="" err
    name="$(printf '%s:%s' "$1" "$2" | sha1sum)"
    name="${name%% *}"
    keep["$name"]=1
    # No cover, or the share is down: either way keep any thumbnail already built.
    if [[ -z "$3" ]] || ! tag="$(stat -L -c '%Y %s' "$3" 2>/dev/null)"; then
        without=$((without + 1))
        return 0
    fi
    [[ -f "${THUMB_DIR}/${name}.src" ]] && recorded="$(<"${THUMB_DIR}/${name}.src")"
    # A recorded failure is not retried until the cover itself changes.
    if [[ "$recorded" == "$tag" || "$recorded" == "failed:${tag}" ]]; then
        current=$((current + 1))
        return 0
    fi
    if err="$(gm convert -limit threads 1 -size "$((EDGE * 2))x$((EDGE * 2))" "$3" -auto-orient             -thumbnail "${EDGE}x${EDGE}>" -strip -quality 80 "jpg:${THUMB_DIR}/${name}.tmp.jpg" 2>&1)"; then
        mv -f "${THUMB_DIR}/${name}.tmp.jpg" "${THUMB_DIR}/${name}.jpg"
        printf '%s' "$tag" > "${THUMB_DIR}/${name}.src"
        built=$((built + 1))
    else
        failed=$((failed + 1))
        [[ "$failed" -eq 1 ]] && echo "thumbnails: ${1} '${2}' failed: ${err}"
        rm -f "${THUMB_DIR}/${name}.tmp.jpg" "${THUMB_DIR}/${name}.jpg"
        printf 'failed:%s' "$tag" > "${THUMB_DIR}/${name}.src"
    fi
}

# The first cover file in a library directory, or nothing.
cover_in() {
    local n
    for n in "${NAMES[@]}"; do
        if [[ -f "${MUSIC_ROOT}/${1:+$1/}${n}" ]]; then
            printf '%s' "${MUSIC_ROOT}/${1:+$1/}${n}"
            return 0
        fi
    done
}

dirs=()
if [[ "$full" -eq 1 ]]; then
    # Every directory a cover URI can name: each song's directory, and each top-level one.
    listing="$(mpc listall 2>/dev/null)" || listing=""
    mapfile -t dirs < <(printf '%s\n' "$listing" | awk -F/ '
        NF == 0 { next }
        NF == 1 { print ""; next }
        { dir = $1; for (i = 2; i < NF; i++) dir = dir "/" $i; print dir; print $1 }' \
        | grep -v -e '@eaDir' -e '#recycle' | sort -u)
fi
shopt -s nullglob
covers=("$CD_ART_DIR"/*.jpg)
shopt -u nullglob
total=$(( ${#dirs[@]} + ${#covers[@]} ))
status running $$ "$started" 0 "$total" "$what"

for dir in "${dirs[@]}"; do
    library=$((library + 1))
    thumb album "$dir" "$(cover_in "$dir")"
    step
done

for cover in "${covers[@]}"; do
    id="$(basename "$cover" .jpg)"
    if [[ "$id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
        thumb release "$id" "$cover"
    fi
    step
done

# Only a full pass knows what has left the library, and an empty listing is MPD down.
if [[ "$full" -eq 1 && "$library" -gt 0 ]]; then
    for src in "$THUMB_DIR"/*.src; do
        [[ -e "$src" ]] || continue
        stem="$(basename "$src" .src)"
        [[ -n "${keep[$stem]+set}" ]] && continue
        rm -f "${THUMB_DIR}/${stem}".*
        pruned=$((pruned + 1))
    done
    if [[ $((built + current)) -gt 0 ]]; then date -Is > "${THUMB_DIR}/.complete"; fi
fi

status idle "$(date +%s)" "$built" "$current" "$without" "$failed" "$what"
echo "thumbnails (${what}): ${built} built, ${current} current, ${without} without art, ${failed} failed, ${pruned} pruned, in ${SECONDS}s"
BODY
}

gen_thumbs_unit() {
    cat <<UNIT
[Unit]
Description=musicbox cover thumbnails, requested by the web server

[Service]
Type=oneshot
User=${APP_USER}
Group=${APP_USER}
# The server's own config, for the same database directory and MPD address.
EnvironmentFile=-${CONF_FILE}
ExecStart=${THUMBS_HELPER}
# A first build is most of an hour, slow on purpose.
TimeoutStartSec=infinity
# Never at the panel's expense: half a core at most, and only when idle.
Nice=19
CPUQuota=50%
IOSchedulingClass=idle
NoNewPrivileges=yes
ProtectSystem=full
PrivateTmp=yes
SyslogIdentifier=musicbox-thumbs
UNIT
}

gen_thumbs_path_unit() {
    cat <<UNIT
[Unit]
Description=Watch for a cover thumbnail request from the web server

[Path]
# The request is the NAME. A request left by a pass in progress fires another.
PathExists=${THUMBS_DIR}/library
PathExists=${THUMBS_DIR}/cd
Unit=musicbox-thumbs.service

[Install]
WantedBy=multi-user.target
UNIT
}

emit_all() {
    local dest="$1"
    mkdir -p "$dest"
    gen_conf         > "${dest}/server.conf"
    gen_service      > "${dest}/musicbox-server.service"
    gen_restart_unit > "${dest}/musicbox-server-restart.service"
    gen_path_unit    > "${dest}/musicbox-server.path"
    gen_power_tmpfiles  > "${dest}/musicbox-power.conf"
    gen_power_helper    > "${dest}/musicbox-power"
    gen_power_unit      > "${dest}/musicbox-power.service"
    gen_power_path_unit > "${dest}/musicbox-power.path"
    gen_restore_tmpfiles  > "${dest}/musicbox-restore.conf"
    gen_restore_helper    > "${dest}/musicbox-restore"
    gen_restore_unit      > "${dest}/musicbox-restore.service"
    gen_restore_path_unit > "${dest}/musicbox-restore.path"
    gen_thumbs_tmpfiles  > "${dest}/musicbox-thumbs.conf"
    gen_thumbs_helper    > "${dest}/musicbox-thumbs"
    gen_thumbs_unit      > "${dest}/musicbox-thumbs.service"
    gen_thumbs_path_unit > "${dest}/musicbox-thumbs.path"
    chmod 0755 "${dest}/musicbox-power" "${dest}/musicbox-restore" "${dest}/musicbox-thumbs"
    printf '  wrote server.conf musicbox-server.service musicbox-server-restart.service musicbox-server.path -> %s\n' "$dest"
}

# ---------------------------------------------------------------------------
require_root() { [[ "$(id -u)" -eq 0 ]] || die "must run as root (try: sudo $0)"; }

do_apply() {
    require_root

    phase "Preflight"
    command -v node >/dev/null 2>&1 || die "node is not installed — run install.sh first"
    # A floor, not a formality: the backend stores its state through node:sqlite,
    # which Debian's node 20 does not have. install.sh takes node from NodeSource.
    local node_major
    node_major="$(node --version 2>/dev/null)" || node_major=""
    node_major="${node_major#v}"; node_major="${node_major%%.*}"
    [[ -n "$node_major" && "$node_major" -ge "$NODE_MIN_MAJOR" ]] \
        || die "node ${node_major:-?} is too old — ${NODE_MIN_MAJOR} or newer is required (run install.sh)"
    ok "node $(node --version 2>/dev/null)"
    id "$APP_USER" >/dev/null 2>&1 || die "user '${APP_USER}' does not exist"
    ok "will run as ${APP_USER}"

    # A warning, not a failure: the units are worth installing before the first
    # build so that the very first dev-push has something to restart.
    if [[ -f "${DEPLOY_DIR}/backend/server.js" ]]; then
        ok "bundle present at ${DEPLOY_DIR}/backend/server.js"
    else
        warn "no bundle at ${DEPLOY_DIR}/backend/server.js yet"
        warn "build and deploy one from the dev machine: tools/dev-push.sh"
    fi
    if [[ -f "${DEPLOY_DIR}/frontend/index.html" ]]; then
        ok "frontend build present"
    else
        warn "no frontend build at ${DEPLOY_DIR}/frontend — the API will work, the UI will 404"
    fi

    phase "State directory"
    if [[ -d "$DATA_DIR" ]]; then
        skip "${DATA_DIR} already exists"
    else
        run install -d -o "$APP_USER" -g "$APP_USER" -m 0755 "$DATA_DIR"
        dry || ok "${DATA_DIR} (owned by ${APP_USER})"
    fi

    phase "Configuration"
    local tmp changed=0
    tmp="$(mktemp)"; gen_conf > "$tmp"
    if install_if_changed "$tmp" "$CONF_FILE" 0644; then ok "$CONF_FILE"; changed=1
    else skip "$CONF_FILE already current"; fi

    tmp="$(mktemp)"; gen_service > "$tmp"
    if install_if_changed "$tmp" "$SERVICE" 0644; then ok "$SERVICE"; changed=1
    else skip "$SERVICE already current"; fi

    tmp="$(mktemp)"; gen_restart_unit > "$tmp"
    if install_if_changed "$tmp" "$RESTART_UNIT" 0644; then ok "$RESTART_UNIT"; changed=1
    else skip "$RESTART_UNIT already current"; fi

    tmp="$(mktemp)"; gen_path_unit > "$tmp"
    if install_if_changed "$tmp" "$PATH_UNIT" 0644; then ok "$PATH_UNIT"; changed=1
    else skip "$PATH_UNIT already current"; fi

    tmp="$(mktemp)"; gen_power_tmpfiles > "$tmp"
    if install_if_changed "$tmp" "$POWER_TMPFILES" 0644; then ok "$POWER_TMPFILES"; changed=1
    else skip "$POWER_TMPFILES already current"; fi

    tmp="$(mktemp)"; gen_power_helper > "$tmp"
    if install_if_changed "$tmp" "$POWER_HELPER" 0755; then ok "$POWER_HELPER"; changed=1
    else skip "$POWER_HELPER already current"; fi

    tmp="$(mktemp)"; gen_power_unit > "$tmp"
    if install_if_changed "$tmp" "$POWER_UNIT" 0644; then ok "$POWER_UNIT"; changed=1
    else skip "$POWER_UNIT already current"; fi

    tmp="$(mktemp)"; gen_power_path_unit > "$tmp"
    if install_if_changed "$tmp" "$POWER_PATH_UNIT" 0644; then ok "$POWER_PATH_UNIT"; changed=1
    else skip "$POWER_PATH_UNIT already current"; fi

    tmp="$(mktemp)"; gen_restore_tmpfiles > "$tmp"
    if install_if_changed "$tmp" "$RESTORE_TMPFILES" 0644; then ok "$RESTORE_TMPFILES"; changed=1
    else skip "$RESTORE_TMPFILES already current"; fi

    tmp="$(mktemp)"; gen_restore_helper > "$tmp"
    if install_if_changed "$tmp" "$RESTORE_HELPER" 0755; then ok "$RESTORE_HELPER"; changed=1
    else skip "$RESTORE_HELPER already current"; fi

    tmp="$(mktemp)"; gen_restore_unit > "$tmp"
    if install_if_changed "$tmp" "$RESTORE_UNIT" 0644; then ok "$RESTORE_UNIT"; changed=1
    else skip "$RESTORE_UNIT already current"; fi

    tmp="$(mktemp)"; gen_restore_path_unit > "$tmp"
    if install_if_changed "$tmp" "$RESTORE_PATH_UNIT" 0644; then ok "$RESTORE_PATH_UNIT"; changed=1
    else skip "$RESTORE_PATH_UNIT already current"; fi

    tmp="$(mktemp)"; gen_thumbs_tmpfiles > "$tmp"
    if install_if_changed "$tmp" "$THUMBS_TMPFILES" 0644; then ok "$THUMBS_TMPFILES"; changed=1
    else skip "$THUMBS_TMPFILES already current"; fi

    tmp="$(mktemp)"; gen_thumbs_helper > "$tmp"
    if install_if_changed "$tmp" "$THUMBS_HELPER" 0755; then ok "$THUMBS_HELPER"; changed=1
    else skip "$THUMBS_HELPER already current"; fi

    tmp="$(mktemp)"; gen_thumbs_unit > "$tmp"
    if install_if_changed "$tmp" "$THUMBS_UNIT" 0644; then ok "$THUMBS_UNIT"; changed=1
    else skip "$THUMBS_UNIT already current"; fi

    tmp="$(mktemp)"; gen_thumbs_path_unit > "$tmp"
    if install_if_changed "$tmp" "$THUMBS_PATH_UNIT" 0644; then ok "$THUMBS_PATH_UNIT"; changed=1
    else skip "$THUMBS_PATH_UNIT already current"; fi

    phase "Enabling"
    if dry; then
        printf '    %s[dry-run]%s would enable musicbox-server.service and musicbox-server.path\n' \
            "${C_DIM}" "${C_RESET}"
        printf '\n    %sDry run — nothing was changed.%s\n' "${C_BOLD}" "${C_RESET}"
        return 0
    fi

    systemctl daemon-reload
    systemctl enable musicbox-server.service >/dev/null 2>&1 || true
    systemctl enable musicbox-server.path    >/dev/null 2>&1 || true
    systemctl start  musicbox-server.path    >/dev/null 2>&1 || true
    # The request directory is on tmpfs, so it has to exist before the first
    # request rather than only after the next boot.
    systemd-tmpfiles --create "$POWER_TMPFILES" >/dev/null 2>&1 || true
    systemctl enable musicbox-power.path >/dev/null 2>&1 || true
    systemctl start  musicbox-power.path >/dev/null 2>&1 || true
    systemd-tmpfiles --create "$RESTORE_TMPFILES" >/dev/null 2>&1 || true
    systemctl enable musicbox-restore.path >/dev/null 2>&1 || true
    systemctl start  musicbox-restore.path >/dev/null 2>&1 || true
    systemd-tmpfiles --create "$THUMBS_TMPFILES" >/dev/null 2>&1 || true
    systemctl enable musicbox-thumbs.path >/dev/null 2>&1 || true
    systemctl start  musicbox-thumbs.path >/dev/null 2>&1 || true
    command -v gm >/dev/null 2>&1 || warn "gm not found — cover thumbnails need graphicsmagick (run install.sh)"
    ok "units enabled"

    if [[ ! -f "${DEPLOY_DIR}/backend/server.js" ]]; then
        skip "not starting the service — there is no bundle to run yet"
    elif [[ "$changed" -eq 1 ]] || ! systemctl is-active --quiet musicbox-server.service; then
        if systemctl restart musicbox-server.service; then ok "musicbox-server started"
        else warn "failed to start — check: journalctl -u musicbox-server -b --no-pager"; fi
    else
        skip "musicbox-server already running on this config"
    fi

    phase "Verifying"
    if systemctl is-active --quiet musicbox-server.service; then
        ok "musicbox-server is active"
        if command -v curl >/dev/null 2>&1; then
            local health
            health="$(curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null)" || health=""
            if [[ -n "$health" ]]; then ok "/api/health: ${health}"
            else warn "/api/health did not answer — check: journalctl -u musicbox-server -b"; fi
        fi
    else
        skip "service not running (expected until the first deploy)"
    fi

    cat <<EOF

    ${C_BOLD}Server configured.${C_RESET}  http://$(hostname 2>/dev/null || echo musicbox).local/

    Deploy a build from the DEV MACHINE (never build on the Pi):
      tools/dev-push.sh

    backend/server.js and frontend/index.html are both watched, so a deploy
    restarts the service by itself — no sudo needed in the loop. The restart is
    also what updates the panel: it drops every SSE stream, and each client then
    re-reads the build id and reloads itself if it changed.

      systemctl status musicbox-server
      journalctl -u musicbox-server -b -f

    If it misbehaves:  sudo $0 --revert
EOF
    [[ "$changed" -eq 0 ]] && skip "(nothing changed this run)"
    return 0
}

do_revert() {
    require_root
    phase "Removing the server"

    local u
    for u in musicbox-thumbs.path musicbox-restore.path musicbox-power.path musicbox-server.path musicbox-server.service; do
        if systemctl list-unit-files "$u" >/dev/null 2>&1; then
            run systemctl disable --now "$u" >/dev/null 2>&1 || true
        fi
    done
    run rm -f "$SERVICE" "$RESTART_UNIT" "$PATH_UNIT" "$CONF_FILE" \
        "$POWER_UNIT" "$POWER_PATH_UNIT" "$POWER_HELPER" "$POWER_TMPFILES" \
        "$RESTORE_UNIT" "$RESTORE_PATH_UNIT" "$RESTORE_HELPER" "$RESTORE_TMPFILES" \
        "$THUMBS_UNIT" "$THUMBS_PATH_UNIT" "$THUMBS_HELPER" "$THUMBS_TMPFILES"
    run systemctl daemon-reload
    ok "units and configuration removed"
    # The database is DATA, not configuration. Settings, and later favourites and
    # play history, are not something a --revert should decide to throw away.
    if [[ -e "${DATA_DIR}/musicbox.db" ]]; then
        log "kept ${DATA_DIR}/musicbox.db — remove it by hand if you mean to"
    fi
    log "the deployed build in ${DEPLOY_DIR} was left alone"
    log "node was left installed; remove with:"
    log "  sudo apt-get purge nodejs && sudo apt-get autoremove --purge"
    log "the kiosk still points at this server — re-run setup-kiosk.sh to change that"
}

main() {
    local dest=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --dry-run)    DRY_RUN=1 ;;
            -y|--yes)     ASSUME_YES=1 ;;
            --user)       APP_USER="${2:?--user needs a value}"; shift ;;
            --deploy-dir) DEPLOY_DIR="${2:?--deploy-dir needs a value}"; shift ;;
            --port)       PORT="${2:?--port needs a value}"; shift ;;
            --mpd-host)   MPD_HOST="${2:?--mpd-host needs a value}"; shift ;;
            --mpd-port)   MPD_PORT="${2:?--mpd-port needs a value}"; shift ;;
            --revert)     MODE="revert" ;;
            --emit)       MODE="emit"; dest="${2:-}"; shift ;;
            -h|--help)    usage; exit 0 ;;
            *)            usage >&2; die "unknown option: $1" ;;
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
            printf '%smusicbox setup-server.sh %s%s\n' "${C_BOLD}" "${SCRIPT_VERSION}" "${C_RESET}"
            dry && printf '%sDRY RUN — no changes will be made%s\n' "${C_YELLOW}" "${C_RESET}"
            do_revert
            ;;
        *)
            printf '%smusicbox setup-server.sh %s%s\n' "${C_BOLD}" "${SCRIPT_VERSION}" "${C_RESET}"
            dry && printf '%sDRY RUN — no changes will be made%s\n' "${C_YELLOW}" "${C_RESET}"
            do_apply
            ;;
    esac
}

main "$@"
