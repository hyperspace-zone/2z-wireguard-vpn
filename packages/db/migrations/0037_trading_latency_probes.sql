CREATE TABLE trading_probe_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  generation bigint NOT NULL DEFAULT 1,
  desired_state text NOT NULL DEFAULT 'Maintenance'
    CHECK (desired_state IN ('Enabled', 'Maintenance', 'Disabled')),
  placement_kind text NOT NULL DEFAULT 'gate_host'
    CHECK (placement_kind IN ('gate_host', 'testnode', 'dedicated')),
  gate_id uuid REFERENCES gates(id) ON DELETE SET NULL,
  city text NOT NULL,
  country text NOT NULL,
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  provider text NOT NULL DEFAULT '',
  region_code text NOT NULL DEFAULT '',
  spec jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE trading_probe_auth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  probe_node_id uuid NOT NULL REFERENCES trading_probe_nodes(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  UNIQUE (probe_node_id, token_hash)
);

CREATE INDEX trading_probe_auth_tokens_active_idx
  ON trading_probe_auth_tokens (probe_node_id, token_hash)
  WHERE revoked_at IS NULL;

CREATE TABLE trading_probe_node_status (
  probe_node_id uuid PRIMARY KEY REFERENCES trading_probe_nodes(id) ON DELETE CASCADE,
  observed_generation bigint NOT NULL DEFAULT 0,
  boot_id text,
  agent_version text,
  agent_revision text,
  agent_built_at timestamptz,
  agent_artifact_sha256 text,
  agent_installed_at timestamptz,
  observed_endpoint text,
  observed_capabilities text[] NOT NULL DEFAULT '{}',
  active_network_profiles text[] NOT NULL DEFAULT ARRAY['direct']::text[],
  last_report_at timestamptz,
  spool_depth integer NOT NULL DEFAULT 0,
  last_self_test jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE trading_probe_leases (
  probe_node_id uuid PRIMARY KEY REFERENCES trading_probe_nodes(id) ON DELETE CASCADE,
  lease_owner text NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE trading_probe_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_key text NOT NULL UNIQUE,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  category text NOT NULL,
  display_name text NOT NULL,
  product text NOT NULL DEFAULT '',
  protocol text NOT NULL CHECK (protocol IN ('http_json', 'websocket', 'tcp_tls', 'json_rpc')),
  scheme text NOT NULL CHECK (scheme IN ('https', 'wss', 'tls')),
  hostname text NOT NULL,
  port integer NOT NULL DEFAULT 443 CHECK (port BETWEEN 1 AND 65535),
  path text NOT NULL DEFAULT '/',
  request_method text NOT NULL DEFAULT 'GET' CHECK (request_method IN ('GET', 'POST')),
  request_headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_body jsonb,
  expected_status integer NOT NULL DEFAULT 200 CHECK (expected_status BETWEEN 100 AND 599),
  expected_body_contains text,
  response_kind text NOT NULL DEFAULT 'json_object'
    CHECK (response_kind IN ('json_object', 'json_array', 'json_number', 'any')),
  interval_seconds integer NOT NULL DEFAULT 30 CHECK (interval_seconds BETWEEN 5 AND 86400),
  timeout_ms integer NOT NULL DEFAULT 5000 CHECK (timeout_ms BETWEEN 250 AND 30000),
  sample_count integer NOT NULL DEFAULT 3 CHECK (sample_count BETWEEN 1 AND 20),
  enabled boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 100,
  official_documentation_url text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE trading_probe_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  probe_node_id uuid NOT NULL REFERENCES trading_probe_nodes(id) ON DELETE CASCADE,
  target_id uuid NOT NULL REFERENCES trading_probe_targets(id) ON DELETE CASCADE,
  target_revision integer NOT NULL,
  network_profile text NOT NULL DEFAULT 'direct',
  phase text NOT NULL DEFAULT 'queued'
    CHECK (phase IN ('queued', 'leased', 'succeeded', 'failed', 'dead')),
  payload jsonb NOT NULL,
  lease_owner text,
  lease_expires_at timestamptz,
  run_after timestamptz NOT NULL DEFAULT now(),
  retry_count integer NOT NULL DEFAULT 0,
  max_retries integer NOT NULL DEFAULT 3,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX trading_probe_jobs_claim_idx
  ON trading_probe_jobs (probe_node_id, phase, run_after, lease_expires_at);

CREATE UNIQUE INDEX trading_probe_jobs_one_active_target_idx
  ON trading_probe_jobs (probe_node_id, target_id, network_profile)
  WHERE phase IN ('queued', 'leased');

CREATE TABLE trading_probe_job_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES trading_probe_jobs(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL,
  lease_owner text NOT NULL,
  leased_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  status text CHECK (status IN ('succeeded', 'failed', 'retryable')),
  error_code text,
  result_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (job_id, attempt_number)
);

CREATE TABLE trading_latency_latest (
  probe_node_id uuid NOT NULL REFERENCES trading_probe_nodes(id) ON DELETE CASCADE,
  target_id uuid NOT NULL REFERENCES trading_probe_targets(id) ON DELETE CASCADE,
  network_profile text NOT NULL DEFAULT 'direct',
  target_revision integer NOT NULL,
  status text NOT NULL CHECK (status IN ('succeeded', 'failed')),
  measured_at timestamptz NOT NULL,
  dns_ms double precision,
  tcp_ms double precision,
  tls_ms double precision,
  ttfb_ms double precision,
  total_p50_ms double precision,
  total_p95_ms double precision,
  total_min_ms double precision,
  total_max_ms double precision,
  jitter_ms double precision,
  sample_count integer NOT NULL DEFAULT 0,
  failure_count integer NOT NULL DEFAULT 0,
  http_status integer,
  response_class text,
  resolved_ip text,
  error_code text,
  error_message text,
  agent_version text,
  agent_revision text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (probe_node_id, target_id, network_profile)
);

CREATE INDEX trading_latency_latest_target_idx
  ON trading_latency_latest (target_id, network_profile, measured_at DESC);

CREATE TABLE trading_latency_rollups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  probe_node_id uuid NOT NULL REFERENCES trading_probe_nodes(id) ON DELETE CASCADE,
  target_id uuid NOT NULL REFERENCES trading_probe_targets(id) ON DELETE CASCADE,
  network_profile text NOT NULL DEFAULT 'direct',
  target_revision integer NOT NULL,
  bucket_start timestamptz NOT NULL,
  bucket_end timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('succeeded', 'failed')),
  total_min_ms double precision,
  total_p50_ms double precision,
  total_p95_ms double precision,
  total_max_ms double precision,
  jitter_ms double precision,
  sample_count integer NOT NULL DEFAULT 0,
  failure_count integer NOT NULL DEFAULT 0,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (probe_node_id, target_id, network_profile, bucket_start)
);

CREATE INDEX trading_latency_rollups_history_idx
  ON trading_latency_rollups (target_id, network_profile, bucket_start DESC);

INSERT INTO trading_probe_targets (
  target_key, category, display_name, product, protocol, scheme, hostname, path,
  request_method, request_headers, request_body, expected_body_contains,
  response_kind, enabled, sort_order, official_documentation_url, metadata
) VALUES
  (
    'binance-spot-rest', 'cex', 'Binance', 'Spot', 'http_json', 'https',
    'api.binance.com', '/api/v3/time', 'GET', '{"cache-control":"no-cache"}', NULL,
    'serverTime', 'json_object', true, 10,
    'https://developers.binance.com/docs/binance-spot-api-docs/rest-api/general-endpoints',
    '{"measurement":"REST TTFB and total RTT","cdnFronted":true}'
  ),
  (
    'kraken-spot-rest', 'cex', 'Kraken', 'Spot', 'http_json', 'https',
    'api.kraken.com', '/0/public/Time', 'GET', '{"cache-control":"no-cache"}', NULL,
    'unixtime', 'json_object', true, 20,
    'https://docs.kraken.com/api/docs/rest-api/get-server-time',
    '{"measurement":"REST TTFB and total RTT","cdnFronted":true}'
  ),
  (
    'hyperliquid-info', 'hyperliquid', 'Hyperliquid', 'Perpetuals', 'http_json', 'https',
    'api.hyperliquid.xyz', '/info', 'POST', '{"content-type":"application/json","cache-control":"no-cache"}',
    '{"type":"allMids"}', NULL, 'json_object', true, 30,
    'https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint',
    '{"measurement":"read-only application RTT","cdnFronted":true}'
  ),
  (
    'polymarket-clob-time', 'prediction-markets', 'Polymarket', 'CLOB', 'http_json', 'https',
    'clob.polymarket.com', '/time', 'GET', '{"cache-control":"no-cache"}', NULL,
    NULL, 'json_number', true, 40,
    'https://docs.polymarket.com/developers/CLOB/timeserver',
    '{"measurement":"REST TTFB and total RTT"}'
  ),
  (
    'kalshi-exchange-status', 'prediction-markets', 'Kalshi', 'Exchange', 'http_json', 'https',
    'api.elections.kalshi.com', '/trade-api/v2/exchange/status', 'GET', '{"cache-control":"no-cache"}', NULL,
    'exchange_active', 'json_object', true, 50,
    'https://docs.kalshi.com/api-reference/exchange/get-exchange-status',
    '{"measurement":"REST TTFB and total RTT"}'
  ),
  (
    'arbitrum-one-rpc', 'arbitrum', 'Arbitrum One', 'Public RPC', 'json_rpc', 'https',
    'arb1.arbitrum.io', '/rpc', 'POST', '{"content-type":"application/json","cache-control":"no-cache"}',
    '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}', '0xa4b1',
    'json_object', true, 60,
    'https://docs.arbitrum.io/build-decentralized-apps/reference/node-providers',
    '{"measurement":"read-only JSON-RPC response RTT","chainId":"42161","sequencerSubmission":false}'
  )
ON CONFLICT (target_key) DO NOTHING;
