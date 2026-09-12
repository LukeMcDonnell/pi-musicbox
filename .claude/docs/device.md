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

## MPD (2026-09-12)

| | |
|---|---|
| Version on Trixie | `mpd` 0.24.4-1, `mpc` 0.35-1+b2 |
| Package cost | **118 new packages** with `--no-install-recommends` — all hard Depends |
| ALSA | `card 0: sndrpihifiberry [snd_rpi_hifiberry_dacplus]`, device 0 |
| Mixer control | **`Digital`** (also `Analogue`; there is no `PCM`) |
| Library size | 489 directories, **49,711 files** under `/srv/music/Music` |
| Actual disk cost | 4.8G → **5.1G** used; 23G still free |
| New enabled units | **none** — still 34. No PipeWire/JACK/Pulse/fluidsynth daemon appears |
| Post-install state | `mpd.service` and `mpd.socket` install **disabled and inactive**; `setup-mpd.sh` enables the service |

Config is at `/etc/musicbox/mpd.conf`, with `/etc/default/mpd` carrying a
managed block that sets `MPDCONF`. `/etc/mpd.conf` is left as the package
shipped it — `dpkg --verify mpd` confirms it unmodified. See `architecture.md`
for why.

`mpd.socket` listens on `%t/mpd/socket` **and** port 6600 on all interfaces, so
phone clients reach it over the LAN and no `bind_to_address` is needed.

**MPD reads `music_directory` at startup and triggers the automount** — observed,
not assumed. So the mount does happen at boot.

### Boot cost, measured (2026-09-12)

```
before MPD:  2.069s kernel +  7.279s userspace =  9.348s
with MPD:    2.332s kernel + 15.564s userspace = 17.896s
```

`mpd.service` is on the critical path and takes **5.960s**:

```
multi-user.target @15.563s
└─mpd.service @9.601s +5.960s
  └─network.target @9.597s
```

Decomposed from the journal, the NFS mount is **not** the cost:

| | |
|---|---|
| 11.934s | `mpd.service` starts |
| 16.366s | first mpd log line — **4.43s** of silent startup |
| 16.381s | automount triggered by mpd |
| 16.925s | mount complete — the NFS mount costs only **0.54s** |
| 17.895s | ready |

The 4.43s is MPD loading a 3.4M `tag_cache` of 37,289 songs plus initialising
the decoder plugins those 118 packages brought. `After=network.target` defers
the start to 9.6s on top of that. A warm restart is only ~2s — the cold figure
is page-cache-empty.

**This 6s is accepted deliberately.** Socket activation would give the boot time
back (mpd starts on first connection instead), and is a one-command change if it
is ever wanted:
`systemctl disable mpd.service` — keep `mpd.socket` enabled.

### Boot with the NAS unreachable (2026-09-12)

The test the automount design exists for. NAS powered off, cold boot:

```
NAS up:   2.332s kernel + 15.564s userspace = 17.896s
NAS off:  2.383s kernel + 16.586s userspace = 18.969s   (+1.07s)
```

**Nothing hung.** From the journal:

| | |
|---|---|
| 13.029s | mpd triggers the automount |
| 18.076s | `mount.nfs: Failed to resolve server synonas.local` |
| 18.079s | mount unit fails — `nofail` means boot carries on |
| 18.083s | mpd logs `Failed to access /srv/music/Music: No such device` and **keeps running** |

MPD stayed active with its database intact (37,289 songs, loaded from the local
`tag_cache`). The automount stayed **armed**: each later access retries in ~5s
and fails cleanly rather than wedging, so the share simply starts working again
when the NAS comes back. `srv-music.mount` sits in `failed` state until then,
which is cosmetic.

**Caveat — this tested the name-resolution path.** `synonas.local` is mDNS, so
with the NAS off the name does not resolve and the mount gives up in 5.05s. A
NAS that resolves but does not answer (a static DNS or `/etc/hosts` entry, or
the host up with NFS stopped) would get as far as TCP, where
`x-systemd.mount-timeout` defaults to **90s**. That case is still untested. If it
ever bites, the fix is `x-systemd.mount-timeout=10` in `setup-nas.sh`'s
`LAZY_OPTS`.

### The initial scan

`time mpc update --wait` over NFS: **48m40s** for 49,711 files → 37,289 songs,
535 artists, 2,731 albums, 3.4M `tag_cache`. One-time; it survives reboots
because `/var/lib` is not volatile.

### mDNS does not work, and that is deliberate

MPD logs `zeroconf: No global port, disabling zeroconf`. Under socket activation
MPD never creates a listener of its own, so it has no port to advertise. Setting
`port` alone does not help — measured. Making it work means taking the listeners
back from systemd (`bind_to_address "any"`, `systemctl disable mpd.socket`, and a
`RuntimeDirectory=mpd` drop-in so `/run/mpd/socket` still exists), which trades a
supported default for a nice-to-have.

MPD is still reachable on 6600 across the LAN — verified over both IPv4 and IPv6,
loopback and remote.

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
systemctl is-active mpd             # player running
mpc status && mpc stats             # and it can see the library
```

The `.automount` check matters: `ls` on an unmounted empty mountpoint succeeds
and looks exactly like a working mount.
