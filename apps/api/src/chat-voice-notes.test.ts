import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const PEOPLE = ['cvn_alice', 'cvn_bob'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@cvn.tablamigo`).join(',');
process.env.REVIEW_CODE = '999999';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { config } = await import('./lib/config.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown, headers?: Record<string, string>) => Promise<import('light-my-request').Response>;

let ip = 1600;
async function login(name: string): Promise<Api> {
  const email = `${name}@cvn.tablamigo`;
  const remoteAddress = `10.99.6.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '999999' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  const call: Api = (method, url, payload, headers) => app.inject({
    method: method as any,
    url,
    payload: payload as any,
    headers: { authorization: `Bearer ${tok}`, ...(headers ?? {}) },
    remoteAddress
  });
  await call('PATCH', '/me', { name, birthdate: '1996-04-04', gender: 'woman', homeCountry: 'IN' });
  return call;
}

const idOf = async (name: string) => (await sql`select id from users where email = ${name + '@cvn.tablamigo'}`)[0].id as string;

const u: Record<string, Api> = {};

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@cvn.tablamigo'`;
  u.cvn_alice = await login('cvn_alice');
  u.cvn_bob = await login('cvn_bob');
  await sql`update users set plus_until = now() + interval '30 days' where email like '%@cvn.tablamigo'`;
});

afterAll(async () => {
  await sql`delete from users where email like '%@cvn.tablamigo'`;
  await app.close();
  await sql.end();
});

describe('voice notes are off unless FEATURE_VOICE_NOTES=on', () => {
  it('exploit: no audio upload and no voice/audio messages while the feature is off, whatever the body says', async () => {
    expect(config.features.voiceNotes).toBe(false);
    const bobId = await idOf('cvn_bob');
    const chatId = (await u.cvn_alice('POST', `/dm/${bobId}`)).json().chatId;

    const up = await u.cvn_alice('POST', '/uploads/audio/direct', Buffer.from('alice-audio'), { 'content-type': 'audio/m4a' });
    expect(up.statusCode).toBe(404);
    expect(up.json().error).toBe('voice_notes_unavailable');

    // The old app sent a hard-coded URL as a "voice" message; a message of kind voice/audio is refused outright now.
    for (const kind of ['voice', 'audio']) {
      for (const body of ['https://tablamigo.hookstep.in/dev-files/audio/voice-note-demo.m4a', 'call me on 98765 43210']) {
        const r = await u.cvn_alice('POST', `/chats/${chatId}/messages`, { kind, body, durationSeconds: 15 });
        expect(r.statusCode, `${kind} ${body}`).toBe(404);
        expect(r.json().error).toBe('voice_notes_unavailable');
      }
    }
    expect((await sql`select count(*)::int as n from messages where chat_id = ${chatId} and kind in ('voice', 'audio')`)[0].n).toBe(0);
    expect((await sql`select count(*)::int as n from chat_voice_notes v join messages m on m.id = v.message_id where m.chat_id = ${chatId}`)[0].n).toBe(0);

    // Text still works in the same chat.
    expect((await u.cvn_alice('POST', `/chats/${chatId}/messages`, { body: 'hello' })).statusCode).toBe(200);
  });
});

describe('Feature 16: Voice Notes in Chat (switched on)', () => {
  beforeAll(() => { config.features.voiceNotes = true; });
  afterAll(() => { config.features.voiceNotes = false; });

  it('uploads an audio file via POST /uploads/audio/direct and rejects unsupported formats', async () => {
    // 1. Upload valid M4A audio buffer
    const fakeAudio = Buffer.from('RIFF....WAVEfmt ....data....');
    const uploadRes = await u.cvn_alice('POST', '/uploads/audio/direct', fakeAudio, {
      'content-type': 'audio/m4a'
    });
    expect(uploadRes.statusCode).toBe(200);
    const { publicUrl, key } = uploadRes.json();
    expect(publicUrl).toBeDefined();
    expect(key).toContain('audio/');

    // 2. Reject non-audio content type
    const badRes = await u.cvn_alice('POST', '/uploads/audio/direct', Buffer.from('hello text'), {
      'content-type': 'text/plain'
    });
    expect(badRes.statusCode).toBe(400);
    expect(badRes.json().error).toBe('unsupported_audio_type');
  });

  it('sends and receives a voice note in a DM chat with duration metadata', async () => {
    const bobId = await idOf('cvn_bob');

    // Alice opens DM with Bob
    const dmRes = await u.cvn_alice('POST', `/dm/${bobId}`);
    const chatId = dmRes.json().chatId;

    // The hard-coded demo URL the app used to send, any other host, someone else's upload and plain text sent as a
    // "voice" message (which skipped the contact shield) are all refused.
    const bobUpload = (await u.cvn_bob('POST', '/uploads/audio/direct', Buffer.from('bob-audio'), { 'content-type': 'audio/m4a' })).json().publicUrl as string;
    for (const body of ['https://tablamigo.hookstep.in/dev-files/audio/voice-note-demo.m4a', 'https://evil.example/track.m4a', bobUpload, 'call me on 98765 43210']) {
      for (const kind of ['voice', 'audio']) {
        const r = await u.cvn_alice('POST', `/chats/${chatId}/messages`, { kind, body, durationSeconds: 5 });
        expect(r.statusCode, `${kind} ${body}`).toBe(400);
        expect(r.json().error).toBe('bad_audio');
      }
    }
    expect((await sql`select count(*)::int as n from messages where chat_id = ${chatId} and kind in ('voice', 'audio')`)[0].n).toBe(0);

    // Alice sends her own uploaded voice note with 18 seconds duration
    const audioUrl = (await u.cvn_alice('POST', '/uploads/audio/direct', Buffer.from('alice-audio'), { 'content-type': 'audio/m4a' })).json().publicUrl as string;
    const sendRes = await u.cvn_alice('POST', `/chats/${chatId}/messages`, {
      kind: 'voice',
      body: audioUrl,
      durationSeconds: 18
    });
    expect(sendRes.statusCode).toBe(200);
    const msg = sendRes.json();
    expect(msg.kind).toBe('voice');
    expect(msg.body).toBe(audioUrl);
    expect(msg.voiceNote).toBeDefined();
    expect(msg.voiceNote.durationSeconds).toBe(18);
    expect(msg.voiceNote.audioUrl).toBe(audioUrl);

    // Bob loads the chat messages
    const listRes = await u.cvn_bob('GET', `/chats/${chatId}/messages`);
    expect(listRes.statusCode).toBe(200);
    const { messages } = listRes.json();
    const voiceMsg = messages.find((m: any) => m.id === msg.id);
    expect(voiceMsg).toBeDefined();
    expect(voiceMsg.kind).toBe('voice');
    expect(voiceMsg.voiceNote).toBeDefined();
    expect(voiceMsg.voiceNote.durationSeconds).toBe(18);
  });
});
