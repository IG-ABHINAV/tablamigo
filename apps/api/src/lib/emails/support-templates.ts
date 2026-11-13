/**
 * Support ticket emails. Kept apart from templates.ts so the ticket work merges cleanly.
 * Same block layout (layout.ts) and copy rules: short, no fake SLA, a person replies.
 */
import type { Email } from './layout.js';
import { firstName } from './templates.js';

export const REPORT_REASONS: Record<string, string> = {
  harassment: 'Harassment', spam: 'Spam', fake_profile: 'Fake profile', inappropriate: 'Inappropriate content',
  unsafe: 'Safety concern', underage: 'Possibly under 18', other: 'Something else',
};
const TARGETS: Record<string, string> = {
  user: 'a profile', activity: 'a plan', message: 'a message', moment: 'a travel moment', moment_comment: 'a comment',
  plan_comment: 'a comment', city_tip: 'a city tip', circle_proposal: 'a meetup idea',
};

/** Same subject on every email about a ticket, so mail clients thread them. */
export const ticketSubject = (ref: string) => `Your report to Tablamigo [${ref}]`;

/** To the person who reported, right after POST /reports. */
export function reportReceived(d: { name?: string | null; ref: string; reason: string; targetType: string }): Email {
  return {
    subject: ticketSubject(d.ref), category: 'transactional',
    preheader: `Your reference is ${d.ref}. A person on the team reviews every report.`,
    blocks: [
      { t: 'h1', text: `Thanks for telling us, ${firstName(d.name)}` },
      { t: 'p', text: `We got your report about ${TARGETS[d.targetType] ?? 'something in Tablamigo'}. A person on the team reviews every report.` },
      { t: 'rows', rows: [['Reference', `**${d.ref}**`], ['Reason', REPORT_REASONS[d.reason] ?? d.reason]] },
      { t: 'p', text: 'If we need more detail, we will reply to this email. To add something yourself, reply here and keep the reference in the subject.' },
      { t: 'small', text: 'We may not be able to tell you what action we take on another person\'s account. If anyone is in immediate danger, contact local police first.' },
    ],
  };
}

/** An admin's reply from the Tickets tab. */
export function ticketReply(d: { name?: string | null; ref: string; reply: string; original: string }): Email {
  const quote = d.original.length > 600 ? d.original.slice(0, 600) + '…' : d.original;
  return {
    subject: `Re: ${ticketSubject(d.ref)}`, category: 'transactional',
    preheader: d.reply.replace(/\s+/g, ' ').slice(0, 110),
    blocks: [
      { t: 'p', text: `Hi ${firstName(d.name)},` },
      ...d.reply.split(/\n{2,}/).map(p => ({ t: 'p' as const, text: p.replace(/\s*\n\s*/g, ' ') })),
      { t: 'p', text: 'The Tablamigo team' },
      { t: 'divider' },
      { t: 'small', text: `Reply to this email to continue. Reference **${d.ref}**.` },
      { t: 'small', text: `You wrote: ${quote}` },
    ],
  };
}

/** Internal copy to SUPPORT_EMAIL. */
export function ticketInternal(d: { ref: string; subject: string; body: string; email: string; name?: string | null; about?: string; adminUrl: string }): Email {
  return {
    subject: `[${d.ref}] ${d.subject}`, category: 'transactional',
    preheader: `${d.name || d.email}: ${d.body.slice(0, 90)}`,
    blocks: [
      { t: 'eyebrow', text: 'New ticket' },
      { t: 'h1', text: d.subject },
      { t: 'rows', rows: [['Ticket', d.ref], ['From', `${d.name || '(no name)'} · ${d.email}`], ...(d.about ? [['About', d.about] as [string, string]] : [])] },
      // The customer's own words: shown as typed, never parsed for **bold** or [links](…).
      { t: 'quote', text: d.body || '(no details)' },
      { t: 'button', label: 'Open in admin', url: d.adminUrl },
    ],
  };
}
