/**
 * Email layout. A template is a list of blocks; render() turns the same blocks into a table-based,
 * inline-styled HTML part and a plain-text part, so the two can never drift apart.
 *
 * Inline markup inside text: **bold** and [label](https://url). Everything else is escaped.
 */
import { config } from '../config.js';

export type Category = 'transactional' | 'reminders' | 'activity' | 'digest';
export type Person = { name: string; photoUrl?: string | null; sub?: string };
export type Block =
  | { t: 'eyebrow'; text: string }
  | { t: 'h1'; text: string }
  | { t: 'p'; text: string }
  | { t: 'small'; text: string }
  | { t: 'button'; label: string; url: string }
  | { t: 'code'; text: string }
  | { t: 'rows'; rows: [string, string][] }
  | { t: 'list'; items: string[]; marker?: 'check' | 'dot' }
  | { t: 'people'; people: Person[]; more?: string }
  | { t: 'stats'; items: { value: string; label: string }[] }
  | { t: 'divider' }
  /** A small pill above the headline ("Test mode"). Plain text, never parsed for **bold** or links. */
  | { t: 'badge'; text: string; tone?: 'muted' | 'warn' }
  /** Label/value rows whose values are untrusted text: escaped only, never parsed. A row with `url` links to it. */
  | { t: 'facts'; rows: { k: string; v: string; url?: string }[] }
  /** Untrusted free text (a message someone typed), shown as-is in a panel. */
  | { t: 'quote'; text: string };
export type Email = { subject: string; preheader: string; category: Category; blocks: Block[] };
export type Rendered = { subject: string; html: string; text: string };

export const BRAND = {
  coral: '#FF5A36', teal: '#10B39F', tealText: '#0A7C6E',
  bg: '#F7F7F5', card: '#FFFFFF', border: '#E8E8E3', rule: '#EFEFEA',
  ink: '#1D1D1B', body: '#4A4A46', muted: '#6E6E68',
};
export const FOOTER_ORG = 'Tablamigo by Hookstep · Ghatkopar, Mumbai, India';
const LOGO = 'https://tablamigo.hookstep.in/icon-192.png';
const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** For untrusted text (badge, facts, quote): also escapes the single quote. */
const escText = (s: string) => esc(s).replace(/'/g, '&#39;');
const inline = (s: string) => esc(s)
  .replace(/\*\*(.+?)\*\*/g, `<strong style="color:${BRAND.ink};font-weight:600">$1</strong>`)
  .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g, `<a href="$2" style="color:${BRAND.tealText};text-decoration:underline">$1</a>`);
const plain = (s: string) => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\[([^\]]+)\]\((mailto:)?([^)\s]+)\)/g, (_m, l, _mt, u) => l === u ? u : `${l} (${u})`);
const initials = (n: string) => n.trim().split(/\s+/).map(w => w[0] ?? '').join('').slice(0, 2).toUpperCase() || '?';

function blockHtml(b: Block): string {
  switch (b.t) {
    case 'eyebrow':
      return `<p class="eyebrow" style="margin:0 0 10px;font-size:12px;line-height:16px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${BRAND.tealText}">${inline(b.text)}</p>`;
    case 'h1':
      return `<h1 class="t1" style="margin:0 0 16px;font-size:24px;line-height:32px;font-weight:700;color:${BRAND.ink};letter-spacing:-.01em">${inline(b.text)}</h1>`;
    case 'p':
      return `<p class="t2" style="margin:0 0 16px;font-size:16px;line-height:26px;color:${BRAND.body}">${inline(b.text)}</p>`;
    case 'small':
      return `<p class="t3" style="margin:0 0 12px;font-size:13px;line-height:20px;color:${BRAND.muted}">${inline(b.text)}</p>`;
    case 'button':
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px"><tr><td align="center" bgcolor="${BRAND.coral}" style="border-radius:8px;background:${BRAND.coral}">
<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${esc(b.url)}" style="height:48px;v-text-anchor:middle;width:240px" arcsize="17%" stroke="f" fillcolor="${BRAND.coral}"><center style="color:#ffffff;font-family:Arial,sans-serif;font-size:16px;font-weight:bold">${esc(b.label)}</center></v:roundrect><![endif]-->
<!--[if !mso]><!--><a href="${esc(b.url)}" class="btn" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:16px;line-height:20px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:8px;background:${BRAND.coral}">${esc(b.label)}</a><!--<![endif]-->
</td></tr></table>`;
    case 'code':
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:4px 0 24px"><tr><td class="panel" align="center" bgcolor="#F4F4F1" style="background:#F4F4F1;border-radius:10px;padding:20px 12px;font-size:34px;line-height:40px;font-weight:700;letter-spacing:10px;color:${BRAND.ink};font-variant-numeric:tabular-nums"><span class="t1">${esc(b.text)}</span></td></tr></table>`;
    case 'rows':
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:4px 0 24px;border-collapse:collapse">${b.rows.map(([k, v], i) =>
        `<tr><td class="t3 line" style="padding:12px 0;font-size:14px;line-height:20px;color:${BRAND.muted};border-top:1px solid ${BRAND.rule}${i === b.rows.length - 1 ? `;border-bottom:1px solid ${BRAND.rule}` : ''}">${inline(k)}</td><td class="t1 line" align="right" style="padding:12px 0 12px 16px;font-size:14px;line-height:20px;font-weight:600;color:${BRAND.ink};text-align:right;border-top:1px solid ${BRAND.rule}${i === b.rows.length - 1 ? `;border-bottom:1px solid ${BRAND.rule}` : ''}">${inline(v)}</td></tr>`).join('')}</table>`;
    case 'list':
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 20px">${b.items.map(it =>
        `<tr><td valign="top" width="26" style="padding:3px 0 9px;font-size:15px;line-height:22px;${b.marker === 'dot' ? `color:${BRAND.muted}">&#8226;` : `color:${BRAND.teal};font-weight:700">&#10003;`}</td><td class="t2" style="padding:3px 0 9px;font-size:15px;line-height:22px;color:${BRAND.body}">${inline(it)}</td></tr>`).join('')}</table>`;
    case 'people': {
      const cells = b.people.map(p => {
        const face = p.photoUrl
          ? `<img src="${esc(p.photoUrl)}" width="48" height="48" alt="" style="display:block;width:48px;height:48px;border-radius:24px;object-fit:cover;border:0">`
          : `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="48" height="48" align="center" bgcolor="#E7F7F4" style="width:48px;height:48px;border-radius:24px;background:#E7F7F4;font-size:16px;font-weight:700;color:${BRAND.tealText}">${esc(initials(p.name))}</td></tr></table>`;
        return `<td valign="top" width="33%" style="padding:0 8px 0 0">${face}<p class="t1" style="margin:8px 0 0;font-size:14px;line-height:20px;font-weight:600;color:${BRAND.ink}">${esc(p.name)}</p>${p.sub ? `<p class="t3" style="margin:0;font-size:13px;line-height:18px;color:${BRAND.muted}">${esc(p.sub)}</p>` : ''}</td>`;
      });
      while (cells.length < 3) cells.push('<td width="33%"></td>');
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:4px 0 ${b.more ? 12 : 24}px"><tr>${cells.join('')}</tr></table>${b.more ? `<p class="t3" style="margin:0 0 24px;font-size:13px;line-height:20px;color:${BRAND.muted}">${inline(b.more)}</p>` : ''}`;
    }
    case 'stats':
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:4px 0 24px"><tr>${b.items.map((s, i) =>
        `<td valign="top" width="${Math.floor(100 / b.items.length)}%" style="${i ? 'padding-left:12px' : ''}"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td class="panel" bgcolor="#F7F7F5" style="background:#F7F7F5;border-radius:10px;padding:16px 18px"><p class="num" style="margin:0;font-size:30px;line-height:36px;font-weight:700;color:${BRAND.tealText}">${esc(s.value)}</p><p class="t3" style="margin:2px 0 0;font-size:13px;line-height:18px;color:${BRAND.muted}">${esc(s.label)}</p></td></tr></table></td>`).join('')}</tr></table>`;
    case 'badge': {
      const [fg, bg] = b.tone === 'warn' ? ['#8A5A00', '#FFF4DB'] : [BRAND.muted, '#F1F1EC'];
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px"><tr><td class="panel" bgcolor="${bg}" style="background:${bg};border-radius:999px;padding:3px 10px;font-size:12px;line-height:16px;font-weight:600;color:${fg}">${escText(b.text)}</td></tr></table>`;
    }
    case 'facts':
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:4px 0 24px;border-collapse:collapse">${b.rows.map((r, i) => {
        const edge = `border-top:1px solid ${BRAND.rule}${i === b.rows.length - 1 ? `;border-bottom:1px solid ${BRAND.rule}` : ''}`;
        const v = r.url ? `<a href="${esc(r.url)}" style="color:${BRAND.tealText};text-decoration:underline">${escText(r.v)}</a>` : escText(r.v);
        return `<tr><td class="t3 line" valign="top" width="38%" style="padding:10px 12px 10px 0;font-size:14px;line-height:20px;color:${BRAND.muted};${edge}">${escText(r.k)}</td><td class="t1 line" valign="top" style="padding:10px 0;font-size:14px;line-height:20px;font-weight:600;color:${BRAND.ink};word-break:break-word;${edge}">${v}</td></tr>`;
      }).join('')}</table>`;
    case 'quote':
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:4px 0 24px"><tr><td class="panel t2" bgcolor="#F7F7F5" style="background:#F7F7F5;border-radius:10px;padding:16px 18px;font-size:15px;line-height:24px;color:${BRAND.body};white-space:pre-line;word-break:break-word">${escText(b.text)}</td></tr></table>`;
    case 'divider':
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:8px 0 24px"><tr><td class="line" style="border-top:1px solid ${BRAND.rule};font-size:0;line-height:0">&nbsp;</td></tr></table>`;
  }
}

function blockText(b: Block): string {
  switch (b.t) {
    case 'eyebrow': return b.text.toUpperCase();
    case 'h1': return plain(b.text);
    case 'p': case 'small': return plain(b.text);
    case 'button': return `${b.label}: ${b.url}`;
    case 'code': return `    ${b.text}`;
    case 'rows': return b.rows.map(([k, v]) => `${plain(k)}: ${plain(v)}`).join('\n');
    case 'list': return b.items.map(i => `- ${plain(i)}`).join('\n');
    case 'people': return b.people.map(p => `- ${p.name}${p.sub ? ` (${p.sub})` : ''}`).join('\n') + (b.more ? `\n${plain(b.more)}` : '');
    case 'stats': return b.items.map(s => `${s.value} ${s.label}`).join('\n');
    case 'divider': return '---';
    case 'badge': return `[${b.text}]`;
    case 'facts': return b.rows.map(r => `${r.k}: ${r.v}`).join('\n');
    case 'quote': return b.text;
  }
}

/**
 * `footer`: plain-text lines that replace the customer footer ("a service email about your Tablamigo account" and the
 * support line) on emails that are not to a customer: the owner's alerts, admin copies, a reply to a form someone sent.
 */
export type RenderOpts = { unsubscribeUrl: string | null; footer?: string[] };

export function render(e: Email, o: RenderOpts): Rendered {
  const reason = e.category === 'transactional'
    ? 'This is a service email about your Tablamigo account.'
    : `You're getting this because you have a Tablamigo account.`;
  const unsub = o.unsubscribeUrl ? ` <a href="${esc(o.unsubscribeUrl)}" style="color:${BRAND.muted};text-decoration:underline">Unsubscribe</a>` : '';
  const support = config.supportEmail;
  const custom = o.footer?.filter(Boolean);
  // The filler stops mail clients pulling body text into the inbox preview after the preheader.
  const filler = '&#847;&zwnj;&nbsp;'.repeat(60);
  const html = `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no,address=no,email=no,date=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escText(e.subject)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style>
  body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
  table,td{mso-table-lspace:0;mso-table-rspace:0}
  img{-ms-interpolation-mode:bicubic;border:0;outline:none;text-decoration:none}
  body{margin:0!important;padding:0!important;width:100%!important}
  a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important}
  @media only screen and (max-width:620px){
    .wrap{padding:16px 8px!important}
    .card-pad{padding:28px 22px!important}
    h1{font-size:22px!important;line-height:30px!important}
  }
  @media (prefers-color-scheme:dark){
    .bg{background:#141413!important}
    .card{background:#1E1E1C!important;border-color:#2E2E2B!important}
    .panel{background:#262624!important}
    .t1,h1{color:#F3F3F0!important}
    .t2{color:#C9C9C3!important}
    .t3,.foot,.foot a{color:#9D9D96!important}
    .line{border-color:#33332F!important}
    .eyebrow,.num{color:#3FD1BD!important}
  }
  [data-ogsc] .t1,[data-ogsc] h1{color:#F3F3F0!important}
  [data-ogsc] .t2{color:#C9C9C3!important}
  [data-ogsc] .t3,[data-ogsc] .foot{color:#9D9D96!important}
  [data-ogsb] .bg{background:#141413!important}
  [data-ogsb] .card{background:#1E1E1C!important}
</style>
</head>
<body class="bg" style="margin:0;padding:0;background:${BRAND.bg};font-family:${FONT}">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">${escText(e.preheader)}${filler}</div>
<table role="presentation" class="bg" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BRAND.bg}" style="background:${BRAND.bg}">
<tr><td align="center" class="wrap" style="padding:40px 16px">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;font-family:${FONT}">
<tr><td style="padding:0 4px 20px">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td valign="middle" style="padding-right:10px"><img src="${LOGO}" width="32" height="32" alt="Tablamigo" style="display:block;width:32px;height:32px;border-radius:8px"></td>
    <td valign="middle" class="t1" style="font-size:18px;line-height:24px;font-weight:700;color:${BRAND.ink};letter-spacing:-.01em">Tablamigo</td>
  </tr></table>
</td></tr>
<tr><td class="card card-pad" bgcolor="${BRAND.card}" style="background:${BRAND.card};border:1px solid ${BRAND.border};border-radius:14px;padding:40px 44px">
${e.blocks.map(blockHtml).join('\n')}
</td></tr>
<tr><td class="foot" style="padding:24px 4px 0;font-size:12px;line-height:19px;color:${BRAND.muted}">
${custom?.length ? custom.map(l => `  <p class="foot" style="margin:0 0 8px;color:${BRAND.muted}">${esc(l)}</p>\n`).join('') : `  <p class="foot" style="margin:0 0 8px;color:${BRAND.muted}">${reason}${unsub}</p>
  <p class="foot" style="margin:0 0 8px;color:${BRAND.muted}">Questions? Reply to this email or write to <a href="mailto:${support}" style="color:${BRAND.muted};text-decoration:underline">${support}</a>.</p>
`}  <p class="foot" style="margin:0;color:${BRAND.muted}">${esc(FOOTER_ORG)}</p>
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
  const text = [
    ...e.blocks.map(blockText),
    '--',
    ...(custom?.length ? custom : [
      reason + (o.unsubscribeUrl ? `\nUnsubscribe: ${o.unsubscribeUrl}` : ''),
      `Questions? Reply to this email or write to ${support}.`,
    ]),
    FOOTER_ORG,
  ].join('\n\n') + '\n';
  return { subject: e.subject, html, text };
}
