#!/usr/bin/env bash
# zero2w-tune.sh — memory + reliability tuning so BirdNET-Pi DETECTION runs
# stably on a 512 MB Pi Zero 2 W (the AvianVisitors detection-only deployment).
#
# Background (see PI-RECOVERY.md): a 512 MB Zero 2 W is marginal for BirdNET. The
# stock box OOM-thrashed unreachable. The fix is NOT "strip more services" (that
# saves only tens of MB) — it is: give it fast compressed swap, undo the damage the
# crashes did, make the recorder lighter so the slow CPU keeps up, and add a
# watchdog so a future hang self-heals instead of needing a physical power-cycle.
# This deliberately makes NO edits to BirdNET-Pi's own Python (those get clobbered
# by `git pull`); everything here is OS/config + birdnet.conf.
#
# Idempotent. Run on the Pi:   sudo bash pi/zero2w-tune.sh   then reboot.
set -uo pipefail
[ "$(id -u)" -eq 0 ] || { echo "ERROR: run as root (sudo bash pi/zero2w-tune.sh)"; exit 1; }

BNHOME=/home/inky/BirdNET-Pi
VENV_LIB="$BNHOME/birdnet/lib"
CONF="$BNHOME/birdnet.conf"

echo "== 1. clear corrupt numba JIT cache (truncated by the prior OOM crashes) =="
# numba does NOT recover from a corrupt .nbi/.nbc — it throws EOFError on EVERY call
# (it never treats a truncated entry as a clean miss), so the librosa hot path stays
# broken until the files are deleted. Removing them forces a one-time clean recompile.
# Must be done with the analysis service stopped.
systemctl stop birdnet_analysis birdnet_recording >/dev/null 2>&1 || true
NBEFORE=$(find "$VENV_LIB" \( -name '*.nbi' -o -name '*.nbc' \) 2>/dev/null | wc -l)
find "$VENV_LIB" \( -name '*.nbi' -o -name '*.nbc' \) -delete 2>/dev/null || true
echo "   cleared $NBEFORE numba cache files under $VENV_LIB"

echo "== 2. birdnet.conf: mono capture + 30s recordings =="
# CHANNELS=1 halves the WAV size / SD-write churn / decode buffer. RECORDING_LENGTH=30
# (the official RPi0W2 recommendation) lowers how often the analyzer is invoked so the
# slow CPU stops falling behind realtime (the backlog is what drives RSS into swap).
if [ -f "$CONF" ]; then
  cp -a "$CONF" "$CONF.bak.pretune"
  sed -i 's/^CHANNELS=.*/CHANNELS=1/' "$CONF"
  sed -i 's/^RECORDING_LENGTH=.*/RECORDING_LENGTH=30/' "$CONF"
  grep -E '^CHANNELS=|^RECORDING_LENGTH=' "$CONF" | sed 's/^/   /'
else echo "   !! $CONF not found — skipped"; fi

echo "== 3. zram: compressed RAM swap as the primary lane (fast, no SD wear) =="
if ! dpkg -s zram-tools >/dev/null 2>&1; then
  apt-get update -qq && apt-get install -y -qq zram-tools || echo "   !! apt install zram-tools FAILED (check network)"
fi
cat > /etc/default/zramswap <<'EOF'
# AvianVisitors zero2w-tune — compressed RAM swap, used before the SD swapfile.
# zstd, not lz4: measured on the live box (2026-07-01) lz4 only got 1.63:1 on
# this workload and the 50%-of-RAM device sat 100% full, spilling to SD swap —
# zstd (~2.5:1 typical) + a 75% device buys real spike headroom for the same
# RAM cost, and the 4 cores idle at ~0.3 load so the extra CPU is free.
ALGO=zstd
PERCENT=75
PRIORITY=100
EOF
systemctl enable --now zramswap >/dev/null 2>&1 || systemctl enable --now zramswap.service >/dev/null 2>&1 || true
systemctl restart zramswap >/dev/null 2>&1 || systemctl restart zramswap.service >/dev/null 2>&1 || true
# The stock 512 MB SD swapfile stays as a low-priority deep backstop (NOT grown to
# 2 GB — that big-SD-swap approach is what thrashes the card to death under backlog).

echo "== 4. vm.swappiness=100 (prefer the fast zram over the SD swapfile) =="
echo 'vm.swappiness=100' > /etc/sysctl.d/99-avian-swappiness.conf
sysctl -q -w vm.swappiness=100

echo "== 5. gpu_mem=16 (headless; the Inky panel is SPI, not the GPU) — frees RAM =="
CFG=/boot/firmware/config.txt
if [ -f "$CFG" ]; then
  cp -a "$CFG" "$CFG.bak.pretune" 2>/dev/null || true
  sed -i '/^gpu_mem=/d' "$CFG"
  printf '\n# AvianVisitors zero2w-tune: headless box, free RAM\ngpu_mem=16\n' >> "$CFG"
  grep -n '^gpu_mem=' "$CFG" | sed 's/^/   /'
fi

echo "== 6. hardware watchdog: auto-reboot on hang (no more manual power-cycle) =="
SC=/etc/systemd/system.conf
sed -i 's/^#\?RuntimeWatchdogSec=.*/RuntimeWatchdogSec=15/' "$SC"
sed -i 's/^#\?RebootWatchdogSec=.*/RebootWatchdogSec=2min/' "$SC"
grep -E '^RuntimeWatchdogSec=|^RebootWatchdogSec=' "$SC" | sed 's/^/   /'

echo "== 7. Wi-Fi power-save off (NetworkManager) — link stability =="
mkdir -p /etc/NetworkManager/conf.d
cat > /etc/NetworkManager/conf.d/wifi-powersave-off.conf <<'EOF'
[connection]
wifi.powersave=2
EOF

echo "== 8. journald: persistent + capped 200M (post-mortem logs survive a reboot) =="
# Storage=volatile (found set on the live box, 2026-07-01) keeps only ~4 h of logs
# in tmpfs and wipes them on every reboot — useless exactly when the hardware
# watchdog fires, and it silently defeats the SystemMaxUse cap (volatile storage
# is governed by RuntimeMaxUse instead). Persistent journald writes ~50 MB/day;
# the recorder already writes ~8 GB/day of WAVs, so the SD wear is a rounding error.
JC=/etc/systemd/journald.conf
if grep -qE '^#?Storage=' "$JC"; then
  sed -i 's/^#\?Storage=.*/Storage=persistent/' "$JC"
else
  echo 'Storage=persistent' >> "$JC"
fi
if grep -qE '^#?SystemMaxUse=' "$JC"; then
  sed -i 's/^#\?SystemMaxUse=.*/SystemMaxUse=200M/' "$JC"
else
  echo 'SystemMaxUse=200M' >> "$JC"
fi
grep -E '^(Storage|SystemMaxUse)=' "$JC" | sed 's/^/   /'

echo "== 9. unattended security upgrades (months-unattended, internet-connected box) =="
if ! dpkg -s unattended-upgrades >/dev/null 2>&1; then
  apt-get update -qq && apt-get install -y -qq unattended-upgrades || echo "   !! apt install unattended-upgrades FAILED (check network)"
fi
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
# Debian security comes from the package's stock 50unattended-upgrades origins;
# this ADDS cloudflared (its apt repo is the tunnel client's only update lane —
# the service runs --no-autoupdate) and deliberately NOT the raspi firmware/
# kernel repo (too risky to swap kernels with nobody at the house). Never
# auto-reboot: detection would be down until someone noticed.
cat > /etc/apt/apt.conf.d/52avian-unattended <<'EOF'
Unattended-Upgrade::Origins-Pattern {
        "origin=cloudflared";
};
Unattended-Upgrade::Automatic-Reboot "false";
EOF
# Run at 03:30, not the stock ~06:00 — dawn chorus is this box's peak-RAM window.
mkdir -p /etc/systemd/system/apt-daily-upgrade.timer.d
cat > /etc/systemd/system/apt-daily-upgrade.timer.d/avian.conf <<'EOF'
[Timer]
OnCalendar=
OnCalendar=*-*-* 03:30
RandomizedDelaySec=30m
EOF
systemctl daemon-reload
echo "   unattended-upgrades on (Debian security + cloudflared; no auto-reboot; 03:30)"

echo
echo "== DONE. REBOOT REQUIRED (gpu_mem + watchdog + zram size take effect on boot). =="
echo "   Detection stays OFF at boot (disabled); start it manually to re-measure."
