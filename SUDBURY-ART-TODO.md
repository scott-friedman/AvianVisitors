# SUDBURY-ART-TODO.md — bird illustration worklist

**Plain English:** the birds below get *detected* fine at Dad's, but have **no
artwork**, so they're invisible on the e-ink frame and the website (the
"detected ≠ shown" gotcha — see `CLAUDE.md`). This file tracks which still need
illustrations drawn. Work the **land** list top-down (it's ranked by how often
each is actually detected at Sudbury). Progress: **1 / 46 land birds done.**

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
   `GEMINI_API_KEY=… python3 avian/scripts/pregen.py --species "Sci|Com" --out /tmp/bird-art-preview`
2. **Clean the cream ground with `avian/scripts/keycut.py` — NOT `cutout.py`.**
   `cutout.py`'s rembg/onnxruntime `new_session()` **hangs in native code** on this
   Mac's Xcode `/usr/bin/python3` (any model). `keycut.py` is a deterministic
   flood-fill key-out (border-connected cream→alpha, drops <2% specks, 1px feather,
   2% crop) — cleaner than the ML matte on these flat grounds. See `avian/scripts/README.md`.
3. **Review:** copy both PNGs to `~/Downloads`, show Scott, get **per-bird approval**
   before moving on (his workflow — one bird at a time). [[scott-art-approval-workflow]]
4. On approval → move both PNGs into `avian/assets/illustrations/`.
5. **After a batch** (not per bird): `build_masks.py` + bump `SKETCH_VERSION`/`IMG_VERSION`
   in `apt.js` → `avian/build-site.sh` → `wrangler pages deploy … barrysbirds`.
   Past detections render **retroactively** — no Pi change needed.

## Caveat for later
- The key-out is validated on a vivid bird. **Spot-check very pale birds** (the
  deferred gulls/doves, plus White-throated Sparrow / Eastern Bluebird belly) where
  white plumage ≈ cream — the edge-connected fill should protect interior white, but eyeball it.

---

## Land birds needing art — ranked by Sudbury detection frequency (work top-down)
- [ ] **Gray Catbird** — `Dumetella carolinensis` · freq 0.83
- [ ] **Red-eyed Vireo** — `Vireo olivaceus` · freq 0.75
- [x] **Northern Cardinal** — `Cardinalis cardinalis` · freq 0.74  ✅ DEPLOYED LIVE 2026-06-20 — in assets/illustrations/, masks rebuilt (r11), live on barrysbirds.pages.dev; confirmed rendering on a real detection
- [ ] **Black-capped Chickadee** — `Poecile atricapillus` · freq 0.73
- [ ] **Blue Jay** — `Cyanocitta cristata` · freq 0.73
- [ ] **Common Grackle** — `Quiscalus quiscula` · freq 0.62
- [ ] **Tufted Titmouse** — `Baeolophus bicolor` · freq 0.54
- [ ] **Ovenbird** — `Seiurus aurocapilla` · freq 0.49
- [ ] **Eastern Phoebe** — `Sayornis phoebe` · freq 0.41
- [ ] **Eastern Kingbird** — `Tyrannus tyrannus` · freq 0.37
- [ ] **Eastern Wood-Pewee** — `Contopus virens` · freq 0.34
- [ ] **Ruby-crowned Kinglet** — `Corthylio calendula` · freq 0.29
- [ ] **Great Crested Flycatcher** — `Myiarchus crinitus` · freq 0.27
- [ ] **Ruby-throated Hummingbird** — `Archilochus colubris` · freq 0.27
- [ ] **Red-bellied Woodpecker** — `Melanerpes carolinus` · freq 0.25
- [ ] **Wood Thrush** — `Hylocichla mustelina` · freq 0.24
- [ ] **Veery** — `Catharus fuscescens` · freq 0.22
- [ ] **Scarlet Tanager** — `Piranga olivacea` · freq 0.17
- [ ] **Black-throated Green Warbler** — `Setophaga virens` · freq 0.16
- [ ] **Yellow-bellied Sapsucker** — `Sphyrapicus varius` · freq 0.15
- [ ] **Blue-headed Vireo** — `Vireo solitarius` · freq 0.14
- [ ] **Eastern Bluebird** — `Sialia sialis` · freq 0.14
- [ ] **White-throated Sparrow** — `Zonotrichia albicollis` · freq 0.13
- [ ] **Rose-breasted Grosbeak** — `Pheucticus ludovicianus` · freq 0.13
- [ ] **Northern Parula** — `Setophaga americana` · freq 0.13
- [ ] **Pine Warbler** — `Setophaga pinus` · freq 0.13
- [ ] **Chestnut-sided Warbler** — `Setophaga pensylvanica` · freq 0.12
- [ ] **Chimney Swift** — `Chaetura pelagica` · freq 0.12
- [ ] **Carolina Wren** — `Thryothorus ludovicianus` · freq 0.10
- [ ] **Field Sparrow** — `Spizella pusilla` · freq 0.08
- [ ] **Winter Wren** — `Troglodytes hiemalis` · freq 0.08
- [ ] **Bobolink** — `Dolichonyx oryzivorus` · freq 0.08
- [ ] **Black-throated Blue Warbler** — `Setophaga caerulescens` · freq 0.08
- [ ] **Least Flycatcher** — `Empidonax minimus` · freq 0.07
- [ ] **Blackburnian Warbler** — `Setophaga fusca` · freq 0.06
- [ ] **Brown Thrasher** — `Toxostoma rufum` · freq 0.06
- [ ] **Fish Crow** — `Corvus ossifragus` · freq 0.06
- [ ] **Blackpoll Warbler** — `Setophaga striata` · freq 0.05
- [ ] **Orchard Oriole** — `Icterus spurius` · freq 0.04
- [ ] **Broad-winged Hawk** — `Buteo platypterus` · freq 0.04
- [ ] **Northern Waterthrush** — `Parkesia noveboracensis` · freq 0.04
- [ ] **Alder Flycatcher** — `Empidonax alnorum` · freq 0.04
- [ ] **Eastern Meadowlark** — `Sturnella magna` · freq 0.04
- [ ] **Yellow-billed Cuckoo** — `Coccyzus americanus` · freq 0.03
- [ ] **Blue-winged Warbler** — `Vermivora cyanoptera` · freq 0.03
- [ ] **Yellow-throated Vireo** — `Vireo flavifrons` · freq 0.03

## Coastal / wetland — DEFERRED (inland backyard mic won't hear these; add only if one is actually detected)
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
