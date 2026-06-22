# FRAME-WINDOW-TOGGLE-PLAN.md

**Goal:** add a menu control on the website that lets a person choose which **time
window** the physical e-ink frame shows — **1H / 12H / 24H / 7D / ALL** — replacing
today's hard-coded 24-hour window.

**Status:** planned, not built. All decisions resolved (see below). This doc is
self-contained — a cold-start session should be able to execute it without
re-researching. Anchors (`file:line`) were accurate as of 2026-06-22; re-confirm
before editing.

---

## Plain English Summary (non-technical)

The picture frame always shows the birds heard in the **last 24 hours** — that number
is hard-coded; nobody can change it without editing code and redeploying. We're adding
a switch on the website menu (1H / 12H / 24H / 7D / ALL) that changes what the
**physical frame** shows.

The reason this needs a real plan and not a one-line tweak: the frame's picture is a
**screenshot of the website** taken in the cloud. So three things have to agree on the
chosen number — the screenshot, the cloud's "has the picture changed?" check, and the
little program on the Pi that decides when to fetch a fresh image. The plan wires all
three to one shared setting stored in the cloud database.

Two clarifications:
- This is **separate** from the 1H/12H/24H buttons at the **top of the web page**.
  Those only change what *you* see on *your* phone (saved in your browser) and never
  touch the frame. The new menu control is a **single shared setting for the physical
  panel** — whoever flips it changes the frame for everyone.
- After someone flips it, the frame updates on its next check-in (**≤ 5 minutes**).

---

## Decisions (all resolved)

1. **Write auth: OPEN (no password).** Anyone who can reach the public site can change
   the frame window. Acceptable: it only writes a *number* to the DB; it cannot burn the
   metered screenshot budget (rendering still requires the `FRAME_KEY` only the Pi has)
   and touches nothing sensitive; it's reversible with one tap. If ever abused, add a
   gate later (see "Optional hardening").
2. **Storage: D1 singleton `settings` table.** Matches the existing `frame_cache` /
   `heartbeat` single-row pattern; no new Cloudflare resource, no CI-token change. (KV
   rejected — new infra for no benefit.)
3. **Pi propagation: low-churn fold-in.** The Pi reads the window from a new
   `GET /api/frame-config` and hashes `/api/recent?hours={that window}` instead of a
   fixed 24h, so its change-detector tracks exactly what the frame shows. (ETag
   conditional-GET is a cleaner long-term alternative but touches the Pi's HTTP layer
   more — not chosen for v1.)
4. **Window options: all five — 1H / 12H / 24H / 7D / ALL** (mirrors the top-bar
   picker: `data-h` = `1 / 12 / 24 / 168 / 1000000`). Revisit only if `ALL` looks too
   dense on the 800×480 panel in person.

---

## How it works today (the 3 facts that shape the plan)

1. **The frame image is a screenshot of the website.** `worker/src/index.js:370`
   (`renderFrame`) launches a headless browser, navigates to `FRAME_URL`
   = `https://barrysbirds.pages.dev/?frame=1` (`worker/wrangler.toml:43`), and
   screenshots it at 800×480.

2. **That screenshot's window comes from the page's own JS, not the Worker's DB query.**
   When the headless browser loads the page, `avian/frontend/apt.js:158` runs
   `currentHours = +readLS('bird:window','24') || 24`. The headless browser has **no
   localStorage**, so it always falls back to **24**. The Worker's separate D1 query at
   `worker/src/index.js:343` (`since = now - 24 * 3600`) feeds **only the cache
   signature** (hit/miss) — *not* the picture.
   → **Crux: to change what's drawn we must pass the window into the page URL; to keep
   the cache correct we must also pass it into the Worker's signature. Both.**

3. **The Pi decides when to pull a new frame by hashing a fixed 24h window.**
   `frame/display.py:260` hashes `/api/recent?hours={cfg.hours}` (default 24) and only
   pulls `/frame.png` when that hash changes (or every 24h "heal"). If we change the
   frame's window but the Pi keeps hashing 24h, **it won't notice and won't pull.**
   Decision 3 fixes this.

Supporting facts confirmed during research:
- D1 (`avian-detections`) is bound as `DB` (`worker/wrangler.toml:11-14`). **No KV exists.**
- Migrations live in `worker/migrations/` (`0001`–`0004`); apply via
  `worker/package.json` scripts `migrate:local` / `migrate:remote`
  (`wrangler d1 migrations apply avian-detections [--local|--remote]`).
- `/frame.png` already emits `ETag: "<sig>"` (`worker/src/index.js:328`) — relevant only
  to the rejected ETag alternative.
- The menu's "unlock" box (`avian/frontend/index.html:59`, `apt.js:1761`) is a **dead
  stock relic** — it POSTs to `./avian/api/menu.php`, PHP that doesn't exist on Pages
  (Pages serves a 200 HTML fallback, so it silently fails). The new control must go in
  the **always-visible** drawer area, NOT behind the unlock and NOT in `#dd-items`
  (which only populates after the dead unlock succeeds).
- `?frame=1` mode strips chrome via an inline script (`avian/frontend/index.html:13-32`).
  Adding `&window=N` is the natural extension.

---

## Implementation

### A. Database — new migration
Create `worker/migrations/0005_settings.sql` (mirrors the `frame_cache`/`heartbeat`
singleton pattern):

```sql
CREATE TABLE IF NOT EXISTS settings (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  frame_window_hours INTEGER NOT NULL DEFAULT 24
);
INSERT OR IGNORE INTO settings (id, frame_window_hours) VALUES (1, 24);
```

Apply:
```bash
cd worker
npm run migrate:local    # dev D1
npm run migrate:remote   # prod D1
```

### B. Worker (`worker/src/index.js`)

1. **Helper** — read the setting, default + validate:
   ```js
   const FRAME_WINDOWS = [1, 12, 24, 168, 1000000];
   async function getFrameWindow(env) {
     const row = await env.DB.prepare('SELECT frame_window_hours AS h FROM settings WHERE id = 1').first();
     const h = row && Number(row.h);
     return FRAME_WINDOWS.includes(h) ? h : 24;
   }
   ```

2. **`frame()` (lines 342-347)** — use the stored window for both the data query and the
   cache signature:
   ```js
   const now = Math.floor(Date.now() / 1000);
   const windowHours = await getFrameWindow(env);
   const since = now - windowHours * 3600;
   const rows = (await env.DB.prepare(
     'SELECT sci, COUNT(*) AS n FROM detections WHERE ts >= ? GROUP BY sci'
   ).bind(since).all()).results || [];
   const sig = await frameSignature(rows, windowHours);   // window folded in
   ...
   png = await renderFrame(env, windowHours);             // pass it through (see #4)
   ```

3. **`frameSignature` (307-314)** — fold the window into the hashed payload so switching
   windows always busts `frame_cache` even if the species set coincides:
   ```js
   async function frameSignature(rows, windowHours) {
     const items = rows
       .map((r) => [frameSlug(r.sci), frameBucket(Number(r.n) || 1)])
       .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
     const data = new TextEncoder().encode(JSON.stringify({ w: windowHours, items }));
     const digest = await crypto.subtle.digest('SHA-256', data);
     return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
   }
   ```

4. **`renderFrame(env)` → `renderFrame(env, windowHours)` (370-392)** — add the window to
   the screenshot URL so the page draws the right collage:
   ```js
   const target = new URL(env.FRAME_URL);        // already carries ?frame=1
   target.searchParams.set('window', windowHours);
   await page.goto(target.toString(), { waitUntil: 'load', timeout: 30000 });
   ```

5. **`GET /api/frame-config`** — add a case to the `queryApi` switch (~456-468):
   ```js
   case 'frame-config': return json({ window_hours: await getFrameWindow(env) });
   ```
   (Reachable as `/api/frame-config` via the `path.startsWith('/api/')` dispatch at line 103.)

6. **`POST /api/frame-config`** — add to the top-level router next to the other POSTs
   (~84). Open (no auth), validated, returns the new value:
   ```js
   if (path === '/api/frame-config' && request.method === 'POST') {
     const body = await request.json().catch(() => ({}));
     const h = Number(body.window_hours);
     if (!FRAME_WINDOWS.includes(h)) return json({ error: 'bad window_hours' }, 400);
     await env.DB.prepare(
       'INSERT OR REPLACE INTO settings (id, frame_window_hours) VALUES (1, ?)'
     ).bind(h).run();
     return json({ window_hours: h });
   }
   ```
   Ensure the response carries CORS headers (reuse the `CORS` const; OPTIONS preflight is
   already handled at line 70).

### C. Frontend

1. **`avian/frontend/apt.js:158`** — honor a `?window=` URL param (this is what makes the
   headless screenshot use the chosen window):
   ```js
   function urlWindow() {
     try {
       var w = +new URLSearchParams(location.search).get('window');
       return [1, 12, 24, 168, 1000000].indexOf(w) >= 0 ? w : 0;
     } catch (e) { return 0; }
   }
   var currentHours = urlWindow() || +readLS('bird:window', '24') || 24;
   ```

2. **New menu control** — add a segmented picker to the **always-visible** area of
   `#menu-dd` (`avian/frontend/index.html:57`), as a sibling of `#dd-locked` (NOT inside
   `#dd-items`). Clone the markup of `#winPick` (`index.html:46-53`) and the wiring
   pattern of the window picker (`apt.js:157-170`). Label it clearly as the **physical /
   shared frame** setting to distinguish it from the per-device top-bar picker. Behaviour:
   - On menu open (or page load): `GET /api/frame-config` → set the active button.
   - On click: `POST /api/frame-config {window_hours:N}` → optimistic active-state + a
     small "frame updates within ~5 min" confirmation.
   - This is a **global** setting — do **not** store it in localStorage and do **not**
     wire it to `currentHours`/`refreshRecent` (that's the separate per-device picker).

   Note: the menu currently shows only the dead unlock box; this control will be the
   first genuinely-working menu item.

### D. Pi (`frame/display.py`) — Decision 3 (low-churn fold-in)

In `run()` (lines 256-263), replace the static-window signature so the Pi tracks the
chosen window:
```python
win = fetch_frame_window(cfg["base_url"], cfg["timeout"], _auth(cfg)) or cfg["hours"]
sig = signature(fetch_recent(cfg["base_url"], win, cfg["timeout"], _auth(cfg))) + ":" + str(win)
```

Add a `fetch_frame_window()` helper (GET `/api/frame-config`, parse `window_hours`,
return int or None). **It MUST set a `User-Agent` header** — the Worker `403`s the
default urllib UA (project gotcha). Copy the header pattern from `fetch_recent`
(~`display.py:101`). No systemd/cadence change; propagation is ≤ the existing 5-min
timer (`frame/systemd/birdframe.timer`).

---

## Testing & verification

- **Visual path, no hardware:** open
  `https://barrysbirds.pages.dev/?frame=1&window=12` in a normal browser and confirm the
  collage reflects 12h (then try `window=1`, `window=168`, `window=1000000`).
- **Panel look, no panel:** `python3 frame/display.py --preview out.png`.
- **Worker (local):** `cd worker && npm run dev` with local D1.
  - `POST /api/frame-config {window_hours:12}` → `GET /api/frame-config` returns 12.
  - `GET /frame.png?k=...` → header `X-Frame-Cache: miss` first, then `hit`.
  - Flip the window → next `/frame.png` is a fresh `miss` (cache busted by the folded sig).
  - `POST {window_hours:5}` → `400 bad window_hours` (validation).
- **End-to-end:** flip the menu control → within ~5 min the Pi logs
  `refresh: changed` and the panel updates.

---

## Risks & gotchas

- **Browser Rendering budget** (free tier ≈ 10 min/day): each render is ~1-2s and the
  signature cache absorbs repeats; even frequent toggling stays within budget because
  only the Pi (every 5 min, `FRAME_KEY`-gated) triggers renders.
- **Two windows, identical content** would cache-collide → handled by folding
  `windowHours` into the signature (B3).
- **Don't reuse the top-bar `#winPick`** — it's per-device localStorage and never reaches
  the frame. The new control is its own server-backed global setting.
- **Don't hang the toggle off the unlock** — it targets non-existent `menu.php`.
- **Pi UA header** — `fetch_frame_window` must set `User-Agent` or it silently 403s.
- **`?window=` validation** — both Worker (POST) and `apt.js` (`urlWindow`) restrict to
  the five allowed values; reject anything else.

## Rollback

Trivial and independent per layer:
- Worker: revert `frame()` to the constant `since = now - 24 * 3600` and drop the helper.
- Pi: falls back to `cfg["hours"]` automatically if `/api/frame-config` is absent/unreachable.
- The `settings` table and endpoints are inert if unused.

## Optional hardening (only if the open write is ever abused)

Gate `POST /api/frame-config` with a shared secret: add `FRAME_ADMIN_SECRET`
(`wrangler secret put`), check an `X-Frame-Admin` header in the POST handler, and revive
the existing `#unlockForm` UI (`apt.js:1770`) to capture the secret once into
localStorage and send it on writes. Keep `GET /api/frame-config` open.

---

## Scope summary

1 new migration, ~5 edits in `worker/src/index.js`, ~2 edits across
`avian/frontend/apt.js` + `index.html`, ~8 lines in `frame/display.py`. **No new
Cloudflare resources, no CI-token changes.** Deploy order: migration → Worker → Pages
(rebuild via `avian/build-site.sh` + `wrangler pages deploy`) → Pi (`pi/update.sh`).
