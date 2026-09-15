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

emit_all() {
    local dest="$1"
    mkdir -p "$dest"
    gen_conf         > "${dest}/server.conf"
    gen_service      > "${dest}/musicbox-server.service"
    gen_restart_unit > "${dest}/musicbox-server-restart.service"
    gen_path_unit    > "${dest}/musicbox-server.path"
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
    for u in musicbox-server.path musicbox-server.service; do
        if systemctl list-unit-files "$u" >/dev/null 2>&1; then
            run systemctl disable --now "$u" >/dev/null 2>&1 || true
        fi
    done
    run rm -f "$SERVICE" "$RESTART_UNIT" "$PATH_UNIT" "$CONF_FILE"
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
