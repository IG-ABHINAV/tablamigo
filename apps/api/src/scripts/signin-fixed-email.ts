/**
 * One-time "sign-in on Android is fixed" email to the people the 1.4.2 code screen locked out (lib/emails/signin-fixed.ts says
 * who and why). Report only by default; nothing is sent without --send.
 *
 *   DATABASE_URL=... node dist/scripts/signin-fixed-email.js --only=<file>            # report: who would get it
 *   DATABASE_URL=... RESEND_API_KEY=... node dist/scripts/signin-fixed-email.js --only=<file> --send
 *   ... --from=2026-11-03T18:30:00Z --until=2026-11-11T10:28:00Z   (the default window)
 *
 * --only: a file with one address per line, the Android app sessions (code requests matched to okhttp lines in nginx). It
 * holds contact data, so it lives on the server outside the repo and is deleted after the send. Required with --send.
 * Every send is logged in email_log (kind 'signin_fixed'); that table is the sent-list, so running it again sends nothing new.
 * Prints the database host first, and addresses only masked.
 */
import fs from 'node:fs';
import { config } from '../lib/config.js';
import { sql } from '../lib/db.js';
import { candidates, sendOne, mask, DEFAULT_WINDOW } from '../lib/emails/signin-fixed.js';

const args = process.argv.slice(2);
const flag = (n: string) => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const send = args.includes('--send');
const unknown = args.filter(a => a !== '--send' && a !== '--dry-run' && !/^--(only|from|until)=/.test(a));
if (unknown.length || (send && args.includes('--dry-run'))) { console.error(`Unknown or conflicting argument: ${unknown.join(' ') || '--send with --dry-run'}`); process.exit(2); }
const onlyFile = flag('only');
if (send && !onlyFile) { console.error('--send needs --only=<file> (the Android app addresses).'); process.exit(2); }
const only = onlyFile ? fs.readFileSync(onlyFile, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#')) : null;
const from = flag('from') ? new Date(flag('from')!) : DEFAULT_WINDOW.from, until = flag('until') ? new Date(flag('until')!) : DEFAULT_WINDOW.until;
if (Number.isNaN(from.getTime()) || Number.isNaN(until.getTime()) || from >= until) { console.error('Bad --from/--until.'); process.exit(2); }
if (send && !config.resendKey) { console.error('RESEND_API_KEY is not set: nothing would leave this machine.'); process.exit(2); }

const db = new URL(config.databaseUrl);
console.log(`database: ${db.hostname}:${db.port || 5432}${db.pathname}   (${send ? 'SENDING' : 'report only; pass --send to send'})`);
console.log(`window: ${from.toISOString()} .. ${until.toISOString()}${only ? `   only: ${only.length} addresses from ${onlyFile}` : ''}`);
const list = await candidates({ from, until, only });
console.log(`eligible: ${list.length}`);
for (const c of list) console.log(`  ${mask(c.email)}  first code ${c.firstAt.toISOString()}  codes ${c.codes}`);
if (send) {
  const tally: Record<string, number> = {};
  for (const c of list) {
    const r = await sendOne(c.email);
    tally[r.status] = (tally[r.status] ?? 0) + 1;
    console.log(`  ${r.status.padEnd(9)} ${mask(r.email)}${r.providerId ? `  resend ${r.providerId}` : ''}${r.error ? `  ${r.error}` : ''}`);
  }
  console.log(`done: ${JSON.stringify(tally)}`);
}
await sql.end();
