# STATS-DAYDIAL-PLAN.md

Implementation plan: add a **rolling 24-hour "Day Dial"** to the stats screen as the new
default chart, with a toggle to swap back to the existing per-species timeline.

> **Status:** design complete, not yet built. This doc is self-contained — a cold-start
> session should be able to execute it reading only this file plus the anchors it cites.
> Scope is the public collage frontend (`avian/frontend/`) + one small `avian-worker`
> endpoint. **No Pi change.** Past detections render retroactively (the dial is pure
> read-side), so this is safe to ship anytime.

---

## 1. Plain English Summary (for a non-technical reader)

The stats page today shows one chart: a row of little black squares, one per bird species,
arranged left-to-right by when each was last heard. It answers *"which birds, and how many?"*

We're adding a second chart and making it the **default**: a round, clock-like **"Day Dial"**
that shows the **last 24 hours** of bird activity laid out around a 24-hour clock face —
midnight at the top, noon at the bottom. Each hour of the day gets a "petal" pointing
outward; the busier that hour was, the longer the petal. Behind the petals, the part of the
clock that was **daytime** (between sunrise and sunset) is gently shaded lighter, and a thin
hand points at the current time. At a glance you can see the **rhythm of a day**: the big
dawn-and-morning chorus, the midday lull, the evening quiet — and how that shape shifts as
the days roll by.

A small two-way switch (styled exactly like the existing "sort" switch on the atlas page)
lets you flip between the new Day Dial and the original species timeline. Your choice is
remembered. The dial respects the page's existing time-window buttons (1H / 12H / 24H / 7D /
ALL), so at the default **24H** it's the literal "rolling last day," and at 7D/ALL it shows
the *typical* daily rhythm averaged over more data.

What you'll notice: open stats → you immediately see a beautiful field-guide-style activity
clock instead of a bar row, and you can toggle back whenever you want.

**Real data already supports this.** The live box (deployed 2026-06-19, Sudbury MA) shows a
clear arc today: ~46 detections at 4am, climbing to a **200-detection peak at 1pm**, falling
off sharply after 3pm, near-silent overnight. The dial will make that shape legible instantly.

---

## 2. Exact requirement (from the request)

- Add more to the stats screen.
- New **default** chart = a **rolling 24-hour period** with detection data **overlaid** onto
  it, to see "how bird calls are detected over the course of a rolling 24 hours" / "how it
  changes over the course of a day."
- **Keep** the existing chart; add a **toggle** to swap between them. The time-based one is
  the default.
- Build it in a **cool, accurate, artistic** way that **fits the existing aesthetic**.
- Completion = this implementation plan. (Design freedom was explicitly granted; §4 records
  the decisions taken so a builder doesn't have to re-derive them.)

---

## 3. The design — "The Day Dial"

A **24-hour radial histogram** (a polar "rose" / record-wheel). Pure inline **SVG** (no chart
library — the codebase has none and we keep it that way), so it inherits CSS custom
properties and themes automatically (light/dark) and matches the existing hand-drawn,
`stroke="currentColor"` SVG-icon idiom.

```
                       12a  (midnight, top)
                 ·  ·  · | ·  ·  ·
            ·      [ night wash ]      ·            ← outer band: daylight arc
         ·     \         |         /     ·            (sunrise→sunset shaded light,
       9p       \   ·    |    ·   /       3a           night left subtle/darker)
        ·    ☾   \    \  |  /    /   ☀ sunrise
        |         \    \ | /    /  ╱╱        |
   6p ──┤   ·      ·   \\|//  ╱╱▔▔  ·        ├── 6a   ← petals: length = detections
        |               (●now)   ▔▔▔         |          that clock-hour. dawn/morning
        ·         ·    ╱╱ | ▔▔▔▔▔     ·      ·          petals long, overnight ~0.
         ·     ╱╱╱▔▔▔▔   |    ▔▔▔▔╲      ·
            ▔▔▔▔   1,399 │           ▔▔▔
                 ·  24H heard ·                       ← center readout: total + window
                       12p  (noon, longest petals = midday peak)
```

**Mechanics**
- **Angle = time of day.** 24 wedges, 15° each. **Midnight at top, clockwise** (→ 6a right,
  12p bottom, 6p left). Intuitive "clockwise = forward in time," and it pins the dawn chorus
  to a fixed spot so day-over-day change is visible in place.
- **Radius = count.** Petal for hour *h* extends from inner radius `r0` to
  `r0 + (n_h / maxN)·(r1 − r0)`. Empty hours render as a whisper (so the ring reads continuous).
- **Daylight overlay** ("overlaid onto it"): an outer band shaded light across the
  sunrise→sunset arc, subtly darker at night. This is the artistic centerpiece — the
  dawn-chorus petals visibly cluster at first light. Sunrise/sunset are computed server-side
  for Sudbury and returned as fractional local hours (§5). Degrades gracefully: if `sun` is
  null the band is omitted and the dial still works.
- **"Now" hand**: a thin `--ink` radial line + tip dot at the current **Sudbury-local** time
  (returned by the Worker, not the viewer's clock — see §5/§9 gotcha). Makes the rolling/live
  nature visible; it sweeps as polling updates. The current (in-progress) hour's petal renders
  **outlined** (dashed stroke, no fill) to signal "partial."
- **Center**: total detections in the window (`fmtNK`, already in apt.js:831) + window label
  (`windowLabel`, apt.js:838).
- **Monochrome, on purpose.** Ink-on-paper only — **no species color-coding** (rainbow is
  off-brand for this field-guide palette). Per-hour species composition is revealed on
  **hover/tap** in a tooltip pill (`--raised`), listing that hour's count + top 2–3 species
  (serif names), mirroring the timeline's existing hover behavior.
- **Window-aware.** Bins by **clock hour** over the currently selected window. At **24H**
  (default) each clock hour appears once → the literal rolling day. At 7D/ALL each clock hour
  aggregates multiple days → the typical rhythm. Reuses the existing window picker; no new
  windowing control.

**Why radial (not a linear ridgeline):** cyclical time reads truthfully on a circle (23:00→00:00
is adjacent, not a chart edge), it's distinctive and "record-wheel" in spirit, and the daylight
arc only makes sense radially. A linear area chart is the documented fallback if the radial
math proves fussy (§12), but radial is the intended build.

---

## 4. Decisions taken (so you don't re-litigate)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Radial 24h dial, inline SVG, no library | Matches no-dependency codebase + field-guide aesthetic; themes via CSS vars |
| D2 | Default = dial; toggle clones `.atlas-sort` segmented control | Requirement; reuse existing, tested pattern (`syncPill`/`wireToggleAdvance`/`readLS`) |
| D3 | Bin by **clock hour**, honor the existing window picker; 24H = default | Satisfies "rolling 24h" at default, generalizes to 7D/ALL for free |
| D4 | **New Worker endpoint** `/api/hourly?hours=N` (rolling, per-hour, zero-filled, + top species) | No existing endpoint gives rolling-window hourly data (recent = per-species; timeseries.by_hour = fixed 30-day). This is the only backend change. |
| D5 | Worker is the single source of truth for **tz / now / sunrise-sunset** (returns local fractional hours) | Viewer's browser may be in any timezone; the dial is about Sudbury local time |
| D6 | Monochrome; species shown on hover, not by color | Palette is ink-on-paper; rainbow would break aesthetic |
| D7 | Daylight arc is **optional / graceful-degrade** | De-risks the astronomical calc; dial ships even if `sun:null` |
| D8 | Persist choice in `localStorage` key `bird:statsChart` (default `'dial'`) | Mirrors `bird:window`, `bird:atlasSort`, `bird:theme` |

---

## 5. Backend — the one new endpoint (`avian-worker`)

**File:** `worker/src/index.js`. **No D1 migration needed** (reads the existing `detections`
table). Add config (lat/lon) to `worker/wrangler.toml`.

### 5.1 Route registration
In `queryApi()` (apt anchor: the `const known = [...]` array, ~line 281), add `'hourly'`:
```js
const known = ['recent', 'stats', 'lifelist', 'timeseries', 'species', 'firstseen', 'hourly'];
```
In the `switch (action)` (~line 288) add:
```js
case 'hourly': return hourly(env, url, tz, now);
```
This makes it reachable as both `/api/hourly?hours=24` and (matching the frontend's existing
call style) `/api/birdnet-api.php?action=hourly&hours=24`.

### 5.2 The handler
Add near `timeseries()` (~line 357). One grouped query → reduce to 24 zero-filled bins with
per-hour totals, distinct-species count, and top-3 species:
```js
async function hourly(env, url, tz, now) {
  const hours = clampInt(url.searchParams.get('hours'), 24, 1, 1000000);
  const since = now - hours * 3600;

  // hour (local clock) × species counts in the rolling window.
  const { results } = await env.DB.prepare(
    `SELECT CAST(strftime('%H', ts, 'unixepoch', ?) AS INT) AS hour,
            sci, com, COUNT(*) AS n
       FROM detections
      WHERE ts >= ?
      GROUP BY hour, sci
      ORDER BY hour, n DESC`
  ).bind(tz, since).all();

  const bins = Array.from({ length: 24 }, (_, h) => ({
    hour: h, detections: 0, species: 0, top: [],
  }));
  for (const r of (results || [])) {
    const b = bins[r.hour];
    b.detections += r.n;
    b.species += 1;
    if (b.top.length < 3) b.top.push({ com: r.com, sci: r.sci, n: r.n });
  }
  const total = bins.reduce((s, b) => s + b.detections, 0);
  let peakHour = null, peakN = -1;
  for (const b of bins) if (b.detections > peakN) { peakN = b.detections; peakHour = b.hour; }

  // tz-correct "now" and sun, in Sudbury-local fractional hours (see D5).
  const offH = parseInt(env.TZ_OFFSET_HOURS ?? '0', 10) || 0;
  const localNow = new Date((now + offH * 3600) * 1000);
  const now_local = {
    hour: localNow.getUTCHours(),
    minute: localNow.getUTCMinutes(),
    frac: localNow.getUTCHours() + localNow.getUTCMinutes() / 60,
  };
  const sun = sunArc(env, localNow, offH); // {sunrise, sunset} local frac hours, or null

  return json({
    hours, total, peak_hour: peakHour,
    tz_offset_hours: offH, now_local, sun,
    bins, as_of: new Date().toISOString(),
  });
}
```

### 5.3 Sunrise/sunset (`sunArc`) — optional, graceful-degrade
Standard sunrise equation. Add lat/lon to `wrangler.toml` `[vars]` (Sudbury MA defaults
`SITE_LAT = "42.385"`, `SITE_LON = "-71.417"`). Returns local fractional hours, or `null`
if lat/lon are unset/invalid (band omitted client-side).
```js
function sunArc(env, localNow, offH) {
  const lat = parseFloat(env.SITE_LAT), lon = parseFloat(env.SITE_LON);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const Y = localNow.getUTCFullYear(), M = localNow.getUTCMonth() + 1, D = localNow.getUTCDate();
  const rad = Math.PI / 180, deg = 180 / Math.PI;
  const a = Math.floor((14 - M) / 12), y = Y + 4800 - a, m = M + 12 * a - 3;
  const JDN = D + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4)
            - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
  const n = JDN - 2451545.0 + 0.0008;
  const Jstar = n - lon / 360;                       // NOTE: lon EAST-positive; -71.4 for Sudbury
  const Msun = (357.5291 + 0.98560028 * Jstar) % 360;
  const C = 1.9148 * Math.sin(Msun * rad) + 0.02 * Math.sin(2 * Msun * rad)
          + 0.0003 * Math.sin(3 * Msun * rad);
  const lambda = (Msun + C + 282.9372) % 360;
  const Jtransit = 2451545.0 + Jstar + 0.0053 * Math.sin(Msun * rad)
                 - 0.0069 * Math.sin(2 * lambda * rad);
  const decl = Math.asin(Math.sin(lambda * rad) * Math.sin(23.4397 * rad));
  const cosH = (Math.sin(-0.833 * rad) - Math.sin(lat * rad) * Math.sin(decl))
             / (Math.cos(lat * rad) * Math.cos(decl));
  if (cosH > 1 || cosH < -1) return null;            // polar day/night
  const Hd = Math.acos(cosH) * deg / 360;
  const toLocalFrac = (J) => {
    const utcHours = ((J - Math.floor(J - 0.5) - 0.5) * 24); // J → hours past UTC midnight
    return ((utcHours + offH) % 24 + 24) % 24;
  };
  return { sunrise: toLocalFrac(Jtransit - Hd), sunset: toLocalFrac(Jtransit + Hd) };
}
```
> **⚠ VERIFY before trusting the band.** For `SITE_LAT=42.385, SITE_LON=-71.417`, date
> 2026-06-20, `TZ_OFFSET_HOURS=-4` (EDT), this must yield **sunrise ≈ 05:08, sunset ≈ 20:24**
> local. If it's shifted by the longitude or flipped AM/PM, the `lon` sign or the `toLocalFrac`
> Julian→hours step is off — fix there. If you don't want to risk it on the critical path,
> ship with `SITE_LAT/LON` unset (`sun:null`, no band) and add the arc in a follow-up; the
> dial is fully functional without it.

### 5.4 Deploy the Worker
From `worker/`: `npx wrangler deploy`. (Add the two `[vars]` lines first.) Smoke-test:
```
curl -s -A "x/1" "https://avian-worker.s-friedman.workers.dev/api/hourly?hours=24" | python3 -m json.tool
```
Expect `bins` length 24 (zero-filled), `total` matching today's count, `now_local`, and `sun`.

---

## 6. Frontend — file map & exact anchors

All in `avian/frontend/`. Line numbers are from the current revision; **anchor on the quoted
strings/function names** (apt.js is ~803 KB and shifts).

### 6.1 `index.html` — markup (stats view is `#v1`, lines 82–109)
Restructure the left grid cell to hold a toggle + **both** chart containers. Replace the
single `<div class="stats-timeline" id="statsTimeline">…</div>` (lines 84–90) with:
```html
<div class="stats-charts">
  <div class="stats-chart-toggle" id="statsChartToggle" role="tablist" aria-label="chart type">
    <i class="seg-pill" aria-hidden="true"></i>
    <button type="button" data-chart="dial"     aria-current="true">day</button>
    <button type="button" data-chart="timeline">species</button>
  </div>
  <!-- Day Dial: 24h radial histogram (default). Rendered by drawDayDial(). -->
  <div class="stats-dial" id="statsDial"></div>
  <!-- Original editorial timeline. Rendered by drawHistograms(). -->
  <div class="stats-timeline" id="statsTimeline" hidden></div>
</div>
```
(Keep the existing explanatory comment near `#statsTimeline`. Note the stale reference in the
old comment to `renderStatsTimeline()` — the real fn is `drawHistograms()`.)

### 6.2 `apt.js` — data layer
- **`DATA` object (line 850):** add `hourly: null,` with a comment
  `// ?action=hourly&hours=N — per-clock-hour bins for the Day Dial (refetched on picker change)`.
- **`refreshRecent()` (lines 1363–1375):** it currently fetches only `recent`. Fetch `hourly`
  in parallel for the same window, guarding the same `forHours` staleness check:
```js
function refreshRecent(animate) {
  var forHours = currentHours;
  return Promise.all([
    fetchJson(AV_API + '/api/birdnet-api.php?action=recent&hours=' + forHours),
    fetchJson(AV_API + '/api/birdnet-api.php?action=hourly&hours=' + forHours).catch(function () { return null; }),
  ]).then(function (parts) {
    if (forHours !== currentHours) return;     // window changed mid-flight
    DATA.recent = parts[0];
    if (parts[1]) DATA.hourly = parts[1];
    renderWindowDependent(animate);
  }).catch(function (e) { console.warn('recent/hourly fetch failed', e); });
}
```
- **`refreshAll()` (lines 1376–1396):** add a 6th fetch and assignment:
```js
fetchJson(AV_API + '/api/birdnet-api.php?action=hourly&hours=' + forHours).catch(function () { return null; }),
// …in .then(parts):
if (forHours === currentHours && parts[5]) DATA.hourly = parts[5];
```

### 6.3 `apt.js` — render routing
- Add a router and use it everywhere `drawHistograms(animate)` is currently called
  (`renderWindowDependent` line 1353, `renderTimeIndependent` line 1359):
```js
function drawActiveStatsChart(animate) {
  var mode = window.__statsChart || 'dial';
  var dial = document.getElementById('statsDial');
  var tl = document.getElementById('statsTimeline');
  if (!dial || !tl) return;
  if (mode === 'dial') { tl.hidden = true; dial.hidden = false; drawDayDial(animate); }
  else                 { dial.hidden = true; tl.hidden = false; drawHistograms(animate); }
}
```
  Replace the two `drawHistograms(animate);` calls with `drawActiveStatsChart(animate);`.
  (Leave `drawHistograms` itself untouched — it stays the timeline renderer.)

### 6.4 `apt.js` — the dial renderer + interactions
Add `drawDayDial(animate)`, `wireDialHover(host, bins)`, and `playDialEntrance(host, lead)`
next to `drawHistograms` (~line 911). **Full reference implementation in Appendix A.** It
reuses existing helpers `fmtNK` (831) and `windowLabel` (838).

### 6.5 `apt.js` — the toggle wiring
Mirror the atlas-sort block (lines 169–185). Add after it:
```js
var statsChartEl = document.getElementById('statsChartToggle');
var statsChartBtns = statsChartEl ? [].slice.call(statsChartEl.querySelectorAll('button')) : [];
window.__statsChart = readLS('bird:statsChart', 'dial');
statsChartBtns.forEach(function (b) {
  b.setAttribute('aria-current', (b.dataset.chart === window.__statsChart) ? 'true' : 'false');
});
statsChartBtns.forEach(function (b) {
  b.addEventListener('click', function () {
    statsChartBtns.forEach(function (x) { x.setAttribute('aria-current', x === b ? 'true' : 'false'); });
    window.__statsChart = b.dataset.chart;
    writeLS('bird:statsChart', window.__statsChart);
    syncPill(statsChartEl);
    drawActiveStatsChart(true);   // re-render with entrance
  });
});
```
- Add `wireToggleAdvance(statsChartEl);` beside the others (line 190–191).
- Add `if (statsChartEl) syncPill(statsChartEl);` inside `syncAllPills()` (line 192) so the
  pill lands correctly after fonts/layout settle.

### 6.6 `apt.js` — view-switch entrance (line 106)
`go(i)` fires `playStatsEntrance(STATS_LEAD)` when switching to stats. Refactor so the
side-panel animation always runs and the **active** chart's entrance runs:
- Rename the chart-specific part. Simplest: keep `playStatsEntrance(lead)` for the **side
  panel only** (its `.stats-side` queries already cover that), and at line 106 call a small
  wrapper:
```js
else if (i === 1) { playStatsEntrance(STATS_LEAD); /* side panel */
                    drawActiveStatsChart(true); }  // re-draw active chart so its own entrance fires with animate
```
  …but `drawActiveStatsChart(true)` re-renders on every view-switch (cheap; data already in
  `DATA`). Alternatively split `playStatsEntrance` into `playStatsSideEntrance` +
  `playStatsTimelineEntrance` and have each renderer own its chart entrance (cleaner; the
  timeline already calls `playStatsEntrance()` at its end, line 1010 — narrow that to the side
  panel + timeline, and give the dial `playDialEntrance`). Pick one; the wrapper above is the
  low-risk option. **Verify both the dial and timeline animate on view-switch AND on
  window-picker change.**

### 6.7 `styles.css` — new rules
Append a `/* ===== Day Dial ===== */` block. Tokens in §8; full CSS in Appendix B. Key pieces:
- `.stats-chart-toggle` — clone `.atlas-sort` (line 804) recess track + `.seg-pill`; buttons
  carry **text** ("day"/"species") so style them like `.window-pick button` (line 117:
  10px ui-monospace, 0.18em, uppercase, `--ink-soft`→`--ink`). Place it top-left of the chart
  cell (the atlas toggle is top-right via `.atlas-controls`; for stats, left-align so it sits
  above the dial).
- `.stats-charts` — wraps toggle + both charts; `display:flex; flex-direction:column;`.
- `.stats-dial` — centers the SVG; `aspect-ratio:1; max-width: min(100%, 420px); margin:auto;`.
- `.dial-svg` child classes: `.dial-petal`, `.dial-petal.current`, `.dial-night`, `.dial-day`,
  `.dial-ring`, `.dial-spoke(.major)`, `.dial-suntick`, `.dial-now`, `.dial-now-dot`,
  `.dial-hlabel`, `.dial-total`, `.dial-total-lbl`, `.dial-tip` (hover pill).
- `@keyframes dial-petal-in` + `.dial-petal.entering` (scale from dial center via
  `transform-box:view-box; transform-origin:160px 160px`). Wrap motion in the existing
  `@media (prefers-reduced-motion: reduce)` guard (see line ~535 precedent).

---

## 7. Build order (each step independently testable)

1. **Worker endpoint** (§5.1–5.2, skip sun). Deploy. `curl …/api/hourly?hours=24` → 24 bins.
2. **Sun calc** (§5.3) + `wrangler.toml` vars. Re-deploy. Verify sunrise≈05:08/sunset≈20:24.
3. **Data wiring** (§6.2). Add `DATA.hourly`, extend the two fetchers. Confirm in DevTools that
   `DATA.hourly` populates on load, on window-picker change, and on the 30 s poll.
4. **Markup + toggle** (§6.1, §6.5) + minimal CSS so the segmented control renders and the pill
   slides. Toggle should flip `hidden` on the two (still-empty) containers.
5. **Dial renderer** (§6.3, §6.4, Appendix A) with petals + spokes + ring + center only (no
   sun, no now-hand). Get geometry right against live data (midday petals longest).
6. **Overlays**: daylight band, sun ticks, now-hand, current-hour outline.
7. **Interactions**: hover/tap tooltip (top species per hour); entrance animation (§6.6).
8. **CSS polish** (Appendix B): theme both light/dark, mobile sizing, reduced-motion.
9. **Build + deploy Pages** (§10). Verify on the live site + e-ink unaffected.

A reasonable first PR = steps 1–5 (functional dial, default). Steps 6–8 = a polish PR.

---

## 8. Aesthetic tokens to reuse (verbatim)

Light theme (auto-inverts in dark via `:root[data-theme="dark"]`):

| Token | Value | Dial use |
|---|---|---|
| `--paper` | `#fcfcfb` | page bg |
| `--paper-2` | `#f3f2ee` | recess track (toggle), night band fill |
| `--paper-3` | `#e8e6df` | night band / faint fills |
| `--ink` | `#1a1612` | petals, now-hand, center number |
| `--ink-2` | `#4a3f31` | secondary |
| `--ink-soft` | `#908576` | hour labels, ticks, window caption |
| `--accent` | `#4a3f31` | hovered petal |
| `--hairline` | `rgba(26,22,18,0.14)` | ring, spokes, gridlines |
| `--recess` | (see :root) | toggle track inset |
| `--raised` | (see :root) | sliding pill + hover tooltip |

Type: hour labels/ticks → `ui-monospace, "SF Mono", Menlo, monospace` (8px, `letter-spacing
.08–.18em`, uppercase for caps); species names in tooltip → `ui-serif, "Iowan Old Style",
Georgia, serif`. Strokes: 1px hairline. Motion: `cubic-bezier(.7,.05,.2,1)` (UI),
`cubic-bezier(.2,.7,.3,1)` (scale-in), ~320–360 ms; always honor `prefers-reduced-motion`.

---

## 9. Edge cases & gotchas

- **Zero-fill is mandatory.** Live `by_hour` omits silent hours (16–18, 21–22, 0–3 today).
  The endpoint already returns 24 bins; the renderer also defensively fills (Appendix A).
- **Timezone is server-authoritative (D5).** The dial is about *Sudbury* local time; the
  viewer's browser may be anywhere. **Never** use `new Date()` in the browser for angle
  placement — use `DATA.hourly.now_local` / `sun` / `tz_offset_hours` from the Worker.
- **Current hour is partial.** The newest clock-hour bin is "so far"; render its petal
  outlined (dashed, no fill) so it doesn't read as a real dip/peak.
- **Window < 24H.** At 1H/12H only a few hours are lit — expected and fine ("what time were
  these heard"). At 24H every hour appears once (rolling day). At 7D/ALL hours aggregate days.
- **Cloudflare 403s the default urllib/empty User-Agent.** Any ad-hoc probe of the Worker must
  send a `User-Agent` header (`curl` is fine; shipped `detection-forwarder.py`/`display.py`
  already set one). Cost a debug cycle on 2026-06-19 — see CLAUDE.md.
- **Pages serves a 200 HTML fallback for missing assets**, so verify deploys by content, not
  HTTP status. (Not directly relevant here — no new assets — but keep in mind.)
- **e-ink frame is unaffected.** `?frame=1` hides all chrome and pins the collage view (`#v0`);
  the dial lives in `#v1` and never renders in frame mode. Re-confirm `/frame.png` after deploy.
- **`fmtNK` / `windowLabel` already exist** (apt.js 831 / 838) — reuse, don't reinvent.
- **Toggle pill placement** needs `syncPill` after fonts load (text-sized buttons) — wire into
  `syncAllPills` and `document.fonts.ready` (already in place at lines 192–198).

---

## 10. Test / verify

- **Local Worker:** `cd worker && npx wrangler dev` against local D1; `curl` `/api/hourly`.
- **Local frontend:** serve `avian/frontend/` (e.g. `python3 -m http.server`) with `config.js`
  pointed at the live Worker (or `wrangler dev`). Check: dial is default; toggle persists across
  reload; window picker reshapes the dial; 30 s poll updates it; light+dark both legible;
  mobile (≤700px) sizes sanely; reduced-motion disables the entrance; hover tooltip shows top
  species; now-hand at correct Sudbury time from a non-Eastern browser tz.
- **Live data shape sanity (today):** dawn ramp from ~4–5am, peak ~1pm (~200), sharp drop after
  3pm, near-empty overnight. Center total ≈ today's count (~1.4k).
- **Deploy Pages:** `bash avian/build-site.sh` then from `worker/`:
  `wrangler pages deploy _site --project-name barrysbirds --branch production`. Bump any sketch/
  img cache version only if assets changed (they don't here). Verify `barrysbirds.pages.dev`
  stats view + that `/frame.png` still renders the collage.

---

## 11. Files touched (summary)

| File | Change |
|---|---|
| `worker/src/index.js` | + `hourly()` handler, + `sunArc()`, register `'hourly'` action |
| `worker/wrangler.toml` | + `SITE_LAT` / `SITE_LON` vars |
| `avian/frontend/index.html` | restructure `#v1` left cell: toggle + `#statsDial` + `#statsTimeline` |
| `avian/frontend/apt.js` | + `DATA.hourly`; extend `refreshRecent`/`refreshAll`; + `drawActiveStatsChart`; + `drawDayDial`/`wireDialHover`/`playDialEntrance`; + toggle wiring; route view-switch entrance |
| `avian/frontend/styles.css` | + Day Dial + toggle styles, keyframes, mobile + reduced-motion |

No D1 migration. No Pi change. No new runtime dependency.

---

## 12. Out of scope / stretch (don't build now)

- Species color-coding (off-aesthetic; hover tooltip covers composition).
- Per-hour stacked-by-species petals; tiny bird illustration at the busiest hour's rim.
- Animating the now-hand sweep continuously (it updates per poll — sufficient).
- Civil/nautical twilight gradient (we draw a single sunrise→sunset band).
- **Documented fallback** if radial math proves fussy: a linear "ridgeline" — same
  `/api/hourly` data, x = 0–24h, area/area-spline filled `--ink`, daylight shaded behind,
  now-line vertical. Less distinctive but trivial geometry. Radial is the intended build.

---

## Appendix A — `drawDayDial` reference implementation (apt.js)

> Paste near `drawHistograms` (~line 911). Geometry constants (`r0,r1,…`) are tuning knobs —
> adjust live in the browser. Reuses `fmtNK`, `windowLabel`, `currentHours`, `syncPill` idioms.

```js
// ---- Day Dial: 24h radial histogram of detections by clock hour ----
// angle = time of day (midnight top, clockwise); radius = detections that hour.
// Daylight arc + "now" hand are tz-correct from the Worker (DATA.hourly), never
// the viewer's clock. Monochrome; per-hour species shown on hover.
function drawDayDial(animate) {
  var host = document.getElementById('statsDial');
  if (!host) return;
  var HD = DATA.hourly || {};
  var src = HD.bins || [];
  var total = +HD.total || 0;
  if (!total) { host.innerHTML = '<div class="stats-tl-empty">no detections in this window</div>'; return; }

  var bins = new Array(24).fill(0).map(function (_, h) {
    var r = src[h] || {}; return { hour: h, n: +r.detections || 0, species: +r.species || 0, top: r.top || [] };
  });
  var maxN = bins.reduce(function (m, b) { return Math.max(m, b.n); }, 1);

  var S = 320, cx = S / 2, cy = S / 2, r0 = 58, r1 = 132, ringIn = 138, ringOut = 150, PAD = 1.4 / 360;
  function pt(frac, rad) { var a = (frac * 360 - 90) * Math.PI / 180; return [cx + rad * Math.cos(a), cy + rad * Math.sin(a)]; }
  function f(x) { return x.toFixed(2); }
  function petal(h, n) {
    var a1 = h / 24 + PAD, a2 = (h + 1) / 24 - PAD;
    var rh = n > 0 ? r0 + (n / maxN) * (r1 - r0) : r0 + 0.6;
    var p1 = pt(a1, r0), p2 = pt(a2, r0), p3 = pt(a2, rh), p4 = pt(a1, rh);
    return 'M' + f(p1[0]) + ' ' + f(p1[1]) + 'A' + r0 + ' ' + r0 + ' 0 0 1 ' + f(p2[0]) + ' ' + f(p2[1]) +
           'L' + f(p3[0]) + ' ' + f(p3[1]) + 'A' + f(rh) + ' ' + f(rh) + ' 0 0 0 ' + f(p4[0]) + ' ' + f(p4[1]) + 'Z';
  }
  function ringSector(fr1, fr2, ri, ro) {
    var large = (fr2 - fr1) > 0.5 ? 1 : 0;
    var p1 = pt(fr1, ri), p2 = pt(fr2, ri), p3 = pt(fr2, ro), p4 = pt(fr1, ro);
    return 'M' + f(p1[0]) + ' ' + f(p1[1]) + 'A' + ri + ' ' + ri + ' 0 ' + large + ' 1 ' + f(p2[0]) + ' ' + f(p2[1]) +
           'L' + f(p3[0]) + ' ' + f(p3[1]) + 'A' + ro + ' ' + ro + ' 0 ' + large + ' 0 ' + f(p4[0]) + ' ' + f(p4[1]) + 'Z';
  }

  var s = ['<svg class="dial-svg" viewBox="0 0 ' + S + ' ' + S + '" role="img" aria-label="Detections by time of day">'];
  // daylight band (night = full ring beneath)
  s.push('<circle class="dial-night" cx="' + cx + '" cy="' + cy + '" r="' + ((ringIn + ringOut) / 2) + '" fill="none" stroke-width="' + (ringOut - ringIn) + '"/>');
  var sun = HD.sun;
  if (sun && sun.sunrise != null && sun.sunset != null) {
    s.push('<path class="dial-day" d="' + ringSector(sun.sunrise / 24, sun.sunset / 24, ringIn, ringOut) + '"/>');
    [sun.sunrise, sun.sunset].forEach(function (t) { var a = pt(t / 24, ringIn - 2), b = pt(t / 24, ringOut + 4); s.push('<line class="dial-suntick" x1="' + f(a[0]) + '" y1="' + f(a[1]) + '" x2="' + f(b[0]) + '" y2="' + f(b[1]) + '"/>'); });
  }
  // ring + hour spokes
  s.push('<circle class="dial-ring" cx="' + cx + '" cy="' + cy + '" r="' + r1 + '" fill="none"/>');
  for (var h = 0; h < 24; h++) { var i = pt(h / 24, r0), o = pt(h / 24, r1); s.push('<line class="dial-spoke' + (h % 6 === 0 ? ' major' : '') + '" x1="' + f(i[0]) + '" y1="' + f(i[1]) + '" x2="' + f(o[0]) + '" y2="' + f(o[1]) + '"/>'); }
  // petals
  var nowH = HD.now_local ? HD.now_local.hour : -1;
  bins.forEach(function (b) { s.push('<path class="dial-petal' + (b.hour === nowH ? ' current' : '') + '" data-hour="' + b.hour + '" d="' + petal(b.hour, b.n) + '"/>'); });
  // cardinal labels
  [[0, '12a'], [6, '6a'], [12, '12p'], [18, '6p']].forEach(function (l) { var p = pt(l[0] / 24, r1 + 16); s.push('<text class="dial-hlabel" x="' + f(p[0]) + '" y="' + f(p[1]) + '" text-anchor="middle" dominant-baseline="middle">' + l[1] + '</text>'); });
  // now hand
  if (HD.now_local) { var nf = (HD.now_local.hour + (HD.now_local.minute || 0) / 60) / 24, tip = pt(nf, r1 - 4), base = pt(nf, r0 - 6); s.push('<line class="dial-now" x1="' + f(base[0]) + '" y1="' + f(base[1]) + '" x2="' + f(tip[0]) + '" y2="' + f(tip[1]) + '"/><circle class="dial-now-dot" cx="' + f(tip[0]) + '" cy="' + f(tip[1]) + '" r="2.6"/>'); }
  // center readout
  s.push('<text class="dial-total" x="' + cx + '" y="' + (cy - 2) + '" text-anchor="middle">' + fmtNK(total) + '</text>');
  s.push('<text class="dial-total-lbl" x="' + cx + '" y="' + (cy + 13) + '" text-anchor="middle">' + windowLabel(currentHours) + '</text>');
  s.push('</svg>');
  host.innerHTML = s.join('');

  wireDialHover(host, bins);
  if (animate) playDialEntrance(host);
}

// Hover/tap a petal → highlight + tooltip pill with that hour's top species.
function wireDialHover(host, bins) {
  var tip = document.createElement('div'); tip.className = 'dial-tip'; tip.hidden = true; host.appendChild(tip);
  function label(h) { var ap = h < 12 ? 'a' : 'p', hr = (h % 12) || 12; return hr + ap; }
  host.querySelectorAll('.dial-petal').forEach(function (el) {
    function show() {
      var b = bins[+el.dataset.hour];
      host.querySelectorAll('.dial-petal.is-hover').forEach(function (x) { x.classList.remove('is-hover'); });
      el.classList.add('is-hover');
      var top = (b.top || []).map(function (t) { return '<span class="t"><span class="c">' + (t.com || t.sci) + '</span><span class="n">' + t.n + '</span></span>'; }).join('');
      tip.innerHTML = '<span class="hd">' + label(b.hour) + '–' + label((b.hour + 1) % 24) + ' · ' + b.n + (b.n === 1 ? ' call' : ' calls') + '</span>' + (top || '<span class="t">—</span>');
      tip.hidden = false;
    }
    el.addEventListener('mouseenter', show);
    el.addEventListener('click', show);
    el.addEventListener('mouseleave', function () { el.classList.remove('is-hover'); tip.hidden = true; });
  });
}

// Petals grow from the dial center, staggered clockwise from midnight.
function playDialEntrance(host, lead) {
  lead = lead || 0;
  var petals = [].slice.call(host.querySelectorAll('.dial-petal'));
  petals.forEach(function (el) { el.classList.remove('entering'); el.style.animationDelay = Math.round(lead + (+el.dataset.hour / 24) * 420) + 'ms'; });
  void host.offsetWidth;
  petals.forEach(function (el) { el.classList.add('entering'); });
  setTimeout(function () { petals.forEach(function (el) { el.classList.remove('entering'); el.style.animationDelay = ''; }); }, lead + 420 + 420);
}
```

---

## Appendix B — Day Dial CSS (styles.css)

> Append after the stats block. Clones `.atlas-sort`/`.window-pick` for the toggle. Verify the
> dark-theme overrides under the existing `:root[data-theme="dark"]` cascade (the vars already
> flip; only check the night/day band contrast reads in both themes).

```css
/* ===== Stats: chart toggle + Day Dial ===== */
.stats-charts { display: flex; flex-direction: column; gap: 14px; min-height: 0; flex: 1 1 auto; }

.stats-chart-toggle {
  align-self: flex-start; display: inline-flex; padding: 4px; position: relative;
  background: var(--paper-2); border-radius: 999px; box-shadow: var(--recess);
}
.stats-chart-toggle button {
  background: transparent; border: 0; color: var(--ink-soft);
  font: 10px/1 ui-monospace, Menlo, monospace; letter-spacing: 0.18em; text-transform: uppercase;
  padding: 8px 14px; border-radius: 999px; cursor: pointer; position: relative; z-index: 1;
  transition: color 200ms ease;
}
.stats-chart-toggle button:hover,
.stats-chart-toggle button[aria-current="true"] { color: var(--ink); }

.stats-dial { display: flex; align-items: center; justify-content: center; flex: 1 1 auto; min-height: 0; }
.dial-svg { width: 100%; max-width: 420px; height: auto; overflow: visible; }

.dial-night   { stroke: var(--paper-3); }
.dial-day     { fill: var(--paper); }                 /* daylight: lighter than night band */
.dial-ring,
.dial-spoke   { stroke: var(--hairline); stroke-width: 1; }
.dial-spoke.major { stroke: var(--hairline); }
.dial-suntick { stroke: var(--ink-soft); stroke-width: 1; }
.dial-petal   { fill: var(--ink); transition: fill 160ms ease; }
.dial-petal.is-hover { fill: var(--accent); }
.dial-petal.current  { fill: none; stroke: var(--ink); stroke-width: 1; stroke-dasharray: 2 2; }
.dial-now     { stroke: var(--ink); stroke-width: 1.5; }
.dial-now-dot { fill: var(--ink); }
.dial-hlabel  { fill: var(--ink-soft); font: 8px/1 ui-monospace, Menlo, monospace; letter-spacing: 0.08em; text-transform: uppercase; }
.dial-total     { fill: var(--ink); font: 800 22px/1 ui-serif, "Iowan Old Style", Georgia, serif; }
.dial-total-lbl { fill: var(--ink-soft); font: 8px/1 ui-monospace, Menlo, monospace; letter-spacing: 0.18em; text-transform: uppercase; }

/* hover tooltip pill (reuses the raised-paper look) */
.stats-dial { position: relative; }
.dial-tip {
  position: absolute; top: 8px; left: 50%; transform: translateX(-50%);
  background: var(--paper); box-shadow: var(--raised); border-radius: 8px;
  padding: 6px 10px; pointer-events: none; max-width: 220px; z-index: 2;
}
.dial-tip .hd { display: block; font: 9px/1.4 ui-monospace, Menlo, monospace; letter-spacing: 0.08em; color: var(--ink-soft); text-transform: uppercase; margin-bottom: 3px; }
.dial-tip .t  { display: flex; justify-content: space-between; gap: 14px; font: 12px/1.4 ui-serif, "Iowan Old Style", Georgia, serif; color: var(--ink); }
.dial-tip .t .n { color: var(--ink-soft); font-variant-numeric: tabular-nums; }

@keyframes dial-petal-in { from { transform: scale(0.15); opacity: 0; } to { transform: scale(1); opacity: 1; } }
.dial-petal.entering { animation: dial-petal-in 360ms cubic-bezier(.2,.7,.3,1) backwards; transform-box: view-box; transform-origin: 160px 160px; }

@media (max-width: 900px) { .stats-dial { min-height: clamp(280px, 50vh, 440px); } }
@media (prefers-reduced-motion: reduce) { .dial-petal.entering { animation: none; } }
```
