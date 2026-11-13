/**
 * The refuse-unless-a-throwaway-test-database rule for every suite that touches Postgres (vitest integration + e2e projects,
 * src/scripts/e2e-scenarios.ts). Test-only: nothing in src/main.ts or the routes imports it.
 *
 * Accepted: DATABASE_URL set explicitly in the environment, a loopback host (localhost, 127.0.0.1, ::1) or a host listed in
 * TEST_DB_HOSTS (CI service containers), and a database name containing "test" (tablamigo_test, tablamigo_e2e_test).
 * Refused: everything else, NODE_ENV=production, and port 5434 whatever the name (the API's default port, and a Cloud SQL
 * proxy to another company's production database once listened there on this Mac). There is no override flag on purpose.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function testDatabaseProblem(env: Record<string, string | undefined>): string | null {
  if (env.NODE_ENV === 'production') return 'NODE_ENV is production';
  const raw = env.DATABASE_URL;
  if (!raw) return 'DATABASE_URL is not set (the app would fall back to localhost:5434, which is not a test database)';
  let u: URL;
  try { u = new URL(raw); } catch { return 'DATABASE_URL is not a URL'; }
  if (!/^postgres(ql)?:$/.test(u.protocol)) return `DATABASE_URL protocol ${u.protocol} is not postgres`;
  const extra = (env.TEST_DB_HOSTS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const host = u.hostname.toLowerCase();
  if (!LOOPBACK.has(host) && !extra.includes(host)) return `host ${host} is not local (allowed: localhost, 127.0.0.1, ::1${extra.length ? ', ' + extra.join(', ') : ''})`;
  const db = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!/test/i.test(db)) return `database "${db}" does not have "test" in its name`;
  if (u.port === '5434') return 'port 5434 is the dev database and once a proxy to another company\'s production database; use the throwaway test DB on 5499';
  return null;
}

export function assertThrowawayTestDatabase(env: Record<string, string | undefined>) {
  const problem = testDatabaseProblem(env);
  if (problem) {
    throw new Error(`Refusing to run tests: ${problem}. Point DATABASE_URL at a throwaway PostGIS test database, e.g.\n` +
      `  bash apps/api/scripts/test-db.sh up   # docker postgis on 127.0.0.1:5499, database tablamigo_test, migrated\n` +
      `  export DATABASE_URL=postgres://tablamigo:tablamigo-test@127.0.0.1:5499/tablamigo_test\n(see TESTING.md)`);
  }
}
