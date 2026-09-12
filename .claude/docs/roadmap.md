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
- MPD playing that library through the DAC — 37,289 songs indexed, resident from
  boot at a deliberate cost of ~6s (9.348s → 17.896s; see `device.md`)

## Next

1. **Bluetooth audio** — bluez + a BlueALSA or PipeWire sink. Note chromium runs
   with `--mute-audio` precisely because MPD is meant to own the DAC
   exclusively; adding a second audio consumer means a shared layer, not just
   dropping the flag.
2. **USB CD** — playback and ripping (`cdparanoia` / `libcdio-utils`).
3. **Web UI**, then point the kiosk at it:
   `sed -i 's|^KIOSK_URL=.*|...|' /etc/musicbox/kiosk.conf && systemctl restart musicbox-kiosk`.
   `frontend/` is an empty placeholder.

## Offered, not actioned

- Mask `rpcbind` / `rpc-statd-notify` / `nfs-blkmap` (~666ms). Only if SMB is
  chosen — NFS needs them.
- A `tools/sync.sh` to stop the device drifting from the repo.
- Investigate the unexplained 1543ms firmware gap.
- Reclaim the ~4s the kiosk currently waits on NetworkManager.
- Read-only root via `raspi-config nonint enable_overlayfs` (planned from the
  start: "volatile logs now, overlayfs later").
