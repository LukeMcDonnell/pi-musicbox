# Status and roadmap

Last updated 2026-09-12.

## Working on the device

- OS cleanup and boot tuning — boot 15.34s → 8.74s
- netplan → NetworkManager keyfile migration (where the saving actually came from)
- HiFiBerry DAC+ Standard, card 0, onboard and HDMI audio gone
- DSI panel at 800×480, touch via the firmware path and accurate to the corners
- cage + chromium fullscreen on the panel from boot, showing the holding page
- NFS mount of the Synology library at `/srv/music`, read-only, lazily automounted

## Next

1. **MPD.** Packages into `install.sh` (`mpd`, `mpc`), then config. Two things
   to get right: `music_directory` is **`/srv/music/Music`**, not `/srv/music`
   (see `device.md`), and MPD must tolerate the library being absent at start
   and pick it up on first access — it must not be the thing that reintroduces a
   boot dependency on the NAS.
2. **Bluetooth audio** — bluez + a BlueALSA or PipeWire sink. Note chromium runs
   with `--mute-audio` precisely because MPD is meant to own the DAC
   exclusively; adding a second audio consumer means a shared layer, not just
   dropping the flag.
3. **USB CD** — playback and ripping (`cdparanoia` / `libcdio-utils`).
4. **Web UI**, then point the kiosk at it:
   `sed -i 's|^KIOSK_URL=.*|...|' /etc/musicbox/kiosk.conf && systemctl restart musicbox-kiosk`.
   `frontend/` is an empty placeholder.

## Owed: the regression test that has never been run

**Reboot with the NAS unreachable** and confirm boot time is unchanged and
nothing waits. This is the entire reason for the `noauto,x-systemd.automount`
design and it has been asserted in tests but never demonstrated on hardware. It
became possible only once the mount existed, which it now does. Do this before
MPD goes in — MPD is the first thing that will hold the mount open.

## Offered, not actioned

- Mask `rpcbind` / `rpc-statd-notify` / `nfs-blkmap` (~666ms). Only if SMB is
  chosen — NFS needs them.
- A `tools/sync.sh` to stop the device drifting from the repo.
- Investigate the unexplained 1543ms firmware gap.
- Reclaim the ~4s the kiosk currently waits on NetworkManager.
- Read-only root via `raspi-config nonint enable_overlayfs` (planned from the
  start: "volatile logs now, overlayfs later").
