# Architecture

Seven bash scripts in `install/`, run in a fixed order on a freshly-flashed
Raspberry Pi OS Lite (Trixie) image. Each owns one concern and one managed
block. Nothing here is a package or a service — the scripts are run by hand over
SSH and are safe to re-run.

## Run order

```
setup.sh            OS cleanup + boot tuning          (no hardware)
setup-hardware.sh   DAC+, DSI panel, touch, HDMI       reboot after
install.sh          apt packages for the music stack
setup-nas.sh        mount the music library            interactive
setup-mpd.sh        point MPD at the library + DAC
setup-server.sh     web server + API units
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
| `setup-mpd.sh` | `/etc/musicbox/mpd.conf` + one `MPDCONF=` line in `/etc/default/mpd` | `# >>> musicbox setup-mpd.sh managed block >>>` |
| `setup-server.sh` | `/etc/musicbox/server.conf` + three systemd units | (owns whole files) |
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

Installs `cifs-utils`, `nfs-common`, `smbclient` (both NAS clients, because
`setup-nas.sh` chooses the protocol interactively at run time and cannot install
anything itself) plus `mpd` and `mpc`. Its header carries the contract with
`setup.sh` (the automount rule, the hardware, MPD and kiosk handoffs); read it
before adding packages. Bluetooth, CD and web-UI packages are marked TODO.

`mpd` alone costs **118 packages** with `--no-install-recommends`. See
`decisions.md` for why that is accepted.

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

### `setup-mpd.sh`

Writes MPD's configuration. Installs nothing; dies pointing at `install.sh` if
`mpd` is missing.

**It does not touch `/etc/mpd.conf`.** Debian's unit is
`ExecStart=/usr/bin/mpd --systemd $MPDCONF` with
`EnvironmentFile=/etc/default/mpd`, and that file ships with
`# MPDCONF=/etc/mpd.conf` commented out. So the config lives at
`/etc/musicbox/mpd.conf` and a managed block in `/etc/default/mpd` points MPD at
it. The package conffile stays pristine, dpkg never prompts on upgrade, and
`--revert` is exact: strip one block, delete one file.

An `include` file does not work as an alternative — Debian's `mpd.conf` already
sets `music_directory` and `bind_to_address`, and MPD treats a redefined
parameter as a fatal duplicate.

The three settings that matter:

| | |
|---|---|
| `music_directory "/srv/music/Music"` | **not** `/srv/music` — the share root holds `#recycle` and Synology's `@eaDir` dirs |
| `mixer_type "none"` | **no volume control.** Volume is handled downstream by the preamp; MPD moving the pcm512x attenuator would discard bits |
| `auto_update "no"` | MPD's auto-update is inotify-based, and inotify cannot see changes made on the far side of an NFS mount |

It also installs `musicbox-dac-unity.service` (`Type=oneshot`,
`After=alsa-restore.service`, `Before=mpd.service`) which pins `Digital` and
`Analogue` at 0 dB and turns `Deemphasis` off. That unit exists because with MPD
no longer managing those controls, `alsa-restore` would faithfully reload whatever
was last written to `asound.state` — one stray `amixer` call and the box is
quietly attenuated with nothing to catch it. Measured at **220ms**, finishing ~3s
before `mpd.service` starts, so it costs nothing at boot despite being ordered
ahead of it.

An unreadable `/srv/music/Music` is a **warning, not a failure**. MPD is required
to tolerate an absent library and pick it up on first access; refusing to
configure would contradict the whole point of the lazy automount.

No `bind_to_address` is set: Debian enables `mpd.socket`, which passes listening
sockets in, and binding as well risks a double bind.

The script does not run the first scan — 49,711 files over NFS is minutes, and
burying it in a config script makes a re-run look hung. It prints
`time mpc update --wait` instead.

### `setup-server.sh` + the application

One Node process serves the Angular build **and** the API that bridges it to
MPD. The repo splits source from committed build output:

```
src/backend/   Fastify + TypeScript   --esbuild-->  backend/server.js   (one file)
src/frontend/  Angular workspace      --ng build->  frontend/           (hashed)
src/shared/    api.ts — the wire format, imported by BOTH sides
```

`src/shared/api.ts` is the single definition of the contract; change it and both
sides stop compiling until they agree. That is the whole reason the stack is
TypeScript end to end.

**Runtime dependencies: one.** Fastify. Static serving and the MPD protocol are
hand-written (~150 lines each) so the bundle has no dynamic requires and the Pi
needs no `node_modules`. `nodejs` is 12 apt packages; `npm` is 363 and is never
installed on the device.

#### Three units, and why

| Unit | |
|---|---|
| `musicbox-server.service` | the server |
| `musicbox-server-restart.service` | `Type=oneshot`, runs `systemctl restart` |
| `musicbox-server.path` | watches `backend/server.js`, triggers the shim |

A `.path` unit can only *start* a unit, and the service is already running — so
restarting on deploy needs the one-shot in between. The payoff is that a deploy
is just an rsync: **no sudo anywhere in the dev loop.**

#### The ordering that costs real money

```
musicbox-server.service   NO After=mpd.service, NO After=network.target
musicbox-kiosk.service    After=musicbox-server.service  (Wants, not Requires)
```

`mpd.service` takes ~6s and is on the critical path; ordering behind it would
add that for nothing. `network.target` is not reached until NetworkManager
starts (~6s here) and binding `0.0.0.0` needs no interface up first. Measured:
the server starts from `basic.target` at **5.4s** and adds **0s** to boot.

MPD being absent is handled in the app, not by systemd — two connections, each
reconnecting with backoff, reporting `status: "unavailable"` meanwhile. Observed
on a real boot: the first attempt times out because MPD has not started yet, and
it reconnects a second later.

**The command connection pings every 20s.** MPD closes a connection that sends
nothing for `connection_timeout` (default 60s), and the command connection is
otherwise silent — without the keepalive MPD hung up roughly once a minute. The
idle connection needs none: it is blocked in `idle`, which MPD exempts.

**Reporting `unavailable` is delayed by 3s.** Reconnecting takes ~500ms and
`systemctl restart mpd` about 2s; surfacing either as an error is worse than
briefly showing slightly stale state. A real outage still surfaces.

**Shutdown must end the SSE streams first.** Fastify's `close()` waits for open
connections and an SSE stream never finishes, so a single connected client — the
kiosk always has one — wedges shutdown until systemd gives up. The app ends them
on SIGTERM, `forceCloseConnections` destroys the rest, and `TimeoutStopSec=10`
bounds it.

The kiosk `Wants` the server rather than `Requires` it, so a broken server still
leaves a panel that can say so instead of a black screen.

#### Port 80 without root

`AmbientCapabilities=CAP_NET_BIND_SERVICE`, running as the existing `musicbox`
user — forced by `/home/musicbox` being `0700`, which a dedicated service user
could not read. `ProtectHome` is therefore deliberately unset.

#### The API

SSE for state, REST for commands. **Every event is a complete snapshot, never a
delta**, so a dropped event costs nothing and the client never reconciles. The
queue is referenced by `queueVersion` rather than embedded — with 37,289 songs,
embedding it would mean megabytes of JSON on every volume nudge.

Three fields describe the queue without carrying it: `queueVersion` (refetch when
it changes), `queueLength`, and `queuePosition` — the 0-based index of the
current track, read from MPD's `status` rather than from the track, so it stays
correct when `currentsong` returns nothing. Use it to highlight the playing row
in a queue listing; use `track.id` instead if you need a handle that survives
the queue being reordered.

Elapsed time is interpolated client-side; MPD does not push progress
continuously and polling for a smooth progress bar is the wrong answer. The
client interpolates from **its own receive time**, not `serverTime`, so a phone's
clock never has to match the Pi's — which is only sound because **the server
sends a freshly queried snapshot** on SSE connect and on `GET /api/status`.
Handing a new client the cached snapshot instead made a page reload display the
elapsed time as at the last MPD event. Tests assert the refresh happens before
the first frame.

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
