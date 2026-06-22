# STATS-RHYTHM-PLAN.md

Cold-start implementation plan: **replace the "species" timeline chart on the
stats page with "The Day Rhythm" — a ridgeline of when each bird is heard
across the day.** Mirrors the pattern of `STATS-DAYDIAL-PLAN.md` and
`STATS-FACTS-PLAN.md` (both shipped). A fresh session should be able to execute
this end-to-end from this file alone.

> Status: **SHIPPED 2026-06-22.** Built end-to-end and deployed live —
> `avian-worker` (`/api/rhythm`) + `barrysbirds.pages.dev` (toggle slot renamed
> `species`→`rhythm`, `drawHistograms` replaced by `drawDayRhythm`, all timeline
> CSS removed bar the shared `.stats-tl-empty`). The Day Dial (default chart) and
> the right-cell Field Notes / summary are unaffected. Endpoint smoke-tested
> (12 species, sorted dawn→dusk, bins sum to totals, honest `days_covered`).
> Visually confirmed in-browser + approved by Scott 2026-06-22. Post-ship tune:
> ridge `amp` lowered `laneH*1.5` -> `laneH*0.85` so peaks stay inside their own
> lane (the 1.5 overlap crashed spiky few-day-data ridges through the names above).

---

## 1. Plain English Summary (for a non-technical reader)

The stats page has a little chart toggle with two views: **"day"** (a clock-face
that shows when birds are active *all together*) and **"species"** (the one
we're replacing). Today the "species" chart is confusing — it lines birds up
left-to-right but the left-to-right axis doesn't really mean anything useful, so
you can't actually learn much from it.

We're replacing it with **"The Day Rhythm."** Picture a stack of little
mountain-range silhouettes, one row per bird. Each row shows **what times of day
you tend to hear that bird** — a hump in the morning means it's a dawn singer, a
hump in the late afternoon means it shows up before dusk. The rows are sorted so
**early-morning birds sit at the top and evening birds toward the bottom**, so
the whole picture "cascades" through the day like a sunrise-to-sunset story.

Each bird is drawn on **its own scale**, so a quiet, rare bird's morning habit is
just as visible as a loud, common one's — you're comparing *timing*, not
*loudness* (the bird's total call count still sits next to its name). A soft
shaded band marks daylight hours, and a faint line marks "right now." If you
**slide across the chart**, a little label tells you who's most active at that
exact hour ("8–9am: Robin 12, Cardinal 8, Wren 5"), which answers the question
"what's around at 8am vs noon vs 5pm" directly.

To make the pattern trustworthy, the chart looks at the **last couple of weeks**
of listening (a "typical day"), not just today — one quiet morning won't distort
it. Everything keeps the site's existing hand-drawn, ink-on-cream look, and it
all renders in the cloud exactly like the other charts, so the little Raspberry
Pi at the window does no extra work.

---

## 2. Exact requirement (from the request + the locked decisions)

> "I don't really love the 'species' graph on the stats page. Revamp it to a tool
> that visualizes how different birds appear throughout the day — to get a sense
> of what is most common at 8am vs 12pm vs 5pm etc. Match the aesthetic of the
> site, as a replacement to the existing graph."

Three design questions were put to the user and **answered** (do not re-litigate
— see §4):

1. **Visual form → Ridgeline cascade.** One filled curve per species, stacked,
   ordered by peak hour (dawn on top → dusk on bottom).
2. **Cell/curve scale → Per-species (own scale).** Each bird normalized to its
   own busiest hour; the row label carries the absolute total so volume isn't
   lost.
3. **Time window → Typical day (fixed lookback).** Always aggregate a full 24h
   portrait over a fixed recent window (default **14 days**), **independent of
   the global 1H/12H/24H/7D/ALL picker.** A caption states the actual span.

---

## 3. The design — "The Day Rhythm"

A single responsive SVG (`viewBox`-scaled, like the Day Dial — no pixel-width
recompute needed). Top-to-bottom: one **lane** per species.

```
              12a        6a          12p         6p        12a
  ┌─────────────────────────────────────────────────────────────┐
  │            ░░░░░░░░░ daylight band ░░░░░░░░░░                 │
  │  ROBIN  12      ╱▔▔╲                         ╱╲               │   ← earliest
  │              __╱    ╲__________________   __╱  ╲__            │     peak on top
  │  WREN   31        ╱▔╲                                         │
  │              ____╱   ╲_____________________________          │
  │  BLUE JAY 44        ╱▔▔╲                                      │
  │              ______╱    ╲___________________________         │
  │  CHICKADEE 28      ╱▔╲                                        │
  │              _____╱   ╲_____________________________         │
  │  CARDINAL 19    ╱▔╲                          ╱╲              │   ← later
  │              __╱   ╲________________________╱  ╲___          │     peak below
  │              ┊now                                            │
  └─────────────────────────────────────────────────────────────┘
     12a    3a    6a    9a   12p   3p    6p    9p   11p
              (hover/drag → "8–9am: Robin 12 · Cardinal 8 · Wren 5")
```

**Geometry (viewBox units, W=320):**
- X-axis = clock hour, `x = plotL + (h/24)·plotW`, midnight→midnight. Curves are
  sampled at **hour centers** (`h + 0.5`) and pinned to the lane baseline at the
  `x=0` and `x=24` edges so each ridge opens and closes cleanly.
- Each lane `i` has a baseline `y = padT + (i+1)·laneH`. The ridge rises *upward*
  from the baseline by `(bins[h] / speciesMax) · amp`, where `amp = laneH · 1.5`
  (a >1 factor gives the classic ridgeline *slight overlap* into the lane above;
  tune 1.3–1.7 to taste).
- **Per-species normalization:** `speciesMax = max(bins)` for that row, so every
  ridge peaks at full `amp` at its own busiest hour.
- **Ordering:** server returns species pre-sorted by **peak hour (argmax),
  circular-mean tiebreak** (see §5.2). Dawn singers → top.
- **Smoothing:** Catmull-Rom → cubic Bézier through the 24 sample points
  (helper `smoothPath` in Appendix A). Two paths per lane: a filled `.rhythm-area`
  (closed down to baseline) and an open `.rhythm-crest` (the top stroke) — the
  standard ridgeline look.

**Shared context (reused from the Day Dial, tz-correct from the Worker, never the
viewer's clock — see CLAUDE.md D5):**
- **Daylight band:** a faint full-height `<rect>` from `sunrise` to `sunset`
  (`RY.sun`, same `sunArc` the dial uses).
- **"Now" line:** a dashed vertical at `RY.now_local.frac`.
- **Hour gridlines:** faint verticals at 0/6/12/18/24 + monospace hour labels.

**Interactions:**
- **Scrubber (the payoff for "what's common at 8am"):** hover (desktop) or drag
  (touch) moves a vertical line snapped to the hovered clock hour; a readout pill
  ranks that hour's species by **absolute count** (`bins[h]`, top 4). The ridges
  show *rhythm* (per-species-normalized); the scrubber is where *"who's most
  common right now"* is answered with real magnitudes. (`wireRhythmScrub`, App. A.)
- **Click a lane → jump to that bird** (`data-sci` on the `<g class="rhythm-lane">`;
  needs one line added to the global click delegate — see §6.5).
- **Cross-highlight** with the right-cell species list (the existing `sync-hi`
  mechanic; needs `.rhythm-lane` added to one selector — see §6.5).
- **Entrance:** lanes fade + rise, staggered top→bottom (the cascade reveal);
  respects `prefers-reduced-motion` (`playRhythmEntrance`, App. A).

**Empty / sparse states:**
- No species at all → `<div class="stats-tl-empty">no detections yet</div>`
  (reuse the existing empty-state class — keep it; the dial uses it too).
- A ridge from 1–2 calls is noise: the server drops species with `total < 3`
  and caps to the top `N` (default 12) by total count.
- Caption: `"typical day · last <days_covered> days · <N> species"` — `days_covered`
  is honest about a young box (won't claim 14 days on a 3-day-old deployment).

**Mobile (`innerWidth ≤ 700`):** taller lanes (`laneH ≈ 30`) and a slightly larger
label font so the ridges/labels stay legible when the fixed viewBox scales down.
X is a fixed 24h span, so — unlike the old timeline — **no horizontal scroll** is
needed.

---

## 4. Decisions taken (so you don't re-litigate)

| # | Decision | Rationale |
|---|---|---|
| D1 | **Ridgeline cascade** (not heatmap / mini-clocks) | User pick. Most striking; the dawn→dusk ordering tells the story of the day. |
| D2 | **Per-species normalization**, row labeled with absolute total | User pick. Every bird's rhythm legible regardless of volume; magnitude not lost (label + scrubber carry it). |
| D3 | **Fixed lookback (14 days), ignores the window picker** | User pick. A time-of-day pattern needs several days; 1H/12H would render near-empty. |
| D4 | **Scrubber ranks by absolute count** | Answers "most common at 8am" with real numbers, complementing the normalized ridges. |
| D5 | **Order by argmax peak hour, circular-mean tiebreak** | Clean dawn→dusk cascade; circular mean handles the midnight wrap for ties. |
| D6 | **Server returns raw 24-bins per species**; client normalizes | Keeps the Worker generic; client owns the visual scale. Mirrors how `hourly` ships raw bins. |
| D7 | **Rename toggle slot `timeline`→`rhythm`** (label "rhythm"), DOM `#statsTimeline`→`#statsRhythm` | Clarity; the old name described the discarded chart. One-line pref migration handles stored `bird:statsChart`. |
| D8 | **New endpoint `GET /api/rhythm`** (not an extension of `/api/hourly`) | Different window semantics (fixed lookback) and shape (per-species matrix). `hourly` stays as-is for the dial. |
| D9 | **Delete `drawHistograms` + timeline CSS** | It's fully replaced; per-species totals still live in the right-cell "Top Species" list. See §12. |

---

## 5. Backend — the one new endpoint (`avian-worker`)

File: `worker/src/index.js`. Reuses existing helpers: `clampInt`, `json`,
`tzMod`, `sunArc`, and the `env.TZ_OFFSET_HOURS` / `SITE_LAT` / `SITE_LON` vars
(all already wired for `hourly`).

### 5.1 Route registration
- Add `'rhythm'` to the `known` array (currently `index.js:451`).
- Add a switch case (after the `hourly` case, ~`index.js:464`):
  ```js
  case 'rhythm': return rhythm(env, url, tz, now);
  ```

### 5.2 The handler
Add next to `hourly()` (~`index.js:740`). Full reference in **Appendix B**. Shape:

- Params: `?days=14` (clamp 1–90), `?top=12` (clamp 1–40).
- One query: `SELECT strftime('%H',ts,'unixepoch',tz) AS hour, sci, com, COUNT(*) n
  FROM detections WHERE ts >= since GROUP BY hour, sci`.
- Fold rows into per-species `{ sci, com, total, bins[24] }`.
- Compute `peak_hour` (argmax) and `mean_hour` (circular mean) per species.
- Filter `total >= 3`, sort by total desc, take top `N`, then **re-sort the kept
  set by `peak_hour` asc** (mean_hour, then total, as tiebreaks).
- `days_covered = min(days, floor((now - MIN(ts in window))/86400)+1)` for an
  honest caption.
- Append `now_local` + `sun` exactly as `hourly()` does (copy that block).
- Response:
  ```json
  {
    "days": 14, "days_covered": 9, "top": 12,
    "species": [ { "sci":"Turdus migratorius", "com":"American Robin",
                   "total": 412, "peak_hour": 5, "mean_hour": 6.2,
                   "bins": [0,0,...,24 ints] }, ... ],   // ordered dawn→dusk
    "tz_offset_hours": -4,
    "now_local": { "hour": 14, "minute": 7, "frac": 14.12 },
    "sun": { "sunrise": 5.17, "sunset": 20.45 },
    "as_of": "2026-…Z"
  }
  ```

### 5.3 Deploy the Worker
From `worker/`: `npx wrangler deploy`. Smoke-test:
`curl -s 'https://<worker-host>/api/rhythm?days=14' | head -c 800` (curl avoids the
Python-urllib 403 gotcha; browsers are fine). Confirm `species[]` is non-empty and
sorted by `peak_hour`.

---

## 6. Frontend — file map & exact anchors

All three files live in `avian/frontend/`. Anchors are the line numbers as of
2026-06-22; grep the quoted text if they've drifted.

### 6.1 `index.html` — stats markup (the `#v1` view, lines 82–139)
- Toggle button (line 91):
  `<button type="button" data-chart="timeline">species</button>`
  → `<button type="button" data-chart="rhythm">rhythm</button>`
- Chart container (line 103):
  `<div class="stats-timeline" id="statsTimeline" hidden></div>`
  → `<div class="stats-rhythm" id="statsRhythm" hidden></div>`
- Update the adjacent HTML comments (lines 85–102) to describe the ridgeline.

### 6.2 `apt.js` — data layer
- `DATA` object (~line 960): add a slot
  ```js
  rhythm: null,  // ?action=rhythm&days=N — per-species 24h bins (FIXED lookback, NOT the picker)
  ```
- `refreshAll()` (~line 1654): add **one** fetch to the `Promise.all` and accept it
  **regardless of the window** (it's window-independent, like `facts`/`stats`):
  ```js
  fetchJson(AV_API + '/api/birdnet-api.php?action=rhythm&days=14').catch(function(){return null;}),
  // …in the .then, after parts[6]:
  if (parts[7]) DATA.rhythm = parts[7];
  ```
  `refreshAll(true)` is the initial load, so this also covers first paint.
- **Do NOT** add the rhythm fetch to `refreshRecent()` (~line 1627) — that's the
  picker-change path, and the rhythm chart is deliberately picker-independent (D3).

### 6.3 `apt.js` — render routing
- `drawActiveStatsChart()` (line 789):
  ```js
  var tl = document.getElementById('statsTimeline');   // → 'statsRhythm'
  …
  else { dial.hidden = true; tl.hidden = false; drawHistograms(animate); }   // → drawDayRhythm(animate)
  ```
- `playActiveStatsEntrance()` (line 777): the non-dial branch
  `else playStatsTimelineEntrance(lead);` → `else playRhythmEntrance(document.getElementById('statsRhythm'), lead);`
- Resize handler (~line 915): replace `drawHistograms();` with
  `drawActiveStatsChart();` (re-evaluates the mobile/desktop branch when crossing
  the 700px breakpoint; the SVG itself scales without it).

### 6.4 `apt.js` — the renderer + interactions
Replace `drawHistograms` + `playStatsTimelineEntrance` (lines ~1169–1276) with
**`drawDayRhythm`, `wireRhythmScrub`, `playRhythmEntrance`** (full reference in
**Appendix A**).

### 6.5 `apt.js` — wire the lane into the two existing `data-sci` mechanics
- **Click-to-bird** (global click delegate, `index.js`… i.e. `apt.js:3796`): add a
  branch alongside the others:
  ```js
  var lane = ev.target.closest('.rhythm-lane[data-sci]');
  if (lane) return jumpToSci(lane.dataset.sci);
  ```
- **Cross-highlight** (`wireStatsHighlight` → `setHi`, `apt.js:1287`): add
  `.rhythm-lane` to the toggled selector so a hovered lane lights the matching
  side-list row and vice-versa:
  ```js
  v1.querySelectorAll('.rhythm-lane[data-sci="' + esc + '"], .stats-tl-col[data-sci="' + esc + '"], .stats-side li[data-sci="' + esc + '"]')
  ```
  (Leave `.stats-tl-col` in or strip it — it's dead once the timeline is gone; see §12.)

### 6.6 `apt.js` — toggle pref migration
`window.__statsChart` init (~line 197): migrate any stored `'timeline'` value:
```js
var __sc = readLS('bird:statsChart', 'dial');
window.__statsChart = (__sc === 'timeline') ? 'rhythm' : __sc;
if (__sc === 'timeline') writeLS('bird:statsChart', 'rhythm');
```
The `data-chart` attribute on the button is now `"rhythm"`, so the existing
`aria-current` sync and click handler (lines 198–207) work unchanged.

### 6.7 `styles.css` — new rules
Add the `.stats-rhythm` / `.rhythm-*` block (**Appendix C**). Update
`.stats-dial[hidden], .stats-timeline[hidden]` (line 1664) →
`…, .stats-rhythm[hidden]`. See §12 for the timeline CSS to remove.

---

## 7. Build order (each step independently testable)

1. **Worker endpoint** (§5 + App. B). Deploy; `curl /api/rhythm?days=14` returns
   a sorted `species[]`. *Testable with zero frontend changes.*
2. **Data slot + fetch** (§6.2). In devtools, `DATA.rhythm` populates on load.
3. **Renderer** (§6.4 + App. A) + **markup/routing rename** (§6.1, §6.3) + **CSS**
   (§6.7 + App. C). Flip the toggle to "rhythm" → ridgeline draws. *Visual check.*
4. **Interactions** (§6.5): click a lane → atlas card; hover a lane → side-list
   row highlights. Scrubber readout tracks the cursor.
5. **Pref migration** (§6.6): set `localStorage['bird:statsChart']='timeline'`,
   reload → lands on "rhythm" without error.
6. **Dead-code removal** (§12). Rebuild, re-verify nothing else referenced it.
7. **Deploy Pages:** `avian/build-site.sh` then
   `wrangler pages deploy _site --project-name barrysbirds --branch production`
   (run from `worker/`, per CLAUDE.md).

---

## 8. Aesthetic tokens to reuse (verbatim)

- Marks: `fill/stroke: var(--ink)`; hover/active: `var(--accent)`; gridlines &
  hairlines: `var(--hairline)`; backgrounds: `var(--paper)` / `--paper-2` / `--paper-3`.
- Micro-labels (hours, totals): `font: 8px/1 ui-monospace, Menlo, monospace;
  letter-spacing: 0.08em; text-transform: uppercase; fill: var(--ink-soft)` (copied
  from `.dial-hlabel`).
- Species names: the timeline's serif treatment —
  `font: 10px/1.1 ui-serif, "Iowan Old Style", Georgia, serif; font-weight: 600`
  (lifted from the removed `.stats-tl-label .com`).
- Readout pill: clone `.dial-tip` (+ `.hd`/`.t`/`.c`/`.n`) — `var(--paper)` bg,
  `var(--edge-lg)` shadow, monospace uppercase header, serif rows.
- Daylight band echoes `.dial-day`/`.dial-night`; "now" line echoes `.dial-now`.
- Entrance: hook `.entering` + a `rhythm-rise` keyframe into the existing stats
  entrance group; add the `prefers-reduced-motion` guard (mirror lines 536–539).

---

## 9. Edge cases & gotchas

- **tz correctness (CLAUDE.md D5):** all hour bucketing uses `strftime(…, tz)` and
  sun/now use `TZ_OFFSET_HOURS` — never the browser clock. Copy `hourly()`'s block
  verbatim; do not improvise.
- **Picker independence (D3):** the chart must *not* refetch on picker change. If
  you accidentally wire it into `refreshRecent`, short windows will blank it.
- **Young box:** with <3 days of data the ridges are lumpy but valid; the caption's
  `days_covered` keeps it honest. With zero detections, show the empty state.
- **One dominant species:** per-species normalization (D2) is exactly what prevents
  a 10× Robin from flattening everyone — verify a quiet species still shows a clear
  hump.
- **Midnight wrap:** ordering uses circular mean for ties so an owl peaking at
  23:00/01:00 sorts to the bottom, not the middle.
- **`stats-tl-empty` is shared:** the Day Dial *and* this chart use it — **keep**
  that CSS rule when deleting the rest of the timeline styles (§12).
- **SVG `<g>` transform animation:** the entrance animates `transform` on the lane
  `<g>` — fine in modern browsers; the reduced-motion guard disables it.
- **403 on ad-hoc GETs:** only affects Python-urllib scripts (set a `User-Agent`);
  browser `fetch` and `curl` are unaffected. No change needed here.
- **Pages 200-HTML fallback:** unrelated to data, but if a lane label looks wrong
  remember art/`content-type` probing is by file, not HTTP status.

---

## 10. Test / verify

- `curl -s '…/api/rhythm?days=14' | jq '.species | length, .species[0]'` — sorted,
  `bins` sums look like `total`.
- Toggle "rhythm": ridges render, dawn species on top, daylight band + now line
  placed sensibly for Sudbury-local time.
- Hover across the chart: scrubber snaps per hour; readout ranks by count and
  matches `bins[h]`.
- Click a lane → opens that bird; hover a lane ↔ side-list row highlight both ways.
- Toggle back to "day": Day Dial unaffected. Reload on "rhythm": persists.
- Dark mode: fills/strokes/daylight band invert cleanly (check `--ink`/`--paper`).
- Mobile (≤700px / real iPhone): labels legible, no horizontal scroll, touch-drag
  scrubber works, tap-outside dismisses the readout.
- `prefers-reduced-motion`: no entrance animation, chart still correct.
- Picker sanity: switch 1H/12H/24H/7D/ALL — the rhythm chart **does not change**.

---

## 11. Files touched (summary)

| File | Change |
|---|---|
| `worker/src/index.js` | + `rhythm()` handler; register action (§5). |
| `avian/frontend/index.html` | toggle label/value + container id rename (§6.1). |
| `avian/frontend/apt.js` | DATA slot + `refreshAll` fetch; render routing rename; `drawDayRhythm`/`wireRhythmScrub`/`playRhythmEntrance`; click + highlight wiring; pref migration; **remove `drawHistograms`/`playStatsTimelineEntrance`** (§6, §12). |
| `avian/frontend/styles.css` | + `.rhythm-*` block; `[hidden]` selector; **remove `.stats-tl-*` / `.stats-timeline`** except `.stats-tl-empty` (§6.7, §12). |

No Pi-side, frame, D1-schema, or `wrangler.toml` changes. (`/api/rhythm` reads the
existing `detections` table.)

---

## 12. Dead code to remove (explicit — clean up after yourself)

Remove **only after** the ridgeline works (Build step 6). List, then delete:

**`apt.js`**
- `function drawHistograms` (~1176–1276).
- `function playStatsTimelineEntrance` (~755–772).
- In `setHi` (§6.5): the `.stats-tl-col[data-sci=…]` term (timeline-only).
- Global click delegate: the `var tlCol = ev.target.closest('.stats-tl-col[data-sci]')`
  branch (~3796).

**`styles.css`** (remove the timeline block; **KEEP `.stats-tl-empty`** — shared):
- `.stats-timeline`, `.stats-tl-yaxis`, `.stats-tl-ytick`(+`::after`), `.stats-tl-plot`,
  `.stats-tl-col`(+`.sync-hi` variants + `cursor`), `.stats-tl-gridline`,
  `.stats-tl-square`, `.stats-tl-label`(+`.com`/`.sci`), `.stats-tl-xtick`,
  `.stats-tl-cap`, and the `.stats-tl-*` entries in the `.entering` keyframe group
  (lines ~529–539) and the mobile block (lines ~614–623).

Grep `stats-tl-` and `Histogram` / `Timeline` afterward to confirm only
`.stats-tl-empty` remains.

---

## 13. Out of scope / stretch (don't build now)

- A per-species **absolute/relative scale toggle** (D2 chose per-species; a toggle
  is cheap to add later — both numbers are already on the client).
- Folding the rhythm view into the **e-ink frame** render (the panel shows the
  collage; leave it).
- **Seasonal** rhythm (month-over-month) — needs much more data; revisit later.
- Letting the **picker** scope the lookback (7D→7, ALL→all) — deferred; fixed 14d
  is the chosen default.

---

## Appendix A — `drawDayRhythm` reference implementation (`apt.js`)

Drop in where `drawHistograms` was. Desktop-tuned; the `isMobile` branch bumps
`laneH`/label size.

```js
// ---- Day Rhythm: per-species ridgeline of activity by clock hour ----
// Each species is a horizontal lane; the filled curve is that species'
// detections across the 24h "typical day" (DATA.rhythm — a FIXED multi-day
// lookback, NOT the window picker). Curves are normalized per-species (own
// peak = full lane height) so every bird's rhythm reads regardless of volume;
// the row label carries the absolute total. Lanes arrive pre-sorted by peak
// hour (server-side) so dawn singers sit on top and the ridges cascade down
// the day. A daylight band + "now" line echo the Day Dial; a hover/drag
// scrubber reads the cross-section ("8–9am: Robin 12, Cardinal 8, …").
function drawDayRhythm(animate) {
  var host = document.getElementById('statsRhythm');
  if (!host) return;
  var RY = DATA.rhythm || {};
  var sp = RY.species || [];
  if (!sp.length) { host.innerHTML = '<div class="stats-tl-empty">no detections yet</div>'; return; }

  var isMobile = (window.innerWidth || 800) <= 700;
  var N = sp.length;

  var W = 320, padL = 12, padR = 12, padT = 12, padB = 18;
  var plotL = padL, plotW = (W - padR) - padL;
  var laneH = isMobile ? 30 : 26;      // baseline-to-baseline spacing
  var amp   = laneH * 1.5;             // max ridge height (>laneH ⇒ slight overlap)
  var H = padT + N * laneH + padB;

  function xForH(h) { return plotL + (h / 24) * plotW; }
  function f(x) { return x.toFixed(2); }

  // Catmull-Rom → cubic Bézier through pts [[x,y],…] (tension 1/6).
  function smoothPath(pts) {
    if (pts.length < 2) return '';
    var d = 'M' + f(pts[0][0]) + ' ' + f(pts[0][1]);
    for (var i = 0; i < pts.length - 1; i++) {
      var p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || pts[i + 1];
      var c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
      var c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += 'C' + f(c1x) + ' ' + f(c1y) + ' ' + f(c2x) + ' ' + f(c2y) + ' ' + f(p2[0]) + ' ' + f(p2[1]);
    }
    return d;
  }

  var s = ['<svg class="rhythm-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="When each species is heard across the day">'];

  // daylight band
  var sun = RY.sun;
  if (sun && sun.sunrise != null && sun.sunset != null) {
    var dx = xForH(sun.sunrise), dw = xForH(sun.sunset) - xForH(sun.sunrise);
    s.push('<rect class="rhythm-daylight" x="' + f(dx) + '" y="' + padT + '" width="' + f(dw) + '" height="' + (H - padT - padB) + '"/>');
  }
  // hour gridlines
  [0, 6, 12, 18, 24].forEach(function (h) {
    s.push('<line class="rhythm-grid" x1="' + f(xForH(h)) + '" y1="' + padT + '" x2="' + f(xForH(h)) + '" y2="' + (H - padB) + '"/>');
  });

  // ridges, top (earliest peak) → bottom
  sp.forEach(function (row, i) {
    var base = padT + (i + 1) * laneH;
    var bins = row.bins || [];
    var mx = bins.reduce(function (m, v) { return Math.max(m, v); }, 0) || 1;
    var pts = [[xForH(0), base]];
    for (var h = 0; h < 24; h++) pts.push([xForH(h + 0.5), base - (bins[h] / mx) * amp]);
    pts.push([xForH(24), base]);
    var crest = smoothPath(pts);
    var area = crest + 'L' + f(xForH(24)) + ' ' + f(base) + 'L' + f(xForH(0)) + ' ' + f(base) + 'Z';
    var esc = String(row.sci).replace(/"/g, '&quot;');
    s.push('<g class="rhythm-lane" data-sci="' + esc + '" data-i="' + i + '">');
    s.push('<path class="rhythm-area" d="' + area + '"/>');
    s.push('<path class="rhythm-crest" d="' + crest + '"/>');
    s.push('<text class="rhythm-name" x="' + (plotL + 2) + '" y="' + f(base - 3) + '">'
      + (row.com || row.sci) + '<tspan class="rhythm-total" dx="5">' + fmtNK(row.total) + '</tspan></text>');
    s.push('</g>');
  });

  // hour axis labels
  [[0, '12a'], [6, '6a'], [12, '12p'], [18, '6p'], [24, '12a']].forEach(function (l) {
    s.push('<text class="rhythm-hlabel" x="' + f(xForH(l[0])) + '" y="' + (H - 6) + '" text-anchor="middle">' + l[1] + '</text>');
  });

  // "now" line + (hidden) scrubber
  if (RY.now_local) {
    var nf = RY.now_local.frac != null ? RY.now_local.frac : RY.now_local.hour;
    var nx = xForH(nf);
    s.push('<line class="rhythm-now" x1="' + f(nx) + '" y1="' + padT + '" x2="' + f(nx) + '" y2="' + (H - padB) + '"/>');
  }
  s.push('<line class="rhythm-scrub" x1="0" y1="' + padT + '" x2="0" y2="' + (H - padB) + '" hidden/>');
  s.push('</svg>');
  host.innerHTML = s.join('');

  // caption (own class — the timeline's .stats-tl-cap is removed in §12)
  var dc = RY.days_covered || RY.days || 0;
  host.insertAdjacentHTML('beforeend',
    '<div class="rhythm-cap">typical day · last ' + dc + ' day' + (dc === 1 ? '' : 's') + ' · ' + N + ' species</div>');

  wireRhythmScrub(host, sp, { W: W, plotL: plotL, plotW: plotW });
  if (animate) playRhythmEntrance(host);
}

// Hover (desktop) / drag (touch) a vertical scrubber; the readout ranks the
// species heard in that clock hour by ABSOLUTE count (ridges are normalized,
// so this is where "who's most common at 8am" is answered). Mirrors
// wireDialHover's one-time outside-tap dismissal.
function wireRhythmScrub(host, species, geo) {
  var svg = host.querySelector('.rhythm-svg');
  var scrub = host.querySelector('.rhythm-scrub');
  if (!svg || !scrub) return;
  var tip = document.createElement('div'); tip.className = 'rhythm-readout'; tip.hidden = true; host.appendChild(tip);
  function lab(h) { var ap = h < 12 ? 'a' : 'p', hr = (h % 12) || 12; return hr + ap; }

  function showAt(clientX) {
    var box = svg.getBoundingClientRect();
    var vbX = ((clientX - box.left) / box.width) * geo.W;
    var h = Math.floor(((vbX - geo.plotL) / geo.plotW) * 24);
    h = Math.max(0, Math.min(23, h));
    var sx = geo.plotL + ((h + 0.5) / 24) * geo.plotW;
    scrub.setAttribute('x1', sx); scrub.setAttribute('x2', sx); scrub.hidden = false;
    var ranked = species.map(function (s) { return { com: s.com || s.sci, n: (s.bins || [])[h] || 0 }; })
      .filter(function (r) { return r.n > 0; }).sort(function (a, b) { return b.n - a.n; }).slice(0, 4);
    var rows = ranked.length
      ? ranked.map(function (r) { return '<span class="t"><span class="c">' + r.com + '</span><span class="n">' + r.n + '</span></span>'; }).join('')
      : '<span class="t">—</span>';
    tip.innerHTML = '<span class="hd">' + lab(h) + '–' + lab((h + 1) % 24) + '</span>' + rows;
    tip.hidden = false;
    var hb = host.getBoundingClientRect();
    tip.style.left = Math.max(4, Math.min(hb.width - 4, clientX - hb.left)) + 'px';
  }
  function hide() { scrub.hidden = true; tip.hidden = true; }

  svg.addEventListener('mousemove', function (e) { showAt(e.clientX); });
  svg.addEventListener('mouseleave', hide);
  svg.addEventListener('touchstart', function (e) { if (e.touches[0]) showAt(e.touches[0].clientX); }, { passive: true });
  svg.addEventListener('touchmove',  function (e) { if (e.touches[0]) showAt(e.touches[0].clientX); }, { passive: true });
  if (!wireRhythmScrub._outsideWired) {
    wireRhythmScrub._outsideWired = true;
    document.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('.rhythm-svg')) return;
      document.querySelectorAll('.rhythm-readout').forEach(function (t) { t.hidden = true; });
      document.querySelectorAll('.rhythm-scrub').forEach(function (l) { l.hidden = true; });
    });
  }
}

// Lanes fade + rise, staggered top→bottom (the dawn→dusk cascade reveal).
function playRhythmEntrance(host, lead) {
  if (!host) return;
  lead = lead || 0;
  var lanes = [].slice.call(host.querySelectorAll('.rhythm-lane'));
  if (!lanes.length) return;
  lanes.forEach(function (el, i) { el.classList.remove('entering'); el.style.animationDelay = Math.round(lead + i * 55) + 'ms'; });
  void host.offsetWidth;
  lanes.forEach(function (el) { el.classList.add('entering'); });
  setTimeout(function () { lanes.forEach(function (el) { el.classList.remove('entering'); el.style.animationDelay = ''; }); }, lead + lanes.length * 55 + 480);
}
```

---

## Appendix B — `/api/rhythm` handler reference (`worker/src/index.js`)

```js
// Per-species activity by LOCAL clock hour over a FIXED multi-day lookback (the
// "typical day"), for the Day Rhythm ridgeline. Independent of the collage
// window picker: a daily pattern needs several days to be meaningful, so this
// always aggregates the last ?days=N (default 14, clamp 1–90). Returns the top
// ?top=M species (default 12) by total detections, each with a 24-bin hourly
// histogram (raw counts — the client normalizes per-species), ordered by peak
// hour so the ridges cascade dawn→dusk. Reuses hourly()'s sun + now_local block.
async function rhythm(env, url, tz, now) {
  const days = clampInt(url.searchParams.get('days'), 14, 1, 90);
  const top  = clampInt(url.searchParams.get('top'), 12, 1, 40);
  const since = now - days * 86400;

  const { results } = await env.DB.prepare(
    `SELECT CAST(strftime('%H', ts, 'unixepoch', ?) AS INT) AS hour,
            sci, com, COUNT(*) AS n
       FROM detections
      WHERE ts >= ?
      GROUP BY hour, sci`
  ).bind(tz, since).all();

  const bySci = new Map();
  for (const r of (results || [])) {
    let s = bySci.get(r.sci);
    if (!s) { s = { sci: r.sci, com: r.com, total: 0, bins: new Array(24).fill(0) }; bySci.set(r.sci, s); }
    if (r.hour >= 0 && r.hour < 24) { s.bins[r.hour] = r.n; s.total += r.n; }
  }

  const list = [...bySci.values()].map((s) => {
    let peak = 0, peakN = -1;
    for (let h = 0; h < 24; h++) if (s.bins[h] > peakN) { peakN = s.bins[h]; peak = h; }
    let sx = 0, sy = 0;
    for (let h = 0; h < 24; h++) { const a = (2 * Math.PI * h) / 24; sx += s.bins[h] * Math.cos(a); sy += s.bins[h] * Math.sin(a); }
    const meanHour = ((Math.atan2(sy, sx) / (2 * Math.PI)) * 24 + 24) % 24;
    return { ...s, peak_hour: peak, mean_hour: Math.round(meanHour * 100) / 100 };
  });

  list.sort((a, b) => b.total - a.total);
  const kept = list.filter((s) => s.total >= 3).slice(0, top);
  kept.sort((a, b) => (a.peak_hour - b.peak_hour) || (a.mean_hour - b.mean_hour) || (b.total - a.total));

  const span = await env.DB.prepare('SELECT MIN(ts) AS first FROM detections WHERE ts >= ?').bind(since).first();
  const days_covered = span && span.first != null ? Math.min(days, Math.floor((now - span.first) / 86400) + 1) : 0;

  // tz-correct now + sun (identical to hourly()).
  const offH = parseInt(env.TZ_OFFSET_HOURS ?? '0', 10) || 0;
  const localNow = new Date((now + offH * 3600) * 1000);
  const now_local = {
    hour: localNow.getUTCHours(),
    minute: localNow.getUTCMinutes(),
    frac: localNow.getUTCHours() + localNow.getUTCMinutes() / 60,
  };
  const sun = sunArc(env, localNow, offH);

  return json({
    days, days_covered, top,
    species: kept,
    tz_offset_hours: offH, now_local, sun,
    as_of: new Date().toISOString(),
  });
}
```

Register (in `queryApi`): add `'rhythm'` to `known`, and
`case 'rhythm': return rhythm(env, url, tz, now);`.

---

## Appendix C — Day Rhythm CSS (`styles.css`)

```css
/* ---- Day Rhythm ridgeline (replaces the .stats-tl-* timeline) ---- */
.stats-rhythm { position: relative; flex: 1 1 auto; min-height: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center; }
.stats-dial[hidden], .stats-rhythm[hidden] { display: none; }
.rhythm-svg { width: 100%; max-width: 460px; height: auto; overflow: visible; }

.rhythm-daylight { fill: var(--ink); fill-opacity: 0.035; }
:root[data-theme="dark"] .rhythm-daylight { fill-opacity: 0.06; }
.rhythm-grid { stroke: var(--hairline); stroke-width: 1; }
.rhythm-area  { fill: var(--ink); fill-opacity: 0.10; transition: fill-opacity 150ms ease; }
.rhythm-crest { fill: none; stroke: var(--ink); stroke-width: 1; transition: stroke 150ms ease; }
.rhythm-lane  { cursor: pointer; }
.rhythm-lane.is-hover .rhythm-area, .rhythm-lane.sync-hi .rhythm-area { fill-opacity: 0.20; }
.rhythm-lane.is-hover .rhythm-crest, .rhythm-lane.sync-hi .rhythm-crest { stroke: var(--accent); stroke-width: 1.3; }

.rhythm-name { font: 10px/1.1 ui-serif, "Iowan Old Style", Georgia, serif; font-weight: 600; fill: var(--ink);
  paint-order: stroke; stroke: var(--paper); stroke-width: 3px; stroke-linejoin: round; }  /* paper halo for legibility over fills */
.rhythm-total { fill: var(--ink-soft); font-size: 8px; font-weight: 400; }
.rhythm-hlabel { fill: var(--ink-soft); font: 8px/1 ui-monospace, Menlo, monospace; letter-spacing: 0.08em; text-transform: uppercase; }
.rhythm-now  { stroke: var(--ink); stroke-width: 1; stroke-dasharray: 2 2; opacity: 0.7; }
.rhythm-scrub { stroke: var(--accent); stroke-width: 1; }
.rhythm-scrub[hidden] { display: none; }

/* caption — normal-flow, muted mono (matches the old .stats-tl-empty/.cap voice) */
.rhythm-cap { margin-top: 4px; font: 8.5px/1 "SF Mono", Menlo, monospace;
  color: var(--ink-soft); letter-spacing: 0.04em; text-align: center; }

/* readout pill — mirrors .dial-tip */
.rhythm-readout { position: absolute; top: 4px; transform: translateX(-50%); pointer-events: none; z-index: 5;
  background: var(--paper); box-shadow: var(--edge-lg); border-radius: 8px; padding: 6px 8px; white-space: nowrap; }
.rhythm-readout[hidden] { display: none; }
.rhythm-readout .hd { display: block; font: 9px/1.4 ui-monospace, Menlo, monospace; letter-spacing: 0.08em;
  color: var(--ink-soft); text-transform: uppercase; margin-bottom: 3px; }
.rhythm-readout .t  { display: flex; gap: 10px; justify-content: space-between;
  font: 11px/1.5 ui-serif, "Iowan Old Style", Georgia, serif; }
.rhythm-readout .t .n { color: var(--ink-soft); font-variant-numeric: tabular-nums; }

/* entrance (hook into the existing stats entrance group) */
@keyframes rhythm-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.rhythm-lane.entering { animation: rhythm-rise 480ms cubic-bezier(.2,.7,.3,1) backwards; }
@media (prefers-reduced-motion: reduce) { .rhythm-lane.entering { animation: none; } }

@media (max-width: 700px) {
  .rhythm-svg { max-width: 100%; }
  /* drawDayRhythm bumps laneH + keeps labels legible via its isMobile branch */
}
```

Keep the existing `.stats-tl-empty` (do **not** delete — the Day Dial and this
chart's empty state both use it). The caption uses its own `.rhythm-cap`, so the
timeline's `.stats-tl-cap` can be removed wholesale (§12).
```
