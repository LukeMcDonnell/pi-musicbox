#!/usr/bin/env bash
#
# musicbox — uninstrument-wifi-debug.sh
#
# Removes everything tools/instrument-wifi-debug.sh installed, returning the box
# to what install/setup*.sh alone produce. See .claude/docs/wifi-instability.md.
#
# Usage:
#   sudo ./tools/uninstrument-wifi-debug.sh              # keep the collected logs
#   sudo ./tools/uninstrument-wifi-debug.sh --purge-logs # also delete them

set -euo pipefail

PURGE=0
[[ "${1:-}" == "--purge-logs" ]] && PURGE=1

[[ "$(id -u)" -eq 0 ]] || { echo "must run as root (try: sudo $0)" >&2; exit 1; }

if systemctl list-unit-files musicbox-netwatch.service >/dev/null 2>&1; then
    systemctl disable --now musicbox-netwatch.service >/dev/null 2>&1 || true
fi
rm -f /etc/systemd/system/musicbox-netwatch.service /usr/local/bin/musicbox-netwatch
systemctl daemon-reload
echo "+ netwatch removed"

# Back to setup.sh's Storage=volatile.
rm -f /etc/systemd/journald.conf.d/zz-musicbox-diagnostic.conf
systemctl restart systemd-journald
echo "+ journald back to the setup.sh default ($(journalctl --header 2>/dev/null | grep -c . >/dev/null && echo volatile))"

# Collected logs are NOT deleted by default: they are the point of the exercise,
# and a failure captured but discarded is worse than never instrumenting.
if [[ "$PURGE" -eq 1 ]]; then
    rm -rf /var/log/journal
    echo "+ /var/log/journal purged"
else
    if [[ -d /var/log/journal ]]; then
        echo ". /var/log/journal kept ($(du -sh /var/log/journal 2>/dev/null | cut -f1)) — re-run with --purge-logs to delete"
    fi
fi

# Runtime only; a reboot would have reset it anyway.
sysctl -w kernel.hung_task_timeout_secs=120 >/dev/null
echo "+ hung_task_timeout_secs back to 120"
echo
echo "The wifi power-save change is NOT undone by this script — it is a fix, not"
echo "instrumentation. To revert it:"
echo "  nmcli connection modify musicbox-wlan0 802-11-wireless.powersave 0"
