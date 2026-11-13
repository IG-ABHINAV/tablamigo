// Process entry point. Kept separate from server.ts so tests can build() without listening
// (an argv check does not work under PM2, whose wrapper is argv[1]).
// Deployed by the CI/CD deploy job (.github/workflows/ci.yml) after a green push to main; infra/deploy.sh api is the fallback.
import { build } from './server.js';
import { attachRealtime } from './lib/realtime.js';
import { config } from './lib/config.js';
import { runEmailJobs } from './lib/emails/jobs.js';
import { resumePending } from './lib/verification.js';
import { startSchedulerIfEnabled } from './lib/scheduler.js';
import { startAiEngagementWorker } from './lib/ai-engagement.js';
import { ownerAlertsStartupLine, ownerAlertsSettled } from './lib/owner-alerts.js';

const app = await build();
attachRealtime(app.server);
await app.listen({ port: config.port, host: config.isProd ? '127.0.0.1' : '0.0.0.0' });
console.log(`api on :${config.port}`);
// Whether the owner's sale alerts are on (OWNER_SALES_ALERT_EMAIL), once per start.
console.log(ownerAlertsStartupLine());
// PM2 stops the process with SIGINT (reload, restart) and kills it 1.6 s later: give an alert that is mid-send up to 1.2 s to
// finish, then exit. One that doesn't is re-sent by the email jobs (owner-alerts.ts retryFailedOwnerAlerts).
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => { void ownerAlertsSettled(1200).finally(() => process.exit(0)); });
}
// Selfie checks run in-process right after upload; any a restart interrupted are picked up here.
resumePending().then(n => n && console.log(`verification: resumed ${n} pending`)).catch(e => console.error('verification resume failed', e?.message));
// Time-based customer emails (receipts, renewal problems, Plus/Trip Pass endings, join batches, the Monday digest).
// email_log's unique key makes every pass safe to repeat, so a restart never double-sends.
if (config.emailJobs) {
  const emails = () => runEmailJobs().catch(e => console.error('email jobs failed', e?.message));
  setTimeout(emails, 60_000).unref();
  setInterval(emails, 10 * 60_000).unref();
}
// Plan reminders (2 hours and 15 minutes before) and the next session of recurring plans, every minute, and the daily retention
// purge, under a database lock so two API processes never double-send. SCHEDULER=off turns all of it off.
startSchedulerIfEnabled();
// AI engagement engine: interacts with newly posted plans and unanswered chat messages every 15 minutes.
startAiEngagementWorker();

