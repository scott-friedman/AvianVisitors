// The shape of one day in the yard, for the play tab's day songs and the
// "today's song" button: the facts its picture (a feather, drawn by
// avian/frontend/day-feather.js) is grown from. Pure, so it is unit-tested.
//
// The day is split the way the play tab's day song (sampler-core's daySong)
// splits it: from the first call to the last, with the 1 % stray tails trimmed
// (so a 3 am owl isn't dawn), into eight equal parts. The lull and the mood use
// daySong's own rules, so the picture and the tune agree on them.
//
// In:  { date, species: [{ sci, com, n, slots: [[slot, n], …] }], prev30: { sci: days } }
//      slots are 5-minute slots from local midnight; prev30 (optional) is how many
//      of the 30 days before had each bird.
// Out: { date, calls, kinds, mood, levels[8] (0..1), lead[8] (sci or null),
//        lull (first of the two quiet parts, or -1), peak ('morning'|'evening'),
//        patch (0..1, how stop-start the day was), rare: { sci, com, part } | null,
//        from, to (minutes after local midnight), names: { sci: com } }
export const PARTS = 8;

export function dayShape(day) {
  const out = { date: day.date, calls: 0, kinds: 0, mood: null, levels: [], lead: [], lull: -1,
    peak: null, patch: 0, rare: null, from: null, to: null, names: {} };
  const sp = (day.species || []).filter((s) => s.slots && s.slots.length);
  for (let i = 0; i < PARTS; i++) { out.levels.push(0); out.lead.push(null); }
  const perSlot = new Map();
  let total = 0;
  for (const s of sp) for (const [slot, n] of s.slots) { perSlot.set(slot, (perSlot.get(slot) || 0) + n); total += n; }
  out.calls = total; out.kinds = sp.length;
  if (!total) return out;

  // The span, without the stray tails (as daySong).
  const slots = [...perSlot.keys()].sort((a, b) => a - b);
  const cut = Math.max(1, Math.floor(total * 0.01));
  let acc = 0, first = slots[0], last = slots[slots.length - 1];
  for (const s of slots) { acc += perSlot.get(s); if (acc >= cut) { first = s; break; } }
  acc = 0;
  for (let i = slots.length - 1; i >= 0; i--) { acc += perSlot.get(slots[i]); if (acc >= cut) { last = slots[i]; break; } }
  const span = last - first + 1;
  out.from = first * 5; out.to = (last + 1) * 5;
  const partOf = (slot) => Math.min(PARTS - 1, Math.max(0, Math.floor((slot - first) * PARTS / span)));

  const parts = [];
  for (let i = 0; i < PARTS; i++) parts.push({ n: 0, by: new Map() });
  for (const s of sp) for (const [slot, n] of s.slots) {
    if (slot < first || slot > last) continue;
    const p = parts[partOf(slot)];
    p.n += n; p.by.set(s.sci, (p.by.get(s.sci) || 0) + n);
  }
  const maxN = Math.max(...parts.map((p) => p.n));
  parts.forEach((p, i) => {
    out.levels[i] = maxN ? Math.round(1000 * Math.log(1 + p.n) / Math.log(1 + maxN)) / 1000 : 0;
    let who = null, most = 0;
    for (const [sci, n] of p.by) if (n > most) { most = n; who = sci; }
    out.lead[i] = who;
  });

  // The lull: the quietest pair of parts among 3–6, if it really dips (daySong's rule).
  const avg = total / PARTS;
  let lull = -1, lullN = Infinity;
  for (let i = 2; i <= 4; i++) { const pn = parts[i].n + parts[i + 1].n; if (pn < lullN) { lullN = pn; lull = i; } }
  out.lull = lullN >= 0.7 * 2 * avg ? -1 : lull;

  // The mood (daySong's formula): busy and varied → bright, else gentle.
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const busy = clamp01(Math.log(1 + total) / Math.log(1 + 1500));
  const variety = clamp01((sp.length - 3) / 17);
  out.mood = busy * 0.6 + variety * 0.4 >= 0.45 ? 'bright' : 'gentle';

  // When it peaked: the middle of the day's calls, in the first half or the second.
  let w = 0;
  parts.forEach((p, i) => { w += p.n * (i + 0.5); });
  out.peak = w / total < PARTS / 2 ? 'morning' : 'evening';

  // How stop-start it was: the spread of the parts' levels.
  const mean = out.levels.reduce((a, b) => a + b, 0) / PARTS;
  out.patch = Math.round(1000 * Math.sqrt(out.levels.reduce((a, v) => a + (v - mean) * (v - mean), 0) / PARTS)) / 1000;

  // A rare visitor: the busiest of the day's birds heard on fewer than 3 of
  // the 30 days before (daySong's test), at the part of the day it called most.
  if (day.prev30) {
    const r = sp.filter((s) => (day.prev30[s.sci] || 0) < 3).sort((a, b) => b.n - a.n)[0];
    if (r) {
      const peakSlot = r.slots.slice().sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
      out.rare = { sci: r.sci, com: r.com, part: partOf(Math.min(Math.max(peakSlot, first), last)) };
    }
  }
  for (const s of sp) if (out.lead.includes(s.sci) || (out.rare && out.rare.sci === s.sci)) out.names[s.sci] = s.com;
  return out;
}

// Turns one query's rows (5-minute buckets counted from `origin`, per bird)
// into dayShape inputs for each local day in `days` ([{ date, start, end }],
// newest first). The rows reach back 30 days before the oldest day, for the
// rare-visitor test.
export function daysFromRows(rows, days, origin) {
  const byDay = days.map((d) => ({ date: d.date, start: d.start, end: d.end, sp: new Map(), seen: new Map() }));
  const present = new Map();   // sci → Set of day-index (counting from origin, by local day bounds)
  for (const r of rows) {
    const ts = origin + r.b * 300;
    for (const d of byDay) {
      if (ts < d.start || ts >= d.end) continue;
      let s = d.sp.get(r.sci);
      if (!s) { s = { sci: r.sci, com: r.com, n: 0, slots: [] }; d.sp.set(r.sci, s); }
      s.n += r.n; s.slots.push([Math.floor((ts - d.start) / 300), r.n]);
      break;
    }
    let set = present.get(r.sci);
    if (!set) { set = new Set(); present.set(r.sci, set); }
    set.add(Math.floor((ts - origin) / 86400));
  }
  return byDay.map((d) => {
    const species = [...d.sp.values()].sort((a, b) => b.n - a.n);
    const prev30 = {};
    const d0 = Math.floor((d.start - origin) / 86400);
    for (const s of species) {
      let c = 0;
      for (const k of present.get(s.sci) || []) if (k >= d0 - 30 && k < d0) c++;
      prev30[s.sci] = c;
    }
    return { date: d.date, species, prev30 };
  });
}
