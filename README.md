# musicbox

A Raspberry Pi music player appliance.

| | |
|---|---|
| Board | Raspberry Pi 4B |
| OS | Raspberry Pi OS **Lite**, Trixie (Debian 13, kernel 6.12) |
| Audio | HiFiBerry DAC+ **Standard** (I2S HAT) |
| Display | DFRobot DFR0550 — 5" 800×480 DSI capacitive touchscreen |
| Library | NFS/SMB network share |
| Planned | MPD · Bluetooth audio · USB CD audio · web UI on `<hostname>.local` |

## Run order

```sh
sudo ./install/setup.sh --dry-run       # 1. review what it would do
sudo ./install/setup.sh                 # 2. OS cleanup + boot tuning
sudo reboot                             # 3.
musicbox-bootreport                     # 4. before/after boot timings
sudo ./install/setup-hardware.sh        # 5. DAC+, DSI panel, HDMI
sudo reboot                             # 6.
sudo ./install/install.sh               # 7. not implemented yet
```

The three scripts split by concern, and each owns its own managed block in
`config.txt` so they never collide:

| Script | Owns |
|---|---|
| `setup.sh` | OS cleanup and boot tuning — **no hardware** |
| `setup-hardware.sh` | HiFiBerry DAC+, DSI panel, HDMI suppression |
| `install.sh` | MPD, Bluetooth, USB CD, web UI (still a stub) |

Optionally, for an image provisioned by Raspberry Pi Imager (see below):

```sh
sudo ./install/migrate-network.sh --dry-run
sudo ./install/migrate-network.sh   # arms a revert watchdog
sudo reboot
sudo ./install/migrate-network.sh --finish   # or --revert
```

`setup.sh` runs on a freshly-flashed image and does two things: removes packages
and services this box will never use, and cuts boot time. It configures **no
hardware** — the DAC overlay, DSI panel and hostname all belong to `install.sh`.

It is safe to re-run; a second run reports no changes.

### Options

| Flag | Effect |
|---|---|
| `--dry-run` | Print every change, apply nothing. Run this first. |
| `--yes`, `-y` | Skip the confirmation prompt |
| `--no-eeprom` | Skip the bootloader EEPROM phase |
| `--sd-overclock` | Opt in to `sdtweak,overclock_50=100` (card-dependent, off by default) |
| `--force` | Continue even if the board/OS check fails |

## What setup.sh does

| Phase | Action |
|---|---|
| 0 | Preflight; records a boot baseline — `systemd-analyze` **and** `vclog` firmware timings — to `/var/log/musicbox-setup/` before changing anything |
| 1 | Purges `triggerhappy`, `modemmanager`, `rpi-connect*`, `cups*`, `unattended-upgrades` — only if actually installed |
| 2 | Disables cloud-init (only once it reports `done`); masks `NetworkManager-wait-online`; disables `rpi-eeprom-update`, `man-db.timer`, apt timers |
| 3 | `config.txt`: `disable_splash`, `boot_delay=0`, `camera_auto_detect=0`, `disable_poe_fan=1`, `initial_turbo=30` |
| 4 | `cmdline.txt`: adds `quiet` and `logo.nologo` |
| 5 | EEPROM: `BOOT_UART=0`, `NET_INSTALL_*=0`. `BOOT_ORDER` left at the bootloader default unless the tunable is set |
| 6 | `noatime`, tmpfs `/tmp` and `/var/tmp`, volatile journald, swap check |
| 7 | Installs `musicbox-bootreport` |

### Measured result on the real device (2026-09-11)

Pi 4B Rev 1.1, Trixie, kernel 6.18.34, imaged with Raspberry Pi Imager:

| Stage | Kernel | Userspace | Total |
|---|---|---|---|
| Stock image | 2.353s | 12.982s | **15.336s** |
| After `setup.sh` | 2.114s | 12.460s | **14.575s** |
| After network rework | 2.345s | 6.396s | **8.742s** |

Plus, invisible to `systemd-analyze`, the EEPROM change below took roughly
another **0.75s** off the pre-kernel stage.

**15.34s → 8.74s, a 43% reduction.** Almost all of it came from the network
rework, *not* from `setup.sh` — worth being honest about, since `setup.sh` on its
own only bought 0.76s.

#### Where the time actually went

Two assumptions in the original plan were wrong on this hardware:

- **`NetworkManager-wait-online` was already disabled** and never appeared in
  `systemd-analyze blame`. Masking it is a no-op here. Still worth doing
  defensively so a package update cannot re-enable it, but it was not the win the
  plan predicted.
- **The 6s `NetworkManager.service` was not wifi or DHCP.** Imager configures the
  Pi via cloud-init, which writes netplan, which backs NetworkManager. On startup
  NM round-tripped every connection through netplan's YAML store, and each write
  triggered a **full systemd daemon-reload at ~720ms**. Four connections, four
  reloads, ~5.3s of pure overhead before DHCP even began.

### The pre-kernel stage — the part nothing was measuring

`systemd-analyze` reports kernel + userspace only. `vclog --msg` exposes the
firmware stage underneath (timestamps are **milliseconds since power-on**), and
on this device it dwarfs both:

```
~11.2s firmware  +  2.3s kernel  +  6.4s userspace  ~=  20s wall clock
```

which matches observed reboot-to-SSH times. `setup.sh` now records these figures
in its Phase 0 baseline and `musicbox-bootreport` shows them before/after, so
firmware-stage changes can be judged at all.

Two figures matter: the **first** `vclog` line marks roughly when the bootloader
began (everything before it is BootROM and DRAM training, and is not
improvable), and **`Starting ARM`** marks hand-off to the kernel.

#### EEPROM (Phase 5), measured

Phase 5 sets `NET_INSTALL_ENABLED=0` and `NET_INSTALL_AT_POWER_ON=0`.
`BOOT_UART` was already `0`. **`BOOT_ORDER` is deliberately left alone** — boot
modes are tried in order and stop on success, so the stock SD-then-USB order
costs nothing while the SD card works and preserves a USB recovery path. (An
earlier version set `0xf1` on the false premise that a USB CD drive was
attached.) Set the `BOOT_ORDER` tunable in `setup.sh` to override.

```
                    bootloader_start    Starting ARM
  before                005209 ms         011247 ms
  after  (sample 1)     004473 ms         010515 ms
  after  (sample 2)     004384 ms         010427 ms
```

**~730-825ms saved, reproducible across two boots.** The gain is entirely in the
stage *before* the bootloader logs anything — which is why `systemd-analyze` is
unchanged (8.74s vs 8.79s vs 9.06s is run-to-run noise). The
bootloader-to-kernel span itself was flat at 6038 vs 6042 ms, as expected: the
`NET_INSTALL` keys act on the early boot-mode probe, not on config.txt work.

> **How the write is applied.** `rpi-eeprom-config --apply` stages
> `pieeprom.upd`, `pieeprom.sig` and `recovery.bin` into `/boot/firmware`; the
> **bootloader ROM** flashes the EEPROM on the next boot and renames
> `recovery.bin` to `RECOVERY.000`. `flashrom` is not installed on Pi OS Lite,
> so the immediate-SPI path in `rpi-eeprom-update` is not the one taken. Either
> way this is independent of `rpi-eeprom-update.service` (which runs
> `-s -a`, checking only for bootloader *version* updates), so Phase 2 disabling
> that service does not block Phase 5.
>
> Consequences: the boot immediately after applying is a **flash cycle** and is
> not representative — measure the one after it. And a power cut during that
> cycle is the one moment this process could leave the bootloader unbootable.

#### The HDMI theory was wrong — a worked example

Both HDMI connectors reported `disconnected`, yet the firmware performed 12
EDID-related operations, with a **1537 ms gap right after
`hdmi_pixel_freq_limit`**. The obvious reading: suppress HDMI, save ~1-2.3s.

`setup-hardware.sh` suppressed HDMI at both layers. The result:

| | before | after |
|---|---|---|
| EDID log lines | 12 | **6** (HDMI0 gone, HDMI1 remains) |
| bootloader start | 004384 ms | 004393 ms |
| `Starting ARM` | 010427 ms | 010429 ms |
| firmware span | 6042 ms | 6036 ms |

**Zero boot-time gain.** Half the EDID probing genuinely disappeared, and the
firmware stage did not move at all — the 1537 ms gap is *still there*, now
1543 ms, with HDMI suppressed.

The mistake was attributing a gap to the log line *preceding* it. That gap was
never HDMI's cost; it is simply whatever the firmware does next. Where the ~6s
firmware span actually goes:

```
 +1543 ms  after HDMI1: hdmi_pixel_freq_limit   <- still unexplained
 +1364 ms  after loading kernel8.img
 +1231 ms  after sdram refresh
 + 956 ms  after a 188-byte file read
 + 582 ms  after arasan_emmc_set_clock
 + 450 ms  after reading config.txt
```

Mostly storage and inherent firmware work, not display probing.

The change was kept anyway, because its *other* effects are worth having: the
`vc4hdmi0`/`vc4hdmi1` ALSA cards and the HDMI DRM connectors are gone, so
**card 0 is unambiguously the DAC** — which matters when MPD is configured.
`--keep-hdmi` opts out if you ever want a monitor.

Residual: HDMI1 still probes. Per-port `hdmi_ignore_edid:1` might stop it, but
since removing HDMI0's probing bought nothing, there is no reason to expect
HDMI1's would either.

#### The network rework (done manually, not by `setup.sh`)

`netplan.io` **cannot be removed** — `network-manager` depends on it on Pi OS, so
purging it takes NM with it. The fix is to move connection *storage* to NM's
native keyfiles so nothing invokes netplan at startup:

1. `touch /etc/cloud/cloud-init.disabled` — first boot was long done; everything
   it configured is already persisted in `/etc`.
2. Write `/etc/NetworkManager/system-connections/{wlan0,eth0}.nmconnection`,
   **`0600 root:root`** — NM silently ignores keyfiles with looser permissions,
   which is the main way this migration fails.
3. Move `/etc/netplan/90-NM-*.yaml` aside (kept in
   `/var/lib/musicbox/netplan-disabled/`).
4. `chmod 0600 /lib/netplan/00-network-manager-all.yaml` — silences a warning
   logged on every generate.

Result: `netplan generate` calls per boot went 4 → 0, daemon-reloads 4 → 1,
`NetworkManager.service` 6.0s → 2.3s, cloud-init units 3 → 0.

A self-healing watchdog (revert + reboot if the network was down 120s after boot)
was installed before the change and removed once confirmed. Rollback material is
kept in `/var/lib/musicbox/netbackup-<timestamp>/`.

Both halves are now code, split by how generic they are:

- **Disabling cloud-init is a phase of `setup.sh`** (Phase 2). It is generic to
  any Imager-written image and carries no site-specific data. It only fires once
  `cloud-init status` reports `done`, so it cannot interrupt an incomplete first
  boot, and `DISABLE_CLOUD_INIT=0` opts out.
- **The keyfile migration is `install/migrate-network.sh`**, kept separate
  because it operates on *your* SSID and PSK. It re-derives them from whatever
  netplan config is on the machine rather than hardcoding anything, so it works
  on any Imager-provisioned Pi.

## Hardware, as verified on the device (2026-09-11)

| Component | Status |
|---|---|
| HiFiBerry DAC+ | **Configured and working.** `setup-hardware.sh` pins `dtoverlay=hifiberry-dacplus-std` and `dtparam=audio=off`; it is now the only ALSA card (`card 0: snd_rpi_hifiberry_dacplus`). |
| DSI touchscreen | **Connected.** `card1-DSI-1 status=connected`, mode `800x480`; touch controller `ft5x06` live at i2c `10-0038`. |
| USB CD drive | Not attached. |

The DAC+ has **no programmed HAT ID EEPROM**, so `/proc/device-tree/hat/` is
empty and the card will never be auto-detected. This is normal for HiFiBerry and
is why the overlay must be set explicitly in `install.sh`. It also means an
absent `/proc/device-tree/hat/` is *not* a useful health check for this board —
check for the sound card instead:

```sh
aplay -l | grep hifiberry
```

## What it deliberately does *not* do

Most Pi boot-optimisation guides target a headless, network-optional appliance.
This box is neither, so roughly half the usual advice is actively harmful here:

| Common tweak | Why it's excluded |
|---|---|
| `dtoverlay=disable-bt` | Bluetooth audio is a planned feature |
| `dtoverlay=disable-wifi` | The library lives on a network share |
| Remove `avahi-daemon` | The web UI is served at `<hostname>.local` — mDNS is required |
| `max_framebuffers=0`, `disable_fw_kms_setup=1` | Headless-only; a DSI panel is attached |
| `force_eeprom_read=0` | General HAT-detection hazard. Verified harmless on *this* DAC+ (its ID EEPROM is unprogrammed), so it is left unset out of caution, not necessity |
| Strip USB / `sr_mod` | A USB CD drive is a planned input |
| Remove graphics/DRM | A touchscreen kiosk browser is coming |

Kept on purpose: **SSH**, Bluetooth, NetworkManager, avahi-daemon,
`systemd-timesyncd` (the kiosk browser and TLS need correct time), `fstrim.timer`.

### Two trade-offs worth knowing

- **`BOOT_ORDER` is left at the bootloader default.** See the EEPROM section
  above for why narrowing it buys nothing.
- **apt auto-update timers are disabled**, so there are no automatic security
  updates. Set `MASK_APT_TIMERS=0` in `setup.sh` to keep them.

## Verifying a run

```sh
musicbox-bootreport                    # before/after systemd-analyze
nmcli general status                   # network
getent hosts musicbox.local            # mDNS (from another machine)
                                       # avahi-resolve needs: apt install avahi-utils
bluetoothctl show                      # Bluetooth controller present
aplay -l | grep hifiberry              # DAC+ present (HAT EEPROM is unprogrammed,
                                       # so /proc/device-tree/hat/ is always empty)
lsblk                                  # USB CD drive
```

The last four exist to catch exactly the regressions the exclusions table above
protects against.

## Rollback

Every multi-line edit sits inside a delimited block:

```
# >>> musicbox setup.sh managed block >>>
...
# <<< musicbox setup.sh managed block <<<
```

Delete the block to undo that file. Otherwise:

```sh
sudo apt-get install triggerhappy modemmanager      # whatever was purged
sudo systemctl unmask NetworkManager-wait-online.service
sudo systemctl enable apt-daily.timer apt-daily-upgrade.timer
sudo rm /etc/systemd/journald.conf.d/musicbox.conf
sudo rpi-eeprom-config --apply /var/lib/musicbox/eeprom-config.before-<timestamp>.txt
```

`noatime` in `/etc/fstab` is edited in place rather than in a block — remove it
by hand if you want it gone.

## Development

```sh
bash tests/run-all.sh          # syntax + shellcheck + both test suites
```

Or individually:

| | |
|---|---|
| `tests/test-hardware-config.sh` | 37 tests of the `config.txt` transform, via `--emit-config` / `--emit-revert`. Covers neutralising conflicting stock lines (duplicates in `config.txt` are not reliably last-wins), the overlay ordering requirement, idempotency, `--keep-hdmi`/`--skip-*`, and that revert restores the original byte-for-byte. |
| `tests/test-migrate-network.sh` | 25 tests of the netplan→keyfile conversion, via `--convert-only`, which touches no system state. Covers wifi/ethernet/static layouts, UUID preservation, the mandatory `0600` permissions, and that a PSK never leaks into an ethernet profile. |
| `tests/test-setup-helpers.sh` | 62 unit tests. Sources the helper functions and runs them against throwaway fixtures: managed-block round-trips, the single-line `cmdline.txt` edit, `fstab` rewriting, EEPROM key merge. Touches only its own temp dir. |
| `tests/test-integration.sh` | 41 end-to-end assertions. Runs the real `setup.sh` inside a throwaway `debian:trixie-slim` container against a fake `/boot/firmware`, checking that `--dry-run` changes nothing, that a real run produces the expected config, and that a second run is byte-for-byte identical. Requires Docker; skips cleanly without it. |

Both are safe on a development machine — `setup.sh` is never executed on the
host, only inside the container.

**Integration test coverage limits.** The container has no systemd and no Pi
firmware, so these are only reachable on real hardware:

- Phase 2 (service/timer disabling) — no `systemctl` in the container. The unit
  predicates that gate it *are* covered by the helper tests.
- Phase 5 (bootloader EEPROM) — no `rpi-eeprom-config`.
- Phase 1 package purging — Trixie slim has none of the purge candidates.

This is why `--dry-run` on the actual Pi is a real step, not a formality.

## References

- [Optimising boot time on Raspberry Pi SBCs](https://pip-assets.raspberrypi.com/categories/685-app-notes-guides-whitepapers/documents/RP-010196-WP-1-Optimising%20boot%20time%20on%20Raspberry%20Pi%20single-board%20computers.pdf) (Raspberry Pi Ltd whitepaper)
- [config.txt reference](https://www.raspberrypi.com/documentation/computers/config_txt.html)
- [Changes in HiFiBerry drivers](https://www.hifiberry.com/blog/changes-in-hifiberry-drivers/) — the `-std` / `-pro` overlay split
- [Trixie — the new version of Raspberry Pi OS](https://www.raspberrypi.com/news/trixie-the-new-version-of-raspberry-pi-os/)
