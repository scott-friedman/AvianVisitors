#!/usr/bin/env bash
# Assemble the static Cloudflare Pages site (avianvisitors) into _site/.
# Used by both a local `wrangler pages deploy _site` and the GitHub Action.
#
# The collage shell is self-contained: apt.js embeds DIMS/MASKS inline, so
# dims.json/masks.json are NOT shipped. Data comes from the avian-worker
# (set in config.js); images are static illustrations + a cutouts fallback.
#
# The build lands in a temp dir and is atomically swapped into $OUT at the
# end, so a mid-script failure can never leave a half-built _site/ that a
# later manual `wrangler pages deploy` would ship.
set -euo pipefail
# ROOT is derived from this script's location; AVIAN_ROOT overrides it so the
# fixture test (avian/tests/build-site.test.sh) can build a fake tree.
ROOT="${AVIAN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
OUT="${1:-$ROOT/_site}"
TMP="$OUT.tmp.$$"
trap '[ -d "$TMP" ] && rm -rf "$TMP"' EXIT

rm -rf "$TMP"
mkdir -p "$TMP/assets"

# Frontend shell. spectral-core.js holds the shared STFT analysis (loaded
# before apt.js, and reused by avian/scripts/build-signatures.mjs).
cp "$ROOT"/avian/frontend/index.html \
   "$ROOT"/avian/frontend/apt.js \
   "$ROOT"/avian/frontend/spectral-core.js \
   "$ROOT"/avian/frontend/config.js \
   "$ROOT"/avian/frontend/styles.css \
   "$ROOT"/avian/frontend/favicon.png \
   "$TMP/"

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
  cp "$ROOT"/avian/assets/signatures.json "$TMP/assets/"
  [ -d "$ROOT/avian/assets/songs" ] && cp -R "$ROOT"/avian/assets/songs "$TMP/assets/"
  clipv="$( (md5 -q "$TMP/assets/signatures.json" 2>/dev/null || md5sum "$TMP/assets/signatures.json" | awk '{print $1}') | cut -c1-8)"
  before="$(grep -o 'assets/songs/[^"]*\.mp3' "$TMP/assets/signatures.json" | wc -l | tr -d ' ')"
  perl -pi -e "s#(assets/songs/[a-z0-9-]+\.mp3)#\$1?v=$clipv#g" "$TMP/assets/signatures.json"
  stamped="$(grep -o "\.mp3?v=$clipv" "$TMP/assets/signatures.json" | wc -l | tr -d ' ')"
  # The rewrite only matches [a-z0-9-] clip names; a nonconforming name would
  # silently keep its bare (cache-poisonable) URL. Fail loud instead.
  if [ "$before" != "$stamped" ]; then
    echo "!! clip cache-busting incomplete: $before clip URLs, only $stamped stamped" >&2
    echo "   (a songs/*.mp3 filename outside [a-z0-9-] slipped in?)" >&2
    exit 1
  fi
  sigh="$( (md5 -q "$TMP/assets/signatures.json" 2>/dev/null || md5sum "$TMP/assets/signatures.json" | awk '{print $1}') | cut -c1-8)"
  [ -f "$TMP/apt.js" ] && perl -pi -e "s#assets/signatures\.json#assets/signatures.json?v=$sigh#g" "$TMP/apt.js"
  grep -q "assets/signatures.json?v=$sigh" "$TMP/apt.js" || {
    echo "!! signatures.json fetch in apt.js did not get its ?v= stamp" >&2; exit 1; }
fi

# Cache-bust the shell assets (learned 2026-07-03): the site sits behind
# zone-cached hosts — the birds-origin custom domain AND the ridge /birds proxy
# both cache assets for 24 h — and a Pages deploy purges neither, so a bare
# ./apt.js kept serving the previous build for up to a day (stale DIMS/MASKS =
# new birds render everywhere EXCEPT the collage). Point index.html at
# content-hashed URLs instead: a changed file gets a new cache key instantly;
# unchanged files keep their warm cache. (HTML itself is not edge-cached long:
# must-revalidate at the origin, 5-min TTL on the proxy.)
for f in apt.js spectral-core.js config.js styles.css favicon.png; do
  h="$( (md5 -q "$TMP/$f" 2>/dev/null || md5sum "$TMP/$f" | awk '{print $1}') | cut -c1-8)"
  perl -pi -e "s#\./\Q$f\E\"#./$f?v=$h\"#g" "$TMP/index.html"
  grep -q "$f?v=$h" "$TMP/index.html" || {
    echo "!! cache-hash stamp failed for $f (reference missing in index.html?)" >&2; exit 1; }
done

# Static bird imagery: illustrations (perched <slug>.png, flight <slug>-2.png)
# and cutouts (photo fallback for the apt.js onerror chain).
#
# ⚠ ART RE-RENDER RULE: these URLs are the LAST unhashed runtime-fetched
# assets — both edge caches hold them up to 24 h and a Pages deploy purges
# neither. NEVER re-render/replace a PNG in place at an existing slug (it
# would serve stale for up to a day); give re-rendered art a NEW slug (and
# a DIMS/MASKS rebuild) instead. Same applies to assets/art-manifest.json,
# which the worker fetches at a fixed URL for /api/coverage.
cp -R "$ROOT"/avian/assets/illustrations "$TMP/assets/"
cp -R "$ROOT"/avian/assets/cutouts "$TMP/assets/"

# art-manifest.json: the set of illustration slugs (perched <slug>.png only) so
# the Worker's GET /api/coverage can compute the "detected but no art" gap by
# reading a real JSON list — Pages serves a 200 HTML fallback for a missing .png,
# so probing image URLs is unreliable. Slug = filename sans .png (already the
# apt.js slugify of the scientific name).
ls "$TMP"/assets/illustrations/*.png \
  | sed -E 's#.*/##; /-2\.png$/d; s/\.png$//' \
  | sort \
  | awk 'BEGIN{printf "{\"slugs\":["} {printf "%s\"%s\"", (NR>1?",":""), $0} END{print "]}"}' \
  > "$TMP/assets/art-manifest.json"

# (Song signatures + clips are copied + cache-busted near the top, before the
# shell-asset hashing loop — see that block.)

# Atomic swap: only a fully-built tree ever occupies $OUT.
rm -rf "$OUT"
mv "$TMP" "$OUT"

# NOTE (2026-07-02): the public home is indianridgeroad.com/birds/. This
# site deploys to the `avianvisitors` Pages project (origin:
# birds-origin.indianridgeroad.com, proxied by the `ridge` worker). The old
# `barrysbirds` project is now only a static 301 stub for legacy
# barrysbirds.pages.dev links — do NOT deploy this site there.
#   npx wrangler pages deploy _site --project-name avianvisitors --branch avian-visitors
#   (avian-visitors IS the project's Production branch → feeds birds-origin; a
#    --branch production deploy would land on a preview URL the domain never sees.)

echo "built $OUT  ($(find "$OUT" -type f | wc -l | tr -d ' ') files, $(du -sh "$OUT" | cut -f1))"
