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

# Canonical song signatures + the bundled reference clips the bloom plays, WITH
# cache-busting for the 24h zone/proxy edge cache (same trap as the shell assets
# below; learned 2026-07-06). Two fixed-path fetches would otherwise serve stale
# for a day:
#   (a) apt.js fetches assets/signatures.json → a plain deploy hides newly added
#       blooms even though the .mp3s (new files, fresh URLs) are already live.
#   (b) each clip's fixed URL can hold a cached 200-HTML *negative* fallback if
#       it was probed before it existed (seen on one Osprey clip) → tap-to-play
#       404s. So version the clip URLs INSIDE the deployed json too.
# Do this BEFORE the shell-asset loop so apt.js's own ?v= reflects the rewrite,
# and hash the FINAL deployed json (AFTER clip-versioning) so its fetch URL
# changes whenever the served bytes change. The committed source stays bare.
if [ -f "$ROOT/avian/assets/signatures.json" ]; then
  cp "$ROOT"/avian/assets/signatures.json "$OUT/assets/"
  [ -d "$ROOT/avian/assets/songs" ] && cp -R "$ROOT"/avian/assets/songs "$OUT/assets/"
  clipv="$( (md5 -q "$ROOT/avian/assets/signatures.json" 2>/dev/null || md5sum "$ROOT/avian/assets/signatures.json" | awk '{print $1}') | cut -c1-8)"
  perl -pi -e "s#(assets/songs/[a-z0-9-]+\.mp3)#\$1?v=$clipv#g" "$OUT/assets/signatures.json"
  sigh="$( (md5 -q "$OUT/assets/signatures.json" 2>/dev/null || md5sum "$OUT/assets/signatures.json" | awk '{print $1}') | cut -c1-8)"
  [ -f "$OUT/apt.js" ] && perl -pi -e "s#assets/signatures\.json#assets/signatures.json?v=$sigh#g" "$OUT/apt.js"
fi

# Cache-bust the shell assets (learned 2026-07-03): the site sits behind
# zone-cached hosts — the birds-origin custom domain AND the ridge /birds proxy
# both cache assets for 24 h — and a Pages deploy purges neither, so a bare
# ./apt.js kept serving the previous build for up to a day (stale DIMS/MASKS =
# new birds render everywhere EXCEPT the collage). Point index.html at
# content-hashed URLs instead: a changed file gets a new cache key instantly;
# unchanged files keep their warm cache. (HTML itself is not edge-cached long:
# must-revalidate at the origin, 5-min TTL on the proxy.)
for f in apt.js spectral-core.js config.js styles.css; do
  h="$( (md5 -q "$OUT/$f" 2>/dev/null || md5sum "$OUT/$f" | awk '{print $1}') | cut -c1-8)"
  perl -pi -e "s#\./\Q$f\E\"#./$f?v=$h\"#g" "$OUT/index.html"
done

# Static bird imagery: illustrations (perched <slug>.png, flight <slug>-2.png)
# and cutouts (photo fallback for the apt.js onerror chain).
cp -R "$ROOT"/avian/assets/illustrations "$OUT/assets/"
cp -R "$ROOT"/avian/assets/cutouts "$OUT/assets/"

# art-manifest.json: the set of illustration slugs (perched <slug>.png only) so
# the Worker's GET /api/coverage can compute the "detected but no art" gap by
# reading a real JSON list — Pages serves a 200 HTML fallback for a missing .png,
# so probing image URLs is unreliable. Slug = filename sans .png (already the
# apt.js slugify of the scientific name).
ls "$OUT"/assets/illustrations/*.png \
  | sed -E 's#.*/##; /-2\.png$/d; s/\.png$//' \
  | sort \
  | awk 'BEGIN{printf "{\"slugs\":["} {printf "%s\"%s\"", (NR>1?",":""), $0} END{print "]}"}' \
  > "$OUT/assets/art-manifest.json"

# (Song signatures + clips are copied + cache-busted near the top, before the
# shell-asset hashing loop — see that block.)

# NOTE (2026-07-02): the public home is indianridgeroad.com/birds/. This
# site deploys to the `avianvisitors` Pages project (origin:
# birds-origin.indianridgeroad.com, proxied by the `ridge` worker). The old
# `barrysbirds` project is now only a static 301 stub for legacy
# barrysbirds.pages.dev links — do NOT deploy this site there.
#   npx wrangler pages deploy _site --project-name avianvisitors --branch avian-visitors
#   (avian-visitors IS the project's Production branch → feeds birds-origin; a
#    --branch production deploy would land on a preview URL the domain never sees.)

echo "built $OUT  ($(find "$OUT" -type f | wc -l | tr -d ' ') files, $(du -sh "$OUT" | cut -f1))"
