// Route-level tests against the default export's fetch(), with a fake D1/R2.
// These lock the incident-hardened behaviors: the transient-D1 retry loop and
// poll micro-cache (the 2026-07-03 overload), ingest's gate/validation/rare-
// clip archive, and /api/frame-config's abuse hardening (2026-07-10).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker, { POLL_CACHE, RARE_MAX } from '../src/index.js';

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
      run: async () => { db._hit(sql, args, 'run'); return { success: true }; },
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
  constructor(objects = {}) { this.objects = { ...objects }; this.puts = []; }
  async head(k) { return this.objects[k] ? {} : null; }
  async get(k) { return this.objects[k] ? { body: this.objects[k], size: 3 } : null; }
  async put(k, body) { this.puts.push(k); this.objects[k] = body; }
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
    expect(db.count('INSERT')).toBe(0);
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

  it('archives a rare species\' clip to rare/ (first lifetime clips only)', async () => {
    const db = new FakeDB();
    db.on('SELECT COUNT(*) AS n FROM detections WHERE sci = ?', { n: 3 });
    const clips = new FakeR2({ ['clips/' + good().file]: 'mp3bytes' });
    const e = env(db, { CLIPS: clips });
    const res = await post('/api/detection', e, good(), { 'X-Avian-Secret': SECRET });
    expect(res.status).toBe(204);
    expect(clips.puts).toEqual(['rare/' + good().file]);
  });

  it('does not archive past the lifetime cap or when already archived', async () => {
    const db = new FakeDB();
    db.on('SELECT COUNT(*) AS n FROM detections WHERE sci = ?', { n: RARE_MAX + 1 });
    const clips = new FakeR2({ ['clips/' + good().file]: 'mp3bytes' });
    await post('/api/detection', env(db, { CLIPS: clips }), good(), { 'X-Avian-Secret': SECRET });
    expect(clips.puts).toEqual([]);

    const db2 = new FakeDB();
    db2.on('SELECT COUNT(*) AS n FROM detections WHERE sci = ?', { n: 1 });
    const clips2 = new FakeR2({
      ['clips/' + good().file]: 'mp3bytes',
      ['rare/' + good().file]: 'already',
    });
    await post('/api/detection', env(db2, { CLIPS: clips2 }), good(), { 'X-Avian-Secret': SECRET });
    expect(clips2.puts).toEqual([]);
  });

  it('never fails the ingest when the archive throws (but logs it)', async () => {
    const db = new FakeDB();
    db.on('SELECT COUNT(*) AS n FROM detections WHERE sci = ?', () => { throw new Error('R2 down'); });
    const res = await post('/api/detection', env(db, { CLIPS: new FakeR2() }), good(), { 'X-Avian-Secret': SECRET });
    expect(res.status).toBe(204);
    expect(console.error).toHaveBeenCalled();
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
