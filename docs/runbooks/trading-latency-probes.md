# Trading latency probes

This runbook covers the feature-branch staging canary for the public
`/trading` latency dashboard. Trading probes are a separate subsystem from the
VPN gate agent. A probe failure must not affect WireGuard assignments,
DoubleZero recovery, gate heartbeats, or config issuance.

## Live staging evidence (2026-08-28)

The expanded backend and CEX probe artifact from commit `30834d1` and the light
web dashboard from `1142ad2` are deployed only to staging. Three independent
probe agents in Hong Kong, Madrid, and Chicago run version `0.3.0`, revision
`30834d17523e5b32aa6fb6939b72cd40964f1649`, artifact SHA-256
`1c9cc1d69bcbcffec15706254ee5d4f16bcfeaa22c589fc00195982913d08596`.

The live catalog contains 26 targets and publishes 78 latest measurements.
All ten CEX venues are present. The CEX matrix has 28 successful measurements;
Chicago receives the documented Binance HTTP 451 (`geo_blocked`) and a Bybit
HTTP 403 (`unexpected_http_status`). API, worker, all three VPN gate agents,
and all three trading probe agents remained active after rollout.

The pre-migration PostgreSQL dump is
`/var/backups/hyperspace/hyperspace-20260828T143122Z.dump`. Probe-agent
rollbacks are stored in
`/opt/hyperspace-rollbacks/trading-probe-1008248-before-30834d1` on each probe
host; the previous web artifact is
`/opt/hyperspace-rollbacks/trading-pre-1008248-web` on the staging web host.

## Target set

The initial catalog uses public, read-only requests and requires no exchange
API keys or funded wallets:

| Category | Target | Measurement |
| --- | --- | --- |
| CEX | Binance Spot server time | REST TTFB and total RTT |
| CEX | Bitget Spot server time | REST TTFB and total RTT |
| CEX | Bitstamp BTC/USD ticker | REST TTFB and total RTT |
| CEX | Bullish BTC/USDC market | REST TTFB and total RTT |
| CEX | Bybit server time | REST TTFB and total RTT |
| CEX | Coinbase server time | REST TTFB and total RTT |
| CEX | Deribit server time | REST TTFB and total RTT |
| CEX | Kraken Spot server time | REST TTFB and total RTT |
| CEX | OKX server time | REST TTFB and total RTT |
| CEX | Upbit SGD/BTC ticker | REST TTFB and total RTT |
| Hyperliquid | `allMids` info request | read-only application RTT |
| Prediction markets | Polymarket CLOB time | REST TTFB and total RTT |
| Prediction markets | Kalshi exchange status | REST TTFB and total RTT |
| Arbitrum | public RPC `eth_chainId` | read-only JSON-RPC response RTT |
| Sui | mainnet GraphQL checkpoint | read-only GraphQL response RTT |
| Robinhood Chain, Base, X Layer, Ink, OP Mainnet, ZKsync Era | official public RPC `eth_chainId` | read-only JSON-RPC response RTT |
| Pyth Pro (Lazer) | three public routers | TCP connect plus TLS handshake |
| Switchboard | Crossbar public health | REST TTFB and total RTT |
| Chainlink Data Streams | public health endpoint | REST TTFB and total RTT |

Binance may intentionally return HTTP 451 from restricted jurisdictions. The
agent records this as `geo_blocked`, preserves the HTTP status, resolved IP and
response timing, and the UI shows the location as unavailable instead of
misrepresenting it as a successful latency sample.

REST, JSON-RPC, WebSocket, and FIX values have different semantics. Do not
label these measurements as fill latency or matching-engine latency. CDN-fronted
TCP/TLS values describe the edge connection and are diagnostic only.

The public Pyth, Switchboard, and Chainlink probes approximate access to the
provider infrastructure. They do not measure an authenticated oracle stream,
feed freshness, or publish-to-receive latency. Production stream measurements
require provider subscriptions and credentials and must be added as separate
targets rather than silently changing these public metrics.

The dashboard map uses the locally shipped Leaflet client and standard
OpenStreetMap raster tiles. Probe markers come from the latitude/longitude
stored on each `trading_probe_node`; the OpenStreetMap attribution must remain
visible. No browser API key is required for the low-traffic staging canary.
Before a high-traffic production rollout, configure a tile provider account
with an explicit quota and SLA.

## Control-plane rollout

Apply additive migrations `0037_trading_latency_probes.sql` and
`0038_trading_latency_target_expansion.sql`, deploy API and
worker from the exact feature commit, and enable the scheduler only in staging:

```dotenv
TRADING_PROBES_ENABLED=true
TRADING_PROBE_SCHEDULER_POLL_MS=5000
```

The worker writes only `trading_probe_jobs`; it never creates a gate job. Public
data is exposed at:

```text
GET /v1/public/trading/latency
```

## Register a probe node

Create or rotate a probe-node token using the admin API. The returned token is
shown once and must be stored only in the node's root-readable environment
file. Example for the Hong Kong staging gate host:

```bash
curl -fsS https://control-plane.staging.hyperspace.zone/v1/admin/trading/probe-nodes \
  -H "x-admin-token: ${ADMIN_TOKEN}" \
  -H 'content-type: application/json' \
  --data '{
    "name":"probe-gate-ap-hkg-31-staging",
    "desiredState":"Enabled",
    "placementKind":"gate_host",
    "gateName":"gate-ap-hkg-31",
    "city":"Hong Kong",
    "country":"Hong Kong",
    "latitude":22.3193,
    "longitude":114.1694,
    "provider":"",
    "regionCode":"HKG"
  }'
```

Register Madrid and Chicago with their operator-curated coordinates in the
same way. Repeating the request rotates the token and immediately revokes the
old one.

## Build and install the independent agent

Build an immutable Linux artifact and run its embedded self-test:

```bash
npm run trading:build-agent
```

Install the binary, service unit, and a root-readable environment file:

```bash
sudo install -o root -g root -m 0755 dist/hyperspace-trading-probe-agent \
  /usr/local/bin/hyperspace-trading-probe-agent
sudo install -o root -g root -m 0644 \
  infra/systemd/hyperspace-trading-probe-agent.service \
  /etc/systemd/system/hyperspace-trading-probe-agent.service
sudo useradd --system --home /var/lib/hyperspace-trading-probe \
  --shell /usr/sbin/nologin hyperspace-probe || true
sudo install -o root -g hyperspace-probe -m 0640 /path/to/generated.env \
  /etc/hyperspace/trading-probe-agent.env
sudo /usr/local/bin/hyperspace-trading-probe-agent --self-test
sudo systemctl daemon-reload
sudo systemctl enable --now hyperspace-trading-probe-agent.service
```

The service runs without Linux capabilities, has no access to gate state, and
is constrained to 25% CPU and 256 MiB memory. The host allowlist is repeated in
the node environment as a second boundary in addition to the control-plane
catalog.

## Canary verification

```bash
systemctl is-active hyperspace-gate-agent
systemctl is-active hyperspace-trading-probe-agent
journalctl -u hyperspace-trading-probe-agent -n 50 --no-pager
curl -fsS https://app.staging.hyperspace.zone/api/v1/public/trading/latency | jq .
curl -fsSI https://app.staging.hyperspace.zone/trading/cex
```

Verify that all ten CEX targets have fresh measurements or an explicit regional
policy error from all enabled probe nodes. Stop the probe service deliberately
and confirm that the primary gate agent remains fresh and a new VPN config can
still be issued.

## Rollback

For the staging MVP, stop and disable only the probe service, restore the
previous API/worker/web artifacts, and leave the additive tables in place:

```bash
sudo systemctl disable --now hyperspace-trading-probe-agent.service
```

Do not remove or restart `hyperspace-gate-agent` as part of this rollback. A
managed immutable probe-agent release controller with canary verification and
automatic rollback is the next delivery slice before production expansion.
