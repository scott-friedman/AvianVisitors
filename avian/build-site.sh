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

# Canonical song signatures (precomputed) + the bundled reference clips the
# bloom plays. Both optional - the site degrades to a hidden bloom without them.
[ -f "$ROOT/avian/assets/signatures.json" ] && cp "$ROOT"/avian/assets/signatures.json "$OUT/assets/"
[ -d "$ROOT/avian/assets/songs" ] && cp -R "$ROOT"/avian/assets/songs "$OUT/assets/"

# NOTE (2026-07-02): the public home is indianridgeroad.com/birds/. This
# site deploys to the `avianvisitors` Pages project (origin:
# birds-origin.indianridgeroad.com, proxied by the `ridge` worker). The old
# `barrysbirds` project is now only a static 301 stub for legacy
# barrysbirds.pages.dev links — do NOT deploy this site there.
#   npx wrangler pages deploy _site --project-name avianvisitors --branch production

echo "built $OUT  ($(find "$OUT" -type f | wc -l | tr -d ' ') files, $(du -sh "$OUT" | cut -f1))"
