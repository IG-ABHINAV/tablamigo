import { config } from './config.js';
import { bad } from './errors.js';

const BLOCKED = ['harassment', 'harassment/threatening', 'hate', 'hate/threatening', 'sexual', 'sexual/minors', 'violence/graphic', 'self-harm/instructions'];

/** True when OpenAI flags the text. Fails open: no key, an error or a reply slower than 2.5 s lets it through. */
export async function isBlocked(text: string) {
  if (!config.openaiKey) { console.warn('moderation skipped: OPENAI_API_KEY not set'); return false; }
  try {
    const r = await fetch('https://api.openai.com/v1/moderations', {
      method: 'POST', headers: { Authorization: `Bearer ${config.openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'omni-moderation-latest', input: text }), signal: AbortSignal.timeout(2500),
    });
    if (!r.ok) { console.warn('moderation skipped: HTTP', r.status); return false; }
    const j: any = await r.json();
    const c = j.results?.[0]?.categories ?? {};
    return BLOCKED.some(k => c[k] === true);
  } catch (e) { console.warn('moderation skipped:', (e as Error).message); return false; }
}

export async function assertClean(...texts: string[]) {
  if (await isBlocked(texts.join('\n'))) throw bad('message_blocked');
}
