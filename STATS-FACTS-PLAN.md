# STATS-FACTS-PLAN.md

Implementation plan: add a **"Field Notes"** sheet to the stats screen — a live, auto-updating
set of plain-English observations about the bird data ("first call today was X at 4:02am, 68 min
before sunrise", "2 new species today", "busiest hour 1pm", …). It becomes the **default view of the
right-hand cell** of the stats grid, behind a **new `notes | summary` toggle** (flip to "summary" for
the classic numbers), mirroring the left cell's existing `day | species` chart toggle.

> **Status:** design complete (steered by Scott 2026-06-20), not yet built. This doc is
> self-contained — a cold-start session should be able to execute it reading only this file plus the
> anchors it cites. Scope is the public collage frontend (`avian/frontend/`) + one new `avian-worker`
> read endpoint. **No Pi change. No D1 migration.** Facts are pure read-side derivations, so past
> detections "narrate" retroactively and this is safe to ship anytime.
>
> Companion doc: **`STATS-DAYDIAL-PLAN.md`** — the just-shipped Day Dial used the identical
> toggle/endpoint/entrance patterns; read it if any anchor here is unclear. This plan deliberately
> reuses that machinery.

---

## 1. Plain English Summary (for a non-technical reader)

The stats page has two halves. On the **left** is a chart (the round "Day Dial" clock, or a species
timeline — you flip between them with a little two-way switch). On the **right** is a column of
numbers: detections "By Period", "Top Species", and "First Detections".

We're adding a **second little switch to the right column** and making a new view called **"Field
Notes"** (**"notes"**) the thing it shows **by default** — you flip the switch to **"summary"** to get
the old numbers back. Field Notes is a short, friendly list of *observations the site writes about
itself* — the kind of thing a birder would jot in a notebook:

- *"First call today: Northern Cardinal at 4:02am — 68 min before sunrise."*
- *"2 new species today: Blue-gray Gnatcatcher, Cedar Waxwing."*
- *"Busiest hour: 1pm — 200 calls."*
- *"Most heard today: House Sparrow — 1,081 calls (57% of today)."*
- *"Seldom heard: Cedar Waxwing — only its 1st time ever."*
- *"Day 2 of listening — 1,903 calls logged in all."*

These sentences are generated automatically from the same live data the rest of the page uses, and
they **refresh on their own every 30 seconds** — so as new birds are heard through the day, the notes
quietly rewrite themselves (a brand-new observation gets a tiny dot so you notice it changed). Each
note about a specific bird is **tappable**, jumping you to that bird's card, exactly like the
existing lists.

What you'll notice: open stats → the right column now **leads with the Field Notes** — a tidy,
readable little field-notebook of the day's most interesting facts, styled to match the rest of the
page (ink-on-paper, serif sentences, small monospace labels). A new switch flips it back to the
classic "summary" numbers, and your choice is remembered, just like every other switch on the page.

**Real data already supports this.** The live box (Sudbury MA, online 2026-06-19) on 2026-06-20
showed: 1,900 calls today across 25 species; House Sparrow dominating at 1,081 (~57%); a 1pm peak of
200 calls; the Northern Cardinal singing 44× at 4am, *before* the 5:10 sunrise; and two genuinely new
species (Blue-gray Gnatcatcher, Cedar Waxwing). Every example note above is a real fact from that
day.

---

## 2. Exact requirement (request + the 2026-06-20 design answers)

From the request: *"add a facts sheet to the stats page … useful interesting facts about the data
that updates as the data does … 'the first bird heard today was xx at xx:xx', '2 new birds were
heard today …', pattern notes of interest … display this in a way that matches the current aesthetic
and is easily viewable and engaging."*

Design decisions Scott made when asked (so a builder doesn't re-derive them):

- **Placement = its own toggle on the RIGHT cell.** Not a separate panel and not folded into the
  left chart toggle. The stats grid becomes **two cells, each with its own two-way switch**: left =
  `day | species` (existing, untouched), right = **`notes | summary`** (new), with **`notes` the
  default**. "notes" shows the Field Notes sheet; "summary" shows the existing By Period / Top
  Species / First Detections lists. (Scott: *"I want there to be a separate toggle for the right-side
  cell … so there are 2 sections (left/right) each with their own toggle"* and *"make field notes the
  default view also."*)
- **Compute server-side** via a **new `/api/facts` endpoint** (full SQL → precise facts; client is a
  generic renderer; future facts ship by deploying *only* the Worker). (Chosen over the zero-backend
  client-derived variant, which couldn't give the exact-minute "first call" headline.)
- **Facts to feature:** *first call of the day*, *new species / lifers*, *daily rhythm (peak &
  quiet)*, *headliner & rarities* — **plus anything else feasible and interesting** (Scott granted
  latitude). §5.2 specifies the full catalog.
- Completion = this implementation plan.

---

## 3. The design — "Field Notes", a second toggle on the right cell

### 3.1 Layout (symmetric two-cell grid)

```
┌─ stats (#v1) ───────────────────────────────────────────────┐
│  [ day | species ]            [ notes | summary ]           │  ← two toggles, top-left of each cell
│                                  ▲ default = notes           │
│  ╭───────────────╮            ┌──────────────────────────┐   │
│  │   Day Dial    │            │ FIELD NOTES   today       │   │
│  │   (or species │            │ ── DAWN ───────────────── │   │
│  │    timeline)  │            │  First call 4:02a —       │   │
│  │     1.9k      │            │  N. Cardinal, 68m b/sun   │   │
│  ╰───────────────╯            │ ── NEW ────────────────── │   │
│                               │  2 new today: Gnatcatcher │   │
│   LEFT cell = chart           │  ── PEAK ──────────────── │   │
│   (#statsDial /               │  Busiest hour 1pm, 200    │   │
│    #statsTimeline)            │  …                        │   │
│                               └──────────────────────────┘   │
│                               RIGHT cell = #statsLists OR     │
│                                            #statsFacts        │
└──────────────────────────────────────────────────────────────┘
```

The grid itself (`.stats-grid`, two columns `1.15fr 0.85fr`) is unchanged. We restructure only the
**right cell** (`.stats-side`) to hold a toggle + two swappable bodies:
- `#statsLists` — the existing three `.grp` blocks (By Period / Top Species / First Detections),
  moved verbatim into this wrapper.
- `#statsFacts` — the new Field Notes sheet.

### 3.2 Why this shape

- **Maximum reuse, minimum new surface.** The right toggle is a clone of the left toggle, which is
  itself a clone of `.atlas-sort`. The whole segmented-control behaviour — sliding `.seg-pill`,
  `syncPill`, `wireToggleAdvance`, `aria-current`, `readLS`/`writeLS` persistence — already exists and
  is generic over its buttons. We add a second instance, not a new mechanism.
- **Field notes as `<li data-sci>` rows = three free behaviours.** Rendering each note as
  `<li class="fact" data-sci="…">` means it inherits, with zero new wiring: (1) **click-to-bird** via
  the global `li[data-sci]` delegate (`apt.js` ~3234 → `jumpToSci`); (2) **entrance fade** via the
  shared `stats-fade-in` keyframe; (3) hover affordance styling. We only add the prose layout + tag.
- **Server is the single source of "what's interesting."** All fact selection/wording/priority lives
  in one testable `facts()` function. The client renders a generic `{kind, tag, text, sci}` list, so
  **adding or rewording a fact later is a Worker-only deploy** (no Pages rebuild).
- **Updates as the data does, without motion thrash.** Facts are refetched on the existing 30 s
  `refreshAll()` poll (§6.3). The poll passes no `animate`, so the sheet silently rewrites; only a
  *newly-changed* note gets a small "is-new" dot (§Appendix A), which is the intended "it updated"
  signal.

### 3.3 Aesthetic

Ink-on-paper, field-guide. Each note = a small monospace **tag** (DAWN / NEW / PEAK / TOP / RARE /
QUIET / TALLY / MILE …) in the accent ink + a **serif sentence** in `--ink`, separated by hairlines —
the same visual grammar as `.stats-side li` (mono `.yr` + serif body + `--hairline` rule), just laid
out for prose instead of a 3-column number row. Tokens in §8.

---

## 4. Decisions taken (so you don't re-litigate)

| # | Decision | Rationale |
|---|----------|-----------|
| F1 | **Two independent toggles**, one per cell. Right = `notes \| summary`, key `bird:statsSide`, **default `'notes'`** (Field Notes is what the right cell shows on first load) | Scott's explicit ask; mirrors the left `day\|species` toggle (`bird:statsChart`) exactly |
| F2 | New Worker endpoint **`/api/facts`**; server computes an ordered `{kind,tag,text,sci}[]` | Precise facts (exact times, comebacks, Nth-time-ever); client stays a dumb renderer; new facts = Worker-only deploy |
| F3 | Facts are **today / all-time scoped, NOT window-scoped** — fetched in `refreshAll` only (not `refreshRecent`) | Notes are "today's field notebook," a stable narrative; the *dial* already responds to the window picker. Avoids confusing double-windowing |
| F4 | Notes render as **`<li class="fact" data-sci>`** inside `<ul class="facts-sheet">` | Inherits click-to-bird (`li[data-sci]` delegate), entrance, hover for free |
| F5 | Server returns the **full applicable set** (cap ~8) in priority order; **client shows top N** (6 desktop, all on mobile-scroll) | Keeps the sheet tidy on desktop; phone grid already scrolls |
| F6 | **Reuse** existing Worker helpers `localDayStart`, `tzMod`, `sunArc` | Already in `worker/src/index.js`; no new astronomy/tz code |
| F7 | A changed note gets a subtle **`is-new` dot** on silent (poll) updates only | The "updates as data does" delight, without re-animating the whole sheet each poll |
| F8 | **No new `wrangler.toml` vars** | `SITE_LAT`/`SITE_LON`/`TZ_OFFSET_HOURS` already set for the Day Dial; `sunArc` reuses them |

---

## 5. Backend — the one new endpoint (`avian-worker`)

**File:** `worker/src/index.js`. **No D1 migration** (reads the existing `detections` table). **No
`wrangler.toml` change.** Full reference handler in **Appendix C**.

### 5.1 Route registration
In `queryApi()` add `'facts'` to the `known` array (currently line 398):
```js
const known = ['recent', 'stats', 'lifelist', 'timeseries', 'species', 'firstseen', 'hourly', 'facts'];
```
In the `switch (action)` (currently ~line 405) add — facts are time-independent (today/all-time),
so the signature matches `stats(env, tz, now)`:
```js
case 'facts': return facts(env, tz, now);
```
Reachable as both `/api/facts` and `/api/birdnet-api.php?action=facts` (the frontend uses the latter
style).

### 5.2 The fact catalog (what `facts()` computes)

Each entry is pushed only if its **condition** holds; the push **order is the priority** (events
first, then the day's arc, then summaries, then an always-true fallback). Every fact is
`{ kind, tag, text, sci? }`. `sci` (when set) makes the note click-to-bird. All times/days are
**Sudbury-local** (via `tzMod`/`localDayStart`/`sunArc` — never the viewer's clock).

| Order | kind / tag | Condition | Copy template (real 2026-06-20 example) | sci? |
|---|---|---|---|---|
| 1 | `new` / **NEW** | ≥1 species' first-ever detection is today | 1: `New today: {com} — first time at this yard.` · ≥2: `{N} new species today: {a}, {b}, {c}{, +k more}.` | singular only |
| 2 | `dawn` / **DAWN** | ≥1 detection today | `First call today: {com} at {h:mm am} — {m} min before sunrise.` ("…after sunrise." / no tail if no sun) | ✓ |
| 3 | `peak` / **PEAK** | today has detections | `Busiest hour: {h am/pm} — {N} calls.` | — |
| 4 | `top` / **TOP** | today total > 0 | `Most heard today: {com} — {N} calls ({pct}% of today).` | ✓ |
| 5 | `rare` / **RARE** | rarest species heard today has all-time total ≤ 5 **and** isn't already a `new` today | `Seldom heard: {com} — only its {ordinal} time ever.` | ✓ |
| 6 | `return` / **RETURN** | a species heard today was last heard ≥ 3 days ago | `{com} is back — first time in {days} days.` | ✓ |
| 7 | `now` / **NOW** | last-hour count > 0 | `Last hour: {N} calls from {S} species.` | — |
| 8 | `quiet` / **QUIET** | a silent run of ≥ 3 clock-hours today exists | `Quietest stretch: {h1 am/pm}–{h2 am/pm}.` | — |
| 9 | `tally` / **TALLY** | today > 0 | `{S} species today across {N} calls.` | — |
| 10 | `mile` / **MILE** | always (fallback — the sheet is never empty) | `Day {d} of listening — {N} calls logged in all.` | — |

**Empty-day path:** if there are no detections today, return a single gentle note
(`No calls yet today. Last heard: {com}.`, or `No birds detected yet — the mic is listening.`) so the
sheet never reads as broken.

Helpers `facts()` needs (Appendix C provides them): `hm12(h,m)` → `"4:02am"` / `"1pm"`;
`ordinal(n)` → `"1st"/"2nd"/…`; `fmt(n)` → `"1.1k"` / `"1,903"`. SQL count ≈ 7–9 small queries — on
par with the existing `stats()` handler.

### 5.3 Response shape
```jsonc
{
  "facts": [
    { "kind": "new",  "tag": "NEW",  "text": "2 new species today: Blue-gray Gnatcatcher, Cedar Waxwing.", "sci": null },
    { "kind": "dawn", "tag": "DAWN", "text": "First call today: Northern Cardinal at 4:02am — 68 min before sunrise.", "sci": "Cardinalis cardinalis" },
    { "kind": "peak", "tag": "PEAK", "text": "Busiest hour: 1pm — 200 calls.", "sci": null }
    // …priority order, capped ~8
  ],
  "today": { "detections": 1900, "species": 25 },
  "as_of": "2026-06-20T23:48:21.000Z"
}
```

### 5.4 Deploy + smoke-test
From `worker/`: `npx wrangler deploy`. Then (note the **`-A` User-Agent** — Cloudflare 403s the
default urllib/empty UA; see §9):
```
curl -s -A "facts/1" "https://avian-worker.s-friedman.workers.dev/api/facts" | python3 -m json.tool
```
Expect an ordered `facts` array whose sentences match the live day (a DAWN note with an exact time, a
PEAK at 1pm, a TOP House-Sparrow with ~57%).

---

## 6. Frontend — file map & exact anchors

All in `avian/frontend/`. Line numbers are from the current revision; **anchor on the quoted
strings/function names** (`apt.js` is ~814 KB and shifts).

### 6.1 `index.html` — restructure the RIGHT cell (`#v1`, the `.stats-side` aside, lines 105–121)
Wrap the three existing `.grp` blocks in `#statsLists`, add the toggle above them, and add an empty
`#statsFacts` sibling. Replace the whole `<aside class="stats-side"> … </aside>`:
```html
<aside class="stats-side">
  <!-- Right-cell toggle (clone of #statsChartToggle): flip the right column
       between the Field Notes sheet (default) and the numeric summary.
       Choice persists in localStorage bird:statsSide. -->
  <div class="stats-side-toggle" id="statsSideToggle" role="tablist" aria-label="panel type">
    <i class="seg-pill" aria-hidden="true"></i>
    <button type="button" data-side="notes" aria-current="true">notes</button>
    <button type="button" data-side="lists">summary</button>
  </div>
  <div class="stats-side-body">
    <!-- Field Notes (DEFAULT): auto-generated observations (/api/facts).
         Rendered by drawFactsSheet(). Notes are <li data-sci> → click-to-bird
         for free. -->
    <div id="statsFacts"></div>
    <!-- Numeric summary (hidden until toggled). Rendered by renderStatsLists(). -->
    <div id="statsLists" hidden>
      <div class="grp">
        <h3>By Period</h3>
        <small>detections, grouped by recency</small>
        <ol id="statsByPeriod"></ol>
      </div>
      <div class="grp">
        <h3>Top Species</h3>
        <small id="statsTopSpecCap">most-heard, current window</small>
        <ol id="statsTopSpec"></ol>
      </div>
      <div class="grp">
        <h3>First Detections</h3>
        <small>newest additions to the life list</small>
        <ol id="statsFirstSeen"></ol>
      </div>
    </div>
  </div>
</aside>
```
(The `.grp` markup is unchanged — only re-parented under `#statsLists`. Keep the existing element IDs:
`statsByPeriod`, `statsTopSpec`, `statsTopSpecCap`, `statsFirstSeen` — `renderStatsLists()` targets
them.)

### 6.2 `apt.js` — data layer
- **`DATA` object (~line 909):** add after `hourly:`
  ```js
  facts: null,        // ?action=facts — ordered Field Notes for the right cell (refetched on poll)
  ```
- **`refreshAll()` (~lines 1536–1558):** add a **7th** fetch + assignment. Facts are time-independent
  (not window-scoped, F3), so they go in `refreshAll` (load + 30 s poll + tab-revisit) and **NOT** in
  `refreshRecent`:
  ```js
  // …add to the Promise.all array:
  fetchJson(AV_API + '/api/birdnet-api.php?action=facts').catch(function () { return null; }),
  // …in .then(parts), alongside the others:
  if (parts[6]) DATA.facts = parts[6];
  ```
  (Best-effort: a failed facts fetch keeps the last good sheet, like `hourly`.)

### 6.3 `apt.js` — right-cell render router (mirror `drawActiveStatsChart`)
Add next to `drawActiveStatsChart` (~line 761). It shows lists-or-facts and fires the matching
entrance, so the render routers don't each branch:
```js
// Render whichever right-cell panel is selected (persisted in bird:statsSide),
// toggling #statsLists vs #statsFacts. Mirrors drawActiveStatsChart for the left.
function drawActiveSidePanel(animate) {
  var mode = (window.__statsSide === 'lists') ? 'lists' : 'notes';   // default + any other value → notes
  var lists = document.getElementById('statsLists');
  var facts = document.getElementById('statsFacts');
  if (!lists || !facts) return;
  lists.hidden = (mode !== 'lists');
  facts.hidden = (mode !== 'notes');
  if (mode === 'lists') { renderStatsLists(); if (animate) playStatsSideEntrance(); }
  else { drawFactsSheet(animate); }   // drawFactsSheet fires playFactsEntrance when animate
}
```
Then in the two render routers, **replace** the `renderStatsLists(); … if (animate) playStatsSideEntrance();`
pair with a single `drawActiveSidePanel(animate);`:
- `renderWindowDependent` (~line 1499): the lines `renderStatsLists();` and `if (animate) playStatsSideEntrance();` → `drawActiveSidePanel(animate);`
- `renderTimeIndependent` (~line 1510): same replacement.

### 6.4 `apt.js` — the Field Notes renderer + entrance
Add `drawFactsSheet(animate)` and `playFactsEntrance(host, lead)` near `drawDayDial`/`playDialEntrance`
(~line 1024). **Full reference in Appendix A.** Reuses no new helpers; renders
`DATA.facts.facts[]` into `#statsFacts` as a headed `<ul class="facts-sheet">` of `<li class="fact"
data-sci>` rows, with the `is-new` diff-highlight on silent updates.

### 6.5 `apt.js` — right-toggle wiring (clone the left block, lines 188–204)
Add a parallel block right after the existing `statsChartEl` wiring. It's the same generic pattern
(`querySelectorAll('button')`, `aria-current`, persist, `syncPill`, re-render with entrance):
```js
var statsSideEl = document.getElementById('statsSideToggle');
var statsSideBtns = statsSideEl ? [].slice.call(statsSideEl.querySelectorAll('button')) : [];
window.__statsSide = readLS('bird:statsSide', 'notes');   // Field Notes is the default view
statsSideBtns.forEach(function (b) {
  b.setAttribute('aria-current', (b.dataset.side === window.__statsSide) ? 'true' : 'false');
});
statsSideBtns.forEach(function (b) {
  b.addEventListener('click', function () {
    statsSideBtns.forEach(function (x) { x.setAttribute('aria-current', x === b ? 'true' : 'false'); });
    window.__statsSide = b.dataset.side;
    writeLS('bird:statsSide', window.__statsSide);
    syncPill(statsSideEl);
    drawActiveSidePanel(true);   // swap panels, replaying the new panel's entrance
  });
});
```
- Add `wireToggleAdvance(statsSideEl);` beside the others (~line 210).
- Add `if (statsSideEl) syncPill(statsSideEl);` inside `syncAllPills()` (~line 212) so the pill lands
  correctly after fonts/layout settle.

### 6.6 `apt.js` — view-switch + side-entrance scoping
- **`playActiveStatsEntrance(lead)` (~line 750):** it currently replays the active chart's entrance +
  `playStatsSideEntrance(lead)`. Make the side half pick lists-vs-facts:
  ```js
  function playActiveStatsEntrance(lead) {
    if ((window.__statsChart || 'dial') === 'dial') playDialEntrance(document.getElementById('statsDial'), lead);
    else playStatsTimelineEntrance(lead);
    if (window.__statsSide === 'lists') playStatsSideEntrance(lead);   // default (notes) → facts entrance
    else playFactsEntrance(document.getElementById('statsFacts'), lead);
  }
  ```
  (No re-render needed on view-switch — `drawActiveSidePanel` ran on the last poll, so the active
  panel's DOM is current. Same contract the dial already relies on.)
- **`playStatsSideEntrance(lead)` (~line 707):** scope its query to the lists wrapper so it doesn't
  animate hidden facts `<li>`s. Change `var side = document.querySelector('.stats-side');` →
  `var side = document.getElementById('statsLists');` (its `h3, small, li` queries then cover exactly
  the three lists).

### 6.7 `styles.css` — new rules (full block in Appendix B)
- `.stats-side` — make it a column with the toggle pinned on top: `display:flex; flex-direction:column;
  gap:14px;` and move the existing vertical centering onto `.stats-side-body`.
- `.stats-side-toggle` — **clone `.stats-chart-toggle`** (the Day Dial added it ~line 1599); text
  buttons styled like `.window-pick button`. Place top-left (`align-self:flex-start`) so it lines up
  with the left cell's toggle across the grid top.
- `.stats-side-body { flex:1 1 auto; min-height:0; display:flex; flex-direction:column;
  justify-content:center; }` — holds `#statsLists` / `#statsFacts`; keeps the summary lists centered
  as today.
- `.facts-sheet` / `.fact` / `.fact-tag` / `.fact-text` / `.fact.is-new` — the sheet (tokens §8).
- Reuse the existing `@keyframes stats-fade-in`; add `.fact.entering`, `.facts-head h3.entering`,
  `.facts-head small.entering` to it **and** to the `prefers-reduced-motion` guard (~line 532).
- Mobile: the right cell already lives in the `≤900px` scrolling grid (`.stats-grid { overflow-y:auto }`,
  ~line 1667). Just let `#statsFacts` claim content height and `.facts-sheet` scroll internally if
  long.

---

## 7. Build order (each step independently testable)

1. **Worker endpoint** (§5, Appendix C). Deploy. `curl -A … /api/facts` → ordered facts matching the
   live day. *No frontend yet.*
2. **Data wiring** (§6.2). Add `DATA.facts`; extend `refreshAll`. Confirm in DevTools that `DATA.facts`
   populates on load and on the 30 s poll.
3. **HTML restructure** (§6.1) + **right-toggle wiring** (§6.5) + minimal toggle CSS so the segmented
   control renders and the pill slides. Toggling should flip `hidden` on the (still-empty) `#statsFacts`
   vs `#statsLists`. Verify the summary lists still render unchanged under "summary".
4. **Side router** (§6.3): add `drawActiveSidePanel`, swap the two render-router call sites. Confirm the
   summary view is identical to before and the poll keeps it live.
5. **Field Notes renderer** (§6.4, Appendix A): `drawFactsSheet`. Toggle to "notes" → the sheet renders
   from live data. Get the prose layout + tags right.
6. **Entrances** (§6.6): `playFactsEntrance` + extend `playActiveStatsEntrance` + scope
   `playStatsSideEntrance`. Verify notes stagger in on view-switch and on toggle, and the summary
   entrance is unaffected.
7. **`is-new` highlight** (Appendix A diff) — confirm a note that changes between polls gets the dot;
   the entrance (animate) path does **not** mark notes new.
8. **CSS polish** (Appendix B): theme light/dark, mobile sizing, reduced-motion.
9. **Build + deploy Pages** (§10). Verify live site (both toggles, persistence) + e-ink `/frame.png`
   unaffected.

A reasonable first PR = steps 1–5 (functional Field Notes behind the toggle). Steps 6–8 = a polish PR.

---

## 8. Aesthetic tokens to reuse (verbatim)

Light theme (auto-inverts in dark via `:root[data-theme="dark"]`):

| Token | Value | Field-Notes use |
|---|---|---|
| `--paper` | `#fcfcfb` | cell bg |
| `--paper-2` | `#f3f2ee` | toggle recess track, note hover bg |
| `--ink` | `#1a1612` | note sentence (`.fact-text`) |
| `--ink-soft` | `#908576` | caption, secondary |
| `--accent` | `#4a3f31` | h3 left-border, `is-new` dot |
| `--accent-2` | (see `:root`) | tag text (`.fact-tag`), matches `.stats-side li .yr` |
| `--hairline` | `rgba(26,22,18,0.14)` | note separators |
| `--recess` / `--raised` | (see `:root`) | toggle track / sliding pill |

Type: tags + toggle buttons → `ui-monospace, "SF Mono", Menlo, monospace` (9–10px, `letter-spacing
.12–.18em`, uppercase). Note sentences → `ui-serif, "Iowan Old Style", Georgia, serif` (~14px/1.45) —
matches `.stats-side li`. Motion: `stats-fade-in` (opacity, 340 ms ease); always honor
`prefers-reduced-motion`.

---

## 9. Edge cases & gotchas

- **Young dataset: `new today` is inflated.** On a 1–2-day-old box almost every species' first-ever
  detection is "today" (2026-06-20: ~all 25). The NEW note will read `"20 new species today: …,
  +17 more."` — true, self-resolving as the box ages. Acceptable for v1. *Optional softener:* if
  `new == today's total species`, reword to `"First full day — {S} species so far."` (Appendix C notes
  where).
- **Timezone is server-authoritative.** First-call time, peak hour, sunrise delta, "today" boundary
  all come from the Worker (`localDayStart`/`tzMod`/`sunArc` with `TZ_OFFSET_HOURS`). **Never** use the
  browser clock for fact text — the viewer may be anywhere (same rule as the Day Dial).
- **Pluralization.** `1 call` vs `2 calls`, `1 species` (no plural form — "species" is invariant),
  `+1 more`. Appendix C handles these; don't emit `"1 calls"`.
- **De-dupe RARE vs NEW.** A brand-new species is also "rarely heard" (total 1). The RARE rule skips
  any sci already in the NEW set so the same bird isn't reported twice.
- **Notes must be `<li>` to be clickable.** The global click delegate matches `li[data-sci]`
  (`apt.js` ~3234). Render facts as `<li class="fact" data-sci>` — a `<div>` would silently lose
  click-to-bird.
- **Don't re-animate on poll.** The 30 s poll calls `refreshAll()` with no `animate` (line 1583), so
  `drawActiveSidePanel(undefined)` re-renders facts **without** an entrance — correct. Only the
  `is-new` dot signals the update. (If you see the whole sheet flicker every 30 s, an `animate` truthy
  value is leaking through.)
- **Cloudflare 403s the default User-Agent.** Any ad-hoc probe of `/api/facts` must send `-A`/a UA
  header (`curl` is fine; the shipped Pi scripts already do). Cost a debug cycle 2026-06-19 — see
  CLAUDE.md.
- **Pages serves a 200 HTML fallback for missing assets** — not relevant here (no new assets), but
  verify deploys by content, not HTTP status.
- **e-ink frame unaffected.** `?frame=1` pins the collage view (`#v0`) and strips chrome; Field Notes
  live in `#v1` and never render in frame mode. Re-confirm `/frame.png` after deploy anyway.
- **Persisted value safety.** `window.__statsSide = readLS('bird:statsSide','notes')`; the router treats
  only the explicit value `'lists'` as summary — default and any stale/garbage key fall through to
  Field Notes, never a blank cell.
- **Toggle pill needs `syncPill` after fonts load** (text-sized buttons) — wired via `syncAllPills`
  and `document.fonts.ready` (already in place ~lines 192–212). Two-button width is the same as the
  left toggle's, so the existing pill math just works.
- **`renderStatsLists` still owns the summary.** Don't inline it into the router differently — the
  router calls it unchanged so the three lists (and their window-aware caption `statsTopSpecCap`)
  behave exactly as today.

---

## 10. Test / verify

- **Local Worker:** `cd worker && npx wrangler dev` against local D1; `curl -A … /api/facts`.
- **Local frontend:** serve `avian/frontend/` (`python3 -m http.server`) with `config.js` pointed at
  the live Worker (or `wrangler dev`). Check: right cell defaults to **notes** (Field Notes renders on
  first load); flip to **summary** → the three lists render unchanged; choice persists across reload
  **independently** of the left `day/species` choice; the 30 s poll rewrites notes silently; a changed
  note shows the `is-new` dot; tapping a note
  with a species jumps to its atlas card; light + dark both legible; mobile (≤700 px) the right cell
  scrolls; reduced-motion disables the entrance; first-call time is correct from a non-Eastern browser
  timezone (server-authoritative).
- **Live data shape sanity (2026-06-20):** NEW (Gnatcatcher/Waxwing), DAWN (Cardinal ~4am, before
  5:10 sunrise), PEAK (1pm, 200), TOP (House Sparrow ~57%), MILE (Day 2, ~1,903).
- **Deploy Pages:** `bash avian/build-site.sh` then from `worker/`:
  `wrangler pages deploy _site --project-name barrysbirds --branch production`. No asset version bump
  needed (no new assets). Verify `barrysbirds.pages.dev` stats view (both toggles) + that `/frame.png`
  still renders the collage.

---

## 11. Files touched (summary)

| File | Change |
|---|---|
| `worker/src/index.js` | + `facts()` handler, + `hm12`/`ordinal`/`fmt` helpers, register `'facts'` action |
| `worker/wrangler.toml` | **none** (reuses `SITE_LAT`/`SITE_LON`/`TZ_OFFSET_HOURS`) |
| `avian/frontend/index.html` | restructure `#v1` right cell: `#statsSideToggle` + `#statsLists` wrap + `#statsFacts` |
| `avian/frontend/apt.js` | + `DATA.facts`; + facts fetch in `refreshAll`; + right-toggle wiring; + `drawActiveSidePanel`; + `drawFactsSheet`/`playFactsEntrance`; extend `playActiveStatsEntrance`; scope `playStatsSideEntrance`; swap calls in render routers; `syncAllPills` + `wireToggleAdvance` |
| `avian/frontend/styles.css` | + `.stats-side` column + `.stats-side-toggle` (clone) + `.stats-side-body` + Field Notes sheet + entrance + mobile + reduced-motion |

No D1 migration. No Pi change. No new runtime dependency.

---

## 12. Out of scope / stretch (don't build now)

- Window-scoped facts (F3: facts are today/all-time on purpose; the dial owns the window).
- Auto-rotating "note of the moment" / carousel (the static sheet is the chosen shape).
- Species color/illustration thumbnails inside notes (off the ink-on-paper palette; the tag + serif
  line is the language).
- Richer NL ("…the dawn chorus swelled to X by 7am") — keep the templated sentences for v1.
- Clearest-ID / confidence fact (most IDs are 0.9+ → not interesting); civil-twilight nuance on the
  sunrise delta.
- `RETURN`/comeback facts will read as inert until the dataset is several days deep — that's expected
  (the logic ships now, activates later).

---

## Appendix A — `drawFactsSheet` + `playFactsEntrance` reference (apt.js)

> Paste near `drawDayDial`/`playDialEntrance` (~line 1024). Pure renderer over `DATA.facts`; no new
> helpers. `FACTS_MAX` and the row markup are the only tuning knobs.

```js
// ---- Field Notes: auto-generated observations about the data (right cell) ----
// Server (/api/facts) computes the ordered, deduped fact list; this is a generic
// renderer. Notes are <li data-sci> so they inherit click-to-bird (the global
// li[data-sci] delegate ~3234), hover, and the shared entrance. The sheet
// refreshes silently on the 30 s poll; a note whose text changed since the last
// render gets a small "is-new" dot (only on silent updates, never the entrance).
var FACTS_MAX = 6;          // notes shown on desktop; mobile scrolls all
var _lastFactKeys = '';     // join of kind:text from the previous render, for diffing
function drawFactsSheet(animate) {
  var host = document.getElementById('statsFacts');
  if (!host) return;
  var FX = (DATA.facts && DATA.facts.facts) || [];
  if (!FX.length) {
    host.innerHTML = '<div class="stats-tl-empty">no field notes yet</div>';
    _lastFactKeys = '';
    return;
  }
  var isMobile = (window.innerWidth || 800) <= 700;
  var shown = isMobile ? FX : FX.slice(0, FACTS_MAX);

  // Diff against the last render so a freshly-changed note can pulse — but only
  // on a silent update (animate falsy); the entrance animates everything anyway.
  var prev = _lastFactKeys ? _lastFactKeys.split('|') : [];
  function key(f) { return f.kind + ':' + f.text; }
  function fresh(f) { return !animate && _lastFactKeys && prev.indexOf(key(f)) === -1; }

  var rows = shown.map(function (f) {
    var sci = f.sci ? ' data-sci="' + String(f.sci).replace(/"/g, '&quot;') + '"' : '';
    return '<li class="fact' + (fresh(f) ? ' is-new' : '') + '"' + sci + '>'
      +   '<span class="fact-tag">' + (f.tag || '·') + '</span>'
      +   '<span class="fact-text">' + f.text + '</span>'
      + '</li>';
  }).join('');

  host.innerHTML =
    '<div class="facts-head"><h3>Field Notes</h3><small>today’s observations</small></div>'
    + '<ul class="facts-sheet">' + rows + '</ul>';

  _lastFactKeys = shown.map(key).join('|');
  if (animate) playFactsEntrance(host);
}

// Header leads, then notes stagger top-to-bottom (same feel as the side list).
function playFactsEntrance(host, lead) {
  if (!host) return;
  lead = lead || 0;
  var items = [].slice.call(host.querySelectorAll('.facts-head h3, .facts-head small, .fact'));
  if (!items.length) return;
  items.forEach(function (el, i) { el.classList.remove('entering'); el.style.animationDelay = Math.round(lead + i * 70) + 'ms'; });
  void host.offsetWidth;
  items.forEach(function (el) { el.classList.add('entering'); });
  setTimeout(function () { items.forEach(function (el) { el.classList.remove('entering'); el.style.animationDelay = ''; }); }, lead + items.length * 70 + 400);
}
```

> **Note on `f.text` injection:** common/scientific names come from BirdNET's taxonomy (DB `com`/`sci`)
> and are injected as-is, matching the existing code (`liRow` injects `s.com` directly). Consistent
> with the codebase; if you want belt-and-suspenders, escape `<>&` in `f.text` before insertion.

---

## Appendix B — Field Notes + right-toggle CSS (styles.css)

> Append after the Day Dial block (~line 1674). Clones `.stats-chart-toggle` for the right toggle and
> `.stats-side li` type for the notes. Verify dark-theme contrast (vars already flip).

```css
/* ===== Stats right cell: notes | summary toggle + Field Notes ===== */
/* Right cell becomes a column: toggle pinned top, body fills + centers (as the
   summary lists do today). */
.stats-side { display: flex; flex-direction: column; gap: 14px; justify-content: flex-start; }
.stats-side-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; justify-content: center; }

/* Toggle — clone of .stats-chart-toggle (text buttons, sliding seg-pill). */
.stats-side-toggle {
  align-self: flex-start; display: inline-flex; padding: 4px; position: relative;
  background: var(--paper-2); border-radius: 999px; box-shadow: var(--recess);
}
.stats-side-toggle button {
  background: transparent; border: 0; color: var(--ink-soft);
  font: 10px/1 ui-monospace, Menlo, monospace; letter-spacing: 0.18em; text-transform: uppercase;
  padding: 8px 14px; border-radius: 999px; cursor: pointer; position: relative; z-index: 1;
  transition: color 200ms ease;
}
.stats-side-toggle button:hover,
.stats-side-toggle button[aria-current="true"] { color: var(--ink); }

/* Field Notes sheet */
.facts-head { margin: 0 0 8px; }
.facts-head h3 {
  font: 700 10px ui-monospace, Menlo, monospace; color: var(--ink);
  letter-spacing: 0.18em; text-transform: uppercase; margin: 0 0 1px;
  border-left: 2px solid var(--accent); padding-left: 10px;
}
.facts-head small { display: block; font: 9px ui-monospace, Menlo, monospace; color: var(--ink-soft); letter-spacing: 0.06em; margin-left: 12px; }
.facts-sheet { list-style: none; margin: 0; padding: 0; overflow-y: auto; min-height: 0; }
.fact {
  display: grid; grid-template-columns: 48px 1fr; gap: 12px; align-items: baseline;
  padding: 10px 4px; box-shadow: inset 0 -1px 0 var(--hairline);
  transition: background 140ms ease;
}
.fact:last-child { box-shadow: none; }
.fact[data-sci] { cursor: pointer; }
.fact[data-sci]:hover { background: var(--paper-2); }
.fact-tag  { font: 9.5px ui-monospace, Menlo, monospace; letter-spacing: 0.12em; color: var(--accent-2); text-transform: uppercase; padding-top: 2px; }
.fact-text { font: 14px/1.45 ui-serif, "Iowan Old Style", Georgia, serif; color: var(--ink); }
/* "newly true since the last poll" — a quiet dot after the tag */
.fact.is-new .fact-tag::after {
  content: ''; display: inline-block; width: 4px; height: 4px; margin-left: 5px;
  border-radius: 50%; background: var(--accent); vertical-align: middle;
}

/* Entrance — reuse the existing @keyframes stats-fade-in */
.fact.entering, .facts-head h3.entering, .facts-head small.entering { animation: stats-fade-in 340ms ease backwards; }
@media (prefers-reduced-motion: reduce) {
  .fact.entering, .facts-head h3.entering, .facts-head small.entering { animation: none; }
}

/* Mobile: right cell already scrolls inside the grid (≤900px). Let the sheet
   claim height there rather than squishing. */
@media (max-width: 900px) {
  .stats-side-body { justify-content: flex-start; }
  .facts-sheet { overflow-y: visible; }
}
```

> Also add `.fact.entering, .facts-head h3.entering, .facts-head small.entering` to the **existing**
> `prefers-reduced-motion` block near line 532 if you prefer one consolidated guard over the local one
> above (either works; don't duplicate).

---

## Appendix C — `facts()` handler reference (worker/src/index.js)

> Paste near `stats()`/`hourly()` (~line 439–546). Reuses `localDayStart`, `tzMod` (via the `tz`
> arg), `sunArc`, and `json`. ~7–9 small queries, in priority-push order (§5.2).

```js
// ---- Field Notes (/api/facts): ordered plain-English observations ------------
// Today/all-time scoped (NOT window-scoped). Server owns all "what's interesting"
// logic; the client is a generic {kind,tag,text,sci} renderer. Times/days are
// Sudbury-local via tz/localDayStart/sunArc (never the viewer's clock).
async function facts(env, tz, now) {
  const todayStart = localDayStart(env, now);
  const offH = parseInt(env.TZ_OFFSET_HOURS ?? '0', 10) || 0;
  const first = (sql, ...b) => env.DB.prepare(sql).bind(...b).first();
  const all = async (sql, ...b) => (await env.DB.prepare(sql).bind(...b).all()).results || [];

  const out = [];
  const push = (kind, tag, text, sci) => out.push({ kind, tag, text, sci: sci || null });

  // ---- formatting helpers ----
  const hm12 = (h, m) => {                       // (4,2)->"4:02am"  (13,0)->"1pm"
    const ap = h < 12 ? 'am' : 'pm', hr = (h % 12) || 12;
    return m ? `${hr}:${String(m).padStart(2, '0')}${ap}` : `${hr}${ap}`;
  };
  const ordinal = (n) => {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };
  const fmt = (n) => (n >= 10000 ? (n / 1000).toFixed(1) + 'k' : Number(n).toLocaleString('en-US'));
  const calls = (n) => `${fmt(n)} call${n === 1 ? '' : 's'}`;

  // ---- today totals (drives most conditions) ----
  const td = await first('SELECT COUNT(*) AS n, COUNT(DISTINCT sci) AS s FROM detections WHERE ts >= ?', todayStart);
  const todayN = td ? td.n : 0, todaySpec = td ? td.s : 0;

  if (!todayN) {                                 // empty-day path — never blank
    const last = await first('SELECT com, sci FROM detections ORDER BY ts DESC LIMIT 1');
    if (last && last.com) push('quiet', 'QUIET', `No calls yet today. Last heard: ${last.com}.`, last.sci);
    else push('quiet', 'QUIET', 'No birds detected yet — the mic is listening.');
    return json({ facts: out, today: { detections: 0, species: 0 }, as_of: new Date().toISOString() });
  }

  // 1) NEW — species whose first-ever detection is today (lifers today)
  const newToday = await all(
    'SELECT sci, com, MIN(ts) AS f FROM detections GROUP BY sci HAVING f >= ? ORDER BY f ASC', todayStart);
  const newSet = new Set(newToday.map((r) => r.sci));
  if (newToday.length === 1) {
    push('new', 'NEW', `New today: ${newToday[0].com} — first time at this yard.`, newToday[0].sci);
  } else if (newToday.length > 1) {
    // Optional softener (young box): if every species today is "new", reword:
    //   if (newToday.length === todaySpec) push('new','NEW',`First full day — ${todaySpec} species so far.`); else …
    const names = newToday.slice(0, 3).map((r) => r.com);
    const extra = newToday.length - names.length;
    push('new', 'NEW', `${newToday.length} new species today: ${names.join(', ')}${extra ? `, +${extra} more` : ''}.`);
  }

  // 2) DAWN — first call today (+ minutes before/after sunrise)
  const fc = await first(
    `SELECT com, sci,
            CAST(strftime('%H', ts, 'unixepoch', ?) AS INT) AS h,
            CAST(strftime('%M', ts, 'unixepoch', ?) AS INT) AS m
       FROM detections WHERE ts >= ? ORDER BY ts ASC LIMIT 1`, tz, tz, todayStart);
  if (fc) {
    const sun = sunArc(env, new Date((now + offH * 3600) * 1000), offH);
    let tail = '.';
    if (sun && sun.sunrise != null) {
      const mins = Math.round((sun.sunrise - (fc.h + fc.m / 60)) * 60);
      if (mins >= 5) tail = ` — ${mins} min before sunrise.`;
      else if (mins <= -5) tail = ` — ${-mins} min after sunrise.`;
    }
    push('dawn', 'DAWN', `First call today: ${fc.com} at ${hm12(fc.h, fc.m)}${tail}`, fc.sci);
  }

  // by-hour today (drives PEAK + QUIET)
  const byHour = await all(
    `SELECT CAST(strftime('%H', ts, 'unixepoch', ?) AS INT) AS h, COUNT(*) AS n
       FROM detections WHERE ts >= ? GROUP BY h`, tz, todayStart);

  // 3) PEAK — busiest local hour today
  if (byHour.length) {
    let pk = byHour[0];
    for (const r of byHour) if (r.n > pk.n) pk = r;
    push('peak', 'PEAK', `Busiest hour: ${hm12(pk.h, 0)} — ${calls(pk.n)}.`);
  }

  // 4) TOP — most-heard species today (+ share)
  const top = await first(
    'SELECT com, sci, COUNT(*) AS n FROM detections WHERE ts >= ? GROUP BY sci ORDER BY n DESC LIMIT 1', todayStart);
  if (top) {
    const pct = Math.round((top.n / todayN) * 100);
    push('top', 'TOP', `Most heard today: ${top.com} — ${calls(top.n)} (${pct}% of today).`, top.sci);
  }

  // 5) RARE — rarest (lowest all-time) species heard today, if scarce & not already NEW
  const rare = await first(
    `SELECT sci, com, COUNT(*) AS total, MAX(CASE WHEN ts >= ? THEN 1 ELSE 0 END) AS today
       FROM detections GROUP BY sci HAVING today = 1 ORDER BY total ASC LIMIT 1`, todayStart);
  if (rare && rare.total <= 5 && !newSet.has(rare.sci)) {
    push('rare', 'RARE', `Seldom heard: ${rare.com} — only its ${ordinal(rare.total)} time ever.`, rare.sci);
  }

  // 6) RETURN — heard today after a ≥3-day absence (activates as the dataset ages)
  const back = await first(
    `SELECT d.sci, d.com, MIN(d.ts) AS firstToday, p.prev AS prev
       FROM detections d
       JOIN (SELECT sci, MAX(ts) AS prev FROM detections WHERE ts < ? GROUP BY sci) p ON p.sci = d.sci
      WHERE d.ts >= ?
      GROUP BY d.sci
      ORDER BY (MIN(d.ts) - p.prev) DESC LIMIT 1`, todayStart, todayStart);
  if (back && back.prev != null) {
    const days = Math.floor((back.firstToday - back.prev) / 86400);
    if (days >= 3) push('return', 'RETURN', `${back.com} is back — first time in ${days} days.`, back.sci);
  }

  // 7) NOW — last hour
  const lh = await first('SELECT COUNT(*) AS n, COUNT(DISTINCT sci) AS s FROM detections WHERE ts >= ?', now - 3600);
  if (lh && lh.n > 0) push('now', 'NOW', `Last hour: ${calls(lh.n)} from ${lh.s} species.`);

  // 8) QUIET — longest silent run of clock-hours today (cyclic, wraps midnight)
  {
    const bins = new Array(24).fill(0);
    for (const r of byHour) bins[r.h] = r.n;
    let best = 0, bestStart = -1, cur = 0, curStart = -1;
    for (let i = 0; i < 48; i++) {                // 2× pass handles the wrap
      const h = i % 24;
      if (bins[h] === 0) { if (cur === 0) curStart = h; cur++; if (cur > best && cur <= 24) { best = cur; bestStart = curStart; } }
      else cur = 0;
    }
    if (best >= 3 && best < 24) {
      const endH = (bestStart + best) % 24;        // exclusive end = first active hour
      push('quiet', 'QUIET', `Quietest stretch: ${hm12(bestStart, 0)}–${hm12(endH, 0)}.`);
    }
  }

  // 9) TALLY — variety today
  push('tally', 'TALLY', `${todaySpec} species today across ${calls(todayN)}.`);

  // 10) MILE — days listening (always-true fallback)
  const span = await first('SELECT MIN(ts) AS first FROM detections');
  const allN = (await first('SELECT COUNT(*) AS n FROM detections')).n;
  if (span && span.first != null) {
    const dayNo = Math.floor((now - span.first) / 86400) + 1;
    push('mile', 'MILE', `Day ${dayNo} of listening — ${calls(allN)} logged in all.`);
  }

  return json({ facts: out, today: { detections: todayN, species: todaySpec }, as_of: new Date().toISOString() });
}
```

> **Verify after deploy:** the `RETURN` join uses a correlated subquery for each species' last
> detection strictly before today; on a 1–2-day box it returns nothing (no ≥3-day gaps yet) — that's
> correct, not a bug. The `QUIET` cyclic scan must report e.g. `12am–4am` for 2026-06-20 (hours 0–3
> silent), not a wrapped/garbled range — eyeball it against `/api/hourly`.
