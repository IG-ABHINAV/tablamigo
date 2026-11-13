// Runs before every test file (vitest.config.ts setupFiles), before any app module reads config. The suite was written for
// the paid tiers, so it runs with paid plans on (ALL_FREE=false) unless the environment says otherwise. all-free.test.ts
// switches config.allFree on itself to test the everything-free mode.
import { assertThrowawayTestDatabase } from './test-db-guard.js';
import { installNetworkGuard } from './tests/network-guard.js';

// No real outside requests: Nominatim and Photon get canned answers, any other non-local host is refused (tests/network-guard.ts).
// Before this, every geo_cache miss (POST /me/location, POST /activities) asked the live Nominatim, up to 4 s each.
installNetworkGuard();

// The suites delete and rewrite rows (e.g. `delete from users where email like '%@test.tablamigo'`), so they only ever run
// against a throwaway test database. This refuses a missing DATABASE_URL (config.ts would fall back to localhost:5434, where
// a Cloud SQL proxy to another company's production database has listened on this Mac), a non-local host, and a database
// whose name doesn't say it is a test database. See TESTING.md ("Automated suites").
assertThrowawayTestDatabase(process.env);

// Never read apps/api/.env in tests: it can hold live Resend, OpenAI, Razorpay or Play keys, and a test that signs in an
// unlisted address would then send a real email. config.ts imports dotenv/config, which honours DOTENV_CONFIG_PATH.
process.env.DOTENV_CONFIG_PATH = '/nonexistent/tablamigo-tests-never-load-dotenv';

process.env.ALL_FREE ??= 'false';
// The owner's sale alerts stay off unless a test file switches them on itself (tests/integration/owner-sale-alerts.test.ts):
// an address exported in a developer's shell must not make every billing test write alerts.
process.env.OWNER_SALES_ALERT_EMAIL = '';
// The Host's welcome DMs and the starter plans run from the scheduler tick; other test files tick it too, so they stay off
// unless a test switches them on itself (host-welcome.test.ts, starter-plans.test.ts).
process.env.HOST_WELCOME ??= 'off';
process.env.STARTER_PLANS ??= 'off';
// The automatic team messages, the email ladder and the engagement loops (migration 069) likewise.
process.env.TRIP_MATCH ??= 'off';
process.env.PLUS_WELCOME ??= 'off';
process.env.CITY_NUDGE ??= 'off';
process.env.EMAIL_LADDER ??= 'off';
process.env.ENGAGEMENT ??= 'off';
