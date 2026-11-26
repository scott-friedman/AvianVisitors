// The night screens' pure logic (src/night.js): which screen shows when, who
// is "bird of the day", the moon, and the redraw key the Pi compares.
import { describe, it, expect } from 'vitest';
import { nightPlan, starReason, moonPhase, nightKey, rankCallers, STAR } from '../src/night.js';

const H = 3600;
// An evening: sunset 16:15 local, hold from 23:00, the yard went quiet at 16:30.
const DAY0 = 1764133200; // a local midnight (any fixed value works: the plan is relative)
const base = {
  now: DAY0 + 18 * H, sunset: DAY0 + 16.25 * H, nightStart: DAY0 + 16.25 * H, holdAt: DAY0 + 23 * H,
  quietSince: DAY0 + 16.5 * H, birdsToday: true, dayHasBirds: true, hasStar: true, hasCallers: false,
};

describe('nightPlan', () => {
  it('shows the sky when there is no data at all', () => {
    expect(nightPlan({ ...base, dayHasBirds: false }).screen).toBe('sky');
  });
  it('shows the recap in a daytime lull', () => {
    const p = nightPlan({ ...base, now: DAY0 + 13 * H });
    expect(p).toMatchObject({ screen: 'recap', phase: 'lull' });
  });
  it('rotates recap → star → sky hourly from when the yard went quiet', () => {
    const at = (h) => nightPlan({ ...base, now: DAY0 + h * H }).screen;
    expect([at(16.6), at(17.6), at(18.6), at(19.6)]).toEqual(['recap', 'star', 'sky', 'recap']);
  });
  it('drops the star when no bird earned it', () => {
    expect(nightPlan({ ...base, hasStar: false, now: DAY0 + 17.6 * H }).screen).toBe('sky');
  });
  it('puts a night caller in every other slot', () => {
    const at = (h) => nightPlan({ ...base, hasCallers: true, now: DAY0 + h * H }).screen;
    expect([at(16.6), at(17.6), at(18.6), at(19.6)]).toEqual(['recap', 'owl', 'star', 'owl']);
  });
  it('holds one screen from 23:00 until the first bird', () => {
    expect(nightPlan({ ...base, now: DAY0 + 23.5 * H }).screen).toBe('sky');
    expect(nightPlan({ ...base, hasCallers: true, now: DAY0 + 27 * H })).toMatchObject({ screen: 'owl', phase: 'hold' });
    // Next morning before any bird: still held.
    const morning = { ...base, now: DAY0 + 30 * H, sunset: DAY0 + 40.25 * H, birdsToday: false };
    expect(nightPlan(morning).phase).toBe('hold');
  });
  it('is stateless: same inputs, same screen', () => {
    expect(nightPlan(base)).toEqual(nightPlan({ ...base }));
  });
});

describe('starReason', () => {
  const dayStart = DAY0;
  it('needs a sure call for a first-ever bird', () => {
    expect(starReason({ prev: null, best: 0.95 }, dayStart)).toMatchObject({ kind: 'first', rank: 0 });
    expect(starReason({ prev: null, best: 0.8 }, dayStart)).toBeNull();
  });
  it('names a bird back after a week or more away', () => {
    const r = starReason({ prev: dayStart - 21 * 86400, best: 0.8, month: 50 }, dayStart);
    expect(r.kind).toBe('back');
    expect(r.text).toBe('Back after 3 weeks away.');
    expect(starReason({ prev: dayStart - 8 * 86400, month: 50 }, dayStart).text).toBe('Back after 8 days away.');
  });
  it('names a rare visitor, and not a common one', () => {
    expect(starReason({ prev: dayStart - 86400, month: 2 }, dayStart).text).toMatch(/twice/);
    expect(starReason({ prev: dayStart - 86400, month: STAR.monthMax }, dayStart)).toBeNull();
  });
  it('ranks first-ever over back over rare', () => {
    const first = starReason({ prev: null, best: 0.99 }, dayStart).rank;
    const back = starReason({ prev: dayStart - 30 * 86400, month: 0 }, dayStart).rank;
    const rare = starReason({ prev: dayStart - 86400, month: 1 }, dayStart).rank;
    expect(first).toBeLessThan(back);
    expect(back).toBeLessThan(rare);
  });
});

describe('moonPhase', () => {
  it('is new near a known new moon and full half a month later', () => {
    const newMoon = Date.UTC(2024, 0, 11, 11, 57) / 1000; // 2024-01-11 new moon
    expect(moonPhase(newMoon).illum).toBeLessThan(0.02);
    const full = Date.UTC(2024, 0, 25, 17, 54) / 1000; // 2024-01-25 full moon
    expect(moonPhase(full).illum).toBeGreaterThan(0.97);
    expect(moonPhase(newMoon + 5 * 86400).waxing).toBe(true);
  });
});

describe('nightKey', () => {
  const d = { phase: 'evening', day: { date: '2026-11-25', species: [1, 2, 3], calls: 40 }, moon: { age: 5.2 },
    star: [{ sci: 'Buteo jamaicensis' }], callers: [{ sci: 'Bubo virginianus', n: 3 }] };
  it('changes with the screen and its content, not with the clock', () => {
    expect(nightKey('recap', d)).not.toBe(nightKey('sky', d));
    expect(nightKey('owl', d)).toBe(nightKey('owl', { ...d, as_of: 'later' }));
    expect(nightKey('owl', d)).not.toBe(nightKey('owl', { ...d, callers: [{ sci: 'Bubo virginianus', n: 4 }] }));
    expect(nightKey('star', d)).toContain('Buteo jamaicensis');
  });
});

describe('rankCallers', () => {
  it('puts owls first, then the busiest', () => {
    const out = rankCallers([
      { sci: 'Branta canadensis', n: 9, first: 1 },
      { sci: 'Strix varia', n: 1, first: 5 },
      { sci: 'Bubo virginianus', n: 3, first: 2 },
    ]);
    expect(out.map((c) => c.sci)).toEqual(['Bubo virginianus', 'Strix varia', 'Branta canadensis']);
  });
});
