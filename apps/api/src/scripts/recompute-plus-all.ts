/**
 * Recomputes users.plus_until from each account's subscriptions, Trip Passes and comp_until (the rule recomputePlus() in
 * lib/play.ts applies after every billing event) and prints how many accounts have Plus before and after.
 *
 * Why: plus_until is derived, but until the 3 Oct 2026 audit fixes the Trip Pass wallet redeem, the referral reward and the
 * seed script wrote it by hand. Any of those days that nothing backs is erased by the next billing event for that account
 * anyway, so this makes it happen for everyone at once, before a customer notices it as "my Plus disappeared".
 *
 * IMPORTANT: an account whose Plus exists only as a hand-written plus_until (no subscription, no pass, no comp_until) LOSES
 * it. The report lists them under "lost". Grant such access through comp_until first (admin comp), then run this.
 *
 * Safe by default: it only reports. Nothing is written without --apply.
 *
 *   DATABASE_URL=postgres://... npx tsx src/scripts/recompute-plus-all.ts                    # report for every account
 *   DATABASE_URL=postgres://... npx tsx src/scripts/recompute-plus-all.ts --user=<uuid>      # report for one (repeat --user)
 *   DATABASE_URL=postgres://... npx tsx src/scripts/recompute-plus-all.ts --apply            # write
 *
 * Run from apps/api. It prints the database host it is connected to first, so check that line.
 */
import { config } from '../lib/config.js';
import { sql } from '../lib/db.js';
import { recomputePlusAll } from '../lib/play.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const userIds = args.filter(a => a.startsWith('--user=')).map(a => a.slice('--user='.length));
const unknown = args.filter(a => a !== '--apply' && !a.startsWith('--user='));
if (unknown.length || userIds.some(id => !/^[0-9a-f-]{36}$/i.test(id))) {
  console.error(`Unknown or malformed argument: ${[...unknown, ...userIds.filter(id => !/^[0-9a-f-]{36}$/i.test(id))].join(' ')}\nUsage: recompute-plus-all.ts [--apply] [--user=<uuid> ...]`);
  process.exit(2);
}

const db = new URL(config.databaseUrl);
console.log(`database: ${db.hostname}:${db.port || 5432}${db.pathname}   (${apply ? 'APPLYING changes' : 'report only, nothing is written; pass --apply to write'})`);

const r = await recomputePlusAll({ dryRun: !apply, userIds: userIds.length ? userIds : undefined });
const day = (d: Date | null) => d ? d.toISOString() : 'none';
console.log(`accounts checked:        ${r.users}${userIds.length ? ` (limited to ${userIds.length} given)` : ''}`);
console.log(`with Plus before:        ${r.plusBefore}`);
console.log(`with Plus after:         ${r.plusAfter}`);
console.log(`plus_until changes:      ${r.changed}   (gained ${r.gained}, lost ${r.lost}, extended ${r.extended}, shortened ${r.shortened})`);
for (const x of r.sample) console.log(`  ${x.id}  ${day(x.before)}  ->  ${day(x.after)}`);
if (r.changed > r.sample.length) console.log(`  ... and ${r.changed - r.sample.length} more`);
if (!apply && r.changed) console.log('Nothing was written. Re-run with --apply to make these changes.');
if (apply) console.log(r.changed ? 'Done.' : 'Nothing to change.');
await sql.end();
