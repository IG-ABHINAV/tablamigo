// The two switches behind the soft paywall's trial and the live counts (lib/config.ts): typos refuse to start.
import { describe, it, expect } from 'vitest';
import { parseTrialOfferId, parseSocialProof } from '../../lib/config.js';
import { SOCIAL_PROOF } from '../../lib/social-proof.js';

describe('PLAY_YEARLY_TRIAL_OFFER_ID', () => {
  it('unset or empty: no trial', () => {
    expect(parseTrialOfferId(undefined)).toBeNull();
    expect(parseTrialOfferId('  ')).toBeNull();
  });
  it('a Play offer id is kept as written', () => {
    expect(parseTrialOfferId('yearly-trial-3d')).toBe('yearly-trial-3d');
    expect(parseTrialOfferId(' trial3 ')).toBe('trial3');
  });
  it('anything Play would never accept refuses to start', () => {
    for (const bad of ['Yearly-Trial', 'yearly trial', '-yearly', 'yearly_trial', 'x'.repeat(64), 'true']) {
      if (bad === 'true') { expect(parseTrialOfferId(bad)).toBe('true'); continue; } // a valid id shape, even if odd
      expect(() => parseTrialOfferId(bad)).toThrow(/PLAY_YEARLY_TRIAL_OFFER_ID/);
    }
  });
});

describe('SOCIAL_PROOF', () => {
  it('defaults to auto, accepts off, refuses anything else', () => {
    expect(parseSocialProof(undefined)).toBe('auto');
    expect(parseSocialProof('AUTO')).toBe('auto');
    expect(parseSocialProof('off')).toBe('off');
    expect(() => parseSocialProof('on')).toThrow(/SOCIAL_PROOF/);
  });
  it('the thresholds are the owner\'s: 10 upcoming trips per city, 3 cities for the page', () => {
    expect(SOCIAL_PROOF.MIN_TRIPS).toBe(10);
    expect(SOCIAL_PROOF.MIN_CITIES).toBe(3);
  });
  it('the website states the same thresholds (build.py LIVE_MIN_TRIPS, LIVE_MIN_CITIES)', async () => {
    const fs = await import('node:fs');
    const py = fs.readFileSync(new URL('../../../../web/build.py', import.meta.url), 'utf8');
    expect(py).toMatch(new RegExp(`LIVE_MIN_TRIPS, LIVE_MIN_CITIES = ${SOCIAL_PROOF.MIN_TRIPS}, ${SOCIAL_PROOF.MIN_CITIES}`));
  });
});
