# Status and roadmap

Last updated 2026-09-14.

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
- A **Bluetooth A2DP sink** at aptX HD: a phone pairs with no prompt and plays
  through the DAC, MPD pauses and releases the card. The now-playing screen and
  the transport buttons follow whichever source is active, over AVRCP, and a
  Disconnect button hands the speaker back. The handoff is owned by a root arbiter
  rather than the backend, so it survives the web server being redeployed. See
  `bluetooth.md`.

## Open issue: the box drops off the network under load

Unresolved. Streaming for tens of minutes over wifi and the Pi disappears from
the network while continuing to run locally — the kiosk keeps working, MPD starts
erroring on the NAS. Power save has been disabled and it has since run 47+
minutes clean, but that is not proof. Diagnostic instrumentation is installed on
the device.

**`.claude/docs/wifi-instability.md` has the full picture, the dead ends worth not
repeating, and how to remove the instrumentation.**

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
   ~31,000px tall with no virtualisation.

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
library list at the same time. Virtualising the artist list is the other half.
Confirm which of the two actually causes the crash before fixing both — the panel
is the only place that can answer it, and `--disable-gpu-rasterization` via
`CHROMIUM_EXTRA_FLAGS` in `/etc/musicbox/kiosk.conf` is the cheapest way to ask.

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


## Offered, not actioned

- Mask `rpcbind` / `rpc-statd-notify` / `nfs-blkmap` (~666ms). Only if SMB is
  chosen — NFS needs them.
- **`tests/run-all.sh` does not run the frontend specs.** Its only Node step is
  the backend's `node:test`; the 36 Karma/Jasmine specs under `src/frontend` have
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
- **Shutdown stalls ~90s when MPD is playing.** `/srv/music` cannot be unmounted
  while MPD holds it, so a graceful reboot spends the full stop timeout waiting.
  Observed 2026-09-13:

  ```
  12:41:54  netwatch: mpd=[[playing] #59/130 1:42/5:19]
  12:41:59  Unmounting srv-music.mount...
  12:41:59  umount.nfs4: /srv/music: device is busy
  12:41:59  srv-music.mount: Mount process exited, code=exited, status=16
  12:41:59  Failed unmounting srv-music.mount - /srv/music
  12:43:29  srv-music.mount: Deactivated successfully      <- 90s later
  ```

  Not a data risk: the share is mounted `ro` and the unmount does eventually
  succeed. Not new either, though the journal cannot prove that — only five boots
  are recorded and the earlier ones were a hard power cycle (the clock deadlock)
  or seconds long, so this was the first graceful shutdown with the share actually
  in use. Nothing in the Bluetooth work touches `/srv/music`.

  The fix is a shutdown-ordering dependency so `mpd.service` stops before
  `srv-music.mount` — systemd has no idea MPD depends on it, because the mount is
  `noauto,x-systemd.automount` and MPD merely triggers it by access. A drop-in
  with `After=srv-music.mount` on `mpd.service` would do it (systemd reverses
  ordering on shutdown), but **it touches the boot contract**: non-negotiable #1
  in `CLAUDE.md` exists because anything that makes boot wait on the network hangs
  the box when the NAS is off. `After=` on an automount unit should be safe —
  the automount unit, not the mount, is what is active at boot — but that needs
  proving with the NAS powered down, not reasoning. Own change, own tests.
- Investigate the unexplained 1543ms firmware gap.
- Reclaim the ~4s the kiosk currently waits on NetworkManager.
- Read-only root via `raspi-config nonint enable_overlayfs` (planned from the
  start: "volatile logs now, overlayfs later").
