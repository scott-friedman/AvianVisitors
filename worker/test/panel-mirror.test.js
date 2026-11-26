// The panel mirror: the Pi's upload after a redraw, and the public reads the
// site's "on the frame now" view uses (src/panel-mirror.js).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from '../src/index.js';

// Minimal D1 holding the single panel_mirror row, with the upsert's
// "only move forward" WHERE emulated.
class MirrorDB {
  constructor() { this.row = null; this.writes = 0; }
  prepare(sql) {
    const db = this;
    const stmt = (args) => ({
      bind: (...a) => stmt(a),
      first: async () => (sql.includes('FROM panel_mirror') ? db.row : null),
      all: async () => ({ results: [] }),
      run: async () => {
        if (sql.includes('INSERT INTO panel_mirror')) {
          const [png, sha256, displayed_at, kind, screen] = args;
          if (!db.row || displayed_at > db.row.displayed_at) {
            db.row = { png: new Uint8Array(png), sha256, displayed_at, kind, screen };
            db.writes++;
          }
        }
        return { success: true, meta: { changes: 1 } };
      },
    });
    return stmt([]);
  }
}

function png(w = 800, h = 480, fill = 0) {
  const b = new Uint8Array(64).fill(fill);
  b.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, w); dv.setUint32(20, h);
  return b;
}
async function sha(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

const KEY = 'frame-key';
const call = (path, env, init = {}) => worker.fetch(new Request('https://w.example' + path, init), env);
async function confirm(env, bytes, { when = Date.now() / 1000 - 5, key = KEY, kind, screen, hash } = {}) {
  return call('/api/frame-confirmed', env, {
    method: 'POST', body: bytes,
    headers: {
      'Content-Type': 'image/png', 'X-Frame-Key': key, 'X-Displayed-At': String(when),
      'X-Image-SHA256': hash || (await sha(bytes)),
      ...(kind ? { 'X-Frame-Kind': kind } : {}), ...(screen ? { 'X-Frame-Screen': screen } : {}),
    },
  });
}

let db, env;
beforeEach(() => {
  db = new MirrorDB();
  env = { DB: db, FRAME_KEY: KEY, TZ_OFFSET_HOURS: '-4' };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('panel mirror', () => {
  it('says so when the frame has never reported (no fallback to a render)', async () => {
    const info = await (await call('/api/frame-mirror', env)).json();
    expect(info.ok).toBe(false);
    expect((await call('/api/frame-mirror.png', env)).status).toBe(404);
  });

  it('stores a confirmed picture and serves it back with its screen', async () => {
    const img = png();
    const r = await confirm(env, img, { kind: 'night', screen: 'sky' });
    expect(r.status).toBe(204);
    const info = await (await call('/api/frame-mirror', env)).json();
    expect(info).toMatchObject({ ok: true, kind: 'night', screen: 'sky', sha256: await sha(img) });
    const res = await call('/api/frame-mirror.png?v=' + info.sha256, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Cache-Control')).toContain('immutable');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(img);
    const again = await call('/api/frame-mirror.png', env, { headers: { 'If-None-Match': `"${info.sha256}"` } });
    expect(again.status).toBe(304);
  });

  it('accepts a portrait (480x800) picture', async () => {
    expect((await confirm(env, png(480, 800))).status).toBe(204);
  });

  it('rejects a wrong key, a wrong hash, a wrong size and a non-PNG', async () => {
    expect((await confirm(env, png(), { key: 'nope' })).status).toBe(401);
    expect((await confirm({ ...env, FRAME_KEY: '' }, png(), { key: '' })).status).toBe(401);
    expect((await confirm(env, png(), { hash: 'a'.repeat(64) })).status).toBe(400);
    expect((await confirm(env, png(640, 400))).status).toBe(400);
    const junk = new Uint8Array(64).fill(7);
    expect((await confirm(env, junk)).status).toBe(400);
    expect(db.writes).toBe(0);
  });

  it('never lets an older upload replace a newer picture', async () => {
    const now = Date.now() / 1000;
    await confirm(env, png(800, 480, 1), { when: now - 10 });
    await confirm(env, png(800, 480, 2), { when: now - 100 });
    expect(db.row.displayed_at).toBe(now - 10);
    expect(db.writes).toBe(1);
  });

  it('drops unknown kind/screen labels instead of storing them', async () => {
    await confirm(env, png(), { kind: 'collage', screen: 'sky' });
    expect(db.row).toMatchObject({ kind: 'collage', screen: null });
    await confirm(env, png(800, 480, 3), { when: Date.now() / 1000, kind: 'night', screen: '<script>' });
    expect(db.row).toMatchObject({ kind: 'night', screen: null });
  });
});
