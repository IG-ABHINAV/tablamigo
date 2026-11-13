// The Play acknowledgement safety net's pure rules (lib/play-ack.ts): backoff, when the owner is emailed, what an error keeps,
// and the PLAY_ACK_* hours parser. No database. The job against a fake Play API is tests/integration/play-ack.test.ts.
import { describe, it, expect } from 'vitest';
import { ackBackoffMs, ackAlertDue, ackErrorText, tokenRef, MAX_BACKOFF_MS } from '../../lib/play-ack.js';
import { boundedHours } from '../../lib/config.js';

const H = 3_600_000;

describe('ackBackoffMs', () => {
  it('waits the grace period after the first failure, doubles after each one, and stops at 6 hours', () => {
    expect([1, 2, 3, 4, 5, 6, 50].map(n => ackBackoffMs(n, 1) / H)).toEqual([1, 2, 4, 6, 6, 6, 6]);
    expect(ackBackoffMs(0, 1)).toBe(H);                        // never shorter than the grace period
    expect(ackBackoffMs(3, 0.5)).toBe(2 * H);
    expect(MAX_BACKOFF_MS).toBe(6 * H);
  });

  it('leaves Google at least 7 tries before the 3-day refund with the default hour', () => {
    let t = 1, tries = 1;                                      // first safety-net try 1 h after purchase
    while (t + ackBackoffMs(tries, 1) / H < 72) { t += ackBackoffMs(tries, 1) / H; tries++; }
    expect(tries).toBeGreaterThanOrEqual(7);
  });
});

describe('ackAlertDue', () => {
  const since = new Date('2026-11-01T00:00:00Z');
  it('is due once the purchase is alertHours old, and only if the owner was not emailed yet', () => {
    expect(ackAlertDue(since, new Date(since.getTime() + 23.9 * H), null, 24)).toBe(false);
    expect(ackAlertDue(since, new Date(since.getTime() + 24 * H), null, 24)).toBe(true);
    expect(ackAlertDue(since, new Date(since.getTime() + 47 * H), null, 24)).toBe(true);
    expect(ackAlertDue(since, new Date(since.getTime() + 30 * H), new Date(since.getTime() + 25 * H), 24)).toBe(false);
  });
});

describe('ackErrorText', () => {
  it('keeps the status and Google message, drops any URL (it holds the purchase token), and is short', () => {
    const token = 'tok-secret-purchase-token-123';
    const e = Object.assign(new Error(`Request failed for https://androidpublisher.googleapis.com/x/tokens/${token}:acknowledge`), { response: { status: 403 } });
    const t = ackErrorText(e);
    expect(t).toMatch(/^403: Request failed for <url>$/);
    expect(t).not.toContain(token);
    expect(ackErrorText({ response: { status: 500, data: { error: { message: 'Backend error' } } } })).toBe('500: Backend error');
    expect(ackErrorText(new Error('x'.repeat(1000))).length).toBe(300);
    expect(ackErrorText('plain')).toBe('plain');
    expect(ackErrorText({ response: { status: 400, data: { error: { message: `Token ${token} is not valid` } } } }, token)).toBe('400: Token <token> is not valid');
  });

  it('tokenRef is a stable short hash, never the token', () => {
    expect(tokenRef('abc')).toBe(tokenRef('abc'));
    expect(tokenRef('abc')).toMatch(/^[0-9a-f]{16}$/);
    expect(tokenRef('abc')).not.toBe(tokenRef('abd'));
  });
});

describe('PLAY_ACK_GRACE_HOURS / PLAY_ACK_ALERT_HOURS', () => {
  it.each([
    [undefined, 1], ['', 1], ['  ', 1], ['abc', 1], ['0', 1], ['-2', 1], ['25', 1], ['Infinity', 1],
    ['2', 2], ['0.5', 0.5], ['24', 24], ['0.0005', 0.0005],
  ])('grace %j -> %j', (raw, want) => expect(boundedHours(raw as string | undefined, 1, 24)).toBe(want));
  it('the alert defaults to 24 h and never goes past 48 h (Google refunds at 72 h)', () => {
    expect(boundedHours(undefined, 24, 48)).toBe(24);
    expect(boundedHours('60', 24, 48)).toBe(24);
    expect(boundedHours('36', 24, 48)).toBe(36);
  });
});
