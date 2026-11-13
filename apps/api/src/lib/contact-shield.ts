/**
 * Finds contact details in a chat message: phone numbers, emails, and messaging or social handles and links.
 * Used to hold back off-platform contact details between strangers (see routes/chats.ts).
 *
 * It errs towards letting ordinary travel talk through: prices, times, dates, flight numbers, headcounts and
 * short numbers never trigger. Evasions it catches: spaced, dotted or bracketed numbers, number words
 * ("nine eight double seven"), keycap emoji and non-Latin digits, O/l for 0/1 inside long numbers,
 * "abc at gmail dot com", "insta: abc", "i n s t a", "wh4tsapp", wa.me and t.me links, and a number
 * split across a few messages (pass the sender's recent messages as `recent`).
 */
export type ContactKind = 'phone' | 'email' | 'handle' | 'link';
export type ContactHit = { kind: ContactKind; match: string };

const WORD_DIGITS: Record<string, string> = {
  zero: '0', oh: '0', nought: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9', niner: '9',
};
const NUM_WORD = Object.keys(WORD_DIGITS).join('|');
// Zero digits of the other decimal scripts people use in Tablamigo's markets (Arabic, Persian, Devanagari, Bengali, Thai...).
const ZEROS = [0x0660, 0x06f0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66, 0x0ce6, 0x0d66, 0x0e50, 0x0ed0, 0x1040, 0x17e0];

const PLATFORMS = 'instagram|insta|insa|ig|whatsapp|whatsap|watsapp|watsap|whatapp|whats app|telegram|tele|tg|snapchat|snap|signal|facebook|fb|messenger|wechat|kakao|kakaotalk|viber|tiktok|twitter|line id|imessage|discord|skype|gmail|email|e-mail|mail id';
const LINK = /\b(?:wa\.me|chat\.whatsapp\.com|api\.whatsapp\.com|whatsapp\.com\/\S|t\.me|telegram\.me|telegram\.dog|instagram\.com|instagr\.am|ig\.me|snapchat\.com|facebook\.com|fb\.com|fb\.me|m\.me|messenger\.com|signal\.me|line\.me|wechat\.com|discord\.gg|discord\.com\/users|tiktok\.com\/@|twitter\.com|x\.com)\S*/i;
const EMAIL = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/i;
const EMAIL_NO_TLD = /[a-z0-9][a-z0-9._%+-]*@(?:gmail|googlemail|yahoo|ymail|hotmail|outlook|live|icloud|me|proton|protonmail|aol|rediffmail|zoho|gmx)\b/i;
const HANDLE_CHARS = '@?[a-z0-9][a-z0-9._]{2,29}';
const SEP = '(?:\\s*(?:[:=>\\-–—]+|->)\\s*|\\s*@)';
// "insta: abc", "ig - @abc", "whatsapp = ...", "insta@abc"
const PLATFORM_SEP = new RegExp(`\\b(?:${PLATFORMS})\\b\\s*(?:id|handle|username|user ?name|account|acc)?${SEP}${HANDLE_CHARS}`, 'i');
// "insta id abc", "ig handle is abc"
const PLATFORM_ID = new RegExp(`\\b(?:${PLATFORMS})\\s*(?:id|handle|username|user ?name)\\b\\s*(?:is|:|-)?\\s*${HANDLE_CHARS}`, 'i');
// "add me on insta abc", "follow me on ig @abc", "find me on telegram: abc"
const ADD_ME = new RegExp(`\\b(?:add|follow|find|dm|text|message|msg|ping|reach|contact|hit)\\s+me\\s+(?:up\\s+)?(?:on|at|via)\\s+(?:${PLATFORMS})\\b\\s*(?:id|handle|username)?\\s*(?:is|:|-|@)?\\s*${HANDLE_CHARS}`, 'i');
// "my insta is abc_123": only when the handle looks like one, so "my insta is broken" stays fine.
const PLATFORM_IS = new RegExp(`\\b(?:${PLATFORMS})\\b\\s+(?:is|id)\\s+(@[a-z0-9._]{3,30}|[a-z0-9]*[0-9._][a-z0-9._]*)`, 'i');
// A bare @handle with a digit, dot or underscore: "@maria.travels", "@abc_123". "@starbucks" and "@7pm" pass.
const AT_HANDLE = /(?:^|[\s(])@([a-z0-9._]{3,30})\b/i;

/** Lower-case, fold fullwidth and other-script digits, drop keycap marks and zero-width characters. */
function fold(text: string) {
  let s = text.normalize('NFKC').toLowerCase().replace(/[​-‍⁠﻿️⃣]/g, '');
  s = s.replace(/\p{Nd}/gu, ch => {
    const cp = ch.codePointAt(0)!;
    const z = ZEROS.find(z => cp >= z && cp <= z + 9);
    return z === undefined ? ch : String(cp - z);
  });
  return s;
}

/** "nine eight double seven" -> "9 8 77"; only words that stand alone or touch digits. */
function wordsToDigits(s: string) {
  s = s.replace(new RegExp(`\\b(double|triple)[\\s-]+(${NUM_WORD}|\\d)\\b`, 'g'), (_, m, d) => (WORD_DIGITS[d] ?? d).repeat(m === 'double' ? 2 : 3));
  return s.replace(new RegExp(`(?<![a-z])(${NUM_WORD})(?![a-z])`, 'g'), w => WORD_DIGITS[w]);
}

/** "i n s t a" -> "insta", "w.h.a.t.s.a.p.p" -> "whatsapp" (runs of 4+ single letters). */
const collapseSpelled = (s: string) => s.replace(/\b(?:[a-z][\s.*_-]){3,}[a-z]\b/g, m => m.replace(/[\s.*_-]/g, ''));

/** "wh4tsapp", "1nsta", "$nap" for platform-name matching only. */
const unleet = (s: string) => s.replace(/[4@]/g, 'a').replace(/[1!|]/g, 'i').replace(/3/g, 'e').replace(/[5$]/g, 's').replace(/0/g, 'o').replace(/7/g, 't');

/** "abc at gmail dot com", "abc(at)gmail(dot)com", "abc [@] gmail [.] com". */
function deobfuscateEmail(s: string) {
  return s
    .replace(/\s*[[({<]\s*(?:at|@)\s*[\])}>]\s*/g, '@')
    .replace(/\s*[[({<]\s*(?:dot|\.)\s*[\])}>]\s*/g, '.')
    .replace(/\s+at\s+(?=(?:gmail|googlemail|yahoo|ymail|hotmail|outlook|live|icloud|proton(?:mail)?|aol|rediffmail|zoho|gmx)\b)/g, '@')
    .replace(/\s*@\s+/g, '@')
    .replace(/\s+dot\s+(?=(?:com|net|org|in|co|io|me|de|uk|fr|es|it|nl|au|ca|edu|app|info|biz|th|id|vn|ph|my|sg|jp)\b)/g, '.')
    .replace(/(?<=\w)\s*\.\s+(?=(?:com|net|org|in|co|io|me)\b)/g, '.');
}

// Tokens that are clearly not part of a phone number.
const TIME = /^(?:[01]?\d|2[0-3])[.:h][0-5]\d(?:am|pm|h|hrs)?$/;
const DATE = /^(?:[0-3]?\d[./-][01]?\d(?:[./-](?:\d{2}|\d{4}))?|\d{4}[./-][01]?\d[./-][0-3]?\d)$/;
const YEAR = /^(?:19|20)\d{2}$/;
const COORD = /^-?\d{1,3}\.\d{4,7}$/;
const one = (t: string) => TIME.test(t) || DATE.test(t) || YEAR.test(t) || COORD.test(t);
const known = (tok: string) => one(tok) || tok.split(/[-–—]/).every(p => p !== '' && one(p));
const CURRENCY = /(?:[$€£¥₹฿₫₱₩]|\b(?:rs|inr|usd|eur|gbp|thb|idr|rp|vnd|aud|cad|sgd|myr|rm|php|aed|jpy|krw)\.?)\s*$/;
const CURRENCY_AFTER = /^\s*(?:k\b|rs|inr|rupees?|usd|dollars?|bucks|eur|euros?|gbp|pounds?|baht|thb|idr|rupiah|vnd|dong|yen|pesos?|lira|dirhams?|aed|ringgit|won)/;

/** Digit runs joined by spaces, dots, dashes, brackets or slashes; judged as a phone number or not. */
function findPhone(s: string): string | null {
  // O and l standing in for 0 and 1 inside long mostly-digit tokens: "98765432l0", "O98765 43210".
  s = s.replace(/[0-9ol|]{7,}/g, t => (t.replace(/[^0-9]/g, '').length >= 6 ? t.replace(/o/g, '0').replace(/[l|]/g, '1') : t));
  const re = /\+?\(?\d[\d\s.\-–—()/]*\d/g;
  s = s.replace(/\s+/g, ' ');
  for (const m of s.matchAll(re)) {
    const cand = m[0];
    const digits = cand.replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) continue;
    const start = m.index ?? 0;
    if (CURRENCY.test(s.slice(Math.max(0, start - 5), start)) || CURRENCY_AFTER.test(s.slice(start + cand.length))) continue;
    // Times, dates, years and coordinates, alone or as ranges ("10:30 - 12:30", "12/10/2026 - 15/10/2026").
    const toks = cand.split(/ (?:[-–—] )?| ?[–—] ?/).filter(Boolean);
    const rest = toks.filter(t => !known(t)).join('').replace(/\D/g, '');
    if (rest.length < 8) continue;
    // Two short groups is a range or a pair of numbers ("1500-2000", "2025 2026"), not a phone.
    const groups = cand.split(/[\s.\-–—()/]+/).filter(Boolean);
    if (groups.length === 2 && groups.every(g => g.replace(/\D/g, '').length <= 4)) continue;
    // A list of round amounts ("1500 2000 2500") is prices, not a phone.
    if (groups.every(g => /^\d{2,4}$/.test(g) && g.endsWith('0'))) continue;
    return cand.trim();
  }
  return null;
}

export function findContact(text: string, recent: string[] = []): ContactHit | null {
  const base = collapseSpelled(fold(text));
  const mail = deobfuscateEmail(base);
  const e = mail.match(EMAIL) ?? mail.match(EMAIL_NO_TLD);
  if (e) return { kind: 'email', match: e[0] };
  const l = mail.match(LINK);
  if (l) return { kind: 'link', match: l[0] };
  const phone = findPhone(wordsToDigits(base));
  if (phone) return { kind: 'phone', match: phone };
  for (const s of [base, unleet(base)]) {
    const h = s.match(PLATFORM_SEP) ?? s.match(PLATFORM_ID) ?? s.match(ADD_ME) ?? s.match(PLATFORM_IS);
    if (h) return { kind: 'handle', match: h[0] };
  }
  const at = base.match(AT_HANDLE);
  if (at && /[0-9._]/.test(at[1]) && /[a-z]/.test(at[1]) && !/^\d{1,2}([.:]\d{2})?(am|pm)?$/.test(at[1])) return { kind: 'handle', match: '@' + at[1] };
  // A number sent a few digits at a time: only a phone spread across the messages counts.
  if (recent.length) {
    const joined = findPhone(wordsToDigits(collapseSpelled(fold([...recent, text].join(' ')))));
    if (joined) return { kind: 'phone', match: joined };
  }
  return null;
}
