# Generating illustrations

The collage art is generated, not hand-drawn. The repo ships 498 kachō-e
illustrations (249 species, a perched and a flight pose each). To restyle
them or build a set for your own region, the pipeline is four scripts in
this directory.

## Pipeline

1. `pregen.py` renders each bird with Gemini 2.5 Flash Image, on a flat cream ground.
2. `keycut.py` keys the cream ground out (deterministic flood fill) and crops to the
   bird. (`cutout.py` — BiRefNet via rembg — is the ML alternative if onnxruntime
   works on your platform; on this dev Mac it hangs, see below.)
3. `build_masks.py` rebuilds the collage silhouette masks inlined in `apt.js`.
4. `verify.py` (optional) runs an adversarial species-ID + anatomy check.

```bash
pip install -r requirements.txt
export GEMINI_API_KEY='your-key'

# 1. generate (cream ground) for your region's species
python3 pregen.py --labels ~/BirdNET-Pi/model/labels.txt --ebird-region US-CA

# 2. key the ground off and crop (in place; pass the freshly generated PNGs)
python3 keycut.py avian/assets/illustrations/<slug>.png avian/assets/illustrations/<slug>-2.png

# 3. rebuild the collage masks
python3 build_masks.py
```

> **Art re-render rule:** never re-render/replace an illustration PNG in place at an
> existing slug. Illustration/cutout URLs are fetched **unhashed** at runtime, and both
> edge caches (the Pages custom domain and the `/birds/` proxy) hold them for up to
> 24 h — replaced-in-place art keeps serving stale for up to a day. Bump the slug
> (new filename) instead.

`--labels` takes any `Sci|Com` per-line file (BirdNET-Pi's `labels.txt` works
directly). `--ebird-region` filters to species actually seen in your region
(needs `EBIRD_API_KEY`). Re-render one bird with
`--species "Calypte anna|Anna's Hummingbird" --force`.

## Why `keycut.py` is the default step 2: `cutout.py` hangs on this Mac

On this dev Mac (Xcode `/usr/bin/python3`), `rembg`'s `new_session()` **hangs in
native onnxruntime code** at session init — for BiRefNet *and* u2net — so
`cutout.py` never returns, and a Python-level timeout can't break a native hang.
**`keycut.py`** (this dir) is the default step 2 instead — a deterministic
flood-fill key-out of the flat cream ground: it removes only the cream *connected
to the image border* (so interior white plumage is safe), drops disconnected
specks under 2% of the bird's area, feathers the edge 0.8 px, and crops with a 2%
margin. On these flat grounds it's as clean as the ML matte, often cleaner.
Sudbury deployment worklist + per-bird status: `SUDBURY-ART-TODO.md` (repo root).

```bash
python3 keycut.py /tmp/bird-art-preview/<slug>.png /tmp/bird-art-preview/<slug>-2.png
```

**Pale-bellied birds need a lower `--tol`.** The default (`TOL=34`) treats a
near-white belly as ground where the dark outline is thin, and the
border-connected fill eats the lower-body outline (seen on Red-eyed Vireo +
Black-capped Chickadee). Re-key from the raw with `--tol 18` — it spares the white
belly while still removing the flat ground (≈13 is too low: the ground stops being
removed). Eyeball the result on a contrasting (e.g. magenta) background, which
exposes both eaten edges and leftover halo:

```bash
python3 keycut.py --tol 18 /tmp/bird-art-preview/<slug>.png /tmp/bird-art-preview/<slug>-2.png
```

**After keying, sweep for leftover bits on magenta** (it reveals what a light
ground hides). Two kinds slip past the key-out:
- *Disconnected specks* — a corner blob or edge smudge that lands just **over** the
  2% island-drop threshold (2.4–2.8% seen) survives. Fix: keep only the largest
  alpha connected component (drop the non-main island) — safe, since each bird keys
  as one blob.
- *A connected stray* — e.g. the faint perch/twig the model paints off a foot — is
  part of the main island, so island-dropping can't reach it. Region-erase it (clear
  alpha in a tight box), checking the natural toe/edge extent against the **raw** so
  you trim only the stray, not real anatomy.

Keep the raw cream-ground generations (e.g. `/tmp/bird-art-preview/raw/`) so every
re-key (`--tol`) or speck/stray touch-up is **free** — no new Gemini calls.

## Why a cream ground

The image model can't cut a clean transparent background on its own: it
leaves holes and fringes, worst on pale birds. Rendering on a flat,
consistent cream ground gives a known color that step 2 keys out cleanly
(flood fill or BiRefNet alike), and the steady ground also holds the
painting style together across the whole set. `keycut.py` (or `cutout.py`)
is the step that makes the backgrounds transparent.

## The prompt

`prompt.template.md` is the kachō-e prompt, sent verbatim per request with
`{sci_name}`, `{com_name}`, and `{pose}` substituted. Edit it to change the
style. `pregen.py` attaches up to three reference images per request:

- **Anatomy** (IMAGE 1): a Wikipedia photo of the target species, auto-fetched
  and cached in `assets/references/`. Anchors identity and markings. Drop your
  own `references/<slug>.jpg` to override.
- **Anti-reference** (IMAGE 2, optional): a photo of a look-alike the model
  drifts toward, captioned with what NOT to copy. Wired for blue corvids (vs
  Blue Jay) and swallows (vs Barn Swallow); add more in the `ANTI_REFS` table
  and place photos at `references/_anti_<key>.jpg`.
- **Style** (IMAGE 3, optional): a real Edo-period kachō-e print whose painting
  technique is borrowed. The genus-to-print mapping is in `pregen.py`'s
  `STYLE_REFS`. The prints are not bundled (they are someone else's art); put
  your own in `assets/references/styles/`. The Koson and Yoshida prints used
  originally are easy to find on the public web by the filenames in `STYLE_REFS`.

All three degrade gracefully: a missing reference is simply not attached.

## Hard species

`species-notes.json` holds one-line diagnostic addenda for species the model
gets wrong. Each note names the field marks that matter and the look-alikes to
avoid, and is appended to the prompt for that species. Add entries as you find
drift; they carry forward to every future regeneration of that bird.

## Verifying

`verify.py` sends each illustration back through Gemini Vision without telling
it the target species, then checks the guess, the wing/leg/tail counts, and
whether a stray perch crept in. It catches drift a quick eyeball misses.

```bash
python3 verify.py --labels labels.txt              # whole library -> verify-results.csv
python3 verify.py --labels labels.txt calypte-anna
```

## What actually goes wrong

- **Sticks.** Perched raptors often come back gripping a twig the prompt
  forbade. Generate 2-3 and keep the clean one.
- **Species drift.** The model collapses an uncommon species toward a common
  look-alike (a swift becomes a swallow). Fixes, in order: a sharper
  `species-notes.json` note with anti-feature language; an anti-reference; a
  different style print; a one-off `--species` regen.
- **Matched pair.** The perched and flight poses must read as the same
  individual. Review them side by side before locking.

## Song signatures (`build-signatures.mjs`)

Separate from the illustration pipeline: the modal's "song signature" bloom is a
**canonical** per-species fingerprint precomputed from one clean xeno-canto song —
NOT extracted from our noisy R2 field clips. For each target species the script
pulls a license-compatible (CC, no ND) `type:song` recording, trims it to its
loudest ~3.5 s, runs the shared STFT analysis, and writes two committed artifacts:

- `avian/assets/signatures.json` — per-species analysis (`{ version, generated, species }`)
- `avian/assets/songs/<slug>.mp3` — the trimmed reference clip (tap-to-play in the modal)

Prereqs: **Node ≥ 18**, **ffmpeg** on PATH, and a **xeno-canto v3 API key** at
`~/.config/avian/xeno-canto-key` (mode 600, outside the repo; free — register at
xeno-canto.org → account → API key).

```bash
node avian/scripts/build-signatures.mjs                  # default: detected species w/ art, missing only (incremental)
node avian/scripts/build-signatures.mjs --all-art        # every species with illustration art
node avian/scripts/build-signatures.mjs --force          # rebuild (re-pick clips for) targets
node avian/scripts/build-signatures.mjs --only "Cyanocitta cristata"
node avian/scripts/build-signatures.mjs --limit 5        # first N (testing)
```

Birds whose auto-picked clip is poor (e.g. woodpeckers — no tonal song) can be
pinned to a curated recording via `avian/assets/signature-overrides.json`
(`{ "Genus species": <xeno-canto id> }`).

**Follow-up after a build:** commit the artifacts, then `bash avian/build-site.sh`
and redeploy Pages — build-site.sh content-hashes the *deployed* signatures.json
and its clip URLs, so new signatures are visible immediately (no 24 h edge-cache
wait).

Two rules that keep the output right (full story: `SPECTRO-CONCEPTS-PLAN.md`):

- **The STFT is shared.** `avian/frontend/spectral-core.js` is loaded by the
  browser AND `require`d by this build script, so the canonical bloom and the
  live per-recording line can't drift. Change the math there, once.
- **Compute energy/pitch from LINEAR POWER, never the dB grid.** dB summed over a
  linear-frequency band pins every dominant near the ceiling; dB is for the
  heatmap visual only.
