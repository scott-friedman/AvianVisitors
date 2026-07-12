# CHORUS-PLAN.md — the "chorus" tab (rolling-12h streamgraph)

> **Cold-start build plan.** A fourth tab beside **collage / stats / atlas** that shows the
> last **rolling 12 hours** of bird calls as a flowing "river of song" — variety *and*
> per-species volume across the window — with the site's watercolor illustrations woven
> into the graphic. This doc is self-contained: a fresh session should be able to build it
> end-to-end from here. All file paths, insertion anchors, SQL, and response shapes below
> were verified against the repo on 2026-06-23.
>
> **New here? Read §0, then §1 (the concept), then build top-to-bottom from §5.**

---

## 0. Plain-English summary (read me first)

Barry's Birds already has three screens: the **collage** (every bird as an illustration),
**stats** (charts of activity), and the **atlas** (a card per species). This plan adds a
fourth screen, **"chorus."**

Chorus answers one question at a glance: *"What's been going on outside for the last twelve
hours?"* It draws time left-to-right — twelve hours ago on the left, **now** on the right —
as a smooth, flowing **river**. The wider the river at any moment, the busier the yard was
then. The river is made of colored **ribbons stacked together**, one per bird species, so a
thick band means that bird was especially vocal at that time. Each bird's **watercolor
illustration floats above its ribbon at the moment it was loudest**, so you don't read a
legend — you just see the birds riding their own wave. Quiet stretches (the middle of the
night) pinch the river thin; the dawn chorus swells it wide.

It's meant to be **immediately legible** (wide = busy, more colors = more kinds of birds)
but to **reward poking at it**: drag across the river to read exact counts at any time, tap
a bird to follow just its ribbon, and flip a couple of simple switches to change the time
detail or to see "share of the chorus" instead of raw counts.

Nothing changes on the Raspberry Pi. This is purely the website (a new screen) plus one new
data endpoint on the existing Cloudflare Worker. When it's done, visitors get a living,
twelve-hour "soundscape" that feels hand-drawn like the rest of the site.

**What the user will notice:** a new "chorus" button in the bottom nav; tapping it slides to
a flowing, illustrated graph of the last 12 hours that updates itself every ~30 seconds.

---

## 1. The concept — "Chorus," a streamgraph of the last 12 hours

### 1.1 What it is

A **streamgraph** (a.k.a. ThemeRiver): a stacked area chart whose stack is centered on a
wandering baseline instead of sitting on a flat axis, so the whole thing reads as an organic
flowing band. This form is *rare* (most people have never seen one), which makes it feel
special, and it maps perfectly onto the goal:

| Goal phrase | How the streamgraph encodes it |
|---|---|
| "the full arc of the last rolling 12 hours" | **x-axis = time**, `now-12h` (left) → `now` (right) |
| "variety of birds" | **number (and color) of ribbons** present; plus an optional thin **variety line** = distinct species per interval |
| "volume of each one at the different intervals" | **thickness of each species' ribbon** at each time bin |
| "what birds are active and when" | each bird's **illustration floats at its ribbon's peak** |
| "same art style / creative direction" | watercolor illustrations are the legend; paper/ink palette; smooth hand-drawn curves (reuses the rhythm chart's Catmull-Rom spline) |
| "user-friendly … while still having depth" | reads instantly (wide=busy); depth via scrub-readout, tap-to-isolate, interval + volume/mix toggles |

### 1.2 ASCII sketch

```
  The Last Twelve Hours                                   [ 30m · 1h ]  [ volume · mix ]
  ┌──────────────────────────────────────────────────────────────────────────────────┐
  │                         (robin floats at its peak)  🐦                              │
  │              ╭───────────╮                              ╭────╮                      │
  │        ╭─────╯  Robin     ╰─────╮                ╭──────╯    ╰───╮                  │
  │  ┄┄┄┄┄┄╪┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╪┄┄┄┄┄┄┄┄┄┄┄┄╪┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╪┄┄  ← variety line │
  │     🐦 ╰──╮  Chickadee  ╭────────╯       ╭──────╯  Cardinal  ╭───╯                  │
  │           ╰─────────────╯                ╰──────────────────╯       🐦              │
  │        ╰────╮   Jay   ╭──────────────────────────╮     ╭──────────╯                │
  │             ╰─────────╯                          ╰─────╯                           │
  └──────────────────────────────────────────────────────────────────────────────────┘
   12h ago    │ 🌙 night          │ ☀ daylight band                      │   ▼ now
            10pm        12am      4am  ↑dawn        8am          12pm        2pm
```

The river is centered (streamgraph baseline). Night pinches it thin; dawn swells it. Each
bird sits at the crest of its own ribbon. A faint dotted **variety line** tracks how many
*different* species were calling per interval (a second analytic dimension beyond raw volume).
A daylight band and a "now" edge reuse the same sun/now data the other charts already use.

### 1.3 Why this form (and what was considered and rejected)

- **Perch-branch timeline** (birds perched on a wire at their peak time): charming and very
  on-brand, but it only encodes each species' *single* peak moment — it loses "volume at the
  different intervals," which is an explicit requirement. *Rejected as the primary.* (Could
  return as an empty-state or a "mix" easter-egg.)
- **12-hour radial arc**: too close to the existing **Day Dial** (radial 24h) — redundant.
- **Per-species ridgeline over real time**: too close to the existing **Day Rhythm** ridgeline.
- **Murmuration particle field** (one dot per call, flocking): beautiful but imprecise; weak
  at "volume of each at intervals" and hard to make legible. *Rejected.*

The streamgraph is the one form that is (a) visually distinct from everything already on the
site, (b) a literal fit for variety+volume+time, and (c) buildable by reusing patterns the
codebase already has (hand-rolled SVG + Catmull-Rom + DOM-overlay illustrations).

### 1.4 Staged fallback (de-risks the build)

A **stacked area chart** (flat baseline at the bottom) is the streamgraph with `baseline = 0`.
Build that first (it's strictly simpler and obviously correct), confirm the data path, then
switch the baseline function to "symmetric/centered" to get the streamgraph — same boundary
math, one function swapped. See milestones (§15).

---

## 2. Assumptions & decisions to confirm

These are my defaults so the build isn't blocked. Flag any the owner wants changed.

1. **Tab label = `chorus`** (lowercase, like collage/stats/atlas). **View title = "The Last
   Twelve Hours."** Both trivially changeable (one array entry + one nav button).
2. **Window = fixed 12h, rolling, window-picker–independent** (like `/api/rhythm`). The global
   top-bar window picker (`#winPick`) should be **hidden while on chorus** since it has its own
   time controls; restore it on other views. (Default chosen; confirm.)
3. **Interval granularity** default **30 min** (24 bins over 12h), user-switchable to **1 hr**
   (12 bins). 30 min gives a smoother river; 1 hr is calmer/sparser. (No finer than ~15 min —
   BirdNET's latency floor + yard volume make finer bins noisy.)
4. **Ribbon color**: the site is deliberately near-monochrome (paper/ink). A streamgraph needs
   ribbons to be *distinguishable*, so this plan introduces a **small, curated, muted/earthy
   palette** (~12 watercolor-ish hues) assigned **stably per species** (hash of `sci`). This is
   a deliberate, flagged extension of the palette — kept low-saturation to stay
   field-notebook. (See §11.3. Optional upgrade: derive each ribbon's tint from its
   illustration's average color — §11.4.)
5. **All detected species appear as ribbons**, including ones with **no illustration art**
   (they just don't get a floating bird — they keep their ribbon + label). This is *different*
   from the collage (which hides art-less species) and is a feature here: a more honest picture
   of variety. (Confirm — alternative is to roll art-less species into "others.")
6. **Payload cap**: keep the top ~24 species by volume; roll the remainder into a single
   neutral **"others"** ribbon so total volume stays honest. 12h rarely exceeds a few dozen
   species, so this is mostly a safety bound.
7. **No Pi changes. No D1 schema changes.** New read-only Worker endpoint only.

---

## 3. Where this fits (architecture)

Recall the three-lane edge design (CLAUDE.md): the Pi only detects + uploads; **Cloudflare**
serves the public site (Pages) and the API (Worker) over **D1**. Chorus lives entirely in the
"static shell + live data" lanes:

```
 D1 (avian-detections)  →  avian-worker  /api/chorus  →  Pages frontend (new #v3 "chorus" view)
   (existing rows)          (NEW handler)                  (NEW renderer in apt.js + CSS)
```

- **Backend**: one new GET handler `chorus()` in `worker/src/index.js` (§5). Read-only.
- **Frontend**: one new `<section>` + nav button in `index.html`, wiring + a `drawChorus()`
  renderer in `apt.js`, and `chorus-*` styles in `styles.css` (§6–§11).
- **Assets**: reuses existing `avian/assets/illustrations/` (already shipped by `build-site.sh`).
- **Deploy**: existing `avian/build-site.sh` + `wrangler pages deploy`; `wrangler deploy` for
  the worker (§12).

---

## 4. File map (what gets touched)

| File | Change | Section |
|---|---|---|
| `worker/src/index.js` | add `chorus()` handler; register in `known[]` + `switch` | §5 |
| `avian/frontend/index.html` | add `<section id="v3">` + nav `<button data-i="3">` | §6 |
| `avian/frontend/apt.js` | view wiring (`VIEW_TITLES`, `go()` clamp+branch, winPick hide), `DATA.chorus` + fetch in `refreshAll`, `drawChorus()` renderer, controls, scrubber, entrance anim | §6–§10 |
| `avian/frontend/styles.css` | `.chorus-*` classes, palette vars, dark/mobile/reduced-motion | §11 |
| `CLAUDE.md` | (optional) add a one-line pointer to this doc in the Status section | §15 |

No changes to: the Pi, D1 schema/migrations, `build-site.sh` (already copies illustrations),
`wrangler.toml`, `spectral-core.js`, `config.js`.

---

## 5. Backend — new `/api/chorus` endpoint

### 5.1 Pattern recap (verified)

- Router: `worker/src/index.js` → `fetch()` falls through to `queryApi()` for any `/api/*`
  GET (line ~106–108). `queryApi()` (line 483) resolves an `action` from `?action=` **or the
  last path segment if it's in the `known[]` list** (line 488–490), then dispatches via a
  `switch` (line 495–507). So `GET /api/chorus` resolves automatically once `chorus` is added
  to `known[]` and the `switch`.
- Helpers available in scope: `tzMod(env)` → `"-4 hours"`; `clampInt(raw, dflt, lo, hi)`;
  `sunArc(env, localNow, offH)` → `{sunrise, sunset}` local fractional hours or `null`;
  `json(obj, status?, extra?)` → adds CORS + `Cache-Control: public, max-age=10`.
- Time model: `ts` is **unix seconds, UTC**. Rolling windows are computed in UTC seconds
  (`since = now - hours*3600`). Local binning is done with `strftime(..., 'unixepoch', tz)` —
  but for **sub-hour, clock-aligned** bins we bin by an integer slot index instead (below).
- `TZ_OFFSET_HOURS = "-4"` in `wrangler.toml` (Sudbury/Eastern; fixed offset is acceptable).

### 5.2 Two routing edits

In `worker/src/index.js`:

```js
// line ~488 — add 'chorus' to the known actions:
const known = ['recent', 'stats', 'lifelist', 'timeseries', 'species', 'firstseen', 'hourly', 'rhythm', 'facts', 'frame-config', 'chorus'];

// in the switch (after the 'rhythm' case, ~line 502):
case 'chorus': return chorus(env, url, tz, now);
```

### 5.3 The handler (copy-paste; mirrors `hourly()`/`rhythm()`)

Add near `rhythm()` (~line 840). Key idea: bin by a **local-clock-aligned slot index**
`floor((ts + offsetSeconds) / intervalSeconds)` so 30-min bins land on tidy `:00/:30` marks,
then express each species as a zero-filled array indexed `slot - firstSlot`.

```js
// Rolling N-hour stream of per-species detections, binned by a chosen interval, for the
// Chorus streamgraph. Fixed-duration rolling window (now-Nh .. now), independent of the
// collage window picker (like rhythm). Bins align to LOCAL wall-clock interval boundaries.
async function chorus(env, url, tz, now) {
  const hours    = clampInt(url.searchParams.get('hours'), 12, 1, 48);
  const interval = clampInt(url.searchParams.get('interval'), 30, 10, 120); // minutes
  const top      = clampInt(url.searchParams.get('top'), 24, 1, 60);

  const iv   = interval * 60;                                  // interval seconds
  const offH = parseInt(env.TZ_OFFSET_HOURS ?? '0', 10) || 0;
  const off  = offH * 3600;                                    // tz offset seconds
  const since = now - hours * 3600;

  const firstSlot = Math.floor((since + off) / iv);
  const lastSlot  = Math.floor((now   + off) / iv);
  const nBins = lastSlot - firstSlot + 1;

  const { results } = await env.DB.prepare(
    `SELECT CAST((ts + ?) / ? AS INT) AS slot, sci, com, COUNT(*) AS n
       FROM detections
      WHERE ts >= ?
      GROUP BY slot, sci
      ORDER BY slot, n DESC`
  ).bind(off, iv, since).all();

  const bySci = new Map();
  const totals  = new Array(nBins).fill(0);
  const variety = new Array(nBins).fill(0);
  const seen = Array.from({ length: nBins }, () => new Set());
  for (const r of (results || [])) {
    const b = r.slot - firstSlot;
    if (b < 0 || b >= nBins) continue;                         // defensive
    let s = bySci.get(r.sci);
    if (!s) { s = { sci: r.sci, com: r.com, total: 0, bins: new Array(nBins).fill(0) }; bySci.set(r.sci, s); }
    s.bins[b] += r.n; s.total += r.n;
    totals[b] += r.n;
    if (!seen[b].has(r.sci)) { seen[b].add(r.sci); variety[b] += 1; }
  }

  const all  = [...bySci.values()].sort((a, b) => b.total - a.total);
  const kept = all.slice(0, top);
  const rest = all.slice(top);
  let others = null;
  if (rest.length) {
    const bins = new Array(nBins).fill(0);
    let tot = 0;
    for (const s of rest) { for (let i = 0; i < nBins; i++) bins[i] += s.bins[i]; tot += s.total; }
    others = { total: tot, bins, n_species: rest.length };
  }

  for (const s of kept) {                                      // peak bin → where its bird floats
    let p = 0, pn = -1;
    for (let i = 0; i < nBins; i++) if (s.bins[i] > pn) { pn = s.bins[i]; p = i; }
    s.peak_bin = p;
  }

  const pad = (x) => String(x).padStart(2, '0');               // local bin-start labels
  const bin_starts = [];
  for (let i = 0; i < nBins; i++) {
    const startUtc = (firstSlot + i) * iv - off;
    const d = new Date((startUtc + off) * 1000);               // shift to read local fields as UTC
    bin_starts.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`);
  }

  const localNow = new Date((now + off) * 1000);
  const now_local = { hour: localNow.getUTCHours(), minute: localNow.getUTCMinutes(),
                      frac: localNow.getUTCHours() + localNow.getUTCMinutes() / 60 };
  const sun = sunArc(env, localNow, offH);

  return json({
    window_hours: hours, interval_minutes: interval, n_bins: nBins,
    tz_offset_hours: offH, now_local, sun,
    bin_starts, totals_by_bin: totals, variety_by_bin: variety,
    species: kept, others,
    as_of: new Date().toISOString(),
  });
}
```

### 5.4 Response shape (what the client consumes)

```json
{
  "window_hours": 12, "interval_minutes": 30, "n_bins": 24,
  "tz_offset_hours": -4,
  "now_local": { "hour": 14, "minute": 45, "frac": 14.75 },
  "sun": { "sunrise": 5.17, "sunset": 20.45 },
  "bin_starts": ["2026-06-23 03:00", "2026-06-23 03:30", "..."],
  "totals_by_bin":  [3, 5, 8, "..."],
  "variety_by_bin": [2, 3, 4, "..."],
  "species": [
    { "sci": "Turdus migratorius", "com": "American Robin",
      "total": 42, "peak_bin": 11, "bins": [0,1,2,5,"..."] }
  ],
  "others": { "total": 7, "bins": [0,0,1,"..."], "n_species": 5 },
  "as_of": "2026-06-23T18:45:12.345Z"
}
```

- `species[].bins` and `totals_by_bin`/`variety_by_bin` all have length `n_bins`.
- `bin_starts[i]` is the **local** wall-clock start of bin `i` (for axis labels + scrub readout).
- `sun`/`now_local` drive the daylight band + "now" edge (identical semantics to `hourly`).

### 5.5 Sizing & caching

- 12h × ~24 species × 24 bins of small ints ≈ **well under ~50 KB** JSON. Negligible.
- `json()` already sets `Cache-Control: public, max-age=10` — matches the 30 s client poll.
- Stays inside the free Browser-Rendering/D1 budgets (this is a plain D1 read, no rendering).

---

## 6. Frontend — wiring the 4th view (exact anchors)

All in `avian/frontend/`. The view system is an **index-based horizontal carousel**:
`.views#views` holds `<section class="view" id="vN">`; `go(i)` sets
`translateX(-i*100%)`. Adding a 4th view is purely additive — the translate math scales.

### 6.1 `index.html`

**(a) New view section** — insert **after** the atlas `</section>` (line 186) and **before**
the `</div>` that closes `.views` (line 188):

```html
<!-- ========== View 4 - Chorus ========== -->
<section class="view" id="v3" aria-label="Last twelve hours">
  <div class="chorus-wrap" id="chorusWrap">
    <div class="chorus-controls" id="chorusControls">
      <div class="chorus-interval" role="tablist" aria-label="time detail">
        <i class="seg-pill" aria-hidden="true"></i>
        <button type="button" data-iv="30" aria-current="true">30 min</button>
        <button type="button" data-iv="60">1 hr</button>
      </div>
      <div class="chorus-mode" role="tablist" aria-label="view mode">
        <i class="seg-pill" aria-hidden="true"></i>
        <button type="button" data-mode="volume" aria-current="true">volume</button>
        <button type="button" data-mode="mix">mix</button>
      </div>
    </div>
    <div class="chorus-stage" id="chorusStage"></div>   <!-- SVG + floating <img> overlay go here -->
    <div class="chorus-empty" id="chorusEmpty" hidden>No calls in the last 12 hours.</div>
  </div>
</section>
```

**(b) Nav button** — insert in `.slider#slider` **before** `</nav>` (line 288):

```html
<button type="button" data-i="3">chorus</button>
```

The slider's segmented pill (`.seg-pill`) auto-sizes to the button count via `syncPill`, so
no extra pill markup is needed.

### 6.2 `apt.js`

**(a) Title** — `VIEW_TITLES` (line 67):

```js
var VIEW_TITLES = ['Heard Recently', 'Heard Recently', 'Avian Visitors', 'The Last Twelve Hours'];
```

**(b) `go()` clamp** (line 96): `Math.min(2, i)` → `Math.min(3, i)`.

**(c) `go()` entrance branch** (after line 111):

```js
else if (i === 3) playChorusEntrance(SWITCH_LEAD);
```

**(d) Hide the global window picker on chorus** (chorus owns its own time controls). Inside
`go()`, after `setTitleForView(i);` (line 105):

```js
if (winPick) winPick.hidden = (i === 3);   // chorus is fixed 12h; its own controls live in-view
```

(Confirm desired; if the picker should stay, drop this line.)

### 6.3 View-wiring checklist (don't miss one)

- [ ] `index.html`: `<section id="v3">` added inside `.views`
- [ ] `index.html`: `<button data-i="3">chorus</button>` added inside `.slider`
- [ ] `apt.js`: `VIEW_TITLES` has a 4th entry
- [ ] `apt.js`: `go()` clamp is `Math.min(3, i)`
- [ ] `apt.js`: `go()` has an `i === 3` entrance branch
- [ ] `apt.js`: winPick hidden on `i === 3` (if keeping that decision)
- [ ] `apt.js`: `DATA.chorus` declared + fetched in `refreshAll()` (§7)
- [ ] `apt.js`: `drawChorus()` defined + called from the time-independent render path (§7)
- [ ] `apt.js`: `playChorusEntrance()` defined (§10.4)
- [ ] `styles.css`: `.chorus-*` styles added (§11)

---

## 7. Frontend — data integration

### 7.1 State + fetch

`DATA` is the central cache (declared ~line 948 per exploration; near `recent/hourly/rhythm`).
Add:

```js
// in the DATA object:
chorus: null,
```

Chorus is **window-independent** (always 12h) but **interval-dependent** (a client control).
Keep a small bit of view state near the other view state:

```js
var chorusInterval = +readLS('bird:chorusInterval', '30') || 30;   // 30 | 60
var chorusMode     = readLS('bird:chorusMode', 'volume');          // 'volume' | 'mix'
var chorusVariety  = readLS('bird:chorusVariety', '1') === '1';    // show variety line
```

Fetch helper (mirror the existing `api()`/fetch usage — base URL is `window.AVIAN_API_BASE`
from `config.js`; **send a `User-Agent`-safe request** — browsers set UA automatically, so
the CLAUDE.md "set a User-Agent" gotcha only bites ad-hoc scripts, not this fetch):

```js
function fetchChorus() {
  var u = API_BASE + '/api/chorus?hours=12&interval=' + chorusInterval;
  return fetch(u).then(function (r) { return r.json(); })
                 .then(function (j) { DATA.chorus = j; });
}
```

### 7.2 Hook into `refreshAll()` and polling

`refreshAll(animate)` (line ~1684) fetches everything and is also the 30 s poll
(`startPolling` → `refreshAll()`; pauses when `document.hidden`). Add `fetchChorus()` to its
parallel fetch set, and render it from the **time-independent** path (`renderTimeIndependent`,
line ~1660 — chorus ignores the window picker, like rhythm):

```js
// inside refreshAll's Promise.all([...]) list, add: fetchChorus()
// inside renderTimeIndependent(animate): drawChorus(animate);
```

Because rendering reads from `DATA.chorus`, the 30 s poll keeps the river live with no extra
code. Guard `drawChorus` against `DATA.chorus == null` (first paint) — render nothing/empty.

### 7.3 Interval change = refetch; mode/variety = pure re-render

- Changing **interval** changes `n_bins`, so it must **refetch**: update `chorusInterval`,
  `writeLS`, then `fetchChorus().then(function(){ drawChorus(true); })`.
- Changing **mode** or **variety** is a client transform — just `drawChorus(true)` (no fetch).

---

## 8. Frontend — the renderer (`drawChorus`)

### 8.1 Rendering approach (match the codebase)

Charts here are **hand-rolled inline SVG built by pushing strings into an array, then
`host.innerHTML = s.join('')`** — no charting library. The **Day Rhythm** chart already has
exactly the spline we need; **reuse its `smoothPath(pts)`** (Catmull-Rom → cubic Bézier,
tension 1/6) for the ribbon boundaries. Floating illustrations are **DOM `<img>` overlaid on
the SVG** (positioned absolutely), mirroring how collage tiles work (so the existing
`illustrations → cutouts` `onerror` fallback applies for free).

Layout: an SVG (`viewBox="0 0 W H"`, responsive width) inside `#chorusStage`, plus an
absolutely-positioned `.chorus-birds` overlay `<div>` for the floating illustrations and a
`.chorus-tip` scrub readout (a DOM div, like `.dial-tip`/`.rhythm-readout`).

### 8.2 Streamgraph math (pseudocode)

```
CH = DATA.chorus; N = CH.n_bins; sp = CH.species; totals = CH.totals_by_bin
geometry: plotL, plotR, plotW = plotR-plotL; plotT, plotB; midY = (plotT+plotB)/2
xForBin(i) = plotL + ((i + 0.5) / N) * plotW        // bin centers
            (also anchor endpoints at x=plotL for i=-0.5 and x=plotR for i=N-0.5)

// 1) value per species per bin, honoring mode:
val(s, i):
  if mode == 'volume': return s.bins[i]
  if mode == 'mix':    return totals[i] ? s.bins[i]/totals[i] : 0   // fraction of that bin

// 2) y-scale:
if mode == 'volume':
  maxTotal = max(totals); yScale = (plotB - plotT) * 0.62 / max(1, maxTotal)   // headroom for birds
else:
  yScale = (plotB - plotT) * 0.62                                              // stack sums to 1

// 3) species order — "inside-out" by peak_bin for a clean streamgraph
//    (MVP: stable order by peak_bin asc; nicer: alternate sides Byron–Wattenberg)
order = sp sorted by peak_bin asc (tiebreak total desc)

// 4) baseline g0(i): centered streamgraph
//    MVP stacked-area: g0(i) = plotB (flat bottom) — build this FIRST.
//    Streamgraph:      g0(i) = midY + 0.5 * stackHeight(i) * yScale  (center the stack on midY)
stackHeight(i) = sum over order of val(s,i)

// 5) build each ribbon as a closed area:
for each species s in order:
  topPts = []; botPts = []
  for i in 0..N-1:
    x = xForBin(i)
    bottomY = runningOffset(i)                 // starts at g0(i), grows "up" (decreasing y)
    topY    = bottomY - val(s,i) * yScale
    botPts.push([x, bottomY]); topPts.push([x, topY])
    runningOffset(i) = topY                     // next species stacks above
  // smooth + close: top L→R, then bottom R→L
  d = smoothPath(topPts) + lineTo(last bot) + smoothPathReversed(botPts) + 'Z'
  push <path class="chorus-ribbon" data-sci=... fill=color(s.sci) />
  push <path class="chorus-crest"  d=smoothPath(topPts) stroke=darker(color) />  // crest line
```

Add edge anchors (a point at `x=plotL` and `x=plotR` equal to the nearest bin's y) so ribbons
meet the panel edges cleanly instead of starting half a bin in.

**Reuse note:** `smoothPath` is defined inside the rhythm renderer's scope. Either lift it to
a shared helper (preferred — small, pure) or copy it. Lifting it is in-scope cleanup; if you
lift it, leave the rhythm call site working (point it at the shared one).

### 8.3 Overlays

- **Variety line** (if `chorusVariety`): polyline through `[xForBin(i), map(variety[i])]`,
  scaled to its own max into the top ~20% strip, drawn as a thin dotted ink stroke
  (`.chorus-variety`) with a tiny end-label "variety." Smooth with `smoothPath`. Toggleable.
- **Daylight band**: for each bin, local hour = parse `bin_starts[i]`'s `HH`; day if
  `sun && sunrise <= hour <= sunset`. Draw faint background rects (`.chorus-daylight` for day,
  default paper for night) behind the stream — same visual weight as `.rhythm-daylight`.
  Omit if `sun == null`.
- **"Now" edge**: a vertical hairline + "now" label at `x = plotR` (window ends at now).
  Optionally a "12h ago" label at `x = plotL`.
- **Axis**: a few time ticks (e.g., every 4th bin at 30 min = every 2h) labeled from
  `bin_starts` in mono caps (reuse `.dial`/`.rhythm` label styling).

---

## 9. Frontend — weaving the illustrations in (the creative core)

This is the steer: *use the bird art as the graphic, not decoration.*

- **Float each species' illustration at its ribbon's peak.** For species `s`: x = `xForBin(s.peak_bin)`; y = the **mid-height of that species' ribbon at `peak_bin`** (average of its top/bottom boundary there). Render a DOM `<img>` in the `.chorus-birds` overlay positioned at that (x,y), translated to center on the point.
- **Pose by volume (exploit the two poses).** Illustrations come in perched (`<slug>.png`) and
  flight (`<slug>-2.png`). Use **flight** for the busiest species (e.g., top quartile by
  `total`, or `total ≥ someThreshold`) and **perched** otherwise — so the loud birds look
  like they're *in flight over their wave*. Load via the existing `avImg(sci, pose)` helper:

  ```js
  var pose = (s.total >= flightThreshold) ? 2 : 1;
  var img = avImg(s.sci, pose);   // → './assets/illustrations/<slug>[-2].png', cutouts fallback on error
  ```

- **Size by volume.** `size = clamp(minPx, k * sqrt(s.total), maxPx)` (sqrt so one very loud
  species doesn't dwarf everything). Apply the collage tile look: `object-fit:contain` +
  `drop-shadow` (reuse `.gtile img` recipe) so the transparent bird reads on any ribbon.
- **Art-less species:** `avImg` will 404 → the `onerror` chain tries cutouts → may also miss.
  Detect "no art" and **skip the floating bird**, keep the ribbon + a small text label
  (`com`) at the crest instead. (Probe by the same mechanism the rest of the site uses; do
  **not** trust HTTP status — Cloudflare Pages serves a 200 HTML fallback for a missing
  `.png`, per CLAUDE.md. Simplest robust check: `img.onerror` after the cutouts fallback →
  hide the img + show the text label.)
- **Collision/overlap:** peaks can cluster. MVP: allow gentle overlap (it reads as a flock)
  and raise the hovered/active bird's `z-index`. Enhancement: nudge labels/birds vertically
  when two peaks share a bin (simple greedy de-overlap on x-proximity).
- **Tap a bird → open its modal** (reuse the existing `data-sci` → bird-modal click path the
  collage/atlas use), and/or isolate its ribbon (§10.3). Wiring `data-sci` on both the ribbon
  `<path>` and the floating `<img>` gets you the existing modal for free.

---

## 10. Frontend — controls & interactivity

Reuse the established **segmented-pill** control pattern (`.seg-pill` + `data-*` buttons +
`aria-current` + `syncPill`/`segmentedPillMove`), the same as `#statsChartToggle` /
`#atlasSort`. Persist choices in `localStorage` (`bird:chorus*`).

### 10.1 Interval pill (`30 min` / `1 hr`)
On click: set `chorusInterval`, `writeLS`, move pill, `fetchChorus().then(()=>drawChorus(true))`.

### 10.2 Mode pill (`volume` / `mix`)
On click: set `chorusMode`, `writeLS`, move pill, `drawChorus(true)` (no refetch). "mix"
normalizes each bin to 100% → shows **composition shifts** (who dominates the chorus) rather
than absolute loudness. A genuinely different read on the same data = "depth."

### 10.3 Tap-to-isolate
Tap a ribbon or its bird → add `.is-active` to that ribbon, dim others (CSS opacity), enlarge
that bird, fade the rest. Tap empty space (document handler, same guard pattern as
`wireDialHover._outsideWired`) → reset. Keep it lightweight; don't refetch.

### 10.4 Scrub readout (the precision layer)
Mirror the **Day Rhythm scrubber** exactly (`wireRhythmScrub`): on `mousemove`/`touchmove`
over the SVG, convert `clientX` → viewBox x via `getBoundingClientRect()`, map to a bin,
draw a vertical scrub line, and show a DOM tooltip (`.chorus-tip`) listing that bin's time
range (from `bin_starts`) + top species with **counts and tiny illustration thumbnails**.
Touch + mouse share the handler; `{passive:true}` listeners; outside-tap dismiss.

### 10.5 Variety-line toggle (optional, keep controls minimal)
Either a third tiny pill or fold it into the scrub readout only. Default **on**. If it makes
the control bar busy on mobile, show the variety line always and drop the toggle.

### 10.6 Entrance animation (`playChorusEntrance(lead)`)
Match the site's entrance vocabulary (≈420–480 ms, `cubic-bezier(.2,.7,.3,1)`, staggered).
Nice options: ribbons "rise" (translateY + fade, staggered by stack order) like
`rhythm-rise`, then birds fade/scale in (staggered by x) after the ribbons settle. Respect
`@media (prefers-reduced-motion: reduce)` → no animation (add `.chorus-*.entering` to the
existing reduced-motion block).

---

## 11. Styling (`styles.css`)

### 11.1 Conventions
One monolithic stylesheet (~1780 lines). Class prefix **`chorus-`**. Use the CSS custom
properties (`--paper`, `--paper-2`, `--ink`, `--ink-2`, `--ink-soft`, `--hairline`,
`--accent`) so light/dark themes work automatically. Watch specificity (the project has been
bitten: scope chorus selectors under `.chorus-wrap`/`#v3` where needed, and remember
`[hidden]` needs `display:none !important` if a more specific rule sets display).

### 11.2 Classes to define
`.chorus-wrap`, `.chorus-controls`, `.chorus-interval`/`.chorus-mode` (clone
`.stats-chart-toggle` styling), `.chorus-stage` (position:relative; holds SVG + overlay),
`.chorus-svg`, `.chorus-ribbon` (transition fill-opacity/opacity for hover), `.chorus-crest`,
`.chorus-birds` (absolute overlay, `pointer-events:none`; children re-enable), `.chorus-bird`
(img: object-fit contain + drop-shadow, like `.gtile img`), `.chorus-variety`,
`.chorus-daylight`, `.chorus-now`, `.chorus-axis`, `.chorus-tip`, `.chorus-empty`,
`.chorus-ribbon.is-active` / `.chorus-wrap.has-active .chorus-ribbon:not(.is-active)` (dim).

### 11.3 The ribbon palette (flagged palette extension)
The site is near-monochrome; ribbons must be distinguishable, so add a **small curated muted
palette** (low-saturation, earthy/watercolor — harmonizes with the illustrations). Assign
**stably per species** by hashing `sci` so a bird keeps its color across renders/sessions.

```css
/* muted "field watercolor" ribbon palette — low saturation on purpose */
:root{
  --ch-1:#b9836f; --ch-2:#c9a25a; --ch-3:#8a9a5b; --ch-4:#7faa8e;
  --ch-5:#6f8aa8; --ch-6:#c08aa0; --ch-7:#9a8f4f; --ch-8:#9a8e7e;
  --ch-9:#8c7194; --ch-10:#88a7bd; --ch-11:#a96a4f; --ch-12:#7d9a86;
}
.chorus-ribbon{ fill-opacity:.55; transition:opacity .18s ease, fill-opacity .18s ease; }
.chorus-crest{ fill:none; stroke-width:1.1; opacity:.55; }
```

```js
// stable per-species index into --ch-1..12
function chorusHue(sci){ var h=0; for(var i=0;i<sci.length;i++){ h=(h*31+sci.charCodeAt(i))>>>0; } return (h%12)+1; }
// fill = getComputedStyle(root).getPropertyValue('--ch-'+chorusHue(sci))   (read at render, like the spectro code does)
```

Reserve a neutral `--ink-soft`-ish fill for the **"others"** ribbon. Flag in the PR: this is a
deliberate, minimal departure from the strict mono palette, justified by legibility and kept
desaturated to stay on-brand.

### 11.4 Optional upgrade — tints from the art
Since illustrations are **same-origin** on Pages, you *can* sample each PNG's average color on
a hidden `<canvas>` (no CORS taint) and tint each ribbon to match its bird — beautiful and
maximally coherent. Costs an async pass + caching. **Default to the curated palette (§11.3);**
note this as a follow-up.

### 11.5 Dark mode
The §11.3 mid-tones read on charcoal but may look muddy. Provide a parallel dark palette under
`:root[data-theme="dark"]` (lift lightness ~12–18%, keep low saturation) or bump
`fill-opacity`. Verify both themes (the site flips via `data-theme` on `<html>`).

### 11.6 Responsive / mobile
Reuse the breakpoints (`max-width:900px` stacks; `700px`/`420px` shrink). On phones: increase
vertical room per ribbon, shrink/auto-thin floating birds (or cap how many float — e.g. top 8
by volume), ensure controls wrap, and honor `env(safe-area-inset-*)`. Touch handlers for the
scrubber (§10.4). The site had a mobile pass — match it (hover vs pointer media, no hover-only
affordances).

---

## 12. Build, run, deploy

**Local preview (frontend):** the shell is static; serve `avian/frontend/` (or the built
`_site/`) and point `config.js`'s `AVIAN_API_BASE` at the live worker (or a local one).

**Local worker:** `cd worker && wrangler dev` against a local D1. Seed a local DB with a
spread of detections across the last 12h (several species, varied counts per 30-min bin,
include at least one art-less species and one very-loud species) so the river has shape. Hit
`http://localhost:8787/api/chorus?hours=12&interval=30` and eyeball the JSON.

**Deploy worker:** `cd worker && wrangler deploy` (publishes `chorus()`).

**Deploy site:** from repo root `bash avian/build-site.sh` (assembles `_site/` — already
copies `illustrations/`), then **from `worker/`** so the local wrangler resolves:
`wrangler pages deploy ../_site --project-name barrysbirds --branch production`
(per CLAUDE.md; project was renamed `avianvisitors`→`barrysbirds`). No new assets to add —
illustrations already ship.

**Order:** deploy the **worker first** (so `/api/chorus` exists), then the **site**.

---

## 13. Testing & verification

- **Endpoint shape:** `curl` the live/dev `/api/chorus` (curl is exempt from the
  Python-urllib UA 403 gotcha). Verify `n_bins` matches `12*60/interval`, array lengths ==
  `n_bins`, `bin_starts` land on `:00/:30`, `totals_by_bin[i] == Σ species.bins[i] (+others)`.
- **Interval switch:** 30↔60 changes `n_bins` 24↔12 and the river re-bins.
- **Mode switch:** "mix" makes every bin full-height (constant total thickness); "volume"
  restores real heights.
- **Quiet window:** seed a 12h window with near-zero calls → river collapses to a thin thread,
  empty state shows if truly zero. No NaN paths (guard divide-by-zero in `mix`).
- **One dominant species:** river is mostly one ribbon; its bird floats large in flight pose.
- **Many species:** > `top` species → "others" ribbon carries the remainder; totals still
  reconcile.
- **Art-less species:** ribbon renders; no floating bird; text label at crest; no broken-img.
- **Midnight crossing:** a window spanning midnight labels two dates correctly (the night band
  + dawn swell land in the right place).
- **Scrub:** desktop hover and mobile drag both read the correct bin; tooltip counts match the
  ribbon thickness there.
- **Carousel:** the existing collage/stats/atlas still slide correctly with a 4th view; nav
  pill sizes to 4; titles swap; window picker hides on chorus and returns on others.
- **Dark mode + mobile (real iPhone spot-check):** palette legible; birds not clipped;
  controls wrap; safe-area respected.
- **Reduced motion:** entrance animation suppressed.

A quick **screenshot diff** against the ASCII intent (wide dawn, thin night, birds on crests)
is the fastest "does it feel right" check. Optionally use the `verify`/`run` skills to drive
the site and capture the chorus view.

---

## 14. Edge cases & gotchas (collected)

- **Pages 200-HTML fallback for missing `.png`** → never probe art by HTTP status; rely on
  `img.onerror` (the site already does this for the illustrations→cutouts chain).
- **Cloudflare 403s the default Python-urllib UA** → any ad-hoc test/monitor script must set a
  `User-Agent`; browsers and curl are fine.
- **`[hidden]` specificity** → if a chorus rule sets `display`, `[hidden]` may lose; use
  `[hidden]{display:none !important}` or scope carefully (documented site gotcha).
- **Divide-by-zero in "mix"** when a bin has zero detections → guard (`totals[i] ? … : 0`).
- **`translateX(-i*100%)` scales** to a 4th view automatically (each `.view` is `flex:0 0
  100%`); no carousel math change needed — but **do** bump the `go()` clamp to `min(3,i)`.
- **Window-independence:** chorus must fetch on the poll/`refreshAll`, **not** on the window
  picker (it ignores the picker — that's why we hide it on this view).
- **Fixed tz offset** (`-4`): bins are Eastern-DST-correct in summer; in winter they'd be 1h
  off (known, accepted site-wide). Fine for a "feel of the day" view.
- **Don't regress the other views:** the only shared edits are `VIEW_TITLES`, `go()`, and the
  `refreshAll` fetch set — keep them additive.
- **smoothPath reuse:** if you lift it out of the rhythm closure, keep the rhythm call working.

---

## 15. Milestones (build in this order)

1. **M1 — Endpoint.** Add `chorus()` + routing; `wrangler dev`; verify JSON against §13.
   *(Backend done, independently testable.)*
2. **M2 — Tab + stacked-area MVP.** Wire `#v3`/nav/`go()`/`refreshAll`; render a **flat-baseline
   stacked area** (no streamgraph yet), single ink fill, no birds. Confirm data → pixels and
   the carousel/nav/title all behave.
3. **M3 — Streamgraph + color + birds.** Swap baseline to centered; add the per-species palette;
   float illustrations at peaks with pose-by-volume + sizing; "others" ribbon; daylight band +
   now edge + axis.
4. **M4 — Interactivity.** Interval + mode pills (persisted), tap-to-isolate, scrub readout,
   variety line (+ toggle).
5. **M5 — Polish.** Entrance animation, dark-mode palette, mobile/responsive + real-iPhone
   check, reduced-motion, empty/quiet states, de-overlap nudge for clustered birds.
6. **M6 — Ship.** Deploy worker → build site → `wrangler pages deploy`. Optional: add a
   one-line pointer to this doc in `CLAUDE.md`'s Status section, and a memory note that the
   chorus tab shipped (mirroring the daydial/rhythm memory entries).

Each milestone is shippable; M2 alone already adds a working (if plain) tab.

---

## 16. Definition of done

- A **`chorus`** tab sits beside collage/stats/atlas; tapping it slides to the view and
  replays an entrance.
- It shows the **last rolling 12h** as a centered, smooth **streamgraph**: river width = total
  activity, ribbon thickness = per-species volume per interval, with **watercolor
  illustrations floating at each species' peak** (flight pose for the loud, perched for the
  quiet).
- **Variety** is legible (ribbon count/colors + the variety line); **volume at intervals** is
  legible (thickness + scrub readout with exact counts).
- Controls work and persist: **interval** (30m/1h, refetches), **mode** (volume/mix),
  **tap-to-isolate**, **scrub**.
- It updates itself (~30 s poll), is **window-picker–independent**, matches the **paper/ink +
  watercolor** aesthetic, works in **light/dark** and on **mobile**, and honors
  **reduced-motion**.
- The other three views are unchanged. Backend is one read-only endpoint; no Pi/D1-schema
  changes.

---

*Plan authored 2026-06-23. Anchors (file:line) verified against the working tree at authoring
time — re-confirm if `apt.js`/`index.js` have since shifted.*
