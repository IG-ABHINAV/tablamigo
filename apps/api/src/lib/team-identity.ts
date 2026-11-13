/**
 * What marks the Tablamigo Host (lib/host.ts) as the team in the installed app: its name, "Tablamigo Host (Team)", and its
 * avatar, the site's icon. The app does not render isTeam, so these two are all a person sees. Once the welcome DM has taught
 * people that the official team writes to them, a profile that copies either is a ready scam, so people can't use them:
 *
 *   name   nothing that reads "Tablamigo" (any spacing, accents or look-alike letters, I for l, rn for m), no "(Team)"
 *          label, no "official"
 *   photo  none of the site's own images (the Host's avatar is one), and never the Host's current photo (routes/me.ts also
 *          takes a new profile photo only from the person's own uploads)
 *
 * The checks apply to people only (PATCH /me, which onboarding uses, POST /me/photos, and a Google name at sign-up); the team
 * account never signs in.
 */
import { sql } from './db.js';
import { config } from './config.js';
import { fileUrl } from './storage.js';

// Characters that pass for a Latin letter in a name, after lower-casing: Cyrillic, Greek and Armenian look-alikes, IPA letters
// and small capitals, letters with a stroke or hook (NFKD leaves those whole), and the usual digit and sign swaps. Fullwidth and
// maths-styled letters ("Ｔａｂ", "𝐓𝐚𝐛") need no entry: NFKD turns them into plain ones.
const LOOKALIKE: Record<string, string> = {
  'а': 'a', 'в': 'b', 'ь': 'b', 'с': 'c', 'е': 'e', 'г': 'r', 'һ': 'h', 'н': 'h', 'і': 'i', 'ї': 'i', 'ј': 'j', 'к': 'k',
  'ӏ': 'l', 'м': 'm', 'п': 'n', 'о': 'o', 'р': 'p', 'ѕ': 's', 'т': 't', 'у': 'y', 'х': 'x',
  'α': 'a', 'β': 'b', 'ϲ': 'c', 'ε': 'e', 'η': 'n', 'ι': 'i', 'κ': 'k', 'μ': 'm', 'ν': 'v', 'ο': 'o', 'σ': 'o', 'ρ': 'p',
  'τ': 't', 'υ': 'u', 'χ': 'x',
  'ց': 'g', 'օ': 'o',
  'ɑ': 'a', 'ⱥ': 'a', 'ᴀ': 'a', 'ƀ': 'b', 'ɓ': 'b', 'ʙ': 'b', 'ƈ': 'c', 'ᴄ': 'c', 'ɇ': 'e', 'ᴇ': 'e', 'ƒ': 'f', 'ꜰ': 'f',
  'ɡ': 'g', 'ɢ': 'g', 'ǥ': 'g', 'ɠ': 'g', 'ı': 'i', 'ɩ': 'i', 'ɨ': 'i', 'ɪ': 'i', 'ł': 'l', 'ƚ': 'l', 'ɫ': 'l', 'ɭ': 'l',
  'ʟ': 'l', 'ǀ': 'l', 'ɱ': 'm', 'ᴍ': 'm', 'ɴ': 'n', 'ø': 'o', 'ɵ': 'o', 'ᴏ': 'o', 'ŧ': 't', 'ƭ': 't', 'ʈ': 't', 'ᴛ': 't',
  '0': 'o', '1': 'l', '!': 'l', '¡': 'l', '|': 'l', '3': 'e', '4': 'a', '@': 'a', '5': 's', '$': 's', '6': 'b', '7': 't',
  '8': 'b', '9': 'g',
};
/** Latin letters that pass for each other, made one: i and l (so I, 1, | and ! too), and rn for m. ("vv" for w and "cl" for d
 *  are left out: no w in the words below, and "cl" is in "official".) */
const sameShape = (s: string) => s.replace(/i/g, 'l').replace(/rn/g, 'm');
/** Lower case, accents and invisible characters (zero-width spaces, joiners) off, look-alikes folded to Latin. */
const fold = (s: string) =>
  sameShape([...s.normalize('NFKD').replace(/[\p{M}\p{Cf}]/gu, '').toLowerCase()].map(c => LOOKALIKE[c] ?? c).join(''));

// The words themselves go through the same fold, so both sides of each comparison are spelled alike ("official" is "offlclal").
const TEAM_NAME = fold('tablamigo');
const TEAM_LABEL = new RegExp(`[([{]\\s*${fold('team')}\\s*[)\\]}]`);
const OFFICIAL = new RegExp(`(^|[^a-z])${fold('official')}([^a-z]|$)`);

/** A name a person can't take: it reads like the team account's. */
export function looksLikeTeamName(name: string): boolean {
  const f = fold(name);
  // "Tablamigo", "Tabla-migo", "T a b l a m i g o", "Tab1amigo", "TabIamigo", "Tablarnigo", "Tablamiɡo"; rn again once the
  // gaps are out, for "Tablar nigo".
  if (sameShape(f.replace(/[^a-z]/g, '')).includes(TEAM_NAME)) return true;
  return TEAM_LABEL.test(f) || OFFICIAL.test(f);
}

const comparable = (u: URL) => (u.hostname.replace(/\.$/, '') + u.pathname.replace(/\/+$/, '')).toLowerCase();

/** A photo URL a person can't use: one of the site's own images (not an upload), or the Host's photo. */
export async function isTeamPhoto(url: string): Promise<boolean> {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  const host = u.hostname.replace(/\.$/, '').toLowerCase();
  const site = new URL(config.siteUrl).hostname.toLowerCase();
  // Uploads are served from fileUrl('') (lib/storage.ts), which may sit on the site's host; anything else there is the site's.
  if ((host === site || host.endsWith('.' + site)) && !url.startsWith(fileUrl(''))) return true;
  const [team] = await sql`select photo_url from users where account_kind = 'team' and photo_url is not null`;
  if (!team) return false;
  try { return comparable(new URL(team.photoUrl)) === comparable(u); } catch { return false; }
}

export const TEAM_NAME_MSG = 'Names with "Tablamigo", "(Team)" or "official" are kept for the Tablamigo team account. Please use your own name.';
export const TEAM_PHOTO_MSG = 'That picture belongs to the Tablamigo team account. Please choose a photo of yourself.';
