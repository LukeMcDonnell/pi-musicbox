#!/usr/bin/env bash
# Fixture tests for musicbox setup.sh helpers.
# Operates ONLY on throwaway files in this scratchpad directory.
# Config vars below are consumed by the functions sourced from setup.sh,
# which the linter cannot see through.
# shellcheck disable=SC2034
set -uo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/install/setup.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Load the helpers: drop the final `main "$@"`, and un-readonly the path
# constants so we can point them at fixtures. Function bodies are untouched.
sed -e '$ d' \
    -e 's/^readonly \(BOOT_DIR\|CONFIG_TXT\|CMDLINE_TXT\|FSTAB\|JOURNALD_DROPIN\|STATE_DIR\|LOG_DIR\|BOOTREPORT\|CLOUD_INIT_DISABLED\)=/\1=/' \
    "$SRC" > "$WORK/harness.sh"
# shellcheck source=/dev/null
source "$WORK/harness.sh"

PASS=0; FAIL=0
check() { # check <description> <expected> <actual>
    if [[ "$2" == "$3" ]]; then
        PASS=$((PASS+1)); printf '  ok   %s\n' "$1"
    else
        FAIL=$((FAIL+1)); printf '  FAIL %s\n       expected: %q\n       actual:   %q\n' "$1" "$2" "$3"
    fi
}
banner() { printf '\n== %s ==\n' "$1"; }
exists() { if [[ -e "$1" ]]; then echo 0; else echo 1; fi; }

DRY_RUN=0
ASSUME_YES=1

# ---------------------------------------------------------------------------
banner "write_managed_block — config.txt"
# ---------------------------------------------------------------------------
CONFIG_TXT="$WORK/config.txt"
cat > "$CONFIG_TXT" <<'FIX'
# For more options and information see rpi docs
dtparam=audio=on
camera_auto_detect=1
display_auto_detect=1
auto_initramfs=1
dtoverlay=vc4-kms-v3d
max_framebuffers=2

[cm5]
dtoverlay=dwc2,dr_mode=host

[pi5]
usb_max_current_enable=1
FIX
ORIG_TAIL="$(cat "$CONFIG_TXT")"

phase_config_txt >/dev/null 2>&1
check "first run modifies config.txt" "0" "$?"

n_begin=$(grep -cF ">>> musicbox setup.sh managed block >>>" "$CONFIG_TXT")
check "exactly one begin delimiter" "1" "$n_begin"
n_end=$(grep -cF "<<< musicbox setup.sh managed block <<<" "$CONFIG_TXT")
check "exactly one end delimiter" "1" "$n_end"

# The critical one: stock config.txt ends inside [pi5]. Our block must reopen [all].
first_line_of_block=$(sed -n '/>>> musicbox/{n;p;}' "$CONFIG_TXT")
check "block opens with [all] section filter" "[all]" "$first_line_of_block"

check "original content preserved" "0" "$(grep -qF 'usb_max_current_enable=1' "$CONFIG_TXT"; echo $?)"
check "disable_splash written" "0" "$(grep -qx 'disable_splash=1' "$CONFIG_TXT"; echo $?)"
check "force_eeprom_read NOT set (DAC+ HAT trap)" "0" "$(! grep -qE '^force_eeprom_read' "$CONFIG_TXT"; echo $?)"
check "max_framebuffers=0 NOT set (DSI panel)" "0" "$(! grep -qx 'max_framebuffers=0' "$CONFIG_TXT"; echo $?)"

before_second="$(cat "$CONFIG_TXT")"
phase_config_txt >/dev/null 2>&1
check "second run is a no-op (idempotent)" "$before_second" "$(cat "$CONFIG_TXT")"
check "still exactly one block after re-run" "1" "$(grep -cF '>>> musicbox' "$CONFIG_TXT")"

# Changing block content must replace, not append
SD_OVERCLOCK=1
phase_config_txt >/dev/null 2>&1
check "content change still leaves one block" "1" "$(grep -cF '>>> musicbox' "$CONFIG_TXT")"
check "sdtweak now present" "0" "$(grep -qF 'sdtweak' "$CONFIG_TXT"; echo $?)"
SD_OVERCLOCK=0
phase_config_txt >/dev/null 2>&1
check "reverting removes sdtweak" "0" "$(! grep -qF 'sdtweak' "$CONFIG_TXT"; echo $?)"
check "non-block content survived 4 rewrites" "$ORIG_TAIL" "$(sed '/>>> musicbox/,/<<< musicbox/d' "$CONFIG_TXT" | sed -e :a -e '/^\n*$/{$d;N;};/\n$/ba')"

# ---------------------------------------------------------------------------
banner "cmdline.txt — must stay exactly one line"
# ---------------------------------------------------------------------------
CMDLINE_TXT="$WORK/cmdline.txt"
printf 'console=serial0,115200 console=tty1 root=PARTUUID=abc123-02 rootfstype=ext4 fsck.repair=yes rootwait\n' > "$CMDLINE_TXT"

phase_cmdline >/dev/null 2>&1
check "cmdline is exactly one line" "1" "$(wc -l < "$CMDLINE_TXT")"
check "quiet added" "0" "$(grep -qw quiet "$CMDLINE_TXT"; echo $?)"
check "logo.nologo added" "0" "$(grep -qF 'logo.nologo' "$CMDLINE_TXT"; echo $?)"
check "root= preserved" "0" "$(grep -qF 'root=PARTUUID=abc123-02' "$CMDLINE_TXT"; echo $?)"
check "fsck.repair left alone" "0" "$(grep -qF 'fsck.repair=yes' "$CMDLINE_TXT"; echo $?)"
check "serial console left alone" "0" "$(grep -qF 'console=serial0,115200' "$CMDLINE_TXT"; echo $?)"

before_second="$(cat "$CMDLINE_TXT")"
phase_cmdline >/dev/null 2>&1
check "second run is a no-op" "$before_second" "$(cat "$CMDLINE_TXT")"
check "quiet appears exactly once" "1" "$(tr ' ' '\n' < "$CMDLINE_TXT" | grep -cx quiet)"
check "still one line after re-run" "1" "$(wc -l < "$CMDLINE_TXT")"

# token matching must be exact, not substring
printf 'root=/dev/sda1 quietly logo.nologo.bak\n' > "$CMDLINE_TXT"
check "cmdline_has_token: 'quietly' != 'quiet'" "1" "$(cmdline_has_token quiet; echo $?)"
check "cmdline_has_token: 'logo.nologo.bak' != 'logo.nologo'" "1" "$(cmdline_has_token logo.nologo; echo $?)"
printf 'root=/dev/sda1 quiet\n' > "$CMDLINE_TXT"
check "cmdline_has_token: exact match found" "0" "$(cmdline_has_token quiet; echo $?)"

# ---------------------------------------------------------------------------
banner "fstab — noatime and tmpfs"
# ---------------------------------------------------------------------------
FSTAB="$WORK/fstab"
BOOT_DIR="/boot/firmware"
cat > "$FSTAB" <<'FIX'
proc            /proc           proc    defaults          0       0
PARTUUID=abc-01  /boot/firmware  vfat    defaults          0       2
PARTUUID=abc-02  /               ext4    defaults,noatime  0       1
# a comment mentioning / that must not be touched
FIX

root_before="$(grep -E '[[:space:]]/[[:space:]]' "$FSTAB")"
fstab_add_noatime "/" >/dev/null 2>&1
check "root line byte-identical when noatime already present" "$root_before" "$(grep -E '[[:space:]]/[[:space:]]' "$FSTAB")"
check "no duplicate noatime on root" "0" "$(! grep -q 'noatime,noatime' "$FSTAB"; echo $?)"

fstab_add_noatime "/boot/firmware" >/dev/null 2>&1
check "noatime added to /boot/firmware" "0" "$(awk '$2=="/boot/firmware"{exit ($4 ~ /noatime/) ? 0 : 1}' "$FSTAB"; echo $?)"
fstab_add_noatime "/boot/firmware" >/dev/null 2>&1
check "noatime not duplicated on re-run" "0" "$(! grep -q 'noatime,noatime' "$FSTAB"; echo $?)"
check "comment line untouched" "0" "$(grep -qF '# a comment mentioning / that must not be touched' "$FSTAB"; echo $?)"
check "proc line untouched" "0" "$(awk '$2=="/proc"{exit ($4=="defaults") ? 0 : 1}' "$FSTAB"; echo $?)"

# ---------------------------------------------------------------------------
banner "eeprom_merge_key"
# ---------------------------------------------------------------------------
EE="$WORK/eeprom.txt"
cat > "$EE" <<'FIX'
[all]
BOOT_UART=1
POWER_OFF_ON_HALT=0
BOOT_ORDER=0xf41
FIX

eeprom_merge_key "$EE" BOOT_UART 0
check "existing key replaced" "BOOT_UART=0" "$(grep '^BOOT_UART=' "$EE")"
check "existing key appears once" "1" "$(grep -c '^BOOT_UART=' "$EE")"
check "unrelated key preserved" "POWER_OFF_ON_HALT=0" "$(grep '^POWER_OFF_ON_HALT=' "$EE")"

eeprom_merge_key "$EE" NET_INSTALL_ENABLED 0
check "missing key appended" "NET_INSTALL_ENABLED=0" "$(grep '^NET_INSTALL_ENABLED=' "$EE")"

eeprom_merge_key "$EE" BOOT_ORDER 0xf1
check "BOOT_ORDER replaced" "BOOT_ORDER=0xf1" "$(grep '^BOOT_ORDER=' "$EE")"

before="$(cat "$EE")"
eeprom_merge_key "$EE" BOOT_ORDER 0xf1
check "merge is idempotent" "$before" "$(cat "$EE")"

# duplicate keys collapse to one
printf 'BOOT_UART=1\nX=1\nBOOT_UART=1\n' > "$EE"
eeprom_merge_key "$EE" BOOT_UART 0
check "duplicate keys collapsed to one" "1" "$(grep -c '^BOOT_UART=' "$EE")"

# ---------------------------------------------------------------------------
banner "disable_cloud_init"
# ---------------------------------------------------------------------------
STUB="$WORK/stubbin"; mkdir -p "$STUB"
stub_cloud_init() {  # stub_cloud_init <status-string>
    printf '#!/bin/sh\necho "status: %s"\n' "$1" > "$STUB/cloud-init"
    chmod 755 "$STUB/cloud-init"
}
PATH="$STUB:$PATH"

DISABLE_CLOUD_INIT=1
CLOUD_INIT_DISABLED="$WORK/cloud-init.disabled"

stub_cloud_init "done"
rm -f "$CLOUD_INIT_DISABLED"
disable_cloud_init >/dev/null 2>&1
check "status 'done' creates the flag file" "0" "$(exists "$CLOUD_INIT_DISABLED")"

disable_cloud_init >/dev/null 2>&1
check "re-run is idempotent (flag still there)" "0" "$(exists "$CLOUD_INIT_DISABLED")"

stub_cloud_init running
rm -f "$CLOUD_INIT_DISABLED"
disable_cloud_init >/dev/null 2>&1
check "status 'running' does NOT disable" "1" "$(exists "$CLOUD_INIT_DISABLED")"

stub_cloud_init error
rm -f "$CLOUD_INIT_DISABLED"
disable_cloud_init >/dev/null 2>&1
check "status 'error' does NOT disable" "1" "$(exists "$CLOUD_INIT_DISABLED")"

printf '#!/bin/sh\nexit 1\n' > "$STUB/cloud-init"; chmod 755 "$STUB/cloud-init"
rm -f "$CLOUD_INIT_DISABLED"
disable_cloud_init >/dev/null 2>&1
check "unreadable status does NOT disable" "1" "$(exists "$CLOUD_INIT_DISABLED")"

stub_cloud_init "done"
DISABLE_CLOUD_INIT=0
rm -f "$CLOUD_INIT_DISABLED"
disable_cloud_init >/dev/null 2>&1
check "DISABLE_CLOUD_INIT=0 is honoured" "1" "$(exists "$CLOUD_INIT_DISABLED")"
DISABLE_CLOUD_INIT=1

stub_cloud_init "done"
DRY_RUN=1
rm -f "$CLOUD_INIT_DISABLED"
disable_cloud_init >/dev/null 2>&1
check "dry-run does not create the flag" "1" "$(exists "$CLOUD_INIT_DISABLED")"
DRY_RUN=0

# ---------------------------------------------------------------------------
banner "BOOT_ORDER policy (only touched when explicitly configured)"
# ---------------------------------------------------------------------------
# Mirrors the key-list construction in phase_eeprom.
build_keys() {
    local -a keys=("BOOT_UART=0" "NET_INSTALL_ENABLED=0" "NET_INSTALL_AT_POWER_ON=0")
    if [[ -n "$BOOT_ORDER" ]]; then
        keys+=("BOOT_ORDER=${BOOT_ORDER}")
    fi
    printf '%s\n' "${keys[@]}"
}

BOOT_ORDER=""
check "empty BOOT_ORDER yields 3 keys" "3" "$(build_keys | wc -l)"
check "empty BOOT_ORDER omits BOOT_ORDER" "0" "$(build_keys | grep -c BOOT_ORDER)"
check "NET_INSTALL keys always present" "2" "$(build_keys | grep -c NET_INSTALL)"

BOOT_ORDER="0xf41"
check "set BOOT_ORDER yields 4 keys" "4" "$(build_keys | wc -l)"
check "set BOOT_ORDER is carried through" "BOOT_ORDER=0xf41" "$(build_keys | grep '^BOOT_ORDER=')"
BOOT_ORDER=""

# An empty BOOT_ORDER must never reach eeprom_merge_key and blank the value.
EE2="$WORK/eeprom-policy.txt"
printf 'BOOT_UART=1\nBOOT_ORDER=0xf41\n' > "$EE2"
for kv in $(build_keys); do
    eeprom_merge_key "$EE2" "${kv%%=*}" "${kv#*=}"
done
check "pre-existing BOOT_ORDER left untouched" "BOOT_ORDER=0xf41" "$(grep '^BOOT_ORDER=' "$EE2")"
check "BOOT_UART still normalised to 0" "BOOT_UART=0" "$(grep '^BOOT_UART=' "$EE2")"

# ---------------------------------------------------------------------------
banner "firmware_timings (pre-kernel measurement)"
# ---------------------------------------------------------------------------
FWSTUB="$WORK/fwbin"; mkdir -p "$FWSTUB"
PATH="$FWSTUB:$PATH"

# vclog absent entirely
rm -f "$FWSTUB/vclog"
out="$(firmware_timings 2>&1)"
check "missing vclog does not fail" "0" "$?"
check "missing vclog is reported" "0" "$(grep -q 'vclog unavailable' <<<"$out"; echo $?)"

# vclog present with realistic output
cat > "$FWSTUB/vclog" <<'VCL'
#!/bin/sh
cat <<'OUT'
005209.127: arasan: arasan_emmc_open
006735.482: HDMI1: hdmi_pixel_freq_limit: 300000000
011247.613: arm_loader: Starting ARM with 948MB
012588.421: vchiq_core: vchiq_init_state
OUT
VCL
chmod 755 "$FWSTUB/vclog"
out="$(firmware_timings 2>&1)"
check "bootloader start parsed"  "bootloader_start_ms=005209.127" "$(grep '^bootloader_start_ms=' <<<"$out")"
check "Starting ARM parsed"      "starting_arm_ms=011247.613"     "$(grep '^starting_arm_ms=' <<<"$out")"
check "firmware stage computed"  "firmware_stage_ms=6038"         "$(grep '^firmware_stage_ms=' <<<"$out")"

# vclog present but silent (non-root)
printf '#!/bin/sh\nexit 0\n' > "$FWSTUB/vclog"; chmod 755 "$FWSTUB/vclog"
out="$(firmware_timings 2>&1)"
check "silent vclog does not fail" "0" "$?"
check "silent vclog is reported" "0" "$(grep -q 'no output' <<<"$out"; echo $?)"

# vclog that errors out must not abort under set -e
printf '#!/bin/sh\nexit 1\n' > "$FWSTUB/vclog"; chmod 755 "$FWSTUB/vclog"
firmware_timings >/dev/null 2>&1
check "failing vclog does not abort the script" "0" "$?"

# no "Starting ARM" line at all
printf '#!/bin/sh\necho "005209.127: something"\n' > "$FWSTUB/vclog"; chmod 755 "$FWSTUB/vclog"
out="$(firmware_timings 2>&1)"
check "missing Starting ARM handled" "starting_arm_ms=unknown" "$(grep '^starting_arm_ms=' <<<"$out")"
rm -f "$FWSTUB/vclog"

# ---------------------------------------------------------------------------
printf '\n===============================\n'
printf ' passed: %d   failed: %d\n' "$PASS" "$FAIL"
printf '===============================\n'
[[ "$FAIL" -eq 0 ]]
