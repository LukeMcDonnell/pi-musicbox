#!/usr/bin/env bash
#
# Tests the config.txt transform in install/setup-hardware.sh via --emit-config
# and --emit-revert, which touch no system state. Safe on a dev machine.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO/install/setup-hardware.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0; FAIL=0
check() {
    if [[ "$2" == "$3" ]]; then
        PASS=$((PASS+1)); printf '  ok   %s\n' "$1"
    else
        FAIL=$((FAIL+1)); printf '  FAIL %s\n       expected: %q\n       actual:   %q\n' "$1" "$2" "$3"
    fi
}
banner() { printf '\n== %s ==\n' "$1"; }
# Active (uncommented) line matching a pattern.
active() { grep -cE "^[[:space:]]*$1" "$2"; }

# Mirrors the real Raspberry Pi OS Trixie config.txt, including the section
# filters and a pre-existing setup.sh block that must survive untouched.
SRC="$WORK/config.txt"
cat > "$SRC" <<'FIX'
# For more options and information see rpi docs
dtparam=audio=on
camera_auto_detect=1
display_auto_detect=1
auto_initramfs=1
dtoverlay=vc4-kms-v3d
max_framebuffers=2
arm_64bit=1
disable_fw_kms_setup=1
arm_boost=1

[cm4]
otg_mode=1

[cm5]
dtoverlay=dwc2,dr_mode=host

[pi5]
dtoverlay=nospi10

[all]

# >>> musicbox setup.sh managed block >>>
[all]
disable_splash=1
boot_delay=0
# <<< musicbox setup.sh managed block <<<
FIX
ORIG="$(cat "$SRC")"

OUT="$WORK/out.txt"
bash "$SCRIPT" --emit-config "$SRC" "$OUT"
check "emit-config exits 0" "0" "$?"

banner "conflicting stock lines are neutralised, not shadowed"
check "no active dtparam=audio=on"        "0" "$(active 'dtparam=audio=on' "$OUT")"
check "no active display_auto_detect=1"   "0" "$(active 'display_auto_detect=1' "$OUT")"
check "no active max_framebuffers=2"      "0" "$(active 'max_framebuffers=2' "$OUT")"
check "stock lines are tagged, not deleted" "4" "$(grep -c '#musicbox-hw# ' "$OUT")"

banner "our settings are active exactly once"
check "dtparam=audio=off"        "1" "$(active 'dtparam=audio=off$' "$OUT")"
check "display_auto_detect=0"    "1" "$(active 'display_auto_detect=0$' "$OUT")"
check "max_framebuffers=1"       "1" "$(active 'max_framebuffers=1$' "$OUT")"
check "hifiberry-dacplus-std"    "1" "$(active 'dtoverlay=hifiberry-dacplus-std$' "$OUT")"
check "exactly one active vc4-kms-v3d" "1" "$(active 'dtoverlay=vc4-kms-v3d' "$OUT")"
check "vc4-kms-v3d carries nohdmi,noaudio" "1" "$(active 'dtoverlay=vc4-kms-v3d,nohdmi,noaudio$' "$OUT")"
check "DSI overlay has disable_touch" "1" "$(active 'dtoverlay=vc4-kms-dsi-7inch,disable_touch$' "$OUT")"
check "firmware touch overlay pinned"  "1" "$(active 'dtoverlay=rpi-ft5406$' "$OUT")"
check "no disable_touchscreen in firmware mode" "0" "$(active 'disable_touchscreen=' "$OUT")"
check "hdmi_ignore_edid set"     "1" "$(active 'hdmi_ignore_edid=' "$OUT")"
check "hdmi_ignore_hotplug set"  "1" "$(active 'hdmi_ignore_hotplug=' "$OUT")"

banner "ordering trap: base overlay must precede the panel overlay"
v3d=$(grep -n '^dtoverlay=vc4-kms-v3d' "$OUT" | cut -d: -f1)
dsi=$(grep -n '^dtoverlay=vc4-kms-dsi-7inch' "$OUT" | cut -d: -f1)
check "vc4-kms-v3d appears before vc4-kms-dsi-7inch" "yes" "$([[ -n "$v3d" && -n "$dsi" && "$v3d" -lt "$dsi" ]] && echo yes || echo no)"

banner "block hygiene"
check "exactly one setup-hardware block" "1" "$(grep -cF '>>> musicbox setup-hardware.sh' "$OUT")"
check "setup.sh block survives untouched" "1" "$(grep -cF '>>> musicbox setup.sh' "$OUT")"
check "setup.sh block content intact" "1" "$(active 'disable_splash=1$' "$OUT")"
check "block opens with [all] filter" "[all]" "$(sed -n '/>>> musicbox setup-hardware/{n;p;}' "$OUT")"
check "[pi5] section content preserved" "1" "$(active 'dtoverlay=nospi10$' "$OUT")"

banner "idempotency"
OUT2="$WORK/out2.txt"
bash "$SCRIPT" --emit-config "$OUT" "$OUT2"
check "re-emitting is byte-identical" "0" "$(cmp -s "$OUT" "$OUT2"; echo $?)"
check "still exactly one block" "1" "$(grep -cF '>>> musicbox setup-hardware.sh' "$OUT2")"
check "still one tagged set (no double-tagging)" "4" "$(grep -c '#musicbox-hw# ' "$OUT2")"

banner "--touch kernel selects the i2c backend"
OUTK2="$WORK/tk.txt"
bash "$SCRIPT" --touch kernel --emit-config "$SRC" "$OUTK2"
check "kernel mode: plain DSI overlay"      "1" "$(active 'dtoverlay=vc4-kms-dsi-7inch$' "$OUTK2")"
check "kernel mode: no rpi-ft5406"          "0" "$(active 'dtoverlay=rpi-ft5406' "$OUTK2")"
check "kernel mode: disable_touchscreen=1"  "1" "$(active 'disable_touchscreen=1$' "$OUTK2")"
bash "$SCRIPT" --touch bogus --emit-config "$SRC" "$WORK/z.txt" >/dev/null 2>&1
check "invalid --touch is refused" "1" "$?"

# switching backends must not leave the other one's settings active
OUTSW="$WORK/sw.txt"
bash "$SCRIPT" --touch firmware --emit-config "$OUTK2" "$OUTSW"
check "switching kernel->firmware clears disable_touchscreen" "0" "$(active 'disable_touchscreen=' "$OUTSW")"
check "switching kernel->firmware adds rpi-ft5406" "1" "$(active 'dtoverlay=rpi-ft5406$' "$OUTSW")"

banner "--keep-hdmi"
OUTK="$WORK/keep.txt"
bash "$SCRIPT" --keep-hdmi --emit-config "$SRC" "$OUTK"
check "no hdmi_ignore_edid"        "0" "$(active 'hdmi_ignore_edid=' "$OUTK")"
check "no hdmi_ignore_hotplug"     "0" "$(active 'hdmi_ignore_hotplug=' "$OUTK")"
check "vc4-kms-v3d without nohdmi" "1" "$(active 'dtoverlay=vc4-kms-v3d$' "$OUTK")"
check "DSI overlay still pinned"   "1" "$(active 'dtoverlay=vc4-kms-dsi-7inch,disable_touch$' "$OUTK")"

banner "--skip-dac / --skip-display"
OUTND="$WORK/nodac.txt"
bash "$SCRIPT" --skip-dac --emit-config "$SRC" "$OUTND"
check "skip-dac omits hifiberry"      "0" "$(active 'dtoverlay=hifiberry' "$OUTND")"
check "skip-dac leaves audio=on alone" "1" "$(active 'dtparam=audio=on$' "$OUTND")"
check "skip-dac still does display"   "1" "$(active 'display_auto_detect=0$' "$OUTND")"

OUTNS="$WORK/nodisp.txt"
bash "$SCRIPT" --skip-display --emit-config "$SRC" "$OUTNS"
check "skip-display omits DSI overlay"    "0" "$(active 'dtoverlay=vc4-kms-dsi-7inch' "$OUTNS")"
check "skip-display omits touch overlays" "0" "$(active 'dtoverlay=rpi-ft5406' "$OUTNS")"
check "skip-display leaves vc4 untouched" "1" "$(active 'dtoverlay=vc4-kms-v3d$' "$OUTNS")"
check "skip-display still does DAC"       "1" "$(active 'dtoverlay=hifiberry-dacplus-std$' "$OUTNS")"

banner "both skips is refused"
bash "$SCRIPT" --skip-dac --skip-display --emit-config "$SRC" "$WORK/x.txt" >/dev/null 2>&1
check "exits non-zero" "1" "$?"

banner "revert restores the original exactly"
REV="$WORK/rev.txt"
bash "$SCRIPT" --emit-revert "$OUT" "$REV"
check "emit-revert exits 0" "0" "$?"
check "reverted file matches the original" "$ORIG" "$(cat "$REV")"
check "no musicbox-hw tags remain" "0" "$(grep -c '#musicbox-hw# ' "$REV")"
check "setup.sh block still present after revert" "1" "$(grep -cF '>>> musicbox setup.sh' "$REV")"

printf '\n===============================\n passed: %d   failed: %d\n===============================\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
