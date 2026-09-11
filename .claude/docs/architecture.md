# Architecture

Five bash scripts in `install/`, run in a fixed order on a freshly-flashed
Raspberry Pi OS Lite (Trixie) image. Each owns one concern and one managed
block. Nothing here is a package or a service — the scripts are run by hand over
SSH and are safe to re-run.

## Run order

```
setup.sh            OS cleanup + boot tuning          (no hardware)
setup-hardware.sh   DAC+, DSI panel, touch, HDMI       reboot after
install.sh          apt packages for the music stack
setup-nas.sh        mount the music library            interactive
setup-kiosk.sh      cage + chromium on the panel       reboot after
```

`migrate-network.sh` is optional and out-of-band: it is only needed on an image
provisioned by Raspberry Pi Imager (cloud-init → netplan). It produced ~5.8s of
the 6.6s total boot saving, so in practice it is not optional at all.

## Who owns what

| Script | Owns | Marker |
|---|---|---|
| `setup.sh` | package purge, service/timer masking, `config.txt` boot tunables, `cmdline.txt`, EEPROM, fstab `noatime`/tmpfs/journald, `musicbox-bootreport` | `# >>> musicbox setup.sh managed block >>>` |
| `setup-hardware.sh` | `config.txt` hardware: DAC overlay, DSI overlay, touch backend, HDMI suppression | `# >>> musicbox setup-hardware.sh managed block >>>` |
| `setup-nas.sh` | one `/etc/fstab` entry + `/etc/musicbox/nas.credentials` | `# >>> musicbox setup-nas.sh managed block >>>` |
| `setup-kiosk.sh` | 4 files, `getty@tty1`, its own packages | (no shared file) |
| `install.sh` | `apt-get install` only | (none) |
| `migrate-network.sh` | `/etc/NetworkManager/system-connections/` | (none) |

Three of these write to `/boot/firmware/config.txt`. **Never let two scripts
share a marker** — `strip_managed_block` removes everything between the
delimiters, so a shared marker means one script silently deletes the other's
work.

## The managed-block pattern

Every multi-line edit is written between delimiters, so the edit can be found,
replaced, or removed without parsing the file:

```
# >>> musicbox <script> managed block >>>
...generated content...
# <<< musicbox <script> managed block <<<
```

Rules learned the hard way:

- The block is **appended after an explicit `[all]`** in `config.txt`. Stock
  images end with a `[pi5]` section; an unqualified append lands inside it and
  silently applies to the wrong model. The integration test fixture has a
  trailing `[pi5]` section specifically to catch this.
- **Duplicate keys in `config.txt` are not reliably last-wins.** Shadowing a
  stock setting does not work. `setup-hardware.sh` neutralises conflicting lines
  by prefixing them `#musicbox-hw# `, which is also how `--revert` finds them.
- `write_managed_block` must terminate the content with a newline
  (`printf '%s\n'`). Callers pass `"$(build_... )"` and command substitution
  strips the trailing newline — without this the closing marker is glued onto
  the last record. In fstab that produced a 12-field entry instead of 6.
- `cmdline.txt` is a **single line**; it is edited by token, never appended to.

## Per-script notes

### `setup.sh` (911 lines)

Seven phases; Phase 0 records a `systemd-analyze` **and** `vclog` baseline to
`/var/log/musicbox-setup/` before touching anything. Tunables at the top:
`MASK_APT_TIMERS=1`, `DISABLE_CLOUD_INIT=1`, `BOOT_ORDER=""` (empty = leave the
bootloader default alone).

cloud-init is only disabled once it reports `done` or `disabled` — disabling a
run in progress leaves the machine half-provisioned.

The EEPROM phase does not flash anything itself. It stages `pieeprom.upd` +
`recovery.bin` in `/boot/firmware`; the bootloader applies them at the *next*
boot and renames `recovery.bin` to `RECOVERY.000`. Verifying the change
therefore requires a reboot, and the reboot takes an extra cycle.

### `setup-hardware.sh` (400 lines)

Emits, in this order (the order matters — `vc4-kms-dsi-7inch` requires
`vc4-kms-v3d` to be loaded first):

```
[all]
dtoverlay=vc4-kms-v3d,nohdmi,noaudio
dtoverlay=vc4-kms-dsi-7inch,disable_touch
dtoverlay=rpi-ft5406
display_auto_detect=0
max_framebuffers=1
hdmi_ignore_edid=0xa5000080
hdmi_ignore_hotplug=1
dtparam=audio=off
dtoverlay=hifiberry-dacplus-std
```

`display_auto_detect=1` is what currently loads the DSI overlay on a stock
image; setting it to 0 without pinning the overlay leaves the panel dead. Both
are written in one atomic block, so this is satisfied by construction.

Flags: `--touch firmware|kernel`, `--keep-hdmi`, `--skip-dac`, `--skip-display`,
`--emit-config SRC DEST`, `--emit-revert SRC DEST`.

### `install.sh` (182 lines)

Currently installs `cifs-utils`, `nfs-common`, `smbclient` — both NAS clients,
because `setup-nas.sh` chooses the protocol interactively at run time and cannot
install anything itself. Its header carries the contract with `setup.sh` (the
automount rule, the hardware and kiosk handoffs); read it before adding
packages. MPD, Bluetooth, CD and web-UI packages are marked TODO.

### `setup-nas.sh` (488 lines)

Interactive: protocol → host (reachability-checked on 445/2049 first) →
credentials (SMB, `read -s`) → share discovery menu → mount point → **test mount
to a temp dir** → only then write anything.

```sh
LAZY_OPTS="noauto,x-systemd.automount,x-systemd.idle-timeout=600,_netdev,nofail"
SMB: ro,credentials=/etc/musicbox/nas.credentials,uid=0,gid=0,file_mode=0444,dir_mode=0555,iocharset=utf8,cache=loose,$LAZY_OPTS
NFS: ro,soft,timeo=50,retrans=3,$LAZY_OPTS
```

`soft` is not optional: a `hard` mount blocks processes forever when the NAS
disappears. `ro` throughout — MPD only reads, and it removes any chance of the
Pi damaging the library.

Spaces in share names and paths **must** be escaped `\040` (`fstab_escape`);
Synology shares routinely contain them.

`systemctl daemon-reload` *generates* the `.automount` unit from fstab but does
**not start it**. The script explicitly starts
`$(systemd-escape --path "$MOUNTPOINT").automount` afterwards, otherwise the
mount only works after a reboot and `ls` on the empty mountpoint looks like
success.

Credentials: `0600 root:root`, never echoed, never on a command line visible to
`ps`, never written into fstab.

### `setup-kiosk.sh` (453 lines)

Installs `cage` + `chromium` (the deliberate exception to rule 3) and writes
four artifacts:

| Path | Purpose |
|---|---|
| `/etc/musicbox/kiosk.conf` | `KIOSK_URL` + extra chromium flags |
| `/usr/local/bin/musicbox-kiosk` | launch wrapper |
| `/etc/systemd/system/musicbox-kiosk.service` | starts it at boot |
| `/usr/share/musicbox/kiosk/index.html` | touch-diagnostic holding page |

cage needs a logind session owning `seat0`. It gets one from `PAMName=login` +
`TTYPath=/dev/tty1` — no greeter, no display manager. `getty@tty1` is disabled
so the panel shows the UI, but `autovt@` is aliased so **Ctrl+Alt+F2 still gives
a login** on a plugged-in keyboard. Preserve that.

The wrapper passes `--mute-audio` because MPD is meant to own the DAC
exclusively; chromium holding the ALSA device would stop MPD starting. If the
web UI ever needs sound, the fix is a shared audio layer (dmix/PipeWire), not
removing the flag.

To point it at the real UI later:

```sh
sed -i 's|^KIOSK_URL=.*|KIOSK_URL="http://localhost:PORT/"|' /etc/musicbox/kiosk.conf
systemctl restart musicbox-kiosk
```

### `migrate-network.sh` (440 lines)

Moves NetworkManager connection storage from netplan YAML to native keyfiles.
`netplan.io` cannot be purged — `network-manager` depends on it on Pi OS — so
the *storage* moves and the package stays.

It rewrites the network config of the machine you are connected through, so it
backs everything up and arms a watchdog that reverts and reboots if the network
is still down after the next boot. `--finish` disarms it; `--revert` rolls back.

NM keyfiles are **silently ignored unless `0600`**. The tests assert this.
