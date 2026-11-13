// Every error code the API sends without its own sentence needs app copy (apps/mobile/src/lib/api.ts FRIENDLY). Without it
// the app shows "Something went wrong on our side. Try again in a moment." for an ordinary 400/404, which reads as an outage
// (e.g. a mistyped invite code). KNOWN_GAPS lists the codes that had no copy on 22 Oct 2026; the test fails when a NEW code
// ships without copy, and when a gap gets copy (then delete it from the list).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MOBILE = path.resolve(API, '../../mobile/src');
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const apiFiles = [...walk(path.join(API, 'routes')), ...walk(path.join(API, 'lib')), path.join(API, 'server.ts')].filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'));

/** code -> whether every throw site passes its own message. */
function apiCodes() {
  const out = new Map<string, boolean>();
  const add = (code: string, hasMessage: boolean) => out.set(code, (out.get(code) ?? true) && hasMessage);
  for (const f of apiFiles) {
    const t = fs.readFileSync(f, 'utf8');
    for (const m of t.matchAll(/\b(bad|forbidden|notFound)\('([a-z_0-9]+)'(\s*,\s*[^)]+)?\)/g)) add(m[2], !!m[3]);
    for (const m of t.matchAll(/HttpError\(\d+,\s*'([a-z_0-9]+)'(?:\s*,\s*([^,)]+))?/g)) add(m[1], !!m[2] && m[2].trim() !== 'undefined');
  }
  return out;
}
const FRIENDLY = new Set([...fs.readFileSync(path.join(MOBILE, 'lib/api.ts'), 'utf8').split('const FRIENDLY')[1].split('};')[0].matchAll(/^\s+([a-z_0-9]+):/gm)].map(m => m[1]));
// Codes some screen handles itself (a literal '<code>' outside lib/api.ts).
const appText = walk(MOBILE).filter(f => /\.(ts|tsx)$/.test(f) && !f.endsWith('lib/api.ts')).map(f => fs.readFileSync(f, 'utf8')).join('\n');

const KNOWN_GAPS = [
  'activity_not_found', 'can_only_edit_text', 'cannot_ban_admin', 'cannot_ban_self', 'cannot_connect_self', 'cannot_delete',
  'cannot_invite_self', 'empty_audio', 'host_only', 'invalid_photo_ids', 'invalid_prompt_ids', 'lead_not_found',
  'link_expired_or_invalid', 'moment_not_found', 'no_host', 'not_owner', 'payment_already_used', 'photo_not_found', 'prompt_not_found',
  'recipient_not_found', 'request_not_found', 'team_account', 'ticket_not_found', 'tip_not_found', 'trip_not_found', 'user_not_found',
].sort();

describe('API error codes have words in the app', () => {
  const codes = apiCodes();
  const gaps = [...codes].filter(([c, hasMessage]) => !hasMessage && !FRIENDLY.has(c) && !appText.includes(`'${c}'`)).map(([c]) => c).sort();

  it('found the API codes and the app copy (sanity)', () => {
    expect(codes.size).toBeGreaterThan(100);
    expect(FRIENDLY.size).toBeGreaterThan(60);
    expect(FRIENDLY.has('server_error')).toBe(true);
  });

  it('no new code without copy (add it to FRIENDLY in apps/mobile/src/lib/api.ts)', () => {
    expect(gaps.filter(c => !KNOWN_GAPS.includes(c))).toEqual([]);
  });

  it('the known gaps list is current (remove codes that now have copy)', () => {
    expect(KNOWN_GAPS.filter(c => !gaps.includes(c))).toEqual([]);
  });

  // Until 22 Oct 2026 a wrong invite code on the referral screen (POST /me/referral/redeem -> 404 invalid_code) showed
  // "Something went wrong on our side. Try again in a moment.", so the person retried a code that would never work.
  it('a mistyped invite code gets its own message, not the server-error one', () => {
    expect(FRIENDLY.has('invalid_code') || appText.includes("'invalid_code'")).toBe(true);
  });
});
