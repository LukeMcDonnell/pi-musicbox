# Status and roadmap

Last updated 2026-09-16.

## Working on the device

- OS cleanup and boot tuning — boot 15.34s → 8.74s
- netplan → NetworkManager keyfile migration (where the saving actually came from)
- HiFiBerry DAC+ Standard, card 0, onboard and HDMI audio gone
- DSI panel at 800×480, touch via the firmware path and accurate to the corners
- cage + chromium fullscreen on the panel from boot, showing the holding page
- NFS mount of the Synology library at `/srv/music`, read-only, lazily automounted
- **Verified**: a cold boot with the NAS powered off costs only +1.07s, nothing
  hangs, MPD starts and keeps running, and the automount stays armed so the
  share recovers by itself. The one untested sub-case is a NAS that resolves but
  does not answer — see `device.md`.
- Web server and API: Angular on the panel and phones, Fastify bridging MPD over
  SSE. Added **0s** to boot (17.786s vs 17.896s) because it starts from
  `basic.target` in parallel with MPD rather than behind it.
- A dev loop that is **2.5s** backend-only, **4.3s** for both halves, with no sudo.
- MPD playing that library through the DAC — 37,289 songs indexed, resident from
  boot at a deliberate cost of ~6s (9.348s → 17.896s; see `device.md`)
- **Library scanning from the screen.** Settings → Library: a daily scan at a
  chosen hour, an optional scan after boot, Scan now and Full rescan, plus what
  the library holds and when it was last scanned. `auto_update` stays off — see
  `decisions.md` for why the schedule is a tick rather than an armed timer, and
  why the scan edge is read from `refresh()`. Scan history is schema v2.
- A **Bluetooth A2DP sink** at aptX HD: a phone pairs with no prompt and plays
  through the DAC, MPD pauses and releases the card. The now-playing screen and
  the transport buttons follow whichever source is active, over AVRCP, and a
  Disconnect button hands the speaker back. The handoff is owned by a root arbiter
  rather than the backend, so it survives the web server being redeployed. See
  `bluetooth.md`.

## Closed: the box drops off the network under load

**Cause: the `ondemand` cpufreq governor.** 16,604 netwatch samples over 16 boots
since the fix, **zero** genuine dropouts — the only "down" samples are each
boot's first, taken before wlan0 associates. Against 38 drops in 53 minutes
before the fix. The mitigation lives in `setup-hardware.sh` and stays; it is a
fix, not instrumentation.

**Still to do: take the instrumentation off the device.** `netwatch` and the
persistent journal are still installed and are the leading suspect for the
boot-time variance (`decisions.md`, 2026-09-14). One command, on the device:

```sh
sudo ./tools/uninstrument-wifi-debug.sh     # keeps /var/log/journal
```

Then drop the "temporary diagnostic instrumentation" section from `CLAUDE.md`
and the "What is installed on the device" section from `wifi-instability.md`.

**`.claude/docs/wifi-instability.md` has the full picture and the dead ends worth
not repeating.**

## Open issue: the panel's renderer crashes — blur + the library's artist images

Unresolved, and **purely frontend** — nothing in the install scripts, the backend
or the deploy is involved. Chromium on the panel gets as far as "this page has
crashed"; the reload button brings it back. Before it dies the screen is almost
entirely white with a scrollbar and only the track-time indicator still drawn:
the near-white text (`--color-text: #f4f1ee`) is invisible against a layer that
failed to rasterise, while the accent progress bar — its own fixed compositing
layer — keeps painting.

Two costs arrived together and both are suspects; neither has been isolated yet.

1. **`blur(172px)` on a full-viewport layer, twice, always mounted.** The
   `art-backdrop` utility in `styles.scss`, new in `9321afc "tweak app design"`.
   Now-playing (`absolute inset-0`) and the mini bar (`h-dvh`) both carry it, and
   now-playing is never unmounted — it is a sheet translated off screen, not a
   route — so both layers are live at all times. A 172px sigma over the whole
   viewport is an enormous ask of the VideoCore GPU under ANGLE/GLES
   (`--use-angle=gles --enable-gpu-rasterization`).
2. **The library screen renders 487 artists, each `/api/art` image a full
   1000×1000 JPEG (~250KB) displayed at 48×48.** `loading="lazy"` limits what is
   fetched at once, but scrolling still walks the whole list, and the page is
   ~31,000px tall.

   **Half addressed since.** The artist list is virtualised — ~18 rows in the DOM
   instead of 487 (`@iharbeck/ngx-virtual-scroller`, `parentScroll`-ed onto
   `<main>`; see the `library.ts` header). That cut the row count and the NUMBER
   of decodes. It did not make the page shorter, it did not make one decode
   cheaper, and it added churn: a row leaving the window is destroyed, so
   scrolling back up decodes its picture again — the response is cached, the
   bitmap is not. **Whether this helped the crash at all is unmeasured**, and it
   was landed for the DOM cost rather than as a fix for this.

**What was already ruled out** — do not spend another cycle on these:

- Deploy drift. `frontend/` and `backend/server.js` on the device were byte-for-byte
  identical to the local build (md5 each file, not just the one edited).
- Asset serving. `index.html`, `main-*.js` and `styles-*.css` all 200 with correct
  MIME types; CSS variables resolve on the device.
- Browser age. The panel runs Chromium 152 — newer than the dev machine's 151.
  Tailwind v4 and `@layer` are fine.
- A boot race. musicbox-server was listening at 10:53:55, the kiosk started at
  10:53:56.
- Resource starvation. CmaFree 505MB/524MB, 2.2GB RAM free, `get_throttled=0x0`,
  73.5°C. No OOM kill, no crashpad dump.

The page renders correctly at 800×480 on the dev machine, which is why this was
not caught: headless Chrome uses `--disable-gpu`, i.e. software rasterisation —
the one path that never exercises the fault.

**Direction, not yet a decision.** Blur cost scales with the source resolution, so
blurring a 1000×1000 JPEG at sigma 172 is paying twice over; a small downscaled
source with a proportionally smaller sigma should look near-identical for almost
nothing. `/api/art` serving a thumbnail size would fix the backdrop and the
library list at the same time, and it is now the OUTSTANDING half — the other,
virtualising the artist list, has landed. It is also the half that matters for
cost-per-decode, which virtualisation did nothing about.

Still confirm which of the two actually causes the crash before fixing both — the
panel is the only place that can answer it, and `--disable-gpu-rasterization` via
`CHROMIUM_EXTRA_FLAGS` in `/etc/musicbox/kiosk.conf` is the cheapest way to ask.
Virtualisation is not that answer: it was never measured against the fault.

## Landed: a database, and the panel turns itself off (2026-09-15)

The box now has SQLite (`node:sqlite`, so no dependency and nothing to ship) at
`/var/lib/musicbox/data/musicbox.db`, with append-only migrations keyed on
`PRAGMA user_version`. Schema v1 is one `settings` table. **Favourites and recent
plays are what it was stood up for** — they arrive as `MIGRATIONS[1]`, `[2]`, and
`src/backend/src/db.ts` is the only file that imports the engine.

Getting it needed node 24 on the device, which is now NodeSource rather than
Debian — see `decisions.md` for what that costs.

Its first user is Settings -> System -> "Turn the panel off after idle": the
panel's backlight goes off after N idle minutes with nothing playing, and comes
back on a touch or when the music starts. The backlight, deliberately, and never
DPMS — `clock-deadlock.md` is the reason and `decisions.md` has the argument.

**One thing unverified on hardware: that touch still registers while the
backlight is off.** The digitizer is a separate device so it should, and a dead
panel stream restores the backlight anyway, but nobody has put a finger on a dark
screen yet. Worth thirty seconds next time you are at the box.

## Landed: Recently Added (2026-09-18)

The Home shelf and `/home/recently-added`: the 100 newest albums, newest first,
from `GET /api/library/recent`. Grouped out of a window of songs sorted by MPD's
`Added` tag — `decisions.md` has the measurements and why the rows carry no track
count. Recent Plays followed; see below.

## Landed: favourite albums (2026-09-17)

Stars on the album screen and the artist screen's album rows (not on phones); a
Favourites tab with a filter, Play/Queue and a per-device sort. Stored in schema v3's
`favourite_album` table rather than MPD stickers — `decisions.md` has the measurement.
Not yet checked on the panel itself.

## Next

1. **Library search.** Browse landed: artists -> albums -> tracks, with Play and
   Queue on the album screen (`POST /api/library/{play,queue}`). Artist pictures
   come from the existing `/api/art` keyed by the artist directory — 97% coverage,
   no new code. See the "Browsing the library" section of `README.md` for the
   measurements that shaped it, and `decisions.md` for what they ruled out.
   Search is the remaining half and the API is shaped for it.
2. **USB CD** — playback and ripping (`cdparanoia` / `libcdio-utils`). Note the
   DAC exclusion that Bluetooth ran into applies again: whatever plays a CD has
   to go through the same arbiter, not open `hw:0,0` for itself.
3. **Repeat and shuffle control, for both sources at once.** They are now
   *reflected* in the snapshot — AVRCP's `Repeat`/`Shuffle` for a phone, MPD's own
   flags otherwise — but nothing can change them: there has never been an API for
   it. AVRCP's are writable and MPD's obviously are, so do both together rather
   than adding a Bluetooth-only control and a second inconsistency.
4. **A UI-gated Bluetooth pairing window** — the box is currently discoverable to
   anyone in radio range. Designed for, deliberately deferred; see
   `bluetooth.md`.
5. **Chase the flaky Bluetooth watcher test**, which is why `run-all.sh` goes red
   on a clean tree about one run in five. Rates, the failing assertion and the
   one clue worth following are in `testing.md`. It may be the test and it may be
   the re-arm — the watcher is the thing that already failed silently on the
   device once, so it is worth knowing which.


## Offered, not actioned

- Mask `rpcbind` / `rpc-statd-notify` / `nfs-blkmap` (~666ms). Only if SMB is
  chosen — NFS needs them.
- **`tests/run-all.sh` does not run the frontend specs.** Its only Node step is
  the backend's `node:test`; the 121 Karma/Jasmine specs under `src/frontend` have
  to be run by hand:

  ```sh
  cd src/frontend && npx ng test --watch=false --browsers=ChromeHeadless
  ```

  So "tests must stay green before anything is called done" currently depends on
  remembering a second command that nothing prints. It is the only suite in the
  repo not reachable from one entry point, and it grew from 12 specs to 36 with
  library browse, so there is now real coverage riding on it.

  Not wired in yet because it is not free: `ng test` needs a browser, which is
  why the step has to degrade the way the shellcheck step already does — run it
  if a Chrome is present, `SKIP:` otherwise, never fail the suite on a machine
  without one. It also costs ~15s against the backend suite's 6s. Worth doing;
  just its own change, with the skip path actually tested on a box with no
  browser.

- A `tools/sync.sh` to stop the device drifting from the repo. **Now with a
  demonstrated failure mode**: on 2026-09-14 a hand-rolled
  `rsync -a --delete install/ tests/ musicbox@...:musicbox/` — two sources, one
  destination — deleted `backend/`, `frontend/`, `tools/` and the docs off the
  device and took the server down. Recovered from the repo in a couple of
  minutes, since the device only ever holds copies, and verified by `md5sum`.
  A checked-in script that always names one source and one destination, and
  verifies afterwards, removes the whole class.
- **The NAS-off boot proof for the `mpd.service` drop-in is still outstanding.**
  `setup-mpd.sh` now writes `/etc/systemd/system/mpd.service.d/10-musicbox-nas.conf`
  with `After=srv-music.mount`, so MPD stops before the share is unmounted. It
  shipped on reasoning, not measurement: `After=` is ordering only, adds no
  requirement, and the `.mount` has `noauto` so it gets no boot job — but
  non-negotiable #1 deserves the real test. Reboot once with the NAS powered
  down and check boot time and `systemd-analyze critical-chain mpd.service`.

  If it ever does hang boot, the rollback is one file:
  `rm /etc/systemd/system/mpd.service.d/10-musicbox-nas.conf && systemctl daemon-reload`.
- Investigate the unexplained 1543ms firmware gap.
- Reclaim the ~4s the kiosk currently waits on NetworkManager.
- Read-only root via `raspi-config nonint enable_overlayfs` (planned from the
  start: "volatile logs now, overlayfs later").

## Landed: Most Played Artists (2026-09-18)

`GET /api/plays/artists`, the Home shelf that now sits second, and
`/home/most-played-artists`. This is the half of `track_play` the entry below
promised: a `GROUP BY album_artist` with `SUM(play_count)`, no migration, and no
new index — `track_play_album` already leads on `album_artist`.

Three things worth knowing before editing it, all in `decisions.md`: the artist's
picture is derived from the stored file path rather than joined against MPD's
artist index; `file` is a bare column beside `MAX(last_played)` while the ranking
is the `SUM`; and there is deliberately no SSE event, because an all-time count
does not reorder on one play. `PlaysStore` drops its cached list when a `plays`
frame lands, which is the cheap version of the same liveness.

The rail carrying round cards is what `shelf.ts` was written content-agnostic
for, and `ShelfSkeleton` grew a `[round]` to match.

**Follow-up: the Library's artist row is still inline markup.** It is the same
row as `components/artist-row/`, and moving it over is the obvious tidy — left
alone here because that screen carries the open renderer-crash issue above, and
destabilising it to save fifteen lines of markup is a bad trade.

Not yet checked on the panel itself.

## Landed: Recent Plays (2026-09-18)

`GET /api/plays/recent`, a `plays` SSE event, the Home shelf that now leads the
screen, and `/home/recent-plays`. Schema v4's `track_play` is the first half of
what the database was stood up for that had not been built: one row per song ever
played, with a count and the last time, so most-played track/album/artist is a
query away. What decides that a track played is `play-watch.ts` — thirty seconds
of playing, accrued from the wall clock between snapshots, MPD only. See
`decisions.md` for why that needs no timer and no change to the bridge.

Verified against the live box: a track played out naturally, one row was written
with the right tags and art, and the `plays` frame arrived on the stream. The
negative cases — a skip, a pause, a phone taking over, repeat-one — are covered by
`play-watch.test.ts` rather than on the device, which would have meant skipping
through someone's music.
