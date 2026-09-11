# Decisions, and things that were wrong

Two kinds of entry: choices that look arbitrary but are not, and confident
predictions that the hardware disproved. The second kind is here because the
same mistakes are easy to repeat.

## Choices

**Both NAS protocols are supported, chosen at run time.** SMB is the friendlier
default on a Synology (enabled by default, clean client-side ownership via
`uid=`/`gid=`, no squash config). NFS is faster at directory traversal — which
is MPD's initial scan — and stores no credentials on the device. ~16 packages on
24G free is not worth optimising, so `install.sh` installs both clients and
`setup-nas.sh` can offer either without a second run. NFS was chosen in the end.

**Read-only mount.** MPD only reads, and it removes any chance of the Pi
damaging the library. It also makes `file_mode=0444,dir_mode=0555` harmless,
which sidesteps the fact that MPD's user does not exist yet and would never
match a NAS uid anyway.

**`setup-kiosk.sh` installs its own packages**, breaking the otherwise-strict
"install.sh installs, setup-*.sh configure" rule. Explicitly requested: if this
ever goes headless, the entire kiosk should be removable by deleting one script.

**cage, not a full compositor.** Single-app Wayland kiosk compositor; no desktop,
no window manager, no display manager, no login prompt.

**`BOOT_ORDER` is left at the bootloader default.** Narrowing it buys nothing
measurable and can make a box unbootable from a fresh card.

**apt auto-update timers are masked**, so there are no automatic security
updates. Appliance trade-off; `MASK_APT_TIMERS=0` restores them.

**Half the standard Pi boot-optimisation advice is actively harmful here**,
because this box is neither headless nor network-optional:
`dtoverlay=disable-bt` (Bluetooth audio is planned), `disable-wifi` (the library
is on the network), removing `avahi-daemon` (the web UI is served at
`<hostname>.local`), `max_framebuffers=0` (a DSI panel is attached), stripping
USB/`sr_mod` (a USB CD drive is planned), removing DRM (a kiosk browser is
coming).

## Predictions the hardware disproved

**"Masking `NetworkManager-wait-online` is the biggest single win, 6–19s."**
False on this device — it was already disabled and never appeared in
`systemd-analyze blame`. Masking it is a no-op here, kept only so a package
update cannot re-enable it. The README claim was corrected.

**"The 6s `NetworkManager.service` is wifi or DHCP."** It was neither. Imager
provisions via cloud-init → netplan → NetworkManager, and on startup NM
round-trips every connection through netplan's YAML store; each write triggers a
full systemd `daemon-reload` at ~720ms. Four connections, four reloads, ~5.3s of
pure overhead before DHCP even began. This, not `setup.sh`, is where the boot
saving came from.

**"Suppressing HDMI will reclaim the 1537ms gap."** It reclaimed **zero**. The
gap persists at 1543ms and is still unexplained. The underlying error was
attributing a gap to the log line *preceding* it rather than the one after —
`vclog` timestamps mark when a line was emitted, not how long the next stage
took. HDMI suppression is still worth keeping (it removes the vc4hdmi ALSA
cards, which makes MPD's card selection unambiguous), but not for boot time.

**"The EEPROM change is applied immediately via flashrom."** `flashrom` is not
installed. `rpi-eeprom-update` stages `pieeprom.upd` + `recovery.bin` in
`/boot/firmware` and the *bootloader* flashes them at the next boot, renaming
`recovery.bin` to `RECOVERY.000`. The conclusion (it works, ~0.75s saved) held;
the mechanism was wrong, and verifying it costs an extra boot cycle.

**"`force_eeprom_read=0` is a trap."** Overstated. It is a general HAT-detection
hazard, but this DAC+ has an unprogrammed ID EEPROM, so it breaks nothing here.
Left unset out of caution, not necessity.

**Touch: three device test cycles were wasted guessing.** `--touch-events=enabled`
on chromium, then `disable_touchscreen=1`, both before anyone had looked at raw
`/dev/input/event0`. The capture took minutes and settled it immediately.
**Capture the raw input first.** Guessing at the top of the stack when the
problem is at the bottom costs the user a reboot per guess.

## Bugs that shipped and what they teach

**fstab entry had 12 fields instead of 6.** `line="$(build_fstab_line ...)"`
strips the trailing newline — command substitution always does — and
`write_managed_block` wrote it with `printf '%s'`, gluing the closing marker
onto the record. Fixed with `printf '%s\n' "${content%$'\n'}"`.

**The `.automount` unit was generated but never started.** `daemon-reload`
creates it from fstab; it does not start it. The mount would only have worked
after a reboot. Worse, the verification step used `ls`, which succeeds on an
empty directory — it reported success on a broken mount. Verification now
requires `findmnt`.

Both bugs survived because the tests only exercised the *line generator* via
`--emit-fstab`, not the code that writes the line into the file. Test the
function that touches the filesystem, by sourcing it, not just the pure one.

**A stale copy on the device cost a debugging cycle.** Files were `scp`'d
piecemeal. Sync whole directories and check `md5sum`.

## `set -euo pipefail` traps hit in this repo

- `local x="$(cmd | awk ...)"` — the `local` swallows the exit status, but a
  bare `x="$(cmd)"` aborts the entire script when `cmd` fails. The
  "unreadable cloud-init status" branch was **unreachable** until `|| true` was
  added. Declare and assign separately, and add `|| true` when failure is
  expected.
- `[[ -n "$X" ]] && arr+=(...)` is safe mid-function but aborts the script when
  it is the **last statement of a function** (the function returns the failed
  test's status). Replaced with explicit `if` throughout.
- `${#(cmd)}` is not valid bash. It passes `bash -n` and fails at runtime with
  "bad substitution".

## shellcheck / harness gotchas already paid for

| | |
|---|---|
| SC2319 | `$?` after a condition refers to the condition — wrap in an `exists()` helper |
| SC1010 | `done` as a literal argument must be quoted |
| SC1087 | `$t[` needs `${t}[` |
| SC2016 | a `# shellcheck disable` comment must precede **each** line, not the block |
| `has -- 'pat' file` | the stray `--` was matched literally |
| `<head` | also matches `<header` — anchor the pattern |
| `/mnt/tests/*.sh` | globbed on the host, not in the container; glob first, then map paths |
