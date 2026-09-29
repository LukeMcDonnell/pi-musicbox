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
served at `/api/cd/art`; the table is in backups, the covers are not (they are
re-fetched). A re-inserted disc is named instantly and offline.

**The disc is published before the lookup finishes**, with `lookup: 'pending'`,
and auto-play does not wait for it; titles arrive while it plays. The queue's rows
change without MPD's queue version moving, so clients refetch on the disc's lookup
state too (`musicbox-api.ts`).

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
                      `cdrom_id --eject-media`. So the helper only stops MPD.
```

Because eject works through an open handle, stopping MPD first is not needed to
make the tray open — it is there so MPD is not left reading a disc that has gone.

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

**NOT YET MEASURED:** time from insert to sound, and a CD taking over from a phone.
Record them here when exercised.

## Triage

```sh
musicbox-cd status                       # what the server is being told
journalctl -u musicbox-cd -f
udevadm info -q property -n /dev/cdrom | grep ID_CDROM_MEDIA
udevadm monitor --udev --property -s block
id mpd                                   # must include cdrom
mpc add cdda:///1 && mpc play            # MPD reading the disc, no UI involved
curl -s localhost/api/status | python3 -c 'import json,sys; print(json.load(sys.stdin)["cd"])'
curl -s -A 'musicbox-triage ( you )' "https://musicbrainz.org/ws/2/discid/<ID>?fmt=json"
sqlite3 /var/lib/musicbox/data/musicbox.db 'SELECT disc_id, status, fetched_at FROM cd_disc'
printf 'eject\n' > /run/musicbox-cd/control   # as musicbox
```
