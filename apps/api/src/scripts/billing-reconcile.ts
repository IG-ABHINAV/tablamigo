/**
 * The hourly billing reconcile (lib/billing-reconcile.ts) by hand: sync open Razorpay subscriptions, replay missed refunds and
 * chargebacks, cancel at Razorpay what must not charge again, and apply Google's voided Play purchases. The scheduler runs the
 * same thing once an hour in the API process; use this to see what it would do, or to run it now after an outage.
 *
 * Safe by default: --dry-run is the default and writes nothing (no database write, no Razorpay or Google write). --apply runs it.
 *
 *   DATABASE_URL=postgres://... npx tsx src/scripts/billing-reconcile.ts            # what it would do
 *   DATABASE_URL=postgres://... npx tsx src/scripts/billing-reconcile.ts --apply    # do it
 *
 * Run from apps/api with the API's environment (Razorpay keys, PLAY_SERVICE_ACCOUNT_JSON). It prints the database host first.
 */
import { config } from '../lib/config.js';
import { sql } from '../lib/db.js';
import { reconcileBilling } from '../lib/billing-reconcile.js';

const args = process.argv.slice(2);
const unknown = args.filter(a => a !== '--apply' && a !== '--dry-run');
if (unknown.length || (args.includes('--apply') && args.includes('--dry-run'))) {
  console.error(`Unknown or conflicting argument: ${unknown.join(' ') || '--apply with --dry-run'}\nUsage: billing-reconcile.ts [--dry-run | --apply]`);
  process.exit(2);
}
const dryRun = !args.includes('--apply');
console.log(`database: ${new URL(config.databaseUrl).host} · ${dryRun ? 'DRY RUN (nothing is written)' : 'APPLY'}`);
const report = await reconcileBilling({ dryRun });
console.log(JSON.stringify(report, null, 2));
await sql.end();
