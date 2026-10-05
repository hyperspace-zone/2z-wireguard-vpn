-- Small durable quota state: only human-verified admitted send attempts create rows.
CREATE TABLE email_auth_send_limits (
  key text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  send_count integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz NOT NULL,
  blocked_until timestamptz
);
