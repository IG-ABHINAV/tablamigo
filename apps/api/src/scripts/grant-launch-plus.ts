/**
 * The launch offer for the accounts that already exist: Plus free until LAUNCH_PLUS_UNTIL. New accounts get it at sign-up (the
 * API does that itself while the variable is set); this gives it to everyone who signed up before.
 *
 * For every account that is not deleted or banned it sets comp_until = greatest(comp_until, the end of the offer), then derives
 * plus_until the usual way for the accounts whose Plus ended before the offer does. Safe to run again (it finds nothing to
 * grant the second time), and it never lowers anything: a later admin comp, a subscription or a Trip Pass that runs past the
 * end is left as it is, and so is an account whose Plus already ends after it.
 *
 * Safe by default: it only reports. Nothing is written without --apply (--dry-run is the same as the default, spelled out).
 *
 *   LAUNCH_PLUS_UNTIL=2026-12-31T18:29:59Z DATABASE_URL=postgres://... npx tsx src/scripts/grant-launch-plus.ts --dry-run
 *   LAUNCH_PLUS_UNTIL=2026-12-31T18:29:59Z DATABASE_URL=postgres://... npx tsx src/scripts/grant-launch-plus.ts --apply
 *   ... --user=<uuid>    only this account (repeat the flag for more)
 *
 * Run from apps/api. It prints the database host it is connected to first, so check that line. It refuses to run when the
 * variable is unset, malformed or already in the past (there would be nothing to grant).
 */
import { config } from '../lib/config.js';
import { sql } from '../lib/db.js';
import { launchOffer } from '../lib/plus.js';
import { grantLaunchPlusAll } from '../lib/play.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const userIds = args.filter(a => a.startsWith('--user=')).map(a => a.slice('--user='.length));
const unknown = args.filter(a => a !== '--apply' && a !== '--dry-run' && !a.startsWith('--user='));
const badIds = userIds.filter(id => !/^[0-9a-f-]{36}$/i.test(id));
if (unknown.length || badIds.length || (apply && args.includes('--dry-run'))) {
  console.error(`Unknown, malformed or conflicting argument: ${[...unknown, ...badIds, ...(apply && args.includes('--dry-run') ? ['--apply with --dry-run'] : [])].join(' ')}\nUsage: grant-launch-plus.ts [--dry-run | --apply] [--user=<uuid> ...]`);
  process.exit(2);
}

const offer = launchOffer();
if (!offer.until) { console.error('LAUNCH_PLUS_UNTIL is not set: there is no launch offer to grant.'); process.exit(2); }
if (!offer.active) { console.error(`The launch offer ended at ${offer.until.toISOString()}: there is nothing to grant.`); process.exit(2); }

const db = new URL(config.databaseUrl);
console.log(`database: ${db.hostname}:${db.port || 5432}${db.pathname}   (${apply ? 'APPLYING changes' : 'report only, nothing is written; pass --apply to write'})`);
console.log(`offer ends: ${offer.until.toISOString()}`);

const r = await grantLaunchPlusAll({ dryRun: !apply, userIds: userIds.length ? userIds : undefined });
console.log(`accounts checked:        ${r.users}${userIds.length ? ` (limited to ${userIds.length} given)` : ''}`);
console.log(`to be granted:           ${r.granted}   (comp_until raised to the end of the offer)`);
console.log(`  had no Plus:           ${r.gained}`);
console.log(`  Plus ending sooner:    ${r.extended}   (extended to the end of the offer)`);
console.log(`Plus already beyond:     ${r.alreadyBeyond}   (a subscription, pass or comp past the end: left as it is)`);
if (!apply && r.granted) console.log('Nothing was written. Re-run with --apply to make these changes.');
if (apply) console.log(r.granted ? 'Done.' : 'Nothing to grant: everyone already has it.');
await sql.end();
