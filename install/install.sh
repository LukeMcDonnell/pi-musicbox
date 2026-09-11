#!/usr/bin/env bash
#
# musicbox — install.sh
#
# Installs the music player stack. Runs AFTER setup.sh has stripped and tuned
# the OS. Not yet implemented.
#
# ===========================================================================
# CONTRACT WITH setup.sh — read before writing anything here
# ===========================================================================
#
# 1. THE MUSIC SHARE MUST NOT BLOCK BOOT.
#
#    setup.sh masks NetworkManager-wait-online.service, which is the single
#    biggest boot-time win on this image. That is only safe if nothing in
#    fstab waits on the network. Mount the NFS/SMB library lazily:
#
#      //nas/music  /srv/music  cifs  x-systemd.automount,x-systemd.idle-timeout=600,_netdev,noauto,...  0 0
#
#    A plain _netdev mount here will reintroduce the boot delay (and can hang
#    boot entirely when the NAS is off). MPD must also tolerate the library
#    being absent at start and pick it up on first access.
#
# 2. HARDWARE ENABLEMENT LIVES HERE, NOT IN setup.sh.
#
#    setup.sh deliberately writes no hardware config. These are the values for
#    this build, already researched — add them to /boot/firmware/config.txt.
#    Reuse setup.sh's write_managed_block pattern so they stay idempotent, but
#    use a DIFFERENT delimiter string so the two scripts don't fight over the
#    same block.
#
#    HiFiBerry DAC+ Standard (I2S HAT):
#      dtparam=audio=off                  # disable onboard PWM/HDMI audio
#      dtoverlay=hifiberry-dacplus-std    # NOT -pro; this is the Standard card
#
#      The std/pro overlay split landed in kernel 6.1.77. The legacy unified
#      `hifiberry-dacplus` still works on a Pi 4 but is deprecated.
#
#      Do NOT set force_eeprom_read=0 anywhere — the DAC+ is a HAT with an
#      EEPROM and that setting breaks its detection.
#
#    DFRobot DFR0550 5" 800x480 DSI touchscreen:
#      dtoverlay=vc4-kms-dsi-7inch        # append ",dsi0" if wired to DISP0
#      display_auto_detect=0              # ONLY after the line above is pinned
#
#      The panel is a clone of the official 7" 800x480 display, so it uses the
#      same overlay and the same rpi-ft5406 touch driver.
#
#      *** ORDERING TRAP ***
#      display_auto_detect=1 is currently what auto-loads vc4-kms-dsi-7inch.dtbo
#      (observed in `vclog --msg` at 008657 ms). Setting it to 0 WITHOUT pinning
#      the overlay first leaves the panel dead. Pin the overlay, reboot, confirm
#      the panel still works, and only then set display_auto_detect=0.
#
#      Why bother: with auto-detect on, the firmware probes both HDMI ports even
#      though nothing is plugged into them. Measured on this box, 8 failed EDID
#      reads between 005949-006735 ms, plus a 1537 ms gap right after
#      hdmi_pixel_freq_limit. Both HDMI connectors report "disconnected" while
#      card1-DSI-1 reports "connected". Expected saving is ~1-2.3s of the ~11s
#      pre-kernel stage — the largest single item left anywhere in boot.
#
#      Verify with:  sudo vclog --msg   (timestamps are ms since power-on;
#                    systemd-analyze cannot see any of this)
#
#      Do NOT set max_framebuffers=0 or disable_fw_kms_setup=1 — those are
#      headless-only and will break this panel.
#
# 3. STILL TO DO HERE
#      - hostname + avahi so the web UI resolves at <hostname>.local
#      - MPD, its config, and the library mount
#      - Bluetooth audio (bluez + a BlueALSA/PipeWire sink)
#      - USB CD audio playback and ripping
#      - the web UI service
#      - kiosk browser on the DSI panel (rpd-wayland-core or cage + chromium)
#      - optional: read-only root via `raspi-config nonint enable_overlayfs`,
#        once everything above is stable
#
# ===========================================================================

set -euo pipefail

echo "install.sh is not implemented yet. Run install/setup.sh first." >&2
exit 1
