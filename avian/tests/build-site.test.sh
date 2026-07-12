#!/usr/bin/env bash
# Fixture test for avian/build-site.sh's cache-hash rewrites — the
# clip-version → json-hash ordering is load-bearing (it burned two deploy
# cycles: 2026-07-03 shell assets, 2026-07-06 signatures/clips), so this
# locks it. Runs against a synthetic tree via the AVIAN_ROOT override; no
# network, no real assets.
#
# Usage: bash avian/tests/build-site.test.sh   (exits nonzero on any failure)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BUILD="$HERE/../build-site.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
pass=0
ok() { pass=$((pass + 1)); echo "  ok - $*"; }

# ---- fixture tree ----
FIX="$WORK/root"
mkdir -p "$FIX/avian/frontend" "$FIX/avian/assets/songs" \
         "$FIX/avian/assets/illustrations" "$FIX/avian/assets/cutouts"
cat > "$FIX/avian/frontend/index.html" <<'HTML'
<link rel="icon" href="./favicon.png">
<link rel="stylesheet" href="./styles.css">
<script src="./config.js"></script>
<script src="./spectral-core.js"></script>
<script src="./apt.js"></script>
HTML
echo 'fetch("assets/signatures.json");var x=1;' > "$FIX/avian/frontend/apt.js"
echo 'var core=1;' > "$FIX/avian/frontend/spectral-core.js"
echo 'var cfg=1;'  > "$FIX/avian/frontend/config.js"
echo 'body{}'      > "$FIX/avian/frontend/styles.css"
printf 'PNG' > "$FIX/avian/frontend/favicon.png"
printf '{"species":{"A b":{"clip":"assets/songs/a-b.mp3"},"C d":{"clip":"assets/songs/c-d.mp3"}}}' \
  > "$FIX/avian/assets/signatures.json"
printf 'mp3' > "$FIX/avian/assets/songs/a-b.mp3"
printf 'mp3' > "$FIX/avian/assets/songs/c-d.mp3"
printf 'png' > "$FIX/avian/assets/illustrations/a-b.png"
printf 'png' > "$FIX/avian/assets/illustrations/a-b-2.png"
printf 'png' > "$FIX/avian/assets/illustrations/c-d.png"
printf 'png' > "$FIX/avian/assets/cutouts/a-b.png"

OUT="$WORK/_site"

# ---- happy path ----
AVIAN_ROOT="$FIX" bash "$BUILD" "$OUT" > "$WORK/build.log" \
  || fail "build-site.sh exited nonzero on the happy path: $(cat "$WORK/build.log")"

# 1. every shell asset reference in index.html is ?v=<8-hex> stamped
for f in apt.js spectral-core.js config.js styles.css favicon.png; do
  grep -Eq "\./$f\?v=[0-9a-f]{8}\"" "$OUT/index.html" \
    || fail "index.html reference to $f is not content-hash stamped"
done
ok "index.html stamps all five shell assets"
grep -q '"\./apt\.js"' "$OUT/index.html" && fail "bare ./apt.js reference survived"
ok "no bare shell-asset references survive"

# 2. every clip URL inside the DEPLOYED signatures.json is stamped
[ "$(grep -o '\.mp3?v=[0-9a-f]\{8\}' "$OUT/assets/signatures.json" | wc -l | tr -d ' ')" = "2" ] \
  || fail "deployed signatures.json does not stamp both clip URLs"
ok "signatures.json clip URLs stamped"
# ...and the committed source stays bare
grep -q '?v=' "$FIX/avian/assets/signatures.json" && fail "committed signatures.json was mutated"
ok "committed signatures.json untouched"

# 3. apt.js's signatures fetch is stamped with the FINAL (post-clip-rewrite)
#    json hash — the 2026-07-06 ordering bug was hashing the pre-rewrite bytes
sigv="$(grep -o 'assets/signatures\.json?v=[0-9a-f]\{8\}' "$OUT/apt.js" | head -1 | sed 's/.*?v=//')"
[ -n "$sigv" ] || fail "apt.js signatures.json fetch not stamped"
finalh="$( (md5 -q "$OUT/assets/signatures.json" 2>/dev/null || md5sum "$OUT/assets/signatures.json" | awk '{print $1}') | cut -c1-8)"
[ "$sigv" = "$finalh" ] || fail "apt.js stamp ($sigv) != hash of DEPLOYED json ($finalh) — clip-version/json-hash ordering broke"
ok "apt.js stamped with the post-rewrite json hash"

# 4. art-manifest excludes flight (-2) slugs
grep -q '"a-b"' "$OUT/assets/art-manifest.json" || fail "art-manifest missing a-b"
grep -q '"a-b-2"' "$OUT/assets/art-manifest.json" && fail "art-manifest includes a flight -2 slug"
ok "art-manifest lists perched slugs only"

# 5. no half-built temp dir left behind
ls -d "$OUT".tmp.* 2>/dev/null && fail "temp build dir left behind"
ok "atomic swap leaves no temp dir"

# ---- failure path: nonconforming clip filename must abort the build ----
printf '{"species":{"X":{"clip":"assets/songs/Bad_Name.mp3"}}}' \
  > "$FIX/avian/assets/signatures.json"
if AVIAN_ROOT="$FIX" bash "$BUILD" "$OUT" > "$WORK/bad.log" 2>&1; then
  fail "build succeeded with an unstampable clip filename (should abort)"
fi
ok "nonconforming clip filename aborts the build"
# ...and the previous good _site survives the failed build (atomicity)
[ -f "$OUT/index.html" ] || fail "failed build clobbered the previous good _site"
ok "failed build leaves the previous _site intact"

echo "build-site.test.sh: $pass checks passed"
