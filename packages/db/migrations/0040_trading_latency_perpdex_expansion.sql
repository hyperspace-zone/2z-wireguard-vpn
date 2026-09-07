-- Add public mainnet APIs, not the venues' frontend/CDN home pages.
-- Upgrade the independent trading probe agent and its explicit host allowlist
-- before applying this migration: Variational's stats response exceeds 64 KiB.
-- These are cold-connection public API probes, not order execution benchmarks.
INSERT INTO trading_probe_targets (
  target_key, category, display_name, product, protocol, scheme, hostname, path,
  request_method, request_headers, request_body, expected_body_contains,
  response_kind, interval_seconds, timeout_ms, sample_count, enabled, sort_order,
  official_documentation_url, metadata
) VALUES
  (
    'variational-omni-stats', 'variational', 'Variational Omni', 'Perpetuals', 'http_json', 'https',
    'omni-client-api.prod.ap-northeast-1.variational.io', '/metadata/stats', 'GET',
    '{"accept":"application/json","cache-control":"no-cache"}', NULL,
    '"listings"', 'json_object', 60, 5000, 3, true, 21,
    'https://docs.variational.io/technical-documentation/api',
    '{"measurement":"Public statistics API RTT (cold HTTPS; not execution latency)","venueKey":"variational","venueType":"perpdex","endpointRole":"public_statistics","readOnly":true}'
  ),
  (
    'extended-perpetuals-rest', 'extended', 'Extended', 'Perpetuals', 'http_json', 'https',
    'api.starknet.extended.exchange', '/api/v1/info/markets?market=BTC-USD', 'GET',
    '{"accept":"application/json","cache-control":"no-cache"}', NULL,
    '"BTC-USD"', 'json_object', 60, 5000, 3, true, 22,
    'https://api.docs.extended.exchange/#get-markets',
    '{"measurement":"Public market API RTT (cold HTTPS; not execution latency)","venueKey":"extended","venueType":"perpdex","endpointRole":"public_market_metadata","market":"BTC-USD","readOnly":true}'
  ),
  (
    'rise-perpetuals-rest', 'rise', 'RISEx', 'Perpetuals', 'http_json', 'https',
    'api.rise.trade', '/v1/markets', 'GET',
    '{"accept":"application/json","cache-control":"no-cache"}', NULL,
    '"markets"', 'json_object', 60, 5000, 3, true, 23,
    'https://developer.rise.trade/reference/marketservice_getmarkets',
    '{"measurement":"Public market configuration API RTT (cold HTTPS; not execution latency)","venueKey":"rise","venueType":"perpdex","endpointRole":"public_market_metadata","serverCacheSeconds":300,"readOnly":true}'
  ),
  (
    'lighter-perpetuals-rest', 'lighter', 'Lighter', 'Perpetuals', 'http_json', 'https',
    'mainnet.zklighter.elliot.ai', '/api/v1/orderBookDetails?market_id=1', 'GET',
    '{"accept":"application/json","cache-control":"no-cache"}', NULL,
    '"order_book_details"', 'json_object', 60, 5000, 3, true, 24,
    'https://apidocs.lighter.xyz/reference/orderbookdetails',
    '{"measurement":"Public order-book metadata API RTT (cold HTTPS; not execution latency)","venueKey":"lighter","venueType":"perpdex","endpointRole":"public_market_metadata","marketId":1,"readOnly":true}'
  )
ON CONFLICT (target_key) DO UPDATE SET
  revision = trading_probe_targets.revision + 1,
  category = EXCLUDED.category,
  display_name = EXCLUDED.display_name,
  product = EXCLUDED.product,
  protocol = EXCLUDED.protocol,
  scheme = EXCLUDED.scheme,
  hostname = EXCLUDED.hostname,
  path = EXCLUDED.path,
  request_method = EXCLUDED.request_method,
  request_headers = EXCLUDED.request_headers,
  request_body = EXCLUDED.request_body,
  expected_body_contains = EXCLUDED.expected_body_contains,
  response_kind = EXCLUDED.response_kind,
  interval_seconds = EXCLUDED.interval_seconds,
  timeout_ms = EXCLUDED.timeout_ms,
  sample_count = EXCLUDED.sample_count,
  enabled = EXCLUDED.enabled,
  sort_order = EXCLUDED.sort_order,
  official_documentation_url = EXCLUDED.official_documentation_url,
  metadata = EXCLUDED.metadata,
  updated_at = now();
