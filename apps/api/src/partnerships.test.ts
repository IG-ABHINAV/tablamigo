import { describe, it, expect, beforeAll, afterAll } from 'vitest';

process.env.ADMIN_EMAILS = 'partner_admin@partnerships.tablamigo';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { setMailTransport } = await import('./lib/mail.js');
type Mail = { to: string; subject: string; html: string; text: string };
const outbox: Mail[] = [];

let app: Awaited<ReturnType<typeof build>>;

beforeAll(async () => {
  app = await build();
  await sql`delete from partner_leads where email = 'testpartner@hookstep.in'`;
});

afterAll(async () => {
  setMailTransport(null);
  await sql`delete from partner_leads where email in ('testpartner@hookstep.in', 'victim@example.com')`;
  await app.close();
  await sql.end();
});

describe('Partnerships & Sponsored Ads', () => {
  let createdLeadId: string;

  it('submits a new partner lead via POST /partnerships', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/partnerships',
      payload: {
        businessName: 'Sunset Beach Hostel',
        contactName: 'Carlos Nomad',
        email: 'testpartner@hookstep.in',
        businessType: 'hostel_hotel',
        city: 'Goa',
        country: 'India',
        budget: 'pro',
        message: 'We host weekly sunset BBQ meetups and want to sponsor plans for solo travelers.'
      }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.leadId).toBeDefined();
    createdLeadId = body.leadId;

    const [lead] = await sql`select * from partner_leads where id = ${createdLeadId}`;
    expect(lead.businessName).toBe('Sunset Beach Hostel');
    expect(lead.city).toBe('Goa');
    expect(lead.status).toBe('new');
  });

  it('serves active sponsored ads via GET /ads/active', async () => {
    // Insert a temporary test sponsored ad
    const [ad] = await sql`
      insert into sponsored_ads (
        title, subtitle, emoji, target_url, city, category, active
      ) values (
        'Sunset BBQ & Live Beats', 'Free welcome drink for solo travelers', '🍹', 'https://example.com/bbq', 'Goa', 'experience', true
      ) returning id, title
    `;

    const res = await app.inject({
      method: 'GET',
      url: '/ads/active?city=Goa'
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.ads.length).toBeGreaterThan(0);
    expect(body.ads.some((a: any) => a.title === 'Sunset BBQ & Live Beats')).toBe(true);

    // Clean up test ad
    await sql`delete from sponsored_ads where id = ${ad.id}`;
  });

  const lead = (extra: Record<string, unknown> = {}) => ({
    businessName: 'Harbour Hostel', contactName: 'Pat', email: 'victim@example.com', businessType: 'hostel_hotel',
    city: 'Goa', message: 'We would like to sponsor plans.', ...extra,
  });

  it('exploit: whatever a visitor types is escaped in both HTML emails', async () => {
    setMailTransport(async m => { outbox.push(m); return { logged: true }; });
    outbox.length = 0;
    const evil = '<a href="https://phish.example">Verify your account</a><script>x()</script>';
    const res = await app.inject({ method: 'POST', url: '/partnerships', remoteAddress: '10.120.0.1',
      payload: lead({ contactName: evil, businessName: '<img src=x onerror=alert(1)>', city: '<b>Goa</b>', message: evil }) });
    expect(res.statusCode).toBe(200);
    await new Promise(r => setTimeout(r, 50));   // the emails are sent without awaiting
    expect(outbox).toHaveLength(2);
    for (const m of outbox) {
      expect(m.html).not.toContain('<a href');
      expect(m.html).not.toContain('<script>');
      expect(m.html).not.toContain('<img src=x');   // the visitor's tag; the layout's own logo <img> is fine
    }
    // The team's copy shows what was typed, escaped.
    const team = outbox.find(m => m.to !== 'victim@example.com')!;
    expect(team.html).toContain('&lt;a href=&quot;https://phish.example&quot;&gt;');
    // The copy to the typed (unverified) address carries none of the visitor's words, subject included.
    const conf = outbox.find(m => m.to === 'victim@example.com')!;
    for (const part of [conf.subject, conf.html, conf.text]) {
      expect(part).not.toMatch(/phish|Verify your account|onerror|Goa|We would like/);
    }
  });

  it('exploit: every field of the form is escaped in the team\'s HTML, and the subject stays on one line', async () => {
    setMailTransport(async m => { outbox.push(m); return { logged: true }; });
    outbox.length = 0;
    const tag = (n: string) => `<img src=x onerror=alert('${n}')>`;
    const res = await app.inject({ method: 'POST', url: '/partnerships', remoteAddress: '10.120.0.4',
      payload: lead({ businessName: `Harbour\r\nBcc: attacker@example.com\r\n${tag('name')}`, businessType: tag('type'), city: `Goa\nSubject: hijacked`,
        country: tag('country'), budget: tag('budget'), contactName: tag('contact'), message: `${tag('message')} & "quotes"` }) });
    expect(res.statusCode).toBe(200);
    await new Promise(r => setTimeout(r, 50));
    const team = outbox.find(m => m.to !== 'victim@example.com')!;
    expect(team).toBeTruthy();
    // No tag survives into the HTML, whichever field it came in through; the typed words show up escaped.
    expect(team.html).not.toMatch(/<img src=x|<script|onerror=alert\('/);
    for (const field of ['name', 'type', 'country', 'budget', 'contact', 'message']) expect(team.html, field).toContain(`&lt;img src=x onerror=alert(&#39;${field}&#39;)&gt;`);
    expect(team.html).toContain('&amp; &quot;quotes&quot;');
    // The subject is one line: the visitor's line breaks became spaces, so they can't add a header.
    expect(team.subject).not.toMatch(/[\r\n]/);
    expect(team.subject).toBe(`New partner lead: Harbour Bcc: attacker@example.com ${tag('name')} (Goa Subject: hijacked)`);
    await sql`delete from partner_leads where email = 'victim@example.com'`;
  });

  it('exploit: the hidden honeypot field drops bots quietly (no lead stored, no email sent)', async () => {
    outbox.length = 0;
    const before = (await sql`select count(*)::int as n from partner_leads where email = 'victim@example.com'`)[0].n;
    const res = await app.inject({ method: 'POST', url: '/partnerships', remoteAddress: '10.120.0.2', payload: lead({ website: 'http://spam.example' }) });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    await new Promise(r => setTimeout(r, 50));
    expect(outbox).toHaveLength(0);
    expect((await sql`select count(*)::int as n from partner_leads where email = 'victim@example.com'`)[0].n).toBe(before);
  });

  it('exploit: one address can send at most 5 a hour (it emailed any address, 300 a minute)', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await app.inject({ method: 'POST', url: '/partnerships', remoteAddress: '10.120.0.3', payload: lead() })).statusCode);
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes.slice(5)).toEqual([429, 429]);
  });

  it('exploit: a made-up X-Forwarded-For does not dodge the limit (the API trusted every proxy hop)', async () => {
    // What reaches the API from nginx (127.0.0.1): nginx writes the visitor's address (from CF-Connecting-IP) last; the API
    // trusts nothing but loopback, so whatever the client wrote before it can't pick the address the limit keys on.
    const viaCloudflare = (spoofed: string, client: string) => ({ method: 'POST' as const, url: '/partnerships', remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': `${spoofed}, ${client}` }, payload: lead() });
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await app.inject(viaCloudflare(`9.9.9.${i}`, '198.51.100.7'))).statusCode);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429, 429]);
    // Someone else behind the same Cloudflare edge is not affected.
    expect((await app.inject(viaCloudflare('9.9.9.99', '198.51.100.8'))).statusCode).toBe(200);
    // The same when the client's own chain is long: nginx's entry is the address, whatever the client wrote before it.
    const direct: number[] = [];
    for (let i = 0; i < 6; i++) {
      direct.push((await app.inject({ method: 'POST', url: '/partnerships', remoteAddress: '127.0.0.1',
        headers: { 'x-forwarded-for': `104.16.0.${i}, 198.51.100.9` }, payload: lead() })).statusCode);
    }
    expect(direct).toEqual([200, 200, 200, 200, 200, 429]);
  });
});
