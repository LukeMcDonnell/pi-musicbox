# musicbox

A Raspberry Pi music player appliance. Right now the repo is **install scripts +
a test suite** — there is no application code yet (`frontend/` is an empty
placeholder).

`README.md` is the user-facing document: run order, measurements, rationale.
Keep it in sync when behaviour changes. The files below are the working notes
for whoever is editing the code.

| Read this | When |
|---|---|
| `.claude/docs/architecture.md` | Changing or adding an `install/*.sh` script |
| `.claude/docs/device.md` | Anything touching the real hardware or the NAS |
| `.claude/docs/decisions.md` | **Before "fixing" something that looks wrong** — it usually isn't |
| `.claude/docs/testing.md` | Writing or debugging tests |
| `.claude/docs/roadmap.md` | Picking up the next piece of work |

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
4. **Every script must be idempotent and re-runnable**, and must have a
   `--dry-run` and a working `--revert`.
5. **Measure, don't assume.** Several confident predictions in this project were
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
- Comments explain *why*, especially where the obvious-looking code is wrong.
  The existing headers carry the reasoning — do not strip them when editing.
- Backups go to `/var/lib/musicbox/`, config to `/etc/musicbox/`.

## Commands

```sh
bash tests/run-all.sh          # syntax + shellcheck + 6 suites (307 assertions)
bash tests/test-nas-config.sh  # one suite
shellcheck install/*.sh tests/*.sh
```

Tests must stay green and shellcheck clean before anything is called done.
`run-all.sh` is safe on this dev machine — the scripts only ever execute inside
a throwaway container.

## Working on the device

The Pi is reachable at `musicbox@musicbox.local` (password is the user's; it is
deliberately not recorded in this repo). The user commits to git manually — do
not commit unless asked.

**The device drifts.** Files have been edited here and `scp`'d piecemeal, and a
stale copy on the Pi has already cost a debugging cycle. After changing a
script, sync the whole `install/` and `tests/` directories and verify with
`md5sum`, not just the one file you touched.
