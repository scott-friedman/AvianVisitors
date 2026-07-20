# SUDBURY-ART-TODO.md — bird illustration worklist

**Plain English:** the birds below get *detected* fine at Dad's, but have **no
artwork**, so they're invisible on the e-ink frame and the website (the
"detected ≠ shown" gotcha — see `CLAUDE.md`). This file tracks which still need
illustrations drawn. Work the **land** list top-down (it's ranked by how often
each is actually detected at Sudbury). Progress: **35 / 46 land birds done.**
(All 11 remaining are **undetected** at Sudbury so far — no current collage gap; add on detection.)

## How this list was derived (don't redo unless the location changes)
- BirdNET range/meta model @ Sudbury **42.3834, -71.4162**, threshold **0.03**
  (= the box's `SF_THRESH`), **year-round union** of 12 weeks → 147 candidates.
  Method (run on the Pi, read-only): see [[avian-deploy-state]] memory.
- Diffed against the **249** species that already have art in
  `avian/assets/illustrations/` (slug = lower(sci), spaces→`-`, drop `-2`/`.png`).
- Machine-readable, `pregen.py`-ready inputs (`Sci|Com` per line):
  `sudbury-missing-art.labels` (land) · `sudbury-missing-art-waterbirds.labels` (coastal).

## Per-bird pipeline (proven 2026-06-20 on the Northern Cardinal)
1. **Generate** (2 cream-ground poses → `<slug>.png` perched, `<slug>-2.png` flight):
   `GEMINI_API_KEY="$(cat ~/.config/avian/gemini-api-key)" python3 avian/scripts/pregen.py --species "Sci|Com" --out /tmp/bird-art-preview`
   (key lives in a 600 file outside the repo — see [[gemini-api-key-location]] memory; never inline the literal key)
   **API budget = exactly 2 calls/species** (perched + flight). Stay frugal: pass `--species` per bird (repeatable),
   **never `--force`** (re-renders everything), and keep `--out /tmp/bird-art-preview` (existing files there are skipped). All re-keying/touch-ups after this are free — work from the raws.
2. **Clean the cream ground with `avian/scripts/keycut.py` — NOT `cutout.py`.**
   `cutout.py`'s rembg/onnxruntime `new_session()` **hangs in native code** on this
   Mac's Xcode `/usr/bin/python3` (any model). `keycut.py` is a deterministic
   flood-fill key-out (border-connected cream→alpha, drops <2% specks, 1px feather,
   2% crop) — cleaner than the ML matte on these flat grounds. See `avian/scripts/README.md`.
   **For pale-bellied birds add `--tol 18`** (default 34 eats the belly outline — see "Caveat for later").
3. **Review:** copy both PNGs to `~/Downloads`, show Scott, get **per-bird approval**
   before moving on (his workflow — one bird at a time). [[scott-art-approval-workflow]]
4. On approval → move both PNGs into `avian/assets/illustrations/`.
5. **After a batch** (not per bird): `build_masks.py` + bump `SKETCH_VERSION`/`IMG_VERSION`
   in `apt.js` → `avian/build-site.sh` → `wrangler pages deploy … barrysbirds`.
   Past detections render **retroactively** — no Pi change needed.

## Caveat for later — pale birds need a lower `--tol` (learned 2026-06-20)
- `keycut.py`'s default `TOL=34` **eats the lower-belly outline of pale-bellied
  birds**: where a near-white belly meets the cream ground through a thin/leaky
  spot in the dark outline, the border-connected fill treats the belly as ground
  and erases it. **Observed on the Red-eyed Vireo + Black-capped Chickadee bellies.**
- **Fix (no regeneration): re-key from the raw cream-ground PNG with `--tol 18`** —
  `python3 avian/scripts/keycut.py --tol 18 <slug>.png <slug>-2.png`. 18 spares the
  white belly *and* still removes the flat ground; ~13 is too low (ground stops
  being removed). Verify on a magenta background (reveals eaten edges + halos) before delivering.
- Always keep the raw generations (e.g. `/tmp/bird-art-preview/raw/`) so re-keying costs **zero** API calls.
- After keying, **sweep on magenta** for leftover bits: disconnected specks just over
  keycut's 2% drop threshold (remove the non-main connected component) and connected
  strays like a perch off the feet (region-erase, confirm vs the raw). Full how-to: `avian/scripts/README.md`.
- Still **spot-check the very palest** (deferred gulls/doves, White-throated Sparrow,
  Eastern Bluebird belly) — they may want an even lower tol or a per-bird eyeball.
- **Confirmed 2026-06-22 (batch 3): very-white bellies need `--tol 14`, not 18.** Wood
  Thrush (white spotted belly, +44k px), Eastern Wood-Pewee, Veery, and Blue-headed
  Vireo all had the lower belly eaten at 18 and keyed clean at 14 (verified: 0
  border-halo px, single connected blob). On a cream/parchment background an eaten
  belly is invisible — it reads as "washed out" (how Scott caught these), so check on
  **magenta** AND against the raw, not on parchment. **But do NOT blanket-lower the
  tol:** for the Great Crested Flycatcher, tol 14 left cream **ground blobs** near the
  perch. Two traps when chasing a low tol — (1) those blobs are *interior*, so a
  border-only halo check misses them; (2) a raw "belly pixels recovered" count
  conflates real belly with ground junk. **Verdict test:** the recovered region must be
  ONE connected component with **high mean color-distance from cream (≈120+)**, not a
  low-distance (≈14) blob. White-throated Sparrow — despite being the palest — keyed
  clean at 18 (its white throat is fully enclosed by dark borders), so decide per-bird.

---

## Land birds needing art — ranked by Sudbury detection frequency (work top-down)
- [x] **Gray Catbird** — `Dumetella carolinensis` · freq 0.83  ✅ DEPLOYED LIVE 2026-06-20 (r12) — keyed `--tol 18` (pale belly), de-speckled; served live as image/png on barrysbirds.pages.dev
- [x] **Red-eyed Vireo** — `Vireo olivaceus` · freq 0.75  ✅ DEPLOYED LIVE 2026-06-20 (r12) — keyed `--tol 18` (white belly), flight smudge cleared; served live as image/png
- [x] **Northern Cardinal** — `Cardinalis cardinalis` · freq 0.74  ✅ DEPLOYED LIVE 2026-06-20 — in assets/illustrations/, masks rebuilt (r11), live on barrysbirds.pages.dev; confirmed rendering on a real detection
- [x] **Black-capped Chickadee** — `Poecile atricapillus` · freq 0.73  ✅ DEPLOYED LIVE 2026-06-20 (r12) — keyed `--tol 18`, stray foot-perch erased; served live as image/png
- [x] **Blue Jay** — `Cyanocitta cristata` · freq 0.73  ✅ DEPLOYED LIVE 2026-06-20 (r13) — detected n=59; keyed `--tol 18`; "stray perch" investigated + cleared (keying fringe on the claws, not a real twig)
- [x] **Common Grackle** — `Quiscalus quiscula` · freq 0.62  ✅ DEPLOYED LIVE 2026-06-20 (r13) — detected n=3; keyed `--tol 34` (all-dark, no pale belly to protect → cleaner edge)
- [x] **Tufted Titmouse** — `Baeolophus bicolor` · freq 0.54  ✅ DEPLOYED LIVE 2026-06-20 (r13) — detected n=19; keyed `--tol 18` (pale belly/flanks)
- [x] **Ovenbird** — `Seiurus aurocapilla` · freq 0.49  ✅ DEPLOYED LIVE 2026-06-20 (r13) — detected n=3 (was one of the first real detections rendering as nothing); keyed `--tol 18` (white belly)
- [x] **Eastern Phoebe** — `Sayornis phoebe` · freq 0.41  ✅ DEPLOYED LIVE 2026-06-20 (r13) — fill (not yet detected); keyed `--tol 18`; correctly plain (phoebes have no bold marks — verified not over-keyed)
- [x] **Eastern Kingbird** — `Tyrannus tyrannus` · freq 0.37  ✅ DEPLOYED LIVE 2026-06-20 (r13) — fill (not yet detected); keyed `--tol 18`; white tail-tip band reads clearly
- [x] **Eastern Wood-Pewee** — `Contopus virens` · freq 0.34  ✅ DEPLOYED LIVE 2026-06-22 (r14) — keyed `--tol 14` (whitish belly was eaten at 18; washed-out-belly QA pass)
- [x] **Ruby-crowned Kinglet** — `Corthylio calendula` · freq 0.29  ✅ DEPLOYED LIVE 2026-06-22 (r14) — keyed `--tol 18` (clean; ruby crown patch visible on perched)
- [x] **Great Crested Flycatcher** — `Myiarchus crinitus` · freq 0.27  ✅ DEPLOYED LIVE 2026-06-22 (r14) — keyed `--tol 18`. NB: do NOT drop to 14 — its pale gray breast keys clean at 18, but 14 sprouts cream ground blobs by the perch (interior, so a border-halo check misses them; the fg-recovery metric also misreads the blobs as "recovered belly")
- [x] **Ruby-throated Hummingbird** — `Archilochus colubris` · freq 0.27  ✅ DEPLOYED LIVE 2026-06-20 (r13) — detected n=2; keyed `--tol 18`; ruby gorget present on perched
- [x] **Red-bellied Woodpecker** — `Melanerpes carolinus` · freq 0.25  ✅ DEPLOYED LIVE 2026-06-20 (r13) — detected n=1; keyed `--tol 18`; zebra back + red cap + clinging pose all clean
- [x] **Wood Thrush** — `Hylocichla mustelina` · freq 0.24  ✅ DEPLOYED LIVE 2026-06-22 (r14) — keyed `--tol 14` (white spotted belly badly eaten at 18 — +44k px restored; the spots had been stranded)
- [x] **Veery** — `Catharus fuscescens` · freq 0.22  ✅ DEPLOYED LIVE 2026-06-22 (r14) — keyed `--tol 14` (pale belly eaten at 18); kept visibly distinct from Wood Thrush (faint vs bold spotting)
- [x] **Scarlet Tanager** — `Piranga olivacea` · freq 0.17  ✅ DEPLOYED LIVE 2026-06-22 (r14) — keyed `--tol 18` (red+black male; clean edge, didn't need the all-dark tol 34)
- [x] **Black-throated Green Warbler** — `Setophaga virens` · freq 0.16  ✅ DEPLOYED LIVE 2026-06-22 (r14) — keyed `--tol 18` (tol 14 adds a border halo for almost no belly gain)
- [x] **Yellow-bellied Sapsucker** — `Sphyrapicus varius` · freq 0.15  ✅ DEPLOYED LIVE 2026-06-22 (r14) — keyed `--tol 18` (black & white, red crown+throat; clean)
- [x] **Blue-headed Vireo** — `Vireo solitarius` · freq 0.14  ✅ DEPLOYED LIVE 2026-06-22 (r14) — keyed `--tol 14` (white spectacles + belly eaten at 18; caught proactively in the QA pass)
- [x] **Eastern Bluebird** — `Sialia sialis` · freq 0.14  ✅ DEPLOYED LIVE 2026-06-20 (r13) — detected n=11; keyed `--tol 18`. **Flight pose regenerated once** (first gen drifted to a bordered vintage ornithological plate — wrong style, unkeyable); re-roll is proper kachō-e + matches the perched sibling
- [x] **White-throated Sparrow** — `Zonotrichia albicollis` · freq 0.13  ✅ DEPLOYED LIVE 2026-06-22 (r14) — keyed `--tol 18` (palest of the batch, but the white throat keys clean at 18 — no lower tol needed)
- [x] **Rose-breasted Grosbeak** — `Pheucticus ludovicianus` · freq 0.13  ✅ DEPLOYED LIVE 2026-06-22 (r15) — keyed `--tol 18` (clean white belly intact); textbook male (black hood, rose breast, big pale bill)
- [x] **Northern Parula** — `Setophaga americana` · freq 0.13  ✅ DEPLOYED LIVE 2026-06-22 (r15) — keyed `--tol 18`; yellow throat + chestnut/blue breast band + white belly
- [x] **Pine Warbler** — `Setophaga pinus` · freq 0.13  ✅ DEPLOYED LIVE 2026-06-22 (r15) — keyed `--tol 18`; de-strayed (a 2.6% island survived the 2% drop → keep-largest-component)
- [x] **Chestnut-sided Warbler** — `Setophaga pensylvanica` · freq 0.12  ✅ DEPLOYED LIVE 2026-06-22 (r15) — keyed `--tol 18`; yellow crown + chestnut sides + black eyeline
- [x] **Chimney Swift** — `Chaetura pelagica` · freq 0.12  ✅ DEPLOYED LIVE 2026-06-22 (r15) — DETECTED at Sudbury (Scott confirmed); keyed `--tol 34` (all-sooty, no pale belly to protect). Needed a NEW `species-notes.json` entry to stop the documented swift→swallow drift (no `styles/` dir or anti-ref photos on this Mac, so the note is the ONLY guard). Minor: flight-pose belly came out paler than a true uniformly-sooty swift, but shape/ID is unmistakably swift (no fork/rufous/blue) — re-roll that one pose if a darker belly is wanted
- [x] **Carolina Wren** — `Thryothorus ludovicianus` · freq 0.10  ✅ DEPLOYED LIVE 2026-06-20 (r13) — detected n=3 (was rendering as nothing); keyed `--tol 18`; white brow + cocked tail + decurved bill all read
- [x] **Field Sparrow** — `Spizella pusilla` · freq 0.08  ✅ DEPLOYED LIVE 2026-06-22 (r15) — keyed `--tol 18`; rusty cap, plain face, pink bill
- [x] **Winter Wren** — `Troglodytes hiemalis` · freq 0.08  ✅ DEPLOYED LIVE 2026-06-22 (r15) — good bird, but drifted to a **bordered-plate background** (a darker frame band → unkeyable by border-sampling, same failure as the E.Bluebird flight). Salvaged WITHOUT a re-roll: center-crop 12% to drop the frame, then re-key `--tol 30` + keep-largest. Cocked tail + barring read
- [x] **Bobolink** — `Dolichonyx oryzivorus` · freq 0.08  ✅ DEPLOYED LIVE 2026-06-22 (r15) — keyed `--tol 18`. First gen invented a **rufous wing patch** (wrong — Bobolinks have none) → added a `species-notes.json` note (tuxedo-backwards: solid-black body, buff nape, white scapulars/rump, NO rufous) + re-rolled the perched pose. Now correct
- [x] **Black-throated Blue Warbler** — `Setophaga caerulescens` · freq 0.08  ✅ DEPLOYED LIVE 2026-06-22 (r15) — keyed `--tol 18`. First gen was a **plain blue bird missing the diagnostic black face/throat/flanks** → added a `species-notes.json` note (black throat continues down the flanks as a side-stripe vs white belly; white wing "handkerchief") + re-rolled the perched pose. Now correct
- [x] **Least Flycatcher** — `Empidonax minimus` · freq 0.07  ✅ DEPLOYED LIVE 2026-06-22 (r15) — keyed `--tol 18`; olive-gray, bold eyering, wingbars, pale belly (a generic *Empidonax* — precise in-genus ID isn't achievable and isn't needed for the collage)
- [ ] **Blackburnian Warbler** — `Setophaga fusca` · freq 0.06
- [ ] **Brown Thrasher** — `Toxostoma rufum` · freq 0.06
- [ ] **Fish Crow** — `Corvus ossifragus` · freq 0.06
- [ ] **Blackpoll Warbler** — `Setophaga striata` · freq 0.05
- [ ] **Orchard Oriole** — `Icterus spurius` · freq 0.04
- [x] **Broad-winged Hawk** — `Buteo platypterus` · freq 0.04  ✅ DEPLOYED LIVE 2026-07-06 (r17) — detected n=1 (only detected-but-invisible bird left); keyed `--tol 18` (pale barred belly intact), cream strays removed via keep-largest. Needed a NEW `species-notes.json` entry (it's a BUTEO not an Accipiter — banded black-and-white tail + rufous-barred underparts + dark trailing edge in flight; the note prevented Red-tail/Accipiter drift). Bonus: also got a **song signature** (whistle is tonal, XC933598 @ 0.93) — complete species (art+bloom).
- [ ] **Northern Waterthrush** — `Parkesia noveboracensis` · freq 0.04
- [ ] **Alder Flycatcher** — `Empidonax alnorum` · freq 0.04
- [ ] **Eastern Meadowlark** — `Sturnella magna` · freq 0.04
- [ ] **Yellow-billed Cuckoo** — `Coccyzus americanus` · freq 0.03
- [ ] **Blue-winged Warbler** — `Vermivora cyanoptera` · freq 0.03
- [ ] **Yellow-throated Vireo** — `Vireo flavifrons` · freq 0.03

## Coastal / wetland — DEFERRED (inland backyard mic won't hear these; add only if one is actually detected)
- [x] **Greater Yellowlegs** — `Tringa melanoleuca` · freq 0.08  ✅ DEPLOYED LIVE 2026-07-20 — DETECTED at Sudbury (n=1) → the "add only if detected" trigger fired; it was the sole bird in both `/api/coverage` gaps (art + signature). Keyed perched `--tol 14` + keep-largest (white belly eaten at 18; 14 left one cream blob), flight clean `--tol 18`. NEW `species-notes.json` entry (long yellow legs + long slightly-upturned two-toned bill vs Lesser Yellowlegs / the Willet `tringa-semipalmata` we already have). Bonus: also got a **song signature** — no pure `type:song` on xeno-canto (shorebirds call, don't sing), so pinned the iconic ringing flight call via the NEW `avian/assets/signature-overrides.json` (XC474951, tonality 0.96, CC BY-NC-SA). Complete species (art+bloom); coverage now 0/0.
- [ ] **Double-crested Cormorant** — `Nannopterum auritum` · freq 0.13
- [ ] **Herring Gull** — `Larus argentatus` · freq 0.08
- [ ] **American Black Duck** — `Anas rubripes` · freq 0.24
- [ ] **Great Black-backed Gull** — `Larus marinus` · freq 0.15
- [ ] **Red-breasted Merganser** — `Mergus serrator` · freq 0.11
- [ ] **Least Sandpiper** — `Calidris minutilla` · freq 0.10
- [ ] **Semipalmated Plover** — `Charadrius semipalmatus` · freq 0.08
- [ ] **Lesser Yellowlegs** — `Tringa flavipes` · freq 0.08
- [ ] **Greater Yellowlegs** — `Tringa melanoleuca` · freq 0.08
- [ ] **Semipalmated Sandpiper** — `Calidris pusilla` · freq 0.07
- [ ] **Solitary Sandpiper** — `Tringa solitaria` · freq 0.06
- [ ] **Long-tailed Duck** — `Clangula hyemalis` · freq 0.05
- [ ] **Ruddy Duck** — `Oxyura jamaicensis` · freq 0.05
- [ ] **Surf Scoter** — `Melanitta perspicillata` · freq 0.04
- [ ] **Black-bellied Plover** — `Pluvialis squatarola` · freq 0.04
- [ ] **Common Eider** — `Somateria mollissima` · freq 0.04
- [ ] **Horned Grebe** — `Podiceps auritus` · freq 0.03
