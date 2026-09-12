#!/usr/bin/env bash
#
# musicbox — setup-kiosk.sh
#
# Puts a fullscreen browser on the DSI panel at boot: cage (a single-app Wayland
# kiosk compositor) running chromium. No desktop, no window manager, no display
# manager, no login prompt.
#
# Run order:  setup.sh -> setup-hardware.sh -> setup-kiosk.sh -> install.sh
#
# WHAT IT INSTALLS
#   /etc/musicbox/kiosk.conf                     KIOSK_URL + extra chromium flags
#   /usr/local/bin/musicbox-kiosk                launch wrapper
#   /etc/systemd/system/musicbox-kiosk.service   starts it at boot
#   /usr/share/musicbox/kiosk/index.html         holding page until the web UI exists
#
# HOW THE SESSION WORKS
#   cage needs a logind session that owns seat0. The unit gets one with
#   PAMName=login + TTYPath=/dev/tty1 — no greeter or display manager needed,
#   which is both simpler and faster to boot.
#
#   getty@tty1 is disabled so the panel shows the UI rather than a login prompt.
#   CONSOLE RECOVERY IS PRESERVED: autovt@ is aliased, so Ctrl+Alt+F2 on a
#   plugged-in keyboard still gives a login.
#
# Usage:
#   sudo ./setup-kiosk.sh --dry-run
#   sudo ./setup-kiosk.sh
#   sudo reboot
#   sudo ./setup-kiosk.sh --revert      # remove the kiosk, restore getty@tty1
#
#   ./setup-kiosk.sh --emit DEST
#       Write the four artifacts to a directory and exit. Touches no system
#       state; used by the tests and handy for reviewing before applying.

set -euo pipefail

readonly SCRIPT_VERSION="1.0.0"

readonly CONF_DIR="/etc/musicbox"
readonly CONF_FILE="${CONF_DIR}/kiosk.conf"
readonly WRAPPER="/usr/local/bin/musicbox-kiosk"
readonly UNIT="/etc/systemd/system/musicbox-kiosk.service"
readonly PAGE_DIR="/usr/share/musicbox/kiosk"
readonly PAGE="${PAGE_DIR}/index.html"
readonly CHROMIUM_PROFILE="/var/lib/musicbox/chromium"

readonly PACKAGES=(cage chromium)

DRY_RUN=0
ASSUME_YES=0
MODE="apply"
KIOSK_USER="musicbox"
# The web UI served by musicbox-server.service. Override with --url to point the
# panel at the bundled holding page or a dev machine.
DEFAULT_URL="http://localhost/"
EMIT_HOSTNAME=""

if [[ -t 1 ]]; then
    C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
    C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'
else
    C_RESET=""; C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""
fi

phase() { printf '\n%s==> %s%s\n' "${C_BOLD}${C_BLUE}" "$*" "${C_RESET}"; }
log()   { printf '    %s\n' "$*"; }
ok()    { printf '    %s+%s %s\n' "${C_GREEN}" "${C_RESET}" "$*"; }
skip()  { printf '    %s.%s %s\n' "${C_DIM}" "${C_RESET}" "${C_DIM}$*${C_RESET}"; }
warn()  { printf '    %s!%s %s\n' "${C_YELLOW}" "${C_RESET}" "$*" >&2; }
die()   { printf '\n%sERROR:%s %s\n' "${C_RED}${C_BOLD}" "${C_RESET}" "$*" >&2; exit 1; }
dry()   { [[ "$DRY_RUN" -eq 1 ]]; }

run() {
    if dry; then printf '    %s[dry-run]%s %s\n' "${C_DIM}" "${C_RESET}" "$*"
    else "$@"; fi
}

usage() { sed -n '3,37p' "$0" | sed 's/^# \{0,1\}//'; }

# install_if_changed <tmp> <dest> [mode] -> 0 changed, 1 already current
install_if_changed() {
    local tmp="$1" dest="$2" mode="${3:-0644}"
    if cmp -s "$tmp" "$dest" 2>/dev/null; then
        rm -f "$tmp"; return 1
    fi
    if dry; then
        printf '    %s[dry-run]%s would write %s\n' "${C_DIM}" "${C_RESET}" "$dest"
        rm -f "$tmp"; return 0
    fi
    install -D -m "$mode" "$tmp" "$dest"
    rm -f "$tmp"
    return 0
}

# ---------------------------------------------------------------------------
# Artifact generators — pure, so --emit and the tests exercise the real thing
# ---------------------------------------------------------------------------

gen_conf() {
    cat <<CONF
# musicbox kiosk configuration.
#
# Page the panel displays at boot. This is the web UI served by
# musicbox-server.service on port 80; the unit is ordered after it.
#
# To go back to the bundled holding page (useful when debugging the panel
# itself rather than the app):
#   KIOSK_URL="file://${PAGE}"
KIOSK_URL="${DEFAULT_URL}"

# Appended verbatim to the chromium command line. Example:
#   CHROMIUM_EXTRA_FLAGS="--force-device-scale-factor=1.25"
CHROMIUM_EXTRA_FLAGS=""
CONF
}

gen_wrapper() {
    cat <<'WRAPPER'
#!/usr/bin/env bash
# musicbox kiosk launcher. Installed by setup-kiosk.sh; edit kiosk.conf instead.
set -euo pipefail

CONF=/etc/musicbox/kiosk.conf
# shellcheck source=/dev/null
[[ -r "$CONF" ]] && . "$CONF"

KIOSK_URL="${KIOSK_URL:-http://localhost/}"
CHROMIUM_EXTRA_FLAGS="${CHROMIUM_EXTRA_FLAGS:-}"

# Debian ships the binary as `chromium`; older Pi OS used `chromium-browser`.
CHROMIUM="$(command -v chromium || command -v chromium-browser)"

FLAGS=(
    --ozone-platform=wayland
    --enable-features=UseOzonePlatform
    --noerrdialogs
    --disable-infobars
    --no-first-run
    --disable-session-crashed-bubble       # no "didn't shut down properly" after a power cut
    --disable-features=Translate,TranslateUI
    --disable-component-update
    --check-for-update-interval=31536000
    --password-store=basic                 # no keyring prompt on a headless box
    --autoplay-policy=no-user-gesture-required
    --overscroll-history-navigation=0      # a swipe must not mean "back" on touch
    --disable-pinch
    --touch-events=enabled                 # 'auto' can mis-detect under Ozone/Wayland
    --user-data-dir=/var/lib/musicbox/chromium
    --mute-audio                           # MPD owns the DAC; see README
)

# Word-splitting of CHROMIUM_EXTRA_FLAGS is intentional: it is a flag list.
# shellcheck disable=SC2206
[[ -n "$CHROMIUM_EXTRA_FLAGS" ]] && FLAGS+=($CHROMIUM_EXTRA_FLAGS)

exec cage -- "$CHROMIUM" "${FLAGS[@]}" --kiosk "$KIOSK_URL"
WRAPPER
}

gen_unit() {
    cat <<UNIT
[Unit]
Description=musicbox kiosk (cage + chromium on the DSI panel)
Documentation=https://github.com/musicbox
After=systemd-user-sessions.service
# The panel shows the UI, not a login prompt. Ctrl+Alt+F2 still gives a console.
Conflicts=getty@tty1.service
After=getty@tty1.service
# Chromium loading KIOSK_URL before the server is listening shows an error page.
# Wants= rather than Requires=: if the server is broken the panel should still
# come up and say so, not silently stay black.
Wants=musicbox-server.service
After=musicbox-server.service

[Service]
Type=simple
User=${KIOSK_USER}
# PAMName=login creates a real logind session, which is how cage's libseat
# acquires seat0. Without it cage exits with "Could not open seat".
PAMName=login
TTYPath=/dev/tty1
StandardInput=tty
StandardOutput=journal
StandardError=journal
TTYReset=yes
TTYVHangup=yes
TTYVTDisallocate=yes
ExecStart=${WRAPPER}
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT
}

gen_page() {
    local host="${1:-musicbox}"
    cat <<PAGE
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<title>musicbox</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; overflow: hidden; }
  body {
    background: #14161a; color: #e8eaed;
    font: 14px/1.35 system-ui, -apple-system, "DejaVu Sans", sans-serif;
    cursor: none; user-select: none;
    -webkit-tap-highlight-color: transparent; touch-action: none;
  }
  #pad { position: fixed; inset: 0; }
  header { position: fixed; top: 0; left: 0; right: 0; padding: 10px 14px; }
  h1 { margin: 0; font-size: 1.05rem; font-weight: 600; }
  h1 small { color: #9aa0a6; font-weight: 400; margin-left: .5rem; }
  #hint { margin: 2px 0 0; color: #9aa0a6; font-size: .8rem; }
  #stats {
    position: fixed; left: 14px; bottom: 12px;
    display: flex; gap: 1.25rem; font-variant-numeric: tabular-nums;
  }
  .s b { display: block; font-size: 1.5rem; color: #8ab4f8; font-weight: 600; }
  .s span { color: #9aa0a6; font-size: .7rem; text-transform: uppercase; letter-spacing: .06em; }
  .s.zero b { color: #f28b82; }
  #coords {
    position: fixed; right: 14px; bottom: 12px; text-align: right;
    color: #9aa0a6; font-size: .8rem;
  }
  #coords b { display: block; color: #e8eaed; font-size: 1.05rem; font-variant-numeric: tabular-nums; }
  #dot {
    position: fixed; width: 54px; height: 54px; margin: -27px 0 0 -27px;
    border: 2px solid #8ab4f8; border-radius: 50%;
    background: rgba(138,180,248,.18);
    opacity: 0; transition: opacity .5s ease-out; pointer-events: none;
  }
  #dot.on { opacity: 1; transition: none; }
</style>
</head>
<body>
<div id="pad"></div>
<header>
  <h1>musicbox <small>${host}.local</small></h1>
  <p id="hint">Kiosk running. Waiting for the web UI &mdash; set KIOSK_URL in /etc/musicbox/kiosk.conf</p>
</header>
<div id="dot"></div>
<div id="stats">
  <div class="s zero" id="s-touch"><b>0</b><span>touchstart</span></div>
  <div class="s zero" id="s-pointer"><b>0</b><span>pointerdown</span></div>
  <div class="s zero" id="s-click"><b>0</b><span>click</span></div>
</div>
<div id="coords">last point<b id="xy">&mdash;</b></div>
<script>
// Touch diagnostic. Which counters move tells you where touch breaks:
//   nothing        -> events are not reaching chromium at all
//   touch only     -> reaching chromium, but not synthesising clicks
//   all three      -> touch is fine
// And the dot shows WHERE the tap landed, which exposes a mis-mapped
// (inverted or swapped) touchscreen immediately.
(function () {
  var n = { touch: 0, pointer: 0, click: 0 };
  var dot = document.getElementById('dot');
  var xy  = document.getElementById('xy');
  var hideTimer;

  function bump(kind, x, y) {
    n[kind]++;
    var el = document.getElementById('s-' + kind);
    el.firstChild.textContent = n[kind];
    el.classList.remove('zero');
    if (x !== undefined && x !== null) {
      xy.textContent = Math.round(x) + ', ' + Math.round(y);
      dot.style.left = x + 'px';
      dot.style.top  = y + 'px';
      dot.classList.add('on');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(function () { dot.classList.remove('on'); }, 60);
    }
  }

  window.addEventListener('touchstart', function (e) {
    var t = e.changedTouches[0];
    bump('touch', t.clientX, t.clientY);
  }, { passive: true });

  window.addEventListener('pointerdown', function (e) { bump('pointer', e.clientX, e.clientY); });
  window.addEventListener('click',       function (e) { bump('click',   e.clientX, e.clientY); });
})();
</script>
</body>
</html>
PAGE
}

emit_all() {
    local dest="$1" host="${2:-$(hostname 2>/dev/null || echo musicbox)}"
    mkdir -p "$dest"
    gen_conf    > "${dest}/kiosk.conf"
    gen_wrapper > "${dest}/musicbox-kiosk"
    gen_unit    > "${dest}/musicbox-kiosk.service"
    gen_page "$host" > "${dest}/index.html"
    chmod 0755 "${dest}/musicbox-kiosk"
    printf '  wrote kiosk.conf musicbox-kiosk musicbox-kiosk.service index.html -> %s\n' "$dest"
}

# ---------------------------------------------------------------------------
require_root() { [[ "$(id -u)" -eq 0 ]] || die "must run as root (try: sudo $0)"; }

have_pkg() {
    dpkg-query -W -f='${db:Status-Status}' "$1" 2>/dev/null | grep -q '^installed$'
}

do_apply() {
    require_root

    phase "Preflight"
    id "$KIOSK_USER" >/dev/null 2>&1 || die "user '${KIOSK_USER}' does not exist"

    local g missing=0
    for g in video render input; do
        if id -nG "$KIOSK_USER" | tr ' ' '\n' | grep -qx "$g"; then
            ok "${KIOSK_USER} is in group ${g}"
        else
            warn "${KIOSK_USER} is NOT in group ${g} — cage may fail to open DRM/input"
            missing=1
        fi
    done
    [[ "$missing" -eq 1 ]] && warn "add with: usermod -aG video,render,input ${KIOSK_USER}"

    if [[ -e /dev/dri/card0 || -e /dev/dri/card1 ]]; then
        ok "DRM device present"
    else
        die "no /dev/dri/card* — is the graphics stack configured? run setup-hardware.sh first"
    fi

    phase "Packages"
    local p need=()
    for p in "${PACKAGES[@]}"; do
        if have_pkg "$p"; then skip "$p already installed"; else need+=("$p"); fi
    done
    if [[ ${#need[@]} -gt 0 ]]; then
        log "installing: ${need[*]}"
        log "(chromium pulls in ~129 packages; this takes a few minutes)"
        run env DEBIAN_FRONTEND=noninteractive apt-get update
        run env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${need[@]}"
        dry || ok "packages installed"
    fi

    phase "Artifacts"
    local host tmp changed=0
    host="$(hostname 2>/dev/null || echo musicbox)"

    tmp="$(mktemp)"; gen_conf > "$tmp"
    if install_if_changed "$tmp" "$CONF_FILE" 0644; then ok "$CONF_FILE"; changed=1
    else skip "$CONF_FILE already current"; fi

    tmp="$(mktemp)"; gen_wrapper > "$tmp"
    if install_if_changed "$tmp" "$WRAPPER" 0755; then ok "$WRAPPER"; changed=1
    else skip "$WRAPPER already current"; fi

    tmp="$(mktemp)"; gen_page "$host" > "$tmp"
    if install_if_changed "$tmp" "$PAGE" 0644; then ok "$PAGE"; changed=1
    else skip "$PAGE already current"; fi

    tmp="$(mktemp)"; gen_unit > "$tmp"
    if install_if_changed "$tmp" "$UNIT" 0644; then ok "$UNIT"; changed=1
    else skip "$UNIT already current"; fi

    run install -d -o "$KIOSK_USER" -g "$KIOSK_USER" -m 0755 "$CHROMIUM_PROFILE"

    phase "Enabling"
    if dry; then
        printf '    %s[dry-run]%s would disable getty@tty1 and enable musicbox-kiosk\n' "${C_DIM}" "${C_RESET}"
    else
        systemctl daemon-reload
        if systemctl is-enabled getty@tty1.service >/dev/null 2>&1; then
            systemctl disable getty@tty1.service >/dev/null 2>&1 || true
            ok "getty@tty1 disabled (console still on Ctrl+Alt+F2)"
        else
            skip "getty@tty1 already disabled"
        fi
        systemctl enable musicbox-kiosk.service >/dev/null 2>&1
        ok "musicbox-kiosk enabled"
    fi

    if dry; then
        printf '\n    %sDry run — nothing was changed.%s\n' "${C_BOLD}" "${C_RESET}"
        return 0
    fi

    cat <<EOF

    ${C_BOLD}Reboot to start the kiosk.${C_RESET}   sudo reboot

    Then:
      systemctl status musicbox-kiosk      # should be active
      journalctl -u musicbox-kiosk -b      # cage/chromium output
      systemd-analyze blame | head         # what it costs at boot

    The panel should show the holding page with a working tap counter.
    Point it at the real UI later by editing ${CONF_FILE}.

    If it misbehaves:  sudo $0 --revert && sudo reboot
EOF
    [[ "$changed" -eq 0 ]] && skip "(no artifact changed this run)"
    return 0
}

do_revert() {
    require_root
    phase "Removing the kiosk"

    if systemctl list-unit-files musicbox-kiosk.service >/dev/null 2>&1; then
        run systemctl disable --now musicbox-kiosk.service
    fi
    run rm -f "$UNIT" "$WRAPPER" "$CONF_FILE" "$PAGE"
    run systemctl daemon-reload
    run systemctl enable getty@tty1.service
    ok "kiosk removed, getty@tty1 restored"
    log "packages (cage, chromium) were left installed; remove with:"
    log "  sudo apt-get purge cage chromium && sudo apt-get autoremove --purge"
    log "reboot to return the panel to a console"
}

main() {
    local dest=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --dry-run)  DRY_RUN=1 ;;
            -y|--yes)   ASSUME_YES=1 ;;
            --user)     KIOSK_USER="${2:?--user needs a value}"; shift ;;
            --hostname) EMIT_HOSTNAME="${2:?--hostname needs a value}"; shift ;;
            --url)      DEFAULT_URL="${2:?--url needs a value}"; shift ;;
            --revert)   MODE="revert" ;;
            --emit)     MODE="emit"; dest="${2:-}"; shift ;;
            -h|--help)  usage; exit 0 ;;
            *)          usage >&2; die "unknown option: $1" ;;
        esac
        shift
    done
    : "$ASSUME_YES"

    case "$MODE" in
        emit)
            [[ -n "$dest" ]] || die "--emit needs a destination directory"
            emit_all "$dest" "${EMIT_HOSTNAME:-$(hostname 2>/dev/null || echo musicbox)}"
            ;;
        revert)
            printf '%smusicbox setup-kiosk.sh %s%s\n' "${C_BOLD}" "${SCRIPT_VERSION}" "${C_RESET}"
            do_revert
            ;;
        *)
            printf '%smusicbox setup-kiosk.sh %s%s\n' "${C_BOLD}" "${SCRIPT_VERSION}" "${C_RESET}"
            dry && printf '%sDRY RUN — no changes will be made%s\n' "${C_YELLOW}" "${C_RESET}"
            do_apply
            ;;
    esac
}

main "$@"
