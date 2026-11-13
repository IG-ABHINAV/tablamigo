// Pure app libs with no test before: dates and distances on plan cards (components/format.ts), the country and language
// pickers, the translations, share and invite links, and the web session (impersonation hand-off, tab sync).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { when, km, range, daysUntil, dayLabel, planDay } from '../../src/components/format.ts';
import { COUNTRIES } from '../../src/lib/countries.ts';
import { LANGUAGES, MAX_LANGUAGES, toggleLanguage } from '../../src/lib/languages.ts';
import { TRANSLATIONS, t } from '../../src/lib/i18n.ts';
import { Platform, Share, Alert } from 'react-native';
import * as share from '../../src/lib/share.ts';

process.env.TZ = 'Asia/Kolkata';

test('distance on a card: never closer than 100 m, metres under 950, one decimal under 10 km', () => {
  assert.equal(km(null), '');
  assert.equal(km(undefined), '');
  assert.equal(km(0), '100 m');
  assert.equal(km(40), '100 m');
  assert.equal(km(449), '400 m');
  assert.equal(km(949), '900 m');
  assert.equal(km(950), '0.9 km');   // 0.95 rounds down in binary floating point; still the same 900 m as km(949)
  assert.equal(km(1_000), '1.0 km');
  assert.equal(km(9_949), '9.9 km');
  assert.equal(km(10_000), '10 km');
  assert.equal(km(152_400), '152 km');
});

test('when a plan starts, as the card says it', () => {
  const now = new Date('2026-10-22T10:00:00+05:30');
  mock.timers.enable({ apis: ['Date'], now });
  try {
    const at = (min) => new Date(now.getTime() + min * 60_000).toISOString();
    assert.equal(when(at(-31)), 'Started');
    assert.equal(when(at(-30)), 'Happening now');
    assert.equal(when(at(15)), 'Happening now');
    assert.equal(when(at(16)), 'In 16 min');
    assert.equal(when(at(59)), 'In 59 min');
    assert.match(when(at(120)), /^Today · /);
    assert.match(when(at(24 * 60)), /^Tomorrow · /);
    assert.match(when(at(3 * 24 * 60)), /^Sun,? (25 Oct|Oct 25) · /);
    assert.equal(planDay(at(-10)), 'Today');
    assert.equal(planDay(at(60)), 'Today');
    assert.equal(planDay(at(24 * 60)), 'Tomorrow');
    assert.match(planDay(at(3 * 24 * 60)), /Sunday/);
    assert.equal(dayLabel(at(0)), 'Today');
    assert.equal(dayLabel(at(-24 * 60)), 'Yesterday');
    assert.equal(daysUntil('2026-10-25'), 3);
    assert.ok(daysUntil('2026-10-22') === 0);   // -0 from Math.ceil, which prints as 0
    assert.match(range('2026-10-25', '2026-11-02'), /^Oct 25 – Nov 2$|^25 Oct – 2 Nov$/);
  } finally { mock.timers.reset(); }
});

test('countries: unique ISO codes, real names, India and the usual markets present', () => {
  const codes = COUNTRIES.map(c => c[0]);
  assert.equal(new Set(codes).size, codes.length);
  for (const [code, name] of COUNTRIES) { assert.match(code, /^[A-Z]{2}$/); assert.ok(name.length > 2, code); }
  for (const c of ['IN', 'US', 'GB', 'TH', 'ID', 'PT', 'AE', 'XK']) assert.ok(codes.includes(c), c);
  for (const gone of ['SU', 'YU', 'DD', 'AQ']) assert.ok(!codes.includes(gone), gone);
  const names = COUNTRIES.map(c => c[1]);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'en')));
});

test('languages: at most 8 on a profile (the API refuses more); toggling removes and adds', () => {
  assert.equal(MAX_LANGUAGES, 8);
  assert.equal(new Set(LANGUAGES).size, LANGUAGES.length);
  let list = [];
  for (const l of LANGUAGES.slice(0, 10)) list = toggleLanguage(list, l);
  assert.equal(list.length, 8);
  assert.deepEqual(toggleLanguage(list, list[0]), list.slice(1));
  assert.deepEqual(toggleLanguage(['English'], 'Hindi'), ['English', 'Hindi']);
});

test('translations: every language has every English key, none empty; unknown falls back to English', () => {
  const en = Object.keys(TRANSLATIONS.en).sort();
  for (const [loc, dict] of Object.entries(TRANSLATIONS)) {
    assert.deepEqual(Object.keys(dict).sort(), en, `${loc} keys`);
    for (const [k, v] of Object.entries(dict)) assert.ok(String(v).trim(), `${loc}.${k} empty`);
  }
  assert.equal(t('save', 'xx'), TRANSLATIONS.en.save);
  assert.equal(t('appTitle', 'hi'), TRANSLATIONS.hi.appTitle);
});

test('share and invite links: the web app links, and invites tagged for Play Console', () => {
  assert.equal(share.planLink('p1'), 'https://tablamigo.hookstep.in/app/activity/p1');
  assert.equal(share.momentLink('m1'), 'https://tablamigo.hookstep.in/app/m/m1');
  const ref = new URLSearchParams(new URL(share.INVITE_PLAY_URL).searchParams.get('referrer'));
  assert.equal(new URL(share.INVITE_PLAY_URL).searchParams.get('id'), 'com.tablamigo.app');
  assert.equal(ref.get('utm_source'), 'invite');
  assert.equal(ref.get('utm_medium'), 'app');
  assert.equal(new URL(share.INVITE_WEB_URL).searchParams.get('utm_source'), 'invite');
  assert.ok(share.INVITE_MESSAGE.includes(share.INVITE_PLAY_URL) && share.INVITE_MESSAGE.includes(share.INVITE_WEB_URL));
});

test('invite on a phone: the share sheet; if it fails, the web link is shown to send by hand', async () => {
  Platform.OS = 'android';
  Share.calls.length = 0; Alert.calls.length = 0;
  assert.equal(await share.shareInvite(), 'shared');
  assert.equal(Share.calls[0].message, share.INVITE_MESSAGE);
  const real = Share.share;
  Share.share = async () => { throw new Error('no activity'); };
  try {
    assert.equal(await share.shareInvite(), 'failed');
    assert.ok(Alert.calls[0][1].includes(share.INVITE_WEB_URL));
  } finally { Share.share = real; }
});

test('invite with a personal link: the link and the days, and the link shown if the share sheet fails', async () => {
  Platform.OS = 'android';
  Share.calls.length = 0; Alert.calls.length = 0;
  const link = 'https://tablamigo.hookstep.in/invite?code=AB12CD34';
  assert.equal(await share.shareInvite({ link, rewardDays: 7 }), 'shared');
  assert.equal(Share.calls[0].message, share.personalInviteMessage(link, 7));
  assert.ok(Share.calls[0].message.includes(link) && Share.calls[0].message.includes('7 days of Tablamigo Plus'));
  assert.equal(await share.shareInvite(null), 'shared');
  assert.equal(Share.calls[1].message, share.INVITE_MESSAGE);
  const real = Share.share;
  Share.share = async () => { throw new Error('no activity'); };
  try {
    assert.equal(await share.shareInvite({ link, rewardDays: 7 }), 'failed');
    assert.ok(Alert.calls.at(-1)[1].includes(link));
  } finally { Share.share = real; }
});

test('share on the web: the browser share sheet, else the clipboard', async () => {
  Platform.OS = 'web';
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const set = nav => Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true });
  try {
    let shared = null;
    set({ share: async d => { shared = d; } });
    assert.equal(await share.shareLink('Join me', 'https://x.test/p'), 'shared');
    assert.deepEqual(shared, { text: 'Join me', url: 'https://x.test/p' });
    let copied = null;
    set({ clipboard: { writeText: async s => { copied = s; } } });
    assert.equal(await share.shareLink('Join me', 'https://x.test/p'), 'copied');
    assert.equal(copied, 'Join me https://x.test/p');
    set({ share: async () => { throw new Error('AbortError'); } });
    assert.equal(await share.shareLink('Join me', 'https://x.test/p'), 'failed');
  } finally { if (saved) Object.defineProperty(globalThis, 'navigator', saved); Platform.OS = 'android'; }
});
