// recomputePlusAll() and scripts/recompute-plus-all.ts: plus_until is re-derived from subscriptions, Trip Passes and
// comp_until for many accounts at once, with a report of what would change. The tests scope every call to their own
// accounts (other test files keep hand-set plus_until values in the same database), and never touch anything else.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const { sql } = await import('./lib/db.js');
const { recomputePlus, recomputePlusAll } = await import('./lib/play.js');

const D = '@plusall.tablamigo';
const DAY = 86400_000;
const days = (n: number) => new Date(Date.now() + n * DAY);
const id: Record<string, string> = {};
// The dates the fixtures use, made once: a test that runs seconds later (a busy machine) must compare with these, not with a fresh days(n).
const WHEN = { sub: days(10), ext: days(9), comp: days(5), pass: days(14) };
const plusUntil = async (who: string) => ((await sql`select plus_until from users where id = ${id[who]}`)[0].plusUntil as Date | null)?.getTime() ?? null;

beforeAll(async () => {
  await sql`delete from users where email like ${'%' + D}`;
  const make = async (name: string, plus: Date | null, comp: Date | null = null) =>
    (id[name] = (await sql`insert into users (email, name, plus_until, comp_until) values (${name + D}, ${name}, ${plus}, ${comp}) returning id`)[0].id);
  await make('handmade', days(30));                    // Plus with nothing behind it: written by hand
  await make('subonly', null);                         // an active subscription whose plus_until was never set
  const okUntil = WHEN.pass;
  await make('ok', okUntil);                           // consistent already
  await make('stale', days(-5));                       // expired long ago, still stored
  await make('ext', days(2));                          // subscription runs longer than plus_until says
  await make('short', days(40), WHEN.comp);            // plus_until beyond everything that backs it
  await make('voided', days(14));                      // its only Trip Pass was refunded
  const sub = (who: string, expires: Date, status = 'SUBSCRIPTION_STATE_ACTIVE') => sql`insert into subscriptions (purchase_token, user_id, platform, product_id, status, expires_at)
    values (${'tok-plusall-' + who}, ${id[who]}, 'google', 'tablamigo_plus', ${status}, ${expires})`;
  await sub('subonly', WHEN.sub);
  await sub('ext', WHEN.ext);
  await sql`insert into passes (purchase_token, user_id, product_id, expires_at) values ('pass-plusall-ok', ${id.ok}, 'tablamigo_trip_pass', ${okUntil})`;
  await sql`insert into passes (purchase_token, user_id, product_id, expires_at, voided_at) values ('pass-plusall-voided', ${id.voided}, 'tablamigo_trip_pass', ${days(14)}, now())`;
});
afterAll(async () => {
  await sql`delete from users where email like ${'%' + D}`;
  await sql.end();
});

describe('recomputePlusAll', () => {
  it('a dry run reports what would change and writes nothing', async () => {
    const before = Object.fromEntries(await Promise.all(Object.keys(id).map(async k => [k, await plusUntil(k)])));
    const r = await recomputePlusAll({ dryRun: true, userIds: Object.values(id) });
    expect(r).toMatchObject({ users: 7, plusBefore: 5, plusAfter: 4, changed: 6, gained: 1, lost: 2, extended: 1, shortened: 1 });
    expect(r.sample.map(x => x.id).sort()).toEqual(['handmade', 'subonly', 'stale', 'ext', 'short', 'voided'].map(k => id[k]).sort());
    const handmade = r.sample.find(x => x.id === id.handmade)!;
    expect(handmade.after).toBeNull();
    expect(handmade.before!.getTime()).toBe(before.handmade);
    for (const k of Object.keys(id)) expect(await plusUntil(k), k).toBe(before[k]);
  });

  it('applying writes the derived value, the same one recomputePlus gives, and a second run finds nothing to do', async () => {
    const r = await recomputePlusAll({ userIds: Object.values(id) });
    expect(r).toMatchObject({ users: 7, plusBefore: 5, plusAfter: 4, changed: 6 });
    expect(await plusUntil('handmade')).toBeNull();                       // nothing backed it
    expect(await plusUntil('voided')).toBeNull();                         // a refunded pass counts for nothing
    expect(await plusUntil('stale')).toBeNull();
    expect(await plusUntil('subonly')).toBe(WHEN.sub.getTime());
    expect(await plusUntil('ext')).toBe(WHEN.ext.getTime());
    expect(await plusUntil('short')).toBe(WHEN.comp.getTime());          // the comp
    expect(await plusUntil('ok')).toBe(WHEN.pass.getTime());
    const after = Object.fromEntries(await Promise.all(Object.keys(id).map(async k => [k, await plusUntil(k)])));
    for (const k of Object.keys(id)) await recomputePlus(id[k]);
    for (const k of Object.keys(id)) expect(await plusUntil(k), `${k} equals recomputePlus`).toBe(after[k]);
    expect(await recomputePlusAll({ dryRun: true, userIds: Object.values(id) })).toMatchObject({ changed: 0, gained: 0, lost: 0, extended: 0, shortened: 0, sample: [] });
  });

  it('only touches the accounts it is given', async () => {
    const later = days(60);
    await sql`update users set plus_until = ${later} where id = ${id.ok}`;
    await sql`update users set plus_until = ${later} where id = ${id.handmade}`;
    const r = await recomputePlusAll({ userIds: [id.handmade] });
    expect(r).toMatchObject({ users: 1, changed: 1, lost: 1 });
    expect(await plusUntil('handmade')).toBeNull();
    expect(await plusUntil('ok')).toBe(later.getTime());   // not in the list: left alone
    // Every account (a report only: other test files hold hand-set Plus in this database).
    const all = await recomputePlusAll({ dryRun: true });
    expect(all.users).toBeGreaterThanOrEqual(7);
  });
});

describe('scripts/recompute-plus-all.ts', () => {
  const run = (...args: string[]) => promisify(execFile)('npx', ['tsx', 'src/scripts/recompute-plus-all.ts', ...args], { env: { ...process.env, NODE_ENV: 'test' } })
    .then(r => ({ code: 0, out: r.stdout }), (e: any) => ({ code: e.code as number, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }));

  it('reports by default, writes only with --apply, and says which database it is on', async () => {
    const sixty = days(60);                  // fixed before the command runs: starting it can take seconds on a busy machine
    await sql`update users set plus_until = ${sixty} where id = ${id.handmade}`;
    const report = await run(`--user=${id.handmade}`);
    expect(report.code).toBe(0);
    expect(report.out).toContain(`database: ${new URL(process.env.DATABASE_URL ?? 'postgres://tablamigo:tablamigo-local@localhost:5434/tablamigo').hostname}`);
    expect(report.out).toContain('report only, nothing is written');
    expect(report.out).toMatch(/with Plus before:\s+1/);
    expect(report.out).toMatch(/with Plus after:\s+0/);
    expect(report.out).toContain('lost 1');
    expect(report.out).toContain(id.handmade);
    expect(await plusUntil('handmade')).toBe(sixty.getTime());

    const applied = await run('--apply', `--user=${id.handmade}`);
    expect(applied.code).toBe(0);
    expect(applied.out).toContain('APPLYING changes');
    expect(await plusUntil('handmade')).toBeNull();
  }, 60_000);

  it('refuses arguments it does not know', async () => {
    const r = await run('--everything');
    expect(r.code).toBe(2);
    expect(r.out).toContain('Unknown or malformed argument: --everything');
    expect((await run('--user=not-a-uuid')).code).toBe(2);
  }, 60_000);
});
