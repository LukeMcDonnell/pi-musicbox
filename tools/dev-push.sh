#!/usr/bin/env bash
#
# musicbox — dev-push.sh
#
# Build here, push to the device, and let it restart itself. This is the inner
# loop for anything that genuinely needs the hardware: the 800x480 panel, touch,
# the DAC, and later Bluetooth and CD.
#
# MOST WORK DOES NOT NEED THIS. MPD is reachable over the network, so the
# fastest loop never touches the device at all:
#
#   backend    cd src/backend  && MUSICBOX_MPD_HOST=musicbox.local \
#                                 MUSICBOX_PORT=8099 MUSICBOX_CONF=/dev/null npm run dev
#   frontend   cd src/frontend && npx ng serve      # proxies /api to :8099
#
# Reach for dev-push.sh when you need to see it on the actual panel.
#
# NO SUDO IS REQUIRED. musicbox-server.path watches backend/server.js on the
# device and restarts the service when it changes. rsync writes a temp file and
# renames it, so the watch fires once, on a complete file.
#
# Usage:
#   tools/dev-push.sh                 # build both, push, wait for health
#   tools/dev-push.sh --backend       # backend only (skips the slow ng build)
#   tools/dev-push.sh --frontend      # frontend only
#   tools/dev-push.sh --no-build      # push what is already built
#   tools/dev-push.sh --watch         # rebuild and re-push on every save
#   tools/dev-push.sh --host pi.local # a different device

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

HOST="${MUSICBOX_HOST:-musicbox.local}"
USER_NAME="${MUSICBOX_USER:-musicbox}"
REMOTE_DIR="${MUSICBOX_DIR:-musicbox}"
DO_BUILD=1
WATCH=0
SCOPE="both"

if [[ -t 1 ]]; then
    C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'
    C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'
else
    C_RESET=""; C_BOLD=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""
fi

phase() { printf '\n%s==> %s%s\n' "${C_BOLD}${C_BLUE}" "$*" "${C_RESET}"; }
log()   { printf '    %s\n' "$*"; }
ok()    { printf '    %s+%s %s\n' "${C_GREEN}" "${C_RESET}" "$*"; }
warn()  { printf '    %s!%s %s\n' "${C_YELLOW}" "${C_RESET}" "$*" >&2; }
die()   { printf '\n%sERROR:%s %s\n' "${C_RED}${C_BOLD}" "${C_RESET}" "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --backend)  SCOPE="backend" ;;
        --frontend) SCOPE="frontend" ;;
        --no-build) DO_BUILD=0 ;;
        --watch)    WATCH=1 ;;
        --host)     HOST="${2:?--host needs a value}"; shift ;;
        -h|--help)  sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)          die "unknown option: $1" ;;
    esac
    shift
done

command -v rsync >/dev/null 2>&1 || die "rsync is not installed on this machine"

TARGET="${USER_NAME}@${HOST}"

preflight() {
    ssh -o BatchMode=yes -o ConnectTimeout=6 "$TARGET" true 2>/dev/null \
        || die "cannot reach ${TARGET} over ssh (key auth required — no password prompts in a dev loop)"
}

build() {
    [[ "$DO_BUILD" -eq 1 ]] || return 0
    case "$SCOPE" in
        backend)  tools/build.sh --backend ;;
        frontend) tools/build.sh --frontend ;;
        *)        tools/build.sh ;;
    esac
}

push() {
    phase "Pushing to ${TARGET}:${REMOTE_DIR}"
    # --delete on the frontend: Angular content-hashes filenames, so without it
    # every build leaves the previous bundle behind until the disk fills.
    # No --inplace anywhere: the .path unit relies on the atomic rename.
    if [[ "$SCOPE" != "frontend" ]]; then
        rsync -a --delete backend/ "${TARGET}:${REMOTE_DIR}/backend/"
        ok "backend/"
    fi
    if [[ "$SCOPE" != "backend" ]]; then
        rsync -a --delete frontend/ "${TARGET}:${REMOTE_DIR}/frontend/"
        ok "frontend/"
    fi
}

# The .path unit restarts the service by itself; this only confirms it happened.
wait_for_health() {
    phase "Waiting for the service"
    local deadline=$((SECONDS + 30)) body=""
    while (( SECONDS < deadline )); do
        body="$(curl -fsS --max-time 3 "http://${HOST}/api/health" 2>/dev/null)" || body=""
        if [[ -n "$body" ]]; then
            ok "healthy: ${body}"
            return 0
        fi
        sleep 0.5
    done
    warn "no healthy response within 30s"
    warn "check: ssh ${TARGET} journalctl -u musicbox-server -b --no-pager -n 40"
    return 1
}

cycle() {
    local started=$SECONDS
    build
    push
    if [[ "$SCOPE" == "frontend" ]]; then
        # Only the bundle is watched, so a frontend-only push needs no restart —
        # the files are served from disk on the next request.
        phase "Done"
        ok "frontend updated in $((SECONDS - started))s — just reload the page"
    else
        wait_for_health || true
        printf '\n%sPushed in %ss.%s  http://%s/\n' \
            "${C_BOLD}" "$((SECONDS - started))" "${C_RESET}" "$HOST"
    fi
}

preflight
cycle

if [[ "$WATCH" -eq 1 ]]; then
    command -v inotifywait >/dev/null 2>&1 \
        || die "--watch needs inotifywait (sudo apt install inotify-tools)"
    phase "Watching for changes — Ctrl-C to stop"
    watched=(src/shared)
    [[ "$SCOPE" != "frontend" ]] && watched+=(src/backend/src)
    [[ "$SCOPE" != "backend"  ]] && watched+=(src/frontend/src)
    log "watching: ${watched[*]}"
    while inotifywait -qq -r -e modify,create,delete,move "${watched[@]}"; do
        # Coalesce the burst of events an editor emits when it saves.
        sleep 0.3
        cycle
    done
fi
