#!/usr/bin/env bash
# lean-mode.sh — strip a full BirdNET-Pi install down to DETECTION-ONLY on a
# 512 MB Pi Zero 2 W.
#
# Why: in the AvianVisitors deployment the public collage AND the e-ink frame are
# rendered on Cloudflare, so the Pi needs NONE of BirdNET-Pi's web UI / stats /
# spectrogram / audio-streaming / Caddy+PHP stack. On a 512 MB box that full stack
# overcommits RAM and thrashes to swap until the Pi is unreachable (it took inky
# down twice on 2026-06-19 — see PI-RECOVERY.md). This script sheds all of it and
# leaves only: the detection engine, the detection forwarder, the e-ink frame
# timer, and ssh.
#
# Idempotent and safe to re-run. On the Pi:   sudo bash pi/lean-mode.sh
#
# It does NOT touch birdnet_analysis / birdnet_recording enablement — those ARE
# the detection and you decide when to turn them on (no mic yet => keep off; when
# the mic is in: `sudo systemctl enable --now birdnet_analysis birdnet_recording`).
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "ERROR: run with sudo (need to edit systemd + /boot)"; exit 1; }

# Services this deployment never uses (BirdNET-Pi web UI, stats, spectrograms,
# Icecast/livestream audio streaming, browser terminal, and the Caddy/PHP web
# server that would otherwise serve the on-Pi collage).
SHED=(birdnet_stats chart_viewer spectrogram_viewer livestream web_terminal \
      icecast2 birdnet_log caddy php8.2-fpm)

echo "== shedding ${#SHED[@]} non-detection services =="
for s in "${SHED[@]}"; do
  systemctl stop "$s.service" 2>/dev/null || true
  # `systemctl disable` works for normal units but SILENTLY NO-OPS on units that
  # are "generator masked" via a systemd.mask= kernel arg (the recovery hack),
  # so we ALSO remove any leftover enable-symlink on disk. Belt-and-suspenders;
  # harmless when the link is already gone.
  systemctl disable "$s.service" 2>/dev/null || true
  rm -f /etc/systemd/system/*.wants/"$s.service" 2>/dev/null || true
  printf '  %-22s -> stopped + disabled\n' "$s"
done
systemctl daemon-reload

# --- recovery cleanup: remove the temporary systemd.mask= kernel hack, if present
CMDLINE=/boot/firmware/cmdline.txt
echo "== checking for the temporary kernel-mask hack in cmdline.txt =="
if grep -q 'systemd\.mask=' "$CMDLINE" 2>/dev/null; then
  # SAFETY GUARD: only strip the masks once the heavy units have NO enable-symlink
  # left, otherwise they auto-start on the next boot and re-thrash the box.
  if compgen -G "/etc/systemd/system/*.wants/birdnet_analysis.service" >/dev/null \
   || compgen -G "/etc/systemd/system/*.wants/birdnet_recording.service" >/dev/null \
   || compgen -G "/etc/systemd/system/*.wants/birdnet_log.service" >/dev/null \
   || compgen -G "/etc/systemd/system/*.wants/caddy.service" >/dev/null \
   || compgen -G "/etc/systemd/system/*.wants/php8.2-fpm.service" >/dev/null \
   || compgen -G "/etc/systemd/system/*.wants/birdnet_stats.service" >/dev/null; then
    echo "  !! heavy enable-symlinks still present — REFUSING to edit cmdline.txt"
    echo "     (removing the kernel mask now would let them auto-start and re-thrash)."
  else
    [ -f "$CMDLINE.prelean.bak" ] || cp -a "$CMDLINE" "$CMDLINE.prelean.bak"
    # strip every `systemd.mask=...` token and tidy whitespace
    sed -i -E 's/[[:space:]]*systemd\.mask=[^[:space:]]+//g; s/[[:space:]]+/ /g; s/^ //; s/ $//' "$CMDLINE"
    sync
    echo "  cmdline.txt cleaned (backup: $CMDLINE.prelean.bak)"
    echo "  -> $(cat "$CMDLINE")"
  fi
else
  echo "  (none present — nothing to restore)"
fi

echo "== done. kept: birdnet_analysis/recording (your call) + avian-forwarder + birdframe.timer + ssh =="
echo "== memory now: =="
free -m
