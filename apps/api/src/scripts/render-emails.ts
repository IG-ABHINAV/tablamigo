/**
 * Renders every customer email with sample data to HTML + plain-text files for review.
 *   npx tsx src/scripts/render-emails.ts [outDir]     (default: ./email-previews)
 * Touches no database and sends nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { render, type Email } from '../lib/emails/layout.js';
import * as T from '../lib/emails/templates.js';
import * as S from '../lib/emails/support-templates.js';

const out = path.resolve(process.argv[2] ?? 'email-previews');
fs.mkdirSync(out, { recursive: true });

const day = 86400_000, now = Date.now();
// Sample faces are inline SVGs so previews need no network and show no real person.
const face = (bg: string, fg: string) => 'data:image/svg+xml;base64,' + Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="${bg}"/><circle cx="48" cy="38" r="18" fill="${fg}"/><rect x="18" y="62" width="60" height="40" rx="30" fill="${fg}"/></svg>`).toString('base64');
const unsub = 'https://tablamigo-api.hookstep.in/email/unsubscribe?t=sample';

const samples: [string, Email][] = [
  ['01-login-code', T.loginCode({ code: '482913' })],
  ['02-welcome', T.welcome({ name: 'Maya Fernandes' })],
  ['02a-activation-verify-1', T.verifyNudge({ name: 'Maya', second: false, hinglish: true })],
  ['02b-activation-verify-2', T.verifyNudge({ name: 'Maya', second: true })],
  ['02c-activation-plan', T.planNudge({ name: 'Maya', trip: { city: 'Goa' }, scope: 'trip_dates', plans: [{ id: 'p1', title: 'Sunset at Vagator', emoji: '🌅', placeName: 'Vagator Beach', city: 'Goa', going: 3, day: '2026-10-18' }] })],
  ['02d-activation-plan-empty', T.planNudge({ name: 'Maya', trip: null, scope: null, plans: [] })],
  ['02e-activation-trip', T.tripNudge({ name: 'Maya', hinglish: true })],
  ['03-plus-started-razorpay', T.plusStarted({ name: 'Maya', kind: 'subscription', platform: 'razorpay', period: 'monthly', amount: '₹499', orderId: 'sub_R8kq2mYp1xTz9L', startedAt: new Date(now), until: new Date(now + 30 * day) })],
  ['04-plus-started-google', T.plusStarted({ name: 'Maya', kind: 'subscription', platform: 'google', period: 'weekly', amount: null, orderId: 'GPA.3345-1180-2210-54321', startedAt: new Date(now), until: new Date(now + 7 * day) })],
  ['05-trip-pass-receipt', T.plusStarted({ name: 'Maya', kind: 'pass', platform: 'razorpay', amount: '₹299', orderId: 'pay_R8kr7dN2cQwE4v', startedAt: new Date(now), until: new Date(now + 14 * day) })],
  ['06-payment-failed', T.paymentProblem({ name: 'Maya', platform: 'razorpay', onHold: false, until: new Date(now + 2 * day) })],
  ['07-plus-on-hold', T.paymentProblem({ name: 'Maya', platform: 'google', onHold: true })],
  ['08-plus-ending-soon', T.plusEndingSoon({ name: 'Maya', until: new Date(now + 3 * day - 3600_000), source: 'subscription' })],
  ['09-plus-ended', T.plusEnded({ name: 'Maya', source: 'subscription' })],
  // The launch offer (Plus free for everyone until LAUNCH_PLUS_UNTIL) ending, for accounts whose only Plus is the offer.
  ['09a-launch-offer-ending', T.launchOfferEnding({ name: 'Maya', until: new Date(now + 3 * day - 3600_000), prices: { monthly: '₹499', yearly: '₹3,999' } })],
  ['09a-launch-offer-ended', T.launchOfferEnded({ name: 'Maya', prices: { monthly: '₹499', yearly: '₹3,999' } })],
  ['09b-plus-cancelled', T.plusCancelled({ name: 'Maya', period: 'monthly', until: new Date(now + 24 * day) })],
  ['09c-plus-cancelled-refunded', T.plusCancelled({ name: 'Maya', period: 'monthly', until: null, endedAt: new Date(now) })],
  ['09d-refund-plus', T.refundIssued({ name: 'Maya', amount: '₹499', refundId: 'rfnd_R8kq2mYp1xTz9L', paymentId: 'pay_R8kp1cN2cQwE4v', refundedAt: new Date(now), what: 'subscription', period: 'monthly', plus: 'ended' })],
  ['09e-refund-trip-pass', T.refundIssued({ name: 'Maya', amount: '₹299', refundId: 'rfnd_R8kq2mYp1xTz9M', paymentId: 'pay_R8kr7dN2cQwE4v', refundedAt: new Date(now), what: 'pass', plus: 'ended' })],
  ['10-trip-pass-expiring', T.passExpiring({ name: 'Maya', until: new Date(now + 2 * day - 3600_000) })],
  ['11-verification-approved', T.verification({ name: 'Maya', approved: true })],
  ['12-verification-rejected', T.verification({ name: 'Maya', approved: false, reason: "Your selfie didn't match your profile photo closely enough. Try better light, no sunglasses or mask, or use a clearer profile photo." })],
  ['13-plan-joined-one', T.planJoined({ name: 'Maya', plan: { id: '00000000-0000-0000-0000-000000000001', title: 'Sunset drinks on the river', placeName: 'Chao Phraya pier' }, joiners: [{ name: 'Lucas', photoUrl: face('#FFE3DB', '#FF8A6E'), sub: 'Brazil' }], total: 2 })],
  ['14-plan-joined-batch', T.planJoined({ name: 'Maya', plan: { id: '00000000-0000-0000-0000-000000000001', title: 'Street food walk in Yaowarat', placeName: 'Yaowarat Road' }, joiners: [
    { name: 'Lucas', photoUrl: face('#FFE3DB', '#FF8A6E'), sub: 'Brazil' }, { name: 'Aiko', photoUrl: face('#DDF5F1', '#3FBFAE'), sub: 'Japan' }, { name: 'Sam', sub: 'United Kingdom' }, { name: 'Priya' }], total: 5 })],
  ['15-weekly-digest', T.weeklyDigest({ name: 'Maya', trip: { id: '00000000-0000-0000-0000-000000000002', city: 'Lisbon', startDate: '2026-10-08', endDate: '2026-10-15' }, travelers: 12, plans: 4, faces: [
    { name: 'Lucas', photoUrl: face('#FFE3DB', '#FF8A6E'), sub: '29 · Brazil' }, { name: 'Aiko', photoUrl: face('#DDF5F1', '#3FBFAE'), sub: '26 · Japan' }, { name: 'Sam', sub: '33 · United Kingdom' }] })],
  // Deletion cancels a web (Razorpay) subscription itself (routes/me.ts); 17 is the fallback when that call failed.
  ['16-account-deleted', T.accountDeleted({ name: 'Maya', deletedAt: new Date(now), googleSub: false, webSub: false, webCancelled: true })],
  ['17-account-deleted-cancel-failed', T.accountDeleted({ name: 'Maya', deletedAt: new Date(now), googleSub: false, webSub: true, webCancelled: false })],
  ['17-report-received', S.reportReceived({ name: 'Maya Fernandes', ref: 'TM-7K2Q', reason: 'harassment', targetType: 'user' })],
  ['18-ticket-reply', S.ticketReply({ name: 'Maya Fernandes', ref: 'TM-7K2Q', reply: 'Thanks for telling us, and sorry this happened. We have removed his account and he can no longer message you.\n\nIf anything else comes up, reply to this email.', original: 'He kept messaging me after I said no, and asked for my hotel name.' })],
  ['19-ticket-internal', S.ticketInternal({ ref: 'TM-7K2Q', subject: 'Report: Harassment (user)', body: 'He kept messaging me after I said no, and asked for my hotel name.', email: 'maya@example.com', name: 'Maya Fernandes', about: 'user 5f0c2b1e-0000-4000-8000-000000000001', adminUrl: 'https://tablamigo.hookstep.in/admin#tickets?id=sample' })],
];

const index: string[] = [];
for (const [name, e] of samples) {
  const r = render(e, { unsubscribeUrl: e.category === 'transactional' ? null : unsub });
  fs.writeFileSync(path.join(out, `${name}.html`), r.html);
  fs.writeFileSync(path.join(out, `${name}.txt`), `Subject: ${r.subject}\nPreheader: ${e.preheader}\n\n${r.text}`);
  index.push(`<li><a href="${name}.html">${name}</a> · ${r.subject.replace(/</g, '&lt;')} <small>(${r.subject.length} chars, ${e.category})</small> · <a href="${name}.txt">text</a></li>`);
  console.log(`${name.padEnd(28)} ${String(r.subject.length).padStart(2)}  ${r.subject}`);
}
fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Tablamigo emails</title><body style="font:15px/1.7 system-ui;margin:32px"><h1>Tablamigo emails</h1><ol>${index.join('')}</ol>`);
console.log(`\n${samples.length} emails -> ${out}`);
