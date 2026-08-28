-- Expand the CEX latency catalog to the complete venue set currently exposed
-- by the Glassnode latency dashboard. Every target is a public, read-only REST
-- endpoint and measures network/application RTT rather than order execution.
INSERT INTO trading_probe_targets (
  target_key, category, display_name, product, protocol, scheme, hostname, path,
  request_method, request_headers, request_body, expected_body_contains,
  response_kind, interval_seconds, timeout_ms, sample_count, enabled, sort_order,
  official_documentation_url, metadata
) VALUES
  (
    'bitget-spot-rest', 'cex', 'Bitget', 'Spot', 'http_json', 'https',
    'api.bitget.com', '/api/v2/public/time', 'GET',
    '{"accept":"application/json","cache-control":"no-cache"}', NULL,
    'serverTime', 'json_object', 30, 5000, 3, true, 11,
    'https://www.bitget.com/api-doc/classic/common/public/Get-Server-Time',
    '{"measurement":"REST TTFB and total RTT","readOnly":true}'
  ),
  (
    'bitstamp-spot-rest', 'cex', 'Bitstamp', 'Spot', 'http_json', 'https',
    'www.bitstamp.net', '/api/v2/ticker/btcusd/', 'GET',
    '{"accept":"application/json","cache-control":"no-cache"}', NULL,
    'timestamp', 'json_object', 30, 5000, 3, true, 12,
    'https://www.bitstamp.net/api/',
    '{"measurement":"REST TTFB and total RTT","market":"BTC/USD","readOnly":true}'
  ),
  (
    'bullish-spot-rest', 'cex', 'Bullish', 'Spot', 'http_json', 'https',
    'api.exchange.bullish.com', '/trading-api/v1/markets/BTCUSDC', 'GET',
    '{"accept":"application/json","cache-control":"no-cache"}', NULL,
    'BTCUSDC', 'json_object', 30, 5000, 3, true, 13,
    'https://github.com/bullish-exchange/api-docs',
    '{"measurement":"REST TTFB and total RTT","market":"BTC/USDC","readOnly":true}'
  ),
  (
    'bybit-spot-rest', 'cex', 'Bybit', 'Spot', 'http_json', 'https',
    'api.bybit.com', '/v5/market/time', 'GET',
    '{"accept":"application/json","cache-control":"no-cache"}', NULL,
    'retCode', 'json_object', 30, 5000, 3, true, 14,
    'https://bybit-exchange.github.io/docs/v5/market/time',
    '{"measurement":"REST TTFB and total RTT","readOnly":true}'
  ),
  (
    'coinbase-spot-rest', 'cex', 'Coinbase', 'Spot', 'http_json', 'https',
    'api.coinbase.com', '/v2/time', 'GET',
    '{"accept":"application/json","cache-control":"no-cache"}', NULL,
    'epoch', 'json_object', 30, 5000, 3, true, 15,
    'https://docs.cdp.coinbase.com/coinbase-business/track-apis/time',
    '{"measurement":"REST TTFB and total RTT","readOnly":true}'
  ),
  (
    'deribit-derivatives-rest', 'cex', 'Deribit', 'Derivatives', 'http_json', 'https',
    'www.deribit.com', '/api/v2/public/get_time', 'GET',
    '{"accept":"application/json","cache-control":"no-cache"}', NULL,
    'result', 'json_object', 30, 5000, 3, true, 16,
    'https://docs.deribit.com/#public-get_time',
    '{"measurement":"REST TTFB and total RTT","readOnly":true}'
  ),
  (
    'okx-spot-rest', 'cex', 'OKX', 'Spot', 'http_json', 'https',
    'www.okx.com', '/api/v5/public/time', 'GET',
    '{"accept":"application/json","cache-control":"no-cache"}', NULL,
    'data', 'json_object', 30, 5000, 3, true, 18,
    'https://www.okx.com/docs-v5/en/#public-data-rest-api-get-system-time',
    '{"measurement":"REST TTFB and total RTT","readOnly":true}'
  ),
  (
    'upbit-spot-rest', 'cex', 'Upbit', 'Spot', 'http_json', 'https',
    'sg-api.upbit.com', '/v1/ticker?markets=SGD-BTC', 'GET',
    '{"accept":"application/json","cache-control":"no-cache"}', NULL,
    'trade_price', 'json_array', 30, 5000, 3, true, 19,
    'https://global-docs.upbit.com/docs/upbit-quotation-restful-api',
    '{"measurement":"REST TTFB and total RTT","market":"SGD/BTC","region":"Singapore","readOnly":true}'
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

UPDATE trading_probe_targets
SET sort_order = 17, updated_at = now()
WHERE target_key = 'kraken-spot-rest';
