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
 *   GET  /api/coverage   — art + song-signature gap lists (D1 life list diffed
 *                          against Pages art-manifest.json + signatures.json) for
 *                          the HA admin page. See ../BIRDS-DASHBOARD.md.
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
  const headers = { ...JSON_HEADERS, ...extra };
  // Never let an error response inherit the public max-age (a cached 4xx/5xx
  // would keep serving the failure after the cause clears).
  if (status >= 400) headers['Cache-Control'] = 'no-store';
  return new Response(JSON.stringify(obj), { status, headers });
}

// Local-time offset in hours from UTC. TZ_NAME (an IANA zone, "America/New_York")
// is authoritative and DST-correct via Intl; TZ_OFFSET_HOURS is the fixed-offset
// fallback (and the value used if Intl can't resolve the zone). Cached per
// wall-clock hour — DST transitions land on an hour boundary.
let _tzCache = { hour: -1, off: 0 };
function tzOffsetHours(env) {
  const zone = (env.TZ_NAME || '').trim();
  if (!zone) return parseInt(env.TZ_OFFSET_HOURS ?? '0', 10) || 0;
  const hour = Math.floor(Date.now() / 3600000);
  if (_tzCache.hour === hour) return _tzCache.off;
  let off = parseInt(env.TZ_OFFSET_HOURS ?? '0', 10) || 0;
  try {
    // "GMT-04:00" (or bare "GMT" for UTC itself).
    const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(new Date()).find((p) => p.type === 'timeZoneName').value;
    const m = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(name);
    if (m) off = m[1] ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) + Number(m[3]) / 60) : 0;
  } catch { /* keep the fixed-offset fallback */ }
  _tzCache = { hour, off };
  return off;
}

// SQLite datetime() modifier for the deployment's local timezone, e.g. "-4 hours".
// Day-bucketed views (daily, by_hour, formatted timestamps) use it; rolling
// windows (recent/last_hour/week/today) are computed in UTC seconds below.
function tzMod(env) {
  const h = tzOffsetHours(env);
  return `${h >= 0 ? '+' : ''}${h} hours`;
}

// Start of the local day, in UTC seconds (so it compares against ts directly).
function localDayStart(env, now) {
  const offset = tzOffsetHours(env) * 3600;
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

    // D1's storage object occasionally resets mid-flight ("D1_ERROR: ... storage
    // caused object to be reset") and every in-flight query throws — observed
    // 2026-07-03 in multi-minute bursts that dropped detections and flapped the
    // heartbeat. Every route is idempotent (INSERT OR IGNORE / single-row upsert
    // / reads), so retry the dispatch on that signature. /frame.png is excluded:
    // a retry there could double-bill the metered Browser Rendering minutes.
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await dispatch(request.clone(), env, url, path);
      } catch (err) {
        lastErr = err;
        if (path === '/frame.png' || !isTransientD1(err) || attempt === 2) break;
        await new Promise((r) => setTimeout(r, 200 + 400 * attempt));
      }
    }
    // Log path only, never url.search — /frame.png carries ?k=<FRAME_KEY>.
    console.error(`[dispatch] ${request.method} ${path} failed after retries:`, lastErr);
    return json({ error: 'internal' }, 500);
  },

  // Cron ([triggers] in wrangler.toml, ET daylight only): Mojo's periodic
  // "detections". See the MOJO block below for what/why/how-to-remove.
  async scheduled(event, env, ctx) {
    // A transient D1 reset just loses this tick (self-heals in 30 min) — but
    // log it, or cron failures vanish without a trace.
    ctx.waitUntil(mojoVisit(env).catch((err) => console.error('[mojo] cron tick failed:', err)));
  },
};

// A transient D1 infrastructure failure (the storage object restarting), worth
// an immediate in-place retry — as opposed to a SQL/data error, which never is.
function isTransientD1(err) {
  const m = String((err && err.message) || err);
  return /D1_ERROR/i.test(m) && /reset|starting up|network|internal error/i.test(m);
}

async function dispatch(request, env, url, path) {
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
  if (path === '/api/coverage' && request.method === 'GET') {
    // Micro-cached: coverage() full-table GROUP BYs + fetches two Pages
    // manifests, and the HA dashboard polls it. Manifest changes (a Pages
    // deploy) propagate within one 5-min bucket.
    return await pollCached(env, 'coverage', () => coverage(env));
  }
  if (path.startsWith('/api/')) {
    return await queryApi(request, env, url);
  }
  if (path === '/' || path === '/health') {
    return json({ ok: true, service: 'avian-worker' });
  }
  return json({ error: 'not found' }, 404);
}

// ---- Mojo, the resident dog-bird (easter egg) ---------------------------------
// A fake species for dad: the family dog, drawn in the field-guide style and
// "detected" on a cron. As of 2026-07-06 he no longer sits permanently in the
// 1-h window: mojoVisit() gates his appearances on real recent bird activity and
// caps them to a few a day (see that function), so he surfaces on the collage /
// e-ink frame intermittently — around when other birds are actually singing, and
// never on a dead hour. The rows are real D1 detections, so every view (stats,
// dial, rhythm, chorus, modal) stays self-consistent, and every row's play
// button serves his actual bark.
// Full removal:
//   1. delete this block, the scheduled() handler above, and [triggers] in
//      wrangler.toml → `wrangler deploy`
//   2. DELETE FROM detections WHERE sci = 'Canis volaticus'  (--remote)
//   3. wrangler r2 object delete the clips/ key + master/mojo-bark.mp3 (--remote)
//   4. remove canis-volaticus[-2].png + the FORCE_POSE entry in apt.js,
//      re-run build_masks.py, bump versions, redeploy Pages
const MOJO = {
  sci: 'Canis volaticus',
  com: 'Mojo',
  file: 'Mojo-93-2026-07-03-birdnet-08:12:47.mp3', // R2 clip key (his bark)
  master: 'master/mojo-bark.mp3', // lifecycle-proof copy (outside clips/)
  // Appearance shaping (see mojoVisit): he surfaces a few times a day, only when
  // the yard is actually active, never on a dead hour. Tune these to taste.
  activityWindowMin: 45, // "recent" window for judging real-bird activity
  minRecentReal: 3,      // ≥ this many NON-Mojo detections in that window = active
  minGapMin: 90,         // min minutes between his own appearances (spreads them out)
  dailyCap: 4,           // at most this many per LOCAL day ("a few")
  visitProb: 0.6,        // coin-flip on an otherwise-eligible tick (organic jitter)
  confLo: 0.82,
  confHi: 0.97,
  extract:
    'Mojo is a dog hailing from Puerto Rico. While he is scared of trash for ' +
    'some reason, he loves his family and enjoys peeing on graves in the ' +
    'cemetery and taking long walks around Sudbury. His distinctive bark is ' +
    'commonly heard when he sees a person he doesn’t like or when you have a ' +
    'treat for him. Commonly found attacking his favorite toy, Boney, he ' +
    'spends many hours of the day asleep, waiting for his next meal.',
};

async function mojoVisit(env) {
  // Mojo now shows up a FEW times a day, and ONLY when the yard is actually
  // busy — he barks at the other birds, not into a dead hour. On each cron tick
  // (every 30 min, ET daylight) he must clear four gates, in order:
  //   1. ACTIVITY — ≥ minRecentReal real (non-Mojo) detections in the last
  //      activityWindowMin. No birds around ⇒ no Mojo, which both skips
  //      otherwise-inactive hours and ties his timing to when other birds sing.
  //   2. SPACING  — ≥ minGapMin since his own last appearance, so he doesn't
  //      cluster on the dawn chorus and doesn't sit permanently in the 1-h window.
  //   3. DAILY CAP — at most dailyCap per local day ("a few", not a fixture).
  //   4. COIN-FLIP — even an eligible tick is only taken visitProb of the time,
  //      so the cadence stays organic rather than firing the instant a gate opens.
  const now = Math.floor(Date.now() / 1000);

  // 1) Activity gate. Plain COUNT over a ts range (the `sci !=` is a cheap
  //    post-filter); no GROUP BY/DISTINCT, so no index pin needed (cf. status()).
  const active = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM detections WHERE sci != ? AND ts >= ?'
  ).bind(MOJO.sci, now - MOJO.activityWindowMin * 60).first();
  if (!active || active.n < MOJO.minRecentReal) return;

  // 2)+3) His own recent rows (equality on sci + ts range ⇒ the (sci,ts) dedupe
  //    index is exactly right). One read covers both the daily cap and the gap.
  const dayStart = localDayStart(env, now);
  const mine = await env.DB.prepare(
    'SELECT ts FROM detections WHERE sci = ? AND ts >= ? ORDER BY ts DESC'
  ).bind(MOJO.sci, Math.min(dayStart, now - MOJO.minGapMin * 60)).all();
  const rows = (mine && mine.results) || [];
  if (rows.filter((r) => r.ts >= dayStart).length >= MOJO.dailyCap) return; // capped today
  if (rows.length && rows[0].ts >= now - MOJO.minGapMin * 60) return;       // too soon

  // 4) Organic coin-flip.
  if (Math.random() > MOJO.visitProb) return;

  const conf = MOJO.confLo + Math.random() * (MOJO.confHi - MOJO.confLo);
  const ts = now;
  await env.DB.prepare(
    'INSERT OR IGNORE INTO detections (sci, com, conf, ts, file) VALUES (?, ?, ?, ?, ?)'
  ).bind(MOJO.sci, MOJO.com, Math.round(conf * 1000) / 1000, ts, MOJO.file).run();

  // The clips/ 7-day lifecycle eventually deletes his bark; restore it from
  // the master copy so the play button never goes quiet.
  if (env.CLIPS) {
    const head = await env.CLIPS.head('clips/' + MOJO.file);
    if (!head) {
      const m = await env.CLIPS.get(MOJO.master);
      if (m) {
        await env.CLIPS.put('clips/' + MOJO.file, m.body, {
          httpMetadata: { contentType: 'audio/mpeg' },
        });
      }
    }
  }
}

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
  // Hardening (secret-gated, but a Pi-side bug must not poison the DB): names
  // bounded (longest real bird binomials/commons are well under 60 chars; a
  // multi-MB string would be echoed by every GROUP BY endpoint), ts within a
  // sane window (a far-future ts would permanently top `recent` and pin the
  // poll-cache version; ±7 days covers any realistic forwarder replay backlog).
  if (sci.length > 120 || com.length > 120) return json({ error: 'name too long' }, 400);
  if (Math.abs(ts - Math.floor(Date.now() / 1000)) > 7 * 86400) {
    return json({ error: 'ts out of range' }, 400);
  }
  // Accept confidence as 0..1 or 0..100; store clamped to 0..1.
  const c = Math.max(0, Math.min(1, conf > 1 ? conf / 100 : conf));

  // INSERT OR IGNORE against UNIQUE(sci, ts) dedupes Pi restarts/replays.
  await env.DB.prepare(
    'INSERT OR IGNORE INTO detections (sci, com, conf, ts, file) VALUES (?, ?, ?, ?, ?)'
  ).bind(sci, com, c, ts, file).run();

  // Rare-species archival (best-effort — must never fail the ingest). Mojo is
  // excluded: his cron self-heals his one bark from master/ already.
  if (file && env.CLIPS && sci !== MOJO.sci) {
    try {
      await archiveRareClip(env, sci, file);
    } catch (err) {
      // Archive is a bonus — never fail the ingest — but log it: a silent
      // failure here quietly erodes the forever-archive.
      console.error('[ingest] rare-clip archive failed:', sci, file, err);
    }
  }

  return new Response(null, { status: 204, headers: CORS });
}

// ---- clip upload + playback (R2) --------------------------------------------
// The Pi POSTs each detection's mp3 to /api/clip?file=<basename> (secret-gated,
// BEFORE the detection POST — so the clip exists when ingest() runs); the public
// site plays it back via /api/recording. Objects live under clips/<basename>;
// the bucket's 7-day lifecycle rule (prefix-scoped to clips/) expires them.
// See AUDIO-FIX-PLAN.md and CLIP-RETENTION-PLAN.md.

// Rare-clip archive: the flat 7-day TTL deletes a once-ever Veery as fast as the
// 1000th goldfinch, so each species' first RARE_MAX clips are also copied to
// rare/<basename> — a prefix with NO lifecycle rule, kept indefinitely (same
// exemption trick as Mojo's master/). The count is lifetime, so a common species
// archived its first 25 long ago and never copies again; storage is bounded at
// RARE_MAX × ~45 KB ≈ 1.1 MB per species, ever. The per-species COUNT is a
// covering-index seek on idx_detections_dedupe (EXPLAIN QUERY PLAN verified
// 2026-07-03 — see the D1 full-scan gotcha in CLAUDE.md).
const RARE_MAX = 25;

async function archiveRareClip(env, sci, file) {
  const key = clipKey(file);
  if (!key) return;
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM detections WHERE sci = ?'
  ).bind(sci).first();
  if (!row || row.n > RARE_MAX) return;
  if (await env.CLIPS.head('rare/' + key)) return; // replayed detection; already archived
  const src = await env.CLIPS.get('clips/' + key);
  if (!src) return; // clip upload failed or already expired — nothing to copy
  await env.CLIPS.put('rare/' + key, src.body, {
    httpMetadata: { contentType: 'audio/mpeg' },
  });
}

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
// GET /api/recording?sci=<name>  → newest clip for that species.
// Lookup order per key: clips/ (7-day hot set) then rare/ (the forever archive
// of each species' first RARE_MAX clips). For ?sci=, if the newest clip has
// expired from both, fall back to the species' OLDEST clip — the one most
// likely archived — so a rare bird's atlas play button outlives the TTL.
// Honors Range (the <audio> element seeks; the spectrogram does a full fetch).
// Missing/expired object → 404, which the frontend degrades to "no audio".
async function recording(request, env, url) {
  if (!env.CLIPS) return new Response('no clip storage', { status: 404, headers: CORS });

  let sci = null;
  let key = clipKey(url.searchParams.get('file'));
  if (!key) {
    sci = (url.searchParams.get('sci') || '').trim();
    if (!sci) return new Response('file or sci required', { status: 400, headers: CORS });
    const row = await env.DB.prepare(
      'SELECT file FROM detections WHERE sci = ? AND file IS NOT NULL ORDER BY ts DESC LIMIT 1'
    ).bind(sci).first();
    key = row && row.file ? clipKey(row.file) : null;
    if (!key) return new Response('no recording', { status: 404, headers: CORS });
  }

  const rng = parseRange(request.headers.get('Range'));
  const opts = rng ? { range: rng } : undefined;
  let obj = (await env.CLIPS.get('clips/' + key, opts)) || (await env.CLIPS.get('rare/' + key, opts));
  if (!obj && sci) {
    const oldest = await env.DB.prepare(
      'SELECT file FROM detections WHERE sci = ? AND file IS NOT NULL ORDER BY ts ASC LIMIT 1'
    ).bind(sci).first();
    const alt = oldest && oldest.file ? clipKey(oldest.file) : null;
    if (alt && alt !== key) {
      obj = (await env.CLIPS.get('rare/' + alt, opts)) || (await env.CLIPS.get('clips/' + alt, opts));
    }
  }
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
// (no auth) by design — the public site's picker writes it — so abuse is kept
// cheap instead (hardened 2026-07-10): a no-op write is skipped entirely (no
// D1 write to burn the pooled quota on), and real changes are rate-limited per
// isolate. Render burn is bounded structurally: frame_cache keeps one PNG per
// window (migration 0006), so flipping the window serves the other window's
// cached frame — a metered render happens only when that window's detection
// signature actually changes. json() carries CORS.
const FRAME_CONFIG_MIN_INTERVAL_MS = 3000;
let _frameConfigLastWrite = 0;

async function setFrameConfig(request, env) {
  const body = await request.json().catch(() => ({}));
  const h = Number(body.window_hours);
  if (!FRAME_WINDOWS.includes(h)) return json({ error: 'bad window_hours' }, 400);
  const current = await getFrameWindow(env);
  if (current === h) return json({ window_hours: h }); // no-op: skip the write
  const nowMs = Date.now();
  if (nowMs - _frameConfigLastWrite < FRAME_CONFIG_MIN_INTERVAL_MS) {
    return json({ error: 'too many changes; retry shortly' }, 429, { 'Retry-After': '3' });
  }
  _frameConfigLastWrite = nowMs;
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
  // FRAME_KEY gate: only the Pi (and Scott) can trigger a render, which costs
  // metered browser time. Accepted as X-Frame-Key header (preferred — a ?k=
  // query would land in request-URL logs) or legacy ?k= during the Pi
  // transition. Fails CLOSED when FRAME_KEY is unset, like every other gated
  // route; set FRAME_DEV_OPEN=1 in .dev.vars to open it for local dev.
  const provided = request.headers.get('X-Frame-Key') || url.searchParams.get('k') || '';
  if (!env.FRAME_KEY) {
    if (env.FRAME_DEV_OPEN !== '1') return json({ error: 'unauthorized' }, 401);
  } else if (provided !== env.FRAME_KEY) {
    return json({ error: 'unauthorized' }, 401);
  }

  const now = Math.floor(Date.now() / 1000);
  const windowHours = await getFrameWindow(env); // shared, set via /api/frame-config
  const since = now - windowHours * 3600;
  const rows = (await env.DB.prepare(
    'SELECT sci, COUNT(*) AS n FROM detections INDEXED BY idx_detections_ts WHERE ts >= ? GROUP BY sci'
  ).bind(since).all()).results || [];
  const sig = await frameSignature(rows, windowHours);

  // Cache hit: this exact frame was already rendered → serve it, no browser.
  // One cached PNG per window (id = window hours, migration 0006), so a
  // window flip serves the other window's frame instead of forcing a render.
  const hit = await env.DB.prepare('SELECT png FROM frame_cache WHERE id = ? AND sig = ?').bind(windowHours, sig).first();
  if (hit && hit.png) return pngResponse(hit.png, sig, 'hit');

  // Miss: render off-Pi. On failure, fall back to the last good frame so the
  // panel keeps showing something (display.py likewise keeps its last image).
  let png;
  try {
    png = await renderFrame(env, windowHours, rows.length > 0);
    // Sanity-gate before caching: a catastrophically broken screenshot (empty,
    // truncated, not a PNG) must not be cached under this signature — it would
    // stick on the panel until the data next changes. The floor is deliberately
    // tiny: a LEGITIMATE frame can be near-blank (a 1H window overnight), so
    // this catches garbage, not sparseness. Bad render → same stale fallback
    // as a thrown render error.
    if (!png || png.length < 1000 ||
        !(png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47)) {
      throw new Error(`render produced invalid png (${png ? png.length : 0} bytes)`);
    }
  } catch (err) {
    console.error('[frame] render failed, falling back to stale:', err);
    const stale = (await env.DB.prepare('SELECT png, sig FROM frame_cache WHERE id = ?').bind(windowHours).first())
      || (await env.DB.prepare('SELECT png, sig FROM frame_cache ORDER BY ts DESC LIMIT 1').first());
    if (stale && stale.png) return pngResponse(stale.png, stale.sig, 'stale');
    return json({ error: 'render failed' }, 502);
  }

  await env.DB.prepare(
    'INSERT OR REPLACE INTO frame_cache (id, sig, png, ts) VALUES (?, ?, ?, ?)'
  ).bind(windowHours, sig, png.buffer, now).run();
  return pngResponse(png, sig, 'miss');
}

async function renderFrame(env, windowHours, expectTiles) {
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
    // wait for tiles to mount, then for their images to decode. When the
    // window HAS detections, tiles failing to appear means a broken page load
    // — throw (→ the stale fallback) rather than cache a blank white 800×480
    // under this signature, which would stick on the panel until the data
    // next changes. An EMPTY window legitimately renders no tiles.
    const tileWait = page.waitForSelector('#collage .gtile', { timeout: 15000 });
    if (expectTiles) await tileWait;
    else await tileWait.catch(() => {});
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
const WIKI_UA = 'BarrysBirds/1.0 (+https://indianridgeroad.com/birds/; avian-worker)';
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
  // Mojo has no Wikipedia page (yet). Serve his curated field notes.
  if (sci === MOJO.sci) return json({ extract: MOJO.extract, title: MOJO.com }, 200, WIKI_DAY);
  if (!SCI_RE.test(sci)) return json({ error: 'invalid sci' }, 400, WIKI_DAY);

  // Scientific name first (WP redirects it to the species page); fall back to
  // the common name on a miss. com is sanitized to a plain title (letters,
  // space, '.', '-', '\''); it's encodeURIComponent'd before it reaches WP.
  let hit = await wikiSummary(sci);
  if (!hit) {
    const com = (url.searchParams.get('com') || '').trim();
    if (com && /^[\p{L}][\p{L} .'-]{1,58}$/u.test(com)) hit = await wikiSummary(com);
  }
  // A null can be a TRANSIENT Wikipedia failure, not just a missing article —
  // cache it briefly so an outage doesn't pin "no description" for a day.
  return hit
    ? json(hit, 200, WIKI_DAY)
    : json({ extract: null, title: null }, 200, { 'Cache-Control': 'public, max-age=300' });
}

// ---- read API (reimplements avian/api/birdnet-api.php over D1) ---------------

// Poll micro-cache. The page refetches ~10 of these endpoints every 30 s per
// visible tab (refreshAll in apt.js), and several aggregate over the whole
// detections table — measured 2026-07-03 at ~108M D1 rows read/day from routine
// viewing, enough to tip D1's storage object into reset loops (500 bursts across
// every endpoint, dropped detections). These responses only actually change when
// a new detection lands (MAX(ts) moves) or a rolling window slides (time passes),
// so serve from isolate memory keyed on (action+params, MAX(ts), 5-min clock
// bucket). Best-effort by design: a new isolate or an eviction just recomputes;
// staleness is bounded by the bucket (≤5 min) and a new detection busts it
// instantly. species/frame-config stay uncached (rare / must-be-fresh).
const POLL_CACHE = new Map(); // key → { ver, bucket, status, body }
const POLL_CACHE_ACTIONS = new Set(['recent', 'stats', 'lifelist', 'timeseries', 'firstseen', 'hourly', 'facts', 'rhythm', 'chorus']);
const POLL_CACHE_BUCKET_MS = 5 * 60 * 1000;
const POLL_CACHE_MAX = 200; // bound ?hours=/?days= key variants; FIFO-evict beyond

// Cache keys are built ONLY from the params each action actually reads, clamped
// to the same bounds its handler applies — a junk or randomized query string
// (?hours=1000000&x=<rand>) must collapse onto the canonical entry, not bypass
// the cache (every bypass re-runs a whole-table GROUP BY: the 07-03 D1 overload,
// attacker-triggerable on demand if the raw query string were the key). Bonus:
// /api/recent?hours=24 and /api/birdnet-api.php?action=recent&hours=24 now share
// one entry. KEEP IN SYNC with each handler's clampInt call (the tests lock it).
const POLL_CACHE_PARAMS = {
  recent:     [['hours', 24, 1, 1000000]],
  stats:      [],
  facts:      [],
  lifelist:   [],
  timeseries: [['days', 30, 1, 90]],
  firstseen:  [['limit', 10, 1, 50]],
  hourly:     [['hours', 24, 1, 1000000]],
  rhythm:     [['days', 14, 1, 90], ['top', 12, 1, 40]],
  chorus:     [['hours', 12, 1, 48], ['interval', 30, 10, 120], ['top', 24, 1, 60]],
};
function pollKey(action, url) {
  const parts = (POLL_CACHE_PARAMS[action] || [])
    .map(([name, dflt, lo, hi]) => `${name}=${clampInt(url.searchParams.get(name), dflt, lo, hi)}`);
  return action + '?' + parts.join('&');
}

async function queryApi(request, env, url) {
  if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);

  // action from ?action=, else inferred from the path's last segment, so both
  // /api/recent and /api/birdnet-api.php?action=recent resolve the same. The
  // action-less default to 'recent' is the PHP-shim contract — but only for
  // birdnet-api.php / the bare /api root; an unknown path is a real 404 (it
  // used to silently serve `recent`, masking typos from monitors and probes).
  const known = ['recent', 'stats', 'lifelist', 'timeseries', 'species', 'firstseen', 'hourly', 'rhythm', 'facts', 'frame-config', 'chorus'];
  const seg = url.pathname.replace(/\/+$/, '').split('/').pop() || '';
  let action = url.searchParams.get('action');
  if (!action) {
    if (known.includes(seg)) action = seg;
    else if (seg === 'birdnet-api.php' || seg === 'api') action = 'recent';
    else return json({ error: 'not found' }, 404);
  }

  const tz = tzMod(env);
  const now = Math.floor(Date.now() / 1000);

  const run = () => {
    switch (action) {
      case 'recent': return recent(env, url, tz, now);
      case 'stats': return stats(env, tz, now);
      case 'facts': return facts(env, tz, now);
      case 'lifelist': return lifelist(env, tz);
      case 'timeseries': return timeseries(env, url, tz, now);
      case 'hourly': return hourly(env, url, tz, now);
      case 'rhythm': return rhythm(env, url, tz, now);
      case 'chorus': return chorus(env, url, tz, now);
      case 'species': return species(env, url, tz);
      case 'firstseen': return firstseen(env, url, tz);
      case 'frame-config': return getFrameWindow(env).then((h) => json({ window_hours: h }));
      default: return json({ error: 'unknown action' }, 404);
    }
  };

  if (!POLL_CACHE_ACTIONS.has(action)) return run();
  return pollCached(env, pollKey(action, url), run);
}

// The micro-cache core, shared by queryApi and /api/coverage (which the HA
// dashboard polls with a full-table GROUP BY behind it).
async function pollCached(env, key, run) {
  // MAX(ts) is O(1) via idx_detections_ts — one row read per request, vs the
  // tens of thousands the aggregate endpoints would re-scan on every poll.
  const mx = await env.DB.prepare('SELECT MAX(ts) AS ts FROM detections').first();
  const ver = (mx && mx.ts) || 0;
  const bucket = Math.floor(Date.now() / POLL_CACHE_BUCKET_MS);
  const hit = POLL_CACHE.get(key);
  if (hit && hit.ver === ver && hit.bucket === bucket) {
    return new Response(hit.body, { status: hit.status, headers: { ...JSON_HEADERS, 'X-Poll-Cache': 'hit' } });
  }
  const res = await run();
  if (res.status === 200) {
    const body = await res.clone().text();
    POLL_CACHE.delete(key); // re-insert so Map order stays LRU-ish for FIFO eviction
    if (POLL_CACHE.size >= POLL_CACHE_MAX) POLL_CACHE.delete(POLL_CACHE.keys().next().value);
    POLL_CACHE.set(key, { ver, bucket, status: res.status, body });
  }
  return res;
}

async function recent(env, url, tz, now) {
  const hours = clampInt(url.searchParams.get('hours'), 24, 1, 1000000);
  const since = now - hours * 3600;
  // INDEXED BY: without it SQLite picks idx_detections_dedupe (sci,ts) to skip
  // the GROUP BY sort and SCANS THE WHOLE TABLE on every poll, ignoring the ts
  // window (measured 16k rows/query on 2026-07-03 → D1 overload resets). Pinning
  // idx_detections_ts makes it a range search: rows read = rows in the window.
  // Same trap on every windowed GROUP BY sci / COUNT(DISTINCT sci) query below.
  const { results } = await env.DB.prepare(
    `SELECT sci, com, COUNT(*) AS n, MAX(conf) AS best_conf,
            datetime(MAX(ts), 'unixepoch', ?) AS last_seen
       FROM detections INDEXED BY idx_detections_ts
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
  const todaySpec = (await first('SELECT COUNT(DISTINCT sci) AS n FROM detections INDEXED BY idx_detections_ts WHERE ts >= ?', todayStart)).n;
  const lastHour = (await first('SELECT COUNT(*) AS n FROM detections WHERE ts >= ?', hourStart)).n;
  const week = (await first('SELECT COUNT(*) AS n FROM detections WHERE ts >= ?', weekStart)).n;
  const weekSpec = (await first('SELECT COUNT(DISTINCT sci) AS n FROM detections INDEXED BY idx_detections_ts WHERE ts >= ?', weekStart)).n;
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
  const offH = tzOffsetHours(env);
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
  const td = await first('SELECT COUNT(*) AS n, COUNT(DISTINCT sci) AS s FROM detections INDEXED BY idx_detections_ts WHERE ts >= ?', todayStart);
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
    'SELECT com, sci, COUNT(*) AS n FROM detections INDEXED BY idx_detections_ts WHERE ts >= ? GROUP BY sci ORDER BY n DESC LIMIT 1', todayStart);
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
  // NO index pin here (removed 2026-07-10): this is the one windowed query where
  // idx_detections_dedupe is the RIGHT index — the outer side runs as per-species
  // (sci=?, ts>?) seeks off the join, ~4× faster than forcing idx_detections_ts
  // (verified with EXPLAIN QUERY PLAN + benchmark; the full-scan trap doesn't
  // fire on this shape).
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
  const lh = await first('SELECT COUNT(*) AS n, COUNT(DISTINCT sci) AS s FROM detections INDEXED BY idx_detections_ts WHERE ts >= ?', now - 3600);
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

// ---- coverage (/api/coverage): art + song-signature gaps for the admin page --
// Diffs the D1 life list against the art slugs (Pages art-manifest.json) and the
// song-signature set (Pages signatures.json) and returns the per-species gaps the
// HA "Barry's Birds" admin page lists + alerts on. Read-only, no secret (no
// metered work). See ../BIRDS-DASHBOARD.md.
//
// Pages serves a 200 HTML fallback for a missing asset, so we read the manifest
// (a real JSON list) rather than probing image URLs and trusting the status code.
// If a manifest can't be fetched/parsed we degrade to NO gap for that dimension
// (artSet/sigSet stay null → empty array) so a transient Pages hiccup can't
// false-alarm "all art missing"; the *_ok flags say which lists are trustworthy.

// Scientific names with no `type:song` clip on xeno-canto by design — a missing
// signature here is expected, so they're excluded from `signature_addable` (the
// list alerts fire on). Mirrors the EXEMPT note in build-signatures / CLAUDE.md.
const COVERAGE_SIG_EXEMPT = new Set([
  'Archilochus colubris',   // Ruby-throated Hummingbird
  'Dryobates villosus',     // Hairy Woodpecker
  'Sphyrapicus varius',     // Yellow-bellied Sapsucker
]);

// Same slug rule as apt.js slugify() + the illustration filenames.
function slugifySci(sci) {
  return String(sci).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function fetchJsonAsset(u) {
  try {
    const r = await fetch(u, {
      headers: { 'User-Agent': 'avian-worker/coverage' },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function coverage(env) {
  // Fallback matches wrangler.toml's PAGES_BASE — NOT the retired barrysbirds
  // stub, which only "worked" by chasing its 301 (the loop CLAUDE.md warns about).
  const base = (env.PAGES_BASE || 'https://birds-origin.indianridgeroad.com').replace(/\/+$/, '');

  // Detected species (life list), heaviest hitters first so the gap lists read
  // "most-heard missing bird" at the top.
  const { results } = await env.DB.prepare(
    `SELECT sci, com, COUNT(*) AS n
       FROM detections
      GROUP BY sci
      ORDER BY COUNT(*) DESC`
  ).all();
  const detected = results || [];

  // Art slugs + signature keys live in Pages (decoupled from the Worker, so art
  // and signatures expand on a Pages redeploy with no Worker change).
  const [manifest, sigs] = await Promise.all([
    fetchJsonAsset(`${base}/assets/art-manifest.json`),
    fetchJsonAsset(`${base}/assets/signatures.json`),
  ]);
  const artSet = manifest && Array.isArray(manifest.slugs) ? new Set(manifest.slugs) : null;
  const sigSet = sigs && sigs.species ? new Set(Object.keys(sigs.species)) : null;

  const art_missing = [];
  const signature_missing = [];
  const signature_addable = [];
  for (const r of detected) {
    const row = { sci: r.sci, com: r.com, n: r.n };
    if (artSet && !artSet.has(slugifySci(r.sci))) art_missing.push(row);
    if (sigSet && !sigSet.has(r.sci)) {
      signature_missing.push(row);
      if (!COVERAGE_SIG_EXEMPT.has(r.sci)) signature_addable.push(row);
    }
  }

  return json({
    art_missing,
    signature_missing,
    signature_addable,
    totals: {
      detected: detected.length,
      with_art: artSet ? artSet.size : null,
      with_signature: sigSet ? sigSet.size : null,
    },
    art_manifest_ok: artSet != null,
    signatures_ok: sigSet != null,
    as_of: new Date().toISOString(),
  }, 200, { 'Cache-Control': 'public, max-age=300' });
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
  const offH = tzOffsetHours(env);
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
  const offH = tzOffsetHours(env);
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

// Rolling N-hour stream of per-species detections, binned by a chosen interval, for
// the Chorus streamgraph. Fixed-duration rolling window (now-Nh .. now), independent
// of the collage window picker (like rhythm). Bins align to LOCAL wall-clock interval
// boundaries: a slot index floor((ts + tzOffset) / intervalSeconds) lands 30-min bins
// on tidy :00/:30 marks, and each species becomes a zero-filled array indexed by
// (slot - firstSlot). Returns the top ?top species by volume; the remainder is rolled
// into a single neutral "others" ribbon so the total stays honest. Reuses hourly()'s
// sun + now_local block for the daylight band + "now" edge.
async function chorus(env, url, tz, now) {
  const hours    = clampInt(url.searchParams.get('hours'), 12, 1, 48);
  const interval = clampInt(url.searchParams.get('interval'), 30, 10, 120); // minutes
  const top      = clampInt(url.searchParams.get('top'), 24, 1, 60);

  const iv   = interval * 60;                                  // interval seconds
  const offH = tzOffsetHours(env);
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

  // --- Trim all-zero bins at both ends so the river fills the width with the
  //     actual span of song. Overnight, "the last 12 h" trails off into dead
  //     quiet; dropping the empty edges keeps the stream honest (interior lulls
  //     survive) instead of wasting a third of the chart on silence. ---
  let lo = 0, hi = nBins - 1;
  while (lo < hi && totals[lo] === 0) lo++;
  while (hi > lo && totals[hi] === 0) hi--;
  const MIN_BINS = 8;                                          // a single busy bin still reads as a river
  if (hi - lo + 1 < MIN_BINS) {
    lo = Math.max(0, hi - (MIN_BINS - 1));                     // prefer to show the lead-up (extend earlier)
    if (hi - lo + 1 < MIN_BINS) hi = Math.min(nBins - 1, lo + (MIN_BINS - 1));
  }
  const endsAtNow = hi === nBins - 1;                          // did we keep the bin that contains "now"?
  const vis = hi - lo + 1;
  const cut = (a) => a.slice(lo, hi + 1);
  for (const s of bySci.values()) s.bins = cut(s.bins);       // every per-bin array trims to [lo, hi]

  const all  = [...bySci.values()].sort((a, b) => b.total - a.total);
  const kept = all.slice(0, top);
  const rest = all.slice(top);
  let others = null;
  if (rest.length) {
    const bins = new Array(vis).fill(0);
    let tot = 0;
    for (const s of rest) { for (let i = 0; i < vis; i++) bins[i] += s.bins[i]; tot += s.total; }
    others = { total: tot, bins, n_species: rest.length };
  }

  for (const s of kept) {                                      // peak bin → where its bird floats
    let p = 0, pn = -1;
    for (let i = 0; i < vis; i++) if (s.bins[i] > pn) { pn = s.bins[i]; p = i; }
    s.peak_bin = p;
  }

  const pad = (x) => String(x).padStart(2, '0');               // local bin-start labels (visible range only)
  const bin_starts = [];
  for (let i = lo; i <= hi; i++) {
    const d = new Date((firstSlot + i) * iv * 1000);           // local-aligned epoch read as UTC = local wall clock
    bin_starts.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`);
  }

  const localNow = new Date((now + off) * 1000);
  const now_local = { hour: localNow.getUTCHours(), minute: localNow.getUTCMinutes(),
                      frac: localNow.getUTCHours() + localNow.getUTCMinutes() / 60 };
  const sun = sunArc(env, localNow, offH);

  return json({
    window_hours: hours, interval_minutes: interval, n_bins: vis,
    tz_offset_hours: offH, now_local, sun, ends_at_now: endsAtNow,
    bin_starts, totals_by_bin: cut(totals), variety_by_bin: cut(variety),
    species: kept, others,
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

  return json({ sci, summary, detections, as_of: new Date().toISOString() });
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

// Exposed for unit tests only (worker/test/*) — not part of any runtime contract.
export {
  tzOffsetHours, tzMod, localDayStart, clampInt, clipKey, parseRange,
  isTransientD1, pollKey, frameSignature, POLL_CACHE, FRAME_WINDOWS, RARE_MAX,
};
