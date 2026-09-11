#!/usr/bin/env bash
# Run every check for this repo. Safe on a development machine: nothing outside
# temp directories and throwaway containers is touched.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

rc=0
step() { printf '\n\033[1m### %s\033[0m\n' "$1"; }

step "bash -n (syntax)"
for f in install/setup.sh install/install.sh tests/*.sh; do
    bash -n "$f" && printf 'ok  %s\n' "$f" || rc=1
done

step "shellcheck"
# Glob on the host, then map each path into the container's mount point —
# a literal /mnt/tests/*.sh would be expanded by this shell, not the container's.
mapfile -t SH_FILES < <(printf '%s\n' install/*.sh tests/*.sh)
if command -v shellcheck >/dev/null 2>&1; then
    shellcheck "${SH_FILES[@]}" && echo "clean" || rc=1
elif command -v docker >/dev/null 2>&1; then
    docker run --rm -v "$PWD:/mnt:ro" koalaman/shellcheck:stable \
        "${SH_FILES[@]/#//mnt/}" && echo "clean" || rc=1
else
    echo "SKIP: no shellcheck and no docker"
fi

step "helper fixture tests"
bash tests/test-setup-helpers.sh || rc=1

step "netplan -> NM keyfile conversion tests"
bash tests/test-migrate-network.sh || rc=1

step "hardware config.txt transform tests"
bash tests/test-hardware-config.sh || rc=1

step "end-to-end integration test"
bash tests/test-integration.sh || rc=1

printf '\n'
[[ $rc -eq 0 ]] && echo "ALL CHECKS PASSED" || echo "FAILURES — see above"
exit $rc
