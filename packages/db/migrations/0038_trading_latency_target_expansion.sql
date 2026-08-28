-- Expand the staging canary to every trading network section and to public,
-- read-only oracle infrastructure checks. Oracle health/TLS probes measure the
-- public network path to provider infrastructure, not authenticated feed delivery.
INSERT INTO trading_probe_targets (
  target_key, category, display_name, product, protocol, scheme, hostname, path,
  request_method, request_headers, request_body, expected_body_contains,
  response_kind, interval_seconds, timeout_ms, sample_count, enabled, sort_order,
  official_documentation_url, metadata
) VALUES
  (
    'sui-mainnet-graphql', 'sui', 'Sui', 'Mainnet GraphQL', 'http_json', 'https',
    'graphql.mainnet.sui.io', '/graphql', 'POST',
    '{"content-type":"application/json","cache-control":"no-cache"}',
    '{"query":"query { checkpoint { sequenceNumber timestamp } }"}', 'checkpoint',
    'json_object', 30, 5000, 3, true, 70,
    'https://docs.sui.io/references/sui-api/sui-graphql',
    '{"measurement":"read-only GraphQL checkpoint RTT","network":"Sui mainnet","transactionSubmission":false}'
  ),
  (
    'robinhood-chain-mainnet-rpc', 'robinhood', 'Robinhood Chain', 'Mainnet RPC', 'json_rpc', 'https',
    'rpc.mainnet.chain.robinhood.com', '/', 'POST',
    '{"content-type":"application/json","cache-control":"no-cache"}',
    '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}', '0x1237',
    'json_object', 30, 6000, 3, true, 80,
    'https://docs.robinhood.com/chain/connecting/',
    '{"measurement":"read-only JSON-RPC response RTT","chainId":"4663","transactionSubmission":false}'
  ),
  (
    'base-mainnet-rpc', 'base', 'Base', 'Mainnet RPC', 'json_rpc', 'https',
    'mainnet.base.org', '/', 'POST',
    '{"content-type":"application/json","cache-control":"no-cache"}',
    '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}', '0x2105',
    'json_object', 30, 5000, 3, true, 90,
    'https://docs.base.org/base-chain/api-reference/rpc-overview',
    '{"measurement":"read-only JSON-RPC response RTT","chainId":"8453","transactionSubmission":false}'
  ),
  (
    'xlayer-mainnet-rpc', 'xlayer', 'X Layer', 'Mainnet RPC', 'json_rpc', 'https',
    'rpc.xlayer.tech', '/', 'POST',
    '{"content-type":"application/json","cache-control":"no-cache"}',
    '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}', '0xc4',
    'json_object', 30, 5000, 3, true, 100,
    'https://web3.okx.com/xlayer/docs/developer/network-information',
    '{"measurement":"read-only JSON-RPC response RTT","chainId":"196","transactionSubmission":false}'
  ),
  (
    'ink-mainnet-rpc', 'ink', 'Ink', 'Mainnet RPC', 'json_rpc', 'https',
    'rpc-gel.inkonchain.com', '/', 'POST',
    '{"content-type":"application/json","cache-control":"no-cache"}',
    '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}', '0xdef1',
    'json_object', 30, 5000, 3, true, 110,
    'https://docs.inkonchain.com/general/network-information',
    '{"measurement":"read-only JSON-RPC response RTT","chainId":"57073","transactionSubmission":false}'
  ),
  (
    'op-mainnet-rpc', 'op', 'OP Mainnet', 'Public RPC', 'json_rpc', 'https',
    'mainnet.optimism.io', '/', 'POST',
    '{"content-type":"application/json","cache-control":"no-cache"}',
    '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}', '0xa',
    'json_object', 30, 5000, 3, true, 120,
    'https://docs.optimism.io/op-mainnet/network-information/connecting-to-op',
    '{"measurement":"read-only JSON-RPC response RTT","chainId":"10","transactionSubmission":false}'
  ),
  (
    'zksync-era-mainnet-rpc', 'zksync', 'ZKsync Era', 'Mainnet RPC', 'json_rpc', 'https',
    'mainnet.era.zksync.io', '/', 'POST',
    '{"content-type":"application/json","cache-control":"no-cache"}',
    '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}', '0x144',
    'json_object', 30, 5000, 3, true, 130,
    'https://docs.zksync.io/zksync-network/zksync-era/network-details',
    '{"measurement":"read-only JSON-RPC response RTT","chainId":"324","transactionSubmission":false}'
  ),
  (
    'pyth-lazer-router-0', 'oracle', 'Pyth Pro (Lazer)', 'Router 0', 'tcp_tls', 'tls',
    'pyth-lazer-0.dourolabs.app', '/', 'GET', '{}', NULL, NULL,
    'any', 30, 5000, 3, true, 140,
    'https://docs.pyth.network/price-feeds/core/use-real-time-data/pull-integration/pyth-lazer',
    '{"measurement":"TCP + TLS handshake","infra":"Tokyo bare metal","publicPathEstimate":true,"authenticatedFeed":false}'
  ),
  (
    'pyth-lazer-router-1', 'oracle', 'Pyth Pro (Lazer)', 'Router 1', 'tcp_tls', 'tls',
    'pyth-lazer-1.dourolabs.app', '/', 'GET', '{}', NULL, NULL,
    'any', 30, 5000, 3, true, 150,
    'https://docs.pyth.network/price-feeds/core/use-real-time-data/pull-integration/pyth-lazer',
    '{"measurement":"TCP + TLS handshake","infra":"Tokyo bare metal","publicPathEstimate":true,"authenticatedFeed":false}'
  ),
  (
    'pyth-lazer-router-2', 'oracle', 'Pyth Pro (Lazer)', 'Router 2', 'tcp_tls', 'tls',
    'pyth-lazer-2.dourolabs.app', '/', 'GET', '{}', NULL, NULL,
    'any', 30, 5000, 3, true, 160,
    'https://docs.pyth.network/price-feeds/core/use-real-time-data/pull-integration/pyth-lazer',
    '{"measurement":"TCP + TLS handshake","infra":"Tokyo bare metal","publicPathEstimate":true,"authenticatedFeed":false}'
  ),
  (
    'switchboard-crossbar-health', 'oracle', 'Switchboard', 'Crossbar health', 'http_json', 'https',
    'crossbar.switchboard.xyz', '/health', 'GET', '{"cache-control":"no-cache"}', NULL, 'healthy',
    'json_object', 30, 5000, 3, true, 170,
    'https://docs.switchboard.xyz/',
    '{"measurement":"public REST health RTT","infra":"GCP eu-west4","publicPathEstimate":true,"authenticatedFeed":false}'
  ),
  (
    'chainlink-data-streams-health', 'oracle', 'Chainlink Data Streams', 'Public health', 'http_json', 'https',
    'ws.dataengine.chain.link', '/healthz', 'GET', '{"cache-control":"no-cache"}', NULL, 'OK',
    'any', 30, 5000, 3, true, 180,
    'https://docs.chain.link/data-streams',
    '{"measurement":"public REST health RTT (floor)","cdnFronted":true,"publicPathEstimate":true,"authenticatedFeed":false}'
  )
ON CONFLICT (target_key) DO NOTHING;
