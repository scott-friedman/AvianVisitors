// ---- Night screens for the e-ink frame -----------------------------------------
// When the frame's window holds no birds (a 1H window after dusk), the panel used
// to show a lone "no birds heard in this window" for ~14 hours. Instead it now
// shows one of four night screens (avian/frontend/night.js draws them):
//
//   recap  "Today in the yard"  — the day's birds + a short recap
//   star   "Bird of the day"    — only when a bird earned it (see starReason)
//   sky    "The yard is asleep" — night sky, real moon, today's birds as silhouettes
//   owl    "Heard tonight"      — only when something called after dark
//
// Pure logic only (no D1, no env) so it is unit-testable; index.js gathers the
// data (nightData) and calls nightPlan / nightSignature here.

export const NIGHT_SCREENS = ['recap', 'star', 'sky', 'owl'];

// Defaults; each is overridable from [vars] in wrangler.toml.
export const NIGHT_DEFAULTS = {
  rotateMin: 60,   // evening: change screens this often (minutes)
  holdHour: 23,    // local hour from which the screen stops changing until the first bird
  duskMin: 40,     // a call this long after sunset counts as "after dark"
};

// Thresholds for "Bird of the day". A bird qualifies only with a real reason;
// on a dull day there is no star and the screen drops out of the rotation.
export const STAR = {
  gapDays: 7,      // back after at least this many days away
  monthMax: 20,    // or heard fewer than this many times in the 30 days before
  confirmConf: 0.9 // a first-ever bird must have one call at least this sure
};

const DAY = 86400;

// Moon at unix time ts: age in days since new, illuminated fraction, waxing?
// Mean synodic month from a known new moon (2000-01-06 18:14 UTC); good to
// well under a day, which is all a 120-px moon on e-ink needs.
export function moonPhase(ts) {
  const SYN = 29.530588853;
  const NEW = 947182440; // 2000-01-06T18:14:00Z
  const age = ((((ts - NEW) / DAY) % SYN) + SYN) % SYN;
  const illum = (1 - Math.cos((2 * Math.PI * age) / SYN)) / 2;
  return { age: Math.round(age * 10) / 10, illum: Math.round(illum * 100) / 100, waxing: age < SYN / 2 };
}

// Why a bird is the bird of the day, or null if it isn't one.
//   s: { sci, n, best, prev (last ts before the day, or null), month (calls in
//        the 30 days before the day, capped at STAR.monthMax) }
//   dayStart: the recap day's local midnight (UTC seconds)
// Returns { rank, kind, text } — lower rank wins.
export function starReason(s, dayStart) {
  if (s.prev == null) {
    // First ever. A single unsure hit is how BirdNET false positives look, so
    // it must be sure (the site's own "confirmed" rule, one-day form).
    if (!(s.best >= STAR.confirmConf)) return null;
    return { rank: 0, kind: 'first', text: 'The first time it has ever been heard here.' };
  }
  const gap = Math.floor((dayStart - s.prev) / DAY);
  if (gap >= STAR.gapDays) {
    const away = gap >= 14 ? `${Math.round(gap / 7)} weeks` : `${gap} days`;
    return { rank: 1 + 1 / gap, kind: 'back', text: `Back after ${away} away.` };
  }
  if (s.month != null && s.month < STAR.monthMax) {
    const t = s.month === 1 ? 'once' : s.month === 2 ? 'twice' : `${s.month} times`;
    return { rank: 3 + s.month / 100, kind: 'rare', text: `One of the yard's rarer visitors: heard only ${t} in the month before.` };
  }
  return null;
}

// Which screen to show. Stateless: the same inputs always give the same screen,
// so the Worker, the Pi's change check and the page all agree.
//
//   now            unix seconds
//   sunset         this evening's sunset (UTC s) for the local day of `now`
//   nightStart     the sunset that began the current night (today's if past it, else yesterday's)
//   holdAt         local 23:00 of the night that began at nightStart (UTC s)
//   quietSince     when the frame's window went empty: last detection + window length
//   birdsToday     any real (non-Mojo) bird since local midnight
//   dayHasBirds    the recap day has any birds at all
//   hasStar        a bird of the day exists (with art)
//   hasCallers     something was heard after dark tonight
export function nightPlan(p, opts = {}) {
  const o = { ...NIGHT_DEFAULTS, ...opts };
  if (!p.dayHasBirds) return { screen: 'sky', phase: 'empty', slot: 0 };
  // Light out and birds have sung today: a midday lull. Keep it simple.
  const dark = p.now >= p.sunset || !p.birdsToday;
  if (!dark) return { screen: 'recap', phase: 'lull', slot: 0 };
  // Late night until the first bird: hold one screen, so the panel is not
  // flashing all night for nobody. This is also what is up in the morning.
  if (p.now >= p.holdAt || !p.birdsToday && p.now < p.sunset) {
    return { screen: p.hasCallers ? 'owl' : 'sky', phase: 'hold', slot: 0 };
  }
  // Evening: rotate. Start counting when the yard went quiet (or at sunset if
  // it went quiet earlier), so the recap always leads.
  const start = Math.max(p.nightStart, p.quietSince || 0);
  const slot = Math.max(0, Math.floor((p.now - start) / (o.rotateMin * 60)));
  const base = ['recap', p.hasStar ? 'star' : null, 'sky'].filter(Boolean);
  // A night caller is the best thing the frame can show: every other slot.
  const order = p.hasCallers ? base.flatMap((s) => [s, 'owl']) : base;
  return { screen: order[slot % order.length], phase: 'evening', slot, order };
}

// What the panel shows, as a short stable string. The frame redraws only when
// this changes: a new screen, a new caller, a different bird of the day...
// Deliberately leaves out anything that drifts by the minute.
export function nightKey(screen, d) {
  const parts = ['night', screen, d.day && d.day.date];
  if (screen === 'recap' || screen === 'sky') {
    parts.push(d.day ? d.day.species.length : 0, d.phase === 'lull' ? 'lull' : 'night');
  }
  if (screen === 'recap') parts.push(d.day ? d.day.calls : 0);
  if (screen === 'sky') parts.push(d.moon ? Math.round(d.moon.age) : '');
  if (screen === 'star') parts.push(d.star && d.star[0] ? d.star[0].sci : '');
  if (screen === 'owl') parts.push((d.callers || []).map((c) => `${c.sci}:${c.n}`).join(','));
  return parts.join('|');
}

// Order the night callers for the "Heard tonight" screen: owls first (they
// are the point), then by how often they called.
const OWLISH = /^(Bubo|Strix|Megascops|Aegolius|Asio|Tyto|Otus|Glaucidium)\s/;
export function rankCallers(callers) {
  return callers.slice().sort((a, b) =>
    (OWLISH.test(b.sci) - OWLISH.test(a.sci)) || (b.n - a.n) || (a.first - b.first));
}
