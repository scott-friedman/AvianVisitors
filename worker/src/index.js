/**
 * avian-worker — Cloudflare Worker for AvianVisitors (bird).
 *
 * Three responsibilities (see ../PLAN.md Phase 1, ../CLAUDE.md):
 *   POST /api/detection  — the Pi's BirdNET hook posts each detection
 *                          (secret-gated via X-Avian-Secret) → D1 insert.
 *   GET  /api/recent     — species-collapsed recent detections. The public
 *                          collage polls this every ~5–10 s.
 *   GET  /api/{stats,lifelist,timeseries,species,firstseen}  (or ?action=)
 *                        — reimplements avian/api/birdnet-api.php against D1.
 *
 * Storage: D1 `avian-detections`, table detections(id, sci, com, conf, ts),
 * ts = unix seconds (UTC). Audio playback (recording.php) is deferred to v2,
 * so `recent`/`species` return top_file/file = null. The Pi is outbound-only;
 * this Worker is its only public surface.
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
      if (path === '/frame.png' && request.method === 'GET') {
        return await frame(request, env, url);
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

  if (!sci || !com || !Number.isFinite(conf) || !Number.isFinite(ts)) {
    return json({ error: 'need {sci, com, conf, ts}' }, 400);
  }
  // Accept confidence as 0..1 or 0..100; store as 0..1.
  const c = conf > 1 ? conf / 100 : conf;

  // INSERT OR IGNORE against UNIQUE(sci, ts) dedupes Pi restarts/replays.
  await env.DB.prepare(
    'INSERT OR IGNORE INTO detections (sci, com, conf, ts) VALUES (?, ?, ?, ?)'
  ).bind(sci, com, c, ts).run();

  return new Response(null, { status: 204, headers: CORS });
}

// ---- e-ink frame (Browser Rendering → 800x480 PNG, signature-cached) ---------

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
async function frameSignature(rows) {
  const items = rows
    .map((r) => [frameSlug(r.sci), frameBucket(Number(r.n) || 1)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  const data = new TextEncoder().encode(JSON.stringify(items));
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
  const since = now - 24 * 3600; // 24H window — matches the collage's default
  const rows = (await env.DB.prepare(
    'SELECT sci, COUNT(*) AS n FROM detections WHERE ts >= ? GROUP BY sci'
  ).bind(since).all()).results || [];
  const sig = await frameSignature(rows);

  // Cache hit: this exact frame was already rendered → serve it, no browser.
  const hit = await env.DB.prepare('SELECT png FROM frame_cache WHERE id = 1 AND sig = ?').bind(sig).first();
  if (hit && hit.png) return pngResponse(hit.png, sig, 'hit');

  // Miss: render off-Pi. On failure, fall back to the last good frame so the
  // panel keeps showing something (display.py likewise keeps its last image).
  let png;
  try {
    png = await renderFrame(env);
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

async function renderFrame(env) {
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 480, deviceScaleFactor: 1 });
    await page.goto(env.FRAME_URL, { waitUntil: 'load', timeout: 30000 });
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

// ---- read API (reimplements avian/api/birdnet-api.php over D1) ---------------

async function queryApi(request, env, url) {
  if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);

  // action from ?action=, else inferred from the path's last segment, so both
  // /api/recent and /api/birdnet-api.php?action=recent resolve the same.
  const known = ['recent', 'stats', 'lifelist', 'timeseries', 'species', 'firstseen'];
  const seg = url.pathname.replace(/\/+$/, '').split('/').pop() || '';
  const action = url.searchParams.get('action') || (known.includes(seg) ? seg : 'recent');

  const tz = tzMod(env);
  const now = Math.floor(Date.now() / 1000);

  switch (action) {
    case 'recent': return recent(env, url, tz, now);
    case 'stats': return stats(env, tz, now);
    case 'lifelist': return lifelist(env, tz);
    case 'timeseries': return timeseries(env, url, tz, now);
    case 'species': return species(env, url, tz);
    case 'firstseen': return firstseen(env, url, tz);
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

  // top_file/top_at carried the audio clip in the PHP version; deferred to v2.
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

async function species(env, url, tz) {
  const sci = url.searchParams.get('sci') || '';
  if (!sci) return json({ error: 'sci= required' }, 400);

  const detections = (await env.DB.prepare(
    `SELECT date(ts, 'unixepoch', ?) AS d, time(ts, 'unixepoch', ?) AS t, conf
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
