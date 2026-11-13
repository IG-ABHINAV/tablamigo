import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '../lib/db.js';
import { sendMail } from '../lib/mail.js';
import { requireAdmin } from '../lib/admin.js';
import { notFound } from '../lib/errors.js';
import { config } from '../lib/config.js';
import { partnerLeadEmail, partnerConfirmationEmail } from '../lib/owner-alerts.js';

// The subject is plain text built from the form: line breaks and other control characters would let a visitor start a new
// header line with a mail transport that writes headers itself, so they become spaces.
const oneLine = (v: string) => v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();

export default async function partnerships(app: FastifyInstance) {
  // Public endpoint for submitting partnership / local ads inquiry. It emails the address the visitor typed, so it
  // is rate limited per IP, and a hidden `website` field (the honeypot on the website's form) drops bots quietly.
  app.post('/partnerships', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async req => {
    const b = z.object({
      businessName: z.string().trim().min(2).max(120),
      contactName: z.string().trim().min(2).max(100),
      email: z.string().trim().email().toLowerCase(),
      businessType: z.string().trim().min(2).max(60),
      city: z.string().trim().min(2).max(100),
      country: z.string().trim().max(80).optional(),
      budget: z.string().trim().max(100).optional(),
      message: z.string().trim().min(5).max(3000),
      website: z.string().max(500).optional(),
    }).parse(req.body);
    // A person never sees the field, so anything in it means a bot: answer as if it worked, store and send nothing.
    if (b.website?.trim()) return { ok: true };

    const [lead] = await sql`
      insert into partner_leads (
        business_name, contact_name, business_type, email, city, country, budget, message, status
      )
      values (
        ${b.businessName}, ${b.contactName}, ${b.businessType}, ${b.email},
        ${b.city}, ${b.country ?? ''}, ${b.budget ?? ''}, ${b.message}, 'new'
      )
      returning id, created_at
    `;

    // The alert goes to the admins (ADMIN_EMAILS); with none configured the lead is still saved, just nobody is mailed.
    // Non-blocking. Everything the visitor typed is escaped by the layout's facts/quote blocks.
    const alert = partnerLeadEmail(b, { id: lead.id, at: new Date(lead.createdAt ?? Date.now()) });
    for (const to of config.adminEmails) {
      sendMail({ to, subject: oneLine(alert.subject), text: alert.text, html: alert.html, replyTo: b.email })
        .catch(err => console.error('Failed to notify partner lead:', err));
    }

    // Confirmation to the address the visitor typed. Nobody has verified that address, so the email carries none of
    // the visitor's words (subject included): the form can't be used to send someone else a message of its choosing.
    const conf = partnerConfirmationEmail();
    sendMail({ to: b.email, subject: conf.subject, text: conf.text, html: conf.html })
      .catch(err => console.error('Failed to send partner confirmation:', err));

    return { ok: true, leadId: lead.id };
  });

  // Admin: View all partner leads
  app.get('/admin/partner-leads', async req => {
    await requireAdmin(req);
    const leads = await sql`
      select id, business_name, contact_name, business_type, email, city, country, budget, message, status, created_at
      from partner_leads
      order by created_at desc
      limit 200
    `;
    return { ok: true, leads };
  });

  // Admin: Update lead status
  app.post('/admin/partner-leads/:id/status', async req => {
    await requireAdmin(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { status } = z.object({ status: z.enum(['new', 'contacted', 'active', 'declined']) }).parse(req.body);
    const [lead] = await sql`
      update partner_leads set status = ${status} where id = ${id} returning id, status
    `;
    if (!lead) throw notFound('lead_not_found');
    return { ok: true, lead };
  });

  // Public/App: Fetch active sponsored ads for current city or global
  app.get('/ads/active', async req => {
    const q = z.object({ city: z.string().optional() }).parse(req.query);
    // No ads while everything in Tablamigo is free (config.allFree); the sponsored_ads rows stay for later.
    if (config.allFree) return { ok: true, ads: [] };
    const ads = await sql`
      select id, title, subtitle, emoji, badge_text, cta_text, target_url, image_url, city, lat, lng, category
      from sponsored_ads
      where active = true and starts_at <= now() and ends_at >= now()
        and (${q.city ? sql`city ilike ${q.city} or city = 'GLOBAL'` : sql`true`})
      order by random()
      limit 5
    `;
    return { ok: true, ads };
  });
}
