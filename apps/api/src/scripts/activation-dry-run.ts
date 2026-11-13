/**
 * Prints who would get which activation email right now, and why the others don't. Reads only; sends and writes nothing.
 *   npx tsx src/scripts/activation-dry-run.ts [ISO time]                       (local)
 *   node --env-file=.env dist/scripts/activation-dry-run.js [ISO time]         (on the server)
 * Emails are masked (a***@gmail.com) so the output can be pasted.
 */
import { sql } from '../lib/db.js';
import { runActivation, activationCandidates, nextActivation, inSendWindow } from '../lib/emails/activation.js';

const now = process.argv[2] ? new Date(process.argv[2]) : new Date();
const mask = (e: string) => e.replace(/^(.)[^@]*/, '$1***');
const r = await runActivation({}, now, { dryRun: true });
console.log(`now ${now.toISOString()} · send window (10:00-20:00 IST) ${inSendWindow(now) ? 'open' : 'CLOSED: a real run would wait'}`);
const cands = await activationCandidates(now);
console.log(`eligible accounts: ${cands.length} (excludes deleted, banned, not onboarded, under 18, opted out, demo and review accounts, older than 60 days)`);
const by: Record<string, number> = {};
for (const p of r.planned) { by[p.kind] = (by[p.kind] ?? 0) + 1; console.log(`  WOULD SEND ${p.kind.padEnd(20)} ${mask(p.email)}${p.detail ? ' ' + JSON.stringify(p.detail) : ''}`); }
for (const c of cands) if (!r.planned.some(p => p.userId === c.id))
  console.log(`  nothing now          ${mask(c.email)} verified=${c.verified} plan=${c.hasPlan} trip=${c.hasTrip} sent=${c.log.map(l => l.kind).join(',') || '-'}${nextActivation(c, now) ? ' (cut by the run cap)' : ''}`);
console.log('totals:', JSON.stringify(by));
await sql.end();
