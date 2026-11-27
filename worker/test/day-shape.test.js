// The shape of a day (src/day-shape.js), which the play tab draws as a feather
// and the "today's song" button shows off.
import { describe, it, expect } from 'vitest';
import { dayShape, daysFromRows, PARTS } from '../src/day-shape.js';

// A day: dawn chorus 06:00-08:00, a lull, an evening bout; slots are 5 min.
const H = 12; // slots per hour
function sp(sci, n, from, to, every = 1) {
  const slots = [];
  for (let s = from * H; s < to * H; s += every) slots.push([s, n]);
  return { sci, com: sci.toUpperCase(), n: n * slots.length, slots };
}
const busyDay = {
  date: '2026-11-26',
  species: [sp('jay', 4, 6, 8), sp('wren', 2, 6, 9), sp('tit', 3, 15, 17), sp('dove', 1, 7, 16, 3)],
  prev30: { jay: 20, wren: 18, tit: 25, dove: 1 },
};

describe('dayShape', () => {
  it('is empty for a silent day', () => {
    const s = dayShape({ date: 'x', species: [] });
    expect(s).toMatchObject({ calls: 0, kinds: 0, mood: null, rare: null });
    expect(s.levels).toEqual(new Array(PARTS).fill(0));
  });
  it('splits the day into eight parts, busiest at 1, with who led each', () => {
    const s = dayShape(busyDay);
    expect(s.calls).toBe(busyDay.species.reduce((a, b) => a + b.n, 0));
    expect(s.kinds).toBe(4);
    expect(s.levels).toHaveLength(PARTS);
    expect(Math.max(...s.levels)).toBe(1);
    expect(s.lead[0]).toBe('jay');
    expect(s.lead[PARTS - 1]).toBe('tit');
    expect(s.from).toBe(6 * 60);
    expect(s.to).toBe(17 * 60);
  });
  it('finds the midday lull and the morning peak', () => {
    const s = dayShape(busyDay);
    expect(s.lull).toBeGreaterThanOrEqual(2);
    expect(s.levels[s.lull]).toBeLessThan(0.6);
    expect(s.peak).toBe('morning');
    expect(s.patch).toBeGreaterThan(0.1);
  });
  it('names a bird heard on fewer than 3 of the last 30 days as rare, at its hour', () => {
    const s = dayShape(busyDay);
    expect(s.rare).toMatchObject({ sci: 'dove', com: 'DOVE' });
    expect(s.rare.part).toBeGreaterThanOrEqual(0);
    expect(s.names.dove).toBe('DOVE');
  });
  it('has no rare bird when none is rare or the history is unknown', () => {
    expect(dayShape({ ...busyDay, prev30: { jay: 9, wren: 9, tit: 9, dove: 9 } }).rare).toBe(null);
    expect(dayShape({ ...busyDay, prev30: undefined }).rare).toBe(null);
  });
  it('calls a big, varied day bright and a thin one gentle', () => {
    const many = [];
    for (let i = 0; i < 16; i++) many.push(sp('b' + i, 3, 6, 16));
    expect(dayShape({ date: 'x', species: many }).mood).toBe('bright');
    expect(dayShape({ date: 'x', species: [sp('jay', 1, 7, 8)] }).mood).toBe('gentle');
  });
  it('puts an evening-heavy day\'s peak in the evening', () => {
    expect(dayShape({ date: 'x', species: [sp('a', 1, 7, 8), sp('b', 5, 15, 18)] }).peak).toBe('evening');
  });
  it('trims a stray 3 am call off the start of the day', () => {
    const s = dayShape({ date: 'x', species: [{ sci: 'owl', com: 'OWL', n: 1, slots: [[3 * H, 1]] }, sp('jay', 4, 6, 17)] });
    expect(s.from).toBe(6 * 60);
  });
});

describe('daysFromRows', () => {
  it('sorts bucketed rows into their local days and counts the days before each', () => {
    const origin = 0, D = 86400;
    const days = [{ date: 'd31', start: 31 * D, end: 32 * D }, { date: 'd30', start: 30 * D, end: 31 * D }];
    const rows = [
      { b: (31 * D + 7 * 3600) / 300, sci: 'jay', com: 'JAY', n: 2 },
      { b: (31 * D + 8 * 3600) / 300, sci: 'jay', com: 'JAY', n: 1 },
      { b: (30 * D + 7 * 3600) / 300, sci: 'jay', com: 'JAY', n: 5 },
      { b: (5 * D) / 300, sci: 'jay', com: 'JAY', n: 1 },            // history
      { b: (31 * D + 9 * 3600) / 300, sci: 'veery', com: 'VEERY', n: 1 },
    ];
    const [d31, d30] = daysFromRows(rows, days, origin);
    expect(d31.species.map((s) => s.sci)).toEqual(['jay', 'veery']);
    expect(d31.species[0]).toMatchObject({ n: 3, slots: [[84, 2], [96, 1]] });
    expect(d31.prev30).toEqual({ jay: 2, veery: 0 });
    expect(d30.prev30).toEqual({ jay: 1 });
  });
});
