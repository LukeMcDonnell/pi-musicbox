# Testing

`bash tests/run-all.sh` — syntax, shellcheck, then six suites. **307 assertions**,
all green, shellcheck clean (verified 2026-09-12). Safe on a dev machine:
`setup.sh` is never executed on the host, only inside a throwaway container.

| Suite | Assertions | Covers |
|---|---:|---|
| `test-setup-helpers.sh` | 62 | Sources `setup.sh`'s helpers against temp fixtures: managed-block round-trips, single-line `cmdline.txt` edits, fstab rewriting, EEPROM key merge |
| `test-migrate-network.sh` | 25 | `--convert-only`: wifi/ethernet/static layouts, UUID preservation, the mandatory `0600`, and that a PSK never leaks into an ethernet profile |
| `test-hardware-config.sh` | 47 | `--emit-config`/`--emit-revert`: neutralising conflicting stock lines, overlay ordering, idempotency, `--keep-hdmi`/`--skip-*`, byte-for-byte revert |
| `test-kiosk-config.sh` | 60 | `--emit`: every chromium flag, the four systemd lines that make or break the launch (`PAMName`, `TTYPath`, `Restart`, `Conflicts`), that the config file drives the URL, and that the wrapper passes `bash -n` |
| `test-nas-config.sh` | 66 | `--emit-fstab` plus the sourced block writer: the boot contract, `ro`, `soft`, `\040` escaping, 6 fields, password never in fstab |
| `test-integration.sh` | 47 | The real `setup.sh` + `install.sh --dry-run` in `debian:trixie-slim` against a fake `/boot/firmware` |

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
