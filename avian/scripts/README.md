# Generating illustrations

The collage art is generated, not hand-drawn. The repo ships 498 kachō-e
illustrations (249 species, a perched and a flight pose each). To restyle
them or build a set for your own region, the pipeline is four scripts in
this directory.

## Pipeline

1. `pregen.py` renders each bird with Gemini 2.5 Flash Image, on a flat cream ground.
2. `cutout.py` removes the ground with BiRefNet and crops to the bird.
3. `build_masks.py` rebuilds the collage silhouette masks inlined in `apt.js`.
4. `verify.py` (optional) runs an adversarial species-ID + anatomy check.

```bash
pip install -r requirements.txt
export GEMINI_API_KEY='your-key'

# 1. generate (cream ground) for your region's species
python3 pregen.py --labels ~/BirdNET-Pi/model/labels.txt --ebird-region US-CA

# 2. cut the ground off and crop
python3 cutout.py

# 3. rebuild the collage masks, then bump SKETCH_VERSION + IMG_VERSION in apt.js
python3 build_masks.py
```

`--labels` takes any `Sci|Com` per-line file (BirdNET-Pi's `labels.txt` works
directly). `--ebird-region` filters to species actually seen in your region
(needs `EBIRD_API_KEY`). Re-render one bird with
`--species "Calypte anna|Anna's Hummingbird" --force`.

## macOS gotcha: `cutout.py` hangs — use `keycut.py`

On this dev Mac (Xcode `/usr/bin/python3`), `rembg`'s `new_session()` **hangs in
native onnxruntime code** at session init — for BiRefNet *and* u2net — so step 2
never returns, and a Python-level timeout can't break a native hang. Workaround:
**`keycut.py`** (this dir) — a deterministic flood-fill key-out of the flat cream
ground: it removes only the cream *connected to the image border* (so interior
white plumage is safe), drops disconnected specks under 2% of the bird's area,
feathers the edge 1px, and crops with a 2% margin. On these flat grounds it's as
clean as the ML matte, often cleaner. Sudbury deployment worklist + per-bird
status: `SUDBURY-ART-TODO.md` (repo root).

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
consistent cream ground gives a known color that BiRefNet removes cleanly,
and the steady ground also holds the painting style together across the
whole set. `cutout.py` is the step that makes the backgrounds transparent.

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
