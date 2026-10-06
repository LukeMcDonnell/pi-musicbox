# The clock/firmware deadlock — diagnosed 2026-09-12

> **2026-10-06:** a different fault: silent whole-board freezes that neither the
> watchdog nor the hung-task panic catches. Open. See "Silent freezes" at the end.

**Status: root cause captured; fix applied, verified across a reboot, and soaked
4 hours clean (56 track changes, zero hung tasks). Not called closed — the fault
was intermittent, so keep the instrumentation until it has run for days.**

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

| | clock deadlock (this file) | wifi dropout (`wifi-instability.md`) | 2026-10-06 silent hang (below) |
|---|---|---|---|
| Network | **up** | **down** | **down** — no ARP reply |
| Panel/kiosk | **frozen** | **still rendering** | dark (backlight sleep), touch ignored |
| `vcgencmd` | **hangs** | answers | unknown |
| D-state tasks | many, on `clk_prepare_lock` | none of note | unknown |
| ssh | works | dead | dead |
| Journal | hung-task reports land | keeps writing | **stops dead**, mid-sample |

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

### Soak result — 4 hours clean, 2026-09-12 20:51 to 2026-09-13 00:52

| | |
|---|---|
| Duration | **240 min** of continuous playback |
| Samples | 120/120 healthy, polled every 2 min |
| **Track changes** | **56** |
| Deadlock signatures | **0** |
| Kernel hung-task reports (device-side) | **0** |
| Governor | `performance` on every sample |
| Temperature | 53.5–57.9°C, flat |
| `throttled` | `0x0` |

The track-change count is the number that matters. The deadlock manifests when
MPD reopens the audio device and calls `clk_prepare` — a **track boundary** — so
56 of those are the relevant stress, not merely elapsed time. For comparison the
captured incident wedged ~36 minutes after boot, and the kernel logged hung tasks
within the hour; this run logged none in four.

**This is strong evidence, not proof.** The failure was intermittent before
(hours of normal use between incidents), so one clean run cannot exclude a race
that needs a rarer coincidence. What it does do is move the burden: if this
recurs with `performance` confirmed active, the governor is exonerated and the
next suspects are the kernel and firmware versions (`6.18.34+rpt-rpi-v8`, tainted
`G WC`) and `tools/isolate-display.sh`, which soaks with zero vc4 commits.

Keep `tools/instrument-wifi-debug.sh`'s persistent journald on for now — without
it a recurrence erases the evidence of its own cause, which is what happened every
time before this.

The soak harness lives in the session scratchpad, not the repo: a read-only probe
piped over `ssh ... bash -s` (nothing written on the device), and a watcher that
exits the moment it sees either signature. Its one important design rule is that
**an unreachable box is not a failure** — this box drops off the network on its
own, and the deadlock leaves the network *up*, so "reachable but `vcgencmd` hangs"
is the decisive test.

## Silent freezes (2026-09-29 onward) — open, probably not this deadlock

Four so far, all the same shape. Every journal writer stops in the same second.
The last netwatch sample is healthy: network up, gigabytes free, load near zero,
nothing in D. The box is then off the network (no ARP reply), the panel ignores
touch, and it stays like that until power cycled.

| Boot ended | Uptime | Notes |
|---|---|---|
| 2026-09-29 10:28 | ~22h | CD drive first appears in the kernel log 2.5 min later |
| 2026-10-06 10:21 | ~43h | drive empty |
| 2026-10-06 11:12 | 3.5 min | idle, disc in |
| 2026-10-06 11:37 | 13.5 min | idle, no disc |

Why this is not the clock deadlock:

- **Neither recovery fired.** The hung-task panic below was live for the last two
  and was proved working by a sysrq crash (it rebooted in ~38s). The 1-minute
  hardware watchdog did not reset the board either: each freeze lasted 11–35 min
  and ended only at a power cycle. (Do not use the bootloader's `rsts` for this:
  it reads `0x1000` after a clean soft reboot too.) The deadlock leaves the kernel
  running; this stops something below it.
- Nothing is in D beforehand, and the network goes down too.

What has been ruled out:

- **Memory:** 3.2 GB available, no swap use, in the last sample.
- **Power, as far as visible:** official PSU; the CD drive has its own supply;
  no undervoltage ever logged. The kernel samples every 2s and can miss a short
  dip, so netwatch now logs the sticky `get_throttled` bits (`thr=`), live
  undervoltage (`uv=`) and `temp=`. Read those on the last samples first.
- **The panel's backlight write.** Panel sleep writes the ATtiny over the I2C
  bus that the firmware polls for touch (`rpi-ft5406`), with no coordination, and
  the 3.5-min freeze landed exactly at the 3-minute sleep. But the 43h freeze
  came after hours with the panel already off and no backlight write, and a page
  that is already asleep sends nothing. Coincidence.

**Leading suspect: the USB CD drive** (HP slim DVD on a JMicron JMS578
USB-SATA bridge, separately powered). Before it was attached, 2026-09-16 to 09-28,
every boot ended cleanly, including 4- and 7-day uptimes. Since then, four
freezes. The kernel polls the drive for media every 2s even when idle, through
the VL805 USB controller on PCIe, where a hang can stall the CPU below anything
a watchdog sees. Correlation by date only. Being reproduced with the drive left
attached.

**ramoops was tried and removed.** `dtoverlay=ramoops-pi4` was added on 10-06
to keep the panic log across a reboot. The next two freezes came 3.5 and 13.5 min
after boot, against 22h and 43h before. It was the only firmware-level change,
so it came out. The boot it was still loaded in then ran 86 min clean, so this
may well be coincidence. If freezes recur without it, it can come back.

What stays from that work:

| | Where | Why |
|---|---|---|
| `kernel.hung_task_panic=1`, `kernel.panic=10`, timeout 120s | `setup.sh` → `/etc/sysctl.d/90-musicbox-recovery.conf` | A task stuck in D for 2 min panics, and the panic reboots. It catches *this* deadlock, which `reboot` cannot get out of. It does not catch the silent freezes. |
| `kernel.panic_on_rcu_stall=1` | same file | This kernel has no soft/hard lockup detector, so RCU's 21s stall check is the only thing that notices a CPU stuck with interrupts off. If a freeze now reboots itself after ~30s, a CPU was stuck. If it still needs a power cycle, the CPUs were not the thing that stopped. |
| netwatch `avail`, `swap`, `load`, `chromium`, `D=[...]`, `thr`, `uv`, `temp` | `tools/instrument-wifi-debug.sh` | The last samples before a freeze. |
| netwatch runs `journalctl --sync` every sample | same | Without it the journal reaches the SD card only once data is 30s old, so a freeze lost its last ~30s, including any stall warning. Now at most ~10s is lost. |

After a freeze, once power cycled:

```sh
journalctl -b -1 -t netwatch -n 5 --no-pager           # thr= uv= temp= avail= D= just before
journalctl -b -1 -k -p warning --no-pager | tail       # anything from the kernel at all, e.g. "rcu: INFO: rcu_preempt detected stalls"
```
