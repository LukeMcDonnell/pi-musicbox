# Status and roadmap

Last updated 2026-09-12.

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

## Next

1. **Flesh out the UI** — the skeleton is now-playing plus transport and volume.
   Queue, library browse and search are next, and the API is shaped for them.
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
- A `tools/sync.sh` to stop the device drifting from the repo.
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
