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
