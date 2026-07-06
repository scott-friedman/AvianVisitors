# SPECTRO-CONCEPTS-PLAN.md — artistic spectral display in the bird info card

> **STATUS (2026-06-20): bloom + line BUILT (apt.js + index.html + styles.css).**
>
> **STATUS (2026-06-21): REDESIGNED to canonical signatures + a real DSP fix + click-to-play —
> now LIVE on `barrysbirds.pages.dev` (23 detected species).** Highlights of the 06-21 pass (per Scott: "make it accurately
> represent each bird … pull from a known database … clicking should play the song … the line
> should show how the call moves"):
> 1. **Bloom = CANONICAL species signature**, not extracted from our noisy field clips. Precomputed
>    at build time from a clean **xeno-canto** A-grade *song* (license-filtered to CC, attribution
>    shown) by `avian/scripts/build-signatures.mjs` → shipped as `avian/assets/signatures.json` +
>    bundled `avian/assets/songs/<slug>.mp3`. Stable + species-true; same every visit.
> 2. **Click the bloom → HEARS the bird** (plays the bundled reference clip; rosette sweeps in
>    sync). Fixes the "plays silently" bug (the old click only re-ran the animation).
> 3. **DSP bug fixed (the big one):** energy + pitch were derived from the **dB-compressed**
>    spectrogram grid, which — summed over a linear-frequency band — over-weighted the wide
>    high-frequency region and pinned every dominant-pitch readout near the ceiling (a robin
>    "singing" at 7 kHz). Now computed from **linear power**; dB is used only for the heatmap
>    visual. Validated on REAL clips: Wren 2.8 kHz, Robin 2.4 kHz, Cardinal 2.8 kHz, Cedar Waxwing
>    7.0 kHz (correctly high).
> 4. **Ridge tracker** replaces the spectral-centroid pitch (centroid smears for raspy/broadband
>    calls); plus **voiced gating** so the per-recording line breaks in silence instead of drawing
>    a flat line. The line now rides the real call.
> 5. **Single source of truth:** the STFT analysis lives in `avian/frontend/spectral-core.js`,
>    loaded before apt.js AND `require`d by the Node build script — the browser line and the
>    canonical bloom can never drift.
>
> **xeno-canto v3 key (mandatory since 2025-10-10):** `~/.config/avian/xeno-canto-key` (600,
> outside the repo). Re-run `node avian/scripts/build-signatures.mjs` to expand coverage as new
> species are detected (incremental; `--force` rebuilds all; `--only "Genus species"` for one).
> **Deployed to production 2026-06-21** (preview-tested on mobile first). To expand from the 23
> detected species to **all ~263 with art**: `node avian/scripts/build-signatures.mjs --all-art`
> → `bash avian/build-site.sh` → deploy (see **Runbook** at the bottom). Optional per-species clip
> overrides (`avian/assets/signature-overrides.json`) for Downy Woodpecker (no tonal song → reads
> high) etc.
>
> The 06-20 analysis was rewritten on 06-21, so the "numerically identical to the mock" note below
> is historical. Interactive concept demo: **`spectro-concepts.html`** (repo root).

## Plain English summary

When you tap a bird in the **atlas**, an info card opens with its picture, a description, and a
list of past recordings you can play. The idea: show each bird's call **as a picture** in that
card — not just a plain chart, but something a little artistic — so you can look at the "shape"
of the sound while you listen, and just because it looks cool.

The happy surprise from the research: **the card already draws a real spectrogram.** When you
expand/play one of the recordings, the inked strip that slides open *is* a live spectral analysis
of that exact clip, computed in your browser. It's just (a) hidden until you click a recording
open, and (b) unlabeled, so it doesn't read as "here's the call's fingerprint." So this work is
**a re-skin of data we already compute** — no new servers, no Pi changes, no database changes.
Pure website (Pages) work.

This doc records what exists, four creative directions (with a recommendation), exactly where each
plugs into the code, and the open decisions for Scott.

---

## Key finding: the spectrogram already exists (3 places, one renderer)

A single client-side renderer, **`paintSpectrogram(canvas, audioBuffer)`** (`avian/frontend/apt.js:3011`,
core `_paintSpectrogramNow` at `:3019`), is reused in three spots:

1. **Atlas cards** — `.spectro-wrap` per `.bird-card`, painted on first play (`apt.js:1442`, `:1511–1543`).
2. **Detail modal recording rows** — `.rec-spectro` strip per recording, painted on expand/play
   (`ensureSpectroImage` `apt.js:3115`; rows built `apt.js:2359–2373`).
3. **Live stream view** — realtime FFT canvas `#liveSpectro` (`apt.js:1783`, `drawSpectrogram` `:1888`).

**How it works (reuse this verbatim for any new concept):**
- Audio source already exists: **`GET /api/recording?file=<key>`** (or `?sci=<name>` for newest),
  streamed from R2 with Range + CORS (`worker/src/index.js:195`). **No worker change needed.**
- `fetch` → `AudioContext.decodeAudioData` → cached per file in **`_decodedCache`** (`apt.js:2966`);
  shared context via **`getSpecCtx()`** (`apt.js:2956`).
- STFT: in-file radix-2 **`_fft`** (`apt.js:2968`), `FFT_SIZE=1024`, Hann window, hop chosen to lay
  exactly W columns over the clip. Band **200 Hz – 12 kHz**, log-ish row warp (`pow(t,1.55)`),
  dB map `−75..−10 → 0..1`, painted **paper→ink**, **theme-aware** (reads `data-theme` +
  `--paper`/`--ink` at paint time).
- Canvas-size race is handled by an **rAF + size-retry guard** (`_paintSpectrogramNow:3027`) because
  the strip animates open from height 0 — **any new canvas in the morphing modal needs the same guard.**

**The gap (why it reads as "missing" to the user):**
- The per-row strip is **collapsed by default** (`styles.css:1420`, `height:0` → `88px` when
  `.rec-row.expanded`, `:1432`) — you must click a recording to see it.
- It's a **bare heatmap**: no frequency axis, no time axis, no peak-frequency/range readout, no
  caption explaining it's a spectrogram. Nothing makes it a glanceable "signature."

### Data available, per recording, with zero new infra
- From the row dataset: `d.file` (R2 key), `d.d` (date), `d.t` (time), `d.conf` (confidence %).
  (Recordings come from `/api/birdnet-api.php?action=species&sci=` → `j.detections`; **verify the
  array order before assuming `dets[0]` is newest — sort by date desc to be safe.**)
- From species summary `j.summary`: `com`, `total`, `first_seen`.
- Computed from the decoded buffer (all shown working in the demo): **peak frequency**,
  **frequency range** (energy percentiles), **duration**, per-column **energy** + **peak-pitch track**.

### Accuracy note for the "this is how BirdNET works" framing
The user's mental model is right: BirdNET is a **CNN over a mel spectrogram** — it literally does
image recognition on the sound, so showing the spectrogram is "what the model sees." Our renderer
is a **linear/​warped-frequency STFT** (recognizable, not the exact mel front-end). Optional fidelity
upgrade: switch the row→bin map to a **mel scale, 0–15 kHz** to mirror BirdNET's input more closely.
Worth a sentence of caption either way.

---

## The four concepts (see `spectro-concepts.html` for live versions)

All four consume the same decoded buffer + STFT. Lift is relative to "we already have the data."

### 01 · Ink wash (labeled) — *lift: low* — closest to the original "reference" ask
Keep the rectangular spectrogram; restyle on paper and **add context**: kHz frequency axis, time
axis, and a **peak / range / duration** readout, plus a one-line "BirdNET matches this image"
caption. **Animation:** the song paints in left→right behind the existing playhead cursor.
- *Integration:* smallest change. Keep `paintSpectrogram`; add an overlay layer (absolutely-positioned
  mono labels, or draw axes on the canvas) inside `.rec-spectro`; compute peak/range/dur from the
  buffer (~15 lines). Make it discoverable: **auto-expand the representative recording** on modal open.

### 02 · Song bloom (radial) — *lift: medium* — RECOMMENDED as the signature
Polar spectrogram: time = angle, pitch = radius, energy = ink; per-call **rosette**. Sits up by the
illustration as the bird's "voiceprint." **Animation:** blooms open petal-by-petal synced to playback;
gentle idle drift (reduced-motion gated).
- *Integration:* new `renderBloom(canvas, audioBuffer)` beside `paintSpectrogram`. New
  `#modalVoiceprint` canvas in `.modal-img`/`.modal-info` (`index.html` detail-modal). Paint the
  representative clip on modal open. Sweep angle from `modalAudio.currentTime/duration` inside the
  existing cursor rAF loop (`startCursorLoop`/`modalCursorRaf`, `apt.js:2180–2196`).

### 03 · Line signature — *lift: medium*
Dominant-pitch contour as a single flowing line that **draws itself** as it plays; width swells with
loudness. Matches the line-art SVG icons already in the modal (pose toggle).
- *Integration:* new `renderLine`; reuse the peak-pitch track (smooth it — see demo). Animate by
  clipping to `currentTime` in the cursor loop. Risk: noisy/buzzy calls need the smoothing + an
  energy gate so silent gaps break the line.

### 04 · Living halo — *lift: med-high*
The illustration ringed by an aura; each **syllable emits a ripple**. Most alive, subtlest to keep
tasteful, leans on playback (not a static glanceable signature).
- *Integration:* reuse the live view's realtime path — attach a Web Audio **`AnalyserNode`** to
  `modalAudio` (mirror `attachSpectrogram`/`drawSpectrogram`, `apt.js:1855–1925`) and drive a canvas
  aura around `#modalImg`. Needs its own rAF; gate idle motion on `prefers-reduced-motion`.

## CHOSEN DIRECTION (2026-06-20): Bloom signature + Line trace

Scott picked **02 Song bloom + 03 Line signature**. They're the **same data in two coordinate
systems** (the line is the bloom *unrolled* — both are the call's pitch-over-time), which is what
lets them coexist without feeling redundant or bloating the card. Mock of the integrated card:
**`spectro-card-mock.html`** (real Blue Jay illustration + bloom + animated line strips).

**No-bloat placement — each goes where the card already has room:**
- **Bloom = the species *signature*** → a small (~150px) canvas in `.modal-img`, **under the
  portrait**, filling whitespace that already exists beside the taller info column. Built from the
  **representative clip** (newest still-stored; aggregate "average bloom" is a future upgrade).
  Static at rest with a one-time **bloom-in** on open; re-sweeps when the representative recording
  plays. A mono caption beneath carries the **peak / range / duration** readout (the "01 labels").
- **Line = the per-clip *trace*** → painted into the **existing** `.rec-spectro` strip per recording
  row (today a bare heatmap). It **replaces** the heatmap → **zero** new card height. Draws itself
  in sync with the audio cursor; width swells with loudness.
- **Texture without clutter:** draw the line on a **very faint heatmap ground** (~30% alpha) inside
  the strip, so raspy/buzzy calls (jay, hawk) keep their broadband character while the pitch line
  stays the hero. (Demo'd in the mock.)
- **Optional unity touch (later):** hovering/playing a row could highlight the matching arc on the
  bloom — visually proving they're one dataset. Not needed for v1.

Net new footprint = just the small bloom in dead space; the line is a swap, not an addition.

---

## Decisions
- ✅ **Concept:** 02 bloom (signature) + 03 line (per-row trace). *(2026-06-20)*
- ✅ **Static vs animated:** static at rest; animate on play (bloom-in once on open). Avoids a busy card.
- ✅ **Placement:** bloom under the portrait; line in the existing per-row strip (replaces heatmap).
- ✅ **Representative call (bloom):** newest still-stored clip for v1.
- ◻️ **Aggregate "average bloom"** across all of a species' clips — cooler true fingerprint, future
  upgrade (average the STFTs; note R2 7-day expiry ⇒ "all" = "all still-stored").
- ◻️ **Mel-scale upgrade** (0–15 kHz) for max fidelity to "what BirdNET sees" — optional.

## Build sequence
1. Port two renderers from the mock into `apt.js`, beside `paintSpectrogram`:
   `renderBloom(canvas, audioBuffer, progress)` and `renderLine(canvas, audioBuffer, progress)`
   (both compute the same STFT + `peakSmooth`/`energy` arrays — factor a shared `analyzeBuffer(buf)`
   so each clip is analyzed once and cached alongside `_decodedCache`). Sanity-check against a real
   clip using `spectro-concepts.html` (swap synth for `fetch('/api/recording?...')`).
2. **Line in rows:** swap the heatmap for the line *on a faint heatmap ground* — change what
   `ensureSpectroImage` (`apt.js:3115`) paints into the existing `.rec-spectro` canvas. No DOM/space
   change. Keep the played-veil + cursor + scrub that already exist.
3. **Bloom signature:** add `<canvas id="modalVoiceprint">` + caption under `#modalImg` in the
   detail-modal (`index.html`); style in `styles.css` (square, `--recess`, scales down on mobile).
   In `openDetailModal` (`apt.js:2247`), after `j.detections` loads, pick the representative clip
   (newest; sort desc to be safe), `fetch`+`decodeAudioData` (reuse `_decodedCache`+`getSpecCtx`),
   paint with a one-time bloom-in; fill the caption with peak/range/duration.
4. **Animation:** drive `renderLine` progress from the existing cursor rAF loop
   (`startCursorLoop`/`modalCursorRaf`, `apt.js:2180`) so it tracks `modalAudio`. Re-sweep the bloom
   only while the representative clip plays. Gate the bloom-in / any idle motion on
   `prefers-reduced-motion`.
5. Theme repaint hook (repaint bloom + visible strips on `data-theme` change — mirror existing pattern).
7. Deploy: `avian/build-site.sh` → `wrangler pages deploy _site --project-name avianvisitors --branch avian-visitors`
   (barrysbirds is a 301 stub since 07-02 — do NOT deploy the real site there). Frontend-only; no worker/D1/Pi deploy.

## What was built (2026-06-20) — steps 1–6 done; step 7 (deploy) pending
- **Shared analysis:** `analyzeBuffer(audioBuffer)` (apt.js, beside `paintSpectrogram`) runs ONE STFT
  → `{grid, energy, peakSmooth, peakHz, loHz, hiHz, dur, binLo/binHi, cols}`, cached per-file in
  **`_analysisCache`** (parallel to `_decodedCache`). Verified numerically identical to the mock's
  `analyze` (scalars exact; arrays within float32 tolerance). **Key port detail:** the clip is
  normalized to a 0.6 peak (folded into the window step — NOT mutating the shared cached AudioBuffer)
  so quiet/loud calls get equal contrast; omitting this was caught by the parity test.
- **Line (per-row):** `renderLine` replaces what `ensureSpectroImage` paints — pitch trace on a
  ~30%-alpha heatmap ground, drawn into the existing `.rec-spectro` canvas. DOM played-veil + cursor
  + scrub kept. Animates from the cursor rAF loop (`startCursorLoop`); full static contour at rest
  (repainted on pause/stop/end via `restRowLine`).
- **Bloom (signature):** `renderBloom` into new `#modalBloom` canvas. **Layout (revised
  2026-06-20 per Scott's mock):** a new `.modal-lower` grid row under the portrait/info holds the
  **bloom on the LEFT (248px), recordings (scrollable) on the RIGHT** (`grid-template-columns:248px
  minmax(0,1fr)`); the voiceprint is FIRST in source so on mobile (single column) it sits directly
  below the description, never squished in a split box. (Earlier iterations put the bloom under the
  portrait, then on the right — both replaced.) Built from the
  representative clip (newest with a file; sorted
  desc) in `setupVoiceprint`. One-time bloom-in on open (`startBloomIntro`), re-sweeps when that clip
  plays (cursor loop), settles to full rosette otherwise (`restBloom`). Caption = peak/range/dur.
  Tap-to-replay. Degrades to a hidden panel on no-clip / expired-clip (404).
- **Morph gate:** `modalMorphDone` + a 340 ms timer delays the bloom's first paint until the open-
  morph clears its scale transform (else it sizes to the scaled box). `maybeStartBloom` fires on
  whichever of {analysis ready, morph done} lands last.
- **Reduced motion:** `_reduceMotion` (matchMedia) skips the bloom-in (paints the full rosette at once).
- **Theme:** `applyTheme` → `repaintSpectral` repaints bloom + expanded strips; heatmaps re-tint
  lazily (`heatFor` keys on `_heatTheme`).
- `paintSpectrogram`/`_paintSpectrogramNow` **kept** — atlas cards (`.spectro-wrap`) still use them;
  only the modal rows switched to the line.

## Gotchas to carry forward
- **Real field clips are NOISY — validate the analysis on REAL audio, not synthetic.** The mock's
  synth calls are clean tones; real clips have strong low-frequency wind/hum that makes a naive
  per-column argmax pitch go FLAT (identical circles / flat lines — the bug Scott hit). Whitening
  over-corrects to high-freq hiss. Fix shipped: band-limit to **1.8–8.5 kHz**, subtract each bin's
  **temporal noise floor** (per-bin median, in place), pitch = **energy-weighted centroid** (pow 1.5),
  energy = sum of the denoised grid. Verified by decoding real clips (ffmpeg) + running the extracted
  `analyzeBuffer` in node (`/tmp/extract-test.mjs` pattern).
- **Clips expire (R2 7-day TTL).** Old detections `/api/recording` 404 → graceful fallback (per-row
  `fail()` already does this). A "signature" must degrade to "no audio yet / clip expired."
- **Reuse `_decodedCache`** — don't refetch/redecode a clip the row already loaded.
- **Canvas-size race** in the morphing/expanding modal → reuse the rAF + size-retry guard.
- **Theme-aware paint** — read palette at paint time; repaint on theme toggle.
- **FLIP morph on open** (`morphModalOpen`) scales the card during the open animation — paint a
  top-of-card canvas *after* the morph settles or it sizes wrong.
- **Mobile** (`MOBILE-TODO.md`): frontend branches by width, not input type; a square bloom must
  scale down and support **touch** scrub (mirror the existing `.rec-spectro` touch handlers).
- **No worker/Pi changes** — keep it Pages-only (aligns with reuse / minimal-infra preference).

## Verify
- Light + dark; mobile width; species with **no clip** (404 fallback); species with **1 vs many**
  recordings; **playback sync** (animation tracks the audio cursor); `prefers-reduced-motion`.

---

## Runbook — signatures for ALL birds (and how to keep them good)

> Goal: make expanding from "detected species" to "every species with art" a one-command job, and
> capture the learnings that make the output *accurate* rather than just present.

### The whole pipeline is 3 steps
```bash
# 1. Generate/refresh signatures + bundled reference clips (needs the xeno-canto key).
node avian/scripts/build-signatures.mjs --all-art          # every species with art (~263)
#   or no flag = just the live DETECTED species; --only "Genus species"; --force to re-pick clips;
#   --limit N to test. Incremental by default (skips species already in signatures.json).

# 2. Assemble the static site.
bash avian/build-site.sh

# 3. Deploy. (barrysbirds is a 301 stub since 2026-07-02 — the real site is the
#    `avianvisitors` project, prod branch `avian-visitors`, served at
#    indianridgeroad.com/birds/. build-site.sh now cache-busts signatures.json +
#    clip URLs, so new signatures are visible immediately — no 24h wait.)
npx wrangler pages deploy _site --project-name avianvisitors --branch avian-visitors
#   (verify via avianvisitors.pages.dev ORIGIN before probing the /birds/ proxy —
#    a premature proxy probe during the prod-alias flip cache-poisons the new URL.)
```
Outputs (commit these): `avian/assets/signatures.json` + `avian/assets/songs/<slug>.mp3`. CI deploys
never need the key or network — they just ship the committed artifacts.

### Prereqs
- **xeno-canto v3 API key** at `~/.config/avian/xeno-canto-key` (mode 600, outside the repo;
  mandatory since 2025-10-10). Free: register at xeno-canto.org → account → API key.
- **ffmpeg** + **node** on PATH.

### Cost / scale for "all birds" (~263 species)
- ~1–4 xeno-canto downloads per species (it keeps the most tonal of the top candidates), polite
  ~1 s spacing → roughly **10–20 min** wall-clock; a few **MB** of bundled mp3 (≈30–50 KB each).
- xeno-canto free-tier: be polite (the script already sleeps). Don't parallelise hard.

### The learnings that actually matter (don't relearn these the hard way)
1. **Compute energy + pitch from LINEAR POWER, never the dB grid.** dB compression + 0..1 saturation,
   summed over a linear-frequency band, over-weight the wide high-frequency region and pin every
   dominant near the ceiling (a robin "at 7 kHz"). dB is for the heatmap *visual* only. This single
   bug is why the first build looked wrong. (`spectral-core.js`, `analyzeBuffer`.)
2. **Validate the pitch/energy math on REAL clips, never just synthetic.** Synthetic tones are clean
   and hide both #1 and noise issues. Decode real clips with ffmpeg and dump the raw power spectrum
   in ~500 Hz buckets — that's ground truth for "where is this bird actually?". Sanity targets:
   Robin ~2.4k, Carolina Wren ~2.8k, Cardinal ~2.8k, Cedar Waxwing ~7k (genuinely high).
3. **Clip quality > clip availability.** Many xeno-canto uploads tagged `type:song` are actually chip
   calls / drumming / have background species, which wreck the reading (Cardinal read 8 kHz from one
   such clip). The script ranks by metadata (pure `song`, empty `also`, short, A-grade) then keeps
   the most **tonal** of the top few. Trust the `tonality=` number in the log.
4. **License: CC only, reject ND** (trimming a clip is a derivative), and **show attribution**
   (recordist + XC link) — it's required, and the modal renders it from `attr` in signatures.json.
5. **Known hard cases** → use `avian/assets/signature-overrides.json` (`{"Genus species": <XC id>}`):
   - **Woodpeckers** (Downy/Hairy) have no tonal song; `type:song` returns drums/high calls → read
     high. Pick a clean "whinny" recording by id, or accept/hide.
   - **Mourning Dove, Raven** fundamentals are **below the 1.8 kHz band floor** → they read at the
     floor. Expected; could widen `SPEC_FLO` for a low-bird pass if it matters.
   - Species with **no CC-licensed song** are skipped (logged) → their bloom is simply hidden.
6. **Single source of truth:** the STFT lives in `avian/frontend/spectral-core.js`, loaded in the
   browser AND `require`d by the build script — so the canonical bloom and the live per-recording
   line can't drift. Change the math there once.
7. **CSS cascade gotcha:** the modal's early `@media(max-width:700px)` block sits *above* the base
   modal rules, so a mobile override placed there loses the specificity tie. Put modal mobile
   overrides *after* their base rule (see the `.modal-lower` single-column rule).

### To review/improve coverage
Re-run `--all-art --force`, then eyeball the printed dominant-Hz table against biology (the script
logs `peak`/range/`tonality` per species). Anything clearly off → add an override id and re-run
`--only "Genus species" --force`.
