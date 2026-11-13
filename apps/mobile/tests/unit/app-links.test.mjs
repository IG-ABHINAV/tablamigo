// Own-app links in chat messages (the team's trip matches and nudges), where a tapped push goes, and the new-plan screen opened
// from a template link (src/lib/app-links.ts, src/lib/plan-prefill.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkify, ownRoute, routeForPush, openedReport } from '../../src/lib/app-links.ts';
import { slotsForDay, parseNear } from '../../src/lib/plan-prefill.ts';

const SITE = 'https://tablamigo.hookstep.in';

const links = body => linkify(body).filter(x => x.route || x.url);
const whole = body => linkify(body).map(x => x.text).join('');

test('this site\'s /app/ links open in the app; a trailing full stop stays text; the body comes back whole', () => {
  const body = `See Nitya's profile and say hi: ${SITE}/app/user/f73429fe-da84-4574-9495-f40910bfc264.\nOr ${SITE}/app/activity/new?title=Coffee+meetup&date=2035-03-19 now`;
  assert.deepEqual(links(body).map(x => x.route), ['/user/f73429fe-da84-4574-9495-f40910bfc264', '/activity/new?title=Coffee+meetup&date=2035-03-19']);
  assert.equal(links(body).some(x => x.url), false);
  assert.equal(whole(body), body);
});

test('the real team DM to a Plus member: plan links in the app, the alerts-off link in the browser', () => {
  const body = `Join here: ${SITE}/app/activity/7a848ddc-6a2d-4f74-b25e-c08e4ce67e7e\n\nPlan alerts can be switched off in Profile, or here: https://tablamigo-api.hookstep.in/alerts/off?t=22c4dd4e.plan.XSP1hd_-2J6y`;
  assert.deepEqual(links(body), [
    { text: `${SITE}/app/activity/7a848ddc-6a2d-4f74-b25e-c08e4ce67e7e`, route: '/activity/7a848ddc-6a2d-4f74-b25e-c08e4ce67e7e' },
    { text: 'https://tablamigo-api.hookstep.in/alerts/off?t=22c4dd4e.plan.XSP1hd_-2J6y', url: 'https://tablamigo-api.hookstep.in/alerts/off?t=22c4dd4e.plan.XSP1hd_-2J6y' },
  ]);
  assert.equal(whole(body), body);
});

test('other http(s) links open in the browser, several in one message', () => {
  const body = 'Menu: https://example.com/menu?x=1, map http://maps.example.org/a#b! and (https://en.wikipedia.org/wiki/Ubud_(town)).';
  assert.deepEqual(links(body).map(x => x.url), ['https://example.com/menu?x=1', 'http://maps.example.org/a#b', 'https://en.wikipedia.org/wiki/Ubud_(town)']);
  assert.equal(whole(body), body);
});

test('trailing punctuation and quotes stay outside the link', () => {
  for (const [body, url] of [
    ['go to https://example.com/a.', 'https://example.com/a'],
    ['"https://example.com/a"', 'https://example.com/a'],
    ['(see https://example.com/a)', 'https://example.com/a'],
    ['https://example.com/a?!', 'https://example.com/a'],
    ['https://example.com/a;', 'https://example.com/a'],
    ['link: https://example.com/a…', 'https://example.com/a…'],
  ]) {
    assert.deepEqual(links(body).map(x => x.url), [url], body);
    assert.equal(whole(body), body);
  }
});

test('this site without https://, and its invite links, open in the app; its other pages in the browser', () => {
  assert.deepEqual(links('open tablamigo.hookstep.in/app/trip/t1 now')[0], { text: 'tablamigo.hookstep.in/app/trip/t1', route: '/trip/t1' });
  assert.equal(links(`${SITE}/invite?code=ABC12`)[0].route, '/referral');
  assert.equal(links(`${SITE}/r/ABC12`)[0].route, '/referral');
  assert.equal(links('HTTPS://TABLAMIGO.HOOKSTEP.IN/app/user/u1')[0].route, '/user/u1');
  assert.deepEqual(links(`${SITE}/privacy`)[0], { text: `${SITE}/privacy`, url: `${SITE}/privacy` });
  assert.deepEqual(links('tablamigo.hookstep.in/safety')[0], { text: 'tablamigo.hookstep.in/safety', url: 'https://tablamigo.hookstep.in/safety' });
});

test('look-alike hosts are never in-app links (they open, visibly, as the address they are)', () => {
  for (const body of ['https://evil.example/app/user/1', `${SITE}.evil.com/app/user/1`, 'https://tablamigo.hookstep.in@evil.com/app/user/1', 'https://xtablamigo.hookstep.in/app/user/1']) {
    assert.equal(links(body).some(x => x.route), false, body);
    assert.equal(whole(body), body);
  }
  // A bare look-alike without a scheme is not a link at all.
  for (const body of ['evil.tablamigo.hookstep.in/app/user/1', 'me@tablamigo.hookstep.in/app']) assert.equal(links(body).length, 0, body);
});

test('unsafe schemes are never links', () => {
  for (const body of ['javascript:alert(1)', 'JaVaScRiPt:alert(document.cookie)', 'data:text/html;base64,PHNjcmlwdD4=', 'intent://scan/#Intent;scheme=zxing;end', 'file:///etc/passwd', 'tel:+911234567890', 'vbscript:msgbox', 'tablamigo://user/1']) {
    assert.equal(links(body).length, 0, body);
    assert.equal(whole(body), body);
  }
  // Only the https part of a smuggled address becomes the link, and it opens as https.
  for (const p of linkify('javascript:https://example.com/x')) if (p.url) assert.match(p.url, /^https:\/\//);
});

test('plain text, a bare scheme and an empty message stay text', () => {
  for (const body of ['no links at all', 'https://', 'http:// spaced', '', 'example.com without a scheme', 'meet at 7.30 at Café.Bar']) {
    assert.equal(links(body).length, 0, body);
    assert.equal(whole(body), body);
  }
});

test('ownRoute maps only this host', () => {
  assert.equal(ownRoute(`${SITE}/app/activity/a1?ref=share`), '/activity/a1?ref=share');
  assert.equal(ownRoute(`${SITE}/app`), '/');
  assert.equal(ownRoute('https://other.example/app/activity/a1'), null);
  assert.equal(ownRoute(`${SITE}/application`), null);
  for (const r of ['/paywall', '/activity/new?title=Chai', '/trip/new', '/user/u1', '/chat/c1', '/city/lisbon-pt', '/m/x']) assert.equal(ownRoute(`${SITE}/app${r}`), r, r);
});

test('only shareable screens open in the app; other web app pages and odd paths go to the browser', () => {
  for (const r of ['/verify', '/start', '/pick-city', '/language', '/viewers', '/trip-passes', '/activity/', '/user', '//evil.com', '/user/../verify', '/activity/./x', '/user//evil.com']) {
    assert.equal(ownRoute(`${SITE}/app${r}`), null, r);
    const [p] = links(`${SITE}/app${r}`);
    assert.equal(p.route, undefined, r);
  }
  assert.equal(links('www.tablamigo.hookstep.in/safety')[0].url, 'https://tablamigo.hookstep.in/safety');
});

test('a tapped push opens the person, then the plan, then the chat', () => {
  assert.equal(routeForPush({ userId: 'u', chatId: 'c' }), '/user/u');
  assert.equal(routeForPush({ activityId: 'a', chatId: 'c' }), '/activity/a');
  assert.equal(routeForPush({ chatId: 'c' }), '/chat/c');
  assert.equal(routeForPush({}), null);
  assert.equal(routeForPush(undefined), null);
});

test('the open is reported only when the push names its event', () => {
  assert.deepEqual(openedReport({ nkind: 'trip_match', nref: 'm1', chatId: 'c' }), { kind: 'trip_match', ref: 'm1' });
  assert.equal(openedReport({ chatId: 'c' }), null);
  assert.equal(openedReport({ nkind: null, nref: null }), null);
});

test('a template link\'s date offers that day\'s times, only ahead of now and within 30 days', () => {
  const now = new Date(2035, 2, 14, 12, 0);
  assert.deepEqual(slotsForDay('2035-03-14', new Date(2035, 2, 14, 12, 45)).map(s => s.label), ['Wed 14 Mar 5 PM', 'Wed 14 Mar 7 PM']);
  assert.deepEqual(slotsForDay('2035-03-19', now).map(s => s.label), ['Mon 19 Mar 10 AM', 'Mon 19 Mar 1 PM', 'Mon 19 Mar 5 PM', 'Mon 19 Mar 7 PM']);
  assert.deepEqual(slotsForDay('2035-03-14', now).map(s => s.label), ['Wed 14 Mar 1 PM', 'Wed 14 Mar 5 PM', 'Wed 14 Mar 7 PM']);
  assert.deepEqual(slotsForDay('2035-05-01', now), []);
  assert.deepEqual(slotsForDay('2035-02-30', now), []);
  assert.deepEqual(slotsForDay(undefined, now), []);
});

test('near is a real coordinate pair or nothing', () => {
  assert.deepEqual(parseNear('-8.5069,115.2625'), { lat: -8.5069, lng: 115.2625 });
  assert.equal(parseNear('91,0'), null);
  assert.equal(parseNear('abc'), null);
  assert.equal(parseNear(undefined), null);
});
