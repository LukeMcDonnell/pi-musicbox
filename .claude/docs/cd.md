# CD audio

An audio CD in the USB drive shows up on the home screen with Play and Eject.
With **Play CDs when inserted** on (System settings, default on) it starts by
itself. With **Look up CDs online** on (default on) it is named from MusicBrainz
and gets its cover from the Cover Art Archive; otherwise it is "Track 1..N".

Installed by `install/setup-cd.sh`.

## MPD plays the disc

`cdda:///N` through MPD's built-in `cdio_paranoia` input (listed by
`mpd --version` on the device, 0.24.0). That settles the DAC question the roadmap
raised before it starts: **MPD stays the only thing that opens `hw:0,0`**, so
there is no new handoff. A disc playing while a phone is connected is just "MPD
started playing", which `musicbox-bt` already answers by disconnecting the phone
(`bluetooth.md`). The only system change it needs is `mpd` joining `cdrom` —
`/dev/sr0` is `root:cdrom 0660` and `mpd` was only in `audio`. MPD takes groups at
startup, so `setup-cd.sh` restarts it once, only when the membership changed.

`source: 'cd'` is derived, not stored: the snapshot says `cd` whenever MPD's
current song is a `cdda://` URI. `Snapshot.cd` separately says whether a disc is
in the drive, whatever is playing — that is what the home card reads.

Play replaces the queue, like Play on an album. Removing the disc deletes its
tracks from the queue; they cannot play once it is gone.

## Same split as Bluetooth: the helper observes, the server requests

`/usr/local/bin/musicbox-cd` (unit `musicbox-cd.service`) publishes
`/run/musicbox-cd/cd.json` — `{"present":true,"tracks":N}` or `{"present":false}`
— and reads `eject` from `/run/musicbox-cd/control`. `src/backend/src/cd.ts`
watches the file with the same machinery as Bluetooth (`state-file.ts`). The
backend cannot eject itself: no `child_process`, and Node cannot issue the ioctl.

It runs as `musicbox` with `SupplementaryGroups=cdrom`, not root — reading udev
events needs nothing and eject needs only `cdrom`. Its own `/run/musicbox-cd`
rather than `/run/musicbox`, which is `musicbox-bt-monitor`'s `RuntimeDirectory`:
two units owning one directory is the dead-inode trap from `bluetooth.md`.

## Auto-play fires only on a real insertion

Only an explicit `present:false -> present:true` counts. The server's first read
after it starts is a baseline, so **a redeploy with a disc in does not restart
it**. For the same reason the helper *deletes* its state file on exit rather than
publishing "no disc": a helper restart then reads as unknown -> present, not as
an insertion. `cd-autoplay.ts` holds the rule; its tests are named for it.

## Durations, titles and covers

**Durations come from the disc itself.** The helper reads the table of contents
with a `python3` ioctl (`CDROMREADTOCHDR`/`CDROMREADTOCENTRY` — bash cannot, and
python3 is on the base image) and publishes the frame offsets in `cd.json`.
`cd-toc.ts` turns them into lengths — MPD knows a `cdda://` track's length only
once it plays — and skips data tracks, so an Enhanced CD or a disc with a leading
data track is numbered by its real audio tracks.

**Titles are an exact MusicBrainz disc ID match, or nothing.** The ID is the
libdiscid SHA-1 over the TOC (`cd-toc.ts`; test vector is *Ten*). The fuzzy
`?toc=` search is deliberately not used: a near miss is a wrong title shown
confidently. A matching library album is not used either — *Ten* is in the library,
but as a different release, and matching by release group would put a deluxe
cover on a plain CD.

**Which pressing.** A disc ID usually matches several releases (*Ten*: US, AU, DE,
GB). They share a tracklist by construction, so only the cover differs: the first
with a front cover wins, then MusicBrainz's order. The medium used is the one whose
`discs[]` holds this ID, so disc 2 of a set gets disc 2's titles.

**Sent where:** the disc ID to `musicbrainz.org` (User-Agent
`musicbox/<build> ( repo URL )`, at most one request a second), then
`coverartarchive.org/release/<mbid>/front-500`. Nothing when the setting is off.

**Cached.** `cd_disc` (v9) keeps each answer — found forever, not-found for a
week, network failures not at all (retried after 1, 5, 15, 60 minutes while the
disc stays in). Covers are files in `/var/lib/musicbox/data/cd-art/<mbid>.jpg`,
served at `/api/cd/art`; the table is in backups, the covers have their own
archive (`/api/cd/art/backup`, `cd-art-backup.ts`) and are re-fetched if lost. A re-inserted disc is named instantly and offline.

**The disc is published before the lookup finishes**, with `lookup: 'pending'`,
and auto-play does not wait for it; titles arrive while it plays. The queue's rows
change without MPD's queue version moving, so clients refetch on the disc's lookup
state too (`musicbox-api.ts`).

## Worn discs: paranoia is off

MPD's `cdio_paranoia` input defaults to **full paranoia** (`mode_flags =
PARANOIA_MODE_FULL^PARANOIA_MODE_NEVERSKIP` in 0.24.4), which re-reads a
damaged region up to 20 times. That is ripping behaviour. `setup-mpd.sh` sets
`input { plugin "cdio_paranoia" mode "disable" }`: plain reads, and the drive
conceals what it cannot read, as a CD player does. A scratch may click, but
playback never stalls.

Measured 2026-09-30 on a worn 17-track disc (bad patch in track 1 near 1:16).
Each run: restart MPD, play track 1, sample elapsed over 60s of wall clock,
then `next` and `stop`:

```
mode       elapsed after 60s        "too slow"   next    stop
full       0:17 (from 0:00)         4            3.5s    30s TIMEOUT
             and earlier: 1:16 -> 1:22 over several minutes, output playing silence
disable    0:54 (from 0:00)         0            2.6s    2.4s
           1:05 -> 2:02 (across the bad patch)  0
disable+speed 4  0:53               0            2.6s    2.4s   (no gain; not set)
overlap    0:50 (from 0:00)         0            6.1s    0.5s
           1:05 -> 1:57             0            (~7s to first audio: slower start)
```

Under full paranoia, `strace` on MPD's `decoder:pcm` thread showed a steady
`ioctl(CDROM_SEND_PACKET)` every ~68ms, all succeeding, with no `sr0` errors in
`dmesg`. It was the re-reading, not the drive, that stalled playback.

Listened to on the same disc with `disable`: a few clicks through the bad patches,
no stalls.

## Skip latency: a preload for mpd

A skip took ~3s to return, and ~4s to first sound. The kernel's SCSI tracepoints
(below) showed two causes. Both are inside libcdio, and no MPD setting reaches
them. `native/cdio-latency.so` (source `src/native/`) is `LD_PRELOAD`ed into mpd
by `setup-cd.sh`'s drop-in. The first two changes below alter no audio. The third
turns sectors the drive cannot read into silence (see "Bad sectors").

- **The byte-order probe.** `data_bigendianp()` guesses the drive's byte order by
  reading the start of tracks 1–5, with a 150–250ms seek each. `cdio_cddap_open()`
  runs it and MPD then runs it again, on every track open: ~2.6s. Byte order is
  the drive's, so the shim runs the real probe once and remembers a conclusive
  answer (not `-1`) for the life of the mpd process. Every MMC drive returns
  little-endian anyway. Swapping the drive needs an mpd restart.
- **16-second read blocks.** Each paranoia read fetches `CACHEMODEL_SECTORS`
  (1200) before returning anything, even with paranoia disabled. At the drive's
  4x that is ~4s: a stop waited for the block in flight, and a new track for its
  first block. The shim wraps `cdio_paranoia_init()` and sets
  `cdio_paranoia_cachemodel_size(p, 25)`: one drive read (it was 75, 1s, until
  bad sectors showed a stop waiting on three slow reads). Reads stay sequential:
  the cache handler only seeks when a read starts before the cached span.

Both calls go through the PLT (`objdump -d libcdio_cdda.so.2 | grep
data_bigendianp@plt`), which is why a preload can take them. The map file gives
the exports libcdio's version nodes (`CDIO_CDDA_2`, `CDIO_PARANOIA_2`) so
versioned references bind to the shim. It looks up the real functions with
`dlvsym(RTLD_NEXT, ...)`.

Measured 2026-09-30, the same worn 17-track disc, `mpc next` 5s into a track:

```
                          mpc next returns    first audio frame
before                    2.6-3.6s            ~3.3-4.5s
probe cached only         2.8-3.6s            (stop still waits for a 1200-sector block)
probe cached + 75-sector  0.34-0.48s          1.1-1.3s
start from stopped        -                   1.3s
probe cached + 25-sector  0.21-0.31s          (not re-measured)
```

What is left of a skip: stopping the old block (≤0.25s), a 1-sector read at lba
9157 (~0.3s: libcdio's open checks it can read the middle of track 1, inside the
library where a preload cannot reach), the seek to the new track (~0.2-0.35s), and
75 sectors to fill MPD's 1s buffer (~0.25s). 0 "too slow" lines while playing.

## Bad sectors: silence, not retries

Pressing eject while a worn track sat paused froze MPD for 64s. While paused, the
decoder still reads ahead. It was inside a read of a bad patch, and MPD's `stop`
waits for the decoder. Tracing the drive on that track (a 12-track disc, track 5,
lba ~97200-97800, ~0:25 in) showed three layers of retry:

- **The drive** takes ~0.75s to fail a read, or runs into libcdio's 6s MMC
  timeout (`6.01s` in the trace). Lowering its read-retry count (mode page 01h,
  15 -> 1, which it accepts) changed nothing for audio reads.
- **libcdio's `read_blocks()`** retries a failed read 8 more times at the same
  sector, shrinking it (25, 18, 13, 9). One 25-sector chunk took 37s.
- **paranoia**, even disabled, re-reads a block that returned nothing up to 20
  times before skipping it (`retry_count`/`max_retries` in
  `cdio_paranoia_read_limited`).

The shim wraps `cdio_read_audio_sectors()` (a PLT call from `libcdio_cdda` into
`libcdio`, version node `CDIO_19`). A failed read returns **success with the
chunk zeroed**, so nothing above it retries. That is what a CD player does with
an uncorrectable patch: mute and move on. The one exception is `ENOMEDIUM`, which
is still an error, so a vanished disc stops MPD instead of playing silence.

Measured on the same patch, `mpc stop` issued 3s into it:

```
                               track 5 across the bad patch        stop in the patch
before                         stuck at 0:27 for 2+ minutes        up to 64s
libcdio retries cut only       stuck: paranoia re-read the block   -
silence, 75-sector blocks      plays on, 1 "too slow"              2.6-8.2s
silence, 25-sector blocks      plays on, ~4s stall, 3 "too slow"   0.4-5.2s
```

What is left is one read: up to the 6s MMC timeout (`mmc_timeout_ms`, exported by
libcdio, deliberately not lowered, since an aborted command on this USB bridge is
what needed a bus reset during the eject race).

```sh
grep -c cdio-latency /proc/$(pidof mpd)/maps     # non-zero: the preload is in
T=/sys/kernel/tracing                            # as root: every READ CD, with timing
echo 1 > $T/events/scsi/scsi_dispatch_cmd_start/enable
echo 1 > $T/events/scsi/scsi_dispatch_cmd_done/enable
cat $T/trace_pipe | grep 'raw=be'                # be 00 <lba x4> <count x3>
# A READ CD that takes 0.7s or 6.01s is a bad sector; each lba should appear once.
```

## Measured on the device (2026-09-29)

```
drive                 sr0, DVD RW AD-7251H5, USB (152d:0578 enclosure)
media polling         kernel does it: events_dfl_poll_msecs=2000, no udisks needed
eject                 one `change`, no media properties
tray close            `change` at once (no media yet), then ~8.6s later a
                      `change` carrying ID_CDROM_MEDIA_TRACK_COUNT_AUDIO=11
eject while held open succeeds (rc 0) — eject falls back to a SCSI command the
                      door lock does not stop
physical button       stock 60-cdrom_id.rules: DISK_EJECT_REQUEST ->
                      `cdrom_id --eject-media`. No longer used: see below.
```

Because eject works through an open handle, stopping MPD first is not needed to
make the tray open. It is needed so the eject never lands in the middle of a read.

**The eject button goes through the helper, like the UI's Eject.** At first the
stock rule ejected while the helper stopped MPD, both reacting to the same event.
Sometimes the eject reached the drive during one of MPD's `READ CD`s, and the
USB bridge wedged until the kernel reset it. MPD's decoder was stuck in the
ioctl, so its `stop` blocked the main thread and nothing could reach MPD for a
minute (2026-09-30, 1 of 3 presses):

```
14:56:24 musicbox-cd: stopping MPD: it is playing the disc
14:56:50 server: MPD did not answer 'ping' within 10000ms
14:57:25 systemd-udevd: sr0: Worker ... is taking a long time
14:57:25 kernel: usb 2-2: reset SuperSpeed USB device
```

`59-musicbox-cd-eject.rules` renames `DISK_EJECT_REQUEST` to
`MUSICBOX_EJECT_REQUEST` before the stock rule sees it, and the helper answers
with `do_eject`: stop MPD, which returns once the decoder has let go, then eject.
The stock rule is otherwise untouched. Its `--lock-media` is what makes the drive
report the button at all. Clearing the stock `RUN` instead was tried: udev 257
ignores `RUN-=`, and `RUN=""` leaves an empty entry and logs `Invalid value`.

After `setup-cd.sh`, on the device:

```
MPD playing a disc    works
queue durations       ABSENT — MPD reports none for a cdda:// entry until it
                      plays; only the playing track's duration (from `status`)
                      is known. Per-track lengths need the TOC: disc lookup work.
physical button       works during playback, with a slight delay
```

Lookup, by hand from the box before it was built: *Ten*'s TOC read by the ioctl
matched the hand-computed offsets; MusicBrainz answered in ~1.8s with 4 releases,
all with a front cover; the Cover Art Archive answered in ~0.9s.

End to end in the running server: found as Pearl Jam — *Ten* (US 1991 pressing),
all 11 titles and durations in the queue, 80KB cover served at `/api/cd/art`.

**The first deploy's lookups all failed with `fetch failed`, while `curl` worked.**
Node's `fetch` tries each address for only 250ms (`autoSelectFamilyAttemptTimeout`)
and an IPv4 connect from this box to MusicBrainz measured ~280ms over wifi; IPv6 is
unreachable. So Node gave up on the one address that would have answered.
`server.ts` raises the attempt timeout to 2.5s; measured afterwards, a lookup takes
1.1–1.3s. Any future outbound `fetch` from the server benefits the same way.

**NOT YET MEASURED:** time from insert to sound.

**A CD taking over from a phone** never happened at first: the arbiter waited for
MPD to say `playing`, and a CD fails on the busy card before that is visible.
Fixed in the arbiter. See `bluetooth.md`, "The handoff, both directions".
Record them here when exercised.

## Triage

```sh
musicbox-cd status                       # what the server is being told
journalctl -u musicbox-cd -f
udevadm info -q property -n /dev/cdrom | grep ID_CDROM_MEDIA
udevadm monitor --udev --property -s block   # the button shows MUSICBOX_EJECT_REQUEST=1
id mpd                                   # must include cdrom
mpc add cdda:///1 && mpc play            # MPD reading the disc, no UI involved
journalctl -u mpd | grep 'too slow'      # reading slower than real time
grep -A3 cdio_paranoia /etc/musicbox/mpd.conf   # must say mode "disable"
sudo strace -tt -T -p <decoder:pcm tid> -e trace=ioctl   # tid: ls /proc/$(pidof mpd)/task
curl -s localhost/api/status | python3 -c 'import json,sys; print(json.load(sys.stdin)["cd"])'
curl -s -A 'musicbox-triage ( you )' "https://musicbrainz.org/ws/2/discid/<ID>?fmt=json"
sqlite3 /var/lib/musicbox/data/musicbox.db 'SELECT disc_id, status, fetched_at FROM cd_disc'
printf 'eject\n' > /run/musicbox-cd/control   # as musicbox
```
