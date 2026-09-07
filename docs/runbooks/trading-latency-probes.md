# Trading latency probes

This runbook covers the public `/trading` latency dashboard in staging,
testnet, and production. Trading probes are a separate subsystem from the VPN
gate agent. A probe failure must not affect WireGuard assignments, DoubleZero
recovery, gate heartbeats, or config issuance.

## Live rollout evidence (2026-08-28)

The rollout used staging first, testnet second, and production last. The
testnet canary exposed queue starvation after 22 of 26 targets: recurring
low-sort-order work could be claimed ahead of older queued oracle work. Commit
`36821dd` changed claims to oldest-job-first and added a regression test. The
same live node immediately reached 26 of 26 targets before rollout continued.

| Environment | Source revision | Probe coverage | Latest matrix |
| --- | --- | --- | --- |
| Staging | `staging@36821dd` | every catalog gate: 3 of 3 | 3 nodes, 26 targets, 78 measurements |
| Testnet | `staging@36821dd` | every catalog gate: 5 of 5 | 5 nodes, 26 targets, 130 measurements |
| Production | `main@f82b24d` | every enabled or maintenance catalog gate: 30 of 30 | 30 nodes, 26 targets, 780 measurements |

The first deployment used three representative canaries in each environment.
The fleet was expanded on the same day after the canary checks so that every
gate returned by `/v1/public/gates` has a separately authenticated trading
probe node. This includes the Warsaw production gate while its VPN desired
state is `Maintenance`; trading-probe lifecycle is intentionally independent.

All ten CEX venues are present. Regional HTTP policy results such as Binance
`geo_blocked` and venue-specific `unexpected_http_status` remain explicit
failed measurements instead of being reported as latency. API, worker, every
VPN gate agent, and all 38 independent trading probe agents remained active
after fleet expansion. A live test stopped the Singapore trading probe while
its gate stayed ready and schedulable, then restarted only the probe service.

The production probe artifact is version `0.3.0`, revision
`f82b24d29eea8e862c654c12f86db265df2c1972`, SHA-256
`8607f70af2bc5a6a19e63aa81e22489d335abc18a0b6de9e0705c1641407a54e`.
The fresh production pre-migration dump is
`/mnt/hyperspace-backup/postgresql/hyperspace-20260828T150937Z.dump`.
Component and web rollbacks are stored below `/opt/hyperspace-rollbacks` on
their respective hosts. Additive database tables may remain in place when the
feature is rolled back.

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

### PerpDEX catalog extension (prepared 2026-09-07; not rollout evidence)

Migration `0040_trading_latency_perpdex_expansion.sql` adds four mainnet
public APIs. They do not place orders, require a wallet, or expose instruments
as dashboard filters. A fixed market parameter is only a probe fixture.

| Dashboard section | Public API request | Interpretation |
| --- | --- | --- |
| `/trading/variational` | `omni-client-api.prod.ap-northeast-1.variational.io/metadata/stats` | Omni statistics response, not RFQ execution |
| `/trading/extended` | `api.starknet.extended.exchange/api/v1/info/markets?market=BTC-USD` | Public market metadata, not order acknowledgement |
| `/trading/rise` | `api.rise.trade/v1/markets` | RISEx market configuration; server cache is documented as five minutes |
| `/trading/lighter` | `mainnet.zklighter.elliot.ai/api/v1/orderBookDetails?market_id=1` | One market's order-book metadata, not live stream delivery |

All four returned HTTP 200 JSON without credentials from the development
host on 2026-09-07. This is a connectivity smoke check, not fleet coverage or
proof of a Hyperspace path. Official references are recorded on each target.
In particular, the RISEx generated endpoint reference defaults to testnet;
its [integration guide](https://developer.rise.trade/reference/integration)
documents the mainnet hostname used here.

The independent agent itself also passed an opt-in, single-sample live smoke
against each of the four API fixtures from the development host. To repeat
without scheduling jobs or touching a deployed database:

```bash
cd apps/trading-probe-agent
HYPERSPACE_TRADING_LIVE_SMOKE=1 go test -run TestPublicPerpDEXAPIs -v ./...
```

Ordinary `go test ./...` skips those external requests.

Order of deployment, independently per environment:

1. Build and canary the independent trading probe agent `0.3.1`. Update
   `TRADING_PROBE_ALLOWED_HOSTS` in existing node environment files as well as
   the binary: an explicit environment value overrides the compiled defaults.
   No VPN gate-agent update is necessary.
2. Finish the probe-agent rollout before enabling the new targets. Agent
   `0.3.1` raises the bounded, decompressed HTTP body limit from 64 KiB to
   1 MiB. Omni's current statistics payload is about 282 KB; the old agent
   cannot validate it. Lighter uses a single-market endpoint to avoid an
   unnecessarily large all-markets response.
3. Apply `0040` through the normal migration runner, then deploy the web
   artifact. The existing API/worker contract already supports these probes.
4. Verify all four sections, each target's `measuredAt`, response validation,
   regional failures and continuing coverage of the original 26 targets.
   Expect 30 targets, not 30 successful targets in every jurisdiction.
5. Follow staging canary → staging fleet → explicit promotion to the other
   environments. No deployment is implied by this document.

Each new target requests three cold HTTPS samples at most once per 60 seconds
per node (the current scheduler may run less frequently under load). DNS is
reported separately and excluded from the existing `totalP50Ms`; TLS and the
whole response body are included. Server/CDN caching is still possible despite
the request's `cache-control: no-cache`. Do not describe these as warm-session
trading latency or compare different APIs as interchangeable pings.

At the previously documented 38-node, three-environment footprint, Omni alone
would consume at most roughly 114 requests/minute and 46 GB/day of uncompressed
response bodies at the observed payload size. Its documented limits are ten
requests per ten seconds per IP and 1,000/minute globally. The single agent's
three-request burst fits the per-IP budget, but multiple probes behind one NAT
need a shared budget. Before adding tunneled profiles, limit by venue AND
egress IP, add scheduling jitter/backoff, and review provider terms/quotas.
Never multiply external probe traffic by the number of venue pairs.

If reverting this extension, disable only the four exact new target keys before
restoring the old probe binary/allowlist; retain their measurements and the
additive migration. Do not stop existing venue monitoring or restart VPN gates.

### Base subsystem

Apply additive migrations `0037_trading_latency_probes.sql`,
`0038_trading_latency_target_expansion.sql`, and
`0039_trading_latency_cex_expansion.sql`; deploy API and worker from the exact
environment branch revision, then enable the scheduler:

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

Registration and installation are required for every `Enabled` or
`Maintenance` gate in the environment catalog. A newly provisioned gate is not
considered complete for the trading product until both lists match. Compare
them after every catalog change:

```bash
environment=production
control_plane=https://control-plane.hyperspace.zone

comm -23 \
  <(curl -fsS "$control_plane/v1/public/gates" | jq -r '.gates[].name' | sort) \
  <(curl -fsS "$control_plane/v1/public/trading/latency" | \
      jq -r --arg suffix "-$environment" \
        '.nodes[].name | sub("^probe-"; "") | sub($suffix + "$"; "")' | sort)
```

The command must produce no output. Also require every public node to be fresh
and to have one latest row per enabled target before declaring the rollout
complete. Do not reuse gate-agent credentials for the probe service.

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

Stop and disable only the probe service, restore the previous API/worker/web
artifacts, and leave the additive tables in place:

```bash
sudo systemctl disable --now hyperspace-trading-probe-agent.service
```

Do not remove or restart `hyperspace-gate-agent` as part of this rollback. A
managed immutable probe-agent release controller with canary verification and
automatic rollback is the next delivery slice before production expansion.
