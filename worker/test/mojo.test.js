// Mojo (the family dog, a fake "species") is SHOWN but never COUNTED: he stays
// on the collage, life list, modal and "first detections", and every count
// leaves him out. Unlike api.test.js's FakeDB, this runs the worker's real SQL
// against a real SQLite (node:sqlite) built from the migrations, so a missed
// or broken filter shows up as a wrong number.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker, { POLL_CACHE } from '../src/index.js';

const MIGRATIONS = new URL('../migrations/', import.meta.url);
const MOJO = 'Canis volaticus';

// The slice of D1's API the worker uses, over node:sqlite.
class SqliteD1 {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) {
      this.db.exec(readFileSync(new URL(f, MIGRATIONS), 'utf8'));
    }
  }
  prepare(sql) {
    const db = this.db;
    const stmt = (args) => ({
      bind: (...a) => stmt(a),
      first: async () => db.prepare(sql).get(...args) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...args) }),
      run: async () => { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: r.changes } }; },
    });
    return stmt([]);
  }
  add(sci, com, ts, conf = 0.9) {
    this.db.prepare('INSERT INTO detections (sci, com, conf, ts) VALUES (?, ?, ?, ?)').run(sci, com, conf, ts);
  }
}

const env = (db) => ({ DB: db, TZ_NAME: 'America/New_York', TZ_OFFSET_HOURS: '-5', SITE_LAT: '42.385', SITE_LON: '-71.417' });
const getJson = async (path, db) => {
  const res = await worker.fetch(new Request('https://w.example' + path), env(db));
  expect(res.status).toBe(200);
  return res.json();
};

const now = Math.floor(Date.now() / 1000);
let db;
beforeEach(() => {
  POLL_CACHE.clear();
  db = new SqliteD1();
  // Real birds: 3 cardinal calls + 2 jay calls in the last half hour, and
  // an older titmouse so the all-time numbers differ from today's.
  for (let i = 1; i <= 3; i++) db.add('Cardinalis cardinalis', 'Northern Cardinal', now - i * 300);
  for (let i = 1; i <= 2; i++) db.add('Cyanocitta cristata', 'Blue Jay', now - 100 - i * 400);
  db.add('Baeolophus bicolor', 'Tufted Titmouse', now - 20 * 86400);
  // Mojo, more often than any real bird, so he would top every ranking.
  for (let i = 1; i <= 5; i++) db.add(MOJO, 'Mojo', now - 30 - i * 200);
});

describe('Mojo is shown, never counted', () => {
  it('stays on the collage and the life list', async () => {
    const recent = await getJson('/api/recent?hours=24', db);
    expect(recent.species.map((s) => s.sci)).toContain(MOJO);
    const life = await getJson('/api/lifelist', db);
    expect(life.species.map((s) => s.sci)).toContain(MOJO);
    const sp = await getJson('/api/species?sci=' + encodeURIComponent(MOJO), db);
    expect(sp.summary.total).toBe(5); // his own modal still shows his visits
  });

  it('is left out of the period totals', async () => {
    const s = await getJson('/api/stats', db);
    expect(s.totals).toEqual({ detections: 6, species: 3 });
    expect(s.last_hour.detections).toBe(5);
    expect(s.week).toEqual({ detections: 5, species: 2 });
  });

  it('is left out of the field notes', async () => {
    const f = await getJson('/api/facts', db);
    const text = f.facts.map((x) => x.text).join('\n');
    expect(text).not.toMatch(/Mojo/);
    expect(text).toMatch(/Most heard today: Northern Cardinal — 3 calls/);
    expect(text).toMatch(/Last hour: 5 calls from 2 species/);
    expect(text).toMatch(/6 calls logged in all/);
  });

  it('is left out of the Day Dial, rhythm, chorus and daily series', async () => {
    const h = await getJson('/api/hourly?hours=24', db);
    expect(h.total).toBe(5);
    expect(h.bins.flatMap((b) => b.top.map((t) => t.sci))).not.toContain(MOJO);

    const r = await getJson('/api/rhythm?days=14', db);
    expect(r.species.map((s) => s.sci)).not.toContain(MOJO);

    const c = await getJson('/api/chorus?hours=12', db);
    expect(c.species.map((s) => s.sci)).not.toContain(MOJO);
    expect(c.totals_by_bin.reduce((a, b) => a + b, 0)).toBe(5);

    const t = await getJson('/api/timeseries?days=30', db);
    expect(t.daily.reduce((a, d) => a + d.detections, 0)).toBe(6); // titmouse is 20 days back
    expect(t.by_hour.reduce((a, d) => a + d.detections, 0)).toBe(6);
  });

  it('is left out of the day songs (/api/day-songs, /api/day)', async () => {
    const one = await getJson('/api/day-songs?days=1', db);
    expect(one.days).toHaveLength(1);               // the poll cache keys on ?days
    const d = await getJson('/api/day-songs?days=2', db);
    expect(d.days).toHaveLength(2);
    expect(d.days.length).toBeGreaterThanOrEqual(1);
    const all = d.days.reduce((a, x) => a + x.calls, 0);
    expect(all).toBe(5);                         // 3 cardinal + 2 jay; no Mojo
    expect(d.days.flatMap((x) => x.lead)).not.toContain(MOJO);
    const today = d.days.find((x) => x.calls > 0);
    const day = await getJson('/api/day?date=' + today.date + '&interval=5', db);
    expect(day.species.map((s) => s.sci)).not.toContain(MOJO);
  });

  it('does not keep the box looking alive: last_detection ignores him', async () => {
    db.db.exec(`DELETE FROM detections WHERE sci <> '${MOJO}'`);
    db.db.prepare('INSERT INTO heartbeat (id, ts) VALUES (1, ?)').run(now);
    const res = await worker.fetch(new Request('https://w.example/api/status'), env(db));
    expect((await res.json()).last_detection).toBeNull();
  });
});
