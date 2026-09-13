# OPEN ISSUE — the box loses networking under load

**Status: unresolved, mitigated, instrumented.** Last touched 2026-09-12.

Read this before diagnosing any "the box stopped responding" report, and before
removing anything under "What is installed on the device".

## The symptom

After tens of minutes of streaming music over wifi, the Pi **drops off the
network**. From outside: no ping, no ssh, no HTTP. But the box keeps running:

- the kiosk keeps rendering and stays usable on the panel
- the web UI on the panel keeps talking to the backend over localhost
- MPD starts erroring, because the library is on the NAS over that same wifi

Observed twice at roughly 17–20 minutes of continuous playback. Recovery required
a power cycle both times.

**Both of those characterisations are now wrong (2026-09-12, third observation):**

- **It recovered on its own.** The box was unreachable from ~20:03 to ~20:40 —
  100% packet loss, no HTTP, no ssh — and then came back with `uptime` showing the
  *same* boot. No power cycle. So a dropout is not necessarily terminal, and
  "needed a power cycle" was an artifact of never having waited long enough.
- **It is not gated on sustained playback.** MPD was **paused** for the entire
  episode (same track, same position, before and after). The load at the time was
  ssh, journald reads and a couple of build pushes — nothing like streaming FLAC.
- **It flaps constantly rather than failing once.** `netwatch` logged **38** DOWN
  samples in 53 minutes on that boot, at a steady **−72 dBm**, including samples
  where the gateway was unreachable while the NAS was still up and NetworkManager
  still reported `connected`.

Taken together this looks less like a load-triggered driver fault and more like a
plain weak-signal association problem, which raises the priority of "pin to
2.4GHz" and "plug in ethernet" below.

### An observation to watch: it got dramatically better when the governor changed

Measured by `netwatch` itself, same box, same AP, same −72 dBm, one boot apart:

| Boot | DOWN samples | Rate |
|---|---|---|
| Before the governor fix (53 min) | 38 | **~12%** |
| After (4h soak, 1450 samples) | 4 | **0.28%** |

A ~40× reduction. There is a mechanism that would explain it: brcmfmac sits on
**SDIO**, whose clock is also managed through the VideoCore firmware mailbox, and
`ondemand` was hammering that mailbox continuously. Fewer mailbox calls, fewer
SDIO clock stalls. If that holds up, both faults in these two documents share one
root cause.

**Treat this as a lead, not a finding.** It is a single pair of boots, wifi
conditions vary on their own, and the fault was always intermittent. It is
recorded here so the next few days of data are read with it in mind — if drops
stay near zero, this becomes the explanation; if they return, it was noise. It also means **a dropout is not evidence of
the clock deadlock** — during this episode the box was demonstrably healthy
locally (no D-state tasks, `vcgencmd` answering). See
[`clock-deadlock.md`](clock-deadlock.md).

## The methodological mistake that cost hours

**Every liveness probe went over the network**, so network loss looked like a
total system hang. That sent the investigation after a kernel deadlock in the
display driver when the box was in fact fine locally the whole time. The user
noticing "the kiosk is still up and working" is what corrected it.

If you are diagnosing this: **do not trust any conclusion drawn from a
network-dependent probe.** Log locally (see below) and read it after a power
cycle.

## Confirmed facts

| | |
|---|---|
| Interface | `wlan0` — `brcmfmac43455-sdio`, BCM4345/6, firmware 7.45.265 |
| `eth0` | down, no cable attached |
| Band | 5GHz, channel 40 (5200MHz), **80MHz** width |
| Signal | **−65 to −75 dBm** across a soak — weak for 5GHz |
| Same SSID on 2.4GHz | channel 3, **stronger** (NM quality 74 vs 59) |
| Load | MPD streams FLAC over NFS continuously — ~430MB in 33 minutes |
| Power save | **was enabled**; now disabled (see below) |

## The kernel deadlock has since been fully diagnosed — see clock-deadlock.md

**Superseded (2026-09-12).** The deadlock below was captured again, in full, with
the network still up. The holder of the clock lock is the **`ondemand` cpufreq
governor** calling the VideoCore firmware mailbox; `vc4` is a *victim* queued
behind it, not the cause. The framing in this section — display driver at fault —
is wrong in the direction of causation. Read
[`clock-deadlock.md`](clock-deadlock.md) instead, including the table there for
telling that fault apart from this one (there: network up, panel frozen,
`vcgencmd` hangs; here: network down, panel still rendering).

The original notes are kept below because the trace itself was accurate.

## One traced kernel deadlock — real, but NOT established as the recurring cause

Captured once, on the first incident:

```
kworker/u16:3   commit_work [drm_kms_helper]
  vc4_atomic_commit_tail [vc4]
    clk_set_min_rate                     <- holds the global clock mutex
      raspberrypi_fw_get_rate
        rpi_firmware_property
          mbox_send_message
            wait_for_completion_timeout   <- GPU firmware never replied
```

Everything needing a clock queued behind it: the cpufreq governor, PM kworkers,
chromium, and MPD's `output:HiFiBerry` thread in uninterruptible `D` state.

This trace is genuine. What is **not** established is that it explains the
recurring failure — that incident is the only one captured, and the later ones
match a network-only fault (kiosk still rendering), which this deadlock does not.
Treat it as an unexplained one-off until something reproduces it.

## Dead ends — do not re-run these

- **"A CSS transition drives too many display commits."** No evidence. Built from
  the single trace above plus an assumption that the box was stable before the
  Angular UI reached the panel — never verified, and unverifiable in hindsight
  because logs were volatile. 60fps compositing on a Pi 4 is unremarkable.
- **Regulatory domain / country code.** Already correct.
  `cfg80211.ieee80211_regdom=AU` is in `cmdline.txt` *and* `/proc/cmdline`.
  `iw reg get` showing `country 98` (global) and `country 99` (phy#0) is **normal
  for brcmfmac**: 99 means the driver supplies its own custom domain, which is
  also why `iw reg set` is silently ignored. There is **no
  `/etc/wpa_supplicant/wpa_supplicant.conf`** on this box — NetworkManager owns
  the connection since the netplan migration — so advice to add `country=` there
  does not apply.
- **`txpower 31.00 dBm` is not a real 1.25W setting.** A reporting artifact; the
  phy limits say 20 dBm.
- **"Six connections from one host = browser connection cap."** Those were
  leftovers from the investigator's own `curl` probes. Check whose IP it is.
- **A `kworker/...+events_unbound` in `D` state is not a deadlock.** Unbound
  workers park in `D` with a bare `worker_thread` stack. Look at the stack, and
  look for a `blocked for more than N seconds` report, before concluding anything.

## Mitigation applied

**Wifi power save disabled**, persistently:

```sh
nmcli connection modify musicbox-wlan0 802-11-wireless.powersave 2
```

After this the box ran 47+ minutes with continuous playback and **zero**
network-down samples, where it had previously failed at 17–20 minutes. That is
suggestive, not proof — the earlier failures were never bounded tightly enough to
call this a fix.

To revert: `802-11-wireless.powersave 0`.

## Next steps, cheapest first

1. **Pin to 2.4GHz.** The 2.4GHz BSS is stronger and FLAC needs ~1.5 Mbps, so
   5GHz at 80MHz buys nothing here:
   `nmcli connection modify musicbox-wlan0 802-11-wireless.band bg`
2. **Plug in ethernet.** `eth0` is down with no cable; this removes the entire
   class of problem and would confirm the diagnosis by elimination.
3. **Check for a newer rpt kernel and firmware.** Running
   `6.18.34+rpt-rpi-v8`, tainted `G WC`.
4. If the display deadlock ever reproduces, `tools/isolate-display.sh` stops the
   kiosk and soaks with zero vc4 commits. It was written for a theory that has
   since been discredited, so treat it as a tool, not a plan.

## What is installed on the device (NOT part of the setup scripts)

Installed by `tools/instrument-wifi-debug.sh`, removed by
`tools/uninstrument-wifi-debug.sh`. None of it is written by `install/setup*.sh`,
so a fresh image will not have it — and a re-run of `setup.sh` will not remove it.

| Artifact | Purpose |
|---|---|
| `/etc/systemd/journald.conf.d/zz-musicbox-diagnostic.conf` | `Storage=persistent`, overriding `setup.sh`'s `Storage=volatile`. **This is the single thing that makes the fault diagnosable** — every earlier failure erased the evidence of its own cause. |
| `/usr/local/bin/musicbox-netwatch` | Samples gateway/NAS reachability, link, signal, rx/tx bytes and MPD state every 10s **into the journal**, so it survives a hard power cycle. |
| `/etc/systemd/system/musicbox-netwatch.service` | Runs the above. |
| `kernel.hung_task_timeout_secs=30` | Runtime only, reverts on reboot. Reports blocked tasks sooner, so a warning lands before the box goes unreachable. |

Reading it back after a failure:

```sh
journalctl -t netwatch -b -1 --no-pager | grep DOWN   # previous boot
journalctl -k -b -1 --no-pager | grep -iE 'brcmfmac|blocked for more'
```

Two caveats:

- **`netwatch` pings the gateway and the NAS every 10s.** That is a keepalive, so
  it could in principle mask an idle-timeout-related dropout. It is negligible
  next to continuous FLAC streaming, but it is not zero.
- **Persistent journald costs SD writes** and was deliberately turned off by
  `setup.sh`. Remove the instrumentation once this is settled.
