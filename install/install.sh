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
# 2. HARDWARE IS HANDLED BY setup-hardware.sh, NOT HERE.
#
#    The DAC+, the DSI panel and HDMI suppression all moved into
#    install/setup-hardware.sh. Run order is:
#
#      setup.sh  ->  setup-hardware.sh  ->  install.sh
#
#    Do NOT write dtoverlay/dtparam lines into config.txt from this script. If
#    you must, use a DIFFERENT managed-block marker so the three scripts never
#    fight over the same region of the file.
#
#    What setup-hardware.sh already guarantees by the time you run:
#      - card 0 is snd_rpi_hifiberry_dacplus (pcm512x). The onboard
#        "bcm2835 Headphones" and the vc4hdmi0/vc4hdmi1 cards are GONE, so any
#        MPD config assuming card 0 = Headphones is wrong.
#      - the DSI panel is pinned via dtoverlay=vc4-kms-dsi-7inch and no longer
#        depends on display_auto_detect.
#      - HDMI is suppressed at both the firmware and kernel layers.
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
