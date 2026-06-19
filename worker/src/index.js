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
 */

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
