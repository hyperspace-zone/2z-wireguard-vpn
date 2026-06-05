CREATE TABLE address_pools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  cidr cidr NOT NULL,
  family integer NOT NULL CHECK (family IN (4, 6)),
  purpose text NOT NULL DEFAULT 'wireguard_client',
  enabled boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 100,
  next_offset bigint NOT NULL DEFAULT 1 CHECK (next_offset >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX address_pools_allocator_idx
  ON address_pools (purpose, family, enabled, priority, name);

CREATE TABLE client_address_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id uuid NOT NULL REFERENCES address_pools(id),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  client_address inet NOT NULL,
  allocated_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  release_reason text,
  CHECK (family(client_address) = 4)
);

CREATE UNIQUE INDEX client_address_leases_active_address_idx
  ON client_address_leases (client_address)
  WHERE released_at IS NULL;

CREATE UNIQUE INDEX client_address_leases_active_session_idx
  ON client_address_leases (session_id)
  WHERE released_at IS NULL;

CREATE INDEX client_address_leases_session_idx
  ON client_address_leases (session_id, allocated_at DESC);

CREATE INDEX client_address_leases_pool_active_idx
  ON client_address_leases (pool_id, client_address)
  WHERE released_at IS NULL;

INSERT INTO address_pools (name, cidr, family, purpose, priority)
VALUES ('wireguard-client-default', '10.64.0.0/10', 4, 'wireguard_client', 100)
ON CONFLICT (name) DO UPDATE
SET cidr = EXCLUDED.cidr,
    family = EXCLUDED.family,
    purpose = EXCLUDED.purpose,
    priority = EXCLUDED.priority,
    enabled = true,
    updated_at = now();

INSERT INTO client_address_leases (pool_id, session_id, client_address)
SELECT
  address_pools.id,
  sessions.id,
  (rendered_plans.public_material->>'clientAddress')::inet
FROM sessions
JOIN session_status ON session_status.session_id = sessions.id
JOIN rendered_plans
  ON rendered_plans.session_id = sessions.id
 AND rendered_plans.generation = sessions.generation
JOIN address_pools
  ON address_pools.name = 'wireguard-client-default'
WHERE session_status.phase <> 'revoked'
  AND rendered_plans.public_material ? 'clientAddress'
ON CONFLICT DO NOTHING;
