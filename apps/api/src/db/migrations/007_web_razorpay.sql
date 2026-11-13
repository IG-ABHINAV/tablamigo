-- Web app: browser push subscriptions sit in push_tokens as the PushSubscription JSON (platform 'web').
ALTER TABLE push_tokens ADD CONSTRAINT push_tokens_platform_check CHECK (platform IN ('android','ios','web'));

-- Razorpay subscriptions (web checkout) sit next to Google Play ones, token 'rzp:<subscription id>'.
ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_platform_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_platform_check CHECK (platform IN ('google','apple','razorpay'));
-- Set when the user cancels from the web app; Razorpay keeps the sub active until the cycle ends.
ALTER TABLE subscriptions ADD COLUMN cancel_requested_at timestamptz;
