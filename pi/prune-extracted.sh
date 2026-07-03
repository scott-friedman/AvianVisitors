#!/usr/bin/env bash
# pi/prune-extracted.sh — delete extracted clip day-directories older than
# AVIAN_PRUNE_DAYS (default 30) from ~/BirdSongs/Extracted/By_Date.
#
# Why this exists: Extracted grows ~420 MB/day (an mp3 + a spectrogram PNG per
# detection — measured 5.5 GB in the box's first 13 days), and BirdNET-Pi's own
# 95%-disk purge SILENTLY NO-OPS on this lean box: scripts/disk_check.sh
# hard-exits unless scripts/disk_check_exclude.txt exists, and that file is
# created only by the web UI (stats.php/play.php) that lean-mode.sh stripped.
# Left alone the SD card fills in ~8 months and detection dies while the
# heartbeat stays green. (update.sh also creates the exclude file as a
# backstop, but this prune keeps the disk from ever getting near 95%.)
#
# The local archive is only (a) the forwarder's upload source (needs minutes,
# not days) and (b) a recovery buffer for the R2 rare-clip archive
# (CLIP-RETENTION-PLAN.md) — 30 days is generous for both. R2 is the real
# clip store: clips/ (7-day TTL) + rare/ (each species' first 25, forever).
set -uo pipefail

DAYS="${AVIAN_PRUNE_DAYS:-30}"
BASE="${AVIAN_EXTRACTED:-$HOME/BirdSongs/Extracted}/By_Date"
[ -d "$BASE" ] || { echo "nothing to prune ($BASE missing)"; exit 0; }

# Day dirs are named YYYY-MM-DD — compare by NAME, not mtime (dir mtimes get
# refreshed by late-landing files and directory walks).
cutoff="$(date -d "-${DAYS} days" +%F)"
pruned=0
for d in "$BASE"/????-??-??; do
  [ -d "$d" ] || continue
  day="$(basename "$d")"
  if [[ "$day" < "$cutoff" ]]; then
    rm -rf "$d"
    pruned=$((pruned + 1))
  fi
done
echo "pruned $pruned day-dir(s) older than $cutoff from $BASE ($(df -h --output=pcent "$BASE" | tail -1 | tr -d ' ') disk used)"
