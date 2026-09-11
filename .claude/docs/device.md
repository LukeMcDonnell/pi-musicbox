# The device

Everything here was verified on the real hardware, not assumed. Dates are when
the measurement was taken.

## Hardware

| | |
|---|---|
| Board | Raspberry Pi 4B Rev 1.1 |
| OS | Raspberry Pi OS **Lite**, Trixie (Debian 13), kernel 6.18.34+rpt-rpi-v8 |
| Audio | HiFiBerry DAC+ **Standard** (I2S HAT) — not the Pro |
| Display | DFRobot DFR0550, 5" 800×480 DSI capacitive touchscreen |
| Library | Synology NAS, `synonas.local` |
| Access | `musicbox@musicbox.local` over SSH (password not recorded here) |

The DAC+ has **no programmed HAT ID EEPROM**, so `/proc/device-tree/hat/` is
always empty and the card is never auto-detected. That is normal for HiFiBerry
and is why the overlay must be pinned explicitly. It also means an empty
`/proc/device-tree/hat/` is *not* a useful health check — use
`aplay -l | grep hifiberry` instead.

After `setup-hardware.sh`, `snd_rpi_hifiberry_dacplus` is **card 0** and the
onboard `bcm2835 Headphones` and `vc4hdmi0/1` cards are gone. Any MPD config
assuming card 0 = Headphones is wrong.

## Boot time (2026-09-11)

| Stage | Kernel | Userspace | Total |
|---|---|---|---|
| Stock image | 2.353s | 12.982s | **15.336s** |
| After `setup.sh` | 2.114s | 12.460s | **14.575s** |
| After the network rework | 2.345s | 6.396s | **8.742s** |

**15.34s → 8.74s, 43%.** Be honest about where it came from: `setup.sh` alone
bought 0.76s. Almost all of it was `migrate-network.sh`. The EEPROM change took
roughly another 0.75s off the pre-kernel stage, which `systemd-analyze` cannot
see.

### The pre-kernel stage

`systemd-analyze` reports kernel + userspace only. `sudo vclog --msg` exposes
the firmware stage underneath (timestamps are **ms since power-on**), and on
this board it dwarfs both:

```
~11.2s firmware  +  2.3s kernel  +  6.4s userspace  ≈ 20s wall clock
```

which matches observed reboot-to-SSH times. `setup.sh` Phase 0 records these and
`musicbox-bootreport` shows them before/after, so firmware-stage changes can be
judged at all. There is still an **unexplained 1543ms gap** in the firmware log
that nothing has accounted for — see `decisions.md`.

## Touch: firmware path, not the i2c driver

The panel's touch controller exposes **no interrupt line** (`interrupts`,
`interrupt-parent` and `poll-interval` all absent from its DT node), so the
kernel's `edt-ft5x06` driver falls back to blind polling and never identifies
the chip (`fw_version` reads `ff 0a`; it reports "generic ft5x06" despite the DT
claiming `edt,edt-ft5506`) — it is guessing the register layout too.

Captured from `/dev/input/event0`, upstream of compositor and browser:

| | i2c (`edt-ft5x06`) | firmware (`rpi-ft5406`) |
|---|---|---|
| contacts | 535 in 67s | **29 in 42s** |
| phantom contacts | most | **0** |
| negative coordinates | many (−3052, −3577) | **0** |
| X / Y range | −3052..799 / −3577..458 | **12..791 / 10..458** |

So touch goes through the GPU firmware — the path the official Pi panel has
always used. The input device becomes `raspberrypi-ts`, the i2c client
disappears entirely, and the two cannot compete. ~24Hz during a drag.

> **The two backends have opposite `disable_touchscreen` requirements.** With
> the i2c driver, `disable_touchscreen=1` is mandatory or the firmware polls the
> same controller and steals its reports (an ft5x06 clears its report register
> on read — whoever reads first wins). With the firmware driver
> `disable_touchscreen` must **not** be set, because firmware polling is exactly
> what you want. Getting this backwards is what "finicky, glitchy, wrong
> coordinates" looks like.

## The NAS mount (2026-09-12)

NFS was chosen. Synology needed an NFS rule added on the shared folder — before
that, `showmount -e synonas.local` returned an empty export list, which
`nfs_diagnose()` now distinguishes from "exports exist but not for your IP".
NFS `AUTH_SYS` is host-based and UID-mapped: there are no passwords, so
permission errors are a server-side rule, not a credential problem.

```
synonas.local:/volume1/Music  /srv/music  nfs  ro,soft,timeo=50,retrans=3,noauto,x-systemd.automount,x-systemd.idle-timeout=600,_netdev,nofail  0 0
```

Verified: 6 fields, mounted `nfs4` vers=4.1 read-only, `touch` fails with
"Read-only file system", and `umount` followed by `ls` remounts on access.

> **The library is at `/srv/music/Music`, not `/srv/music`.** The export root
> also contains `#recycle`, and Synology scatters `@eaDir` thumbnail folders
> through the tree. MPD's `music_directory` must be the nested path or the scan
> picks up thousands of junk files. 488 artist directories as of 2026-09-12.

## Verifying a device after a run

```sh
musicbox-bootreport                 # before/after boot timings, incl. firmware
sudo vclog --msg | head             # pre-kernel stage
nmcli general status                # network
getent hosts musicbox.local         # mDNS, from another machine
aplay -l | grep hifiberry           # DAC is card 0
findmnt /srv/music                  # share present, ro, sane version
systemctl list-units '*.automount'  # the unit exists AND is active
lsblk                               # USB CD drive
```

The `.automount` check matters: `ls` on an unmounted empty mountpoint succeeds
and looks exactly like a working mount.
