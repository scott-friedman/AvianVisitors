// A day's song drawn as a feather (avian/frontend/day-feather.js), from the
// day's shape (worker/src/day-shape.js). Run: node --test avian/tests/day-feather.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dayShape } from '../../worker/src/day-shape.js';

const require = createRequire(import.meta.url);
const F = require('../frontend/day-feather.js');
const S = require('../frontend/sampler-core.js');

const H = 12;
function sp(sci, n, from, to, every = 1) {
  const slots = [];
  for (let s = from * H; s < to * H; s += every) slots.push([s, n]);
  return { sci, com: sci, n: n * slots.length, slots };
}
function day(date, species, prev30) { return { date, species, prev30: prev30 || {} }; }
const hue = (sci) => (sci.length % 12) + 1;

test('an empty day is a bare quill', () => {
  const svg = F.draw(dayShape(day('2026-11-01', [])), { hue });
  assert.match(svg, /^<svg class="feather"/);
  assert.doesNotMatch(svg, /class="e"/);
});

test('eight parts of the day, each its own group, in the leader\'s colour', () => {
  const sh = dayShape(day('2026-11-02', [sp('jay', 3, 6, 10), sp('wren', 2, 10, 17)]));
  const svg = F.draw(sh, { hue });
  assert.equal((svg.match(/<g class="e" data-k="\d"/g) || []).length, 8);
  assert.match(svg, new RegExp('var\\(--ch-' + hue('jay') + '\\)'));
  assert.match(svg, new RegExp('var\\(--ch-' + hue('wren') + '\\)'));
});

test('the same day always draws the same; different days differ', () => {
  const a = dayShape(day('2026-11-03', [sp('jay', 3, 6, 10), sp('wren', 2, 10, 17)]));
  const b = dayShape(day('2026-11-04', [sp('jay', 3, 6, 10), sp('wren', 2, 10, 17)]));
  assert.equal(F.draw(a, { hue }), F.draw(a, { hue }));
  assert.notEqual(F.draw(a, { hue }), F.draw(b, { hue }));
});

test('the kind of feather follows the day', () => {
  const many = [];
  for (let i = 0; i < 16; i++) many.push(sp('bird' + i, 3, 6, 16));
  assert.equal(F.kindOf(dayShape(day('d', many))), 'contour');               // lively
  assert.equal(F.kindOf(dayShape(day('d', [sp('jay', 1, 7, 9, 2)]))), 'down'); // very quiet
  assert.equal(F.kindOf(dayShape(day('d', [sp('jay', 1, 6, 17), sp('wren', 1, 6, 12)]))), 'flight');
  assert.equal(F.kindOf(dayShape(day('d', []))), null);
});

test('a rare visitor gets an eye-spot', () => {
  const sh = dayShape(day('2026-11-05', [sp('jay', 3, 6, 16), sp('veery', 1, 9, 10)], { jay: 20, veery: 0 }));
  assert.equal(sh.rare.sci, 'veery');
  assert.match(F.draw(sh, { hue }), /class="fe"/);
  const none = dayShape(day('2026-11-05', [sp('jay', 3, 6, 16)], { jay: 20 }));
  assert.doesNotMatch(F.draw(none, { hue }), /class="fe"/);
});

test('the picture and the tune agree on the mood and the lull', () => {
  // daySong needs a board; give every bird one note so it writes a tune.
  const board = { keys: {} };
  ['jay', 'wren', 'tit', 'dove'].forEach((sci, i) => { board.keys[72 + 2 * i] = [{ sci, rank: 1 }]; });
  const cases = [
    day('a', [sp('jay', 4, 6, 8), sp('wren', 2, 6, 9), sp('tit', 3, 15, 17), sp('dove', 1, 7, 16, 3)]),
    day('b', [sp('jay', 1, 6, 17), sp('wren', 1, 6, 12)]),
    day('c', [sp('jay', 5, 6, 17), sp('wren', 4, 6, 17), sp('tit', 4, 6, 17), sp('dove', 4, 6, 17)]),
  ];
  for (const d of cases) {
    const sh = dayShape(d), song = S.daySong({ date: d.date, species: d.species.map((s) => ({ ...s, prev30: 10 })) }, board);
    assert.equal(sh.mood, song.mood, 'mood of day ' + d.date);
    assert.equal(sh.lull >= 0, song.sections.length > 1, 'lull of day ' + d.date);
  }
});

test('the drawing carries the size class it is asked for', () => {
  const sh = dayShape(day('2026-11-06', [sp('jay', 3, 6, 16)]));
  assert.match(F.draw(sh, { hue, cls: 'big' }), /class="feather big"/);
});
