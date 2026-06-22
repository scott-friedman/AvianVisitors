/**
 * avian-worker — Cloudflare Worker for AvianVisitors (bird).
 *
 * Three responsibilities (see ../PLAN.md Phase 1, ../CLAUDE.md):
 *   POST /api/detection  — the Pi's BirdNET hook posts each detection
 *                          (secret-gated via X-Avian-Secret) → D1 insert.
 *   POST /api/clip       — the Pi uploads that detection's mp3 (same secret)
 *                          → R2 `avian-clips` (7-day object lifecycle).
 *   GET  /api/recording  — streams a clip from R2 by ?file=<key> or ?sci=
 *                          (newest), with Range/seek + CORS. 404 once expired.
 *   POST /api/heartbeat  — the Pi's 15-min liveness ping (same secret) → D1.
 *   GET  /api/status     — 200 (fresh) / 503 (Pi silent) for uptime monitors.
 *   GET  /api/recent     — species-collapsed recent detections. The public
 *                          collage polls this every ~5–10 s.
 *   GET  /api/{stats,lifelist,timeseries,species,firstseen}  (or ?action=)
 *                        — reimplements avian/api/birdnet-api.php against D1.
 *
 * Storage: D1 `avian-detections`, table detections(id, sci, com, conf, ts,
 * file), ts = unix seconds (UTC). Audio clips live in R2 (`avian-clips`, 7-day
 * TTL); `detections.file` is the clip's R2 key and persists after the object
 * expires (→ /api/recording 404s, frontend shows "no audio"). The Pi is
 * outbound-only; this Worker is its only public surface.
 *
 *   GET  /frame.png      — 800x480 PNG of the collage for the e-ink panel,
 *                          rendered off-Pi via Cloudflare Browser Rendering
 *                          (k=FRAME_KEY gated, signature-cached in D1).
 */

import puppeteer from '@cloudflare/puppeteer';

const CORS = {
  'Access-Control-Allow-Origin': '*', // public read-only data
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Avian-Secret',
};

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'public, max-age=10',
  ...CORS,
};

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...JSON_HEADERS, ...extra },
  });
}

// SQLite datetime() modifier for the deployment's local timezone, e.g. "-4 hours".
// Day-bucketed views (daily, by_hour, formatted timestamps) use it; rolling
// windows (recent/last_hour/week/today) are computed in UTC seconds below.
function tzMod(env) {
  const h = parseInt(env.TZ_OFFSET_HOURS ?? '0', 10) || 0;
  return `${h >= 0 ? '+' : ''}${h} hours`;
}

// Start of the local day, in UTC seconds (so it compares against ts directly).
function localDayStart(env, now) {
  const offset = (parseInt(env.TZ_OFFSET_HOURS ?? '0', 10) || 0) * 3600;
  const local = now + offset;
  return local - (local % 86400) - offset;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      if (path === '/api/detection' && request.method === 'POST') {
        return await ingest(request, env);
      }
      if (path === '/api/clip' && request.method === 'POST') {
        return await clip(request, env, url);
      }
      if (path === '/api/recording' && request.method === 'GET') {
        return await recording(request, env, url);
      }
      if (path === '/api/heartbeat' && request.method === 'POST') {
        return await heartbeat(request, env);
      }
      if (path === '/api/frame-config' && request.method === 'POST') {
        return await setFrameConfig(request, env);
      }
      // UptimeRobot (and many uptime monitors) probe with HEAD, not GET. Accept
      // both so the liveness check reaches status() instead of falling through to
      // queryApi() and getting a 405. A HEAD reply carries the same 200/503 status
      // and headers but no body (a HEAD response must not include one).
      if (path === '/api/status' && (request.method === 'GET' || request.method === 'HEAD')) {
        const res = await status(env);
        return request.method === 'HEAD'
          ? new Response(null, { status: res.status, headers: res.headers })
          : res;
      }
      if (path === '/frame.png' && request.method === 'GET') {
        return await frame(request, env, url);
      }
      if (path === '/api/wiki' && request.method === 'GET') {
        return await wiki(url);
      }
      if (path.startsWith('/api/')) {
        return await queryApi(request, env, url);
      }
      if (path === '/' || path === '/health') {
        return json({ ok: true, service: 'avian-worker' });
      }
    } catch (err) {
      return json({ error: 'internal', detail: String((err && err.message) || err) }, 500);
    }
    return json({ error: 'not found' }, 404);
  },
};

// ---- ingest -----------------------------------------------------------------

async function ingest(request, env) {
  const secret = request.headers.get('X-Avian-Secret') || '';
  if (!env.AVIAN_INGEST_SECRET || secret !== env.AVIAN_INGEST_SECRET) {
    return json({ error: 'unauthorized' }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  const sci = String(body.sci ?? '').trim();
  const com = String(body.com ?? '').trim();
  const conf = Number(body.conf);
  const ts = body.ts == null ? Math.floor(Date.now() / 1000) : Math.floor(Number(body.ts));
  // Optional R2 clip key (the mp3 basename). The Pi sends it here, then uploads
  // the bytes to /api/clip. NULL if the Pi couldn't locate/read the clip.
  const file = body.file == null ? null : (String(body.file).trim() || null);

  if (!sci || !com || !Number.isFinite(conf) || !Number.isFinite(ts)) {
    return json({ error: 'need {sci, com, conf, ts}' }, 400);
  }
  // Accept confidence as 0..1 or 0..100; store as 0..1.
  const c = conf > 1 ? conf / 100 : conf;

  // INSERT OR IGNORE against UNIQUE(sci, ts) dedupes Pi restarts/replays.
  await env.DB.prepare(
    'INSERT OR IGNORE INTO detections (sci, com, conf, ts, file) VALUES (?, ?, ?, ?, ?)'
  ).bind(sci, com, c, ts, file).run();

  return new Response(null, { status: 204, headers: CORS });
}

// ---- clip upload + playback (R2) --------------------------------------------
// The Pi POSTs each detection's mp3 to /api/clip?file=<basename> (secret-gated,
// right after the detection POST); the public site plays it back via
// /api/recording. Objects live under clips/<basename>; the bucket's 7-day
// lifecycle rule expires them. See AUDIO-FIX-PLAN.md.

// Validate a clip key = one mp3 basename; block path traversal / nesting. Keys
// may contain ':' (the HH:MM:SS time) and Unicode letters (non-English common
// names) — recording.php allowed the same set; only '/', '\', '..' are unsafe.
function clipKey(raw) {
  const k = (raw == null ? '' : String(raw)).trim();
  if (!k || k.length > 255) return null;
  if (k.includes('/') || k.includes('\\') || k.includes('..')) return null;
  if (!/\.mp3$/i.test(k)) return null;
  return k;
}

async function clip(request, env, url) {
  const secret = request.headers.get('X-Avian-Secret') || '';
  if (!env.AVIAN_INGEST_SECRET || secret !== env.AVIAN_INGEST_SECRET) {
    return json({ error: 'unauthorized' }, 401);
  }
  if (!env.CLIPS) return json({ error: 'no clip storage' }, 503);
  const key = clipKey(url.searchParams.get('file'));
  if (!key) return json({ error: 'bad or missing ?file' }, 400);

  // Clips are tiny (~45 KB); buffer rather than stream so R2 gets an exact
  // length and we can sanity-cap pathological uploads.
  const bytes = await request.arrayBuffer();
  if (!bytes || bytes.byteLength === 0) return json({ error: 'empty body' }, 400);
  if (bytes.byteLength > 5_000_000) return json({ error: 'too large' }, 413);

  await env.CLIPS.put('clips/' + key, bytes, {
    httpMetadata: { contentType: 'audio/mpeg' },
  });
  return new Response(null, { status: 204, headers: CORS });
}

// GET /api/recording?file=<key>  → that exact clip.
// GET /api/recording?sci=<name>  → newest clip for that species (≤7 days old).
// Honors Range (the <audio> element seeks; the spectrogram does a full fetch).
// Missing/expired object → 404, which the frontend degrades to "no audio".
async function recording(request, env, url) {
  if (!env.CLIPS) return new Response('no clip storage', { status: 404, headers: CORS });

  let key = clipKey(url.searchParams.get('file'));
  if (!key) {
    const sci = (url.searchParams.get('sci') || '').trim();
    if (!sci) return new Response('file or sci required', { status: 400, headers: CORS });
    const row = await env.DB.prepare(
      'SELECT file FROM detections WHERE sci = ? AND file IS NOT NULL ORDER BY ts DESC LIMIT 1'
    ).bind(sci).first();
    key = row && row.file ? clipKey(row.file) : null;
    if (!key) return new Response('no recording', { status: 404, headers: CORS });
  }

  const rng = parseRange(request.headers.get('Range'));
  const obj = await env.CLIPS.get('clips/' + key, rng ? { range: rng } : undefined);
  if (!obj) return new Response('not found', { status: 404, headers: CORS });

  const size = obj.size; // full object size, even on a ranged get
  const headers = new Headers(CORS);
  headers.set('Content-Type', 'audio/mpeg');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'public, max-age=604800');
  if (obj.httpEtag) headers.set('ETag', obj.httpEtag);

  if (rng) {
    let off, len;
    if (rng.suffix != null) { len = Math.min(rng.suffix, size); off = size - len; }
    else { off = rng.offset; len = rng.length == null ? size - off : Math.min(rng.length, size - off); }
    if (off < 0 || off >= size || len <= 0) {
      headers.set('Content-Range', `bytes */${size}`);
      return new Response('range not satisfiable', { status: 416, headers });
    }
    headers.set('Content-Range', `bytes ${off}-${off + len - 1}/${size}`);
    headers.set('Content-Length', String(len));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set('Content-Length', String(size));
  return new Response(obj.body, { status: 200, headers });
}

// "bytes=start-end" → {offset,length} | {offset} | {suffix}. Null if absent,
// unparseable, or multi-range (single ranges are enough for <audio> seeking).
function parseRange(header) {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header || '').trim());
  if (!m) return null;
  const startS = m[1], endS = m[2];
  if (startS === '' && endS === '') return null;
  if (startS === '') return { suffix: parseInt(endS, 10) };       // last N bytes
  const offset = parseInt(startS, 10);
  if (endS === '') return { offset };                             // start → EOF
  return { offset, length: parseInt(endS, 10) - offset + 1 };     // inclusive end
}

// ---- liveness (dead-man's switch) -------------------------------------------
// The Pi pings POST /api/heartbeat every ~15 min, independent of bird activity.
// GET /api/status reports 200 (fresh) / 503 (stale) so any uptime monitor can
// alert when the box at Dad's goes silent (mic dead, BirdNET hung, wifi dropped).
// See REVIEW-TODO.md A-High.

const HEARTBEAT_DEFAULT_MAX_AGE = 2700; // 45 min = 3 missed 15-min pings before "dead"

async function heartbeat(request, env) {
  const secret = request.headers.get('X-Avian-Secret') || '';
  if (!env.AVIAN_INGEST_SECRET || secret !== env.AVIAN_INGEST_SECRET) {
    return json({ error: 'unauthorized' }, 401);
  }
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare('INSERT OR REPLACE INTO heartbeat (id, ts) VALUES (1, ?)').bind(now).run();
  return new Response(null, { status: 204, headers: CORS });
}

async function status(env) {
  const now = Math.floor(Date.now() / 1000);
  const maxAge = parseInt(env.HEARTBEAT_MAX_AGE_SECONDS ?? '', 10) || HEARTBEAT_DEFAULT_MAX_AGE;

  const hb = await env.DB.prepare('SELECT ts FROM heartbeat WHERE id = 1').first();
  const lastBeat = hb ? hb.ts : null;
  const beatAge = lastBeat == null ? null : now - lastBeat;
  const alive = beatAge != null && beatAge <= maxAge;

  // Informational only (does NOT affect `alive`): when did we last hear any bird?
  // A long gap with alive=true points at the mic/analyzer, not the box or network.
  const det = await env.DB.prepare('SELECT MAX(ts) AS ts FROM detections').first();
  const lastDet = det && det.ts != null ? det.ts : null;

  // no-store: an uptime monitor must see the true current state, never an edge copy.
  return json({
    alive,
    last_heartbeat: lastBeat ? new Date(lastBeat * 1000).toISOString() : null,
    heartbeat_age_seconds: beatAge,
    max_age_seconds: maxAge,
    last_detection: lastDet ? new Date(lastDet * 1000).toISOString() : null,
    last_detection_age_seconds: lastDet == null ? null : now - lastDet,
    as_of: new Date().toISOString(),
  }, alive ? 200 : 503, { 'Cache-Control': 'no-store' });
}

// ---- e-ink frame (Browser Rendering → 800x480 PNG, signature-cached) ---------

// Allowed frame windows, in hours (mirrors the top-bar picker: 1H/12H/24H/7D/ALL).
// Both /api/frame-config writes and getFrameWindow() validate against this list.
const FRAME_WINDOWS = [1, 12, 24, 168, 1000000];

// The shared, server-side window the PHYSICAL frame shows (settings singleton).
// Defaults to 24h if the row/value is missing or somehow out of range, so the
// frame never breaks on a bad setting. See FRAME-WINDOW-TOGGLE-PLAN.md.
async function getFrameWindow(env) {
  const row = await env.DB.prepare('SELECT frame_window_hours AS h FROM settings WHERE id = 1').first();
  const h = row && Number(row.h);
  return FRAME_WINDOWS.includes(h) ? h : 24;
}

// POST /api/frame-config {window_hours:N} — set the shared frame window. OPEN
// (no auth) by design: it only writes one validated number and cannot trigger
// the metered render (that stays FRAME_KEY-gated on /frame.png). json() carries
// CORS. See FRAME-WINDOW-TOGGLE-PLAN.md "Optional hardening" to gate this later.
async function setFrameConfig(request, env) {
  const body = await request.json().catch(() => ({}));
  const h = Number(body.window_hours);
  if (!FRAME_WINDOWS.includes(h)) return json({ error: 'bad window_hours' }, 400);
  await env.DB.prepare(
    'INSERT OR REPLACE INTO settings (id, frame_window_hours) VALUES (1, ?)'
  ).bind(h).run();
  return json({ window_hours: h });
}

// Mirror the Pi's change detection (frame/display.py): the frame content is the
// set of recent species sized by a coarse count bracket, so this signature moves
// exactly when the rendered collage would. The Worker and Pi hashes need not be
// byte-identical — each only has to change when the picture changes.
function frameSlug(sci) {
  return String(sci).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function frameBucket(n) {
  const edges = [1, 2, 5, 15, 40, 100, 300, 1000];
  for (let i = 0; i < edges.length; i++) if (n <= edges[i]) return i;
  return 8;
}
async function frameSignature(rows, windowHours) {
  const items = rows
    .map((r) => [frameSlug(r.sci), frameBucket(Number(r.n) || 1)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  // Fold the window in so switching windows always busts frame_cache, even if
  // two windows happen to hold the identical species/count set.
  const data = new TextEncoder().encode(JSON.stringify({ w: windowHours, items }));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function pngResponse(body, sig, note) {
  // D1 returns a BLOB column as a JS number[] (not an ArrayBuffer), and
  // new Response(number[]) would stringify it ("137,80,78,..."). Coerce to
  // bytes so both the fresh Uint8Array (miss) and the cached array (hit/stale)
  // serve as real binary PNG.
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      // The Pi already gates fetches on change; a short edge TTL is belt-and-suspenders.
      'Cache-Control': 'public, max-age=60',
      ETag: `"${sig}"`,
      'X-Frame-Cache': note,
      ...CORS,
    },
  });
}

async function frame(request, env, url) {
  // k=FRAME_KEY gate: only the Pi (and Scott) can trigger a render, which costs
  // browser time. If FRAME_KEY is unset the route is open (dev convenience).
  if (env.FRAME_KEY && url.searchParams.get('k') !== env.FRAME_KEY) {
    return json({ error: 'unauthorized' }, 401);
  }

  const now = Math.floor(Date.now() / 1000);
  const windowHours = await getFrameWindow(env); // shared, set via /api/frame-config
  const since = now - windowHours * 3600;
  const rows = (await env.DB.prepare(
    'SELECT sci, COUNT(*) AS n FROM detections WHERE ts >= ? GROUP BY sci'
  ).bind(since).all()).results || [];
  const sig = await frameSignature(rows, windowHours);

  // Cache hit: this exact frame was already rendered → serve it, no browser.
  const hit = await env.DB.prepare('SELECT png FROM frame_cache WHERE id = 1 AND sig = ?').bind(sig).first();
  if (hit && hit.png) return pngResponse(hit.png, sig, 'hit');

  // Miss: render off-Pi. On failure, fall back to the last good frame so the
  // panel keeps showing something (display.py likewise keeps its last image).
  let png;
  try {
    png = await renderFrame(env, windowHours);
  } catch (err) {
    const stale = await env.DB.prepare('SELECT png, sig FROM frame_cache WHERE id = 1').first();
    if (stale && stale.png) return pngResponse(stale.png, stale.sig, 'stale');
    return json({ error: 'render failed', detail: String((err && err.message) || err) }, 502);
  }

  await env.DB.prepare(
    'INSERT OR REPLACE INTO frame_cache (id, sig, png, ts) VALUES (1, ?, ?, ?)'
  ).bind(sig, png.buffer, now).run();
  return pngResponse(png, sig, 'miss');
}

async function renderFrame(env, windowHours) {
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 480, deviceScaleFactor: 1 });
    // FRAME_URL already carries ?frame=1; add the chosen window so the page's JS
    // (apt.js urlWindow()) draws that window instead of its localStorage default.
    const target = new URL(env.FRAME_URL);
    target.searchParams.set('window', String(windowHours));
    await page.goto(target.toString(), { waitUntil: 'load', timeout: 30000 });
    // The collage polls /api/recent on a timer, so networkidle never settles;
    // wait for tiles to mount, then for their images to decode.
    await page.waitForSelector('#collage .gtile', { timeout: 15000 }).catch(() => {});
    await page.evaluate(async () => {
      const imgs = Array.from(document.querySelectorAll('#collage img'));
      await Promise.race([
        Promise.all(imgs.map((im) => (im.complete ? null : new Promise((r) => { im.onload = im.onerror = r; })))),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
    });
    await new Promise((r) => setTimeout(r, 400)); // let the last paint settle
    const shot = await page.screenshot({ type: 'png' });
    return new Uint8Array(shot); // exact-size copy → .buffer is a clean D1 BLOB
  } finally {
    await browser.close();
  }
}

// ---- Wikipedia summary proxy (/api/wiki) ------------------------------------
// The detail modal shows a one-paragraph species description. The stock
// avian/api/wiki.php can't run on Pages (static hosting, no PHP), so the Worker
// proxies Wikipedia's REST summary here instead. Wikipedia redirects a
// scientific name to the species article, so a sci lookup resolves the
// common-name page for ~every bird; ?com=<name> is an optional fallback for the
// rare miss (recent splits / disambiguation). The {extract,title} shape matches
// wiki.php, so the frontend is unchanged but for the URL. Cached 24 h
// (descriptions don't change) at the browser, the CF edge, and the WP subrequest.
const WIKI_UA = 'BarrysBirds/1.0 (+https://barrysbirds.pages.dev; avian-worker)';
const WIKI_DAY = { 'Cache-Control': 'public, max-age=86400' };
// "Genus species" (+ optional sub/trinomial) — the shape wiki.php enforced.
const SCI_RE = /^[A-Za-z]{2,40}(?:[ ][a-z]{2,40}){1,3}$/;

// Fetch one Wikipedia REST summary. Returns {extract,title}, or null on any
// failure / non-article result (missing page, disambiguation, empty extract).
async function wikiSummary(name) {
  let res;
  try {
    res = await fetch(
      'https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(name),
      { headers: { 'User-Agent': WIKI_UA, Accept: 'application/json' },
        cf: { cacheTtl: 86400, cacheEverything: true } }
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let j;
  try { j = await res.json(); } catch { return null; }
  if (!j || j.type === 'disambiguation' || !j.extract) return null;
  return { extract: j.extract, title: j.title || null };
}

async function wiki(url) {
  const sci = (url.searchParams.get('sci') || '').trim();
  if (!sci) return json({ error: 'sci required' }, 400, WIKI_DAY);
  if (!SCI_RE.test(sci)) return json({ error: 'invalid sci' }, 400, WIKI_DAY);

  // Scientific name first (WP redirects it to the species page); fall back to
  // the common name on a miss. com is sanitized to a plain title (letters,
  // space, '.', '-', '\''); it's encodeURIComponent'd before it reaches WP.
  let hit = await wikiSummary(sci);
  if (!hit) {
    const com = (url.searchParams.get('com') || '').trim();
    if (com && /^[\p{L}][\p{L} .'-]{1,58}$/u.test(com)) hit = await wikiSummary(com);
  }
  return json(hit || { extract: null, title: null }, 200, WIKI_DAY);
}

// ---- read API (reimplements avian/api/birdnet-api.php over D1) ---------------

async function queryApi(request, env, url) {
  if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);

  // action from ?action=, else inferred from the path's last segment, so both
  // /api/recent and /api/birdnet-api.php?action=recent resolve the same.
  const known = ['recent', 'stats', 'lifelist', 'timeseries', 'species', 'firstseen', 'hourly', 'rhythm', 'facts', 'frame-config'];
  const seg = url.pathname.replace(/\/+$/, '').split('/').pop() || '';
  const action = url.searchParams.get('action') || (known.includes(seg) ? seg : 'recent');

  const tz = tzMod(env);
  const now = Math.floor(Date.now() / 1000);

  switch (action) {
    case 'recent': return recent(env, url, tz, now);
    case 'stats': return stats(env, tz, now);
    case 'facts': return facts(env, tz, now);
    case 'lifelist': return lifelist(env, tz);
    case 'timeseries': return timeseries(env, url, tz, now);
    case 'hourly': return hourly(env, url, tz, now);
    case 'rhythm': return rhythm(env, url, tz, now);
    case 'species': return species(env, url, tz);
    case 'firstseen': return firstseen(env, url, tz);
    case 'frame-config': return json({ window_hours: await getFrameWindow(env) });
    default: return json({ error: 'unknown action' }, 404);
  }
}

async function recent(env, url, tz, now) {
  const hours = clampInt(url.searchParams.get('hours'), 24, 1, 1000000);
  const since = now - hours * 3600;
  const { results } = await env.DB.prepare(
    `SELECT sci, com, COUNT(*) AS n, MAX(conf) AS best_conf,
            datetime(MAX(ts), 'unixepoch', ?) AS last_seen
       FROM detections
      WHERE ts >= ?
      GROUP BY sci
      ORDER BY MAX(ts) DESC`
  ).bind(tz, since).all();

  // top_file/top_at are vestigial — no frontend reads them (the atlas card
  // plays via /api/recording?sci=, which resolves the newest clip itself).
  // Kept null for response-shape stability.
  const list = (results || []).map((r) => ({
    sci: r.sci, com: r.com, n: r.n, best_conf: r.best_conf,
    last_seen: r.last_seen, top_file: null, top_at: r.last_seen,
  }));
  return json({ hours, species: list, as_of: new Date().toISOString() });
}

async function stats(env, tz, now) {
  const todayStart = localDayStart(env, now);
  const weekStart = now - 7 * 86400;
  const hourStart = now - 3600;
  const first = (sql, ...b) => env.DB.prepare(sql).bind(...b).first();

  const total = (await first('SELECT COUNT(*) AS n FROM detections')).n;
  const speciesN = (await first('SELECT COUNT(DISTINCT sci) AS n FROM detections')).n;
  const today = (await first('SELECT COUNT(*) AS n FROM detections WHERE ts >= ?', todayStart)).n;
  const todaySpec = (await first('SELECT COUNT(DISTINCT sci) AS n FROM detections WHERE ts >= ?', todayStart)).n;
  const lastHour = (await first('SELECT COUNT(*) AS n FROM detections WHERE ts >= ?', hourStart)).n;
  const week = (await first('SELECT COUNT(*) AS n FROM detections WHERE ts >= ?', weekStart)).n;
  const weekSpec = (await first('SELECT COUNT(DISTINCT sci) AS n FROM detections WHERE ts >= ?', weekStart)).n;
  const started = await first(`SELECT date(MIN(ts), 'unixepoch', ?) AS d FROM detections`, tz);

  return json({
    totals: { detections: total, species: speciesN },
    today: { detections: today, species: todaySpec },
    last_hour: { detections: lastHour },
    week: { detections: week, species: weekSpec },
    started: started ? started.d : null,
    as_of: new Date().toISOString(),
  });
}

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

async function lifelist(env, tz) {
  const { results } = await env.DB.prepare(
    `SELECT sci, com,
            datetime(MIN(ts), 'unixepoch', ?) AS first_seen,
            datetime(MAX(ts), 'unixepoch', ?) AS last_seen,
            COUNT(*) AS n, MAX(conf) AS best_conf
       FROM detections
      GROUP BY sci
      ORDER BY MIN(ts) ASC`
  ).bind(tz, tz).all();
  return json({ species: results || [], as_of: new Date().toISOString() });
}

async function timeseries(env, url, tz, now) {
  const days = clampInt(url.searchParams.get('days'), 30, 1, 90);
  const dailySince = now - (days - 1) * 86400;
  const daily = (await env.DB.prepare(
    `SELECT date(ts, 'unixepoch', ?) AS date, COUNT(*) AS detections,
            COUNT(DISTINCT sci) AS species
       FROM detections WHERE ts >= ? GROUP BY date ORDER BY date`
  ).bind(tz, dailySince).all()).results || [];

  const hourSince = now - 30 * 86400;
  const by_hour = (await env.DB.prepare(
    `SELECT CAST(strftime('%H', ts, 'unixepoch', ?) AS INT) AS hour, COUNT(*) AS detections
       FROM detections WHERE ts >= ? GROUP BY hour ORDER BY hour`
  ).bind(tz, hourSince).all()).results || [];

  return json({ days, daily, by_hour, as_of: new Date().toISOString() });
}

// Rolling-window detections bucketed by LOCAL clock hour, for the Day Dial.
// Unlike timeseries.by_hour (a fixed 30-day aggregate), this honors ?hours=N so
// the dial tracks the same window picker as the collage. Returns 24 zero-filled
// bins (silent hours included), each with detections/distinct-species/top-3, plus
// tz-correct now + sunrise/sunset in Sudbury-local fractional hours (see CLAUDE.md
// D5: the viewer's browser may be in any timezone — the Worker is authoritative).
async function hourly(env, url, tz, now) {
  const hours = clampInt(url.searchParams.get('hours'), 24, 1, 1000000);
  const since = now - hours * 3600;

  // hour (local clock) × species counts in the rolling window. ORDER BY ... n DESC
  // so the first ≤3 rows pushed per hour are that hour's most-heard species.
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
    if (!b) continue;                       // defensive: strftime is always 00–23
    b.detections += r.n;
    b.species += 1;
    if (b.top.length < 3) b.top.push({ com: r.com, sci: r.sci, n: r.n });
  }
  const total = bins.reduce((s, b) => s + b.detections, 0);
  let peakHour = null, peakN = -1;
  for (const b of bins) if (b.detections > peakN) { peakN = b.detections; peakHour = b.hour; }

  // tz-correct "now" and sun, in Sudbury-local fractional hours (see D5). Shift
  // UTC `now` by the offset, then read the Date's UTC fields = local wall clock.
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

// Sunrise/sunset for the daylight band — standard low-precision sunrise equation
// (Wikipedia). Returns Sudbury-local fractional hours, or null if SITE_LAT/LON are
// unset/invalid (band omitted client-side) or during polar day/night. Verified for
// 42.385,-71.417 on 2026-06-20 EDT: sunrise 05:10, sunset 20:27 (≈NOAA 05:08/20:24).
function sunArc(env, localNow, offH) {
  const lat = parseFloat(env.SITE_LAT), lon = parseFloat(env.SITE_LON);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const Y = localNow.getUTCFullYear(), M = localNow.getUTCMonth() + 1, D = localNow.getUTCDate();
  const rad = Math.PI / 180, deg = 180 / Math.PI;
  const a = Math.floor((14 - M) / 12), y = Y + 4800 - a, m = M + 12 * a - 3;
  const JDN = D + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4)
            - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
  const n = JDN - 2451545.0 + 0.0008;
  const Jstar = n - lon / 360;                       // lon EAST-positive; -71.4 for Sudbury
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

async function species(env, url, tz) {
  const sci = url.searchParams.get('sci') || '';
  if (!sci) return json({ error: 'sci= required' }, 400);

  const detections = (await env.DB.prepare(
    `SELECT date(ts, 'unixepoch', ?) AS d, time(ts, 'unixepoch', ?) AS t, conf, file
       FROM detections WHERE sci = ? ORDER BY ts DESC LIMIT 500`
  ).bind(tz, tz, sci).all()).results || [];

  const summary = await env.DB.prepare(
    `SELECT com, COUNT(*) AS total,
            datetime(MIN(ts), 'unixepoch', ?) AS first_seen,
            datetime(MAX(ts), 'unixepoch', ?) AS last_seen, MAX(conf) AS best_conf
       FROM detections WHERE sci = ?`
  ).bind(tz, tz, sci).first();

  return json({ sci, summary, detections });
}

async function firstseen(env, url, tz) {
  const limit = clampInt(url.searchParams.get('limit'), 10, 1, 50);
  const { results } = await env.DB.prepare(
    `SELECT sci, com, datetime(MIN(ts), 'unixepoch', ?) AS first_seen, COUNT(*) AS total
       FROM detections GROUP BY sci ORDER BY MIN(ts) DESC LIMIT ?`
  ).bind(tz, limit).all();
  return json({ species: results || [], as_of: new Date().toISOString() });
}

function clampInt(raw, dflt, lo, hi) {
  const n = parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}
