// Unit tests for the pure helpers in src/index.js — the highest-value targets
// first: the timezone math exists because a fixed -4 offset almost shipped
// (it would have skewed every displayed time by 1 h each November), and the
// poll-cache key exists because raw-query-string keys let junk params bypass
// the cache and re-run whole-table GROUP BYs (the 2026-07-03 D1 overload).
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  tzOffsetHours, localDayStart, clampInt, clipKey, parseRange,
  isTransientD1, pollKey, frameSignature, secretMatches,
} from '../src/index.js';

afterEach(() => vi.useRealTimers());

// NOTE: tzOffsetHours caches per wall-clock HOUR (not per zone), so every
// assertion below pins a DISTINCT fake hour — two same-hour calls with
// different zones would serve the first zone's cached offset.
describe('tzOffsetHours', () => {
  it('resolves EDT (-4) in July', () => {
    vi.setSystemTime(new Date('2026-07-15T12:00:00Z'));
    expect(tzOffsetHours({ TZ_NAME: 'America/New_York' })).toBe(-4);
  });

  it('resolves EST (-5) in January', () => {
    vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
    expect(tzOffsetHours({ TZ_NAME: 'America/New_York' })).toBe(-5);
  });

  it('flips at the fall-back boundary (Nov 1 2026, 06:00 UTC)', () => {
    vi.setSystemTime(new Date('2026-11-01T05:30:00Z')); // 1:30 EDT
    expect(tzOffsetHours({ TZ_NAME: 'America/New_York' })).toBe(-4);
    vi.setSystemTime(new Date('2026-11-01T06:30:00Z')); // 1:30 EST
    expect(tzOffsetHours({ TZ_NAME: 'America/New_York' })).toBe(-5);
  });

  it('flips at the spring-forward boundary (Mar 8 2026, 07:00 UTC)', () => {
    vi.setSystemTime(new Date('2026-03-08T06:30:00Z'));
    expect(tzOffsetHours({ TZ_NAME: 'America/New_York' })).toBe(-5);
    vi.setSystemTime(new Date('2026-03-08T07:30:00Z'));
    expect(tzOffsetHours({ TZ_NAME: 'America/New_York' })).toBe(-4);
  });

  it('handles half-hour zones', () => {
    vi.setSystemTime(new Date('2026-05-01T09:00:00Z'));
    expect(tzOffsetHours({ TZ_NAME: 'Asia/Kolkata' })).toBe(5.5);
  });

  it('falls back to TZ_OFFSET_HOURS when TZ_NAME is unset or unresolvable', () => {
    expect(tzOffsetHours({ TZ_OFFSET_HOURS: '-7' })).toBe(-7);
    expect(tzOffsetHours({})).toBe(0);
    vi.setSystemTime(new Date('2026-05-01T10:00:00Z')); // unique hour: dodge the per-hour cache
    expect(tzOffsetHours({ TZ_NAME: 'Not/AZone', TZ_OFFSET_HOURS: '-5' })).toBe(-5);
  });
});

describe('localDayStart', () => {
  it('returns local midnight in UTC seconds (fixed offset)', () => {
    const env = { TZ_OFFSET_HOURS: '-4' };
    const noonEDT = Date.UTC(2026, 6, 10, 16) / 1000; // 2026-07-10 12:00 EDT
    expect(localDayStart(env, noonEDT)).toBe(Date.UTC(2026, 6, 10, 4) / 1000);
  });

  it('rolls to the previous UTC date when local is behind UTC', () => {
    const env = { TZ_OFFSET_HOURS: '-4' };
    // 2026-07-10 01:00 UTC = 2026-07-09 21:00 EDT → local day started 07-09 04:00 UTC
    const lateEvening = Date.UTC(2026, 6, 10, 1) / 1000;
    expect(localDayStart(env, lateEvening)).toBe(Date.UTC(2026, 6, 9, 4) / 1000);
  });

  it('agrees with the Intl path', () => {
    vi.setSystemTime(new Date('2026-07-10T16:00:00Z'));
    const env = { TZ_NAME: 'America/New_York' };
    expect(localDayStart(env, Date.UTC(2026, 6, 10, 16) / 1000)).toBe(Date.UTC(2026, 6, 10, 4) / 1000);
  });
});

describe('clampInt', () => {
  it('clamps, defaults, and rejects garbage', () => {
    expect(clampInt('24', 12, 1, 48)).toBe(24);
    expect(clampInt('9999', 12, 1, 48)).toBe(48);
    expect(clampInt('-3', 12, 1, 48)).toBe(1);
    expect(clampInt(null, 12, 1, 48)).toBe(12);
    expect(clampInt('abc', 12, 1, 48)).toBe(12);
  });
});

describe('clipKey', () => {
  it('accepts one mp3 basename (unicode + colons allowed)', () => {
    expect(clipKey('Mésange-93-2026-07-03-birdnet-08:12:47.mp3'))
      .toBe('Mésange-93-2026-07-03-birdnet-08:12:47.mp3');
    expect(clipKey('x.MP3')).toBe('x.MP3');
  });
  it('blocks traversal, nesting, non-mp3, and oversize', () => {
    expect(clipKey('a/b.mp3')).toBeNull();
    expect(clipKey('a\\b.mp3')).toBeNull();
    expect(clipKey('..secret.mp3')).toBeNull();
    expect(clipKey('x.wav')).toBeNull();
    expect(clipKey('')).toBeNull();
    expect(clipKey('x'.repeat(300) + '.mp3')).toBeNull();
  });
});

describe('parseRange', () => {
  it('parses the single-range forms', () => {
    expect(parseRange('bytes=0-99')).toEqual({ offset: 0, length: 100 });
    expect(parseRange('bytes=100-')).toEqual({ offset: 100 });
    expect(parseRange('bytes=-500')).toEqual({ suffix: 500 });
  });
  it('rejects absent, malformed, and multi-range', () => {
    expect(parseRange(null)).toBeNull();
    expect(parseRange('bytes=-')).toBeNull();
    expect(parseRange('bytes=0-99,200-')).toBeNull();
    expect(parseRange('items=0-99')).toBeNull();
  });
});

describe('isTransientD1', () => {
  it('matches the storage-reset signature, not SQL errors', () => {
    expect(isTransientD1(new Error('D1_ERROR: storage caused object to be reset'))).toBe(true);
    expect(isTransientD1(new Error('D1_ERROR: Durable Object is starting up'))).toBe(true);
    expect(isTransientD1(new Error('SQLITE_ERROR: no such table: detections'))).toBe(false);
    expect(isTransientD1(new Error('D1_ERROR: UNIQUE constraint failed'))).toBe(false);
  });
});

describe('pollKey', () => {
  const u = (s) => new URL('https://w.example' + s);

  it('keeps only the params the action reads, clamped', () => {
    expect(pollKey('recent', u('/api/recent?hours=24&x=abc&evil=1')))
      .toBe('recent?hours=24');
    expect(pollKey('recent', u('/api/recent?hours=99999999')))
      .toBe('recent?hours=1000000');
    expect(pollKey('chorus', u('/api/chorus?hours=12&interval=30&top=24&r=' + Math.random())))
      .toBe('chorus?hours=12&interval=30&top=24');
  });

  it('collapses both URL styles onto one key', () => {
    expect(pollKey('recent', u('/api/recent?hours=24')))
      .toBe(pollKey('recent', u('/api/birdnet-api.php?action=recent&hours=24')));
  });

  it('fills defaults so bare and explicit-default calls share an entry', () => {
    expect(pollKey('rhythm', u('/api/rhythm')))
      .toBe(pollKey('rhythm', u('/api/rhythm?days=14&top=12')));
    expect(pollKey('stats', u('/api/stats?whatever=1'))).toBe('stats?');
  });
});

describe('frameSignature', () => {
  it('is order-independent and bucket-stable', async () => {
    const a = await frameSignature([{ sci: 'A a', n: 3 }, { sci: 'B b', n: 20 }], 24);
    const b = await frameSignature([{ sci: 'B b', n: 20 }, { sci: 'A a', n: 3 }], 24);
    expect(a).toBe(b);
    // 3 and 4 fall in the same count bucket → same picture → same signature.
    const c = await frameSignature([{ sci: 'A a', n: 4 }, { sci: 'B b', n: 20 }], 24);
    expect(c).toBe(a);
  });
  it('moves when the window or the species set changes', async () => {
    const base = await frameSignature([{ sci: 'A a', n: 3 }], 24);
    expect(await frameSignature([{ sci: 'A a', n: 3 }], 12)).not.toBe(base);
    expect(await frameSignature([{ sci: 'A a', n: 300 }], 24)).not.toBe(base);
    expect(await frameSignature([], 24)).not.toBe(base);
  });
});

describe('secretMatches', () => {
  it('matches only the exact secret', async () => {
    expect(await secretMatches('s3cret', 's3cret')).toBe(true);
    expect(await secretMatches('s3cret ', 's3cret')).toBe(false);
    expect(await secretMatches('S3cret', 's3cret')).toBe(false);
    expect(await secretMatches('', 's3cret')).toBe(false);
  });

  it('fails closed when the expected secret is unset', async () => {
    expect(await secretMatches('anything', '')).toBe(false);
    expect(await secretMatches('anything', undefined)).toBe(false);
    expect(await secretMatches('', undefined)).toBe(false);
  });
});
