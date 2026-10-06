#!/usr/bin/env bash
#
# musicbox — instrument-wifi-debug.sh
#
# TEMPORARY DIAGNOSTIC INSTRUMENTATION for the network dropout described in
# .claude/docs/wifi-instability.md. Read that first.
#
# None of this belongs to install/setup*.sh. It is deliberately separate so it
# can be removed in one step: tools/uninstrument-wifi-debug.sh
#
# The important part is persistent journald. The failure takes the network with
# it, so anything that reports over the network is useless; and with
# setup.sh's Storage=volatile every failure erased the evidence of its cause.
#
# Usage: sudo ./tools/instrument-wifi-debug.sh

set -euo pipefail

# 1. Persistent journal. setup.sh deliberately set Storage=volatile (boot time +
#    SD wear), but that means every wedge erases the evidence of its own cause.
#    This is the single thing preventing diagnosis.
mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/zz-musicbox-diagnostic.conf <<'CONF'
# DIAGNOSTIC ONLY — added while chasing the wifi/network dropout.
# Overrides musicbox.conf's Storage=volatile so kernel logs survive a hard
# power cycle. Remove this file and restart systemd-journald to go back.
[Journal]
Storage=persistent
SystemMaxUse=200M
CONF
mkdir -p /var/log/journal
systemd-journald --version >/dev/null 2>&1 || true
systemctl restart systemd-journald
echo "journal: $(grep -h '^Storage=' /etc/systemd/journald.conf.d/*.conf | tail -1)"

# 2. A watcher that does not depend on the network, writing to disk so it can be
#    read after a power cycle. The failure kills wifi, so anything that reports
#    over the network is useless for this.
cat > /usr/local/bin/musicbox-netwatch <<'WATCH'
#!/bin/bash
# Samples network + MPD + NFS health every 10s into the journal (persistent).
# Journal rather than a file, so timestamps line up with kernel messages.
while true; do
    link=$(timeout 3 iw dev wlan0 link 2>/dev/null | sed -n '1p;/signal/p' | tr '\n' ' ')
    nm=$(timeout 3 nmcli -t -f STATE general 2>/dev/null)
    gw=$(timeout 3 ping -c1 -W2 192.168.1.1 >/dev/null 2>&1 && echo up || echo DOWN)
    nas=$(timeout 3 ping -c1 -W2 synonas.local >/dev/null 2>&1 && echo up || echo DOWN)
    mnt=$(timeout 3 findmnt -no FSTYPE /srv/music 2>/dev/null | tr '\n' ',')
    mpd=$(timeout 4 mpc status 2>/dev/null | sed -n 2p)
    err=$(timeout 4 mpc status 2>&1 | grep -i '^ERROR' || true)
    rx=$(cat /sys/class/net/wlan0/statistics/rx_bytes 2>/dev/null)
    tx=$(cat /sys/class/net/wlan0/statistics/tx_bytes 2>/dev/null)
    # Memory and D-state, so the next silent hang can be told from exhaustion.
    avail=$(awk '/^MemAvailable:/ { print int($2/1024) }' /proc/meminfo)
    swap=$(awk 'NR > 1 { u += $4 } END { print int(u/1024) }' /proc/swaps)
    load=$(cut -d' ' -f1 /proc/loadavg)
    chrome=$(timeout 3 ps -C chromium -o rss= 2>/dev/null | awk '{ s += $1 } END { print int(s/1024) }')
    dstate=$(timeout 3 ps -eo stat=,comm= 2>/dev/null | awk '$1 ~ /^D/ { printf "%s,", $2 }')
    printf 'NETWATCH gw=%s nas=%s nm=%s mnt=%s rx=%s tx=%s avail=%sM swap=%sM load=%s chromium=%sM D=[%s] link=[%s] mpd=[%s] %s\n' \
        "$gw" "$nas" "$nm" "$mnt" "$rx" "$tx" "$avail" "$swap" "$load" "$chrome" "$dstate" "$link" "$mpd" "$err"
    sleep 10
done
WATCH
chmod 0755 /usr/local/bin/musicbox-netwatch

cat > /etc/systemd/system/musicbox-netwatch.service <<'UNIT'
[Unit]
Description=musicbox network/MPD health watcher (DIAGNOSTIC — remove when done)
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/musicbox-netwatch
Restart=always
RestartSec=5
StandardOutput=journal
SyslogIdentifier=netwatch

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now musicbox-netwatch >/dev/null 2>&1
echo "netwatch: $(systemctl is-active musicbox-netwatch)"

# setup.sh owns kernel.hung_task_timeout_secs now: a hung task panics and reboots,
# so lowering it here would turn a slow NFS read into a reboot.
