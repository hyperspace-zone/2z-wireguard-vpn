# Trading latency probes

This runbook covers the public `/trading` latency dashboard in staging,
testnet, and production. Trading probes are a separate subsystem from the VPN
gate agent. A probe failure must not affect WireGuard assignments, DoubleZero
recovery, gate heartbeats, or config issuance.

## First-open availability fix (2026-09-08)

The September 7 canary was not evidence of durable recovery. Production logs
on September 8 at 06:53:43 UTC show `/v1/public/trading/pairs` returning HTTP
500 after 8.2 seconds: PostgreSQL `57014` statement timeout in the legacy gate
benchmark read. The browser's later retry succeeded. The API had not restarted.
The worker's all-history job-count aggregate had again selected a 6.5 GB heap
scan as visibility-map coverage fell; a recent vacuum alone was not sufficient.

The fix does not depend on periodically vacuuming history to keep an unbounded
aggregate affordable. Operational job metrics now count only phases other than
`succeeded`, using `jobs_actionable_metrics_idx`. Queued, leased, running,
retryable failure, dead and acknowledged-dead counts remain exact, including
zero-valued enum combinations. Successful history is preserved in PostgreSQL
and the admin inventory but is intentionally no longer a polled gauge series;
do not interpret the absent success series as zero or an approximate lifetime
total. Existing dead-job alerts remain covered. The metrics collector has a
separate one-connection pool and a two-second per-statement budget, independent
of operational work. A failed collector retains its gauges and reports degraded
health instead of monopolizing the main pool.

Prebuild the additive index before migration `0044` on an existing fleet:

```bash
node --env-file=/etc/hyperspace/control-plane-api.env scripts/control-plane/prebuild-active-job-metrics-index.mjs
```

This uses `CREATE INDEX CONCURRENTLY`, verifies validity, and refuses to replace
an invalid existing index. The migration records/verifies the prepared index.
No sessions, job history, billing counters or gate routing are removed/changed.

Pair Routes now starts background preparation with the API and refreshes ten
seconds after each calculation finishes. All display requests share one
in-flight calculation. A last-good snapshot is fresh for 15 seconds and may be
displayed up to 120 seconds with its original timestamp and explicit
`snapshotStatus` / `snapshotAgeSeconds`. Fallback rows cannot select a config.
Preset lookup and new checkout validation always require a fresh calculation;
they never authorize using the display fallback. A cold/unavailable snapshot
returns 503 with `Retry-After: 2` and `Cache-Control: no-store`, not an unhandled
500. This is a bounded in-memory cache, not persistence across restarts.

The browser retries automatically with bounded backoff, shows a connecting
state on first open, and preserves the table, comparison and filter inputs
when a later refresh fails. Cached data is explicitly identified and config
selection is paused until fresh data returns. Browser tests inject failures
only into their own requests; they do not interrupt the live database.

For a longer read-only canary, use `TRADING_SMOKE_ROUNDS=60 node
scripts/trading/pairs-sustained-smoke.mjs`. It checks both environments, both
Pair Routes and legacy benchmarks, snapshot freshness/safety and advancing
snapshot timestamps. A finite successful canary is not a performance SLA.

Deployment: API, worker and web revision
`f07c8bc12b1f81d72e70b417454a0cf87347e219`, promoted to GitHub `staging` and
`main` while preserving the separately landed backup/alert changes. Staging
became ready at approximately 07:25 UTC and production at 07:27 UTC. Both
databases recorded `0044`; both prepared partial indexes were valid and 16 kB
after rollout. Production EXPLAIN used the partial Index Only Scan even with
heap visibility misses: the sampled aggregate took 0.61 ms, then 0.47 ms.
Complete worker snapshots were about 0.35–0.37 seconds; all sections were ready.
No additional vacuum, job-history deletion, new host or gate-service restart
was needed. The API, worker and web have retained immutable rollback pointers.

Build and all 192 workspace tests passed, along with both Go agents (gate
tests use `GOTOOLCHAIN=go1.23.12`), the comparison-client test and 19 fixture
browser scenarios. Read-only live browser checks passed in both environments,
including a browser-local injected first-load 503 and later refresh failure,
maps, venue matrix, legacy benchmarks and login. Production additionally
exercised an eligible route's exact preset/login intent; staging had no current
positive estimates, so issuance paths remain covered by fixtures. Ten separate
new browser contexts all opened successfully, rendering in 370–720 ms from the
operator's test location. These timings are not global latency guarantees.

The final 60-round canary ran from approximately 07:27:51 to 07:38:30 UTC:
all 240 public requests returned HTTP 200, with no unsafe/fallback snapshots.
Each environment published 60 distinct observed snapshots; this was not a
single permanently cached response. The maximum response across Pair Routes
and legacy benchmarks was 2,127 ms. Production retained all 812 directed
benchmark routes throughout. Worker/API checks remained ready; the final
worker snapshot samples were 54 ms staging and 242 ms production, with no
failed metric sections. Post-ready API logs contained no 5xx or statement
timeouts at the final log check. All five staging and twelve production VPN
sessions retained their exact IDs, phases and two applied assignments; target
catalogs and probe versions/desired state also matched the before-deploy
inventory. No live checks created configs or transferred funds.

The old production process logged one pool-closed 500 while it was being
replaced, before the new API became ready at 07:27:29 UTC. Do not count a
single-instance process restart as zero-downtime deployment or conflate that
shutdown event with the earlier recurring SQL timeout.

Artifact SHA-256:

- API/worker: `9bc5e51c5f9ecf6ce360573016174ecdc533b29a5d241dbc1b54e24f1591ce9b`.
- Web: `87945e559d8018f5f92e41357d18c1686fb712c4d67c19862b260b8a41ff8e36`.

## Pair Routes release (2026-09-07, historical)

API, worker and web source: `bb3c4833bb700b478ef065773f24cedb81d23b1b`.
The same source was promoted through `staging` to `main`. No testnet rollout,
new servers, VPN gate-agent upgrades or client routing changes were performed.
Only the independent trading probe services were upgraded on existing gates.

| Environment | Probe rollout | Catalog / latest reports | Existing VPN sessions |
| --- | --- | --- | --- |
| Staging | 3/3 on `0.3.1` | 30 targets, 90 reports | 5 active, both assignments applied |
| Production | 29/30 on `0.3.1` | 30 targets, 896 reports | 12 active, both assignments applied |

Each of the four new public APIs reported successful complete batches from
all three staging and all 29 reachable production probes during verification.
The original 26 targets continued reporting. Production Munich
`gate-eu-muc-51` was already offline (last probe heartbeat September 4); SSH
also timed out. It was not restarted or represented as a working route. Its
26 historical reports remain visible as stale, and its four new targets have
no reports yet. Warsaw's maintenance gate still supplies direct matrix data
but cannot be selected for a config.

`/trading/pairs` and alias `/trading/routes` now provide the venue-pair board;
`/trading/` remains the original map. The catalog has 17 trading venues
(10 CEX, 5 perpDEX, 2 prediction venues); chain/RPC/oracle endpoints stay on
the map and are not turned into venue pairs. Filters, pagination, source
selection, per-leg comparisons, matrix mode, shared URLs and exact-route
checkout all use the existing infrastructure.

This release ranks **estimates**, not verified VPN A/B gains. The public
verified count is deliberately zero. IPv6 or unknown-family samples cannot
recommend an IPv4 FullTunnel preset; IPv6 direct observations remain in the
map/matrix. Freshness, revision, incomplete batches, gate readiness, loss,
same-metro N/A and per-leg regression checks fail closed. An old successful
map sample is no longer marked Live when the target or probe is stale.
The client comparison script is read-only, does not install a tunnel, and
does not attest the DoubleZero underlay. See the implemented-scope section in
[the architecture document](../architecture/trading-pair-routes.md).

The production canary exposed intermittent statement timeouts in the existing
gate-matrix query. A bounded recent-results read now uses the existing
`gate_benchmark_results_measured_route_idx`, with historical index lookups
only for missing recent routes. No new index or migration was needed.
Old/new readers were compared in one read-only repeatable-read transaction:
all 812 routes matched, including historical and same-metro behavior; the
observed query duration changed from 2.75 s to 0.21 s. An earlier EXPLAIN
comparison was 5.44 s versus 0.16 s. These are rollout diagnostics, not an SLA.

Further sustained checks identified I/O contention from the pre-existing
unbounded trading-history cleanup. Migration `0041` adds retention indexes;
cleanup now processes at most 1,000 unlocked rows per table/call. The existing
7-day terminal-job and 90-day rollup retention policies are unchanged. The
latest measurements, live jobs and VPN sessions are not cleanup targets.
Both indexes were prebuilt CONCURRENTLY and checked `indisvalid=true` before
the migration; production index sizes were 358 MB and 85 MB. This uses the
existing DB, not a new server. For a future existing fleet, run the new
release's `scripts/trading/prebuild-retention-indexes.mjs` with `DATABASE_URL`
before migrations; it refuses an invalid existing index rather than dropping
it. The normal migration records/verifies the already-valid indexes.

Two existing worker metrics collectors also repeatedly scanned historical
payloads. Latest assignment metrics now use the existing per-assignment/time
index: all 404 rows matched in a read-only repeatable-read comparison (11.96 s
versus 15 ms in that diagnostic). No counter values or billing calculations
changed. Job metrics preserve exact counts and zero-valued enum combinations;
all 49 groups / 9,401,923 jobs matched in another read-only comparison.
Migration `0042` adds a compact `(type, phase)` covering index (62 MB production,
480 kB staging), prebuilt CONCURRENTLY with validity checks.

Production's old jobs table had not been vacuumed since September 3 and only
29% of its pages were all-visible. Consequently the initial new query still
chose a 6.5 GB heap scan. Ordinary `VACUUM (ANALYZE, TRUNCATE FALSE) jobs`
refreshes the visibility map; it is not VACUUM FULL, does not delete live jobs,
and does not truncate the table. Migration `0043` lowers jobs-only autovacuum
update/insert scale factors to 0.02 and analyze to 0.01, preserving any stricter
existing per-table settings. Before deploying to a future existing large fleet,
run `scripts/control-plane/prebuild-metrics-indexes.mjs --vacuum` from the built
new release with its existing `DATABASE_URL`, then apply migrations. These
operations do not require another server or changes to the queue lifecycle.
The production maintenance completed at 11:35 UTC with 839,188 of 839,975
pages all-visible. EXPLAIN then selected `Index Only Scan` on the new index;
the cold aggregate completed in 3.07 s versus the prior 31.5 s heap scan.
After the final rollout, the complete worker business snapshot (all sections)
completed in 0.85 s and every worker health component was ready. These are
observed diagnostics, not a performance SLA.

Verification includes TypeScript suites, both Go agents, the four real public
API fixtures, offline browser scenarios and read-only live browser checks on
both environments. The fixture suite covers login return, exact ingress/egress,
payment failure, stale-preset rejection, successful-request cleanup and a
subsequent ordinary config. Live checks do not fund wallets or create paid
sessions. Existing session IDs, phases and applied assignment counts were
compared before and after deployment. Staging's three locations had no
positive two-leg estimates during the smoke; its honest empty state/matrix
were tested, while production also exercised the eligible-route login CTA.
The final source passed `npm run build && npm test` (183 tests), both Go
agents, all four opt-in public API smoke targets, 15 offline browser scenarios,
the local comparison-client test and both deployment-order tests.
The final sustained canary completed around 11:39 UTC: 72 public read-only
requests across both environments and both `/benchmarks/gate-matrix` and
`/trading/pairs` APIs, all HTTP 200, maximum observed response 1,270 ms.
Production returned all 812 legacy directed routes throughout. The earlier
canary exposed 10 failures in 72 requests before the job-metrics/visibility
fix; it was not accepted as a successful rollout. Both final API health
checks and every worker health component were ready. The sustained script
is checked into the repository; it does not create sessions or move funds.

Re-run public read-only checks from a built checkout with Chromium available:

```bash
node scripts/trading/pairs-live-smoke.mjs
TRADING_SMOKE_URL=https://app.hyperspace.zone node scripts/trading/pairs-live-smoke.mjs
node scripts/trading/pairs-sustained-smoke.mjs
npm run test:trading:ui
npm run test:trading:client
```

Release artifacts (SHA-256):

- Probe `0.3.1`, source `2e14d12ab3f4bb97abf2ac602aea22c712af3b59`:
  `323a111a948d207542da89798cde2d4ca9999e83992e8d5132675b188ca3baf0`.
- API/worker archive:
  `631be5c7d459d7f8f8d16dc8ef0089b5f5b6a48f0bceef83ae9dd111048c4cd8`.
- Web archive:
  `936be07b1c17b7bd565387fc9c1abd287e9947cc194f9612d2bb1879dffac1db`.

API/worker releases are under `/opt/2z-wireguard-vpn-releases/<revision>`;
web releases are under `/var/www/hyperspace-web-releases/<revision>`.
Per-host rollback pointers/copies are under
`/opt/hyperspace-rollbacks/trading-pairs-<revision>`. Restore the pre-feature
pointer when rolling back the whole feature, not merely the previous small
fix. Retain the additive migration/data. Disable the four exact new target
keys before restoring a `0.3.0` probe binary/allowlist.

Staging's fresh pre-migration backup is
`/var/backups/hyperspace/hyperspace-pre-trading-20260907T1006Z.dump` on its DB
host. The production scheduled backup was already failing due to insufficient
backup-volume space. A separate full PostgreSQL custom/zstd dump and globals
were saved on the existing operator host under
`/root/hyperspace/trading-release-20260907-1eSrs9/`; the dump is
`production-pre-trading.dump` (12,856,349,697 bytes). Both dumps were fully
read with `pg_restore --file=/dev/null`, without restoring into a database.
The operator directory is private and dump files have mode 0600. No previous
backup was deleted. Scheduled-backup storage/retention and Munich recovery
remain separate operational follow-ups; this release does not fix them.

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

### PerpDEX catalog extension (2026-09-07)

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
