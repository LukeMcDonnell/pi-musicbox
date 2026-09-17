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
`dtoverlay=disable-bt` (Bluetooth audio now works), `disable-wifi` (the library
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

**The snapshot describes the active source, reversing a decision made hours
earlier.** When the sink first landed, the top-level `state`/`track`/`elapsed`
meant MPD even while a phone played, and four separate comments told clients to
branch on `source`. That was the honest shape when a phone offered no metadata.
AVRCP turned out to offer title, artist, album, duration, position and track
numbers, so the fields now mean "what is playing" and clients need no branching.
The superseded reasoning is revised in place, not deleted — it explains why the
first shape was right at the time.

**No cover art for Bluetooth, and no guessing one.** The phone advertises AVRCP
1.6, which specifies Cover Art, and it is still unavailable: the target offers no
OBEX channel for it and `bluetoothd` contains no cover-art code at all. Borrowing
a cover by matching the phone's artist and album against the local library works
on the first try and was still rejected — that metadata is free text, and a
near-miss shows a confidently wrong cover. A missing cover is obvious; a wrong one
is misinformation.

**Playback control reaches Bluetooth through a FIFO, not a subprocess.** The
backend's own user is allowed to call `org.bluez` methods, so `busctl` would have
worked. It writes a word to `/run/musicbox/control` instead: keeping the backend
free of `child_process` is what makes "a bug in the server cannot make the audio
wrong" true, and `disconnect` has to be the arbiter's decision regardless.

**`RuntimeDirectory` is not stable across a restart.** systemd deletes and
recreates it, which silently killed the server's inotify watch on `/run/musicbox`
after every arbiter restart — the arbiter published perfectly and the API showed
nothing, rescued only by a slow poll. `RuntimeDirectoryPreserve=yes` plus an
inode check on the watcher. The same class of bug as watching a file that gets
replaced by rename, one directory up.

**BlueALSA rather than PipeWire for the Bluetooth sink, on measured grounds.**
Neither Debian build links `fdk-aac` (it is non-free), so both offer *exactly the
same* sink codecs — aptX HD, aptX, SBC-XQ, SBC, and no AAC. Given identical
codecs, BlueALSA is one daemon where PipeWire is a session bus plus wireplumber
plus a user session, and it leaves MPD holding `hw:0,0` raw. PipeWire would want
to own the DAC and would reopen the `mixer_type "none"` decision.

**No AAC, and an iPhone therefore gets SBC-XQ.** Getting it would mean rebuilding
`bluez-alsa` against `libfdk-aac2t64` from trixie/non-free: a cross or emulated
arm64 build, producing a pinned local `.deb` that apt will never update, for a
codec library with a security history. Declined; revisit only if an iPhone
actually sounds bad. Installing the library alone changes nothing, which is worth
knowing before someone "fixes" it that way.

**The Bluetooth handoff lives in a root bash service, not in the backend.** The
backend owns MPD and publishes the snapshot, so it looked like the natural home.
It has to keep working while the server is being redeployed and when someone uses
`mpc` directly, and starting units and disconnecting BlueZ devices need privilege
the server should not have. So the arbiter decides and the server only reads
`/run/musicbox/bluetooth.json`. A bug on the server side can make the UI wrong; it
cannot make the audio wrong.

**A second Bluetooth device takes the speaker; the newest connection wins.**
`hw:0,0` is exclusive, so two phones cannot share it and the only question is
which one holds it. Incumbent-wins was the alternative and is worse in the room:
the person who just connected gets silence with nothing on the box to say why,
and the arbiter has no way to tell them. So the incumbent is disconnected rather
than left connected and mute — "connected but nothing comes out" is exactly the
confusing state this replaced. **No reconnect cooldown**: an evicted phone that
auto-reconnects has made a new connection and legitimately wins, and a timer that
silently refuses a connection the user just made is worse than the ping-pong it
speculates about. Revisit if a ping-pong is ever actually observed.

**The Bluetooth radio was rfkill soft-blocked, and nothing in this repo did it.**
`bluetoothctl show` reported `PowerState: off-blocked` and `bluetoothd` logged
`Failed to set mode: Failed (0x03)` at every boot, with the hardware otherwise
fine. Another instance of **verify the effect, not the setting**: `AutoEnable` in
`main.conf` is necessary and not sufficient. `rfkill` the command is not
installed, so the block is cleared through sysfs — scanned by `type`, because
rfkill indices are not stable.

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

**No volume control on this device.** It sits upstream of a preamp and power amp
that both have volume, so MPD runs `mixer_type "none"` and never touches the
pcm512x attenuator — every dB of digital attenuation discards resolution. Volume
was removed from the API and UI rather than left inert, and `API_VERSION` was
deliberately **not** bumped because nothing consumes the API from outside this
repo yet.

`musicbox-dac-unity.service` then has to exist: with MPD no longer owning those
controls, `alsa-restore` reloads whatever is in `asound.state`, so a single stray
`amixer` call would leave the box quietly attenuated with nothing to notice. The
unit asserts 0 dB at boot, costs 220ms, and finishes ~3s before MPD starts.

**`Deemphasis` was on by default and is now off.** A fixed treble de-emphasis
filter, correct only for pre-emphasised recordings. Unnecessary DSP has no place
in a path aiming to be bit-perfect. Reversible with one `amixer` call if anything
ever sounds wrong.

**Attenuation, if ever needed, belongs in the analog domain** — the `Analogue`
control's −6 dB step — never the digital attenuator.

**The artist list is virtualised with a third-party scroller, not the CDK and not
by hand.** `@iharbeck/ngx-virtual-scroller` — note the scope: the bare
`ngx-virtual-scroller` on npm stopped at 4.0.3 in 2022, is View-Engine-compiled
(it ships a `.metadata.json` and no Ivy declarations) and cannot be consumed at
all since ngcc was removed in Angular 16. The scoped fork is the live one,
published against 20.3. `@angular/cdk` was the obvious alternative and is not
cheaper: `scrolling.mjs` alone is 75kB raw / 16kB gzip before tree-shaking, and
its viewport wants to own the element that scrolls, which is the one thing
app.html does not allow. Hand-rolling ~70 lines for a uniform single-column list
was the third option and would have fitted the one-dependency ethos; it was
turned down because the scroll geometry here is subtle enough that the review
found two separate 8px ways to get it wrong, and none of them fail loudly.

**Measured cost of it: 380.4kB to 418.9kB raw initial** (main 326.5 -> 365.1kB),
i.e. +38.5kB, not the ~98kB the two packages weigh on disk — esbuild tree-shakes
most of `@tweenjs/tween.js`, which is a declared peer and has to be installed
even though only `scrollToIndex` would use it. 81kB of headroom left against
`angular.json`'s 500kB warning, and **`tools/build.sh` pipes `ng build` to
`/dev/null`, so that warning would be invisible** — run `npx ng build` directly
when adding a dependency.

**`parentScroll` onto `<main>`, and `checkResizeInterval` off.** The page scrolls
in `<main>` (app.html says why at length), so the list is pointed at that element
rather than given a viewport of its own. Two consequences worth knowing: the
scroller's default is to write inline `overflow` onto whatever it is pointed at,
which would move the definition of the scroll frame out of app.html — turned off;
and its resize detection on that branch is a 1Hz `getBoundingClientRect` for as
long as the screen is mounted, replaced by a window resize listener. That
substitution holds only while every change to `<main>`'s box is viewport-driven,
which is true today and is written down in the `library.ts` header.

**Do not resolve the scroll frame with `closest('main')`.** A routed component's
host element is inserted after its constructor runs, so it answers null — and the
failure is silent: a virtual scroller with no frame measures itself, concludes
every row is on screen, and renders all 487 looking exactly like the list that
works. It comes through `ScrollFrame`, a root service App publishes into, the
same shape as `NowPlayingSheet` and for the same reason.

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

**A second phone connecting and leaving took the speaker from the first.**
`handle_bt`'s `PCMRemoved` arm checked only that *something* was active, never
that the transport that had just gone belonged to it. So a phone that connected
and left — while a different phone was mid-song — stopped the audio unit and
published `{}`, and the log line named `$ACTIVE_ADDR` for an event about another
device, which is the kind of log that sends you looking in the wrong place.

It was invisible for as long as it was because the matching `PCMAdded` arm
*dropped* second devices entirely, so the only way to reach the bug was to
connect a second phone and then disconnect it — which is not something a single
tester does. The lesson is that **an event handler keyed on a shared resource
must identify which instance the event is about**, even when the design says
there is only ever one of them; "only ever one" was an assumption about the
world, not something enforced anywhere.

Both arms are fixed together, because they are the same assumption: the newcomer
now takes the speaker (above) and `PCMRemoved` compares the address. The
comparison is load-bearing for the takeover too — the evicted phone's own
removal is still queued behind it, so without the check every takeover would
cancel itself a moment after it happened.

The suite had **no assertion that ran `handle_bt` at all**; it was tested only
through `musicbox-bt publish`, which bypasses the dispatcher. It now sources the
generated arbiter with recording stubs on `PATH` and drives the four events in
order. Both bugs lived in the dispatcher's decisions, and no amount of grepping
its text would have found either.

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

**A page refresh showed the elapsed time from the last MPD event, not now.**
MPD's `idle` never fires merely because elapsed time advanced, so `bridge.current`
keeps the `elapsed` from the last real event — a resume, seek or track change. The
client interpolates from *when it received the frame*, so being handed that cached
snapshot made it count up from the old position: pause, resume, wait, reload, and
the UI showed the resume position as though it were current.

The tell was that `serverTime` — which the shared type documents as "for
interpolation" — was never read by anything. Fixed server-side instead of by
trusting it: `/api/events` refreshes before its first frame and `/api/status`
refreshes before responding. Using `serverTime` on the client would require a
phone's clock to agree with the Pi's; re-querying MPD needs no such assumption.

Verified on the device — three connects 12s apart returned 4:49, 5:06, 5:23
where all three would previously have returned the resume position.

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

**Backticks inside an unquoted heredoc execute — and this has now happened
twice in the same generator.** The second time, a comment reading `` `mpc volume` ``
ran `mpc`, printed "command not found", and deleted the word from the emitted
config. `tests/test-mpd-config.sh` now asserts that `--emit` produces **no stderr
output** and that no generator contains a backtick, which catches the whole class
rather than each instance.

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

## `cpufreq.default_governor=performance` is a deadlock fix, not a tweak

Do not "restore `ondemand` to save power". The `ondemand` governor calls the
VideoCore firmware mailbox on a timer, and that path raced and wedged the whole
board for 1h57m — holding the single global clock lock, which stopped audio,
froze the panel and made MPD stop answering while still reporting `active
(running)`. Full trace and evidence in `clock-deadlock.md`.

## "MPD is not running" does not mean MPD is not running

Three distinct causes have produced that exact message:

1. MPD hung up on an idle command connection every ~62s (`connection_timeout`).
   Fixed with a `ping` keepalive plus a 3s grace before reporting unavailable.
2. MPD's main thread wedged behind a kernel clock deadlock — process alive,
   `systemctl` happy, kernel accepting connections on its behalf
   (`ss -ltn` showing `Recv-Q 1`). See `clock-deadlock.md`.
3. The backend itself hanging, because `send()` had no reply timeout.

Check `ss -ltn '( sport = :6600 )'` and `/proc/<pid>/stack` before believing
`systemctl`.

## A protocol reply timeout must be fatal to the connection

`MpdConnection` matches replies to commands purely by **order**. Abandoning one
command and keeping the socket means the next command receives the previous
command's answer — a silent wrong-data bug, far worse than a reconnect. So a
reply timeout destroys the socket and rejects everything queued. `idle` is
exempt (`{ timeoutMs: null }`); it is supposed to block.

## Every liveness probe must not go over the same link you are testing

Recorded in `wifi-instability.md` and worth repeating: it cost hours there, and
in the clock-deadlock investigation `vcgencmd` **hanging** was the single most
diagnostic result — a local probe, no network involved. Reach for local probes
first.

## A kernel cmdline parameter can be present and still have no effect

`cpufreq.default_governor=performance` was in `/proc/cmdline` and the governor
was still `ondemand`. Debian ships
`/usr/lib/udev/rules.d/60-ondemand-governor.rules`, which sets the governor on
every cpu as udev settles, after the kernel has chosen. Nothing showed up in
`systemctl list-units`, `dpkg -l` or `/etc/init.d` — it took
`grep -rl scaling_governor /etc /usr/lib/systemd /lib/udev`.

Lesson: **verify the effect, not the setting.** Reading back the file you wrote
proves only that you wrote it.

Shadowing beats editing: a same-named file in `/etc/udev/rules.d` replaces the
one in `/usr/lib/udev/rules.d`, so the packaged file is never touched and
`rm` restores stock behaviour.

## `listallinfo` is not an option on this library, and `find base` is 50x `find <tag>`

Both measured against the real MPD, and both killed a design that looked obvious
on paper.

`listallinfo` **closes the connection** after 112ms — MPD's output buffer
overflows on 37,289 songs. So there is no "read the library once into memory at
startup" shape available, however much simpler it would be. Paging it with
`window` works but is ~41MB of text across 37 requests, which is worse than not
having an index at all.

`find albumartist "X" window 0:1` costs **11.4ms**, because a tag filter scans
every song and `window` is applied after filtering. `find base "X" window 0:1`
costs **0.23ms**, because `base` is a path prefix and is indexed. Building the
artist index one way takes 5.6s and the other 111ms. If you need one song
matching something, ask by path.

Use the LEGACY `find base "<dir>"` form, not the filter expression
`"(base 'X')"`. The filter form needs its own escaping *inside* the quoting
`quoteArg` already does, and six top-level directories here contain an apostrophe
(`Guns N' Roses`, `Jane's Addiction`, `Tapes 'n Tapes`). One escaping layer that
is provably right beats two that are nearly right.

## An artist's directory is the first path segment, never a transform of their name

48 of 487 artists are filed under a directory that is not their tag: `AC/DC` in
`AC-DC` — a slash cannot be a path segment — `Andrew W.K.` in `Andrew W.K`,
`CAKE` in `Cake`. Deriving a directory from a name would be wrong for one artist
in ten and would show the wrong picture, which is the same failure mode that
rules out matching a Bluetooth track against the local library. So the name and
the directory are JOINED, by asking MPD for one song in each directory.

And it is the FIRST path segment, not `dirname` applied twice. 149 albums keep
their tracks in a disc subdirectory, so two dirnames on
`Black Sabbath/13 (2013)/CD 01/01.flac` gives the album directory. Verified for
all 487: every first segment is a real top-level directory.

## Artist pictures needed no new code, because `/api/art` was never album-specific

`GET /api/art?album=<dir>` resolves a cover inside whatever library directory it
is handed. This library files a `folder.jpg` of the artist beside their albums —
**473 of 487 artist directories have one**. So artist art is the same endpoint
keyed by the artist directory: no new route, no new filename list, no second
cache, and the week-long `Cache-Control` already applies.

Do not "tighten" the resolver to albums only, and do not rename the `album`
parameter — renaming it invalidates every cached URL in every browser for a week.

## `OriginalDate`, not `Date`, is the year an album came out

`Date` is the year of the pressing. Measured across all 2,758 albums here: 2,726
carry `OriginalDate` and **940 of those disagree with `Date`**. AC/DC's entire
catalogue is stamped 2020; `Back in Black` reads 2003 against 1980; `All Eyez on
Me` 2001 against 1996.

An artist page sorted on `Date` is therefore wrong for a third of this library,
and wrong *visibly* — the year on screen contradicts the year in the folder name
on disk. This was caught by looking at real output, not by reasoning; the first
implementation used `Date` and looked fine until AC/DC was opened.

## A UI verified only by unit tests was wrong in two ways a screenshot caught

Both library detail screens shipped with a full-width hero. On the 800x480 panel
that is 310-352 of 480 pixels, which put the album list — and the Play button,
the reason the screen exists — entirely below the fold. Every test passed.

The artist hero also read its picture from the client-side artist list, which is
empty whenever the screen is opened directly. The kiosk reloads the page on every
deploy and a phone can hold a bookmark, so that is a normal state, not an edge
case; the hero silently fell back to the placeholder. The fix was for the screen
to be self-sufficient — `GET /api/library/albums` now returns the picture, which
costs no extra MPD command because it comes off a track already fetched.

Screenshot the panel geometry. `node` + `puppeteer-core` against
`http://musicbox.local/` at 800x480 takes a minute and sees what assertions
cannot. Note that a plain `chrome --headless --screenshot` hangs on these pages:
`--virtual-time-budget` never expires while the SSE stream is open.


## The panel's on-screen keyboard is in the app, not the compositor

cage has no layer-shell, so wvkbd and squeekboard cannot draw over chromium, and
Chromium's Wayland IME is unreliable at raising one on focus anyway. The
alternatives were swapping cage for labwc (against "cage, not a full
compositor", more packages, more boot) or a Chromium extension (unmaintained,
and `--load-extension` is being withdrawn). An Angular keyboard needs neither.

It is enabled only for `http://localhost/` with no port — the kiosk URL — so
phones never see it; `?keyboard` forces it on for development. It attaches to
every text field through document focus events, so new inputs need no wiring.

Keys act on pointerdown and the keyboard cancels touchstart and mousedown. That
is what keeps focus on the field; verified with emulated touch in Chrome at
800x480, not yet on the panel itself. <main> gets bottom padding while it is up
rather than a shorter box, because the library's virtual scroller only refreshes
on viewport resizes.


## The shutdown "device is busy" and the 90s stall were two unrelated faults

Every graceful shutdown logged `umount.nfs4: /srv/music: device is busy`, and
every graceful shutdown took ~90s. It was natural to read that as one fault —
`roadmap.md` did — but the journal says they are independent, and only one of
them was costing the 90 seconds.

**The unmount error.** systemd stopped `srv-music.mount` *concurrently with*
MPD, in fact about 200ms ahead of it:

```
15:44:47.290  Unmounting srv-music.mount - /srv/music...
15:44:47.369  umount.nfs4: /srv/music: device is busy
15:44:47.497  Stopping mpd.service ...        <- 200ms too late
15:44:47.831  Stopped mpd.service             <- exits cleanly in 0.33s
```

MPD was never slow to stop. systemd simply had no dependency to order by:
`RequiresMountsFor=` was empty and the mount is `noauto,x-systemd.automount`,
so MPD only ever triggers it by reading `music_directory`.

The fix is a `mpd.service` drop-in with `After=srv-music.mount`, which systemd
reverses on shutdown. It is safe against non-negotiable #1 because `After=` is
ordering alone: it adds no requirement, cannot pull the mount into the boot
transaction, and `noauto` means the `.mount` gets no boot job for the ordering
to apply to. `After=` naming a unit that does not exist is a no-op, so a box
that never ran `setup-nas.sh` is unaffected.

`After=` on the `.automount` instead would be worse, not safer: that unit *does*
start at boot, so it would be real boot ordering — for nothing, since the EBUSY
comes from the `.mount`.

**The 90s stall was `bt-agent`, which has nothing to do with the NAS.** In the
same incident `roadmap.md` used as evidence for the mount:

```
12:43:29.172  musicbox-bt-agent.service: State 'stop-sigterm' timed out. Killing.
12:43:29.276  srv-music.mount: Deactivated successfully   <- 0.1s AFTER the kill
```

The mount deactivated 100ms *after* bt-agent was SIGKILLed; it was waiting on
the stall, not causing it. The gap is 90.1s in every recorded shutdown, i.e.
`DefaultTimeoutStopSec`. `/proc/<pid>/status` gives `SigCgt: ...4202` — bit 14
set, so bt-agent catches SIGTERM and then never exits, logging only
`SIGUSR1 received`. That is a bluez-tools bug.

The unit sets `KillSignal=SIGINT` and `TimeoutStopSec=5`. SIGINT was measured on
the device, not assumed: the agent exits in ~100ms, logs `unregistering
agent...`, and systemd records `Deactivated successfully`. SIGKILL also works
and is what was tried first, but it skips the BlueZ unregister and systemd
scores a killed main process as `Failed with result 'signal'` — a failure line
on every shutdown, for no gain. `TimeoutStopSec` still escalates to SIGKILL if
SIGINT ever stops working.

The general lesson: two symptoms in the same 90-second window are not evidence
of one cause. Timestamps at millisecond precision separated them in minutes,
and the persistent journal is what made that possible.

## Boot time is ~16.5s and none of the obvious levers move it (2026-09-14)

Prompted by "boot has blown out to 17s". It had not: 17.7s was the high tail of a
15.4–18.4s distribution, and `device.md` already records 17.896s as the measured
baseline with MPD. The median is ~16.2s. Four things came out of measuring it.

**Everything after `sysinit.target` is deterministic.** Across four boots the
total minus `sysinit.target` was 9.082, 9.100, 9.097, 8.924 — a 0.18s spread.
All boot-to-boot variance lives in reaching `sysinit.target` (6.5–9.1s), and in a
slow boot every unit in that phase stretches together (journal-flush 0.22s→2.32s,
udevd 0.47s→1.71s, `run-rpc_pipefs.mount` 0.09s→1.40s, binfmt 0.52s→1.66s) while
`fsck` does not move. That is SD I/O contention, not a slow unit. Do not chase
individual sysinit units; look at total SD write pressure.

**`network-online.target` is a fiction on this box, by design.** `setup.sh` masks
`NetworkManager-wait-online` (non-negotiable #1), so the target fires when
NetworkManager's *service* is up — 3.3s before wlan0 has an address:

```
10.170  network.target + network-online.target "reached"
10.174  mpd starts (stock Debian After=network.target)
13.304  wlan0 actually activated, DHCP done
14.473  srv-music mounted
15.438  mpd ready = multi-user.target
```

**So MPD's boot-time NFS mount is a race it wins by ~1.2s, and only because MPD
is slow.** MPD spends ~4.3s loading the local `tag_cache` before it touches
`music_directory`; that is what covers the wifi association. Starting MPD earlier
therefore does *not* save time — it would hit the automount ~3.9s before wifi has
an IP, cost 5s to fail (`device.md`), lose the boot-time database update and
leave `srv-music.mount` failed. **Dropping `After=network.target` from mpd.service
is a dead end. Do not re-run it.** It is also mechanically impossible with a
drop-in: systemd has no empty-string reset for ordering dependencies, so
`After=` followed by a re-add leaves `network.target` in place (verified with
`systemctl show mpd -p After`). Removing it would mean owning a full copy of
Debian's `mpd.service` and its hardening stanzas.

**Masking `e2scrub_reap.service` measured as exactly zero.** It is pointless work
on this box (no LVM) and burns ~3.2s of SD I/O, so it looked like a free win.
Over four boots masked: mean 16.47s. Over the twelve boots before: mean 16.45s.
It is not on the critical path and removing its I/O did not help either. Left
unmasked — an unmanaged `systemctl mask` is drift for no measured benefit.

The one real constant left is a **2.43s wpa_supplicant scan** between
`supplicant-available` and NetworkManager's `auto-activating` — 2.4322, 2.4320,
2.4317, 2.4241, 2.4270, 2.4393 across six boots, with zero journal lines in the
window. Cutting it saves nothing today, because MPD's `tag_cache` load is the
gate rather than wifi; it would only widen the mount race margin from ~1.2s to
~3.6s. That is a robustness argument, not a boot-time one.

The only change that moves `multi-user.target` materially is socket-activating
MPD (`device.md`), which relocates the cost to first client connect rather than
removing it.

## The panel sleeps by its backlight, never by DPMS (2026-09-15)

`brightness` on `/sys/class/backlight/10-0045`, written by the backend. Not
`vcgencmd display_power`, not a compositor blank, not a DRM mode-off.

The reason is `clock-deadlock.md`. The stack that hard-locked this board was
`vc4_atomic_commit_tail -> clk_set_min_rate -> clk_prepare_lock`, and the
`performance` governor fix is explicitly *not* proven to cover a deadlock formed
between vc4 and v3d alone. Every DPMS-shaped approach issues exactly that atomic
commit; `vcgencmd display_power` is the same VideoCore mailbox from a shell. A
feature whose entire job is to toggle display power on a timer would have been
aimed straight at the unresolved gap.

The backlight write avoids all of it. Measured on the device: the driver is
`rpi_touchscreen_attiny`, an **i2c** device (`7inch-touchscreen-p` under
`fe205000.i2c`), so the write goes to the ATtiny on the display board. Scanout
keeps running and the mode is untouched. It saves the LED and not the GPU, which
is the right trade on a box that has already given up idle power for stability.

Measured, not assumed, before any code was written:

- `brightness` is `0664 root:video`; the service's user is in `video`.
- `/sys` is **rw** in the unit's mount namespace despite `ProtectKernelTunables=yes`
  (`/proc/<pid>/mounts`). A write from inside the real sandbox — `ProtectSystem=full`,
  `NoNewPrivileges=yes` — succeeds. So no root arbiter, no FIFO, no new unit; the
  Bluetooth pattern in `bluetooth.md` is not needed here.
- `bl_power` is `0644 root:root` and therefore not an option.
- `brightness=0` genuinely extinguishes the panel; it does not merely dim.

The one thing not yet proven on hardware is that touch still registers while the
backlight is off. The digitizer is a separate device (`raspberrypi-ts`, via
`dtoverlay=rpi-ft5406`) so it should, and the server restoring the backlight when
the panel's SSE stream drops covers the case where it does not.

## Some settings belong to the box, not to the device (2026-09-15)

`preferences.ts` says settings live in that browser's localStorage, because "the
panel and a phone are entitled to different answers". That is still right for
everything on the Interface tab. It is wrong for the System tab, and the
distinction is worth stating rather than leaving to taste:

- **The device's.** What this screen does — open Now Playing after Play, open the
  Playlist after Queue. A phone and the panel genuinely differ, and nothing else
  needs to know. localStorage.
- **The box's.** What a piece of hardware attached to the box does. There is
  exactly one panel; its behaviour should not depend on which phone last looked
  at it, and you want to change it from the sofa. SQLite, and it travels to
  clients on the SSE stream as its own event.

The test is not "is it a setting" but "how many of the thing are there".

## Node comes from NodeSource, not Debian (2026-09-15)

Trixie ships node 20. `node:sqlite` arrived in 22.5 and is flagless from 24, and
the database had to be one of: a native module (breaks the single-file esbuild
bundle — the verdict already recorded for `sharp`), a WASM engine (a second
runtime dependency and a `.wasm` to ship), a hand-rolled JSON store, or a newer
node. Taking it from the runtime costs nothing at build or deploy time.

What it costs instead: a third-party apt repo, pinned at 600 in
`/etc/apt/preferences.d/nodesource`, and NodeSource's `nodejs` **bundles npm** —
it `Provides:` and `Conflicts:` the Debian package — so npm's files are now on
the disk where Debian's node 20 left them absent.

Non-negotiable #5's reason survives intact: it is ONE package depending only on
libc6, libstdc++6 and python3, against Debian's 12, and the Pi still builds
nothing. But "no npm on the device" is no longer literally true and the README
should not claim it is.

`have_pkg nodejs` is not enough for this one package: the image already had node
20 installed, so presence is not currency. `install.sh` compares the major
version, which is what makes the upgrade happen at all.

## Scroll position is the router's to restore, through a scroller of ours (2026-09-16)

The page scrolls in `<main>`, not the window, and the cost of that had gone
unpaid: every navigation landed at the top of whatever it went to. 487 rows into
the library, open an artist, come back, start again.

**`withInMemoryScrolling` alone is not a fix, it is a no-op.** Angular's
`RouterScroller` does all the bookkeeping correctly — it stores a position per
history entry at `NavigationStart` and replays it on `popstate` — but it replays
it through `ViewportScroller`, whose stock implementation calls `window.scrollTo`.
This window never scrolls. Turning the option on and stopping there would have
looked like a fix and done nothing at all.

`ViewportScroller` is an injectable abstract class and `RouterScroller` takes
whatever the injector has, so `FrameViewportScroller` is the whole of the change:
same bookkeeping, different element, read out of `ScrollFrame`. The option and
the provider are one feature — either alone is inert — which is why they sit
together in app.config.ts under a comment saying so, and why the test for them is
an end-to-end one in app.spec.

**The back arrows are real history back now, reversing "up, not back".** Artist
and album used to navigate to a fixed parent, with a comment turning
`location.back()` down because the path that led here is not predictable once
favourites can reach an artist. Restoration is what changed the balance:
`RouterScroller` restores on `popstate` and nothing else, so an arrow that pushes
a new entry can never bring a screen back to where it was — and "up" also
discarded the `?filter=` term the library was left under, which back preserves.
Unpredictable is also what a back button is for. `AppHistory` counts the in-app
entries behind the current one so a cold load — a bookmarked artist, a panel
reloaded onto one — still falls back to the parent instead of walking out of the
app. `history.length` cannot answer that: the router's initial navigation, every
popstate and every filter keystroke are all `replaceUrl`.

**`NavigationEnd` is too early to write a scroll position, on every screen, for
two unrelated reasons.** Artist, album and settings are still fetching their
content; the library is short because its virtual scroller sizes the spacer in
its own `requestAnimationFrame`, outside the zone. A write into a frame that is
still short clamps and reports nothing — the same shape of silent failure as a
virtual scroller with no frame. So `settle` waits for `scrollHeight` to be able
to hold the target, one read per frame, and writes once.

**The budget is 60 frames or 1000ms, and both numbers are guesses.** What would
replace them is an artist page's cold-cache round trip timed on the Pi. They are
affordable for now because the loop only runs on a real restore, and because a
touch or a wheel on the frame ends it immediately — that interruption is what
makes a generous cap safe. It is deliberately not "did `scrollTop` change": the
virtual scroller writes `scrollTop` itself when its content grows, which would
abandon every restore of the one list this matters most for. Out of budget it
writes the clamped position anyway; landing part-way beats landing at the top.
Every path names its outcome in `landing()`, so a restore that did nothing is
visible rather than merely disappointing. If `'clamped'` turns out common on the
device, raise the budget or move to a `ResizeObserver` on the frame's content,
whose callbacks land after layout and make the `scrollHeight` read free.

**The library is restored by writing `frame.scrollTop`, never by the scroller's
own `scrollToPosition`.** That method adds `getElementsOffset()` to whatever it
is given — the sticky header, the filter row, the count line — and part of that
offset is itself a function of the current scroll, so it and a recorded
`scrollTop` are different coordinate systems and the error is a variable header
height. It would also animate by default, and an animation is a `scrollTop` write
per frame, which on the DSI panel is a vc4 atomic commit per frame. Beyond both:
a viewport scroller must not know that one screen in four is virtualised. Writing
`scrollTop` reaches the list anyway — the scroller listens for `scroll` on the
element it was pointed at, so a restore takes the same path a fling does.

**A replaced URL is the same place under a new name.** The filter's per-keystroke
`replaceUrl` navigations are forward navigations, so the router scrolls to the
top a frame after each one — which is what `setQuery` already did itself, hence
no fight. They are also why `AppHistory` counts pushes rather than navigations.

## Library scanning lives in the backend, and its edges come from `refresh()` (2026-09-16)

Settings → Library can now schedule a scan, run one on boot, and run one on
demand. Four decisions that are not obvious.

**The schedule is a 60s tick plus an edge predicate, not an armed `setTimeout`.**
The box has no RTC, so its clock is wrong until NTP lands after network-up, and
`clock-deadlock.md` documents a firmware/clock fault on top of that. An armed
timer pointed at 04:00 is wrong in two directions after a jump: a jump forward
past the target fires a 48-minute scan out of nowhere, and a jump backward misses
the slot entirely. So `scanIsDue(hour, now, lastTick)` recomputes the target from
the wall clock every tick and fires on `lastTick < target <= now`, with a
one-hour lateness window that discards a jump that vaulted the target. DST is
free from using local wall clock: `setHours(h, 0, 0, 0)` on the spring-forward
day rolls a nonexistent 02:00 to 03:00 and fires once, and autumn's repeated hour
does not fire twice because `lastTick < target` is already false the second time
round. There is deliberately **no catch-up**: a box that was off at 04:00 does
not scan at 09:00, which is what the boot toggle is for.

**Not a systemd timer.** The server is already a long-running unit, the schedule
is a setting it already owns, and a timer would put the two in different places
and need a sixth install script. `install/` is untouched by this feature.

**The scan edge is announced from `refresh()`, never from an `onIdle` listener.**
`runIdleLoop` calls `announceIdle()` *before* `await this.refresh()` — deliberately,
so the library index is invalidated before anything reacts to the new snapshot.
That ordering makes `onIdle` useless for watching `updating_db`: a listener there
reads the value parsed by the *previous* refresh, so it sees `null` at the start
of a scan and the stale job id at the end — and the last idle wake of a scan has
no successor, so the scan's completion would never be observed at all. The new
`onUpdating` fires from inside `refresh()`, where the value is actually parsed.
`bridge.live.test.ts` has the regression test; moving the emit back into
`announceIdle` turns it red.

**The edge predicate is `job !== was`, not `job === null`.** MPD listens on 6600
across the LAN, so a phone can start a scan too, and two scans can step straight
from job 3 to job 4 between refreshes. Treating only `→ null` as an ending
silently loses job 3.

**A history row is written when a scan STARTS.** `musicbox-server.path` restarts
the backend on every deploy, and a scan runs for the better part of an hour, so
recording at the end would lose `started_at` for every scan a deploy landed on.
`finished_at` is nullable and gets one UPDATE at the end; it stays NULL for a
scan whose end was never seen, because a duration we did not measure is not one
to invent. `start()` reconciles an open row against MPD's live `updating_db`,
which is what lets a restart mid-scan adopt the scan rather than lose it.

**`interrupted` is detected from MPD's own `uptime`.** Restarting mpd mid-scan
abandons the scan and leaves a partial database — already observed on the device.
`stats` carries `uptime` on the same reply the counters come from, so
`uptime < the duration we timed` means mpd restarted under it. One field, no
extra command, and the UI can stop calling a partial index a success.

**Every scan is gated on the music share being readable, not just the boot one.**
`update` prunes songs it can no longer see, and a `soft` NFS mount returns EIO
part way through a walk. A scan run while the NAS is asleep could empty a 37,289
song tag cache that costs 48m40s to rebuild. The guard is one `stat`.

**That probe is on-demand only and must never be put on a timer.** `/srv/music`
is `x-systemd.automount` with `x-systemd.idle-timeout=600`; polling it would pin
the mount up permanently and defeat the whole lazy-mount design. It can also
block for the 90s mount timeout on a NAS that resolves but does not answer, and
`fs.promises` runs on the same 4-thread libuv pool as `art.ts` and `static.ts`,
so a handful of stuck probes would stall art and static serving. It is raced
against a 4s timeout and single-flighted, and the SSE stream's first frame uses
the *cached* state so an unreachable NAS cannot hold up every client's connection.

**`LibraryState` is its own SSE event, and the job id is not on it.** Same
argument as `build` and `settings`: the snapshot rule is about what the music is
doing. Nothing can act on the job id, because MPD cannot cancel a scan, so it
stops at the backend.

## A cache invalidated mid-build reinstates itself (2026-09-16)

`library.ts` held `cached` and `building`, and `invalidate()` nulled both — but
an in-flight `build()` still ran `cached = artists` in its `.then`, so a scan
finishing during a build left a stale artist list for the rest of the process's
life. The frontend's `LibraryStore` had the identical shape. Harmless while the
only way to scan was an ssh session; this feature makes the collision likely, so
both now carry a generation counter and a build whose generation has moved on
discards its own result. The pattern was already in the tree as
`MusicboxApi.queueRequest`.

## A tag can arrive more than once, and `Genre` usually does (2026-09-16)

`groupBy` folds a reply into a `Map` keyed by tag name, so a repeated key keeps
the last line. MPD sends **one line per value** of a multi-valued tag, and a
census of all 38,978 songs found `Genre` repeated on **91%** of them — a median
of five, up to sixteen. So `Track.genre` had been reporting one arbitrary value
the whole time: "Burn the Witch" is tagged Art Rock, Art Pop, Ambient Pop,
Electronic, Alternative Rock, Chamber Pop, Indie Rock, Rock, Post-Rock,
Indietronica, Krautrock and Orchestral, and the API said `"Orchestral"`.

Latent only because nothing rendered it. It would have shipped as a visible bug
the first time a genre appeared on a screen, and it would have looked like bad
tagging rather than a parser fault.

`groupByMulti` keeps every value; `firstOf` collapses a record **first**-wins,
which is what `firstValue` already did, so the two now agree. `groupBy` is left
alone for `lsinfo` and the queue, which have no repeated keys.

**Genre lives on the album, not the track.** OK Computer's 23 tracks carry an
identical 13 genres — it describes the record, not the song. And the per-track
copy is not free: Pink Floyd's 309 songs carry 4,027 `Genre` lines between them.
It is taken from the first track that has any, the rule `date` already used, and
NOT intersected across tracks — an intersection comes out empty on a compilation
whose tracks genuinely differ.

## The sort tags cannot buy an opinion about sorting (2026-09-16)

The artist list renders in MPD's own `AlbumArtist` order and `library.ts` says
why: "should The Panics be under T" has no answer worth owning, and a sort
opinion is a thing to maintain forever. `ArtistSort`/`AlbumArtistSort`/`AlbumSort`
look like the library answering it for itself, at 100% coverage.

They do not. Measured: **1 of 489** `AlbumArtistSort` values differs from the
plain tag — `Neko Case` → `Case, Neko` — and the only two `AlbumSort`
differences are one album tagged with two capitalisations of its own title. The
tags are populated and carry no information. Do not spend a cycle here.

## Most of the tag vocabulary is empty on this library (2026-09-16)

MPD 0.24 indexes 32 tag types. A census across all 38,978 songs, so that
"we could also expose X" has an answer that is not a guess:

- **Worth having**, and all of it already arriving on `find` replies and being
  discarded: `Genre` 99.9%, `Disc` 100%, `Label` 97.5%, `Format` 100%, `Added`
  100%, and the MusicBrainz ids at ~100% (6 songs of 38,978 carry none).
- **Ruled out**: `Composer` 3.4%, `Work` 1.4%, `Ensemble` 0.7%, `Conductor`
  0.6%, `Performer` 0.3%, and `Movement`, `MovementNumber`, `Grouping`, `Mood`
  and `Name` at **zero**. A composer or work view would be empty for 36 songs in
  every 37.

`Disc` is worth the note: **313 of 2,876 albums span more than one disc**, against
the **149** that keep their tracks in a `CD 01`-style subdirectory. So the tag
sees twice what the directory layout does. It is still NOT what orders an album —
`sortAlbumTracks` sorts by directory then track number, which is right for both
layouts, and sorting on a tag that 164 albums use without a matching layout would
reorder them against their own filenames. `disc` is for display.

The MusicBrainz ids are **supplementary identity, not keys**. Coverage is near
total but uniqueness is not: Queen carries two `MUSICBRAINZ_ALBUMARTISTID`s
against 487 artists carrying one. Safe to store beside a favourite; unsafe to
look an artist up by.

## A multi-disc album needs the Disc tag to SORT, not just to display (2026-09-16)

The album screen numbered its rows `$index + 1`. That is right for the 2,562
single-disc albums here and wrong for the other 313, which each restart at track
1 per disc: Alice in Chains' *Music Bank* ran 1 to 48.

Grouping by `Disc` fixed the numbering and exposed a second fault underneath it.
The backend sorted by directory then track number, and the note in `library.ts`
claimed `Disc` was for display only because "the directory is what the filenames
agree with". That holds for the **149** albums whose discs are separate
directories. For the other **164** every track shares one directory, so the sort
collapses to track number alone and interleaves the discs — disc 1 track 1, disc
2 track 1, disc 3 track 1. The screen rendered sixteen "Disc N" headings for a
three-disc album.

The order is now directory, then disc, then track. Disc as the MIDDLE key is free
where the directories already separate the discs, because `CD 01` holds disc 1 —
the two never disagree.

**Found by screenshotting the panel, not by a test.** Every assertion was green:
the grouping was correct for the data it was given, and the data was in the wrong
order. This is the second time these two screens have been wrong in a way only a
screenshot could show — see the entry above about the full-width hero. Screenshot
them.

**The same tag then paid for per-disc Play and Queue.** MPD takes `Disc` as an
ordinary filter in the legacy form already used everywhere here, so
`findadd albumartist "X" album "Y" disc "2"` is one command and needs no filter
expression and no second escaping layer. Measured: 17 + 17 + 14 against 48 for
the album, correct for both layouts, and a disc that does not exist matches
nothing rather than erroring.

It is an optional `disc` on the existing `AlbumRef`, NOT a third and fourth
route. Two reasons. The verbs did not change — play still replaces, queue still
appends — so a new route would duplicate the 409, the 503 and the validation for
no new meaning. And `routes.test.ts` slices this file's SOURCE TEXT between route
literals, so an inserted route silently changes what an existing test asserts;
the warning above `registerRoutes` says so and this is the first change that had
to obey it. For the same reason `findaddFor` APPENDS to its existing template
string rather than being rewritten as a pairs loop: a test matches that literal
text.

## Genre tags carry other people's mess, and the backend cleans it once (2026-09-16)

Rendering `genres` for the first time turned up two kinds of real-world tag
damage that no amount of correct parsing would have caught:

- **39 values are a `;`-joined run-on inside one tag.** The worst is 146
  characters: `Progressive Rock;Psychedelic Rock;Emo;…`. MPD reports it as one
  genre, because that is what the file says.
- **Three albums carry bare ID3v1 genre indices as text** — `Alternative
  Metal;17;40;79;137;Sludge Metal;…`. "17" is not a genre.

`songFromTags` splits on `;`, trims, and drops empties and all-digit entries. In
the backend rather than the Angular layer so it is done once for every consumer,
and because the contract says `genres: string[]` is the list.

**Only `;`.** One album uses ", " the same way — `Electronic, Rock, Shoegaze,
Experimental, Ambient` — and splitting on a comma would break every genuine genre
name containing one. One album is not worth that.

## A centred line truncates with line-clamp, never with `truncate` (2026-09-16)

The album hero centres its text below 40rem. `truncate` is
`white-space:nowrap` + `overflow:hidden` + `text-overflow:ellipsis`, and a
centred nowrap line that overflows is clipped at BOTH ends with no ellipsis
anywhere — the genre line read "…mental Rock, Rock, Post-Rock…", starting and
ending mid-word. `line-clamp-1` respects `text-align` and puts the ellipsis at
the end. The page reported no horizontal overflow either way, so only the picture
showed it.

## MPD reports no codec, so the encoding is the file extension (2026-09-16)

Asked whether the API could say flac/mp3, and the answer had to be measured
rather than assumed. MPD's song record is `file`, `Last-Modified`, `Added`,
`Format`, the tags, `Time` and `duration` — there is no codec field on `find`, on
`currentsong` or anywhere else. `readcomments` reads the container's own tags and
names no codec either; it also costs 132ms a file and a filesystem hit on a share
that is `noauto` and routinely unmounted, which is the one thing the browse path
is built never to need.

So `Track.encoding` is the file extension, upper-cased, derived from `file` alone
in `trackFromTags` — the same no-I/O deal as `image`, at the same chokepoint.

**It is the container, not the codec.** `.m4a` answers `M4A`, never `AAC`,
because that container holds ALAC just as happily, and this project already
refuses that class of confident guess for Bluetooth covers and artist
directories. Measured, this library has nothing ambiguous: 38,402 FLAC, 556 MP3,
20 APE — exactly 38,978, no `.m4a` or `.ogg` at all.

**Why it earns a field when `Format` already exists.** `Format` is the DECODED
stream, so every one of those 556 MP3s reports `44100:16:2` — indistinguishable
from a CD rip. The badge shipped earlier that day said `16/44.1` for Alice in
Chains' *Greatest Hits* exactly as it did for a lossless FLAC. The two fields
answer different questions and the badge now shows both: `FLAC 24/96`,
`MP3 16/44.1`.

Note also that `bitrate` is on `status`, not on a song: it is playback state,
reads 0 while paused, and says nothing about the library.

## A watcher that is refused must re-arm itself (2026-09-17)

Panel sleep sometimes never fired: after a reboot with nobody touching the
panel, or after playback was started from a phone. One cause, in
`idle-timer.ts`.

`Watcher.fire()` nulls its timer and calls `onIdle()`. `onActivity()` re-arms
only when the timer is null, and it is reached only from a real DOM event or
`poke()`. So when `PanelSleep.sleep()` declined — because something was playing,
or because the POST came back refused — **the watcher was left disarmed for the
rest of the uptime**, and only a finger on the glass ever started it again.

The common path was invisible precisely because it looked like the design: the
idle clock counts touches only, so a record playing does not hold the timer off.
The deadline therefore lands in the middle of most albums, is declined once, and
that is the end of panel sleep until somebody touches the panel. "No touches
since boot" is not a second bug, it is the condition under which nothing
recovers it.

**`restart()`, not `poke()`.** `poke()` moves the shared timestamp, which would
drag `IdleWatch`'s now-playing watcher along every time an album ended — the
music stopping is not somebody standing at the box. `restart()` arms one watcher
a whole delay from now and leaves the shared clock alone.

**And not a re-arm against the shared clock either.** On the refusal path
`idleFor()` is already past the deadline, so `due <= 0`: the retry would fire at
once, be refused at once, and spin. That asymmetry is the whole reason `arm()`
takes `fromNow`.

**A record ending restarts the full delay** rather than darkening the screen the
instant the last track stops. The earlier comment promised the opposite, and it
was never true in practice; of the two, this one does not black out the panel in
front of whoever just put the record on.

**503 is permanent, 409 is not.** A refused sleep is retried a delay later,
except `503` — that is a box with no backlight at all, and asking again every
minute forever would flicker the sleep overlay for nothing. `409 no panel client
is connected` is the panel's own stream between connections and always worth
another go. Telling them apart is why `ApiClient` throws `ApiError` with the
status rather than a bare `Error`.

## The kiosk waits for the server to listen (2026-09-17)

`musicbox-kiosk.service` is ordered `After=musicbox-server.service`, but the
server is `Type=simple` — systemd calls it started the moment it is exec'd, not
when it binds. Measured on the box: exec'd at 6.87s, listening at 10.98s,
chromium launched at 11.73s. Three quarters of a second of margin, and nothing
holding it there.

Chromium never retries a refused connection, so losing that race leaves an error
page up until someone reboots — and with no app there is no timer, which is the
other half of "panel sleep doesn't work after a reboot".

The wrapper now probes the URL's host and port with bash's `/dev/tcp` until
`KIOSK_WAIT_SECONDS` (default 30) runs out, then launches regardless. Bash
rather than `curl` because `install.sh` does not install curl. Launching anyway
is deliberate and matches the unit's existing `Wants=` rather than `Requires=`:
a broken server should show as a broken page, not as a black panel.
