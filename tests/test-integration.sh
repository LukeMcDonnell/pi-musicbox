#!/usr/bin/env bash
#
# End-to-end test for install/setup.sh, in a throwaway Debian Trixie container.
#
# Runs the real script against a fake /boot/firmware and asserts:
#   1. --dry-run changes nothing
#   2. a real run produces the expected config
#   3. a second run is a byte-for-byte no-op (idempotency)
#
# COVERAGE LIMITS — the container has no systemd and no Raspberry Pi firmware,
# so these are NOT exercised here and are only reachable on real hardware:
#   - Phase 2 (service/timer disabling)  — no systemctl in the container
#   - Phase 5 (bootloader EEPROM)        — no rpi-eeprom-config
#   - Phase 1 package purging            — Trixie slim has none of the candidates
# The unit predicates that gate Phase 2 are covered by test-setup-helpers.sh.
#
# Usage: bash tests/test-integration.sh
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="debian:trixie-slim"

if ! command -v docker >/dev/null 2>&1; then
    echo "SKIP: docker not available" >&2
    exit 0
fi

echo "Running integration test in ${IMAGE} (repo mounted read-only)..."

docker run --rm -i -v "${REPO}:/work:ro" "$IMAGE" bash -s <<'IN_CONTAINER'
set -uo pipefail

PASS=0; FAIL=0
check() { # check <description> <expected> <actual>
    if [[ "$2" == "$3" ]]; then
        PASS=$((PASS+1)); printf '  ok   %s\n' "$1"
    else
        FAIL=$((FAIL+1)); printf '  FAIL %s\n       expected: %q\n       actual:   %q\n' "$1" "$2" "$3"
    fi
}
banner() { printf '\n== %s ==\n' "$1"; }

CFG=/boot/firmware/config.txt
CMD=/boot/firmware/cmdline.txt

fixtures() {
    mkdir -p /boot/firmware
    # Note the trailing [pi5] section: an unqualified append would land inside
    # it and silently apply to the wrong model.
    cat > "$CFG" <<'FIX'
dtparam=audio=on
camera_auto_detect=1
dtoverlay=vc4-kms-v3d
[pi5]
usb_max_current_enable=1
FIX
    printf 'console=serial0,115200 root=PARTUUID=ab-02 fsck.repair=yes rootwait\n' > "$CMD"
    printf 'PARTUUID=ab-02 / ext4 defaults 0 1\nPARTUUID=ab-01 /boot/firmware vfat defaults 0 2\n' > /etc/fstab
}

state_hash() {
    md5sum "$CFG" "$CMD" /etc/fstab /etc/systemd/journald.conf.d/musicbox.conf 2>/dev/null | md5sum
}

# ---------------------------------------------------------------------------
banner "1. --dry-run must change nothing"
# ---------------------------------------------------------------------------
fixtures
before="$(md5sum "$CFG" "$CMD" /etc/fstab | md5sum)"
bash /work/install/setup.sh --dry-run --force --yes >/tmp/dry.log 2>&1
check "dry run exits 0" "0" "$?"
check "no files touched by dry run" "$before" "$(md5sum "$CFG" "$CMD" /etc/fstab | md5sum)"
check "dry run says nothing was changed" "0" "$(grep -qF 'Dry run — nothing was changed' /tmp/dry.log; echo $?)"
check "journald drop-in not created" "1" "$(test -f /etc/systemd/journald.conf.d/musicbox.conf; echo $?)"

# ---------------------------------------------------------------------------
banner "2. real run produces the expected configuration"
# ---------------------------------------------------------------------------
fixtures
bash /work/install/setup.sh --force --yes >/tmp/run1.log 2>&1
check "run exits 0" "0" "$?"

check "exactly one managed block in config.txt" "1" "$(grep -cF '>>> musicbox' "$CFG")"
check "block opens with [all] filter"            "[all]" "$(sed -n '/>>> musicbox/{n;p;}' "$CFG")"
check "pre-existing [pi5] content preserved"     "0" "$(grep -qF 'usb_max_current_enable=1' "$CFG"; echo $?)"
check "disable_splash set"                       "0" "$(grep -qx 'disable_splash=1' "$CFG"; echo $?)"
check "initial_turbo set"                        "0" "$(grep -qx 'initial_turbo=30' "$CFG"; echo $?)"
check "force_eeprom_read NOT set (DAC+ trap)"    "0" "$(! grep -qE '^force_eeprom_read' "$CFG"; echo $?)"
check "max_framebuffers=0 NOT set (DSI panel)"   "0" "$(! grep -qx 'max_framebuffers=0' "$CFG"; echo $?)"
check "sdtweak NOT set without --sd-overclock"   "0" "$(! grep -qF 'sdtweak' "$CFG"; echo $?)"

check "cmdline.txt is exactly one line"          "1" "$(wc -l < "$CMD")"
check "quiet present exactly once"               "1" "$(tr ' ' '\n' < "$CMD" | grep -cx quiet)"
check "root= preserved"                          "0" "$(grep -qF 'root=PARTUUID=ab-02' "$CMD"; echo $?)"
check "fsck.repair left alone"                   "0" "$(grep -qF 'fsck.repair=yes' "$CMD"; echo $?)"
check "serial console left alone"                "0" "$(grep -qF 'console=serial0,115200' "$CMD"; echo $?)"

check "noatime on /"              "0" "$(awk '$2=="/"{exit ($4~/noatime/)?0:1}' /etc/fstab; echo $?)"
check "noatime on /boot/firmware" "0" "$(awk '$2=="/boot/firmware"{exit ($4~/noatime/)?0:1}' /etc/fstab; echo $?)"
check "no duplicated noatime"     "0" "$(! grep -q 'noatime,noatime' /etc/fstab; echo $?)"
check "tmpfs /tmp entry added"    "0" "$(grep -qE '^tmpfs[[:space:]]+/tmp[[:space:]]' /etc/fstab; echo $?)"

check "journald set to volatile" "0" "$(grep -qx 'Storage=volatile' /etc/systemd/journald.conf.d/musicbox.conf; echo $?)"
check "cloud-init flag NOT created when cloud-init absent" "1" "$(test -f /etc/cloud/cloud-init.disabled; echo $?)"
check "bootreport installed"     "0" "$(test -x /usr/local/bin/musicbox-bootreport; echo $?)"
check "bootreport is valid bash" "0" "$(bash -n /usr/local/bin/musicbox-bootreport; echo $?)"
# The container has no vclog, which is the graceful-degradation path.
check "baseline records the pre-kernel section" "0" "$(grep -q 'pre-kernel (firmware) stage' /var/log/musicbox-setup/baseline-latest.txt; echo $?)"
check "missing vclog noted, not fatal" "0" "$(grep -q 'vclog unavailable' /var/log/musicbox-setup/baseline-latest.txt; echo $?)"
check "bootreport mentions the firmware stage" "0" "$(grep -q 'pre-kernel (firmware) stage' /usr/local/bin/musicbox-bootreport; echo $?)"
check "EEPROM phase would not set BOOT_ORDER by default" "1" "$(grep -q 'BOOT_ORDER' /tmp/run1.log; echo $?)"

# ---------------------------------------------------------------------------
banner "2b. cloud-init is disabled when present and finished"
# ---------------------------------------------------------------------------
mkdir -p /usr/local/bin /etc/cloud
printf '#!/bin/sh\necho "status: done"\n' > /usr/local/bin/cloud-init
chmod 755 /usr/local/bin/cloud-init
rm -f /etc/cloud/cloud-init.disabled
bash /work/install/setup.sh --force --yes >/tmp/run_ci.log 2>&1
check "run with cloud-init present exits 0" "0" "$?"
check "cloud-init.disabled created" "0" "$(test -f /etc/cloud/cloud-init.disabled; echo $?)"

# a cloud-init that is still mid-first-boot must be left alone
rm -f /etc/cloud/cloud-init.disabled
printf '#!/bin/sh\necho "status: running"\n' > /usr/local/bin/cloud-init
bash /work/install/setup.sh --force --yes >/tmp/run_ci2.log 2>&1
check "unfinished cloud-init is left enabled" "1" "$(test -f /etc/cloud/cloud-init.disabled; echo $?)"

# a cloud-init whose status command fails must not abort the script
printf '#!/bin/sh\nexit 1\n' > /usr/local/bin/cloud-init
bash /work/install/setup.sh --force --yes >/tmp/run_ci3.log 2>&1
check "failing cloud-init status does not abort the run" "0" "$?"
check "reached the summary despite the failure" "0" "$(grep -q 'Summary' /tmp/run_ci3.log; echo $?)"
rm -f /usr/local/bin/cloud-init /etc/cloud/cloud-init.disabled

# ---------------------------------------------------------------------------
banner "2c. install.sh --dry-run installs nothing"
# ---------------------------------------------------------------------------
before_pkgs="$(dpkg-query -W -f='${Package}\n' 2>/dev/null | wc -l)"
bash /work/install/install.sh --dry-run --yes >/tmp/inst.log 2>&1
check "install.sh --dry-run exits 0" "0" "$?"
check "no packages were installed" "$before_pkgs" "$(dpkg-query -W -f='${Package}\n' 2>/dev/null | wc -l)"
check "it names the NAS clients" "0" "$(grep -qE 'cifs-utils|nfs-common|smbclient' /tmp/inst.log; echo $?)"
check "it does not claim to install the music stack" "0" "$(grep -q 'Dry run' /tmp/inst.log; echo $?)"

# setup-nas.sh must refuse to run without the clients, pointing at install.sh
bash /work/install/setup-nas.sh --protocol nfs --host 127.0.0.1 --share /x </dev/null >/tmp/nas.log 2>&1
check "setup-nas.sh fails without nfs client" "1" "$?"
check "and points at install.sh" "0" "$(grep -q 'install.sh' /tmp/nas.log; echo $?)"

# ---------------------------------------------------------------------------
banner "3. second run must be a byte-for-byte no-op"
# ---------------------------------------------------------------------------
snap="$(state_hash)"
bash /work/install/setup.sh --force --yes >/tmp/run2.log 2>&1
check "second run exits 0" "0" "$?"
check "second run reports 0 changes" "0" "$(grep -qE '^\s+0 change\(s\) applied' /tmp/run2.log; echo $?)"
check "all files byte-identical" "$snap" "$(state_hash)"
check "still exactly one managed block" "1" "$(grep -cF '>>> musicbox' "$CFG")"
check "still exactly one line in cmdline" "1" "$(wc -l < "$CMD")"
check "quiet still appears once" "1" "$(tr ' ' '\n' < "$CMD" | grep -cx quiet)"

printf '\n===============================\n passed: %d   failed: %d\n===============================\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
IN_CONTAINER
