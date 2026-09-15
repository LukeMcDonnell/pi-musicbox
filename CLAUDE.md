# musicbox

A Raspberry Pi music player appliance: bash install scripts, a TypeScript
backend bridging MPD, and an Angular frontend served to both the panel and
phones.

```
src/backend/   Fastify + TS source      ->  backend/    committed build output
src/frontend/  Angular workspace        ->  frontend/   committed build output
src/shared/    the API contract, imported by BOTH sides
install/       setup scripts     tools/  build + dev-push     tests/
```

`README.md` is the user-facing document: run order, measurements, rationale.
Keep it in sync when behaviour changes. The files below are the working notes
for whoever is editing the code.

| Read this | When |
|---|---|
| `.claude/docs/architecture.md` | Changing or adding an `install/*.sh` script |
| `.claude/docs/device.md` | Anything touching the real hardware or the NAS — including the panel's backlight |
| `.claude/docs/decisions.md` | **Before "fixing" something that looks wrong** — it usually isn't |
| `.claude/docs/testing.md` | Writing or debugging tests |
| `.claude/docs/roadmap.md` | Picking up the next piece of work |
| `.claude/docs/bluetooth.md` | **Anything Bluetooth.** The A2DP sink, why the DAC handoff is sequenced by a root arbiter rather than the backend, the codec ladder and why there is no AAC |
| `.claude/docs/clock-deadlock.md` | **Any "the box stopped responding" report — start here.** Diagnosed: a firmware/clock deadlock. Has the triage commands and tells this fault apart from the wifi one |
| `.claude/docs/wifi-instability.md` | The *other* "stopped responding" fault — network drops, kiosk keeps running. Open issue, and there is temporary instrumentation on the device |

## Non-negotiables

1. **Nothing in `/etc/fstab` may wait for the network.** `setup.sh` masks
   `NetworkManager-wait-online`; that is only safe while every network mount is
   `noauto,x-systemd.automount,...,nofail`. A plain `_netdev` mount reintroduces
   the delay and hangs boot when the NAS is off. The tests enforce this.
2. **One managed block per script, one marker per script.** Three scripts write
   to `/boot/firmware/config.txt`; they must never share a marker.
3. **`install.sh` installs packages. `setup-*.sh` configure.** The single
   deliberate exception is `setup-kiosk.sh`, which installs `cage` and
   `chromium` itself so the whole kiosk can be removed by deleting one script.
   MPD follows the rule: packages in `install.sh`, config in `setup-mpd.sh`.
4. **Every script must be idempotent and re-runnable**, and must have a
   `--dry-run` and a working `--revert`.
5. **The Pi is never a build machine.** No npm on the device — the runtime is 12
   packages, Debian's npm is 363. Build here, push a single bundled
   `backend/server.js` plus static files.
6. **Measure, don't assume.** Several confident predictions in this project were
   wrong on the real hardware (see `decisions.md`). `systemd-analyze` cannot see
   the ~11s pre-kernel firmware stage; use `sudo vclog --msg`.

## Conventions

- `set -euo pipefail` in every script. Declare and assign separately when the
  command may fail (`local x; x="$(cmd)" || true`) — otherwise `set -e` kills
  the whole script.
- Shared shape across all five scripts: `phase`/`log`/`ok`/`skip`/`warn`/`die`,
  a `run()` wrapper honouring `dry`, `--dry-run`, `--yes`, `--revert`.
- **Pure emit modes** are how everything is tested without root or hardware:
  `--emit-config`/`--emit-revert` (hardware), `--emit` (kiosk),
  `--emit-fstab` (nas), `--convert-only` (network). Add one to any new script.
- **SSE events are always a complete snapshot, never a delta** — a dropped event
  must cost nothing. The queue is referenced by version, not embedded.
- **Keep comments short.** One line, occasionally two, and only where the code
  would otherwise mislead — say *why*, never *what*. No essay headers, no
  measurement write-ups, no history of earlier attempts, no restating the code.
  Reasoning longer than that belongs in `.claude/docs/decisions.md`, not the
  source. Older files still carry long comments: don't add to them, and it is
  fine to cut them down in code you are already changing.
- Backups go to `/var/lib/musicbox/`, config to `/etc/musicbox/`, and the box's
  own state to `/var/lib/musicbox/data/musicbox.db` — **never** under
  `backend/`, which `dev-push.sh` rsyncs with `--delete`.
- **Settings are the device's or the box's, and that decides where they live.**
  Per-device (what this screen does) is `preferences.ts` and localStorage;
  per-box (what a piece of the hardware does) is the database, reaching clients
  on the SSE stream. The test is how many of the thing there are — see
  `decisions.md`.
- **Text fields get the panel's on-screen keyboard automatically** — no wiring.
  Set `enterkeyhint` to label its Enter key, `type`/`inputmode` numeric to open
  on digits, `inputmode="none"` to opt out. On a phone or `ng serve`, add
  `?keyboard` to see it. See `on-screen-keyboard.ts`.

## Commands

Node 24+ is required: the backend imports `node:sqlite` and the tests are `.ts`
run directly. Debian's node 20 does neither.

```sh
bash tests/run-all.sh          # shellcheck + 9 suites (672 asserts) + 188 node tests
cd src/frontend && npx ng test --watch=false --browsers=ChromeHeadless  # 121 specs
bash tests/test-server-config.sh   # one suite
tools/build.sh --check             # typecheck + node tests + bundle
tools/dev-push.sh --backend        # build, push to the Pi, ~2.5s
shellcheck install/*.sh tests/*.sh
```

Tests must stay green and shellcheck clean before anything is called done.
`run-all.sh` is safe on this dev machine — the scripts only ever execute inside
a throwaway container.

## The device has temporary diagnostic instrumentation on it

Persistent journald and a `musicbox-netwatch` service, installed by
`tools/instrument-wifi-debug.sh` and **not** by any `install/setup*.sh`. It is
there because the box intermittently drops off the network and every earlier
failure erased its own evidence. Do not be surprised by it, and do not remove it
piecemeal — `tools/uninstrument-wifi-debug.sh` takes it all out.
See `.claude/docs/wifi-instability.md`.

## Working on the device

The Pi is reachable at `musicbox@musicbox.local` (password is the user's; it is
deliberately not recorded in this repo). The user commits to git manually — do
not commit unless asked.

**The device drifts.** Files have been edited here and `scp`'d piecemeal, and a
stale copy on the Pi has already cost a debugging cycle. After changing a
script, sync the whole `install/` and `tests/` directories and verify with
`md5sum`, not just the one file you touched.
