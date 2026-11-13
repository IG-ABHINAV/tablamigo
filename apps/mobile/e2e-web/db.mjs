// Which database the browser pass uses, and a synchronous psql for it. A throwaway local test database only, never production
// and never the dev database: E2E_DATABASE_URL must be set (CI's service container, or the browser DB from
// apps/api/scripts/test-db.sh, i.e. E2E_DATABASE_URL=$BROWSER_DATABASE_URL) and pass the API suites' own guard (local host or
// TEST_DB_HOSTS, "test" in the name, not port 5434, not NODE_ENV=production). The seed deletes the @qa.test accounts, and a
// Cloud SQL proxy to another company's production database once listened on 5434 on this Mac.
import { execFileSync } from 'node:child_process';
import { testDatabaseProblem } from '../../api/src/test-db-guard.ts';

export const DATABASE_URL = process.env.E2E_DATABASE_URL ?? '';
const problem = testDatabaseProblem({ DATABASE_URL: DATABASE_URL || undefined, NODE_ENV: process.env.NODE_ENV, TEST_DB_HOSTS: process.env.TEST_DB_HOSTS });
if (problem) {
  throw new Error(`The browser pass refuses to run: E2E_DATABASE_URL ${problem.replace(/^DATABASE_URL /, '')}. Start the throwaway test DB ` +
    '(bash apps/api/scripts/test-db.sh up) and set E2E_DATABASE_URL=$BROWSER_DATABASE_URL; see TESTING.md.');
}
export const psql = q => execFileSync('psql', [DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '-tAc', q]).toString().trim();
