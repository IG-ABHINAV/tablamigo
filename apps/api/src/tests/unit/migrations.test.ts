// The migration files themselves. Applying all of them to an empty PostGIS is the first step of every CI run (the nightly
// workflow migrates a fresh postgis/postgis:16-3.4 before any suite), so a migration that only works on an existing database
// fails CI there; these checks catch the file-level mistakes earlier.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db/migrations');
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort();
const prefix = (f: string) => f.slice(0, 3);

describe('db/migrations', () => {
  it('every file is NNN_snake_case.sql and non-empty', () => {
    expect(files.length).toBeGreaterThanOrEqual(59);
    for (const f of files) {
      expect(f, f).toMatch(/^\d{3}_[a-z0-9_]+\.sql$/);
      expect(fs.readFileSync(path.join(DIR, f), 'utf8').trim().length, f).toBeGreaterThan(0);
    }
  });

  it('numbers only go up, with no gaps; the one shared prefix (054) is a known pair applied in name order', () => {
    const nums = [...new Set(files.map(f => Number(prefix(f))))];
    expect(nums).toEqual(Array.from({ length: nums.length }, (_, i) => i + 1));
    const dup = Object.entries(files.reduce<Record<string, string[]>>((a, f) => ((a[prefix(f)] ??= []).push(f), a), {})).filter(([, v]) => v.length > 1);
    // migrate.ts applies files in plain sort order and records each by full name, so two files with one number are safe as
    // long as their order never matters. New migrations take the next free number instead.
    expect(dup).toEqual([['054', ['054_report_target_types.sql', '054_retention_indexes.sql']]]);
  });

  it('the runner applies files in sorted name order and records each one (schema_migrations), each in its own transaction', () => {
    const runner = fs.readFileSync(path.resolve(DIR, '../migrate.ts'), 'utf8');
    expect(runner).toMatch(/\.sort\(\)/);
    expect(runner).toMatch(/insert into schema_migrations/);
    expect(runner).toMatch(/sql\.begin/);
  });

  it('no migration drops a core table or truncates data', () => {
    const core = ['users', 'activities', 'activity_members', 'chats', 'messages', 'trips', 'subscriptions', 'passes', 'reports'];
    for (const f of files) {
      const body = fs.readFileSync(path.join(DIR, f), 'utf8').replace(/--.*$/gm, '');
      for (const t of core) expect(body, `${f} drops ${t}`).not.toMatch(new RegExp(`drop\\s+table\\s+(if\\s+exists\\s+)?${t}\\b`, 'i'));
      expect(body, `${f} truncates`).not.toMatch(/\btruncate\b/i);
    }
  });
});
