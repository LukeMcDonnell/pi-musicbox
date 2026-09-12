#!/bin/bash
# Isolation test: does the box stay up with NO display activity?
#
# WRITTEN FOR A THEORY THAT WAS SUBSEQUENTLY DISCREDITED. The failure turned out
# to be network loss, not a display deadlock — the kiosk keeps rendering right
# through it. See .claude/docs/wifi-instability.md.
#
# Kept because it is still the right tool IF the traced vc4/clk/mailbox deadlock
# ever reproduces: it removes every vc4 atomic commit, so surviving this while
# wedging with the kiosk running would implicate the display path.
#
# Run with sudo. Logs to /tmp/isolate.log, one line a minute for 30 minutes.
set -u
OUT=/tmp/isolate.log
: > "$OUT"
echo "stopping the kiosk (chromium + cage = all vc4 commits)" >> "$OUT"
systemctl stop musicbox-kiosk >> "$OUT" 2>&1
mpc -q clear 2>/dev/null; mpc -q add '!!!' 2>/dev/null; mpc -q play 2>/dev/null
for _ in $(seq 1 30); do
    printf 'up=%-6s hung=%-3s kiosk=%-9s chromium=%-3s %s\n' \
      "$(awk '{printf "%.0f", $1}' /proc/uptime)" \
      "$(journalctl -k -b --no-pager 2>/dev/null | grep -c 'blocked for more than')" \
      "$(systemctl is-active musicbox-kiosk)" \
      "$(pgrep -c chromium || echo 0)" \
      "$(timeout 5 mpc status 2>/dev/null | sed -n 2p)" >> "$OUT"
    sleep 60
done
echo "done" >> "$OUT"
