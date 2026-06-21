#!/usr/bin/env bash
# Assemble the static Cloudflare Pages site (avianvisitors) into _site/.
# Used by both a local `wrangler pages deploy _site` and the GitHub Action.
#
# The collage shell is self-contained: apt.js embeds DIMS/MASKS inline, so
# dims.json/masks.json are NOT shipped. Data comes from the avian-worker
# (set in config.js); images are static illustrations + a cutouts fallback.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/_site}"

rm -rf "$OUT"
mkdir -p "$OUT/assets"

# Frontend shell. spectral-core.js holds the shared STFT analysis (loaded
# before apt.js, and reused by avian/scripts/build-signatures.mjs).
cp "$ROOT"/avian/frontend/index.html \
   "$ROOT"/avian/frontend/apt.js \
   "$ROOT"/avian/frontend/spectral-core.js \
   "$ROOT"/avian/frontend/config.js \
   "$ROOT"/avian/frontend/styles.css \
   "$OUT/"

# Static bird imagery: illustrations (perched <slug>.png, flight <slug>-2.png)
# and cutouts (photo fallback for the apt.js onerror chain).
cp -R "$ROOT"/avian/assets/illustrations "$OUT/assets/"
cp -R "$ROOT"/avian/assets/cutouts "$OUT/assets/"

# Canonical song signatures (precomputed) + the bundled reference clips the
# bloom plays. Both optional - the site degrades to a hidden bloom without them.
[ -f "$ROOT/avian/assets/signatures.json" ] && cp "$ROOT"/avian/assets/signatures.json "$OUT/assets/"
[ -d "$ROOT/avian/assets/songs" ] && cp -R "$ROOT"/avian/assets/songs "$OUT/assets/"

echo "built $OUT  ($(find "$OUT" -type f | wc -l | tr -d ' ') files, $(du -sh "$OUT" | cut -f1))"
