// One set of numbers, said the same way everywhere: what the API charges and enforces (lib/razorpay.ts, lib/play.ts,
// lib/plus.ts, lib/retention.ts) against what the website (apps/web/build.py, privacy page), the Play listing (store/) and the
// app's paywall copy (apps/mobile/src/lib/paywall-copy.ts) tell people. Before this test they matched only by hand.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RAZORPAY_PRICES } from '../../lib/razorpay.js';
import { PASS_DAYS } from '../../lib/play.js';
import { LIMITS, REFERRAL } from '../../lib/plus.js';
import { RETENTION_DAYS } from '../../lib/retention.js';
import { HOST_REWARD } from '../../lib/host-rewards.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const BUILD = read('apps/web/build.py');
const PAYWALL = read('apps/mobile/src/lib/paywall-copy.ts');
const PRIVACY = read('apps/web/src/privacy.html').replace(/\s+/g, ' ');
const listing = (f: string) => read(`store/${f}`).replace(/\s+/g, ' ');
const pyInt = (name: string) => {
  const m = BUILD.match(new RegExp(`^PLUS_MONTH_INR, PLUS_YEAR_INR, TRIP_PASS_INR = (\\d+), (\\d+), (\\d+)`, 'm'));
  if (!m) throw new Error('build.py price line moved');
  return Number(m[{ PLUS_MONTH_INR: 1, PLUS_YEAR_INR: 2, TRIP_PASS_INR: 3 }[name]!]);
};
const pyString = (name: string) => {
  const m = BUILD.match(new RegExp(`^${name} = \\(([\\s\\S]*?)\\)\\n`, 'm'));
  if (!m) throw new Error(`build.py ${name} moved`);
  return [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(x => x[1]).join('');
};
const F = LIMITS.free, P = LIMITS.plus;

describe('prices: website = Razorpay charges', () => {
  it('Plus monthly and yearly, and the Trip Pass, in rupees', () => {
    expect(RAZORPAY_PRICES.currency).toBe('INR');
    expect(pyInt('PLUS_MONTH_INR') * 100).toBe(RAZORPAY_PRICES.monthly);
    expect(pyInt('PLUS_YEAR_INR') * 100).toBe(RAZORPAY_PRICES.yearly);
    expect(pyInt('TRIP_PASS_INR') * 100).toBe(RAZORPAY_PRICES.pass);
  });

  it('the 6-month plan: ₹2,499 on the web and on Play in India, between half of yearly and 6× monthly (owner rule, 2 Nov 2026)', () => {
    expect(RAZORPAY_PRICES.halfyearly).toBe(249900);
    expect(RAZORPAY_PRICES.halfyearly).toBeLessThan(6 * RAZORPAY_PRICES.monthly);
    expect(RAZORPAY_PRICES.halfyearly).toBeGreaterThan(RAZORPAY_PRICES.yearly / 2);
  });

  it('the Trip Pass is the same number of days everywhere', () => {
    expect(RAZORPAY_PRICES.passDays).toBe(PASS_DAYS);
    expect(BUILD).toContain(`Trip Pass gives ${PASS_DAYS} days of Plus`);
    expect(BUILD).toContain(`"Optional. ${PASS_DAYS} days of Plus, paid once through Razorpay`);
    expect(PAYWALL).toContain(`a Trip Pass: ${PASS_DAYS} days of Plus`);
    expect(PAYWALL).toMatch(new RegExp(`passDays = ${PASS_DAYS}\\b`));
  });

  it('no Google Play price is written in the listing (Play shows it in the buyer currency)', () => {
    for (const f of ['play-listing.md', 'play-listing.en-IN.md', 'play-listing.hi-IN.md']) {
      const body = listing(f).replace(/^[\s\S]*?(?=\n?#+ |Tablamigo)/, '');
      expect(body, f).not.toMatch(/(₹|Rs\.?|INR)\s?\d/);
    }
  });
});

describe('free and Plus limits: API = website = Play listing = app paywall', () => {
  it('website FREE_LIMITS', () => {
    const t = pyString('FREE_LIMITS');
    expect(t).toContain(`posting ${F.activitiesPerDay} plans a day`);
    expect(t).toContain(`${F.dmStartsPerDay} new direct-message conversation a day`);
    expect(t).toContain(`city chats for the next ${F.cityChatDaysAhead} days`);
    expect(t).toContain(`${F.overlapPreview} people overlapping your trips`);
    expect(t).toContain(`${F.aiSuggestionsPerDay} AI plan ideas a day`);
  });

  it('website PLUS_ADDS', () => {
    const t = pyString('PLUS_ADDS');
    expect(t).toContain(`up to ${P.activitiesPerDay} plans a day`);
    expect(t).toContain(`${P.aiSuggestionsPerDay} AI plan ideas a day`);
    expect(t).toContain(`${P.maxPhotos} profile photos`);
    expect(P.cityChatDaysAhead).toBe(365);
    expect(t).toContain('city chats up to a year ahead');
  });

  it.each(['play-listing.md'])('Play listing %s', f => {
    const t = listing(f);
    expect(t).toContain(`post ${F.activitiesPerDay} plans a day`);
    expect(t).toContain(`start ${F.dmStartsPerDay} new direct-message conversation a day`);
    expect(t).toContain(`city chats for the next ${F.cityChatDaysAhead} days`);
    expect(t).toContain(`see ${F.overlapPreview} trip overlaps`);
    expect(t).toContain(`Up to ${P.activitiesPerDay} plans a day`);
    expect(t).toContain(`${P.aiSuggestionsPerDay} AI plan ideas a day`);
    expect(t).toContain(`${P.maxPhotos} profile photos`);
  });

  it('app paywall copy', () => {
    expect(PAYWALL).toContain(`Free accounts start ${F.dmStartsPerDay} new chat a day, ${F.dmMessagesBeforeReply} messages until they reply`);
    expect(PAYWALL).toContain(`Host up to ${P.activitiesPerDay} plans a day`);
    expect(PAYWALL).toContain(`Free accounts get ${F.activitiesPerDay}`);
    expect(PAYWALL).toContain(`${P.aiSuggestionsPerDay} plan ideas a day`);
    expect(PAYWALL).toContain(`Not just a preview of ${F.overlapPreview}`);
  });
});

describe('privacy page = what the code does', () => {
  it('retention periods (lib/retention.ts runs the purge)', () => {
    const d = RETENTION_DAYS;
    const line = PRIVACY.match(/We delete automatically, once a day:[^<]*/)?.[0] ?? '';
    expect(line).toContain(`unused sign-in codes ${d.otpCodes} day after they expire`);
    expect(line).toContain(`sign-in sessions ${d.expiredRefreshTokens} days after they expire`);
    expect(line).toContain(`in-app notifications ${d.notifications} days after they are created`);
    expect(line).toContain(`usage events ${d.analyticsEvents} days after they are recorded`);
    expect(d.expiredChatLocations).toBe(d.expiredPlanShares);
    expect(line).toContain(`live-location shares and expired plan share links ${d.expiredPlanShares} days after they end`);
  });

  it('ways to earn Plus on the paywall = invite and host rewards', () => {
    expect(BUILD).toContain(`host a plan that at least ${HOST_REWARD.minGuests} other travelers check in at (${HOST_REWARD.days} days, at most twice in ${HOST_REWARD.windowDays} days)`);
    expect(HOST_REWARD.maxPerWindow).toBe(2);   // "twice" in the website and privacy wording
    expect(PRIVACY).toContain(`at least ${HOST_REWARD.minGuests} other travelers check in at`);
    expect(PRIVACY).toContain(`(${HOST_REWARD.days} days, at most twice in ${HOST_REWARD.windowDays} days)`);
    expect(PAYWALL).toContain(`export const EARN_PLUS = { inviteDays: ${REFERRAL.rewardDays}, hostDays: ${HOST_REWARD.days}, hostMinGuests: ${HOST_REWARD.minGuests} };`);
  });

  it('invite rewards (lib/plus.ts REFERRAL)', () => {
    expect(PRIVACY).toContain(`invite code in your first ${REFERRAL.redeemWithinDays} days`);
    expect(PRIVACY).toContain(`you get ${REFERRAL.rewardDays} days of Plus`);
    expect(PRIVACY).toContain(`for each of their first ${REFERRAL.maxRewards} invites`);
    // The website's invite page (/invite, apps/web/src/invite.html) prints the same two numbers.
    expect(BUILD).toMatch(new RegExp(`^INVITE_DAYS, INVITE_REDEEM_DAYS = ${REFERRAL.rewardDays}, ${REFERRAL.redeemWithinDays}$`, 'm'));
  });
});
