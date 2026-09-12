#!/usr/bin/env bash
#
# musicbox — build.sh
#
# Builds both halves into the committed output directories:
#
#   src/backend   --esbuild-->  backend/server.js   (one file, no node_modules)
#   src/frontend  --ng build-->  frontend/          (Angular, content-hashed)
#
# The Pi is never a build machine. It gets a node binary and these artifacts.
#
# Usage:
#   tools/build.sh                # both
#   tools/build.sh --backend      # backend only, skips the slow Angular build
#   tools/build.sh --frontend     # frontend only
#   tools/build.sh --check        # also typecheck and run unit tests

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

DO_BACKEND=1
DO_FRONTEND=1
DO_CHECK=0

if [[ -t 1 ]]; then
    C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
    C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_BLUE=$'\033[34m'
else
    C_RESET=""; C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_BLUE=""
fi

phase() { printf '\n%s==> %s%s\n' "${C_BOLD}${C_BLUE}" "$*" "${C_RESET}"; }
ok()    { printf '    %s+%s %s\n' "${C_GREEN}" "${C_RESET}" "$*"; }
skip()  { printf '    %s.%s %s\n' "${C_DIM}" "${C_RESET}" "${C_DIM}$*${C_RESET}"; }
die()   { printf '\n%sERROR:%s %s\n' "${C_RED}${C_BOLD}" "${C_RESET}" "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --backend)  DO_FRONTEND=0 ;;
        --frontend) DO_BACKEND=0 ;;
        --check)    DO_CHECK=1 ;;
        -h|--help)  sed -n '3,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)          die "unknown option: $1" ;;
    esac
    shift
done

command -v node >/dev/null 2>&1 || die "node is not installed on this machine"
command -v npm  >/dev/null 2>&1 || die "npm is not installed on this machine"

# Install dependencies only when they are missing or stale, so a rebuild after
# a source-only change does not pay for npm.
ensure_deps() {
    local dir="$1"
    if [[ ! -d "${dir}/node_modules" ]] \
        || [[ "${dir}/package.json" -nt "${dir}/node_modules" ]]; then
        printf '    installing dependencies in %s\n' "$dir"
        ( cd "$dir" && npm install --no-audit --no-fund --silent )
    fi
}

if [[ "$DO_BACKEND" -eq 1 ]]; then
    phase "Backend"
    ensure_deps src/backend
    if [[ "$DO_CHECK" -eq 1 ]]; then
        ( cd src/backend && npx tsc --noEmit ) || die "backend typecheck failed"
        ok "typecheck clean"
        ( cd src/backend && node --test --experimental-strip-types "src/**/*.test.ts" >/dev/null ) \
            || die "backend tests failed"
        ok "unit tests pass"
    fi
    ( cd src/backend && node esbuild.mjs >/dev/null ) || die "backend bundle failed"
    ok "backend/server.js  ($(du -h backend/server.js | cut -f1))"
else
    skip "backend skipped"
fi

if [[ "$DO_FRONTEND" -eq 1 ]]; then
    phase "Frontend"
    ensure_deps src/frontend
    ( cd src/frontend && npx ng build --configuration production >/dev/null ) \
        || die "angular build failed"
    [[ -f frontend/index.html ]] || die "angular build produced no index.html"
    ok "frontend/  ($(du -sh frontend | cut -f1), $(find frontend -type f | wc -l) files)"
else
    skip "frontend skipped"
fi

printf '\n%sBuild complete.%s  Deploy with: tools/dev-push.sh\n' "${C_BOLD}" "${C_RESET}"
