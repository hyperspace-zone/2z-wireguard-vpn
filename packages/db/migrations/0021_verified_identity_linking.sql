ALTER TABLE users
  ADD COLUMN IF NOT EXISTS avatar_url text;

INSERT INTO identities (
  account_id,
  provider,
  provider_subject,
  email,
  metadata,
  verified_at,
  last_seen_at
)
SELECT
  users.account_id,
  'email',
  users.email::text,
  users.email,
  jsonb_build_object('login', 'password', 'verification', 'pending'),
  NULL,
  NULL
FROM users
JOIN password_credentials ON password_credentials.user_id = users.id
ON CONFLICT (provider, provider_subject) DO NOTHING;

WITH google_profiles AS (
  SELECT DISTINCT ON (account_id)
    account_id,
    NULLIF(metadata->>'name', '') AS display_name,
    NULLIF(metadata->>'picture', '') AS avatar_url
  FROM identities
  WHERE provider = 'google'
  ORDER BY account_id, last_seen_at DESC NULLS LAST, created_at DESC
)
UPDATE users
SET display_name = CASE
      WHEN users.display_name = users.email::text
        THEN COALESCE(google_profiles.display_name, users.display_name)
      ELSE users.display_name
    END,
    avatar_url = COALESCE(users.avatar_url, google_profiles.avatar_url),
    updated_at = now()
FROM google_profiles
WHERE google_profiles.account_id = users.account_id
  AND (
    (users.display_name = users.email::text AND google_profiles.display_name IS NOT NULL)
    OR (users.avatar_url IS NULL AND google_profiles.avatar_url IS NOT NULL)
  );
