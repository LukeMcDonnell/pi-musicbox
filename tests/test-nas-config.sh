#!/usr/bin/env bash
#
# Tests the fstab generation in install/setup-nas.sh via --emit-fstab, which
# touches no system state and needs neither root nor a NAS.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO/install/setup-nas.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0; FAIL=0
check() {
    if [[ "$2" == "$3" ]]; then
        PASS=$((PASS+1)); printf '  ok   %s\n' "$1"
    else
        FAIL=$((FAIL+1)); printf '  FAIL %s\n       expected: %q\n       actual:   %q\n' "$1" "$2" "$3"
    fi
}
banner() { printf '\n== %s ==\n' "$1"; }
emit()   { bash "$SCRIPT" --emit-fstab "$@"; }
opts()   { printf '%s' "$1" | awk -F'\t' '{print $4}'; }
hasopt() { printf '%s' "$2" | tr ',' '\n' | grep -qx -- "$1"; echo $?; }

SMB="$(emit --protocol smb --host nas --share Music --mountpoint /srv/music)"
NFS="$(emit --protocol nfs --host nas --share /volume1/music --mountpoint /srv/music)"
SMBO="$(opts "$SMB")"; NFSO="$(opts "$NFS")"

banner "THE BOOT CONTRACT (setup.sh masks NetworkManager-wait-online)"
for o in noauto x-systemd.automount nofail _netdev; do
    check "smb has $o" "0" "$(hasopt "$o" "$SMBO")"
    check "nfs has $o" "0" "$(hasopt "$o" "$NFSO")"
done
check "smb has an idle timeout" "0" "$(printf '%s' "$SMBO" | grep -qE 'x-systemd\.idle-timeout=[0-9]+'; echo $?)"
check "nfs has an idle timeout" "0" "$(printf '%s' "$NFSO" | grep -qE 'x-systemd\.idle-timeout=[0-9]+'; echo $?)"
# A bare `auto` would make this mount at boot and reintroduce the delay.
check "smb never says plain auto" "1" "$(hasopt auto "$SMBO")"
check "nfs never says plain auto" "1" "$(hasopt auto "$NFSO")"

banner "read-only"
check "smb is ro"      "0" "$(hasopt ro "$SMBO")"
check "nfs is ro"      "0" "$(hasopt ro "$NFSO")"
check "smb is not rw"  "1" "$(hasopt rw "$SMBO")"
check "nfs is not rw"  "1" "$(hasopt rw "$NFSO")"

banner "protocol specifics"
check "smb fstype cifs" "cifs" "$(printf '%s' "$SMB" | awk -F'\t' '{print $3}')"
check "nfs fstype nfs"  "nfs"  "$(printf '%s' "$NFS" | awk -F'\t' '{print $3}')"
check "smb source is //host/share" "//nas/Music" "$(printf '%s' "$SMB" | awk -F'\t' '{print $1}')"
check "nfs source is host:/export" "nas:/volume1/music" "$(printf '%s' "$NFS" | awk -F'\t' '{print $1}')"
check "smb uses a credentials file" "0" "$(hasopt 'credentials=/etc/musicbox/nas.credentials' "$SMBO")"
check "smb sets file_mode" "0" "$(hasopt 'file_mode=0444' "$SMBO")"
check "smb sets dir_mode"  "0" "$(hasopt 'dir_mode=0555' "$SMBO")"
# A hard NFS mount blocks processes forever when the NAS disappears.
check "nfs is soft, not hard" "0" "$(hasopt soft "$NFSO")"
check "nfs is not hard"       "1" "$(hasopt hard "$NFSO")"

banner "credentials never leak into fstab"
OUT="$(emit --protocol smb --host nas --share Music --username bob)"
check "no username in the line" "1" "$(grep -q 'bob' <<<"$OUT"; echo $?)"
check "no password= in the line" "1" "$(grep -q 'password=' <<<"$OUT"; echo $?)"

banner "fstab escaping (Synology shares often contain spaces)"
SP="$(emit --protocol smb --host nas --share 'My Music' --mountpoint '/srv/My Music')"
check "space in share escaped"      "0" "$(grep -qF '//nas/My\040Music' <<<"$SP"; echo $?)"
check "space in mountpoint escaped" "0" "$(grep -qF '/srv/My\040Music' <<<"$SP"; echo $?)"
check "no raw space in field 1"     "1" "$(awk -F'\t' '{print $1}' <<<"$SP" | grep -q ' '; echo $?)"
check "no raw space in field 2"     "1" "$(awk -F'\t' '{print $2}' <<<"$SP" | grep -q ' '; echo $?)"
NSP="$(emit --protocol nfs --host nas --share '/volume1/My Music')"
check "nfs export space escaped"    "0" "$(grep -qF 'nas:/volume1/My\040Music' <<<"$NSP"; echo $?)"

banner "well-formed fstab record"
for label in smb nfs; do
    line="$SMB"; [[ "$label" == nfs ]] && line="$NFS"
    check "$label has exactly 6 fields" "6" "$(awk -F'\t' '{print NF}' <<<"$line")"
    check "$label is one line"          "1" "$(wc -l <<<"$line")"
    check "$label dump/pass are 0 0"    "0 0" "$(awk -F'\t' '{print $5, $6}' <<<"$line")"
done

banner "determinism"
check "same input, same output" "$SMB" "$(emit --protocol smb --host nas --share Music --mountpoint /srv/music)"

banner "argument validation"
bash "$SCRIPT" --emit-fstab --protocol smb --host nas >/dev/null 2>&1
check "missing --share is refused" "1" "$?"
bash "$SCRIPT" --emit-fstab --protocol carrier-pigeon --host nas --share x >/dev/null 2>&1
check "unknown protocol is refused" "1" "$?"
bash "$SCRIPT" --bogus >/dev/null 2>&1
check "unknown option is refused" "1" "$?"

banner "managed block does not collide with setup.sh's"
check "uses its own marker" "0" "$(grep -q 'musicbox setup-nas.sh managed block' "$SCRIPT"; echo $?)"
check "does not reuse setup.sh's marker" "1" "$(grep -q '>>> musicbox setup.sh managed block' "$SCRIPT"; echo $?)"

banner "NFS failure is diagnosed, not just reported"
check "explains an empty export list" "0" "$(grep -q 'exports NOTHING at all' "$SCRIPT"; echo $?)"
check "distinguishes empty vs not-permitted" "0" "$(grep -q 'but not to this host' "$SCRIPT"; echo $?)"
check "gives the DSM path to fix it" "0" "$(grep -q 'NFS Permissions' "$SCRIPT"; echo $?)"
check "suggests smb as the no-config alternative" "0" "$(grep -q 'no NAS-side configuration' "$SCRIPT"; echo $?)"
check "finds showmount outside PATH" "0" "$(grep -q '/sbin/showmount' "$SCRIPT"; echo $?)"
check "still writes nothing on failure" "0" "$(grep -q 'the system is unchanged' "$SCRIPT"; echo $?)"

banner "fstab block is well-formed (regression: markers must not join the record)"
# These need the real internal functions, so source the script minus main.
HARNESS="$WORK/h.sh"
sed -e '$ d' -e 's/^readonly \(FSTAB\|CREDS\|CONF_DIR\|STATE_DIR\)=/\1=/' "$SCRIPT" > "$HARNESS"
# shellcheck source=/dev/null
source "$HARNESS"
# The sourced script carries `set -euo pipefail`, which would now apply to THIS
# shell and abort the run on the first deliberately-failing assertion.
set +e

FIX="$WORK/fstab"
cat > "$FIX" <<'FSTABFIX'
proc /proc proc defaults 0 0
PARTUUID=ab-02 / ext4 defaults,noatime 0 1

# >>> musicbox setup.sh managed block >>>
tmpfs /tmp tmpfs defaults,noatime 0 0
# <<< musicbox setup.sh managed block <<<
FSTABFIX
ORIG_FSTAB="$(cat "$FIX")"

# Exactly how do_apply calls it: command substitution strips the newline.
line="$(build_fstab_line nfs synonas.local /volume1/Music /srv/music)"
out="$(write_managed_block "$FIX" "$line")"
cp "$out" "$FIX.new"; rm -f "$out"

check "entry line has exactly 6 fields" "6" "$(awk '/^synonas/{print NF; exit}' "$FIX.new")"
check "closing marker is on its own line" "0" "$(grep -qx '# <<< musicbox setup-nas.sh managed block <<<' "$FIX.new"; echo $?)"
check "marker never glued to the record" "1" "$(grep -qE '^synonas.*<<<' "$FIX.new"; echo $?)"
check "opening marker on its own line" "0" "$(grep -qx '# >>> musicbox setup-nas.sh managed block >>>' "$FIX.new"; echo $?)"
check "last field is 0, not 0#..." "0" "$(awk '/^synonas/{exit ($NF=="0")?0:1}' "$FIX.new"; echo $?)"
check "setup.sh block survives untouched" "1" "$(grep -c '>>> musicbox setup.sh' "$FIX.new")"
check "exactly one of our blocks" "1" "$(grep -c '>>> musicbox setup-nas.sh' "$FIX.new")"

# rewriting must not accumulate blocks
out2="$(write_managed_block "$FIX.new" "$line")"
check "re-writing leaves one block" "1" "$(grep -c '>>> musicbox setup-nas.sh' "$out2")"
check "re-writing is byte-identical" "0" "$(cmp -s "$FIX.new" "$out2"; echo $?)"
rm -f "$out2"

# strip must restore the original exactly
out3="$(strip_managed_block "$FIX.new")"
check "strip restores the original" "$ORIG_FSTAB" "$(cat "$out3")"
rm -f "$out3"

banner "the automount unit must be STARTED, not just generated"
# Matching literal source text below, so the single quotes are deliberate.
# shellcheck disable=SC2016
check "script starts the .automount unit" "0" "$(grep -q 'systemctl start "\$aunit"' "$SCRIPT"; echo $?)"
# shellcheck disable=SC2016
check "verifies the unit is active" "0" "$(grep -q 'is-active "\$aunit"' "$SCRIPT"; echo $?)"
# shellcheck disable=SC2016
check "verification requires a real mount, not just a readable dir" "0" "$(grep -q 'findmnt -no SOURCE "\$MOUNTPOINT"' "$SCRIPT"; echo $?)"

banner "installs nothing (packages belong to install.sh)"
check "no apt-get in setup-nas.sh" "1" "$(grep -q 'apt-get' "$SCRIPT"; echo $?)"
check "points at install.sh when a client is missing" "0" "$(grep -q 'install.sh' "$SCRIPT"; echo $?)"
check "install.sh installs the NAS clients" "0" "$(grep -qE '^\s+(cifs-utils|nfs-common|smbclient)' "$REPO/install/install.sh"; echo $?)"

printf '\n===============================\n passed: %d   failed: %d\n===============================\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
