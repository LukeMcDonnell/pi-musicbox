#!/usr/bin/env bash
#
# Tests the netplan -> NM keyfile conversion in install/migrate-network.sh.
# Uses --convert-only, which touches no system state: no systemd, no nmcli,
# no /etc. Safe on a development machine.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO/install/migrate-network.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if ! python3 -c 'import yaml' 2>/dev/null; then
    echo "SKIP: python3-yaml not available on this machine" >&2
    exit 0
fi

PASS=0; FAIL=0
check() {
    if [[ "$2" == "$3" ]]; then
        PASS=$((PASS+1)); printf '  ok   %s\n' "$1"
    else
        FAIL=$((FAIL+1)); printf '  FAIL %s\n       expected: %q\n       actual:   %q\n' "$1" "$2" "$3"
    fi
}
banner() { printf '\n== %s ==\n' "$1"; }
exists() { if [[ -e "$1" ]]; then echo 0; else echo 1; fi; }

SRC="$WORK/netplan"; DEST="$WORK/keyfiles"
mkdir -p "$SRC"

# Mirrors the real layout Raspberry Pi Imager + cloud-init produces.
cat > "$SRC/90-NM-84cab133-3717-304d-8ca7-8f76fadea743.yaml" <<'FIX'
network:
  version: 2
  wifis:
    wlan0:
      renderer: NetworkManager
      match: {}
      dhcp4: true
      access-points:
        "testnet":
          auth:
            key-management: "psk"
            password: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
          networkmanager:
            uuid: "84cab133-3717-304d-8ca7-8f76fadea743"
            name: "netplan-wlan0-testnet"
      networkmanager:
        uuid: "84cab133-3717-304d-8ca7-8f76fadea743"
        name: "netplan-wlan0-testnet"
FIX

cat > "$SRC/90-NM-75a1216a-9d1a-30cd-8aca-ace5526ec021.yaml" <<'FIX'
network:
  version: 2
  ethernets:
    eth0:
      renderer: NetworkManager
      match: {}
      dhcp4: true
      dhcp6: true
      networkmanager:
        uuid: "75a1216a-9d1a-30cd-8aca-ace5526ec021"
        name: "netplan-eth0"
FIX

# A static-IP interface, to prove dhcp isn't assumed.
cat > "$SRC/95-static.yaml" <<'FIX'
network:
  version: 2
  ethernets:
    eth1:
      dhcp4: false
      addresses: [10.0.0.5/24]
      nameservers:
        addresses: [10.0.0.1, 1.1.1.1]
      networkmanager:
        uuid: "11111111-2222-3333-4444-555555555555"
        name: "static-eth1"
FIX

banner "conversion runs"
out="$(bash "$SCRIPT" --convert-only "$SRC" "$DEST" 2>&1)"
check "exits 0" "0" "$?"
check "reports 3 connections" "0" "$(grep -q '3 connection(s) converted' <<<"$out"; echo $?)"

W="$DEST/netplan-wlan0-testnet.nmconnection"
E="$DEST/netplan-eth0.nmconnection"
S="$DEST/static-eth1.nmconnection"

banner "wifi connection"
check "wifi keyfile created"    "0" "$(exists "$W")"
check "perms are 0600"          "600" "$(stat -c %a "$W")"
check "type=wifi"               "0" "$(grep -qx 'type=wifi' "$W"; echo $?)"
check "interface-name=wlan0"    "0" "$(grep -qx 'interface-name=wlan0' "$W"; echo $?)"
check "uuid preserved"          "0" "$(grep -qx 'uuid=84cab133-3717-304d-8ca7-8f76fadea743' "$W"; echo $?)"
check "ssid carried over"       "0" "$(grep -qx 'ssid=testnet' "$W"; echo $?)"
check "key-mgmt mapped psk->wpa-psk" "0" "$(grep -qx 'key-mgmt=wpa-psk' "$W"; echo $?)"
check "psk carried over"        "0" "$(grep -q '^psk=0123456789abcdef' "$W"; echo $?)"
check "mode=infrastructure"     "0" "$(grep -qx 'mode=infrastructure' "$W"; echo $?)"
check "dhcp4 -> ipv4 auto"      "0" "$(awk '/^\[ipv4\]/{f=1;next}/^\[/{f=0}f&&/^method=auto$/{found=1}END{exit !found}' "$W"; echo $?)"
check "autoconnect enabled"     "0" "$(grep -qx 'autoconnect=true' "$W"; echo $?)"

banner "ethernet connection"
check "eth keyfile created"     "0" "$(exists "$E")"
check "perms are 0600"          "600" "$(stat -c %a "$E")"
check "type=ethernet"           "0" "$(grep -qx 'type=ethernet' "$E"; echo $?)"
check "no wifi-security section" "0" "$(! grep -q 'wifi-security' "$E"; echo $?)"
check "no psk leaked in"        "0" "$(! grep -q '^psk=' "$E"; echo $?)"
check "ethernet outranks wifi"  "0" "$(grep -qx 'autoconnect-priority=200' "$E"; echo $?)"

banner "static addressing is not clobbered by a dhcp assumption"
check "static keyfile created"  "0" "$(exists "$S")"
check "ipv4 method=manual"      "0" "$(awk '/^\[ipv4\]/{f=1;next}/^\[/{f=0}f&&/^method=manual$/{found=1}END{exit !found}' "$S"; echo $?)"
check "address carried over"    "0" "$(grep -qx 'address1=10.0.0.5/24' "$S"; echo $?)"
check "nameservers carried over" "0" "$(grep -qx 'dns=10.0.0.1;1.1.1.1;' "$S"; echo $?)"

banner "conversion is deterministic"
sum1="$(cat "$DEST"/*.nmconnection | md5sum)"
rm -rf "$DEST"
bash "$SCRIPT" --convert-only "$SRC" "$DEST" >/dev/null 2>&1
check "same input yields identical output" "$sum1" "$(cat "$DEST"/*.nmconnection | md5sum)"

banner "refuses to produce nothing"
EMPTY="$WORK/empty"; mkdir -p "$EMPTY"
bash "$SCRIPT" --convert-only "$EMPTY" "$WORK/out-empty" >/dev/null 2>&1
check "empty input exits non-zero" "3" "$?"

printf '\n===============================\n passed: %d   failed: %d\n===============================\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
