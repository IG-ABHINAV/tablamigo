// Security headers and the CSP report sink on the real server process (src/main.ts) over real HTTP, as nginx reaches it in
// production. tests/integration/security-headers.test.ts covers each rule in-process; infra/nginx/headers-e2e.sh the website.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tablamigo-sech-e2e-'));
const LOG = path.join(TMP, 'server.log');
let server: ChildProcess;
let BASE = '';
const freePort = () => new Promise<number>(res => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); }); });
const waitFor = async <T>(f: () => T | Promise<T>, what: string, ms = 10_000): Promise<NonNullable<T>> => {
  const end = Date.now() + ms;
  for (;;) { const v = await f(); if (v) return v as NonNullable<T>; if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise(r => setTimeout(r, 100)); }
};

beforeAll(async () => {
  const PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development', PORT: String(PORT), PUBLIC_URL: BASE,
    DATABASE_URL: process.env.DATABASE_URL, DOTENV_CONFIG_PATH: '/nonexistent/tablamigo-tests-never-load-dotenv',
    JWT_SECRET: 'dev-only-secret-change-me', RESEND_API_KEY: '', EMAIL_JOBS: 'off', SCHEDULER: 'off', OPENAI_API_KEY: '',
  };
  const out = fs.openSync(LOG, 'a');
  server = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], { cwd: API_DIR, env: env as any, stdio: ['ignore', out, out] });
  await waitFor(async () => (await fetch(BASE + '/health').then(r => r.ok).catch(() => false)), 'server /health', 60_000);
});
afterAll(async () => {
  if (server && server.exitCode === null && server.signalCode === null) { server.kill('SIGTERM'); await new Promise(r => server.once('exit', r)); }
  if (process.env.E2E_ARTIFACTS) { fs.mkdirSync(process.env.E2E_ARTIFACTS, { recursive: true }); fs.copyFileSync(LOG, path.join(process.env.E2E_ARTIFACTS, 'security-headers.log')); }
});

describe('security headers on the server process', () => {
  it('a JSON answer, a 404 and a 401 carry nosniff, no-referrer, DENY and the API policy', async () => {
    for (const [p, st] of [['/health', 200], ['/nope', 404], ['/me', 401]] as const) {
      const r = await fetch(BASE + p);
      expect(r.status, p).toBe(st);
      expect(r.headers.get('x-content-type-options'), p).toBe('nosniff');
      expect(r.headers.get('referrer-policy'), p).toBe('no-referrer');
      expect(r.headers.get('x-frame-options'), p).toBe('DENY');
      expect(r.headers.get('content-security-policy'), p).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    }
  });

  it("a browser's CSP report is answered 204 and logged as one line without the page's query", async () => {
    const r = await fetch(BASE + '/csp-report', { method: 'POST', headers: { 'content-type': 'application/csp-report' },
      body: JSON.stringify({ 'csp-report': { 'document-uri': 'https://tablamigo.hookstep.in/app/user/9?ref=secret-ref', 'effective-directive': 'connect-src', 'blocked-uri': 'https://tracker.example/p?id=1' } }) });
    expect(r.status).toBe(204);
    const line = await waitFor(() => fs.readFileSync(LOG, 'utf8').split('\n').find(l => l.includes('csp report-only: connect-src')), 'report logged');
    expect(line).toContain('blocked https://tracker.example on tablamigo.hookstep.in/app/user/9');
    expect(fs.readFileSync(LOG, 'utf8')).not.toContain('secret-ref');
  });
});
