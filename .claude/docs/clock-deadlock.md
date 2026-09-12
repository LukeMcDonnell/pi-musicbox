# The clock/firmware deadlock — diagnosed 2026-09-12

**Status: root cause captured. Fix applied and verified on the device 2026-09-12;
`performance` now survives a reboot. NOT yet confirmed by a soak — see the end.**

This is **not** the wifi issue. It presents similarly ("the box stopped
responding") and the two were conflated for a while, so read
[`wifi-instability.md`](wifi-instability.md) too and use the table at the bottom
of this file to tell them apart before diagnosing anything.

## How it presents

- The UI says **"MPD is not running"** on the panel and on phones.
- `systemctl is-active mpd` says **`active`**, and the process is alive.
- **Networking stays up.** ssh works, the box answers ping.
- `curl localhost/api/status` returns **nothing at all** — hangs.
- The panel is **frozen** (this is the cheapest way to tell it from the wifi fault,
  where the kiosk kept rendering).
- Load average climbs to ~7 on 4 cores while nothing uses CPU — it is all
  uninterruptible sleep, which Linux counts in load.
- `vcgencmd` **hangs**, and so does `sudo`-anything that touches the firmware.

Only a **hard power cycle** recovers it. The stuck tasks are in uninterruptible
sleep, so they cannot be killed, and `reboot` will not complete either.

## Root cause, as captured

**Two independent subsystems drive clocks through the same single VideoCore
firmware mailbox** — the cpufreq governor and the display stack (vc4/v3d) — and
they are serialised by the kernel's one global clock lock (`clk_prepare_lock`)
plus the firmware's own transaction mutex. Under sustained concurrent use they
deadlock on those mutexes. Once that happens every clock user in the system
piles up and only a power cycle recovers it.

The cpufreq side, sampled twice minutes apart at the identical instruction:

```
kworker/0:2 (pid 7095)
  od_dbs_update                    <- the `ondemand` cpufreq governor, on a timer
    __cpufreq_driver_target
      dev_pm_opp_set_rate
        clk_set_rate               <- takes clk_prepare_lock...
          clk_core_set_rate_nolock <- ...so it HOLDS it from here down
            raspberrypi_fw_set_rate
              rpi_firmware_property
                rpi_firmware_property_list   <- blocked in the mailbox path
```

The display side, at the same moment:

```
kworker/u16:3 (pid 52), and kworker/u16:4 (pid 12115)
  vc4_atomic_commit_tail [vc4]
    clk_set_min_rate
      clk_prepare_lock             <- WAITING for the global clock lock
```

**It is mutex contention, not a firmware timeout.** The kernel says so directly:

```
INFO: task kworker/0:2:7095 blocked for more than 120 seconds.
INFO: task kworker/0:2:7095 is blocked on a mutex likely owned by task kworker/u16:3:52.
```

That matters, because the mailbox wait itself is bounded — a firmware that simply
never answered would time out, not hang for hours. An unbounded wait means a
mutex, and a mutex means two callers.

### An unresolved inconsistency, stated rather than smoothed over

The kernel blamed **pid 52 (vc4)** as the lock owner, consistently, in all three
of its attributions. But pid 52's own stack shows it *waiting* in
`clk_prepare_lock`, while pid 7095's stack shows it *holding* that lock (it got
there via `clk_set_rate`) and blocked deeper in the firmware path. Both cannot be
the owner.

I could not reconcile that from the evidence available, and did not want to pick
whichever half suited the fix. What is solid either way:

- the global clock lock was held by a task blocked inside the firmware mailbox
  path, and everything needing a clock queued behind it;
- **both** cpufreq and vc4 were in that path at the same time;
- the block was on a mutex, so two mailbox users were contending.

Which of the two ends up holding is not established. See "What the fix does and
does not do" below, because this is exactly what limits the confidence there.

Everything else in the system that needs any clock then queues behind it in `D`
state, forever:

| Task | Blocked in | Consequence |
|---|---|---|
| `output:HiFiBerry` (MPD) | `bcm2835_i2s_start_clock` → `clk_prepare` | **audio stops** |
| `kworker/u16:3`, `u16:4` | `vc4_atomic_commit_tail` → `clk_set_min_rate` | **panel freezes** |
| `kworker/2:2+pm` | `v3d_power_suspend` → `clk_unprepare` | v3d runtime PM stuck |
| `chromium` | `rpm_resume` → `v3d_job_init` | kiosk blocks on the above |

**Why MPD looks "running" but answers nothing.** Its `output:HiFiBerry` thread is
wedged in the kernel; MPD's main thread is in a normal `futex` wait on it. So the
process is healthy-looking and `S` state, but it never returns to its event loop.
The kernel keeps accepting connections on 6600 on its behalf — `ss -ltn` showed
`Recv-Q 1`, a completed connection nobody ever accepted. That is why every layer
above reports "MPD is not running" while systemd reports it fine.

**How long it lasted.** The kernel first reported a task blocked past 120s at
**17:01:57**, so the deadlock began by **16:59:57**, and it was still wedged when
the box was power cycled at **19:48** — roughly **2h50m**.

The hung-task reports stop at 17:05:59, which is *not* recovery: the kernel's
`hung_task_warnings` budget (10 by default) was simply exhausted. Do not read the
last report as the end of the incident.

Also worth recording, since it is easy to get wrong: an earlier version of this
write-up derived "1h57m" from the kworker's start time in `/proc/<pid>/stat`. That
field is the **thread's age**, not how long it has been blocked, and a kworker can
be old and healthy. The hung-task reports are the right source for onset; the two
identical stack samples only prove it was stuck across that interval.

## The deadlock starts silently, and only becomes visible at the next track change

Worth knowing before you try to date an incident from the logs. In the captured
case the clock lock was taken at **16:52**, but the backend successfully connected
to MPD and read its greeting at **18:41:55** — nearly two hours later.

That is not a contradiction. Nothing blocks until something actually asks for a
clock operation. MPD does not need one while a stream is already open, so it keeps
playing the current track quite happily on a board that is already deadlocked. The
moment it reaches the **end of the track** and reopens the output device, its
`output:HiFiBerry` thread hits `bcm2835_i2s_start_clock` and is gone; the main
thread then blocks waiting on it, and only then does MPD stop answering.

So: **the time the box appears to fail is the next track boundary, not the time it
broke.** Look for the cpufreq kworker's age (`/proc/<pid>/stat` field 22 against
`/proc/uptime`) for the real onset, not the journal.

This is also why the two timeout layers in the backend both matter. Once MPD's
main thread is gone it stops accepting, so a *new* connection fails on the
**connect** timeout. But a connection established before the wedge stays open and
simply never answers — that needs the **reply** timeout. The original two-hour
dead `/api/status` was the second case.

## Why it correlated with playback

`ondemand` re-evaluates on a timer and changes CPU frequency whenever load moves.
Streaming FLAC over the network is bursty, so the governor flips between 600MHz
and 1.5GHz constantly — thousands of firmware mailbox round-trips an hour. The
deadlock is a race in that path, so exposure scales with how often it is called.
"Fails after tens of minutes of playing music" is what that looks like from
outside. The CPU was found pinned at `600000` because the rate change that
deadlocked never completed.

## The fix — it takes TWO changes, and the first one alone does nothing

**1. `cpufreq.default_governor=performance` in `cmdline.txt`** (`setup.sh`,
Phase 4). `performance` sets the rate once at boot and then makes no further
firmware calls, so the highest-frequency caller of the racing path stops
existing.

**2. Shadow Debian's ondemand udev rule** (`setup.sh`, Phase 2), because the
parameter alone is silently ignored. Measured on the device after a reboot:

```
$ grep -o 'cpufreq[^ ]*' /proc/cmdline
cpufreq.default_governor=performance          <- the kernel did receive it
$ cat /sys/devices/system/cpu/cpufreq/policy0/scaling_governor
ondemand                                      <- and it made no difference
```

The culprit is shipped by Debian:

```
/usr/lib/udev/rules.d/60-ondemand-governor.rules
KERNEL=="cpu*", SUBSYSTEM=="cpu", ATTR{cpufreq/scaling_governor}="ondemand"
```

It fires for every CPU as udev settles and overwrites whatever the kernel chose.
No package, systemd unit or init script was involved — which is why it took a
filesystem-wide `grep` for `scaling_governor` to find, after
`systemctl list-units`, `dpkg -l` and `/etc/init.d` all came up empty.

`setup.sh` neutralises it by writing an **empty, comment-only**
`/etc/udev/rules.d/60-ondemand-governor.rules`. udev takes the highest-priority
directory's copy of a given filename, so this replaces Debian's without modifying
a packaged file, and deleting it restores stock behaviour.

If you only ever check one of the two, check the **governor**, not the cmdline —
the cmdline can look perfect while the governor is wrong.

### What the fix does and does not do

It removes **one of the two contending parties**, and the only one that is both
high-frequency and independent of user activity: `ondemand` re-evaluates on a
timer, whereas vc4/v3d calls follow display commits. Since the failure is mutex
contention between two mailbox users, taking one of them out of the picture is a
principled fix and not just a probability reduction.

But it is **not proven**, and the honest reason is the inconsistency above: the
kernel named the *vc4* worker as the lock owner. If the deadlock can form among
vc4 and v3d alone, pinning the governor will not prevent it. The race itself is in
the firmware mailbox path and is not ours to fix.

So: treat this as the best available fix with a clear mechanism behind it, and
**keep the instrumentation on until a long soak has passed**. If it recurs with
`performance` confirmed active, the governor is exonerated and the next suspects
are the kernel and firmware versions (currently `6.18.34+rpt-rpi-v8`, tainted
`G WC`) — and `tools/isolate-display.sh`, which soaks with zero vc4 commits,
becomes genuinely useful rather than a leftover from a discredited theory.

Cost: the CPU sits at maximum instead of idling at 600MHz — more idle power and
heat. On a mains-powered appliance whose whole job is not to stop playing, that
is the right trade. Worth watching `measure_temp` on the first long soak.

Not chosen, and why: `force_turbo=1` pins the clock in firmware instead, but it is
a blunter instrument that has historically set sticky bits, and it does not
express the intent as clearly as naming the governor.

## Our own bug, found alongside it and fixed

`MpdConnection.send()` had a **connect** timeout but no **reply** timeout. Against
a wedged MPD — which accepts the connection and answers nothing — every `await`
hung forever. `refresh()` never returned, so `/api/status` never responded, so the
**web UI died along with MPD** instead of reporting it unavailable. That is why
"the backend stopped responding" and "mpd is down" kept arriving together.

Fixed in `src/backend/src/mpd/protocol.ts`: every command now carries a 10s
deadline (`DEFAULT_REPLY_TIMEOUT_MS`), and a breach is **fatal to the connection**
— replies are matched to commands by order, so a stream that has lost sync cannot
be resynchronised. `idle` is explicitly exempt via `{ timeoutMs: null }`, because
blocking is its entire purpose.

This fix is independent of the deadlock and worth keeping regardless: any future
cause of an unresponsive MPD now degrades to "unavailable" in the UI instead of
taking the server down.

## Ruled out: power supply and heat

`vcgencmd get_throttled` → `throttled=0x0` on a healthy boot, and `measure_temp`
→ 53.0°C. No undervoltage and no thermal throttling, now or historically (that
flag word is sticky). So this is not a brownout or a heat problem, which are the
usual first guesses for a Pi misbehaving under load.

## Verifying after a reboot

```sh
cat /sys/devices/system/cpu/cpufreq/policy0/scaling_governor  # performance <- THE ONE THAT MATTERS
grep -o 'cpufreq[^ ]*' /proc/cmdline                          # ...=performance
ls -l /etc/udev/rules.d/60-ondemand-governor.rules            # must exist, and be inert
cat /sys/devices/system/cpu/cpufreq/policy0/scaling_cur_freq  # 1500000
vcgencmd measure_temp                                         # answers at all = mailbox alive
```

Then soak: play for well over an hour and check the panel is still live. Watch
`measure_temp` on that first soak, since the CPU no longer idles down.

## Diagnosing a future "box stopped responding"

Run these **in this order**. The first two need no network, so do them on the
panel if ssh is gone.

```sh
vcgencmd measure_temp            # HANGS  -> firmware mailbox: this document
ps -eo pid,stat,comm | awk '$2 ~ /D/'   # D-state pile-up -> this document
ss -ltn '( sport = :6600 )'      # Recv-Q > 0 -> MPD not accepting
sudo cat /proc/<pid>/stack       # the actual proof; look for clk_prepare_lock
journalctl -t netwatch -b -1 | grep DOWN   # network fault -> wifi-instability.md
```

### Telling the two faults apart

| | clock deadlock (this file) | wifi dropout (`wifi-instability.md`) |
|---|---|---|
| Network | **up** | **down** |
| Panel/kiosk | **frozen** | **still rendering** |
| `vcgencmd` | **hangs** | answers |
| D-state tasks | many, on `clk_prepare_lock` | none of note |
| ssh | works | dead |

A previous incident was attributed to the display driver because the one trace
captured then showed `vc4_atomic_commit_tail` holding the lock. This capture shows
vc4 **queued** on it, with cpufreq holding it — so vc4 was most likely a victim
that time too, and the "the display driver is at fault" framing was wrong in the
direction of causation. It is also, separately, why the "a CSS transition drives
too many commits" theory was a dead end: see `wifi-instability.md`.

## Current state of the device — fix APPLIED and verified 2026-09-12 20:47

| | |
|---|---|
| `cmdline.txt` governor parameter | applied |
| `/etc/udev/rules.d/60-ondemand-governor.rules` shadow | applied |
| **Effective governor after a clean reboot** | **`performance`, at 1500000 kHz** |
| Backend reply timeout | applied, confirmed live against the real wedge |
| Temperature | 53°C before, 55.5°C after — the expected small cost of not idling down |
| `throttled` | `0x0` |
| Boot | 16.459s vs a 15.693s baseline. Not attributable to the governor: `e2scrub_reap.service` took 1.748s this boot and does not run every boot. `mpd.service` was 5.405s, slightly *faster* than before. |

The shadow was proved to work **without** relying on a reboot, which is the test
worth repeating if this is ever revisited:

```sh
sudo sh -c 'echo performance > /sys/devices/system/cpu/cpufreq/policy0/scaling_governor'
sudo udevadm trigger --subsystem-match=cpu && sudo udevadm settle
cat /sys/devices/system/cpu/cpufreq/policy0/scaling_governor   # still performance
```

With Debian's rule in force that re-trigger flips it straight back to `ondemand`.
It stayed on `performance`.

### Still outstanding

**A soak is the only thing that can confirm the fix.** For reference, the captured
incident deadlocked about 36 minutes after boot (booted 16:23, blocked by
16:59:57). Play for several hours and watch for the panel freezing.

Keep `tools/instrument-wifi-debug.sh`'s persistent journald on until that soak has
passed — without it a recurrence erases its own evidence, which is what happened
every time before.

If it does recur with `performance` confirmed active, the governor is exonerated:
go to the kernel/firmware versions (`6.18.34+rpt-rpi-v8`, tainted `G WC`) and to
`tools/isolate-display.sh`, which soaks with zero vc4 commits.
