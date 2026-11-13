-- Support tickets and the admin panel's Tickets tab (routes/support.ts).
-- Today every ticket comes from an in-app report (POST /reports); `source` leaves room for a
-- contact form later. Customer replies to support@ are not captured here: they land in that inbox,
-- with the TM- ref in the subject.
CREATE TABLE support_tickets (
  id          uuid PRIMARY KEY,
  ref         text NOT NULL UNIQUE,            -- 'TM-7K2Q', shown to the customer
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  email       text NOT NULL,                   -- where replies go; kept if the account is deleted
  subject     text NOT NULL,
  body        text NOT NULL,
  source      text NOT NULL DEFAULT 'report' CHECK (source IN ('report','contact')),
  report_id   uuid REFERENCES reports(id) ON DELETE SET NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  answered_at timestamptz,                     -- last admin reply
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_tickets_status_idx ON support_tickets (status, created_at DESC);
CREATE INDEX support_tickets_user_idx ON support_tickets (user_id, created_at DESC);

CREATE TABLE support_replies (
  id          bigserial PRIMARY KEY,
  ticket_id   uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  admin_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  body        text NOT NULL,
  email_status text NOT NULL,                  -- deliver() outcome: sent, failed, ...
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_replies_ticket_idx ON support_replies (ticket_id, created_at);
