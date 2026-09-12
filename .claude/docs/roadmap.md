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
2. **Bluetooth audio** — bluez + a BlueALSA or PipeWire sink. Note chromium runs
   with `--mute-audio` precisely because MPD is meant to own the DAC
   exclusively; adding a second audio consumer means a shared layer, not just
   dropping the flag.
3. **USB CD** — playback and ripping (`cdparanoia` / `libcdio-utils`).


## Offered, not actioned

- Mask `rpcbind` / `rpc-statd-notify` / `nfs-blkmap` (~666ms). Only if SMB is
  chosen — NFS needs them.
- A `tools/sync.sh` to stop the device drifting from the repo.
- Investigate the unexplained 1543ms firmware gap.
- Reclaim the ~4s the kiosk currently waits on NetworkManager.
- Read-only root via `raspi-config nonint enable_overlayfs` (planned from the
  start: "volatile logs now, overlayfs later").
