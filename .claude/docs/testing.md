# Testing

`bash tests/run-all.sh` — syntax, shellcheck, nine bash suites (**637 assertions**)
and the backend's 155 `node:test` cases. All green, shellcheck clean (2026-09-14). Safe on a dev machine:
`setup.sh` is never executed on the host, only inside a throwaway container.

These numbers go stale fast. `bash tests/run-all.sh | grep -oE 'passed: [0-9]+'`
sums the suites; the node figure is its own `# pass` line.

| Suite | Assertions | Covers |
|---|---:|---|
| `test-setup-helpers.sh` | 77 | Sources `setup.sh`'s helpers against temp fixtures: managed-block round-trips, single-line `cmdline.txt` edits, fstab rewriting, EEPROM key merge |
| `test-migrate-network.sh` | 25 | `--convert-only`: wifi/ethernet/static layouts, UUID preservation, the mandatory `0600`, and that a PSK never leaks into an ethernet profile |
| `test-hardware-config.sh` | 47 | `--emit-config`/`--emit-revert`: neutralising conflicting stock lines, overlay ordering, idempotency, `--keep-hdmi`/`--skip-*`, byte-for-byte revert |
| `test-kiosk-config.sh` | 61 | `--emit`: every chromium flag, the four systemd lines that make or break the launch (`PAMName`, `TTYPath`, `Restart`, `Conflicts`), that the config file drives the URL, and that the wrapper passes `bash -n` |
| `test-nas-config.sh` | 66 | `--emit-fstab` plus the sourced block writer: the boot contract, `ro`, `soft`, `\040` escaping, 6 fields, password never in fstab |
| `test-mpd-config.sh` | 82 | `--emit` plus the sourced block writer: `music_directory` is the nested path, the ALSA output targets card 0, **`mixer_type "none"` with no mixer control** (giving MPD the attenuator back would silently cost bits), `replaygain` off and no resampler, the unity script sets dB rather than percentages and turns `Deemphasis` off, its unit is ordered after `alsa-restore` and before `mpd`, `auto_update` off, and `--emit` writes nothing to stderr (a backtick in an unquoted heredoc would) |
| `test-server-config.sh` | 88 | `--emit`: that the server unit is **not** ordered after `mpd.service`, `CAP_NET_BIND_SERVICE` without root, the `.path`+shim restart pair, that the kiosk `Wants` (not `Requires`) the server, and that `dev-push.sh` never invokes sudo or `rsync --inplace` |
| `test-bluetooth-config.sh` | 138 | `--emit` plus the sourced rfkill helper: **that MPD is paused and the card has actually gone quiet BEFORE the Bluetooth audio unit is started** (and the reverse), that Debian's `bluealsa-aplay.service` is masked and the audio unit has no `[Install]` section, that aptX and aptX HD are enabled on the daemon's real `ExecStart=` line (they are off by default, and an earlier version wrote them to `/etc/default/bluez-alsa`, which nothing reads), `--volume=none` so nothing fights `musicbox-dac-unity`, that a soft-blocked radio is unblocked and a hard-blocked one is not pretended away, and that the arbiter's JSON survives quotes, backslashes and emoji in a device name |
| `src/backend` (node:test) | 155 | Snapshot shape (no delta fields, queue by version), config precedence, static-path traversal, and — against a **fake MPD server** — the keepalive, the unavailable grace period, and that an open SSE stream cannot wedge shutdown |
| `test-integration.sh` | 47 | The real `setup.sh` + `install.sh --dry-run` in `debian:trixie-slim` against a fake `/boot/firmware` |

## The frontend specs are NOT in run-all.sh

```sh
cd src/frontend && npx ng test --watch=false --browsers=ChromeHeadless   # 70 specs
```

Karma + Jasmine, colocated `*.spec.ts`. `run-all.sh` does not run them — its only
Node step is the backend's `node:test` — so they have to be run by hand and are
easy to forget. `tools/build.sh --check` does not run them either.

The pattern, from `queue.spec.ts` and the three library ones: build a fixture
typed from `@musicbox/shared`, provide a hand-rolled fake service through
`TestBed` (`{ provide: LibraryStore, useValue: fake }`), and assert on the
component's computed values rather than the DOM. Every component also has a
"creates without a backend present" case — `EventSource` will not connect under
test, and that is genuinely the state at boot before MPD is up.

**Two TestBed configurations in one `it` throws** ("test module has already been
instantiated"). Split the cases instead of resetting.

## And they still do not see the panel

Nothing above catches a layout that does not fit 800x480, which is how both
library detail screens shipped with their content below the fold. Screenshot it:

```sh
npm i puppeteer-core    # in a scratch dir; uses the system Chrome
# page.setViewport({ width: 800, height: 480 }) against http://musicbox.local/
```

A plain `chrome --headless --screenshot` hangs on these pages —
`--virtual-time-budget` never expires while the SSE stream is open.

## Three layers

**Fixture unit tests.** Source the script with `main "$@"` stripped, then call
its internal functions against a temp directory. This is the only way to reach
the code that *writes* files — and the layer that would have caught both
`setup-nas.sh` bugs, because the pure emit mode alone did not.

**Pure emit modes.** Every script has a mode that generates its output and exits,
touching no system state and needing no root, no hardware and no NAS. Any new
script needs one — it is the difference between a testable script and an
untestable one.

**Container integration.** `debian:trixie-slim` with the repo mounted read-only.
Asserts `--dry-run` changes nothing, a real run produces the expected config, and
a second run is byte-for-byte identical. Skips cleanly when Docker is absent.

### What the container cannot reach

No systemd, no Pi firmware. Therefore untested off-device:

- Phase 2 service/timer disabling — no `systemctl`. The predicates that *gate*
  it are covered by the helper tests.
- Phase 5 EEPROM — no `rpi-eeprom-config`.
- Phase 1 purging — Trixie slim has none of the purge candidates.

This is why `--dry-run` **on the actual Pi** is a real step, not a formality.

## Mutation-test the fix

The habit that has been worth it here: after fixing a bug, reintroduce it and
confirm the suite goes red, then remove it again. The fstab-newline bug trips 4
assertions; the unstarted-automount bug trips 1. A regression test that does not
fail against the original bug is not a regression test.

## What the tests must never stop enforcing

The boot contract, for both protocols: `noauto` **and** `x-systemd.automount`
**and** `nofail` present in the generated fstab line. That is what makes
`setup.sh`'s masked `NetworkManager-wait-online` safe. If someone "simplifies"
the mount, these assertions are the thing that catches it.

## A trap in the sourcing layer

Both `test-nas-config.sh` and `test-mpd-config.sh` source their script minus
`main` to reach the internal block writers. The sourced file carries
`set -euo pipefail`, which then applies to the **test shell** — which is
deliberately `set -uo pipefail`, no `-e`, so that a failing assertion does not
abort the run. The first deliberately-failing check after the `source` silently
kills the suite mid-way, and the summary line never prints.

All three suites that source a script — nas, mpd and bluetooth — call `set +e`
immediately afterwards. If you add a fourth, do the same.
