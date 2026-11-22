// Route-level tests against the default export's fetch(), with a fake D1/R2.
// These lock the incident-hardened behaviors: the transient-D1 retry loop and
// poll micro-cache (the 2026-07-03 overload), ingest's gate/validation/rare-
// clip archive + first-seen coverage webhook, and /api/frame-config's abuse
// hardening (2026-07-10).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker, { POLL_CACHE, RARE_MAX, parseClipName, CLIPS_CACHE, CLIPS_RECENT_MAX, comSafe } from '../src/index.js';

// Fake D1: routes SQL (by substring) to canned results or functions; records
// every call. INSERT/REPLACE semantics are NOT emulated — tests assert the SQL
// + bound args instead (real-SQLite behavior is D1's contract, not ours).
class FakeDB {
  constructor() { this.routes = []; this.calls = []; }
  on(pattern, result) { this.routes.push([pattern, result]); return this; }
  prepare(sql) {
    const db = this;
    const stmt = (args) => ({
      bind: (...a) => stmt(a),
      first: async () => db._hit(sql, args, 'first'),
      all: async () => ({ results: db._hit(sql, args, 'all') || [] }),
      run: async () => {
        const hit = db._hit(sql, args, 'run');
        if (hit && typeof hit === 'object' && hit.meta) return hit;
        return { success: true, meta: { changes: 1 } };
      },
    });
    return stmt([]);
  }
  _hit(sql, args, kind) {
    this.calls.push({ sql, args, kind });
    for (const [pat, res] of this.routes) {
      if (sql.includes(pat)) return typeof res === 'function' ? res(args, sql) : res;
    }
    return kind === 'all' ? [] : null;
  }
  count(pattern) { return this.calls.filter((c) => c.sql.includes(pattern)).length; }
  find(pattern) { return this.calls.find((c) => c.sql.includes(pattern)); }
}

class FakeR2 {
  constructor(objects = {}) { this.objects = { ...objects }; this.puts = []; this.deletes = []; this.meta = {}; }
  async head(k) { return this.objects[k] ? { size: this._size(k), httpEtag: 'W/"t"' } : null; }
  async get(k, opts) {
    if (!this.objects[k]) return null;
    // Mirror real R2: an unsatisfiable range THROWS rather than returning null.
    if (opts && opts.range && opts.range.offset != null && opts.range.offset >= this._size(k)) {
      throw new Error('get: invalid range');
    }
    return { body: this.objects[k], size: this._size(k) };
  }
  async put(k, body, opts = {}) {
    this.puts.push(k); this.objects[k] = body;
    if (opts.customMetadata) this.meta[k] = opts.customMetadata;
  }
  async delete(k) { this.deletes.push(k); delete this.objects[k]; }
  async list({ prefix = '' } = {}) {
    const objects = Object.keys(this.objects).filter((k) => k.startsWith(prefix))
      .map((k) => ({ key: k, customMetadata: this.meta[k] }));
    return { objects, truncated: false };
  }
  _size(k) { return typeof this.objects[k] === 'string' ? this.objects[k].length : 3; }
}

const SECRET = 'test-ingest-secret';
const env = (db, extra = {}) => ({ DB: db, TZ_OFFSET_HOURS: '-4', AVIAN_INGEST_SECRET: SECRET, ...extra });
const get = (path, e, headers = {}) => worker.fetch(new Request('https://w.example' + path, { headers }), e);
const post = (path, e, body, headers = {}) =>
  worker.fetch(new Request('https://w.example' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }), e);

beforeEach(() => {
  POLL_CACHE.clear();
  CLIPS_CACHE.clear();
  vi.spyOn(console, 'error').mockImplementation(() => {}); // exercised on purpose below
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('transient-D1 retry loop', () => {
  it('retries the storage-reset signature and succeeds', async () => {
    const db = new FakeDB();
    let attempts = 0;
    db.on('SELECT MAX(ts)', () => {
      attempts += 1;
      if (attempts < 3) throw new Error('D1_ERROR: storage caused object to be reset');
      return { ts: 1234 };
    });
    const res = await get('/api/recent?hours=24', env(db));
    expect(res.status).toBe(200);
    expect(attempts).toBe(3);
  });

  it('does not retry non-transient errors, and returns a bare error body', async () => {
    const db = new FakeDB();
    let attempts = 0;
    db.on('SELECT MAX(ts)', () => { attempts += 1; throw new Error('SQLITE_ERROR: no such table'); });
    const res = await get('/api/recent?hours=24', env(db));
    expect(res.status).toBe(500);
    expect(attempts).toBe(1);
    const body = await res.json();
    expect(body).toEqual({ error: 'internal' }); // no detail: internals stay server-side
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('poll micro-cache', () => {
  it('collapses junk params and both URL styles onto one entry', async () => {
    const db = new FakeDB();
    db.on('SELECT MAX(ts)', { ts: 1000 });
    db.on('INDEXED BY idx_detections_ts', [
      { sci: 'Turdus migratorius', com: 'American Robin', n: 3, best_conf: 0.91, last_seen: '2026-07-10 08:00:00' },
    ]);
    const e = env(db);
    const r1 = await get('/api/recent?hours=24', e);
    expect(r1.status).toBe(200);
    expect(r1.headers.get('X-Poll-Cache')).toBeNull();

    // PHP-shim URL style + junk params: must be a HIT on the same entry.
    const r2 = await get('/api/birdnet-api.php?action=recent&hours=24&junk=zzz&r=42', e);
    expect(r2.headers.get('X-Poll-Cache')).toBe('hit');
    // The whole-table GROUP BY ran exactly once across all three requests.
    const r3 = await get('/api/recent?hours=24&cachebust=abc', e);
    expect(r3.headers.get('X-Poll-Cache')).toBe('hit');
    expect(db.count('INDEXED BY idx_detections_ts')).toBe(1);
  });

  it('busts instantly when a new detection lands (MAX(ts) moves)', async () => {
    const db = new FakeDB();
    let ver = 1000;
    db.on('SELECT MAX(ts)', () => ({ ts: ver }));
    db.on('INDEXED BY idx_detections_ts', []);
    const e = env(db);
    await get('/api/recent?hours=24', e);
    ver = 2000; // new detection
    const res = await get('/api/recent?hours=24', e);
    expect(res.headers.get('X-Poll-Cache')).toBeNull();
  });

  it('404s unknown /api/ paths instead of silently serving recent', async () => {
    const db = new FakeDB();
    const res = await get('/api/definitely-not-a-route', env(db));
    expect(res.status).toBe(404);
  });
});

describe('ingest (POST /api/detection)', () => {
  const good = () => ({
    sci: 'Turdus migratorius', com: 'American Robin', conf: 0.91,
    ts: Math.floor(Date.now() / 1000), file: 'Robin-91-2026-07-10-birdnet-08:00:00.mp3',
  });

  it('is secret-gated and fails closed without a configured secret', async () => {
    const db = new FakeDB();
    expect((await post('/api/detection', env(db), good())).status).toBe(401);
    expect((await post('/api/detection', env(db), good(), { 'X-Avian-Secret': 'wrong' })).status).toBe(401);
    const noSecret = env(db); delete noSecret.AVIAN_INGEST_SECRET;
    expect((await post('/api/detection', noSecret, good(), { 'X-Avian-Secret': '' })).status).toBe(401);
  });

  it('validates the payload', async () => {
    const db = new FakeDB();
    const e = env(db);
    const auth = { 'X-Avian-Secret': SECRET };
    expect((await post('/api/detection', e, 'not json', auth)).status).toBe(400);
    expect((await post('/api/detection', e, { sci: 'A a' }, auth)).status).toBe(400);
    expect((await post('/api/detection', e, { ...good(), sci: 'x'.repeat(121) }, auth)).status).toBe(400);
    expect((await post('/api/detection', e, { ...good(), ts: Math.floor(Date.now() / 1000) + 8 * 86400 }, auth)).status).toBe(400);
    expect((await post('/api/detection', e, { ...good(), ts: Math.floor(Date.now() / 1000) + 2 * 86400 }, auth)).status).toBe(400);
    expect((await post('/api/detection', e, { ...good(), ts: Math.floor(Date.now() / 1000) - 61 * 86400 }, auth)).status).toBe(400);
    expect(db.count('INSERT')).toBe(0);
  });

  it('accepts a weeks-old backlog replay (a >7-day outage must not drop data)', async () => {
    const db = new FakeDB();
    const res = await post('/api/detection', env(db),
      { ...good(), ts: Math.floor(Date.now() / 1000) - 30 * 86400 }, { 'X-Avian-Secret': SECRET });
    expect(res.status).toBe(204);
    expect(db.count('INSERT OR IGNORE INTO detections')).toBe(1);
  });

  it('inserts with INSERT OR IGNORE (the (sci,ts) dedupe) and clamps conf', async () => {
    const db = new FakeDB();
    const e = env(db);
    const auth = { 'X-Avian-Secret': SECRET };
    const d = good();
    expect((await post('/api/detection', e, { ...d, conf: 91 }, auth)).status).toBe(204);
    const ins = db.find('INSERT');
    expect(ins.sql).toContain('INSERT OR IGNORE INTO detections');
    expect(ins.args).toEqual([d.sci, d.com, 0.91, d.ts, d.file]);

    expect((await post('/api/detection', e, { ...d, conf: 250 }, auth)).status).toBe(204);
    expect(db.calls.filter((c) => c.sql.includes('INSERT')).pop().args[2]).toBe(1); // clamped 0..1
  });

  // n archived Robin clips at the given confidence percentages.
  const archived = (pcts) => Object.fromEntries(pcts.map((pct, i) =>
    [`rare/Robin-${pct}-2026-06-${String(i + 1).padStart(2, '0')}-birdnet-07:00:00.mp3`, 'old']));

  it('archives a clip to rare/ while the species has room, with its confidence', async () => {
    const clips = new FakeR2({ ['clips/' + good().file]: 'mp3bytes', ...archived([80, 85, 90]) });
    const res = await post('/api/detection', env(new FakeDB(), { CLIPS: clips }), good(), { 'X-Avian-Secret': SECRET });
    expect(res.status).toBe(204);
    expect(clips.puts).toEqual(['rare/' + good().file]);
    expect(clips.meta['rare/' + good().file]).toEqual({ sci: good().sci, conf: '0.91' });
    expect(clips.deletes).toEqual([]);
  });

  it('when full, a clearer clip replaces the weakest one (write first, then one delete)', async () => {
    const pcts = Array.from({ length: RARE_MAX }, (_, i) => 70 + (i % 20)); // weakest = 70
    const clips = new FakeR2({ ['clips/' + good().file]: 'mp3bytes', ...archived(pcts) });
    await post('/api/detection', env(new FakeDB(), { CLIPS: clips }), good(), { 'X-Avian-Secret': SECRET });
    expect(clips.puts).toEqual(['rare/' + good().file]);
    expect(clips.deletes).toEqual(['rare/Robin-70-2026-06-01-birdnet-07:00:00.mp3']);
    expect(Object.keys(clips.objects).filter((k) => k.startsWith('rare/')).length).toBe(RARE_MAX);
  });

  it('when full, a clip that is not clearly better changes nothing', async () => {
    const pcts = Array.from({ length: RARE_MAX }, () => 90); // new clip is 0.91: inside the margin
    const clips = new FakeR2({ ['clips/' + good().file]: 'mp3bytes', ...archived(pcts) });
    await post('/api/detection', env(new FakeDB(), { CLIPS: clips }), good(), { 'X-Avian-Secret': SECRET });
    expect(clips.puts).toEqual([]);
    expect(clips.deletes).toEqual([]);
  });

  it('never touches another species whose name shares the prefix, or a replayed clip', async () => {
    const other = Object.fromEntries(Array.from({ length: RARE_MAX }, (_, i) =>
      [`rare/Robin-like_Thrush-60-2026-06-${String(i + 1).padStart(2, '0')}-birdnet-07:00:00.mp3`, 'x']));
    const clips = new FakeR2({ ['clips/' + good().file]: 'mp3bytes', ...other });
    await post('/api/detection', env(new FakeDB(), { CLIPS: clips }), good(), { 'X-Avian-Secret': SECRET });
    expect(clips.puts).toEqual(['rare/' + good().file]); // Robin had room: the 25 are not Robin's
    expect(clips.deletes).toEqual([]);

    const replay = new FakeR2({ ['clips/' + good().file]: 'mp3bytes', ['rare/' + good().file]: 'already' });
    await post('/api/detection', env(new FakeDB(), { CLIPS: replay }), good(), { 'X-Avian-Secret': SECRET });
    expect(replay.puts).toEqual([]);
  });

  it('parses the BirdNET clip name (species part + confidence)', () => {
    expect(parseClipName('Blue-gray_Gnatcatcher-74-2026-06-20-birdnet-17:31:27.mp3')).toEqual({ name: 'Blue-gray_Gnatcatcher', conf: 0.74 });
    expect(parseClipName('whatever.mp3')).toBeNull();
  });

  it('never fails the ingest when the archive throws (but logs it)', async () => {
    const clips = new FakeR2();
    clips.list = async () => { throw new Error('R2 down'); };
    const res = await post('/api/detection', env(new FakeDB(), { CLIPS: clips }), good(), { 'X-Avian-Secret': SECRET });
    expect(res.status).toBe(204);
    expect(console.error).toHaveBeenCalled();
  });
});

describe('ingest coverage-gap webhook (fires when a species is confirmed)', () => {
  const HOOK_URL = 'https://hooks.example/coverage';
  const HOOK_KEY = 'test-webhook-key';
  const hook = { COVERAGE_WEBHOOK_URL: HOOK_URL, COVERAGE_WEBHOOK_KEY: HOOK_KEY };
  const auth = { 'X-Avian-Secret': SECRET };
  const novel = () => ({
    sci: 'Cardinalis cardinalis', com: 'Northern Cardinal',
    conf: 0.91, ts: Math.floor(Date.now() / 1000),
  });

  // Prior history of the species, as justConfirmed() reads it. No argument =
  // never heard before. `days` apart → lo/hi fall on different local days.
  const SPAN_SQL = 'ORDER BY ts ASC LIMIT 1) AS lo';
  function dbWithPrior(prior) {
    const db = new FakeDB();
    if (prior) {
      const hi = Math.floor(Date.now() / 1000) - (prior.daysAgo ?? 0) * 86400;
      db.on(SPAN_SQL, { lo: hi - (prior.spanDays ?? 0) * 86400, hi });
      db.on('SELECT MAX(conf) AS c', { c: prior.maxConf ?? 0.75 });
    }
    return db;
  }
  const dbWithCount = (n) => (n === 1 ? dbWithPrior() : dbWithPrior({ spanDays: 5 }));

  // Capture webhook POSTs. Manifest GETs are answered from `slugs`/`species`
  // so the notify path can decide art vs signature gaps without the network.
  function stubCoverageAssets({ slugs = [], species = {}, webhook = {} } = {}) {
    const posts = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const url = String(input);
      if (url.includes('art-manifest.json')) {
        return new Response(JSON.stringify({ slugs }), { status: 200 });
      }
      if (url.includes('signatures.json')) {
        return new Response(JSON.stringify({ species }), { status: 200 });
      }
      if (String(init.method || 'GET').toUpperCase() === 'POST') {
        posts.push({ headers: init.headers || {}, body: JSON.parse(init.body) });
        if (webhook.throw) throw new Error('webhook down');
        return new Response('ok', { status: webhook.status ?? 200 });
      }
      return new Response('no', { status: 404 });
    }));
    return posts;
  }

  it('POSTs sci/com + gap flags when a strong first hit confirms a species missing art and/or a signature', async () => {
    const posts = stubCoverageAssets({
      slugs: ['turdus-migratorius'],
      species: { 'Turdus migratorius': {} },
    });
    const d = novel();
    const res = await post('/api/detection', env(dbWithCount(1), hook), d, auth);
    expect(res.status).toBe(204);
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({
      event: 'coverage_gap',
      sci: d.sci,
      com: d.com,
      art_missing: true,
      signature_missing: true,
    });
    expect(posts[0].headers.Authorization).toBe('Bearer ' + HOOK_KEY);
    expect(posts[0].headers['X-Automation-Key']).toBe(HOOK_KEY);
    expect(posts[0].headers['X-Webhook-Key']).toBe(HOOK_KEY);

    // Fully covered first-seen: no ping. Same COUNT=1 (different sci in
    // a real DB); the stub answers both manifests as present for the robin.
    const covered = stubCoverageAssets({
      slugs: ['turdus-migratorius'],
      species: { 'Turdus migratorius': {} },
    });
    const robin = {
      sci: 'Turdus migratorius', com: 'American Robin',
      conf: 0.88, ts: Math.floor(Date.now() / 1000),
    };
    expect((await post('/api/detection', env(dbWithCount(1), hook), robin, auth)).status).toBe(204);
    expect(covered).toHaveLength(0);
  });

  it('does not POST on a subsequent detection of the same sci (or a replay)', async () => {
    const posts = stubCoverageAssets({ slugs: [], species: {} });
    const d = novel();
    expect((await post('/api/detection', env(dbWithCount(4), hook), d, auth)).status).toBe(204);
    expect(posts).toHaveLength(0);

    // INSERT OR IGNORE replay: changes=0 even if the life list still has n=1.
    const replay = stubCoverageAssets({ slugs: [], species: {} });
    const db = dbWithCount(1);
    db.on('INSERT OR IGNORE', { success: true, meta: { changes: 0 } });
    expect((await post('/api/detection', env(db, hook), d, auth)).status).toBe(204);
    expect(replay).toHaveLength(0);
    expect(db.count(SPAN_SQL)).toBe(0);
  });

  it('waits for confirmation: a weak one-off does not ping; a second day or a strong hit does', async () => {
    const weak = { ...novel(), conf: 0.74 };
    const first = stubCoverageAssets({ slugs: [], species: {} });
    await post('/api/detection', env(dbWithPrior(), hook), weak, auth);
    expect(first).toHaveLength(0);                       // first ever, weak → unconfirmed

    const sameDay = stubCoverageAssets({ slugs: [], species: {} });
    await post('/api/detection', env(dbWithPrior({ daysAgo: 0 }), hook), weak, auth);
    expect(sameDay).toHaveLength(0);                     // weak again, same day → still unconfirmed

    const secondDay = stubCoverageAssets({ slugs: [], species: {} });
    await post('/api/detection', env(dbWithPrior({ daysAgo: 3 }), hook), weak, auth);
    expect(secondDay).toHaveLength(1);                   // weak, but a different day → confirmed now

    const strongLater = stubCoverageAssets({ slugs: [], species: {} });
    await post('/api/detection', env(dbWithPrior({ daysAgo: 0 }), hook), novel(), auth);
    expect(strongLater).toHaveLength(1);                 // same day, 0.91 → confirmed now

    const alreadyStrong = stubCoverageAssets({ slugs: [], species: {} });
    await post('/api/detection', env(dbWithPrior({ daysAgo: 0, maxConf: 0.95 }), hook), novel(), auth);
    expect(alreadyStrong).toHaveLength(0);               // was confirmed by an earlier strong hit
  });

  it('still returns 204 when the webhook is unset or the POST fails', async () => {
    const unsetPosts = stubCoverageAssets({ slugs: [], species: {} });
    expect((await post('/api/detection', env(dbWithCount(1)), novel(), auth)).status).toBe(204);
    expect(unsetPosts).toHaveLength(0);

    stubCoverageAssets({ slugs: [], species: {}, webhook: { throw: true } });
    expect((await post('/api/detection', env(dbWithCount(1), hook), novel(), auth)).status).toBe(204);
    expect(console.error).toHaveBeenCalled();

    const httpFail = stubCoverageAssets({ slugs: [], species: {}, webhook: { status: 503 } });
    expect((await post('/api/detection', env(dbWithCount(1), hook), novel(), auth)).status).toBe(204);
    expect(httpFail).toHaveLength(1);
    expect(console.error).toHaveBeenCalled();
  });

  it('never notifies for Mojo, and does not ping an exempt species for a missing signature alone', async () => {
    const mojoPosts = stubCoverageAssets({ slugs: [], species: {} });
    const mojo = {
      sci: 'Canis volaticus', com: 'Mojo',
      conf: 0.9, ts: Math.floor(Date.now() / 1000),
    };
    expect((await post('/api/detection', env(dbWithCount(1), hook), mojo, auth)).status).toBe(204);
    expect(mojoPosts).toHaveLength(0);

    // Hummingbird: no tonal song → signature gap is expected. Art present ⇒ silent.
    const exemptCovered = stubCoverageAssets({
      slugs: ['archilochus-colubris'],
      species: {},
    });
    const hum = {
      sci: 'Archilochus colubris', com: 'Ruby-throated Hummingbird',
      conf: 0.8, ts: Math.floor(Date.now() / 1000),
    };
    expect((await post('/api/detection', env(dbWithCount(1), hook), hum, auth)).status).toBe(204);
    expect(exemptCovered).toHaveLength(0);

    // Same exempt species, but missing art ⇒ art-only ping (signature_missing false).
    const exemptArt = stubCoverageAssets({ slugs: ['turdus-migratorius'], species: {} });
    expect((await post('/api/detection', env(dbWithCount(1), hook), { ...hum, conf: 0.95 }, auth)).status).toBe(204);
    expect(exemptArt).toHaveLength(1);
    expect(exemptArt[0].body.art_missing).toBe(true);
    expect(exemptArt[0].body.signature_missing).toBe(false);
  });
});

describe('clip upload (POST /api/clip)', () => {
  const MP3_ID3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]);       // "ID3..."
  const MP3_SYNC = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);            // MPEG frame sync
  const NOT_MP3 = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);             // PNG magic
  const upload = (e, bytes) =>
    worker.fetch(new Request('https://w.example/api/clip?file=x.mp3', {
      method: 'POST', headers: { 'X-Avian-Secret': SECRET }, body: bytes,
    }), e);

  it('accepts both real MP3 magics and stores under clips/', async () => {
    const clips = new FakeR2();
    const e = env(new FakeDB(), { CLIPS: clips });
    expect((await upload(e, MP3_ID3)).status).toBe(204);
    expect((await upload(e, MP3_SYNC)).status).toBe(204);
    expect(clips.puts).toEqual(['clips/x.mp3', 'clips/x.mp3']);
  });

  it('rejects non-MP3 bytes with 415 (bucket is served as audio/mpeg)', async () => {
    const clips = new FakeR2();
    const res = await upload(env(new FakeDB(), { CLIPS: clips }), NOT_MP3);
    expect(res.status).toBe(415);
    expect(clips.puts).toEqual([]);
  });
});

describe('recording (GET /api/recording) Range handling', () => {
  const KEY = 'Robin-91-2026-07-10-birdnet-08:00:00.mp3';
  const BYTES = '0123456789'; // size 10 via FakeR2._size
  const fetchRec = (e, headers = {}) =>
    get('/api/recording?file=' + encodeURIComponent(KEY), e, headers);

  it('serves 200 with Content-Length, and 206 for a satisfiable range', async () => {
    const e = env(new FakeDB(), { CLIPS: new FakeR2({ ['clips/' + KEY]: BYTES }) });
    const full = await fetchRec(e);
    expect(full.status).toBe(200);
    expect(full.headers.get('Content-Length')).toBe('10');

    const part = await fetchRec(e, { Range: 'bytes=2-5' });
    expect(part.status).toBe(206);
    expect(part.headers.get('Content-Range')).toBe('bytes 2-5/10');
    expect(part.headers.get('Content-Length')).toBe('4');
  });

  it('returns 416 (not 500) for an unsatisfiable range — R2 would throw', async () => {
    const e = env(new FakeDB(), { CLIPS: new FakeR2({ ['clips/' + KEY]: BYTES }) });
    const res = await fetchRec(e, { Range: 'bytes=999-' });
    expect(res.status).toBe(416);
    expect(res.headers.get('Content-Range')).toBe('bytes */10');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('errors are JSON like every other endpoint', async () => {
    const e = env(new FakeDB(), { CLIPS: new FakeR2() });
    const res = await fetchRec(e);
    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect((await res.json()).error).toBeTruthy();
  });
});

describe('frame-config (POST /api/frame-config)', () => {
  it('validates, skips no-op writes, and rate-limits rapid changes', async () => {
    vi.setSystemTime(new Date('2026-07-10T12:00:00Z'));
    const db = new FakeDB();
    db.on('SELECT frame_window_hours', { h: 24 });
    const e = env(db);

    expect((await post('/api/frame-config', e, { window_hours: 13 })).status).toBe(400);

    // No-op: setting the current value writes nothing (no D1 quota burn).
    expect((await post('/api/frame-config', e, { window_hours: 24 })).status).toBe(200);
    expect(db.count('INSERT OR REPLACE INTO settings')).toBe(0);

    // Real change: accepted.
    expect((await post('/api/frame-config', e, { window_hours: 12 })).status).toBe(200);
    expect(db.count('INSERT OR REPLACE INTO settings')).toBe(1);

    // Second change inside the interval: rate-limited.
    vi.setSystemTime(new Date('2026-07-10T12:00:01Z'));
    expect((await post('/api/frame-config', e, { window_hours: 168 })).status).toBe(429);
    expect(db.count('INSERT OR REPLACE INTO settings')).toBe(1);

    // After the interval: accepted again.
    vi.setSystemTime(new Date('2026-07-10T12:00:10Z'));
    expect((await post('/api/frame-config', e, { window_hours: 168 })).status).toBe(200);
    expect(db.count('INSERT OR REPLACE INTO settings')).toBe(2);
  });
});

describe('/frame.png gate + per-window cache', () => {
  it('fails CLOSED when FRAME_KEY is unset (unless FRAME_DEV_OPEN)', async () => {
    const db = new FakeDB();
    expect((await get('/frame.png', env(db))).status).toBe(401);
    expect((await get('/frame.png?k=whatever', env(db))).status).toBe(401);
  });

  it('rejects a wrong key, accepts the X-Frame-Key header, serves the per-window cache row', async () => {
    const png = [0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0];
    const db = new FakeDB();
    db.on('SELECT frame_window_hours', { h: 12 });
    db.on('GROUP BY sci', [{ sci: 'Turdus migratorius', n: 5 }]);
    let cacheArgs = null;
    db.on('SELECT png FROM frame_cache WHERE id = ? AND sig = ?', (args) => { cacheArgs = args; return { png }; });
    const e = env(db, { FRAME_KEY: 'fk' });

    expect((await get('/frame.png?k=nope', e)).status).toBe(401);

    const res = await get('/frame.png', e, { 'X-Frame-Key': 'fk' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('X-Frame-Cache')).toBe('hit');
    expect(cacheArgs[0]).toBe(12); // keyed by the CONFIGURED window, not a fixed id=1
  });
});

describe('field notes (GET /api/facts)', () => {
  // 15:20Z with a fixed -4 offset = 11:20 local. Calls logged 6am-10am only.
  const factsAt1120 = async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-15T15:20:00Z'));
    const db = new FakeDB()
      .on('COUNT(*) AS n, COUNT(DISTINCT sci) AS s', { n: 10, s: 2 })
      .on('GROUP BY h', [6, 7, 8, 9, 10].map((h) => ({ h, n: 2 })))
      .on('SELECT COUNT(*) AS n FROM detections', { n: 10 });
    const res = await get('/api/facts', env(db));
    expect(res.status).toBe(200);
    return { db, facts: (await res.json()).facts };
  };

  it('QUIET never counts hours that have not happened yet', async () => {
    const { facts } = await factsAt1120();
    const quiet = facts.filter((f) => f.kind === 'quiet').map((f) => f.text);
    // The old cyclic scan reported "11am–6am" (the rest of today + the night).
    expect(quiet).toEqual(['Quietest stretch: 12am–6am.']);
  });

  it('formats hours in per-row local time, with no bound tz modifier', async () => {
    const { db } = await factsAt1120();
    const byHour = db.find('GROUP BY h');
    expect(byHour.sql).toContain("strftime('%H', (ts + -14400), 'unixepoch')");
    expect(byHour.args.length).toBe(1); // just todayStart
  });
});

describe('recording ?sci= picks the clearest clip', () => {
  it('prefers the highest-confidence recent clip over the newest', async () => {
    const db = new FakeDB()
      .on('ORDER BY conf DESC, ts DESC', { file: 'Robin-97-clear.mp3' })
      .on('ORDER BY ts DESC LIMIT 1', { file: 'Robin-71-faint.mp3' });
    const e = env(db, { CLIPS: new FakeR2({ 'clips/Robin-97-clear.mp3': 'aaaa', 'clips/Robin-71-faint.mp3': 'bb' }) });
    const res = await get('/api/recording?sci=Turdus%20migratorius', e);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Length')).toBe('4');
  });

  it('falls back to the clearest archived clip once the hot set has expired', async () => {
    const db = new FakeDB()
      .on('ORDER BY ts DESC LIMIT 1', { file: 'Veery-75-2026-07-01-birdnet-09:21:12.mp3' });
    const e = env(db, { CLIPS: new FakeR2({
      'rare/Veery-72-2026-06-02-birdnet-05:00:00.mp3': 'cc',
      'rare/Veery-88-2026-06-09-birdnet-05:00:00.mp3': 'ccccc',
    }) });
    const res = await get('/api/recording?sci=Catharus%20fuscescens', e);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Length')).toBe('5');
  });
});

describe('clip listing for the instrument (GET /api/clips)', () => {
  const SPECIES = [
    { sci: 'Poecile atricapillus', com: 'Black-capped Chickadee', n: 900, confirmed: 1 },
    { sci: 'Accipiter cooperii', com: "Cooper's Hawk", n: 12, confirmed: 1 },
    { sci: 'Catharus fuscescens', com: 'Veery', n: 1, confirmed: 0 },
    { sci: 'Canis volaticus', com: 'Mojo', n: 40, confirmed: 1 },
    { sci: 'Corvus corax', com: 'Common Raven', n: 3, confirmed: 1 }, // heard, but nothing archived
  ];
  const MOJO_FILE = 'Mojo-93-2026-07-03-birdnet-08:12:47.mp3';
  const bucket = () => {
    const r2 = new FakeR2({
      'rare/Black-capped_Chickadee-81-2026-07-01-birdnet-06:00:00.mp3': 'a',
      'rare/Black-capped_Chickadee-97-2026-07-02-birdnet-06:00:00.mp3': 'a',
      'rare/Black-capped_Chickadee-90-2026-07-03-birdnet-06:00:00.mp3': 'a',
      'rare/Coopers_Hawk-88-2026-07-04-birdnet-09:00:00.mp3': 'a',        // apostrophe dropped by BirdNET-Pi
      'rare/Veery-75-2026-07-01-birdnet-09:21:12.mp3': 'a',
      'rare/Some_Vanished_Bird-80-2026-07-01-birdnet-09:00:00.mp3': 'a',  // not on the life list
      'rare/not-a-birdnet-name.mp3': 'a',
      ['clips/' + MOJO_FILE]: 'woof',
      'clips/Black-capped_Chickadee-70-2026-11-20-birdnet-07:00:00.mp3': 'a', // hot set: not listed by default
    });
    // A newer archive entry carries its species + exact confidence as metadata.
    r2.meta['rare/Black-capped_Chickadee-90-2026-07-03-birdnet-06:00:00.mp3'] = { sci: 'Poecile atricapillus', conf: '0.985' };
    return r2;
  };
  const dbWith = () => new FakeDB().on('ORDER BY COUNT(*) DESC', SPECIES);

  it('maps the BirdNET-Pi safe name', () => {
    expect(comSafe("Cooper's Hawk")).toBe('Coopers_Hawk');
    expect(comSafe('Black-capped Chickadee')).toBe('Black-capped_Chickadee');
  });

  it('groups archived clips by species, clearest first, with the confirmed flag', async () => {
    const res = await get('/api/clips', env(dbWith(), { CLIPS: bucket() }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const body = await res.json();
    const by = Object.fromEntries(body.species.map((s) => [s.sci, s]));
    // Metadata confidence (0.985) outranks the filename's rounded 97/81.
    expect(by['Poecile atricapillus'].clips.map((c) => c.conf)).toEqual([0.985, 0.97, 0.81]);
    expect(by['Accipiter cooperii'].clips).toEqual([{ file: 'Coopers_Hawk-88-2026-07-04-birdnet-09:00:00.mp3', conf: 0.88 }]);
    expect(by['Catharus fuscescens'].confirmed).toBe(0);
    expect(by['Poecile atricapillus'].confirmed).toBe(1);
    // Species with nothing archived, vanished species and odd keys are left out.
    expect(by['Corvus corax']).toBeUndefined();
    expect(body.species.every((s) => s.clips.length > 0)).toBe(true);
    // Mojo's one bark lives under clips/, not rare/.
    expect(by['Canis volaticus'].clips).toEqual([{ file: MOJO_FILE, conf: 0.93 }]);
    expect(body.total_clips).toBe(6);
    // Most-heard species first.
    expect(body.species[0].sci).toBe('Poecile atricapillus');
  });

  it('caches the listing per isolate (one GROUP BY + one R2 list across requests)', async () => {
    const db = dbWith();
    const r2 = bucket();
    let lists = 0;
    const list = r2.list.bind(r2);
    r2.list = async (o) => { lists += 1; return list(o); };
    const e = env(db, { CLIPS: r2 });
    await get('/api/clips', e);
    await get('/api/clips?junk=1', e);
    await get('/api/clips?sci=Poecile%20atricapillus', e);
    expect(db.count('ORDER BY COUNT(*) DESC')).toBe(1);
    expect(lists).toBe(1);
  });

  it('?sci= adds the clearest recent clips, without repeating archived ones', async () => {
    const db = dbWith().on('ORDER BY conf DESC, ts DESC LIMIT ?', [
      { file: 'Black-capped_Chickadee-97-2026-07-02-birdnet-06:00:00.mp3', conf: 0.97 }, // already archived
      { file: 'Black-capped_Chickadee-70-2026-11-20-birdnet-07:00:00.mp3', conf: 0.7 },
      { file: '../escape.mp3', conf: 0.9 },                                               // never trusted
    ]);
    const res = await get('/api/clips?sci=Poecile%20atricapillus', env(db, { CLIPS: bucket() }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.com).toBe('Black-capped Chickadee');
    expect(body.clips.map((c) => c.src)).toEqual(['rare', 'rare', 'rare', 'recent']);
    expect(body.clips[3].file).toBe('Black-capped_Chickadee-70-2026-11-20-birdnet-07:00:00.mp3');
    const q = db.find('ORDER BY conf DESC, ts DESC LIMIT ?');
    expect(q.args[0]).toBe('Poecile atricapillus');
    expect(q.args[2]).toBe(CLIPS_RECENT_MAX);
  });

  it('an unknown or junk ?sci= is a 404 that never reaches D1', async () => {
    const db = dbWith();
    const e = env(db, { CLIPS: bucket() });
    expect((await get('/api/clips?sci=Not%20a%20bird', e)).status).toBe(404);
    expect((await get('/api/clips?sci=' + 'x'.repeat(500), e)).status).toBe(404);
    expect(db.count('ORDER BY conf DESC, ts DESC LIMIT ?')).toBe(0);
  });

  it('Mojo in solo mode is just his bark (no hot-set query)', async () => {
    const db = dbWith();
    const res = await get('/api/clips?sci=Canis%20volaticus', env(db, { CLIPS: bucket() }));
    expect((await res.json()).clips).toEqual([{ file: MOJO_FILE, conf: 0.93, src: 'rare' }]);
    expect(db.count('ORDER BY conf DESC, ts DESC LIMIT ?')).toBe(0);
  });

  it('503s without clip storage', async () => {
    expect((await get('/api/clips', env(new FakeDB()))).status).toBe(503);
  });
});
