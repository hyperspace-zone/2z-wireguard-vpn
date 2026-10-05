-- Keep provider outage evidence across API restarts; this is a single global state row,
-- not an additional history table. Restarting must not resolve a real sign-in outage.
ALTER TABLE email_auth_send_limits
  ADD COLUMN last_delivery_status text CHECK (last_delivery_status IN ('sent', 'failed')),
  ADD COLUMN last_provider_error text,
  ADD COLUMN last_delivery_at timestamptz;
