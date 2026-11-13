// Setup for the `unit` vitest project (src/tests/unit): pure functions, no database, no network. A unit test that reaches
// Postgres by accident gets a connection refused on port 1 instead of whatever DATABASE_URL or apps/api/.env points at.
import { installNetworkGuard } from './tests/network-guard.js';

process.env.DATABASE_URL = 'postgres://unit-tests-have-no-database@127.0.0.1:1/none_test';
process.env.DOTENV_CONFIG_PATH = '/nonexistent/tablamigo-tests-never-load-dotenv';
process.env.ALL_FREE ??= 'false';
process.env.HOST_WELCOME ??= 'off';
process.env.STARTER_PLANS ??= 'off';
process.env.SCHEDULER = 'off';
process.env.OWNER_SALES_ALERT_EMAIL = '';
// Any real outside request from a unit test is a bug in the test (tests/network-guard.ts, shared with test-setup.ts).
installNetworkGuard();
