import { describe, it, expect } from 'vitest';
import { PLAY_OFFERS, playOfferId, playOfferLabel } from '../../lib/play-offers.js';

describe('Play intro offer labels', () => {
  it('names the three offers in words', () => {
    expect(playOfferLabel('monthly-intro-50')).toBe('monthly-intro-50 (first month 50% off)');
    expect(playOfferLabel('yearly-launch-20')).toBe('yearly-launch-20 (first year 20% off)');
    expect(playOfferLabel('yearly-trial-3d')).toBe('yearly-trial-3d (3-day free trial, then first year 20% off)');
    expect(Object.keys(PLAY_OFFERS)).toHaveLength(3);
  });
  it('an unknown offer as it is, a configured trial as a free trial, no offer as null', () => {
    expect(playOfferLabel('summer-sale')).toBe('summer-sale');
    expect(playOfferLabel('trial-7d', 'trial-7d')).toBe('trial-7d (free trial)');
    expect(playOfferLabel(null)).toBeNull();
    expect(playOfferLabel('')).toBeNull();
  });
  it('reads the offer from a subscriptionsv2 copy, keeping only Play id format', () => {
    expect(playOfferId({ lineItems: [{ offerDetails: { basePlanId: 'monthly', offerId: 'monthly-intro-50' } }] })).toBe('monthly-intro-50');
    expect(playOfferId({ lineItems: [{ offerDetails: { basePlanId: 'monthly' } }] })).toBeNull();
    expect(playOfferId({ lineItems: [{ offerDetails: { offerId: '<script>' } }] })).toBeNull();
    expect(playOfferId({ lineItems: [{ offerDetails: { offerId: 'x'.repeat(64) } }] })).toBeNull();
    expect(playOfferId(null)).toBeNull();
  });
});
