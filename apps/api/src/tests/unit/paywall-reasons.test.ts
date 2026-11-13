// lib/paywall-reasons.ts: the paywall_viewed reason is kept only when it is one of ours, and every reason the app can send is one
// of ours (else the app's new reason would be counted as 'other' in the admin numbers without anyone noticing).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAYWALL_REASONS, paywallReason, withPaywallReason } from '../../lib/paywall-reasons.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const SRC = path.join(ROOT, 'apps/mobile/src');

describe('paywallReason', () => {
  it('keeps every known reason, remove_ads included', () => {
    for (const r of PAYWALL_REASONS) expect(paywallReason(r)).toBe(r);
    expect(paywallReason('remove_ads')).toBe('remove_ads');
  });
  it('no reason is general', () => {
    for (const r of [undefined, null, '']) expect(paywallReason(r)).toBe('general');
  });
  it('anything else is other: unknown words, prototype keys, markup, long strings, other types', () => {
    for (const r of ['nope', 'REMOVE_ADS', ' remove_ads', '__proto__', 'constructor', 'toString', 'hasOwnProperty', '<script>alert(1)</script>',
      'remove_ads'.repeat(5), 'x'.repeat(10_000), 123, true, ['remove_ads'], { reason: 'ads' }]) {
      expect(paywallReason(r), JSON.stringify(r)?.slice(0, 40)).toBe('other');
    }
  });
  it('only touches a paywall_viewed reason that was sent', () => {
    expect(withPaywallReason('paywall_viewed', { reason: 'junk', surface: 'web' })).toEqual({ reason: 'other', surface: 'web' });
    expect(withPaywallReason('paywall_viewed', { surface: 'web' })).toEqual({ surface: 'web' });
    expect(withPaywallReason('paywall_viewed', { reason: null })).toEqual({ reason: 'general' });
    expect(withPaywallReason('plan_joined', { reason: 'junk' })).toEqual({ reason: 'junk' });
  });
});

describe('the app sends only reasons the API keeps', () => {
  const files: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.tsx?$/.test(e.name)) files.push(p); } };
  walk(SRC);
  const all = files.map(f => fs.readFileSync(f, 'utf8')).join('\n');
  const copy = fs.readFileSync(path.join(SRC, 'lib/paywall-copy.ts'), 'utf8');

  it('every /paywall?reason=... link, every paywall sheet reason and every heading key', () => {
    const linked = [...all.matchAll(/paywall\?reason=([a-z_]+)/g)].map(m => m[1]);
    const sheets = [...copy.matchAll(/reason: '([a-z_]+)'/g)].map(m => m[1]);
    const headings = [...copy.match(/export const REASONS[^{]*\{([\s\S]*?)\n\};/)![1].matchAll(/^\s+([a-z_]+):/gm)].map(m => m[1]);
    const limits = [...copy.match(/const LIMIT_REASONS = \[([^\]]*)\]/)![1].matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
    expect(linked).toContain('remove_ads');
    expect(headings).toContain('remove_ads');
    for (const r of [...linked, ...sheets, ...headings, ...limits]) expect(PAYWALL_REASONS, r).toContain(r);
  });
});
