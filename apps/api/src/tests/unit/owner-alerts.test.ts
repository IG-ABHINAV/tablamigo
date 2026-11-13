// The owner's sale alert as an email (lib/owner-alerts.ts renderOwnerAlert) and the OWNER_SALES_ALERT_EMAIL parser: pure
// functions, no database. The sending, deduplication and the webhook paths are tests/integration/owner-sale-alerts.test.ts.
import { describe, it, expect } from 'vitest';
import { parseEmailList } from '../../lib/config.js';
import { renderOwnerAlert, razorpayProduct, playMoney, playProduct, ownerAlertsStartupLine, partnerLeadEmail, partnerConfirmationEmail, renderOwnerNotice, SALE_LABEL, type Customer, type SaleEvent, type SaleKind } from '../../lib/owner-alerts.js';
import { config } from '../../lib/config.js';

const UID = '3f2a8c1e-0b7d-4e55-9a10-2c4d6e8f0a1b';
const priya: Customer = {
  name: 'Priya S', email: 'priya@x.com', internal: null, homeCountry: 'IN', city: 'Mumbai', signedUp: new Date('2026-10-12T06:00:00Z'),
  deleted: false, source: 'Google Search', medium: 'organic', campaign: null, signupCountry: 'IN', device: 'Android',
};
const renewal: SaleEvent = {
  kind: 'renewal', provider: 'razorpay', userId: UID, product: 'Plus monthly', amountMinor: 49900, currency: 'INR',
  ids: { paymentId: 'pay_Q1w2E3r4T5y6U7', subscriptionId: 'sub_Q1w2E3r4T5y6U7' }, test: null, at: new Date('2026-10-25T08:35:00Z'),
  details: [['Charge number', '2']],
};

describe('OWNER_SALES_ALERT_EMAIL', () => {
  it('takes a comma-separated list, lower-cases and de-duplicates it, and counts what it drops', () => {
    expect(parseEmailList('owner@example.com')).toEqual({ valid: ['owner@example.com'], invalid: 0 });
    expect(parseEmailList(' A@B.co , a@b.co,second@x.in ')).toEqual({ valid: ['a@b.co', 'second@x.in'], invalid: 0 });
    expect(parseEmailList(undefined)).toEqual({ valid: [], invalid: 0 });
    expect(parseEmailList(' , ')).toEqual({ valid: [], invalid: 0 });
  });

  it.each([
    ['no @', 'owner.example.com'],
    ['a display name', 'Owner <o@example.com>'],
    ['a header injection', 'j@gmail.com\r\nBcc: attacker@evil.com'],
    ['a space inside', 'j @gmail.com'],
    ['no domain dot', 'j@localhost'],
    ['two @', 'j@x@gmail.com'],
    ['too long', 'a'.repeat(250) + '@gmail.com'],
  ])('drops %s', (_what, raw) => {
    expect(parseEmailList(`${raw},ok@gmail.com`)).toEqual({ valid: ['ok@gmail.com'], invalid: 1 });
  });

  it('logs one startup line: on with the recipient count, off when unset, and how many were ignored', () => {
    const saved = config.ownerSalesAlerts;
    try {
      config.ownerSalesAlerts = { valid: ['a@b.co'], invalid: 0 };
      expect(ownerAlertsStartupLine()).toBe('owner sale alerts: on, 1 recipient');
      config.ownerSalesAlerts = { valid: [], invalid: 0 };
      expect(ownerAlertsStartupLine()).toBe('owner sale alerts: off (OWNER_SALES_ALERT_EMAIL unset)');
      config.ownerSalesAlerts = { valid: ['a@b.co', 'c@d.co'], invalid: 2 };
      expect(ownerAlertsStartupLine()).toBe('owner sale alerts: on, 2 recipients; 2 invalid addresses in OWNER_SALES_ALERT_EMAIL ignored');
    } finally { config.ownerSalesAlerts = saved; }
  });
});

describe('the alert email', () => {
  it('subject: headline and customer, no [TEST] or [Tablamigo] brackets', () => {
    const m = renderOwnerAlert(renewal, priya, 'rzp:pay:pay_Q1w2E3r4T5y6U7');
    expect(m.subject).toBe('Renewal: Plus monthly, ₹499 — Priya S (priya@x.com)');
    expect(m.subject).not.toMatch(/\[/);
    expect(m.test).toBe(false);
  });

  it('branded layout: logo, headline, one-line summary, admin button, fact tables, owner footer', () => {
    const { html, text } = renderOwnerAlert(renewal, priya, 'rzp:pay:pay_Q1w2E3r4T5y6U7');
    expect(html).toContain('icon-192.png');
    expect(html).toContain('>Renewal: Plus monthly, ₹499</h1>');
    expect(html).toContain("Priya S's Plus monthly renewed for ₹499.");
    expect(html).toContain(`href="${config.siteUrl}/admin#users?q=${UID}" class="btn"`);
    expect(html).toContain('Open customer in admin');
    expect(html).not.toContain('This is a service email about your Tablamigo account');   // not the customer footer
    expect(text).toContain('Sent only to the owner (OWNER_SALES_ALERT_EMAIL)');
    expect(html).not.toContain('Test mode');
  });

  it('plain-text part: amount and currency, Live, customer, user id, sign-up source and country, provider ids, admin link', () => {
    const { text } = renderOwnerAlert(renewal, priya, 'rzp:pay:pay_Q1w2E3r4T5y6U7');
    for (const s of ['Renewal: Plus monthly, ₹499', 'Event: Renewal', 'Product: Plus monthly', 'Amount: ₹499 INR', 'When: 25 Oct 2026, 14:05 IST', 'Mode: Live', 'Charge number: 2',
      'Name: Priya S', 'Email: priya@x.com', `User id: ${UID}`, 'Signed up: 12 Oct 2026 · source Google Search / organic · country IN · device Android',
      'Profile: home IN · Mumbai', `Open customer in admin: ${config.siteUrl}/admin#users?q=${UID}`,
      'Razorpay payment id: pay_Q1w2E3r4T5y6U7', 'Razorpay subscription id: sub_Q1w2E3r4T5y6U7',
      'Dashboard: https://dashboard.razorpay.com/app/payments/pay_Q1w2E3r4T5y6U7', 'Alert key: rzp:pay:pay_Q1w2E3r4T5y6U7']) {
      expect(text).toContain(s);
    }
    expect(text).not.toMatch(/\[Test mode/);
  });

  it('test mode only for a provider test, as a small badge in the body, never in the subject', () => {
    const t = renderOwnerAlert({ ...renewal, test: 'Razorpay test key' }, priya, 'rzp:pay:x1');
    expect(t.subject).toBe('Renewal: Plus monthly, ₹499 — Priya S (priya@x.com)');
    expect(t.test).toBe(true);
    expect(t.html).toContain('Test mode · Razorpay test key');
    expect(t.text).toContain('[Test mode · Razorpay test key]');
    expect(t.text).toContain('Mode: Test mode (Razorpay test key)');
    const play = renderOwnerAlert({ ...renewal, provider: 'google_play', test: 'Google Play test purchase (license tester)' }, priya, 'play:order:x');
    expect(play.test).toBe(true);
    expect(play.html).toContain('Test mode · Google Play test purchase');
  });

  it('an internal account paying on a live key is live money: "Internal account" badge, Mode Live, never test', () => {
    const i = renderOwnerAlert(renewal, { ...priya, internal: 'internal account (ADMIN_EMAILS)' }, 'rzp:pay:x2');
    expect(i.test).toBe(false);
    expect(i.subject).toBe('Renewal: Plus monthly, ₹499 — Priya S (priya@x.com)');
    expect(i.html).not.toContain('Test mode');
    expect(i.html).toContain('Internal account · live money');
    expect(i.text).toContain('Mode: Live (internal account (ADMIN_EMAILS))');
    // A provider test on an internal account is still test (the badge says why).
    const both = renderOwnerAlert({ ...renewal, test: 'Razorpay test key' }, { ...priya, internal: 'admin account' }, 'rzp:pay:x6');
    expect(both.test).toBe(true);
    expect(both.html).toContain('Test mode · Razorpay test key');
    expect(both.html).not.toContain('Internal account · live money');
  });

  it('a name with line breaks, HTML or markdown cannot add headers, markup or links', () => {
    const evil = { ...priya, name: 'Eve\r\nBcc: attacker@evil.com <script>alert(1)</script> [win](https://evil.example) **x**' };
    const m = renderOwnerAlert(renewal, evil, 'rzp:pay:x3');
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.subject).toContain('Eve Bcc: attacker@evil.com');
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;');
    expect(m.html).not.toContain('href="https://evil.example');
    expect(m.text.split('\n').some(l => /^Bcc:/i.test(l.trim()))).toBe(false);
  });

  it('links only the admin button and the dashboard URL the alert builds; a name, city or detail that looks like a URL stays text', () => {
    const phishing = 'https://evil.example/login';
    const m = renderOwnerAlert({ ...renewal, details: [['Event', phishing]] }, { ...priya, name: phishing, city: phishing }, 'rzp:pay:x5');
    expect(m.html).not.toContain(`href="${phishing}"`);
    expect(m.html).toContain(phishing);
    expect(m.html.match(/<a href=/g)).toHaveLength(2);
  });

  it('only whitelisted provider ids, and never a purchase token, card, UPI, phone or signature', () => {
    // The shape of a Play purchase token (100+ characters), made up here: a literal would look like a leaked secret to scanners.
    const token = `fake-play-token.AO-J1Oz${'x'.repeat(120)}`;
    const ev: SaleEvent = {
      ...renewal, provider: 'google_play',
      ids: { playOrderId: token, paymentId: 'pay_OK123', ...({ card: '4111111111111111', vpa: 'priya@okaxis', contact: '+919876543210', signature: 'deadbeef'.repeat(8) } as any) },
    };
    const { text, html } = renderOwnerAlert(ev, priya, 'play:order:GPA.1234-5678-9012-34567');
    for (const leaked of [token, '4111111111111111', 'okaxis', '+919876543210', 'deadbeefdeadbeef']) {
      expect(text).not.toContain(leaked);
      expect(html).not.toContain(leaked);
    }
    expect(text).toContain('Razorpay payment id: pay_OK123');
    expect(text).not.toContain('Google Play order id');
  });

  it('no customer row: says so instead of guessing; no amount: says the provider did not report it', () => {
    const m = renderOwnerAlert({ ...renewal, amountMinor: null, currency: null }, null, 'rzp:pay:x4');
    expect(m.subject).toBe('Renewal: Plus monthly — unknown customer');
    expect(m.text).toContain(`Customer: user ${UID} (no such account now)`);
    expect(m.text).toContain('Amount: not reported by the provider');
    expect(m.text).toContain('A customer\'s Plus monthly renewed.');
  });

  it('other currencies and plan-price notes', () => {
    const m = renderOwnerAlert({ ...renewal, provider: 'google_play', amountMinor: 799, currency: 'USD', amountNote: "order total, before Google's fee", ids: { playOrderId: 'GPA.1234-5678-9012-34567..0' } }, priya, 'play:order:GPA.1234-5678-9012-34567..0');
    expect(m.subject).toBe('Renewal: Plus monthly, USD 7.99 — Priya S (priya@x.com)');
    expect(m.text).toContain("Amount: USD 7.99 (order total, before Google's fee)");
    expect(m.text).toContain('Google Play order id: GPA.1234-5678-9012-34567..0');
    expect(m.text).not.toContain('Dashboard:');
  });

  it.each(Object.keys(SALE_LABEL) as SaleKind[])('renders %s (snapshot of the plain-text part and the HTML headline)', kind => {
    const m = renderOwnerAlert({ ...renewal, kind }, priya, `rzp:pay:snap_${kind}`);
    expect(m.subject.startsWith(`${SALE_LABEL[kind]}: Plus monthly, ₹499 — `)).toBe(true);
    expect(m.html).toContain(`>${SALE_LABEL[kind]}: Plus monthly, ₹499</h1>`);
    expect(m.text).toMatchSnapshot();
  });
});

describe('renderOwnerNotice (the one owner template, also used by the Play acknowledgement alert)', () => {
  const base = { subject: 'Google Play purchase now acknowledged', eyebrow: 'Owner alert · Google Play', headline: 'Acknowledged now: Plus subscription (tablamigo_plus)',
    summary: 'Nothing to do.', sections: [[null, [{ k: 'Customer', v: 'Bo (bo@x.co)' }, { k: 'Empty', v: null }]]] as any, footer: ['Owner only.'] };
  it('live: no badge; empty rows left out; parentheses kept in the headline', () => {
    const r = renderOwnerNotice(base);
    expect(r.html).not.toContain('Test mode');
    expect(r.html).toContain('>Acknowledged now: Plus subscription (tablamigo_plus)</h1>');
    expect(r.text).not.toContain('Empty');
    expect(r.text).toMatchSnapshot();
  });
  it('test mode badge only with a provider test reason', () => {
    expect(renderOwnerNotice({ ...base, testReason: 'Google Play test purchase (license tester)' }).html).toContain('Test mode · Google Play test purchase (license tester)');
    expect(renderOwnerNotice({ ...base, internal: 'admin account' }).html).not.toContain('Test mode');
  });
});

describe('partnership emails', () => {
  const form = { businessName: 'Chai <b>Point</b>', contactName: 'Asha [x](https://evil.example)', email: 'a@b.co', businessType: 'Cafe', city: 'Goa', message: 'Line one\n\nLine **two**' };
  it('the team alert uses the branded layout and escapes every visitor value', () => {
    const e = partnerLeadEmail(form, { id: 'lead-1', at: new Date('2026-10-25T08:35:00Z') });
    expect(e.subject).toBe('New partner lead: Chai <b>Point</b> (Goa)');
    expect(e.html).toContain('icon-192.png');
    expect(e.html).not.toContain('<b>Point</b>');
    expect(e.html).not.toContain('href="https://evil.example');
    expect(e.html).not.toContain('<strong');
    expect(e.text).toMatchSnapshot();
  });
  it('the confirmation carries none of the visitor\'s words', () => {
    const e = partnerConfirmationEmail();
    expect(e.html).toContain('icon-192.png');
    expect(e.text).toMatchSnapshot();
  });
});

describe('product and money helpers', () => {
  it('names Razorpay products the way the owner reads them', () => {
    expect(razorpayProduct('tablamigo_plus_monthly')).toBe('Plus monthly');
    expect(razorpayProduct('tablamigo_plus_yearly')).toBe('Plus yearly');
    expect(razorpayProduct('tablamigo_trip_pass')).toBe('Trip Pass (14 days)');
    expect(razorpayProduct('activity_ticket')).toBe('Event ticket');
    expect(razorpayProduct(undefined)).toBe('Plus');
    expect(playProduct('tablamigo_plus', 'weekly')).toBe('Plus weekly');
    expect(playProduct('tablamigo_trip_pass')).toBe('Trip Pass (14 days)');
  });

  it("reads Google's Money", () => {
    expect(playMoney({ currencyCode: 'INR', units: '499' })).toEqual({ amountMinor: 49900, currency: 'INR' });
    expect(playMoney({ currencyCode: 'USD', units: '7', nanos: 990000000 })).toEqual({ amountMinor: 799, currency: 'USD' });
    expect(playMoney({ units: '7' })).toBeNull();
    expect(playMoney(null)).toBeNull();
  });
});
