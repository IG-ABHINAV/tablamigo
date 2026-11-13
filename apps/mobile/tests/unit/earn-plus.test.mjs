// The paywall's "Want Plus for free?" card (src/lib/paywall-copy.ts EARN_PLUS_LINE): both ways to earn Plus, with the API's numbers
// (lib/plus.ts REFERRAL, lib/host-rewards.ts HOST_REWARD; the API's prices-and-limits test holds EARN_PLUS to them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EARN_PLUS, EARN_PLUS_LINE } from '../../src/lib/paywall-copy.ts';

test('the line names both rewards with their numbers', () => {
  assert.match(EARN_PLUS_LINE, new RegExp(`Invite a friend and you both get ${EARN_PLUS.inviteDays} days`));
  assert.match(EARN_PLUS_LINE, new RegExp(`Host a plan and get ${EARN_PLUS.hostDays} days when ${EARN_PLUS.hostMinGuests} travelers check in at it`));
});

test('both paywalls (Android and web) show it, and no hard-coded copy is left', () => {
  for (const f of ['src/screens/Paywall.tsx', 'src/screens/Paywall.web.tsx']) {
    const src = fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
    assert.ok(src.includes('{EARN_PLUS_LINE}'), f);
    assert.ok(!src.includes('both get 7 days free Tablamigo Plus'), f);
  }
});
