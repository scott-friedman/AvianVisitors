# MOBILE-TODO.md — make the phone experience match the desktop one

> **For a cold-start session:** this is an ordered, ready-to-execute plan. Everything you
> need (file paths, line anchors, exact CSS/JS, and a verify step) is inline. The audit is
> done — you are implementing, not re-discovering. Work top-to-bottom; each item is
> independent, so you can ship in batches. All changes are in **`avian/frontend/`**
> (`styles.css`, `index.html`, `apt.js`); rebuild with `avian/build-site.sh` and redeploy
> Pages (see "Verification" at the bottom). **No Pi or Worker changes** — this is frontend-only.

---

## Plain English Summary (non-technical)

"Barry's Birds" is one website that runs on both computers and phones — there is no separate
mobile app. It already *works* on a phone (you can see the collage, open a bird, play its
call, read the stats), so nothing is broken. But it was clearly designed mouse-first, and a
handful of small things make it feel slightly off on a phone:

- **Buttons sit too close to the screen edges.** On modern iPhones the bottom row of buttons
  (collage / stats / atlas) can tuck under the home-bar, and the top buttons can slide under
  the camera notch when the phone is sideways. We need to nudge them inward automatically.
- **Tapping the password box zooms the page in** (and doesn't zoom back out cleanly). A
  one-line text-size fix stops that.
- **Some buttons are tiny** — the little 1H/12H/24H/7D/ALL time picker and the three sort
  icons are easy to mis-tap with a thumb. We make their tap area bigger without making them
  look bigger.
- **The three sort icons (most-heard / most-recent / A–Z) have no label on a phone.** Their
  name only appears when you hover a mouse, which never happens on a touchscreen, so a phone
  user can't tell them apart. We give them a visible label.
- **A few "polish" glitches:** a grey flash when you tap things, buttons that stay
  "highlighted" after you tap them, and the close-X on a long bird pop-up scrolling out of
  reach. Each is a small, low-risk fix.

None of this changes how the site looks on a computer. The goal is parity: a phone visitor
should get the same calm, legible experience a desktop visitor gets. Estimated effort:
**~half a day**, almost entirely CSS.

---

## What was audited & what's already good

**Audited:** `index.html` (layout + viewport), `styles.css` (all 1733 lines, every `@media`
block), and the interaction code in `apt.js` (event wiring — the file is 819 KB but ~95% is an
inlined data blob on line 257; real code is lines 1–256 + 258–3347).

**Already correct — do not touch:**
- Viewport meta is right: `width=device-width,initial-scale=1,viewport-fit=cover`, and zoom is
  **not** disabled (no `user-scalable=no`) — keep it that way for accessibility (`index.html:5`).
- Modal scroll-lock is solid: `body.overflow='hidden'` on open (`apt.js:2336`) **and** restored
  on close (`apt.js:2413`); Escape + backdrop close both work (`apt.js:2928`, `data-close`).
- Tap-to-open works on touch: collage tile tap (`apt.js:865`), atlas card / stats row / timeline
  column all route through `jumpToSci` (`apt.js:3326`) via a real `click` delegate — synthesized
  taps fire these fine.
- The recording-spectrogram **scrubber already has dual mouse + touch handlers** with
  `{passive:false}` + `preventDefault` (`apt.js:3296-3309`). **This is the reference pattern** —
  copy its shape if any other drag interaction ever needs touch.
- Atlas already has a real mobile layout: 2-up grid, inline chips hidden, whole card is the tap
  target → modal (`styles.css:844-859`). Parity is preserved through the modal.
- `-webkit-overflow-scrolling: touch` is present on the two horizontal/inner scrollers
  (`styles.css:618, 1672`).

**The gap in one sentence:** the code branches responsively by *width* (`@media (max-width:700px)`,
`innerWidth<=700` in JS) but never by *input type* — there is **no `@media (hover:hover)` /
`(pointer:coarse)` and no `env(safe-area-inset-*)` anywhere** — so mouse-only affordances and
edge-to-edge insets were never handled.

---

## Priority table

| # | Priority | Item | Type | Files |
|---|----------|------|------|-------|
| 1 | **P0 — real device breakage** | Safe-area insets for all fixed chrome | CSS | styles.css |
| 2 | **P0 — real device breakage** | Stop iOS zoom-on-focus of the password input | CSS | styles.css |
| 3 | **P1 — usability** | Enlarge touch targets to ≥44 px hit area | CSS | styles.css |
| 4 | **P1 — usability** | Label the icon-only atlas sort buttons on touch | CSS | styles.css |
| 5 | **P1 — usability** | Keep the modal close-X reachable on long modals | CSS | styles.css |
| 6 | **P1 — correctness** | `100dvh` for modal/menu max-height (iOS address bar) | CSS | styles.css |
| 7 | **P2 — polish** | Kill the grey tap-highlight flash | CSS | styles.css |
| 8 | **P2 — polish** | Don't let hover transforms stick after a tap | CSS | styles.css |
| 9 | **P2 — polish** | `overscroll-behavior: contain` on scroll containers | CSS | styles.css |
| 10 | **P2 — polish** | Dismiss the day-dial tooltip on outside tap | JS | apt.js |
| 11 | **Verify visually** | Collage fill (portrait + landscape) & short-landscape header | — | — |

A single new CSS block (a `@media (hover:none),(pointer:coarse)` section appended to
`styles.css`) covers items 3, 4, 7, and 8 cleanly — see "Consolidated touch block" below. Items
1, 2, 5, 6, 9 are edits to existing rules.

---

## P0 — fixes that visibly break on real phones

### 1. Safe-area insets for every fixed element

**Why (mobile):** `viewport-fit=cover` makes the page draw under the notch / Dynamic Island and
the home indicator, but **no rule reads `env(safe-area-inset-*)`** (verified: 0 occurrences). So:
the bottom nav (`.slider`, `bottom:14px` on mobile) sits under the home-bar and is awkward to tap;
the top window-picker (`.top`, `top:12px`, `padding:0 12px`) slides under the notch in landscape;
the menu drawer and modals butt against the edges.

**Change (`styles.css`):** add the inset to each fixed element's offset. Use `max()` so it's a
no-op on devices with zero insets (older phones, desktop).

- `.top` (base `:105`, mobile `:137`): 
  `top: max(12px, env(safe-area-inset-top));` and
  `padding-left: max(12px, env(safe-area-inset-left)); padding-right: max(12px, env(safe-area-inset-right));`
- `.slider` (base `:151`, mobile `:1170`): `bottom: calc(14px + env(safe-area-inset-bottom));`
- `.return-to-atlas` (base `:1007`, mobile `:144`): add `env(safe-area-inset-top)` / `-left`.
- `#menu-dd` (base `:181`, mobile `:1157`): fold insets into `top` / `right` / `left`.
- `#detail-modal` + `#about-modal` padding (`:1245`, `:1193`, mobile `:1175`): 
  `padding: max(12px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) max(12px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left));`
- `.admin-screen` inset (`:986`, mobile `:1158`): add top/bottom insets (admin is desktop-mostly —
  lowest urgency, but trivial while you're here).

**Verify:** iPhone with a notch (or Chrome DevTools → device with "show device frame"), portrait
**and** landscape: the bottom nav clears the home-bar; the top picker clears the notch in landscape.

### 2. Stop iOS zooming in when the password field is focused

**Why (mobile):** iOS Safari auto-zooms when you focus an input whose `font-size < 16px`, and
doesn't reliably zoom back out — leaving the page zoomed/scrolled. The menu's unlock field is
**13 px** (`.lock-row input`, `styles.css:198-202`). (The admin log toolbar inputs are 12 px,
`:1088` — desktop-mostly, fix too while here.)

**Change:** set `.lock-row input { font-size: 16px; }` (override the `font:13px…` shorthand with a
later `font-size`, or bump the shorthand). Optionally the same on `.admin-logs-toolbar input,
.admin-logs-toolbar select`.

**Verify:** iOS Safari → open menu → tap the password field → page must **not** zoom.

---

## P1 — usability parity

### 3. Touch targets ≥ ~44 px hit area

**Why (mobile):** Apple's guideline is 44×44 px; these are well under and get mis-tapped by a
thumb (measured from padding + font):
- `.top .window-pick button` ~20 px tall (`:140`, `:147`) — five buttons in a ~140 px pill.
- `.slider button` ~22 px tall (`:1171`).
- `.atlas-sort button` 26 px (`:816`); `.pose-toggle button` 26 px (`:1322`).
- `.modal-close` 30 px (`:1281`); `.rec-row .play` 24 px (`:1495`).

**Change:** keep the *visual* size; grow the *hit* area. Put these in the consolidated
`@media (hover:none),(pointer:coarse)` block (below): set `min-height:44px` (and `min-width:44px`
for icon buttons) with `display:inline-flex;align-items:center;justify-content:center`. For the
icon buttons (`.atlas-sort button`, `.pose-toggle button`, `.modal-close`, `.rec-row .play`),
keep the small visual glyph but expand the box to 40–44 px. For the window-picker, increase
vertical padding to reach ~40 px and let the row breathe.

> **Watch the window-picker width:** five buttons (1H/12H/24H/7D/ALL) at a bigger tap size may
> overflow a 360 px screen. If it does, either (a) reduce inter-button gap / horizontal padding,
> or (b) drop `12H` on the narrowest breakpoint (`@media (max-width:380px)`) — confirm with Scott
> before removing a window. Do **not** shrink font below the current 8 px.

**Verify:** thumb-tap each control on a real phone; no mis-fires; the window picker doesn't wrap or
clip at 360 px width.

### 4. Label the icon-only atlas sort buttons on touch

**Why (mobile):** `.atlas-sort` is three **icon-only** buttons (bars / clock / "A"). Their names
live only in a hover tooltip (`.atlas-sort button:hover .tip`, `styles.css:824-833`) — hover never
fires on touch, so a phone user cannot tell most-heard from most-recent from A–Z. (`aria-label`
exists for screen readers, but sighted touch users get nothing.)

**Change (pick one; A recommended for least redesign):**
- **A (minimal):** in the touch block, reveal only the **active** sort's label persistently:
  `.atlas-sort button[aria-current="true"] .tip { opacity:1; }` and reposition it so it doesn't
  overlap (e.g. static caption below the pill). The user sees the current mode; tapping cycles and
  the list re-sorts visibly.
- **B (fuller parity):** convert `.atlas-sort` to a **text** segmented control like the stats
  toggles already use (`heard / recent / a–z`), matching `.stats-chart-toggle` (`:1612`). More work,
  clearest result.

**Verify:** on a phone, the atlas sort control communicates what each option does without a mouse.

### 5. Keep the modal close-X reachable on long modals

**Why (mobile):** `.modal-close` is `position:absolute; top:16px` **inside the scrolling card**
(`styles.css:1278`, card `overflow:auto` `:1268`). A bird with many recordings makes the card tall;
scrolling down moves the × off-screen. (Backdrop-tap and Escape still close it, but there's no
Escape key on a phone and the backdrop may be fully covered.)

**Change:** on mobile, pin the close to the viewport instead of the scroll content:
`.modal-close { position: fixed; top: max(12px, env(safe-area-inset-top)); right: 16px; }` inside the
`max-width:700px` block (the modal is effectively full-screen there, so fixed reads correctly).
Keep `z-index` above the card.

**Verify:** open a bird with many recordings on a phone, scroll to the bottom, confirm × stays put
and closes the modal.

### 6. `100dvh` for modal & menu max-height

**Why (mobile):** `.modal-card { max-height: calc(100vh - 48px) }` (`:1260`) and
`#menu-dd { max-height: calc(100vh - 80px) }` (`:184`) use `100vh`, which on iOS counts the area
*behind* the address bar — so the element can be taller than what's visible, hiding the bottom of
the content/close.

**Change:** use the dynamic viewport unit with a `vh` fallback:
```css
.modal-card { max-height: calc(100vh - 48px); max-height: calc(100dvh - 48px); }
#menu-dd    { max-height: calc(100vh - 80px); max-height: calc(100dvh - 80px); }
```
(Two declarations; browsers without `dvh` ignore the second.)

**Verify:** iOS Safari with the address bar visible — the modal's bottom and the menu's bottom items
are reachable.

---

## P2 — polish & feel

### 7. Kill the grey tap-highlight flash
**Why:** every tap on a button/card flashes the default mobile highlight box. **Change:** one line —
`html { -webkit-tap-highlight-color: transparent; }` (the app already supplies its own
`:active`/pressed states). Put it in the touch block or at the top of `styles.css`.

### 8. Don't let hover transforms stick after a tap
**Why:** iOS keeps `:hover` applied to a tapped element until you tap elsewhere, so
`translateY(-1px)` hover lifts "stick." The movers are: `.menu-btn:hover` (`:133`),
`.bird-card:hover` (`:871`), `.bird-card .chip:hover` (`:936`), `.menu-links a:hover` (`:474`),
`.modal-actions .chip:hover` (`:1537`). **Change:** wrap these *transform* hover rules in
`@media (hover:hover)` so touch never applies them. (Color-only hovers don't visibly stick — leave
them.) Cleanest: move the transform-bearing `:hover` rules under one `@media (hover:hover){…}`.

### 9. `overscroll-behavior: contain` on scroll containers
**Why:** without it, scrolling to the end of an inner scroller chains to the page / rubber-bands.
**Change:** add `overscroll-behavior: contain;` to `.view` (`:95`, atlas scroll), `.stats-grid`
mobile (`:1672`), `#menu-dd` (`:184`), `.modal-card` (`:1268`), `.modal-recordings ol` (`:1403`),
`.stats-timeline` (`:618`).

### 10. Dismiss the day-dial tooltip on outside tap (JS)
**Why:** dial petals show their tooltip via a `click` fallback (`apt.js:1079`) — good — but nothing
hides it on touch (no `mouseleave`), so the last-tapped tooltip lingers. **Change:** in
`wireDialHover` (`apt.js:1066-1082`), after wiring petals, add a one-time document handler:
hide `tip` and clear `.is-hover` when a tap lands outside any `.dial-petal`. Mirror the menu's
outside-click dismissal (`apt.js:1702`). Small, self-contained.

---

## 11. Verify visually (not assumptions — confirm on device)

These looked plausibly fine in code but depend on rendering; confirm and only adjust if needed:

- **Collage fill, portrait:** the weight-packed nester targets a `max-width:1300px` cluster
  (`.gcollage`, `styles.css:498`) inside a `overflow:hidden` no-scroll view. On a tall, narrow
  phone, confirm tiles fill the space without giant gaps or hair-thin birds. If off, tune the
  nester's min tile size / `max-width` for narrow viewports (JS `renderCollage`, `apt.js:477`).
- **Collage fill, landscape & short viewports:** the mobile header reserves a large top pad
  (`.static-head { padding:96px 18px 22px }`, `:87`) to clear the fixed top bar. On a short
  landscape phone (e.g. 667×375) confirm the collage/stats aren't squeezed to nothing between the
  header and the bottom nav; if so, reduce the header pad under
  `@media (max-height:480px)` / landscape.
- **Stats view scroll on small screens:** `<900px` switches stats to a single column that scrolls
  inside the fixed view (`:1671`). Confirm the dial + side panel scroll smoothly and nothing
  overlaps.

---

## Consolidated touch block (covers items 3, 4, 7, 8)

Append one block to `styles.css` — this is the missing primitive (input-type media), complementary
to the existing width breakpoints:

```css
/* ============ Touch / coarse-pointer refinements ============
   The rest of the file branches by WIDTH; these branch by INPUT TYPE.
   Covers: ≥44px tap targets, persistent labels for icon-only controls,
   no sticky hover, no tap-highlight flash. Desktop is unaffected. */
@media (hover: none), (pointer: coarse) {
  html { -webkit-tap-highlight-color: transparent; }

  /* ≥44px hit areas (keep glyphs small, grow the box) */
  .slider button { min-height: 44px; }
  .top .window-pick button { min-height: 40px; }
  .atlas-sort button,
  .pose-toggle button { width: 40px; height: 40px; }
  .modal-close { width: 40px; height: 40px; }
  .rec-row .play { width: 32px; height: 32px; }

  /* Item 4 — show the active atlas sort's label (option A) */
  .atlas-sort button[aria-current="true"] .tip { opacity: 1; }
}

/* Item 8 — transform lifts only where a real pointer can hover */
@media (hover: hover) {
  .menu-btn:hover            { transform: translateY(-1px); }
  .bird-card:hover           { transform: translateY(-1px); box-shadow: var(--edge-xl, 0 6px 16px rgba(26,22,18,0.12)); }
  .bird-card .chip:hover     { transform: translateY(-1px); }
  .menu-links a:hover        { transform: translateY(-1px); }
  .modal-actions .chip:hover { transform: translateY(-1px); }
}
```
…then **remove** the `transform: translateY(-1px)` from the five base `:hover` rules listed in item
8 (leave their color changes). Tune the `.atlas-sort .tip` positioning so the persistent active
label doesn't overlap the cards.

---

## Verification protocol (per item + final pass)

**Preview locally with device emulation:**
```bash
bash avian/build-site.sh                       # assembles _site/ (pulls live data from the worker in config.js)
cd _site && python3 -m http.server 8787        # then open http://localhost:8787
```
Open Chrome DevTools → Device Toolbar (Cmd-Shift-M) → test **iPhone (notch), Pixel, and an iPad**,
in **portrait and landscape**. Toggle "show device frame" to see safe areas. For true safe-area /
iOS-zoom behavior, also load the **live** site on a real iPhone:
`https://barrysbirds.pages.dev` (already serves this build).

**Regression guard (desktop must be unchanged):** load at a desktop width with a mouse — hover
lifts, tooltips, collage hover pill, and cross-highlight all still work (the `@media (hover:hover)`
guard preserves them).

**Per-view smoke test on a phone (parity check):**
- Collage: tiles fill the screen; tap a bird → atlas opens that card → its modal.
- Top picker: 1H/12H/24H/7D/ALL each tappable; collage/stats re-scale.
- Stats: dial petal tap shows + dismisses tooltip; species/timeline toggle; notes/summary toggle;
  single-column scroll is clean.
- Atlas: 2-up grid; sort control is labeled; tap card → modal; play a recording; scrub the
  spectrogram with a finger; close-X reachable after scrolling.
- Menu: opens, password field doesn't zoom the page, LISTEN plays live audio.

**Ship:**
```bash
cd worker && wrangler pages deploy ../_site --project-name barrysbirds --branch production
```
(Run from `worker/` so the local wrangler resolves — per CLAUDE.md.)

---

## Out of scope / explicitly leave alone

- **No swipe-between-views gesture.** The bottom slider is the nav metaphor; adding horizontal
  swipe risks fighting the timeline's horizontal scroll and the spectrogram scrub. Note as a
  possible future nicety, don't build it in this pass.
- **No collage "tip on tap."** On touch a tap navigates immediately, so the desktop hover pill
  (windowed count) is moot — the same number is in the modal. Accept the difference; don't add a
  two-tap flow.
- **Don't disable zoom** (`user-scalable=no`) to dodge the input-zoom bug — fix the font-size
  instead (item 2). Pinch-zoom must stay for accessibility.
- **No JS framework / responsive rewrite.** This is a targeted CSS-first pass; keep the existing
  width-breakpoint structure and add the input-type layer alongside it.
- **Pi / Worker / D1 / R2 untouched.** Frontend-only.
```
