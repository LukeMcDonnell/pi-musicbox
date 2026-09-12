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

**MPD's config lives at `/etc/musicbox/mpd.conf`, not `/etc/mpd.conf`.** Debian's
unit already provides the hook — `EnvironmentFile=/etc/default/mpd` and
`ExecStart=/usr/bin/mpd --systemd $MPDCONF` — and ships `MPDCONF` commented out.
Setting it in a managed block leaves the package conffile untouched, so dpkg
never prompts on upgrade and `--revert` is exact. An include file was the
obvious-looking alternative and does not work: Debian's `mpd.conf` already sets
`music_directory` and `bind_to_address`, and MPD treats a redefined parameter as
a fatal duplicate.

**118 packages for MPD, accepted.** `--no-install-recommends` does not help —
they are all hard Depends: the full ffmpeg stack, fluidsynth and a soundfont,
OpenAL, JACK, PipeWire, PulseAudio, sndio, libupnp. This sits badly next to
`setup.sh` stripping the OS, and it was taken deliberately: they are shared
libraries, not services, so the cost is disk (23G free) and not boot time (the
scarce resource). A source build would mean owning the rebuild forever.

**`auto_update "no"` is not a preference.** MPD's auto-update watches the
library with inotify, and inotify cannot see changes made on the far side of an
NFS mount. Turning it on would hold a watch on ~50,000 files and still never
fire. Updates are explicit.

It does **not** disable the initial scan, which was a wrong assumption on my
part: with no `tag_cache`, MPD builds the database itself at startup. Observed
on the device — MPD scanned unprompted on its first start. Two consequences that
are now written into the config and the script: MPD reads `music_directory` at
startup and therefore **does** trigger the lazy automount, and restarting mpd
mid-scan abandons the scan and leaves a partial database.

**`mixer_control "Digital"`, not `"PCM"`.** `PCM` is what most MPD examples show
and it does not exist on a pcm512x. Verified with `amixer -c 0 scontrols`.

**Node, not Python or Go, and the objection I had was aimed wrong.** The stack is
TypeScript end to end so the API contract is shared types rather than prose that
drifts. My initial objection — "Node costs 363 apt packages" — was wrong: that is
Debian's `npm`, which unbundles every npm dependency into its own `node-*`
package. `nodejs` alone is **12**, and npm is only `Suggests:`. The Pi never
needs it, because both halves are built here and it receives one bundled
`server.js` plus static files.

**Boot time did not discriminate between runtimes at all.** The critical path
was already `mpd.service +5.96s`; anything starting in parallel and finishing
sooner adds nothing. Go's ~10ms versus Node's few hundred would have been
invisible. What actually mattered was *ordering* — and the measurement confirmed
it: the server adds **0s** (17.786s vs 17.896s).

**One runtime dependency.** Static file serving and the MPD protocol are
hand-written rather than pulled from npm. The MPD protocol is line-oriented and
simple, and hand-rolling the static handler gives exact control over caching —
which matters because Angular content-hashes filenames, so `index.html` must be
`no-cache` while hashed assets are `immutable`. It also keeps the bundle free of
dynamic requires.

**Events are full snapshots, never deltas** (the user's call, and the right one).
A dropped, duplicated or out-of-order event costs nothing; the client replaces
state wholesale and can never drift. The one exception is the queue, referenced
by version — embedding 37,289 songs would mean megabytes per volume change.

**A `.path` unit restarts the server on deploy.** A `.path` can only *start* a
unit, so restarting a running service needs a `Type=oneshot` shim in between.
Worth the extra unit: the dev loop then needs no sudo at all, and rsync's
temp-file-plus-rename means the watch fires once on a complete file. Never use
`rsync --inplace` here — it would break that.

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

**"MPD is not running" flashed in the UI about once a minute.** MPD closes a
connection that sends nothing for `connection_timeout`, default **60s**. The
command connection only carries commands, so it sat silent and MPD hung up on
it; the bridge reconnected in ~500ms but published an `unavailable` snapshot in
between, which the panel and every phone rendered as an error. Measured on the
device: reconnects at 62s, 62s, 70s.

Two fixes, because one was not enough:
- a `ping` keepalive every 20s on the command connection (the idle connection
  needs none — it is blocked in `idle`, which MPD exempts);
- a 3s grace period before reporting `unavailable`, so a dropped socket or an
  `mpd` restart never reaches the UI at all.

After: one connection in 215s, where there had been three.

**The server could not shut down while anything was watching it.** Fastify's
`close()` waits for open connections to finish and an SSE stream never finishes,
so with the kiosk holding `/api/events` open the service sat in `deactivating`
until systemd's 90s stop timeout. Every deploy took 30s+ and reported failure.

This was latent from the moment SSE was written; it only appeared once the kiosk
actually pointed at the server. The lesson is that "works in testing" meant
"tested with no client connected" — the one condition that never holds in
production.

Fixed three ways: the app ends its SSE streams on SIGTERM,
`forceCloseConnections: true` destroys anything left, and `TimeoutStopSec=10`
bounds the worst case. The tests pin each independently, including one that
deliberately reproduces the hang.

**Volume accepted `null` and coerced it to 0.** `Number(null)` is `0`, so a
malformed request silently meant "set volume to silent" rather than being
rejected. Found by a test asserting the wrong thing, which is the good kind of
wrong. Validation now requires an actual number.



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

**Backticks inside an unquoted heredoc execute.** A comment in `gen_conf()`'s
`cat <<CONF` block mentioned `` `port` ``; bash ran `port` as a command, printed
"command not found" to stderr, and silently deleted the word from the generated
config. shellcheck flagged it as SC2006 "style" — it was not style, it was a
correctness bug. The generators interpolate `${MUSIC_DIR}` and friends, so the
heredoc has to stay unquoted; prose inside it must therefore avoid backticks and
`$(`.

**MPD costs ~6s of boot, and that is accepted.** 9.348s → 17.896s, with
`mpd.service` on the critical path. Decomposed, the NFS mount is only 0.54s of
it; the rest is MPD loading a 3.4M database and its decoder plugins, plus
`After=network.target` deferring the start to 9.6s. Socket activation would give
the time back but means MPD is not running at all until something connects —
a deliberate choice against it. Reversible in one command if that changes.

**An unconditional `systemctl restart` in an idempotent script is harmful.**
`setup-mpd.sh` restarted mpd on every run. Re-running it during MPD's initial
library scan aborted the scan and left a partial database — which is exactly
what happened on the device, self-inflicted, during verification. It now
restarts only when the generated config actually changed, starts mpd if it is
down, and otherwise leaves a playing box alone. Same class of bug as a blanket
`daemon-reload`: cheap-looking, and not cheap while something is using the
service.

**Debian's mpd installs disabled, not running.** I claimed a package-only change
would leave "a useless daemon enabled at boot". On Trixie both `mpd.service` and
`mpd.socket` install `disabled` and `inactive`, so `setup-mpd.sh` enabling the
service is doing necessary work. The argument for configuring it properly stands;
the stated reason was wrong.

**A sourced script's `set -e` leaks into the test shell.** The suites are
deliberately `set -uo pipefail` with no `-e` so a failing assertion does not
abort the run — but sourcing a script to reach its internals re-enables `-e`,
and the first deliberately-failing check afterwards kills the suite silently,
with no summary line. Caught while writing `test-mpd-config.sh`; both affected
suites now `set +e` after sourcing.

**Three of my own test premises were wrong before the code was.** In one sitting:
an assertion that matched the comment explaining a rule rather than a violation
of it; a test that composed the server differently from production and so tested
a 404 that production never returns; and a test asserting `close()` hangs when
the config under test made it not hang. A failing test is not automatically a
failing system — check which one is lying.

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
