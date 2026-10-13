CREATE TABLE session_config_grants (
  session_id uuid PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  granted_by_user_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL CHECK (reason = 'administrator'),
  included_bytes bigint NOT NULL CHECK (included_bytes > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
