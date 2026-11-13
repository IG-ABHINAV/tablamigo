// The guard every database suite runs first (src/test-setup.ts): tests only ever touch a throwaway local test database.
import { describe, it, expect } from 'vitest';
import { testDatabaseProblem, assertThrowawayTestDatabase } from '../../test-db-guard.js';

const ok = (url: string, extra: Record<string, string> = {}) => testDatabaseProblem({ DATABASE_URL: url, ...extra });

describe('test database guard', () => {
  it('accepts a local database named for tests', () => {
    expect(ok('postgres://tablamigo:x@127.0.0.1:5499/tablamigo_test')).toBeNull();
    expect(ok('postgres://tablamigo:x@localhost:5432/tablamigo_e2e_test')).toBeNull();
    expect(ok('postgresql://tablamigo:x@[::1]:5499/test')).toBeNull();
  });

  it('refuses a missing DATABASE_URL: config.ts would fall back to localhost:5434 (a production proxy once listened there)', () => {
    expect(testDatabaseProblem({})).toMatch(/not set/);
    expect(() => assertThrowawayTestDatabase({})).toThrow(/Refusing to run tests/);
  });

  it('refuses the dev database and any database without "test" in its name', () => {
    expect(ok('postgres://tablamigo:tablamigo-local@localhost:5434/tablamigo')).toMatch(/does not have "test"/);
    expect(ok('postgres://u:p@127.0.0.1:5434/credentialing')).toMatch(/does not have "test"/);
  });

  it('refuses port 5434 even for a database named for tests (a proxy to another company\'s production DB once listened there)', () => {
    expect(ok('postgres://tablamigo:x@127.0.0.1:5434/tablamigo_test')).toMatch(/port 5434/);
    expect(ok('postgres://tablamigo:x@localhost:5434/tablamigo_browser_test')).toMatch(/port 5434/);
  });

  it('refuses remote hosts unless CI names its service host in TEST_DB_HOSTS', () => {
    expect(ok('postgres://u:p@10.0.0.5:5432/tablamigo_test')).toMatch(/not local/);
    expect(ok('postgres://u:p@db.example.com:5432/tablamigo_test')).toMatch(/not local/);
    expect(ok('postgres://u:p@postgres:5432/tablamigo_test', { TEST_DB_HOSTS: 'postgres' })).toBeNull();
    expect(ok('postgres://u:p@postgres:5432/tablamigo', { TEST_DB_HOSTS: 'postgres' })).toMatch(/does not have "test"/);
  });

  it('refuses production mode and non-postgres URLs', () => {
    expect(ok('postgres://u:p@127.0.0.1:5499/tablamigo_test', { NODE_ENV: 'production' })).toMatch(/production/);
    expect(ok('mysql://u:p@127.0.0.1:3306/tablamigo_test')).toMatch(/protocol/);
    expect(ok('not a url')).toMatch(/not a URL/);
  });
});
