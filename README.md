# musicbox

A Raspberry Pi music player appliance.

| | |
|---|---|
| Board | Raspberry Pi 4B |
| OS | Raspberry Pi OS **Lite**, Trixie (Debian 13, kernel 6.12) |
| Audio | HiFiBerry DAC+ **Standard** (I2S HAT) |
| Display | DFRobot DFR0550 — 5" 800×480 DSI capacitive touchscreen |
| Library | NFS/SMB network share |
| Web UI | Angular + Fastify at `http://musicbox.local/` |
| Bluetooth | A2DP sink — a phone pairs and plays through the DAC |
| Planned | USB CD audio |

## Run order

```sh
sudo ./install/setup.sh --dry-run       # 1. review what it would do
sudo ./install/setup.sh                 # 2. OS cleanup + boot tuning
sudo reboot                             # 3.
musicbox-bootreport                     # 4. before/after boot timings
sudo ./install/setup-hardware.sh        # 5. DAC+, DSI panel, HDMI
sudo reboot                             # 6.
sudo ./install/install.sh               # 7. packages (NAS clients, mpd, mpc, node 24, bluez-alsa)
sudo ./install/setup-nas.sh             # 8. mount the music share (interactive)
sudo ./install/setup-mpd.sh             # 9. point MPD at the library and the DAC
sudo ./install/setup-server.sh          # 10. web server + API
tools/dev-push.sh                       # 11. build here, push the app to the Pi
sudo ./install/setup-bluetooth.sh       # 12. Bluetooth A2DP sink
sudo ./install/setup-kiosk.sh           # 13. cage + chromium on the panel
sudo reboot                             # 14.
```

The three scripts split by concern, and each owns its own managed block in
`config.txt` so they never collide:

| Script | Owns |
|---|---|
| `setup.sh` | OS cleanup and boot tuning — **no hardware** |
| `setup-hardware.sh` | HiFiBerry DAC+, DSI panel, HDMI suppression |
| `setup-kiosk.sh` | cage + chromium fullscreen on the panel at boot |
| `setup-nas.sh` | the one `/etc/fstab` entry for the music share |
| `setup-mpd.sh` | `/etc/musicbox/mpd.conf`, the `MPDCONF=` line that selects it, and the `mpd.service` drop-in that orders MPD ahead of the share |
| `setup-server.sh` | the web server units, `/etc/musicbox/server.conf`, and `/var/lib/musicbox/data/` where the database lives |
| `setup-bluetooth.sh` | the A2DP sink, the pairing agent and the DAC arbiter |
| `install.sh` | apt packages, and the NodeSource apt source they need — nothing else |

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
| 4 | `cmdline.txt`: adds `quiet`, `logo.nologo`, and `cpufreq.default_governor=performance` (a deadlock fix — see below) |
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
| `dtoverlay=disable-bt` | Bluetooth audio is a working feature |
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
bluetoothctl show                      # want Powered: yes, Class: 0x240414
musicbox-bt status                     # which phone is connected, and its codec
aplay -l | grep hifiberry              # DAC+ present (HAT EEPROM is unprogrammed,
                                       # so /proc/device-tree/hat/ is always empty)
lsblk                                  # USB CD drive
```

The last four exist to catch exactly the regressions the exclusions table above
protects against.

## The kiosk

`setup-kiosk.sh` puts a fullscreen chromium on the panel at boot under
[cage](https://www.hjdskes.nl/projects/cage/), a single-app Wayland kiosk
compositor. No desktop, no window manager, no display manager, no login prompt.

It installs four things:

| Path | Purpose |
|---|---|
| `/etc/musicbox/kiosk.conf` | `KIOSK_URL`, `KIOSK_WAIT_SECONDS` and `CHROMIUM_EXTRA_FLAGS` — the only file you should need to edit |
| `/usr/local/bin/musicbox-kiosk` | launch wrapper; keeps the flag list out of the unit |
| `/etc/systemd/system/musicbox-kiosk.service` | starts at boot, restarts on crash |
| `/usr/share/musicbox/kiosk/index.html` | holding page until the web UI exists |

### Touch: use the firmware path, not the i2c driver

The DFRobot panel's touch controller **exposes no interrupt line** — its
device-tree node has `interrupts`, `interrupt-parent` and `poll-interval` all
absent. The kernel's `edt-ft5x06` driver therefore falls back to blind polling
over i2c, and it never identifies the chip either (`fw_version` reads `ff 0a`;
the driver reports *"generic ft5x06"* despite the DT claiming `edt,edt-ft5506`),
so it is guessing the register layout as well.

Captured from `/dev/input/event0`, upstream of the compositor and browser:

| | i2c (`edt-ft5x06`) | firmware (`rpi-ft5406`) |
|---|---|---|
| contacts | 535 in 67s | **29 in 42s** |
| phantom contacts (zero points) | most | **0** |
| negative coordinates | many (−3052, −3577) | **0** |
| out-of-range points | — | **0** |
| X / Y range | −3052..799 / −3577..458 | **12..791 / 10..458** |
| large jumps between samples | — | **0** |

So `setup-hardware.sh` routes touch through the GPU firmware, which is the path
the official Raspberry Pi panel has always used:

```
dtoverlay=vc4-kms-dsi-7inch,disable_touch   # disable the panel overlay's i2c touch node
dtoverlay=rpi-ft5406                        # firmware polls, delivers via mailbox
```

The input device becomes `raspberrypi-ts` and the i2c client disappears
entirely, so the two cannot compete. `--touch kernel` selects the old i2c path
if it is ever wanted; switching backends cleans up the other's settings.

Effective sample rate during a drag is ~24Hz — fine for taps, adequate for
dragging.

> **Do not mix the two.** With the i2c driver, `disable_touchscreen=1` is
> mandatory or the firmware polls the same controller and steals its reports —
> an ft5x06 clears its report register on read, so whoever reads first wins.
> With the firmware driver, `disable_touchscreen` must **not** be set, because
> firmware polling is exactly what you want.

### What it costs at boot — and why `systemd-analyze` lies about it

```
systemd-analyze, before kiosk:  2.349s kernel + 6.686s userspace = 9.036s
systemd-analyze, after kiosk:   2.363s kernel + 6.982s userspace = 9.345s
```

**+0.31s. That number is misleading and should not be quoted.** The unit is
`Type=simple`, so systemd considers it started the instant `cage` execs — while
chromium carries on loading for another ten seconds. The kiosk unit does not
even appear in `systemd-analyze blame`.

Measured against actual process start times relative to boot:

| | after boot |
|---|---|
| `musicbox-kiosk` unit active | 8.6s |
| chromium GPU process | 15s |
| **chromium renderer (page composited)** | **18s** |

Add the ~11s pre-kernel firmware stage and it is roughly **29s from power-on to
a visible UI**. That is the honest figure for an appliance, and it is the first
change in this project that made things meaningfully slower.

There is an obvious lead if that matters. `systemd-analyze critical-chain`
shows the kiosk gated behind the network, even though it renders a local
`file://` page:

```
musicbox-kiosk.service @6.227s
└─systemd-user-sessions.service @6.169s
  └─network.target @6.162s
    └─NetworkManager.service @3.866s +2.295s
```

`systemd-user-sessions.service` is genuinely required — it removes
`/run/nologin`, without which `PAMName=login` is refused — but it is itself
ordered after `network.target`. Roughly 4s of the 8.6s is spent waiting for
networking the kiosk does not need yet.

### How it gets a session

cage needs a logind session owning `seat0`. Rather than run a display manager,
the unit acquires one directly:

```ini
User=musicbox
PAMName=login          # creates the logind session -> libseat gets seat0
TTYPath=/dev/tty1
```

Without `PAMName=login`, cage exits with *"Could not open seat"*.

`getty@tty1` is disabled so the panel shows the UI rather than a login prompt.
**Console recovery is preserved:** `autovt@` is aliased, so Ctrl+Alt+F2 on a
plugged-in keyboard still gives a login. That matters — it is the stated
recovery path for this box.

### Pointing it at the real UI

```sh
sudo sed -i 's|^KIOSK_URL=.*|KIOSK_URL="http://localhost:8080/"|' /etc/musicbox/kiosk.conf
sudo systemctl restart musicbox-kiosk
```

### Why `--mute-audio`

MPD is meant to own the DAC exclusively. If chromium opens the ALSA device
first, MPD will fail to start, so the wrapper mutes it. Verified on the device:
chromium holds **0** file descriptors on `/dev/snd/*`, and `fuser` reports
nothing using the DAC.

When the web UI genuinely needs sound, the fix is a shared audio layer (dmix or
PipeWire) — not just dropping the flag.

The same exclusivity is why Bluetooth needed an arbiter rather than just another
service; see the Bluetooth section below.

### The panel turns itself off

Settings -> System -> "Turn the panel off after idle". Off by default. When set,
the panel's backlight goes off after that long with **no touches on the panel**
and **nothing playing**; touching it, or the music starting from anywhere, brings
it back. A record ending starts the countdown again, so an album finishing never
blacks the screen out from under whoever put it on.

It is a **backlight** write (`/sys/class/backlight/10-0045/brightness`), not
DPMS and not `vcgencmd display_power`. Both of those go through the vc4 atomic
commit or the VideoCore mailbox — the paths that hard-locked this board, see
[clock-deadlock.md](.claude/docs/clock-deadlock.md). The backlight here is an
i2c device on the display board (`rpi_touchscreen_attiny`), so scanout keeps
running and only the LED changes. It saves the panel's light, not the GPU.

Three things keep a dark screen from becoming a box that looks dead:

- the panel's own browser runs the timer, so only touches **on it** count — a
  phone being used is not somebody standing at the box;
- the server refuses to sleep the panel unless the panel's own event stream is
  open, and lights it again the moment that stream drops (a crashed renderer, a
  reload, a deploy);
- the server turns the backlight on at its own startup and again on SIGTERM.

The setting lives in the box's database, not in the browser, because there is
only one panel — so you can change it from a phone on the sofa. Everything on
the Interface tab is the opposite: per device, in that browser's localStorage.

### Choosing cage

`cage + chromium` is 129 packages; `labwc + chromium` is 131 and
`rpd-wayland-core` is 365. Chromium dominates either way, so the choice was
about behaviour, not size: cage runs exactly one app fullscreen and has no
config file to get wrong. The trade-off is that **cage cannot rotate the
output** — fine here, since the panel is mounted in its native landscape
800x480. A rotation requirement would mean labwc, or a kernel-level `video=`
rotation in `cmdline.txt`.

## Bluetooth

`setup-bluetooth.sh` turns the box into a Bluetooth speaker. Pair from the phone —
look for **musicbox** — and there is nothing to confirm on the box, which has no
keyboard.

Connect and MPD pauses and hands over the DAC. The now-playing screen then shows
what the *phone* is playing — title, artist, album, a moving progress bar — and
the transport buttons control the phone. A **Disconnect** button hands the speaker
back; MPD stays paused where it was, so the next press of play resumes in place.

**Connect a second phone and it takes over**, and the first is disconnected. The
card can only be held by one thing at a time, so the alternative would be a phone
that pairs, connects, says "connected" on its own screen, and plays to nobody —
with nothing on the box able to explain why. Whoever just connected gets the
speaker. Nothing stops the first phone connecting straight back and taking it
again; that is the same rule, not an exception to it.

### One source owns the DAC at a time

MPD opens `hw:0,0` raw, so the card is exclusive and **both directions of the
handoff race**: a phone connecting while MPD plays, and play being pressed while
the phone streams. `bluealsa-aplay` does not retry a busy device — it gets
`EBUSY` and exits.

So `/usr/local/bin/musicbox-bt`, a root service, sequences it: pause MPD, wait for
the card to actually go quiet, then start the Bluetooth audio path — and the
reverse. It is the only thing allowed to start `musicbox-bt-audio.service`, which
has no `[Install]` section, and Debian's `bluealsa-aplay.service` is masked.

It deliberately does **not** live in the web server: the handoff has to keep
working while the server is being redeployed, and disconnecting a BlueZ device
needs privilege the server should not have. The server only reads the state file
the arbiter publishes.

MPD is **paused, not stopped**, so the queue position survives — and it is never
auto-resumed when the phone leaves or when you press Disconnect, because a speaker
that starts playing to an empty room because a phone ran out of battery is worse
than silence.

MPD being started from somewhere else — `mpc`, another client — is a different
matter: it will have already tried the card, failed while Bluetooth held it, and
paused itself. So the arbiter disconnects the phone, waits for the player to exit,
and explicitly restarts MPD. Measured on a Pixel 8 Pro: **3.2s** from that point
to MPD having the DAC, most of it BlueZ tearing the connection down.

### The API follows whichever source is playing

`state`, `track`, `elapsed` and `duration` describe what you are hearing, not what
MPD is doing, so a client renders them the same way for both sources. During a
Bluetooth session the metadata comes from AVRCP, `track.image` is null (there is
no cover art — see below), `queueVersion` is `-1`, and `GET /api/queue` answers
**409**: a phone exposes no track list at all, and an empty array would be
indistinguishable from "nothing queued".

Playback commands reach the phone over AVRCP. Expect a few seconds between
pressing pause and the UI showing paused — that is AVRCP, measured at 2-6s, and
the UI deliberately does not guess in the gap.

### No cover art over Bluetooth

The phone advertises AVRCP **1.6**, which does specify Cover Art, and it is still
unavailable: the phone offers no OBEX channel to fetch images over, and BlueZ
implements none of it either. Either alone is fatal. Devices that manage it are
generally on Android Auto or CarPlay, which are not Bluetooth.

Borrowing a cover from your own library by matching the artist and album was
considered and rejected. It works, but a phone's metadata is free text and a
near-miss would show a confidently wrong cover. A missing cover is obvious; a
wrong one is misinformation.

### Codecs, and the missing one

aptX HD → aptX → SBC-XQ → SBC. As a sink the box advertises capabilities and the
phone picks, so the fallback is A2DP negotiation rather than anything in this
repo.

**There is no AAC**, which matters because iPhones support only SBC and AAC.
Debian's `bluez-alsa` is not linked against `libfdk-aac` (it is non-free) — and
neither is Debian's PipeWire, so this is not a stack choice. An iPhone lands on
SBC-XQ. Getting AAC would mean maintaining a locally rebuilt `.deb` forever; that
was declined rather than overlooked.

### Volume, repeat and shuffle

Nothing here attenuates: the phone applies its volume *before* encoding and the
DAC's gain stages stay at unity, same as for MPD.

Repeat and shuffle are *reflected* from AVRCP but cannot be changed — there has
never been an API for them, for either source. Adding it for both together is on
the roadmap.

### It is open to anyone in radio range

Always discoverable, just-works pairing. That is how a commodity Bluetooth
speaker behaves and it is a deliberate choice. A UI-gated pairing window is the
answer if it ever matters.

### The radio was switched off

Bluetooth appeared dead on the real box: `rfkill` soft-blocked, `bluetoothd`
logging `Failed to set mode: Failed (0x03)` every boot, adapter reporting
`PowerState: off-blocked`. Nothing in this repo set it. `setup-bluetooth.sh`
clears it through sysfs and systemd-rfkill persists it. Another case of verifying
the effect rather than the setting — `AutoEnable` alone does nothing while the
block is in place.

### The pairing agent had to be killed, not asked

`bt-agent` catches SIGTERM and then never exits — `/proc/<pid>/status` shows the
handler installed, and the process only ever logs `SIGUSR1 received`. systemd
therefore waited the full `DefaultTimeoutStopSec` before SIGKILLing it, and
**that, not the NFS share, is what made every shutdown take 90 seconds.** The
unit now sets `KillSignal=SIGINT` and `TimeoutStopSec=5`. SIGINT it does act on:
measured at ~100ms, unregistering from BlueZ on the way out, where SIGTERM never
returned. The timeout escalates to SIGKILL if that ever changes.

## MPD

`setup-mpd.sh` configures the player. It installs nothing — `mpd` and `mpc` come
from `install.sh`, which is deliberate: MPD alone pulls **118 packages** even
with `--no-install-recommends` (the whole ffmpeg stack, fluidsynth, OpenAL,
JACK, PipeWire, PulseAudio, sndio, libupnp — all hard `Depends`). That is a real
departure from the stripping this image does elsewhere, taken on the grounds
that they are shared libraries rather than services: the cost is disk, which is
not scarce here, and not boot time, which is.

### It does not edit `/etc/mpd.conf`

Debian's unit is `ExecStart=/usr/bin/mpd --systemd $MPDCONF` with
`EnvironmentFile=/etc/default/mpd`, and that file ships with
`# MPDCONF=/etc/mpd.conf` commented out. So the config goes to
`/etc/musicbox/mpd.conf` and a small managed block in `/etc/default/mpd` selects
it. The package conffile is never modified, dpkg never prompts on upgrade, and
the revert is exact.

An `include` file will not work as an alternative: Debian's `mpd.conf` already
sets `music_directory` and `bind_to_address`, and MPD treats a redefined
parameter as a fatal duplicate.

### Three settings that are easy to get wrong

| Setting | Why |
|---|---|
| `music_directory "/srv/music/Music"` | **Not** `/srv/music`. The share root also holds `#recycle`, and Synology scatters `@eaDir` thumbnail directories through the tree. |
| `mixer_control "Digital"` | **Not** `"PCM"`, which is what most MPD examples show and does not exist on a pcm512x. Check with `amixer -c 0 scontrols`. |
| `auto_update "no"` | MPD's auto-update is inotify-based, and inotify cannot see changes made on the far side of an NFS mount. It would watch ~50,000 files and never fire. Scans are explicit: Settings → Library, or `mpc update --wait`. Note this does **not** disable the *initial* scan — MPD builds the database itself on startup when `tag_cache` is absent. |

An unreadable library is a **warning, not an error**. MPD has to tolerate the
share being down and pick it up on first access — refusing to configure would
contradict the whole point of the lazy automount.

The script does not run the first scan. 49,711 files over NFS takes minutes, and
burying that in a config script makes a re-run look hung.

### Scanning, from the screen

Because `auto_update` is off, the box has to be told when to look. Settings →
Library does that:

- **Scan for new music daily at** — an hour, or Never. Local wall clock, so it
  can be set to a time nobody is listening. Not a systemd timer: the server is
  already running, and this keeps the schedule in the same place as the setting.
- **Scan after starting up** — one scan a couple of minutes after boot, skipped
  if MPD is not up yet or the share cannot be read. It never gates boot.
- **Scan now** (`update`, what changed, ~8 minutes) and **Full rescan**
  (`rescan`, every tag re-read, ~49 minutes, for music that was retagged in
  place). The second asks first.

Eight minutes is why both routes answer 202 and the result comes back on the SSE
stream rather than on the response, and why the schedule is daily rather than
hourly: `update` still stats all 49,711 files to find what changed.

It also shows what the library holds, when the last scan ran, and how long it
took. Every scan is gated on the share being readable first, because `update`
prunes songs it cannot see: a scan run while the NAS is asleep would empty the
tag cache and cost 48 minutes to rebuild.

**A scan that finishes is followed by the `.nfo` harvest**, which adds about a
minute: the NAS files a Kodi-style `artist.nfo` and `album.nfo` beside the music,
and the box reads the two things MPD's tags do not carry out of them — a rating
out of ten, and an artist biography. They are stored in the box's own database
(`library_note`, schema v5) rather than read when a screen asks for them, so they
survive the share being unmounted, which it normally is. Nothing else about them
is new: everything else in those files — title, label, release date, MusicBrainz
ids — is already a tag MPD hands over, and the tags are the better source. Expect
the biography to be missing: only 60 of 506 artists here have one the box can
reach.

On screen, the rating shows as a red heart and a percentage — `♥ 85%` — **on
albums only**, beside an album in an artist's list and on the album screen
itself. Artists are rated in the files too, and the box deliberately shows
nothing: a mark against a whole artist says much less than one against a record.
The biography appears under the artist's name, tap to expand.

A scan that mpd was restarted under is recorded as **interrupted** rather than as
a success — MPD's own `uptime`, off the same `stats` call, is shorter than the
scan we were timing. An interrupted scan does not trigger the harvest: a
half-read library is not one to read sidecars against. The scan history lives in the box's database
(`library_scan`, schema v2), and the row is written when a scan *starts*: a
deploy restarts the server, and recording at the end would lose the start time
of every scan a deploy landed on top of.

### What it costs at boot

```
before MPD:  2.069s kernel +  7.279s userspace =  9.348s
with MPD:    2.332s kernel + 15.564s userspace = 17.896s
```

`mpd.service` is on the critical path at **5.960s**. The lazy mount is not the
problem — from the journal, the NFS mount takes **0.54s**. The cost is 4.43s of
MPD loading a 3.4M `tag_cache` (37,289 songs) and initialising the decoder
plugins those 118 packages brought, with `After=network.target` deferring the
start to 9.6s on top.

**The 6 seconds are accepted deliberately** so MPD is resident and instantly
ready. Socket activation gives the time back — MPD then starts on the first
connection instead — and is one command away if that trade looks better later:

```sh
sudo systemctl disable mpd.service     # keep mpd.socket enabled
```

The initial scan took **48m40s** over NFS for 49,711 files. One-time; the
database survives reboots. A later `update` against a warm database is **~8
minutes** — it still stats all 49,711 files to find what changed, and only skips
reading tags. A full `rescan` is back to the initial figure.

### Proven: the NAS can be off

The whole point of `noauto,x-systemd.automount,nofail`. Cold boot with the NAS
powered off costs **+1.07s** (18.969s vs 17.896s). The mount attempt fails in
5.05s on name resolution, `nofail` lets boot carry on, and MPD logs
`Failed to access /srv/music/Music: No such device` and keeps running with its
database intact. The automount stays armed, so the share recovers on its own when
the NAS returns — no intervention.

Not yet tested: a NAS that *resolves* but does not answer. That path reaches TCP,
where `x-systemd.mount-timeout` defaults to 90s.

Related: because MPD builds the database itself on first start, **restarting
mpd mid-scan abandons the scan and leaves a partial database.** `setup-mpd.sh`
therefore restarts mpd only when the config actually changed.

### Shutdown has to be ordered by hand, for the same reason

The automount is what makes boot cheap, and it is also why systemd does not know
MPD needs the share: MPD triggers the mount by reading `music_directory`, so no
dependency is ever declared. Shutdown therefore unmounted the share while MPD
still held it open, and every single shutdown logged:

```
umount.nfs4: /srv/music: device is busy
Failed unmounting srv-music.mount - /srv/music
```

`setup-mpd.sh` writes `/etc/systemd/system/mpd.service.d/10-musicbox-nas.conf`
with `After=srv-music.mount`; systemd reverses ordering on shutdown, so MPD now
stops first. This does not touch the boot contract — `After=` adds no
requirement and the `noauto` mount gets no boot job — but the NAS-off reboot
that would prove it is still outstanding (see `.claude/docs/roadmap.md`).

This was **not** what made shutdown take 90 seconds. That was the Bluetooth
pairing agent; see below.

## The web server

One Node process serves the Angular build and the API that bridges it to MPD, at
`http://musicbox.local/` — port 80, so no port suffix to type on a phone.

```
src/backend/   Fastify + TypeScript   --esbuild-->  backend/server.js   (one file)
src/frontend/  Angular workspace      --ng build->  frontend/           (hashed)
src/shared/    api.ts — the wire format, imported by BOTH sides
```

`backend/` and `frontend/` are committed on purpose, so a stable update can be a
pull and a restart.

### The Pi is never a build machine

Both halves are built here; the Pi receives one bundled `server.js` plus static
files, and needs no `node_modules`. That is possible because the backend has
exactly **one runtime dependency** (Fastify). The MPD protocol client and the
static file handler are hand-written, roughly 150 lines each.

Node itself comes from **NodeSource, not Debian**: Trixie ships node 20, and the
backend keeps its state in SQLite through `node:sqlite`, which is part of the
runtime from 22.5 and needs no flag from 24. The alternatives were a native
module (breaks the single-file bundle, the same verdict as `sharp`) or a WASM
engine (a second runtime dependency and a `.wasm` to ship).

It is one package — `nodejs 24.x`, depending only on libc6, libstdc++6 and
python3, against Debian's 12 — but be aware it **bundles npm**, which it
`Provides:` and `Conflicts:`. So npm's files are on the disk where Debian's node
20 left them absent. Debian's own `npm` package, the one that is **363 packages**
because it unbundles every dependency into its own `node-*`, is still never
installed. The Pi still builds nothing.

### The dev loop

Most work never touches the device, because MPD is reachable over the network:

```sh
cd src/backend  && MUSICBOX_MPD_HOST=musicbox.local MUSICBOX_PORT=8099 \
                   MUSICBOX_CONF=/dev/null npm run dev    # real MPD, real library
cd src/frontend && npx ng serve                           # proxies /api to :8099
```

#### The panel reloads itself

`tools/dev-push.sh` rsyncs the build and the device restarts the service on its
own — `musicbox-server.path` watches **both** `backend/server.js` and
`frontend/index.html`.

Watching the frontend looks redundant until you know what it is for. The kiosk
loads the page once at boot and never navigates again: it has no keyboard and
nobody to press reload. So a frontend deploy used to land on disk, be served
perfectly, and never reach the screen — the panel was found running a
**14-hour-old bundle** while the correct files sat beside it.

The chain that fixes it:

```
frontend/index.html changes
  -> musicbox-server.path restarts the service
    -> every SSE stream drops; EventSource reconnects by itself
      -> the server states its build id on connect (SSE_BUILD_EVENT)
        -> a client that sees a DIFFERENT build calls location.reload()
```

`index.html` is the right file to watch because Angular content-hashes its
bundles and rewrites `index.html` to name them, so it changes whenever anything
in the frontend does — and rsync only rewrites it when the content really
differs, so an unchanged deploy still triggers nothing.

This is not only a dev-loop concern: `git pull` in production hits exactly the
same trap, and the same mechanism covers it. Reloading is safe because the UI
holds no state worth keeping — everything arrives in the next snapshot. Phones
get the same treatment, which is what you want after a deploy.

#### Pointing the frontend somewhere else

By default the frontend calls `/api` on whatever origin served it — the dev
server proxy above, or in production the one process that serves both halves. To
aim it at a different origin instead, such as the real box while running
`ng serve` locally, set `apiUrl` in
`src/frontend/src/environments/environment.development.ts`:

```ts
apiUrl: 'http://musicbox.local',
```

**Paths that arrive from the server go through the same resolver.** `Track.image`
is a root-relative `/api/art?...`, and binding it straight into an `<img>` would
make the browser resolve it against the *page's* origin — so with `apiUrl` set to
the real box, the art would be fetched from the dev server and 404. `MusicboxApi.resolve()`
is public for exactly this, and a test asserts nothing bypasses it. Images need no
CORS, so it works cross-origin unchanged.

That is Angular's standard environments mechanism: `angular.json` swaps that file
in for `environment.ts` in the `development` configuration only, so a production
build can never carry a dev origin. Blank means same-origin, which is why the
file is committed blank.

Nothing else to configure: the backend answers `/api` with
`access-control-allow-origin: *`, so a cross-origin frontend on any host or port
works without enumerating it — including the preflight that the playback `POST`
provokes by sending JSON. Static files get no such header; they are served by the
same process and are same-origin by nature.

That is deliberately open, and the trade is worth stating plainly: any page loaded
by any device on the LAN can read player state and issue transport commands. There
is no authentication on this API either way. It is a music player on a home
network and the worst case is a skipped track — but it is not a pattern to copy
onto anything that matters.

When you need the actual panel — touch, the DAC, 800×480 rendering:

```sh
tools/dev-push.sh --backend    # measured: 2.5s
tools/dev-push.sh              # both halves: 4.3s
tools/dev-push.sh --watch      # rebuild and re-push on save
```

**No sudo anywhere in that loop.** `musicbox-server.path` watches
`backend/server.js` and restarts the service itself. rsync writes a temp file and
renames it, so the watch fires once on a complete file — which is why
`rsync --inplace` must never be used here.

### It costs nothing at boot

```
before the server:  2.332s kernel + 15.564s userspace = 17.896s
with the server:    3.139s kernel + 14.647s userspace = 17.786s
```

Because it is **not** ordered behind MPD:

```
musicbox-server.service @5.433s
└─basic.target @5.400s          <- mpd.service is still 6.008s, in parallel
```

`After=mpd.service` would have added that 6s for nothing, and `network.target`
is not reached until NetworkManager starts — binding `0.0.0.0` needs neither.
MPD being absent is handled in the application: two connections, each
reconnecting with backoff, reporting `status: "unavailable"` meanwhile. On a real
boot the first attempt times out because MPD has not started yet, and it
reconnects a second later.

The kiosk **is** ordered after the server, since chromium loading `KIOSK_URL`
before anything listens shows an error page — but with `Wants=`, not `Requires=`,
so a broken server still leaves a panel that can say so.

`After=` is not enough on its own: the server is `Type=simple`, so systemd calls
it started the moment it execs, and it binds about four seconds later. Measured
on this box that left 0.75s between "Server listening" and chromium launching,
and chromium never retries a refused connection. The launch wrapper therefore
waits for the URL's port to accept a connection — up to `KIOSK_WAIT_SECONDS`,
default 30 — and then launches regardless.

### Two things the live device taught us

**MPD hangs up on a silent connection.** `connection_timeout` defaults to 60s and
the command connection only carries commands, so MPD closed it about once a
minute; each reconnect briefly published "unavailable" and the UI flashed
*"MPD is not running"*. Fixed with a 20s `ping` keepalive, plus a 3s grace period
before any outage reaches the UI. The idle connection is exempt — it sits in
`idle`. Verified: one connection in 215s, where there had been three.

**An SSE stream blocks shutdown.** Fastify's `close()` waits for connections to
finish; `/api/events` never does. Once the kiosk held one open, every deploy hung
for systemd's 90s stop timeout. The app now ends its streams on SIGTERM, with
`forceCloseConnections` and `TimeoutStopSec=10` behind it. Deploys went from 30s
and failing back to **2s**.

### The API

SSE carries state, REST carries commands.

```
GET  /api/health     GET /api/status    GET /api/events (SSE)    GET /api/queue
GET  /api/art?album=<url-encoded library directory>
POST /api/playback/{play,pause,stop,next,previous}
POST /api/queue/play/<song id>

GET  /api/library/artists
GET  /api/library/albums?artist=<name>
GET  /api/library/album?artist=<name>&album=<title>&release=<release>
POST /api/library/queue    {albumArtist, album, release}   append an album
POST /api/library/play     {albumArtist, album, release}   replace the queue and play

GET   /api/panel                                   is there a backlight, is it on
POST  /api/panel/backlight {on}                    409 unless the panel itself asks
GET   /api/settings                                the box's settings
PATCH /api/settings        {key: value}            change some of them

GET   /api/library/state                           counts, last scan, is one running
POST  /api/library/scan                            look for what changed
POST  /api/library/rescan                          re-read every tag

GET   /api/backup                                  download the box's state (.tar.gz)
POST  /api/restore         <application/gzip>      replace it with an uploaded backup
```

(`POST /api/volume` is gone — see "Volume, and why there isn't any" below.)

The stream carries three other events besides the snapshot: `build`, which is how
the panel notices a deploy and reloads itself; `settings`, which is how a change
made on a phone reaches the panel without it polling; and `library`, which is how
a running scan and the last one's result do the same. None belongs on the
snapshot — that contract is about what the music is doing.

The two scan routes answer 202, not 200: a scan on this library runs for the
better part of an hour, so there is no result to wait for. They are two routes
rather than one with a flag, because a boolean would make the expensive one the
easier thing to reach by accident. 409 if a scan is already running; 503 if MPD
is unavailable or the music share cannot be read.

**Every SSE event is a complete snapshot, never a delta.** A dropped, duplicated
or out-of-order event costs nothing — the client replaces its state and can never
drift out of sync. The one thing not embedded is the queue, referenced by
`queueVersion` instead: with 37,289 songs, embedding it would mean megabytes of
JSON on every state change.

The queue is described by three fields rather than carried: `queueVersion`,
`queueLength` and `queuePosition` (0-based index of the current track). The last
comes from MPD's `status`, not the track, so it stays correct even when
`currentsong` returns nothing — it is where the screen splits the list.

`POST /api/queue/play/<song id>` starts one track from the queue. **By MPD's song
id, not by position**: a position is only valid until somebody reorders the queue,
and the listing under a finger may be seconds old. It is not one of the playback
commands, deliberately — those are the verbs both sources implement, and a phone
exposes no addressable track list, so it answers `409` during a Bluetooth session
exactly as `GET /api/queue` does.

Elapsed time is **interpolated client-side**. MPD does not push progress
continuously, and polling for a smooth progress bar is the obvious wrong answer.

The client interpolates from **its own receive time**, so a phone's clock never
has to agree with the Pi's. That only works because the server sends a **freshly
queried** snapshot on SSE connect and on `GET /api/status` — MPD's `idle` does not
fire as elapsed time advances, so the cached snapshot's `elapsed` dates from the
last real event. Sending that to a new client made a page reload show the elapsed
time as at the last pause/resume.

### Backup and restore

Settings → System, **on a phone** (the panel shows nothing: a download would land
on the Pi, and a file picker there can only browse the Pi's own disk). One
`.tar.gz`, readable with plain `tar tzf`:

```
manifest.json        format, build, schema version
musicbox.db          the server's database, as one consistent file (VACUUM INTO)
mpd/state            queue, position, repeat/random
mpd/tag_cache        the library index — restoring it skips an hour-long scan
mpd/sticker.sql      if present
mpd/playlists/*.m3u
```

The backup is built by the server itself: every file is world-readable. A restore
is not, because MPD's files are its own and MPD rewrites `state` when it stops.
So the server validates the upload (only those names, only regular files, a
database that passes `integrity_check` and is no newer than this build) and
stages it in `/run/musicbox-restore/`; root's `musicbox-restore.path` then stops
the server and MPD, keeps the current files in `/var/lib/musicbox/restore-previous/`,
swaps in the new ones and starts both again. The helper re-checks the payload
itself rather than trusting the user that wrote it.

Refused with 409 while a library scan runs (restarting MPD mid-scan leaves a
partial index) or a phone is playing. A backup without `tag_cache` or stickers
leaves the box's own copies in place; playlists are replaced as a set.

The helper comes from `setup-server.sh`, so **re-run it** on a box set up before
this existed — until then restore answers 503. To undo a restore by hand, copy
the files back from `restore-previous/` with MPD and the server stopped.

### Home

The screen the box opens on — `/` and anything unrecognised land here.

It carries **shelves**: a heading, a row of cards that scrolls sideways with a
button at each end, and a link through to the full list. The buttons are always
visible to a thumb and fade in on hover where there is a mouse to hover with; the
row has no scrollbar. On a phone or a desktop browser the buttons scroll
smoothly; on the panel they jump, because an animation there is a vc4 atomic
commit per frame and the box has a display-clock deadlock that is not closed.
The row snaps either way, so a page lands on a card edge.

The first shelf is **Recent Plays** — the ten albums the box played most
recently, *See all* going to the screen below. It leads because picking up where
you left off is the commonest reason to walk up to the box, and it is the shelf
that changes most. A box that has played nothing shows no shelf for it.

The second is **Most Played Artists** — the ten artists the box has played most,
all time, as round pictures rather than square covers. Tapping one opens the
artist. A box that has played nothing shows no shelf for this either.

The third is **Recently Added** — the ten newest albums, in order, *See
all* going to the screen below. Nothing about it is random; the list is the same
one that screen shows, fetched once and cached.

The fourth is **ten of your favourites, chosen at random**, with *See all*
going to the Favourites screen. The ten are fixed for as long as the page is
loaded — going into an album and coming back shows the same row — and they are
picked by hashing a per-load seed with each album's release rather than by
shuffling, so favouriting something elsewhere does not rearrange the screen. The
panel reloads on a deploy or a reboot, which is when the ten change. Tapping a
card opens the album.

Each shelf fills at its own moment, and while one is still waiting it shows a
row of **blank cards** the exact size of the real ones rather than a line of
text — so a shelf that lands does not shove the shelves below it up the screen.
The blank cards do not shimmer or pulse: an animation is a repaint per frame, and
on the panel every one of those is a vc4 atomic commit.

`Shelf`, `AlbumCard` and `ArtistCard` under `routes/home/components/` are
deliberately separate: the shelf knows nothing about what it carries, which is
what lets one rail hold square albums and round artists. `ShelfSkeleton` beside
them is what fills the rail while a shelf waits — `[round]` for the artists — and
it goes *inside* a real `Shelf` so the heading and arrows are right by
construction.

### Recently added

`/home/recently-added`: the 100 newest albums, newest first, virtualised like the
Library's artist list. No filter and no sort — the server's order is the answer —
and Queue and Play on each row, as on Favourites.

```
GET /api/library/recent            the default 100
GET /api/library/recent?limit=10   1..500; 400 for anything else
```

**The albums are grouped out of a window of songs.** MPD 0.24 sorts by the `Added`
tag but has no album listing that carries a date — `list album sort -Added` answers
`ACK {list} Unknown filter type` — so the server asks for
`find "(base "")" sort -Added window 0:1000` and takes the first appearance of each
album. Measured here: 1,000 songs is 80 albums in 372ms, 2,000 is 215 in 433ms, so
100 albums is one round trip. The answer is cached until a scan finishes; measured
end to end, 773ms cold and under a millisecond warm.

**The rows carry no track count**, unlike an artist's albums. The window cuts an
album off part way, so any count taken from it would be wrong, and getting it right
is a `find` per album — 11.4ms each, over a second for 100. The row says
"Artist · year", and the album screen has the real numbers.

### Recent plays

`/home/recent-plays`: the albums the box has played, most recent first, and the
shelf that leads the Home screen. Rows read "Artist · 2 hours ago" — the list is
already in time order, so the release year the other album lists show would say
nothing here.

```
GET /api/plays/recent            the default 100
GET /api/plays/recent?limit=10   1..500; 400 for anything else
```

The list also arrives on the stream as a `plays` event, on connect and whenever a
play is recorded, so the screen never fetches and never polls.

**A play is thirty seconds of playing.** Not thirty seconds of the track — time
actually spent playing, accrued across frames while the state is `play`. So
skipping through a queue records nothing, a pause does not accrue, and a seek
backwards cannot make one track count twice.

**Recorded without a timer.** MPD's `idle` never fires because elapsed time
advanced, so a track playing quietly for four minutes produces no events at all —
and then the frame at the song change carries a `serverTime` four minutes later,
which *is* how long it played. `play-watch.ts` keeps its own copy of the last
snapshot it saw and does the arithmetic on the wall clock between frames.

**MPD only.** A phone on A2DP has no file, no library album to open and no cover
art, so there would be nothing for a card to be.

**The table is per track, the screens are per album.** `track_play` holds one row
per song ever played — file, tags, a play count and the last time — and the album
list is a `GROUP BY` over it. Most-played track, album or artist is then a query
rather than another migration. Nothing is pruned: the ceiling is the library.

### Most played artists

`/home/most-played-artists`: the artists the box has played most, all time, and
the second shelf on Home. A list, not a grid, for the reason the Library gives —
a row carries the picture, the name *and* the count, where a grid of squares
gives up the last two to fit more of the first. A row carries the name on the
left and "412 plays" on the right, and opens the artist; there is no Play or
Queue on it, because the library's play and queue take an album.

```
GET /api/plays/artists            the default 100
GET /api/plays/artists?limit=10   1..500; 400 for anything else
```

**Ties break alphabetically, not by recency.** The list is cut off by `limit`,
and an order that moved on every play would shuffle the last card in and out of
the shelf.

**The picture comes from a path, never from the name.** An artist's photo lives
in their directory, and 48 of this library's 487 names differ from the directory
they are filed under — `AC/DC` is `AC-DC`. `track_play` stores the file that
played, so the directory is its first path segment, exactly as the artist list
derives it. An artist whose files sit at the library root gets no picture rather
than a confidently wrong one, and like every art URI here it may still 404.

**It is fetched, not streamed.** Recent Plays arrives on the stream because that
list is ordered by recency and one play reorders it. An all-time count barely
moves, so a frame per play would carry the whole list again to change nothing on
screen. The client caches it instead and drops that cache when a `plays` frame
says something was played, so coming back to Home after listening shows the new
counts.

**No MPD.** This answer comes out of the database alone, which is why it has no
503-when-MPD-is-down case the way Recently Added does.

### Favourites

Albums are favourited with the star on the album screen, and beside each album on
an artist's page (the album screen only, on a phone). The Favourites tab lists
them with Play and Queue; un-favourite from the album itself. It filters by artist or album
title the way the Library filters artists, and sorts by date added, release date,
title or artist, either way. The sort is per device, in localStorage.

```
GET    /api/favourites
PUT    /api/favourites/album?artist=&release=   404 if the library has no such album
DELETE /api/favourites/album?artist=&release=   works for an album that has since gone
```

All three answer with the complete list, which also arrives on the `favourites`
SSE event, so a star set from a phone lights up on the panel.

**They live in the database, not in MPD stickers.** MPD 0.24 can put a sticker on
an `Album` tag, but that is keyed by the title alone, and on this library
**20 titles are shared by 47 albums** — seven are called *Greatest Hits*. The
table is keyed by AlbumArtist and Album, as `findadd` is. Each row keeps the
album's summary so the list costs no MPD lookups; it is refreshed whenever the
album screen is opened.

### The queue on screen

The now-playing screen is exactly one viewport tall; the queue lives underneath
it and you scroll to reach it. A chevron at the foot of the first screen says so,
and appears only when there is a queue.

It is **two lists, not one**, split at `queuePosition` — **Back to** and **Up
next**, with Up next selected. The playing track is in neither: it is already the
whole screen above, and a highlighted row would be the third place the same thing
is said. Back to runs backwards, most recent first, because the point of it is to
get back to something you heard a moment ago.

Tapping a row plays that track. Nothing is updated locally when you do — the new
position arrives on the next snapshot and re-splits both lists, the same rule as
every other command.

The section is **absent, not empty**, when there is nothing to list: a Bluetooth
source (`queueVersion` is -1 and there is no listing to be had), MPD down, or an
empty queue. The page is then one viewport and does not scroll at all.

Rows are lazy-loaded and animate nothing, for the reason the rest of this UI does
not either: scrolling a long list is the most repaint-heavy thing here, and every
repaint on the panel is a vc4 atomic commit. The per-album art key does most of
the work — see below.

### Browsing the library

Three screens: every artist, one artist's albums, one album's tracks. Everything
comes from MPD's in-memory tag database — never from the NFS share, which is
mounted `noauto` with a 10 minute idle timeout and is routinely not mounted at
all. Cover art is the one exception, and it is allowed to 404 for exactly that
reason.

**An album here is a RELEASE, not an album title.** Weezer have four self-titled
records and this library holds all four; grouping on the `Album` tag showed them
as one card carrying 1994's cover and all 43 tracks. The identity is the
`MUSICBRAINZ_ALBUMID` — `release: "mb:<id>"` on the wire, and what every album
URL, queue command and favourite is keyed by. Measured across 3,054 albums here,
25 titles are shared by two releases of the same artist, exactly one album
carries no id at all (it falls back to its directory), and no id is split across
two directories, so a multi-disc album stays one album.

A side effect worth knowing about: two copies of the same record now show as two
cards. Dark Side of the Moon appears twice, once as the original and once as the
50th Anniversary. Only the year distinguishes them on screen. See
`.claude/docs/decisions.md`.

**Measured against the real library** — 38,978 songs, 2,876 albums, 488 artists
(37,289 / 2,757 / 487 when the browse screens were first built; the timings below
were taken then and have not been retaken). Several plausible designs died here:

| Command | |
|---|---|
| `listallinfo` | **MPD closes the connection** after 112ms — its output buffer overflows. There is no "load it all once" design to be had. |
| `list album group albumartist` | 80ms, every artist and album count |
| `lsinfo ""` | 3ms, 486 artist directories |
| `find albumartist "X" window 0:1` | **11.4ms each** — 5.6s for all 487 |
| `find base "X" window 0:1` | **0.23ms each** — 111ms for all 486 |

That 50x gap is the whole design: a tag filter scans every song, while `base` is
a path prefix and is indexed.

**Artist and album screens need no index** — each is a single `find` — but the
artist *list* does, for one field. An artist's picture lives in their DIRECTORY
and MPD's database talks in names, and **48 of the 487 names differ from their
directory**: `AC/DC` is filed under `AC-DC` (a slash cannot be a path segment),
`Andrew W.K.` under `Andrew W.K`, `CAKE` under `Cake`. So the two are joined by
asking MPD for one song in each directory and reading the tag off it, rather than
transforming one string into the other — which would be wrong for one artist in
ten, the same "confidently wrong" failure that rules out guessing a Bluetooth
cover.

The index is built lazily, held for the life of the process, and dropped when
MPD's idle reports `database` or `update`. Measured on the device: **662ms cold,
95ms warm**.

The artist directory is the FIRST path segment of a track, not `dirname` twice —
149 albums keep their tracks in a `CD 01`/`Vinyl 01` subdirectory, so two dirnames
gives the album directory instead.

**The year is the release year, not the pressing.** `OriginalDate` is preferred
over `Date`, and that is load-bearing rather than fussy: 2,726 of 2,758 albums
carry it and **940 of those disagree with `Date`**. AC/DC's entire catalogue is
stamped 2020 by `Date`; `Back in Black` is 2003 against 1980. Sorting an artist's
albums on `Date` is wrong for a third of this library and visibly contradicts the
year in the folder name on disk.

### What the tags actually hold

Every tag MPD indexes, counted across all 38,978 songs. This is what decides
which fields the API carries — the answer was measured, not guessed, and most of
it went the other way from what looked obvious.

| Tag | Coverage | Distinct | |
|---|---|---|---|
| `Genre` | 99.9% | 499 | **Multi-valued on 91% of songs.** Exposed, as an array, on the album |
| `Disc` | 100% | 1–6 | **313 of 2,876 albums span more than one disc** |
| `Label` | 97.5% | 614 | Exposed on the album |
| `MUSICBRAINZ_*` | ~100% | — | Exposed. 6 songs of 38,978 carry none |
| `Format` | 100% | — | Exposed on the track. Half the library is above CD quality |
| *(no codec tag)* | — | — | **MPD reports none.** The container comes from the file extension |
| `Added`, `Last-Modified` | 100% | — | `Added` exposed; free on every `find` |
| `Composer` | 3.4% | 529 | **Not exposed** |
| `Performer`, `Conductor`, `Work`, `Ensemble` | 0.3–1.4% | — | **Not exposed** |
| `Movement`, `Grouping`, `Mood`, `Name` | 0% | 0 | **Not exposed** |
| `ArtistSort`, `AlbumSort`, `AlbumArtistSort` | 100% | — | **Not exposed — see below** |

**Genre is an array because the tag is one.** MPD sends one `Genre:` line per
value and 91% of these songs carry more than one — "Burn the Witch" has twelve,
and the per-song count runs to sixteen. A parser that folds a record into a map
keyed by tag name keeps whichever line came last, so Art Rock through Krautrock
arrived on the wire as `"Orchestral"`. It is on the **album** rather than the
track because that is what it describes here: OK Computer's 23 tracks carry an
identical 13 genres, and repeating them per track is real weight — Pink Floyd's
309 songs carry 4,027 `Genre` lines between them.

**The sort tags do not answer the sorting question.** The artist list is in MPD's
own `AlbumArtist` order and deliberately has no second opinion about whether The
Panics belong under T. The tags were the obvious way to buy one, and they are
empty of information here: **1 of 489** `AlbumArtistSort` values differs from the
plain tag (`Neko Case` → `Case, Neko`), and the two `AlbumSort` differences are a
case-typo pair. Measured so the idea does not have to be revisited.

**Classical metadata is absent, not pending.** Composer reaches 3.4% and
everything else below 1.5%, so a composer or work view would be empty for 36 of
every 37 songs.

**The encoding is not MPD's to give.** The song record carries the DECODED
`Format` and nothing about how the bytes were stored, and `readcomments` — which
reads the container's own tags — names no codec either, costs 132ms a file, and
needs the NFS share mounted. So `Track.encoding` is the file extension,
upper-cased, derived from `file` alone at no I/O cost, exactly as `image` is.

It is the **container, not the codec**: `.m4a` answers `M4A`, never `AAC`, since
that container holds ALAC just as happily. This library has nothing ambiguous —
**38,402 FLAC, 556 MP3, 20 APE**, and that is all 38,978 — but the rule does not
depend on that.

It is worth carrying beside `format` because `format` cannot tell lossy from
lossless: **all 556 MP3s here report `44100:16:2`**, identical to a CD rip. The
now-playing badge would otherwise show *Greatest Hits* as `16/44.1` exactly as it
shows a lossless one.

**Everything above was already arriving.** `find albumartist "X"` returns the
complete song record, so the genres, the disc, the label and the MusicBrainz ids
cost no extra command — they were being parsed and dropped. The one addition is
`count group albumartist`, which gives songs and playtime for all 488 artists in
**35ms**; the artist index measures 520ms cold and 29ms warm with it in place.

**The album screen groups by disc, and numbers rows from the `Track` tag.** 313
albums span more than one disc and each disc restarts at 1, so numbering rows by
their position in the list ran *Music Bank* from 1 to 48. The 2,562 single-disc
albums get no heading at all.

The ordering needed the `Disc` tag too, which was not obvious: only **149** of
those 313 keep their discs in separate directories, so sorting on directory then
track number collapses to track number alone for the other 164 and interleaves
them — three tracks numbered 1, then three numbered 2. The sort is directory,
then disc, then track. That was caught in a screenshot of the panel, not by a
test, which is the second time that has been true of these screens.

**Each disc heading carries its own Play and Queue**, which is the same two POSTs
with a `disc` on the `AlbumRef` and one more filter pair on the same `findadd`.
Verified against MPD: `disc "1"`, `"2"`, `"3"` give 17 + 17 + 14 against 48 for
the whole of *Music Bank*, and it works for both layouts — Blur's *13* keeps all
27 tracks in one directory and still splits 13/14 by tag. A disc that does not
exist matches nothing rather than erroring, so a stale request is inert. It earns
its place on the big sets: the Dylan *Basement Tapes Complete* is 139 tracks over
six discs.

Adding an album is MPD's own `findadd` — one command, not a track at a time, which
would bump `queueVersion` once per track and make every client refetch the whole
listing a dozen times for one button press. Both POSTs answer **409 while a phone
owns the DAC**, exactly as `GET /api/queue` does.

### Album art

Every `Track` carries an `image` URI. It is **always present and may 404** — it is
derived from the song's path alone, so building a snapshot or a 130-track queue
listing touches the filesystem zero times. Resolution happens only when a browser
actually asks for the bytes; about 7.5% of this library's albums have no cover and
the client shows a placeholder.

**Keyed by album directory, not by track.** Measured on the real queue: **130
tracks resolve to 12 distinct art URIs.** So the browser fetches twelve images for
a full queue rather than a hundred and thirty, and a track change within an album
causes no refetch and no repaint — which matters here, because repaints on the DSI
panel are the vc4 commit path implicated in the clock deadlock.

A query parameter rather than a path segment, because album directories in this
library contain `!`, `&`, `#`, `(` and spaces; carrying that in a path means
encoding `/` as `%2F`, which proxies may normalise back.

**The bytes come from the filesystem, not from MPD.** MPD 0.24 has an `albumart`
command and it was the obvious first choice, but it only looks for `cover.*` —
86 files in this library against 3201 `folder.jpg`, about 1.4% coverage. Reading
the album directory directly gets **92.5%** (measured: 111 of 120 sampled dirs).
The alternative, `readpicture` for embedded art, would mean teaching the MPD
client to read binary replies, and that client matches replies to commands purely
by queue order with a timeout that destroys the socket — not a change worth making
for a 1.4% gain. Deferred deliberately.

Candidate filenames, in order: `cover.{jpg,jpeg,png}`, `folder.{jpg,jpeg,png}`,
`front.{jpg,png}`. **`discart`, `fanart`, `banner`, `logo` and `clearlogo` are
never chosen** — a naive "first image in the directory" would pick a discart,
which is a round disc image on a transparent background and looks broken as a
cover. There are 3795 of them here against 86 `cover.jpg`, so this ordering is
load-bearing and the tests assert it.

Cached twice: album directory → filename in memory (**including negative
results**, or the 7.5% with no cover would walk the candidate list over NFS on
every request), and `Cache-Control: public, max-age=604800` plus a weak `ETag`
from mtime and size, so a repeat visit revalidates with a `304` instead of
re-sending ~540KB.

No downscaling: covers here run 117KB–1.48MB against an 800×480 panel, but
resizing needs either `sharp` (a native module, which breaks the single-file
bundle and the one-dependency rule) or a slow pure-JS decoder. Measured cost of
serving the original over wifi: **866KB in 0.106s (8.2 MB/s)** — an order of
magnitude less painful than expected, so the per-album key plus a week of caching
is enough.

**The same endpoint serves artist pictures**, and that needed no new code. The
handler resolves a cover inside whatever library directory it is given, and this
library files a `folder.jpg` of the artist beside their albums exactly as it files
one of the sleeve beside the tracks — **473 of 487 artist directories have one,
measured**. So artist art is `/api/art?album=<artist directory>`: no new endpoint,
no new filename list, no second cache. The parameter is still spelled `album`
because renaming it would invalidate every cached URL in every browser for a week.

`MUSICBOX_MUSIC_ROOT` (default `/srv/music/Music`) **must match**
`music_directory` in `setup-mpd.sh`. If they drift, every art request 404s and
nothing else misbehaves — a miserable symptom to debug, so
`tests/test-server-config.sh` asserts the two literals are identical.

## Volume, and why there isn't any

This box feeds a preamp which feeds a power amp, both of which have volume
controls. So volume is handled downstream and the job here is to pass the purest
signal possible.

MPD runs **`mixer_type "none"`** — it reports `volume: n/a`, refuses volume
commands, and never writes to the DAC. `replaygain` and `volume_normalization` are
explicitly off, and `audio_output_format`/`samplerate_converter` are deliberately
unset so the file's native rate and depth go straight to `hw:0,0`. Verified: a
16-bit/44.1k FLAC arrives as `S16_LE / 44100`, a 24-bit one as `S24_LE`.

`musicbox-dac-unity.service` pins the gain stages at 0 dB on every boot and turns
`Deemphasis` off. It exists because once MPD stops managing those controls,
`alsa-restore` will happily reload whatever was last saved — one stray `amixer`
call would otherwise leave the box quietly attenuated forever. It costs 220ms and
finishes ~3s before MPD starts.

`Deemphasis` was found **enabled**. It is a fixed treble filter, correct only for
pre-emphasised recordings (a handful of early-80s CDs), so it is now off.

**To attenuate**, use the analog control — never digital:

```sh
amixer -c 0 sset Analogue 0      # -6 dB, costs no bits
amixer -c 0 sset Analogue 0dB    # back to unity
```

The web UI has no volume slider, and `POST /api/volume` no longer exists.

**Bluetooth was the first real test of that rule and did not break it.**
`bluealsa-aplay` runs `--volume=none` and the daemon runs `--a2dp-volume`, so the
phone attenuates *before* encoding and nothing on this box touches the signal or
the mixer. The phone's own slider is the volume control, which is the right answer
for that source — and it means `musicbox-dac-unity` has nothing to fight. The
`Snapshot` still carries no `volume` field.

## Mitigated, not proven fixed: the board deadlocked under sustained playback

Twice the box stopped playing while still looking healthy — `systemctl` reported
MPD `active (running)`, the network was up, ssh worked, and yet MPD answered
nothing and the panel was frozen. One incident had been running wedged for
**1h57m** before it was noticed.

The cause: two subsystems — the CPU frequency governor and the display stack —
both drive clocks through the Pi's single VideoCore firmware mailbox, serialised
by one global kernel clock lock. Under sustained concurrent use they deadlock on
it. Everything needing any clock then piles up behind them, unkillable: MPD's
audio output thread, the display pipeline, the GPU's power management. The last
incident stayed wedged for about **2h50m** until it was power cycled, which is the
only recovery.

The fix takes **two** changes, both applied by `setup.sh`, and the obvious one
alone does nothing:

1. `cpufreq.default_governor=performance` in `cmdline.txt`.
2. Shadowing Debian's `60-ondemand-governor.rules`, which forces `ondemand` on
   every CPU as udev settles and silently overwrites whatever the kernel chose.
   Measured: the parameter was present in `/proc/cmdline` and the governor was
   still `ondemand`.

`performance` sets the clock once at boot and then makes no further firmware
calls, so one of the two contending parties — the only one that fires on a timer
rather than following user activity — stops existing. It costs idle power and heat,
the CPU sitting at 1.5GHz instead of dropping to 600MHz. On a mains-powered
appliance that must not stop playing, that is the right trade.

It is **not proven fixed**: the kernel's own hung-task report named the *display*
worker as the lock owner, not the governor, and that inconsistency is unresolved.
If the deadlock can form between the display and GPU paths alone, this will not
prevent it. The diagnostic instrumentation stays on until a long soak has passed.
Full reasoning and evidence in `.claude/docs/clock-deadlock.md`.

Check the **governor**, not the cmdline:
`cat /sys/devices/system/cpu/cpufreq/policy0/scaling_governor` should say
`performance`. Not a power or heat problem, incidentally — `vcgencmd
get_throttled` reads `0x0`.

Do not switch the governor back to save power. The full trace, the reasoning and
the triage commands for telling this fault apart from the wifi one are in
`.claude/docs/clock-deadlock.md`.

A second, independent bug surfaced alongside it and is also fixed: the backend's
MPD client had a connect timeout but no **reply** timeout, so a wedged MPD — one
that accepts a connection and answers nothing — hung every request and took the
web UI down with it. Commands now carry a 10s deadline, so an unresponsive MPD
degrades to "MPD is not running" in the UI instead of killing the server.

## Known issue: wifi drops under sustained load

The Pi is on wifi at −65 to −75 dBm and repeatedly disappears from the network
while continuing to run fine locally — the panel keeps working, only the network
goes. Wifi power save has been disabled, which helped, but it is not fixed: a
third episode on 2026-09-12 logged **38** unreachable samples in 53 minutes at
−72 dBm, this time with playback **paused**, and it **recovered on its own**
without a power cycle. So it is neither load-dependent nor terminal, which points
at a plain weak-signal problem rather than a driver fault.

This is a **different** fault from the deadlock above, and the two were conflated
for a while. The quickest way to tell them apart: in this one the network is down
and the panel keeps rendering; in the deadlock the network is up and the panel is
frozen.

Full write-up, including the leads that turned out to be dead ends and the
diagnostic instrumentation currently on the device, is in
`.claude/docs/wifi-instability.md`. The two highest-leverage remaining options are
pinning the connection to 2.4GHz (the stronger AP here) or plugging in ethernet.

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
| `tests/test-kiosk-config.sh` | 60 tests of the generated kiosk artifacts, via `--emit`. Asserts every chromium flag, the four systemd lines that make or break the launch (`PAMName`, `TTYPath`, `Restart`, `Conflicts`), that the config file actually drives the URL, and that the generated wrapper passes `bash -n`. |
| `tests/test-hardware-config.sh` | 47 tests of the `config.txt` transform, via `--emit-config` / `--emit-revert`. Covers neutralising conflicting stock lines (duplicates in `config.txt` are not reliably last-wins), the overlay ordering requirement, idempotency, `--keep-hdmi`/`--skip-*`, and that revert restores the original byte-for-byte. |
| `tests/test-migrate-network.sh` | 25 tests of the netplan→keyfile conversion, via `--convert-only`, which touches no system state. Covers wifi/ethernet/static layouts, UUID preservation, the mandatory `0600` permissions, and that a PSK never leaks into an ethernet profile. |
| `tests/test-mpd-config.sh` | 53 tests of the generated MPD config, via `--emit`. Asserts `music_directory` is the nested `/srv/music/Music` and not the share root, that the ALSA output targets card 0 with the `Digital` hardware mixer (not `PCM`, which does not exist on a pcm512x), that `auto_update` is off, that no `bind_to_address` is set, and that the `/etc/default/mpd` block uses its own marker. Also round-trips the managed block against a fixture. |
| `tests/test-server-config.sh` | 60 tests of the web server units, via `--emit`. Asserts the server is **not** ordered after `mpd.service`, that port 80 comes from `CAP_NET_BIND_SERVICE` rather than root, the `.path`+one-shot restart pair, that the kiosk `Wants` rather than `Requires` the server, and that `dev-push.sh` never invokes sudo or `rsync --inplace`. |
| `src/backend` (`node:test`) | 25 backend tests: snapshot shape (no delta fields, queue by version), config precedence, static path traversal. Run by `run-all.sh` and by `tools/build.sh --check`. |
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
