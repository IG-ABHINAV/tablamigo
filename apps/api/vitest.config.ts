import { defineConfig } from 'vitest/config';

// Three layers (TESTING.md, "Automated suites"):
//  - unit:        src/tests/unit, pure functions and file-level consistency checks. No database, no network.
//  - integration: every src/*.test.ts plus src/tests/integration. The Fastify app in-process (app.inject) against a throwaway
//                 PostGIS test database; outside services mocked. test-setup.ts refuses any database that isn't one.
//  - e2e:         src/tests/e2e. The real server process (node src/main.ts) over HTTP and socket.io, and workers that act on
//                 the whole database. One file at a time, and only after every integration file has finished (groupOrder).
// `vitest run` runs all three in that order; `--project unit|integration|e2e` runs one.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    projects: [
      { extends: true, test: { name: 'unit', include: ['src/tests/unit/**/*.test.ts'], setupFiles: ['src/test-unit-setup.ts'], sequence: { groupOrder: 0 } } },
      { extends: true, test: { name: 'integration', include: ['src/*.test.ts', 'src/tests/integration/**/*.test.ts'], setupFiles: ['src/test-setup.ts'], sequence: { groupOrder: 1 } } },
      { extends: true, test: { name: 'e2e', include: ['src/tests/e2e/**/*.test.ts'], setupFiles: ['src/test-setup.ts'], fileParallelism: false, testTimeout: 60_000, hookTimeout: 120_000, sequence: { groupOrder: 2 } } },
    ],
  },
});
