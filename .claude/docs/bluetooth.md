# Bluetooth audio (A2DP sink)

A phone pairs with no prompt, connects, and plays through the HiFiBerry DAC. The
now-playing screen shows what the phone is playing and the transport buttons
control it; a Disconnect button hands the speaker back to MPD.

Installed by `install/setup-bluetooth.sh`. Start here for anything Bluetooth, and
read the "one hard constraint" section below before changing how the audio path
is started — it is the part that is easy to break and hard to notice.

## The one hard constraint: `hw:0,0` is exclusive

MPD opens the DAC raw — no dmix, no sound server — because that is what makes the
bit-perfect passthrough measured in `device.md` true. So exactly one of MPD and
Bluetooth can hold the card, and **both directions of the handoff race**:

```
a phone connects   bluealsa-aplay opens hw:0,0 while MPD still has it
play is pressed    MPD opens hw:0,0 while bluealsa-aplay still has it
```

`bluealsa-aplay` has **no retry** when the device is busy (confirmed absent from
its man page, not assumed). It opens, gets `EBUSY`, and exits. So the handoff has
to be sequenced explicitly: release, wait for the card to actually go quiet, then
acquire. "Asked the other side to stop" is not the same as "it has stopped".

`/usr/local/bin/musicbox-bt` is the single component that does this, and it is the
**only thing permitted to start `musicbox-bt-audio.service`**. Two consequences
that look odd until you know why:

- `musicbox-bt-audio.service` has **no `[Install]` section**. It cannot be
  enabled. That is deliberate.
- Debian's own `bluealsa-aplay.service` is **masked**, not disabled — a disabled
  unit can still be pulled in by a dependency. It would open the card the moment
  a transport appeared and lose the race.

## Why the arbiter is not in the web server

The backend owns MPD and publishes the snapshot, so it looks like the natural
home. It is not:

- The handoff must keep working while the server is being redeployed, and when
  someone drives MPD with `mpc` directly. Playback correctness must not depend on
  the web UI being alive.
- Starting units and calling `org.bluez.Device1.Disconnect` need privilege the
  server does not have. Granting it would mean a D-Bus policy file and the first
  `child_process` call in the backend.

So the split is: **the root arbiter decides, the server observes and requests.**
The arbiter publishes `/run/musicbox/bluetooth.json`; `src/backend/src/bluetooth.ts`
reads it. A bug on the server side can make the UI wrong; it cannot make the audio
wrong.

### The control channel

Transport control is a UI action, so the server does have to originate it. It
writes one word into a FIFO at `/run/musicbox/control` (root:musicbox, 0620) and
the arbiter acts on it. Not a subprocess, for three reasons:

- it would be the first `child_process` in the backend, and the test suite asserts
  there is none — precisely so a bug there cannot reach the audio path;
- `disconnect` has to be the arbiter's decision anyway, because it hands the DAC
  back, so a channel is needed either way;
- the arbiter already knows which device is connected, so the server never has to
  learn D-Bus object paths.

The server's own user *could* call BlueZ directly — the shipped policy has
`<policy context="default"><allow send_destination="org.bluez"/>` — so this is a
deliberate choice, not a limitation.

**Two details that are load-bearing:**

- **The arbiter holds the FIFO open itself** (`exec 9<>`). `cat` on a FIFO returns
  EOF when the last writer closes, so without our own descriptor every command
  would end the feed and the restart loop would leave a two-second window where
  the next button press gets `ENXIO` — intermittently dead buttons.
- **The server opens it with `O_NONBLOCK`.** Opening a FIFO for writing otherwise
  blocks until a reader appears, so on a box with no arbiter a button press would
  hang the request instead of answering 503.

### What the phone is playing: AVRCP

`org.bluez.MediaPlayer1` on `/org/bluez/hciN/dev_<addr>/playerM` gives `Status`,
`Position`, and a `Track` dict of Title/Artist/Album/Duration/TrackNumber/
NumberOfTracks, plus `Play`/`Pause`/`Stop`/`Next`/`Previous` methods.

**Polled at 1Hz, not subscribed.** Every property is `emits-change`, so
`busctl monitor` would be the event-driven answer — but it needs
`org.freedesktop.DBus.Monitoring`, which is denied to non-root and is worth not
depending on even as root. The poll only runs while a phone is connected.

**Published only on change.** Rewriting the state file every second would push an
SSE frame to every client and repaint the panel at 1Hz, and repaints here go
through the vc4 commit path that has hard-locked this board. Position is
deliberately excluded from the change signature: the client interpolates it,
exactly as it does for MPD.

**Parsed with python3, not sed.** busctl nests every value as
`{"type":...,"data":...}`, and the obvious sed for it truncates at the first comma
or quote inside a song title — which is most of them. One `GetAll` call plus one
python3 invocation per poll; `python3` is in the base image and preflight checks
for it.

`tests/test-bluetooth-config.sh` asserts that independence — the monitor unit is
neither ordered after nor wanted by `musicbox-server.service`, and the backend
contains no `child_process` call.

## The handoff, both directions

```
A PHONE CONNECTS                       MPD STARTS PLAYING BY ANY OTHER ROUTE
  bluealsa-cli monitor: PCMAdded         mpc idleloop player fires
  publish the device (codec unknown)     bluetoothctl disconnect <addr>
  mpc pause          <- not stop         systemctl stop musicbox-bt-audio
  wait for the CARD to go quiet          wait for bluealsa-aplay to be GONE
  systemctl start musicbox-bt-audio      mpc disable 1 && mpc enable 1
  read the codec, publish again          mpc play
                                         publish {}

DISCONNECT IS PRESSED IN THE UI       A SECOND PHONE CONNECTS
  POST /api/bluetooth/disconnect        bluealsa-cli monitor: PCMAdded, new addr
    -> "disconnect" into the FIFO       take_over_from: disconnect the incumbent
  bluetoothctl disconnect <addr>        stop the audio unit
  release_bluetooth: stop the audio     wait for bluealsa-aplay to be GONE
    unit, publish {}                    wait for the OLD TRANSPORT to be gone
  MPD IS NOT TOUCHED — it stays         take_for_bluetooth, as on first connect
    paused where it was                 MPD IS NOT TOUCHED — already paused
```

**Pressing play no longer takes the speaker back.** It controls the phone, which
is what the button appears to mean. The right-hand column above still exists, and
still ends with `mpc play`, because MPD can be started from `mpc` or another
client — but the UI's route out is now the explicit Disconnect button.

**The two waits are asking different questions, and conflating them is a bug I
shipped once.** Going to Bluetooth, MPD has to genuinely let go, so waiting on
the card's `state:` is right. Coming back, *MPD is the one that should end up
holding the card* — so waiting for it to be free waits for the wrong thing,
times out after 5s, and then fires a corrective action at a box that was about to
be fine. The only precondition there is that **our** player has exited.

**And MPD has already failed by the time the arbiter reacts.** Measured on the
device: told to play while bluealsa held the card, MPD logs
`exception: Failed to open audio output` and **pauses itself**. So freeing the
card is not enough — the `mpc play` at the end is doing real work. Without it the
user presses play, gets silence, and the UI shows paused.

That `mpc play` is not a violation of the no-auto-resume rule below: that rule is
about a phone wandering off on its own. Here the user explicitly asked to play.

**`pause`, not `stop`.** It keeps the queue position, so the panel's play button
resumes in place rather than restarting the track.

**MPD is never auto-resumed** when the phone goes away. A phone running out of
battery or leaving the house must not start the speaker playing to an empty room.

**The `mpc disable 1 && mpc enable 1` is load-bearing**, and was measured rather
than assumed: MPD caches the failed open and does not retry promptly. Verified by
hand on the device — a toggle followed by `mpc play` resumed a stuck MPD at its
saved position in about 1.5s, where doing nothing left it paused indefinitely.

## A second phone takes the speaker

**The newest connection wins.** A second phone connecting disconnects the first
and takes the DAC. There is no sharing to arrange — `hw:0,0` is exclusive, so the
only question is which phone holds it, and the one somebody just connected is the
one that means it.

What it replaced was worse than a missing feature. The second phone was dropped on
the floor at `handle_bt`'s `PCMAdded` arm: connected as far as BlueZ, holding a
transport as far as BlueALSA, and entirely invisible to the arbiter — no log line,
no publish, no audio. `bluealsa-aplay --single-audio` was then choosing between two
PCMs by its own rules rather than ours, which is what "Bluetooth is a bit flaky"
turned out to mean.

**`PCMRemoved` now compares the address, and that is load-bearing twice over.** It
did not before, which was a bug on its own: a second phone that connected and left
stopped the audio unit and published `{}` while the *first* phone was still
connected and playing — the log even named the wrong device. It is also what makes
the takeover survivable, because the evicted phone's own `PCMRemoved` is still
queued behind it and arrives after the newcomer has taken over. Without the
comparison every takeover would cancel itself a moment after it happened.

**Three waits, three different questions.** `take_over_from` uses two of them:

| | |
|---|---|
| `wait_for_dac` | has the current owner let go of the card? |
| `wait_for_aplay` | has *our* player exited? |
| `wait_for_pcm_gone` | has the outgoing phone's transport actually left BlueALSA? |

The third is new and specific to the takeover. `bluealsa-aplay --single-audio`
picks which PCM to play by itself, so restarting it while the evicted phone's
transport still exists can reattach it to the phone we just disconnected — the
newcomer connects and the old one keeps playing. `bluetoothctl disconnect`
returning is not the same as BlueZ having torn the transport down.

**It does not go through `release_bluetooth`**, which is the obvious thing to reach
for. That publishes `{}`, which would flash "disconnected" on the panel in the
moment before the newcomer publishes itself, and re-asserts the adapter, which is
for a session ending rather than for one phone handing over to another.

**There is no reconnect cooldown.** An evicted phone that auto-reconnects has made
a new connection and legitimately wins. Guarding against a ping-pong between two
phones that both retry was considered and left out: it is speculative, and a
timer that silently refuses a connection the user just made is worse than the
behaviour it prevents. Revisit if it is ever actually observed.

`ctl_disconnect` and `take_for_mpd` still disconnect only `$ACTIVE_ADDR`. With at
most one A2DP device connected at a time that is correct by construction, and
enumerating every connected device would be more BlueZ surface for no measured
gain.

`tests/test-bluetooth-config.sh` drives `handle_bt` for real for this — sourcing
the generated arbiter with recording stubs on `PATH` — because both of the bugs
above lived in its decisions rather than in its words.

**NOT YET MEASURED ON REAL HARDWARE.** The arbiter is deployed and the stubbed
event sequence is proven, but no two-phone takeover has been timed on the device.
Everything else in this file carries a figure; this does not, and the gap is the
point — several confident predictions in this project were wrong on the real
board. What to record when it is exercised: the time from the second phone's
`PCMAdded` to audio actually coming out of it, whether the panel flashes anything
between the two devices, and whether `wait_for_pcm_gone` ever hits its 5s timeout
(if it does, the transport teardown is slower than the budget and the timeout is
the number to revisit, not the design).

## There is no cover art, and that is settled

The phone advertises **AVRCP 1.6**, which does specify Cover Art — so this was
worth checking properly rather than assuming. `sdptool browse` on the phone:

```
AV Remote Control          (0x110e/0x110f, phone as controller)  Version 0x0104
AV Remote Control Target   (0x110c,        phone as target)      Version 0x0106  <- 1.6
  Protocol Descriptor List: L2CAP PSM 23, AVCTP 0x0104
  Profile Descriptor List:  AV Remote 0x0106
  ...and nothing else
```

Two independent blockers, either of which is fatal:

- **The phone advertises 1.6 but not the Cover Art feature.** Cover art is fetched
  over a *separate* OBEX/BIP channel, which the target must advertise as an
  `AdditionalProtocolDescriptorList` carrying an OBEX PSM inside the AVRCP Target
  record. There is no such list and no OBEX PSM; the only OBEX services the phone
  offers are Phonebook Access and Object Push, which are unrelated.
- **BlueZ 5.82 implements none of it.** `strings` on `bluetoothd`: `thumb` 0
  matches, `bip` 0 matches, and all 116 `cover` matches are "Discover" or
  "Recovery". No image handle ever appears in the `Track` dict, and
  `MediaPlayer1` exposes no API to retrieve one. `obexd` is not installed.

So it is not a configuration problem — it would mean patching `bluetoothd`.
Devices that do show art are generally on Android Auto or CarPlay, which are not
Bluetooth.

**Borrowing a cover from the local library was considered and rejected.**
`MpdBridge.find()` makes it easy — match AVRCP's artist and album, use that
album's cover — and it works on the first thing tested (`mpc find artist
"Black Sabbath" album "Sabbath Bloody Sabbath"` returns all 8 tracks, and the
directory has `folder.jpg`). It is not wanted: a phone's metadata is free text,
and a near-miss would put a confidently wrong cover on the panel. **A missing
cover is obvious; a wrong one is misinformation.** `find()` stays dead code, and
the test suite asserts no Bluetooth path reaches it or `artUriFor`.

## Codecs

**There is no AAC, and that is not a stack choice.** Debian's `bluez-alsa` is not
linked against `libfdk-aac` because it is non-free — and neither is
`libspa-0.2-bluetooth`, so PipeWire offers exactly the same sink codecs. Both
depend on `libfreeaptx0`, `libsbc1`, `liblc3-1`, `libldacbt-enc2` and no fdk-aac.

The sink ladder is therefore:

| | |
|---|---|
| **aptX HD** | Android with a Qualcomm radio |
| **aptX** | older Qualcomm |
| **SBC-XQ** | everything else, including iPhones |
| **SBC** | the mandatory floor |

**LDAC is irrelevant here.** Debian ships the encoder only, and no open-source
LDAC *decoder* exists — a sink cannot use it. Asking for it would be cargo cult.

**Fallback is not code.** As a sink we advertise capabilities and the phone picks
from them; A2DP negotiation does the degrading. Nothing in this repo chooses.

`bluealsa` enables **only SBC** by default, so `-c aptX -c aptX-HD` in
`/etc/default/bluez-alsa` is doing real work. Delete it and the expensive codec
support silently does not happen — which is why the test suite asserts those flags
on the actual `OPTIONS=` line rather than anywhere in the file.

**Getting AAC would mean rebuilding `bluez-alsa` against `libfdk-aac2t64`**
(which *is* in trixie/non-free). That was considered and declined: the dev machine
is x86_64 so it needs a cross or emulated build, and the result is a pinned local
`.deb` that apt will never update, for a codec library with a security history.
Revisit only if an iPhone actually sounds bad in use.

## Volume

Nothing on this box attenuates, and Bluetooth does not change that.
`--a2dp-volume` on the daemon plus `--volume=none` on `bluealsa-aplay` means the
**phone attenuates before encoding** and the local mixer is never touched. The
phone's own slider is the volume control.

The alternative — BlueALSA's software volume — would attenuate a second time and
fight `musicbox-dac-unity.service`, which exists precisely to stop anything
quietly pulling the gain stages down (`decisions.md`).

## Pairing is open

Always discoverable, always pairable, just-works pairing via
`bt-agent --capability=NoInputNoOutput`. The box has no keyboard and no way to
display a passkey, so there is no other option that still works.

**Anyone in radio range can pair with it.** That is commodity-speaker behaviour
and a deliberate choice, not an oversight. If it ever matters, the answer is a
UI-gated pairing window: discoverable for ~2 minutes after a button press, with
already-paired devices still reconnecting freely.

`Class = 0x240414` (Audio + Rendering service, Audio/Video major, Loudspeaker
minor) is what makes a phone offer to pair with it as a speaker. Without it the
adapter advertises class `0` and looks like a generic peripheral.

## The radio was soft-blocked

Found on the real box, and the reason Bluetooth appeared dead despite the hardware
being fine:

```
/sys/class/rfkill/rfkill0/soft = 1
bluetoothd: Failed to set mode: Failed (0x03)
bluetoothctl show -> Powered: no, PowerState: off-blocked
```

Nothing in this repo set it. `setup-bluetooth.sh` clears it through sysfs, because
the `rfkill` command is not installed; systemd-rfkill then persists the new state
across reboots. The scan is **by type, not by index** — rfkill numbering is not
stable, and `rfkill0` being Bluetooth on this board today is not a contract.

A **hard** block is reported and left alone: it is a physical switch and no amount
of software will clear it.

## Triage

```sh
# Is the radio actually on?
bluetoothctl show                      # want Powered: yes, Discoverable: yes, Class: 0x240414
cat /sys/class/rfkill/*/type /sys/class/rfkill/*/soft

# What does the arbiter think is connected?
musicbox-bt status
journalctl -u musicbox-bt -f

# Which codec was actually negotiated?
bluealsa-cli list-pcms --verbose       # Transport / Format / Selected codec
a2dpconf <hex blob>                    # decodes an A2DP capability blob

# Measured on a Pixel 8 Pro (2026-09-13):
#   /org/bluealsa/hci0/dev_.../a2dpsnk/source
#   Transport: A2DP-sink   Format: S24_LE   Selected codec: aptX-HD
# NOTE the path is a2dpsnk/source, NOT a2dpsrc/sink as you might guess from "the
# phone is the source". The arbiter matches on *a2dp* precisely so it does not
# depend on getting that the right way round.

# Who holds the DAC? There must never be two.
cat /proc/asound/card0/pcm0p/sub0/status
fuser -v /dev/snd/*

# What is the phone reporting right now?
busctl --json=short call org.bluez /org/bluez/hci0/dev_<ADDR>/player0 \
    org.freedesktop.DBus.Properties GetAll s org.bluez.MediaPlayer1

# Drive the UI without a phone, metadata and all.
musicbox-bt publish "Test Phone" AA:BB:CC:DD:EE:FF "aptX HD"
musicbox-bt publish "Test Phone" AA:BB:CC:DD:EE:FF aptX-HD playing \
    "Title" "Artist" "Album" 357093 91000 4 8 off off
musicbox-bt publish                    # back to disconnected

# Is the control channel healthy?
ls -l /run/musicbox/control            # want prw--w---- root musicbox
printf 'pause\n' > /run/musicbox/control   # as the musicbox user; should just work
```

`musicbox-bt publish` is a debug hook, not part of the handoff — it writes the
state file and nothing else, so the arbiter will overwrite it on the next real
event.

## Known risks

- **Wifi and Bluetooth share the BCM43455.** This box already has an unresolved
  network-dropout problem (`wifi-instability.md`), and sustained A2DP is a
  plausible aggravator. Watch `musicbox-netwatch` during any long Bluetooth
  session before concluding anything.
- **The clock deadlock's blast radius.** The captured trace has
  `bcm2835_i2s_start_clock -> clk_prepare` as a victim (`clock-deadlock.md`).
  Every handoff opens and closes the I2S clock, so this path now runs more often
  than it used to. A hang during a source switch is that fault until proven
  otherwise.
- **Bit-perfect playback is unaffected** — because the two never run together.
  The guarantee in `device.md` is about MPD's path, which is untouched. A
  Bluetooth stream is whatever the phone encoded, at 44.1 or 48kHz. Do not claim
  otherwise.

## Measured on the device (2026-09-13)

```
forward handoff, real Pixel 8 Pro   connect -> MPD paused, card handed over, codec
                                    published in two stages ("pending", then aptX-HD)
reverse handoff, same phone         POST /api/playback/play -> 3.16s -> MPD playing,
                                    phone disconnected, bluealsa-aplay gone.
                                    Twice, at 12:51:37 and 12:54:10.
negotiated codec                    aptX-HD, Format S24_LE
MPD position across a handoff       preserved both ways (paused 0:40 -> resumed 0:40)
UI latency, state file -> /api      100ms on connect, 125ms on disconnect (inotify)
                                    up to 10s when the watch failed to arm (below)
MPD releases hw:0,0 on pause        within 100ms
```

**3.16s is the honest figure for pressing play**, measured end to end from the
POST to `/api/status` reporting `mpd play`. Most of it is BlueZ tearing the
connection down; the arbiter's own log shows 2s from "disconnecting" to
"MPD has hw:0,0".

```
AVRCP metadata, real Pixel 8 Pro    Status/Position/Title/Artist/Album/Duration/
                                    TrackNumber/NumberOfTracks all present
AVRCP control                       Play, Pause, Next all confirmed acting on the
                                    phone (arbiter logs "AVRCP Next", track 4 -> 5)
AVRCP status propagation            2-6s from command to Status changing. The UI
                                    does NOT guess in the gap; see below.
API during a session                source=bluetooth, state from the phone,
                                    queueVersion -1, queueLength 8, queuePosition 3,
                                    track.image null, track.file absent
GET /api/queue during a session     409
```

**The propagation lag is the one thing a user will notice.** A press of pause
takes a few seconds to show as paused. There is deliberately no optimistic local
update: guessing would state the wrong thing confidently whenever a phone ignores
a command, and phones do ignore them.

**Four things that only showed up on real hardware**, all now covered by tests:

1. **The options were going to a file nothing reads.** Debian's
   `bluealsa.service` has no `EnvironmentFile` and a hardcoded `ExecStart`, so
   `/etc/default/bluez-alsa` is a decoy — the daemon ran with none of the codec
   flags while every config assertion passed. It is a systemd drop-in now.
2. **The web server starts before the arbiter creates `/run/musicbox`**, so its
   first `fs.watch` fails with ENOENT. It was not retried, so the feature silently
   ran on 10-second polling forever — which reads as "the UI is a bit slow", not
   as a bug. The poll now re-arms the watch; at boot that costs one poll interval.
3. **`apt` both enables and starts `bluealsa-aplay.service`, and `systemctl mask`
   does nothing to a running instance.** A stale `bluealsa-aplay -S` was left
   running after masking, competing for the DAC until the next reboot. The script
   now stops and disables it before masking.
4. **`RuntimeDirectory` is deleted and recreated on every restart of its unit**,
   so restarting the arbiter replaced `/run/musicbox` and left the server's
   inotify watch on a dead inode. The arbiter published a perfect state file and
   the API reported nothing — the slow poll was the only thing still working,
   which reads as "a bit laggy" rather than as a dead mechanism. Fixed on both
   sides: `RuntimeDirectoryPreserve=yes`, and the server re-arms when the
   directory's inode changes. Same trap as the rename, one level up.

Also observed once and not reproducible: `bluetoothctl pairable on` segfaulted.
Harmless — the arbiter deliberately has no `set -e` — and the call was redundant
anyway, since `AlwaysPairable = true` in `main.conf` owns pairability. It has been
removed rather than worked around.

Both directions have since been exercised against the real phone, including the
reverse handoff's fix (waiting on the player rather than on the card, and the
closing `mpc play`).
