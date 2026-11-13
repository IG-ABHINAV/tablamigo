// The escalation ladder's rules on their own (lib/ladder.ts ESCALATION, CHANNEL_ORDER, quiet hours) and the channel helpers
// that need no database (lib/channels.ts plainText, Telegram start tokens, which providers count as configured).
import { describe, it, expect, afterEach } from 'vitest';
import { ESCALATION, CHANNEL_ORDER, ESCALATIONS_PER_DAY, quietHours, ruleFor } from '../../lib/ladder.js';
import { plainText, telegramStartToken, readTelegramStartToken, configured, telegramLink } from '../../lib/channels.js';
import { alertsOffToken, readAlertsOffToken } from '../../lib/team-dm.js';

const UID = '3f2a8c1e-0b7d-4e55-9a10-2c4d6e8f0a1b';
const ENV = ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_TEMPLATE', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_USERNAME', 'TELEGRAM_WEBHOOK_SECRET', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM'];
afterEach(() => { for (const k of ENV) delete process.env[k]; });

describe('ESCALATION: one delay per event type', () => {
  it('plan invites and plan messages after 30 minutes, DMs after 1 hour, trip matches after 6 hours, digests daily', () => {
    expect(ESCALATION.plan_message.delayMin).toBe(30);
    expect(ESCALATION.buddy_request.delayMin).toBe(30);
    expect(ESCALATION.plan_soon.delayMin).toBe(30);
    expect(ESCALATION.dm.delayMin).toBe(60);
    expect(ESCALATION.trip_match.delayMin).toBe(360);
    for (const k of ['city_nudge', 'plan_views'] as const) { expect(ESCALATION[k].delayMin).toBe(1440); expect(ESCALATION[k].digest).toBe(true); }
  });
  it('without a push token nothing waits longer than with one, and the plan reminder goes at once', () => {
    for (const r of Object.values(ESCALATION)) expect(r.noTokenDelayMin).toBeLessThanOrEqual(r.delayMin);
    expect(ESCALATION.plan_soon.noTokenDelayMin).toBe(0);
  });
  it('the events a person can switch off name a real switch', () => {
    expect(ESCALATION.trip_match.optOut).toBe('trip_match_alerts');
    expect(ESCALATION.plan_soon.optOut).toBe('plan_alerts');
    expect(ruleFor('nope')).toBeNull();
  });
  it('channels in order after push: email, WhatsApp, Telegram, SMS; a small daily cap', () => {
    expect(CHANNEL_ORDER).toEqual(['email', 'whatsapp', 'telegram', 'sms']);
    expect(ESCALATIONS_PER_DAY).toBeLessThanOrEqual(5);
  });
});

describe('quiet hours in the person\'s own time zone', () => {
  it('9:00-21:00 local, 7:00-22:00 for urgent events', () => {
    const at = (iso: string) => new Date(iso);
    expect(quietHours(at('2035-03-14T03:30:00Z'), 'Asia/Kolkata')).toBe(false);   // 09:00 IST
    expect(quietHours(at('2035-03-14T03:29:00Z'), 'Asia/Kolkata')).toBe(true);    // 08:59 IST
    expect(quietHours(at('2035-03-14T15:30:00Z'), 'Asia/Kolkata')).toBe(true);    // 21:00 IST
    expect(quietHours(at('2035-03-14T15:30:00Z'), 'Asia/Kolkata', true)).toBe(false);
    expect(quietHours(at('2035-03-14T14:00:00Z'), 'America/New_York')).toBe(false);   // 10:00 EDT
    expect(quietHours(at('2035-03-14T12:00:00Z'), 'Asia/Tokyo')).toBe(true);
  });
});

describe('channel helpers', () => {
  it('plain text: title, body, link; cut to fit an SMS with the link kept whole', () => {
    const m = { kind: 'dm', ref: 'r', title: 'New message from Kofi', body: 'Open Tablamigo to read it. '.repeat(20), url: 'https://tablamigo.hookstep.in/app/chat/c1' };
    expect(plainText({ ...m, body: 'Hi.' })).toBe('New message from Kofi\nHi.\nhttps://tablamigo.hookstep.in/app/chat/c1');
    const sms = plainText(m, 160);
    expect(sms.length).toBeLessThanOrEqual(160);
    expect(sms.endsWith('\nhttps://tablamigo.hookstep.in/app/chat/c1')).toBe(true);
  });
  it('Telegram start tokens: round-trip, under 64 safe characters, forged or truncated ones refused', () => {
    const t = telegramStartToken(UID);
    expect(t).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(readTelegramStartToken(t)).toBe(UID);
    expect(readTelegramStartToken(t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A'))).toBeNull();
    expect(readTelegramStartToken('3f2a8c1e0b7d4e559a102c4d6e8f0a1b_xxxxxxxxxxxxxxxxxxxx')).toBeNull();
    expect(readTelegramStartToken('')).toBeNull();
  });
  it('the alerts-off token names one switch and can\'t be moved to another', () => {
    const t = alertsOffToken(UID, 'trip_match');
    expect(readAlertsOffToken(t)).toEqual({ userId: UID, which: 'trip_match' });
    expect(readAlertsOffToken(t.replace('.trip_match.', '.plan.'))).toBeNull();
    expect(readAlertsOffToken(`${UID}.email.x`)).toBeNull();
  });
  it('WhatsApp, Telegram and SMS stay off until every credential is set', () => {
    expect(configured.whatsapp() || configured.telegram() || configured.sms()).toBe(false);
    expect(telegramLink(UID)).toBeNull();
    process.env.WHATSAPP_TOKEN = 't'; process.env.WHATSAPP_PHONE_NUMBER_ID = '1';
    expect(configured.whatsapp()).toBe(false);
    process.env.WHATSAPP_TEMPLATE = 'tablamigo_alert';
    expect(configured.whatsapp()).toBe(true);
    process.env.TELEGRAM_BOT_TOKEN = 't'; process.env.TELEGRAM_BOT_USERNAME = 'bot';
    expect(configured.telegram()).toBe(false);                  // never without the webhook secret
    process.env.TELEGRAM_WEBHOOK_SECRET = 's';
    expect(telegramLink(UID)).toMatch(/^https:\/\/t\.me\/bot\?start=/);
    process.env.TWILIO_ACCOUNT_SID = 'AC1'; process.env.TWILIO_AUTH_TOKEN = 'x';
    expect(configured.sms()).toBe(false);
    process.env.TWILIO_FROM = '+15550001111';
    expect(configured.sms()).toBe(true);
  });
});
