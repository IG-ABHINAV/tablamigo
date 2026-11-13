// The one-time "sign-in on Android is fixed" email (lib/emails/signin-fixed.ts): who gets it, at most once each, and what it
// says. The mail transport is a recorder; nothing is sent.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
const { sql } = await import('./lib/db.js');
const { setMailTransport } = await import('./lib/mail.js');
const { render } = await import('./lib/emails/layout.js');
const S = await import('./lib/emails/signin-fixed.js');

const D = '@signinfixed.tablamigo';
const IN = new Date('2026-11-06T10:00:00Z');
const OUT = new Date('2026-11-12T10:00:00Z');
const W = { from: new Date('2026-11-03T18:30:00Z'), until: new Date('2026-11-11T10:28:00Z') };
const mails: { to: string; subject: string; text: string; idem?: string }[] = [];

const code = (email: string, at = IN, userId: string | null = null) => sql`insert into email_log (kind, user_id, period_key, to_email, subject, status, created_at)
  values ('login_code', ${userId}, ${crypto.randomUUID()}, ${email}, 'Sign-in code', 'sent', ${at})`;
const user = async (email: string, deleted = false) => (await sql`insert into users (email, name, deleted_at)
  values (${email}, 'X', ${deleted ? new Date() : null}) returning id`)[0].id as string;
const clean = async () => {
  await sql`delete from email_log where to_email like ${'%' + D} or to_email like ${'%' + D.toUpperCase()}`;
  await sql`delete from users where email like ${'%' + D}`;
};
const mine = (list: { email: string }[]) => list.map(c => c.email).filter(e => e.endsWith(D)).sort();

beforeAll(async () => {
  await clean();
  setMailTransport(async m => { mails.push({ to: m.to, subject: m.subject, text: m.text, idem: m.idempotencyKey }); return { id: 're_' + mails.length }; });
  await code('locked' + D); await code('locked' + D); await code('LockedTwo' + D.toUpperCase());
  await code('late' + D, OUT);                                   // outside the window
  await code('gotin' + D); await user('gotin' + D);               // has an account now
  const gone = await user('deleted-x@deleted.tablamigo', true);   // deleted: the address was rewritten, the old log row kept its id
  await code('wasdeleted' + D, IN, gone);
  await code('web' + D);                                          // a web app session: not in `only`
});
afterAll(async () => { setMailTransport(null); await clean(); await sql`delete from users where email = 'deleted-x@deleted.tablamigo'`; });
beforeEach(() => { mails.length = 0; });

describe('who gets it', () => {
  it('locked-out app addresses in the window only; never an account, a deleted one, a late one or a web session', async () => {
    const only = ['locked' + D, 'lockedtwo' + D, 'late' + D, 'gotin' + D, 'wasdeleted' + D];
    const list = await S.candidates({ ...W, only });
    expect(mine(list)).toEqual(['locked' + D, 'lockedtwo' + D].sort());
    expect(list.find(c => c.email === 'locked' + D)!.codes).toBe(2);
    expect(mine(await S.candidates(W))).toContain('web' + D);   // without `only` the web one would be there
  });
});

describe('sending', () => {
  it('sends once per address, logs it, and the log is the sent-list', async () => {
    const r = await S.sendOne('Locked' + D);
    expect(r.status).toBe('sent');
    expect(mails.map(m => m.to)).toEqual(['locked' + D]);
    expect(mails[0].idem).toBe(`signin_fixed-${S.keyOf('locked' + D)}`);
    const [row] = await sql`select status, provider_id, user_id, period_key from email_log where kind = 'signin_fixed' and to_email = ${'locked' + D}`;
    expect(row).toMatchObject({ status: 'sent', providerId: 're_1', userId: null, periodKey: S.keyOf('locked' + D) });
    expect((await S.sendOne('locked' + D)).status).toBe('duplicate');
    expect(mails).toHaveLength(1);
    expect(mine(await S.candidates({ ...W, only: ['locked' + D, 'lockedtwo' + D] }))).toEqual(['lockedtwo' + D]);
  });
  it('a failed send is logged and can be retried', async () => {
    setMailTransport(async () => { throw new Error('resend 500'); });
    expect((await S.sendOne('lockedtwo' + D)).status).toBe('failed');
    expect((await sql`select status, error from email_log where kind = 'signin_fixed' and to_email = ${'lockedtwo' + D}`)[0]).toMatchObject({ status: 'failed', error: 'resend 500' });
    setMailTransport(async m => { mails.push({ to: m.to, subject: m.subject, text: m.text }); return { id: 're_x' }; });
    expect(mine(await S.candidates({ ...W, only: ['lockedtwo' + D] }))).toEqual(['lockedtwo' + D]);
    expect((await S.sendOne('lockedtwo' + D)).status).toBe('sent');
  });
});

describe('the email', () => {
  it('apologises, says it is fixed, links to Play to update and opens the app', () => {
    const r = render(S.signinFixedEmail(), { unsubscribeUrl: null });
    expect(r.subject).toBe('Sign-in on Android is fixed');
    expect(r.text).toContain('Sorry about that');
    expect(r.text).toContain(S.PLAY_URL);
    expect(r.text).toContain(S.OPEN_URL);
    expect(r.text).not.toMatch(/\bAI\b|Claude/);
  });
  it('masks addresses for logs', () => { expect(S.mask('Sanjay.K@gmail.com')).toBe('sa…@gmail.com'); });
});
