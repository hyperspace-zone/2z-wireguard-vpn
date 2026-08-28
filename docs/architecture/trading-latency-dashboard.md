# Trading Latency Dashboard — architecture analysis

Status: expanded staging canary live
Branch: `feature/trading-latency-probes`
Prepared: 2026-08-28

## 1. Decision

Add `/trading` as a public, read-only product surface backed by measurements
collected by a new, independently deployable `hyperspace-trading-probe-agent`.
Initially that agent can be placed on staging gate hosts to reuse their global
footprint. Later the exact same artifact can run on disposable or permanent
testnodes, including nodes whose default route traverses a managed Hyperspace
WireGuard session.

The control-plane remains the owner of desired state: it registers probe nodes,
publishes a versioned target catalog, schedules jobs, leases work, accepts
reports, manages probe-agent releases, and exposes the public read model. Probe
nodes only initiate outbound control-plane connections.

Do not add another mode, goroutine, or command to `hyperspace-gate-agent` and do
not reuse gate identity as probe identity. The existing gate binary carries
WireGuard assignment, heartbeat, DoubleZero recovery, and gate-to-gate UDP
benchmark responsibilities. Although its control and benchmark job lanes are
already isolated, a trading target, parser, release, or credential must not be
able to affect that binary at all. A separate process, identity, queue, release
controller, service account, state directory, and resource budget are the
required isolation boundary.

The first release should measure the direct public path from each probe node to
each trading endpoint. A later release may add a clearly labelled managed
WireGuard path. Until a synthetic client traverses an actual managed
ingress-to-egress session, any value composed from gate-matrix RTT plus
egress-to-venue RTT must be labelled `estimated`, never `measured`.

The implementation must be independent. It may reproduce the useful
information architecture of [Glassnode Latency](https://latency.glassnode.com/)
but must not copy Glassnode source code, branding, prose, map assets, or use its
API as the production data source.

## 2. Existing foundation

The current system already provides most of the required distributed-systems
plumbing:

- the worker schedules gate-to-gate benchmark work;
- gate agents claim work outbound and report results outbound;
- the existing UDP benchmark explicitly binds the Internet or `doublezero0`
  interface and records p50/p95, jitter, loss, failures, and freshness;
- PostgreSQL is the source of truth for latest and historical benchmark rows;
- `/v1/public/benchmarks/gate-matrix` exposes an unauthenticated read model;
- `/benchmarks` provides public routing, filtering, sorting, freshness, and
  failure presentation;
- Caddy already falls back arbitrary paths to `index.html`, so `/trading/*`
  needs no new reverse-proxy rule;
- staging and production already have separate web, API/worker, PostgreSQL,
  observability, credentials, and gate-agent identities.

Repository deployment topology on 2026-08-28:

| Contour | Existing gate footprint | Initial trading-probe policy |
| --- | --- | --- |
| staging | 3 probe placements: Hong Kong, Madrid, Chicago | run a separate probe service on each host |
| production | broader production gate catalog | no rollout from this branch |
| DoubleZero testnet | independent testnet gates | out of scope for the staging MVP |

Even three staging locations are sufficient to prove the scheduler, protocol
adapters, storage, UI, and isolation. The broader fleet also means that a naive
`probe node × target × sample` table can grow very quickly and must not be added
without aggregation and retention.

The existing benchmark table cannot be reused directly: it requires both ends
to be gate foreign keys and models only `public`/`doublezero` gate-to-gate UDP
transports. Existing `jobs.gate_id`, claim authentication, leases, and managed
release state are also gate-oriented. Trading probes need their own node
identity, leases, jobs, deployments, versioned target definitions, network
profiles, and protocol-specific timing fields. Shared repository helpers and
state-machine patterns can be extracted, but the persistent resources must not
be overloaded.

## 3. Public URL and UX model

Use a nested route namespace so the VPN product and trading monitor remain one
deployable SPA without occupying top-level paths:

```text
/trading
/trading/cex
/trading/hyperliquid
/trading/prediction-markets
/trading/sui
/trading/arbitrum
/trading/robinhood
/trading/base
/trading/xlayer
/trading/ink
/trading/op
/trading/zksync
/trading/oracle
/trading/routes
/trading/<section>/status
/trading/<section>/about
```

Solana is deliberately absent.

The landing page should explain the product and show a card per section. Each
measurement page should have:

- a compact horizontally scrollable section bar;
- a second row for `Map`, `Status`, and `About`, plus section-specific views;
- a full-height dark world map on the left and a ranked table on the right;
- target/product selectors where a section has more than one endpoint;
- best-location and lowest-latency summary cards;
- p50 as the main ranking value, plus p95, jitter, success rate, sample count,
  and last measurement;
- explicit `fresh`, `stale`, `failed`, and `not measured` states;
- a mobile layout that places summaries and leaderboard before the map;
- a methodology/disclaimer page describing exactly what each value includes.

Render an interactive Leaflet map and bind every probe node to its operator-
curated latitude/longitude from the control-plane. The staging canary uses
standard OpenStreetMap raster tiles with visible attribution and no API key.
Leaflet is shipped locally with the web artifact
rather than loaded from a CDN. For production traffic, replace the anonymous tile endpoint with an operator-
owned MapTiler, Mapbox, Stadia, or equivalent account that provides a usage
quota and SLA; this changes only the tile layer, not marker coordinates or
latency data.

The UI should be structurally close to the reference but use Hyperspace colors,
typography, naming, icons, and copy. Accessibility requirements include keyboard
navigation, real table markup, non-color status labels, reduced-motion support,
and usable horizontal table scrolling.

## 4. Probe architecture

```text
control-plane desired state + versioned target catalog
        |
        +--> probe release controller --> immutable probe-agent artifact
        |
        +--> trading scheduler --> independent leased trading_probe_jobs
                                   |
                                   v
                         hyperspace-trading-probe-agent
                         (gate host now, testnode later)
                                   |
                                   +--> DNS / TCP / TLS / HTTP /
                                   |    WebSocket / JSON-RPC adapters
                                   |
                                   v
                         authenticated batched reports
                                   |
                                   v
                      latest state + rollups in PostgreSQL
                                   |
                                   +--> public API --> /trading UI
                                   |
                                   +--> low-cardinality metrics/alerts
```

### 4.1 Separate deployable agent

Create a new Go application and artifact rather than importing or extending the
gate command:

```text
apps/trading-probe-agent/cmd/hyperspace-trading-probe-agent
/usr/local/bin/hyperspace-trading-probe-agent
```

Run it as `hyperspace-trading-probe-agent.service`, disabled by default, under a
non-root `hyperspace-probe` user. Use a dedicated node token, environment file,
state directory, log namespace, HTTP client pools, and release metadata. Apply
systemd protections and limits such as `NoNewPrivileges`, a read-only root
filesystem, an explicit writable state directory, low scheduling priority,
bounded memory/CPU, restart backoff, and a maximum number of concurrent probes.
The direct-path MVP needs no `CAP_NET_ADMIN` and must not write nftables,
WireGuard, routing, or DoubleZero state.

The agent heartbeats independently, claims only `trading_probe` work, executes
only operator-defined catalog revisions, and posts bounded result batches. A
public user can never submit a URL or raw request template. Failure of this
unit must not restart or degrade `hyperspace-gate-agent`, WireGuard forwarding,
DoubleZero, gate-to-gate UDP benchmarks, or config issuance.

### 4.2 Probe node identity and placement

A probe node is not necessarily a gate. Model placement explicitly:

```text
placementKind: gate_host | testnode | dedicated
placementRef: optional gate UUID or provider instance reference
city, country, latitude, longitude, provider, regionCode
networkProfiles: [direct] initially; [direct, wireguard:<profile>] later
capabilities: http, websocket, jsonrpc, tcp_tls, ...
```

The initial staging rollout creates three probe-node identities associated with
the Hong Kong, Madrid, and Chicago gate hosts, but the scheduler and public API
key results by `probe_node_id`, not `gate_id`. This is what permits moving the
binary to external testnodes without a schema or protocol redesign.

For a future WireGuard testnode, the control-plane should manage a separate
synthetic session and publish only an opaque network-profile name to the probe
agent. Results include `networkProfile=direct` or a stable managed profile ID.
They must not infer that traffic used Hyperspace merely because the process ran
on a gate host.

Network selection should eventually use one pre-provisioned Linux network
namespace per profile. A small privileged provisioning unit may create the
namespace and WireGuard interface, while the probe agent remains unprivileged
and executes through a named namespace. Do not let a probe job contain shell,
route, interface, or WireGuard configuration commands. For the direct-only MVP,
no namespace orchestration is needed.

### 4.3 Protocol adapters

Use a common result envelope and protocol-specific adapters:

| Adapter | Values | Intended sections |
| --- | --- | --- |
| DNS | resolution time, resolved IPs | diagnostics for all targets |
| TCP connect | connect RTT/failure | Hyperliquid validators, SUI validators |
| TLS handshake | TCP and TLS timing | SUI and direct-origin services |
| HTTP TTFB | DNS/TCP/TLS/TTFB/total and status | CEX REST, prediction markets, oracle public endpoints |
| WebSocket ping | connect breakdown and ping/pong RTT | CEX and Hyperliquid |
| JSON-RPC | warm-connection response TTFB/total and JSON-RPC error class | L2 sequencers |
| FIX | logon/reject RTT | later, only where permitted and credentials/policy are resolved |

HTTP requests must defeat caches where the endpoint permits it. CDN-fronted
targets must not present TCP/TLS-to-edge as distance to the venue origin.
Protocol types are not automatically comparable: the UI must disclose whether
a value is WebSocket RTT, REST TTFB, TCP connect, TLS handshake, or RPC response
time.

For L2 targets, start with a harmless read-only JSON-RPC request and label the
metric `RPC response RTT`. A fixed invalid signed `eth_sendRawTransaction` more
closely follows a transaction submission path, but should only be enabled after
rate-limit, terms-of-service, and abuse review for each endpoint. Never send a
valid funded transaction from the probe fleet.

### 4.4 Category-specific derivations

- **CEX:** select exchange and product; prefer a public order-capable WebSocket
  ping or cache-busted REST time/status endpoint. Do not imply fill latency.
- **Hyperliquid:** API WebSocket RTT first; direct validator TCP latency is a
  second phase unless there is a reliable and permitted validator catalog.
- **Prediction markets:** cache-busted REST TTFB to Polymarket and Kalshi;
  surface geographic/legal unavailability as policy, not endpoint failure.
- **SUI:** periodically obtain active validator endpoints and voting power from
  the SUI system state, measure reachable validators, then sort timings and sum
  stake to derive time-to-2/3 quorum and time-to-90%. Refresh validator metadata
  separately from latency samples.
- **Arbitrum, Robinhood Chain, Base, X Layer, Ink, OP Mainnet, ZKsync Era:**
  one versioned sequencer/RPC target per chain, with the same presentation and
  explicitly documented measurement method.
- **Oracle:** measure only endpoints whose public or credentialed protocol can
  be tested honestly. Keep network RTT separate from update cadence and data
  freshness. Disabled credentialed targets must show `not configured`, not
  zero or failed latency.
- **Arb Routes:** derive a configured venue-pair score from measurements taken
  at the same probe node and compatible time window. Store the route definition,
  not duplicate samples. Show both legs. If `combined = leg A + leg B` or
  `reaction estimate = combined / 2` is displayed, label the formula and its
  limitations.

### 4.5 Target coverage plan

The reference dashboard is useful for measurement semantics, not as a data
dependency. It currently describes WebSocket/FIX/REST CEX probes, Hyperliquid
API and validator probes, REST prediction-market probes, sequencer submission
paths, SUI stake-weighted quorum, and oracle gateways. Hyperspace must maintain
and validate its own catalog against each venue's official documentation and
terms before enabling a target.

| Section | Candidate target or source | Staging MVP measurement | Later measurement |
| --- | --- | --- | --- |
| CEX | Binance plus Coinbase, Kraken, OKX, Bybit, BitMEX, Deribit public endpoints | Binance public WebSocket ping and cache-busted read-only REST; add venues one at a time | product-specific WS/FIX after policy and credential review |
| Hyperliquid | `wss://api.hyperliquid.xyz/ws` | WebSocket application RTT and connection breakdown | permitted validator TCP and controlled order-to-fill on dedicated nodes only |
| Prediction markets | `clob.polymarket.com`, `api.elections.kalshi.com` | cache-busted read-only REST TTFB/total | authenticated market-data paths if useful |
| SUI | official mainnet GraphQL endpoint | checkpoint GraphQL response RTT | TCP+TLS per validator, time-to-2/3 stake and time-to-90% stake |
| Arbitrum | `arb1-sequencer.arbitrum.io` | TCP/TLS plus read-only RPC response RTT | reviewed synthetic transaction-submission path |
| Robinhood Chain | `sequencer.mainnet.chain.robinhood.com` | TCP/TLS plus read-only RPC response RTT | reviewed synthetic transaction-submission path |
| Base | `mainnet-sequencer.base.org` | TCP/TLS plus read-only RPC response RTT | reviewed synthetic transaction-submission path |
| X Layer | `rpc.xlayer.tech` | TCP/TLS plus read-only RPC response RTT | reviewed synthetic transaction-submission path |
| Ink | `rpc-gel.inkonchain.com` | TCP/TLS plus read-only RPC response RTT | reviewed synthetic transaction-submission path |
| OP Mainnet | `mainnet-sequencer.optimism.io` | TCP/TLS plus read-only RPC response RTT | reviewed synthetic transaction-submission path |
| ZKsync Era | `mainnet.era.zksync.io` | TCP/TLS plus read-only RPC response RTT | reviewed synthetic transaction-submission path |
| Oracle | Pyth Pro/Lazer, Switchboard Crossbar, Chainlink Data Streams | Pyth TCP+TLS routers plus public Switchboard/Chainlink health RTT | credentialed streaming/data freshness as separate metrics |
| Arb Routes | configured pairs of compatible measurements | derived score from same node/window | measured strategy-specific path on dedicated testnodes |

Real orders are explicitly excluded from the staging MVP. The reference
dashboard's order-to-fill view uses actual market orders; copying that behavior
would create financial, key-custody, market-impact, and accounting obligations
that do not belong in a network-latency canary.

### 4.6 Cadence and load budget

Do not copy a five-second polling interval across every target. Use persistent
connections where the protocol supports them and a target-specific schedule:

- WebSocket ping: every 5 seconds over one persistent connection, reconnect
  with capped exponential backoff and jitter;
- REST and JSON-RPC: every 30 seconds in staging, with deterministic per-node
  jitter so all locations do not fire together;
- TCP/TLS: every 30 seconds unless an application probe already captures it;
- dynamic validator/target catalogs: every 5 minutes;
- SUI validator fan-out: 5-15 minute buckets with bounded concurrency;
- report batches and heartbeats: every 30 seconds, with an on-disk bounded spool
  for transient control-plane outages.

Start with four canary targets, three nodes, concurrency four, a five-second
per-attempt timeout, and a response body cap. Expand only after a 24-hour soak
confirms endpoint rate limits, database growth, CPU/memory isolation, and alert
volume.

## 5. Target catalog and safety

Keep a version-controlled catalog with stable IDs and sync it idempotently into
PostgreSQL. A target revision should change whenever hostname, port, protocol,
request template, response validation, or measurement semantics change.
Historical samples retain the revision that produced them.

Suggested fields:

```text
id, revision, category, display_name, product, protocol,
scheme, hostname, port, path, request_template, validation_rule,
interval_seconds, timeout_ms, sample_count, enabled, sort_order,
official_documentation_url, terms_reviewed_at, metadata
```

The runner must reject loopback, private, link-local, multicast, Unix socket,
cloud metadata, and non-catalog destinations after every DNS resolution. Apply
an explicit port allowlist, response-size cap, redirect limit, per-target rate
limit, global concurrency limit, and redacted logging. Do not log credentials,
request authorization headers, full response bodies, signed transactions, or
raw target configuration secrets.

Endpoint credentials, if ever required, stay in contour-local root-readable
files and are referenced by an opaque credential key from the catalog. They are
never returned by the config API. The initial release should prefer targets
that need no credentials.

## 6. Storage model

Add a new additive migration after the current `0036` migration. Recommended
logical tables:

### `trading_probe_nodes`, `trading_probe_node_status`, `trading_probe_leases`

Desired placement/capabilities, independently authenticated observed state, and
a renewable lease. Status includes agent version, revision, artifact SHA-256,
build/install timestamps, active network profiles, last report time, queue
depth, spool usage, and the last self-test result. A node may optionally refer
to a gate, but that reference is never its primary identity.

### `trading_probe_jobs`, `trading_probe_job_attempts`

An independent leased queue with bounded retries, deadline, target revision,
network profile, and structured terminal errors. Do not put these jobs in the
gate `jobs` table: its claim authorization and operational alerts are tied to a
gate identity and gate lifecycle.

### `trading_probe_releases`, `trading_probe_deployments`, deployment events

Immutable artifact metadata, rollout desired state, install/startup/integration
test evidence, activation timestamp, and rollback evidence. Reuse the managed
gate rollout state-machine design, but keep its releases and alerts separate.
The control-plane must be able to deploy, canary, verify, stop, and roll back
probe software without ever scheduling a gate-agent release.

### `trading_probe_targets`

Operator-controlled current target catalog and revision metadata.

### `trading_latency_latest`

One upserted row per `(probe_node_id, network_profile, target_id)`. This keeps
the public live query small even when agents report frequently.

Suggested measurements include status, measured timestamp, protocol, total
RTT, DNS, TCP, TLS, TTFB, WebSocket/RPC RTT, sample count, failure count, p50,
p95, jitter, resolved IP, response class, error code, agent version, and target
revision.

### `trading_latency_rollups`

Time-bucketed history rather than every raw request. The probe runner can submit
a completed bucket containing count, failure count, min, p50, p95, max, and
jitter. Start with five-minute buckets and retain them for 90 days. Compact to
hourly buckets for longer history. Partition by time or use bounded indexed
tables plus a worker cleanup loop; do not add TimescaleDB only for this feature.

### `trading_sui_validators`

Current validator identity, network endpoint, voting power, metadata revision,
and active state. Validator-level samples use the same latest/rollup model;
quorum results are derived per probe node and window.

With 30 probe nodes, 25 static targets, and direct-only networking, the latest
table contains only 750 rows. Persisting every 30-second request would create
about 2.16 million raw rows per day before SUI validators; five-minute rollups
reduce static-target history to 216,000 rows per day. SUI therefore needs a
slower interval and/or its own 15-minute rollup policy.

## 7. API contracts

Public read endpoints:

```text
GET /v1/public/trading/catalog
GET /v1/public/trading/latest?category=&target=
GET /v1/public/trading/leaderboard?target=&window=5m
GET /v1/public/trading/history?target=&node=&networkProfile=&from=&to=&step=5m
GET /v1/public/trading/sui/quorum?window=15m
GET /v1/public/trading/routes?route=&window=5m
GET /v1/public/trading/status
```

Authenticated probe-agent endpoints:

```text
POST /v1/trading-probe/heartbeat
POST /v1/trading-probe/jobs/claim
POST /v1/trading-probe/jobs/:id/report
GET  /v1/trading-probe/releases/desired
POST /v1/trading-probe/releases/:id/evidence
```

Every route needs a JSON schema in `packages/contracts`, bounded query ranges,
response-size limits, existing public rate limiting, OpenAPI coverage, and
tests. Public responses expose city/country and map coordinates but do not need
probe public IPs, tokens, provider instance IDs, or resolved endpoint IPs unless
there is a concrete diagnostic reason to publish them.

Store `latitude`, `longitude`, `provider`, and `regionCode` in probe-node
desired state. A gate-host probe can initially copy operator-curated location
metadata from its associated gate; do not runtime-geocode city strings.

## 8. Web implementation

The current UI is a dependency-light TypeScript SPA with one large `main.ts`.
Do not add thirteen trading views directly to that file. Add a route-level
entry module, for example:

```text
apps/web/src/trading/index.ts
apps/web/src/trading/routes.ts
apps/web/src/trading/api.ts
apps/web/src/trading/map.ts
apps/web/src/trading/leaderboard.ts
apps/web/src/trading/sections/*.ts
```

`main.ts` should dispatch paths beginning with `/trading` to this module before
the authenticated VPN view resolution. This keeps `/trading` public like
`/benchmarks` and avoids the current unauthenticated redirect to `/login`.
Scope dark-theme CSS under `.trading-shell` so the existing light VPN UI and
grant acceptance screenshots do not change.

Use `AbortController` to cancel stale requests, poll latest data at a bounded
interval, pause polling for hidden tabs, preserve section/filter state in the
URL, and show the server timestamp rather than the browser fetch time.

## 9. Observability

Export low-cardinality metrics from the worker/API:

- last heartbeat and successful report age per probe node;
- enabled target count and reporting probe-node count;
- report rows accepted/rejected;
- job queue age, attempts, terminal failures, and on-node spool pressure;
- probe-agent desired/observed artifact and rollout/rollback state;
- rollup and cleanup loop durations/failures;
- aggregate target success ratio and age by target ID;
- public trading API request count, errors, and latency.

Avoid raw hostname, resolved IP, validator ID, or error text as unbounded
Prometheus labels. Detailed per-validator health belongs in PostgreSQL and the
status API. Alert only after consecutive failures and group by probe node or
target category to avoid one notification per endpoint. Distinguish DNS,
connect timeout, TLS, protocol validation, HTTP 429, policy block, and stale
data in stored errors.

These probes are a separate product surface, so their failure must not page as
a VPN control-plane outage. Recommended initial alerts are:

- warning: one probe node is stale while the rest of the fleet is healthy;
- warning: sustained 429 or elevated target error ratio;
- warning: rollup/scheduler lag or spool growth;
- critical for the trading subsystem only: every probe node is stale, public
  trading data is unavailable, or an automated probe-agent rollback failed;
- release notification: installation/test failed and rollback succeeded, with
  node, desired/observed SHA-256, timestamps, test stage, and rollback outcome.

Add blackbox checks for `/trading` and a small public status query in staging
before production rollout.

## 10. Delivery without changing the grant release

The grant tag and the deployed `main`/`staging` refs remain untouched during
development. Build and test from an exact commit on
`feature/trading-latency-probes`.

Recommended rollout:

1. **UI shell with fixture data:** implement every route and responsive layout;
   no migrations, services, or gate changes.
2. **Staging collector MVP:** additive schema/API, target catalog, separate
   probe binary/unit and probe identities enabled only on the three staging
   gate hosts; start with Hyperliquid API, Polymarket, Kalshi, and one L2
   endpoint.
3. **Static target coverage:** add CEX, all requested L2s, and permitted oracle
   targets; verify rate and storage budgets.
4. **SUI:** dynamic validator/voting-power catalog and 15-minute quorum
   aggregation.
5. **Arb Routes and history:** derived route rankings and bounded charts.
6. **Production canary:** deploy the tested feature commit to one production
   gate with the trading service enabled, then roll out in waves. Merge to
   `main` only after acceptance and a database backup/rollback rehearsal.
7. **True Hyperspace path measurements:** create dedicated synthetic managed
   VPN sessions and compare direct Internet with actual ingress → DoubleZero →
   egress → venue traffic. Keep this separate from the public-path MVP.

All new behavior is off by default through `TRADING_LATENCY_ENABLED=false`, an
empty target allowlist, and the disabled systemd unit. Database changes are
additive. Probe-agent rollback activates the previous immutable artifact after
its local self-test and integration smoke test pass. A contour rollback
disables the probe units and serves the previous web/API/worker build;
historical trading tables may remain unused.

## 11. Acceptance criteria for the first staging release

- every requested non-Solana route returns the SPA directly and survives page
  refresh;
- `/trading` is public and does not change login, billing, config, or
  `/benchmarks` behavior;
- all three staging locations report fresh data for the canary targets;
- p50/p95/jitter/failure/freshness calculations have deterministic unit tests;
- a disabled, blocked, rate-limited, DNS-failing, TLS-failing, and stale target
  all render distinct states;
- public APIs enforce schemas, rate limits, query bounds, and response bounds;
- probe config cannot target private or metadata addresses;
- stopping, crashing, CPU-throttling, or feeding a hanging endpoint to
  `hyperspace-trading-probe-agent.service` has no effect on the primary gate
  agent, its heartbeat/job latency, or active VPN assignments;
- a probe node can be registered and report from a host with no gate record;
- probe-agent rollout records build/install/test timestamps and automatically
  rolls back a deliberately broken canary artifact;
- agent unit tests cover timing aggregation, adapter validation, timeout,
  cancellation, DNS rebinding/private-address rejection, redirects, response
  caps, persistent WebSocket reconnect/backoff, report spool bounds, and
  graceful shutdown;
- integration tests cover claim leases, idempotent reports, expired jobs,
  target revision changes, token isolation from gate endpoints, and managed
  release/rollback;
- storage growth matches the documented budget for a 24-hour soak;
- Prometheus shows fresh reports and no cardinality explosion;
- visual regression screenshots cover 1440 px and mobile layouts;
- methodology text states that network latency is not fill latency or guaranteed
  execution performance.

## 12. Main risks

| Risk | Mitigation |
| --- | --- |
| Endpoint probing violates rate limits or terms | conservative intervals, target-by-target review, operator-controlled enablement |
| CDN timings are misrepresented as origin latency | protocol labels, hide misleading TCP/TLS columns, publish methodology |
| Trading work impacts VPN lifecycle | separate process/unit, quotas, bounded concurrency, off by default |
| PostgreSQL grows without bound | latest upserts, five-minute rollups, retention and compaction |
| Dynamic DNS enables SSRF/rebinding | validate every resolved address and redirect hop, fixed catalog only |
| SUI validator fan-out overwhelms probe hosts | separate 15-minute schedule, concurrency cap, incremental batches |
| A derived route score is mistaken for a measured route | show both legs and mark formula as estimated |
| A lookalike creates branding/copyright confusion | independent implementation, Hyperspace design and copy, no Glassnode assets/data |

## 13. Recommended first implementation slice

Implement the route shell, dark scoped layout, SVG map, fixture-backed
leaderboard, and API contracts first. Then add the independent node identity,
queue, agent artifact/release controller, and only four canary target types to
staging: Hyperliquid WebSocket, Polymarket REST, Kalshi REST, and one read-only
L2 JSON-RPC endpoint. This validates the hard reusable parts—routing,
geographic data, protocol timing, report batching, storage, freshness,
isolation, and rollback—before multiplying the catalog or adding SUI quorum
logic.

## 14. Reference material

- [Glassnode Latency overview](https://latency.glassnode.com/)
- [CEX measurement methodology](https://latency.glassnode.com/cex/about)
- [Hyperliquid measurement methodology](https://latency.glassnode.com/hyperliquid/about)
- [Hyperliquid order-to-fill view](https://latency.glassnode.com/hyperliquid/fill-latency)
- [Prediction-markets section](https://latency.glassnode.com/prediction-markets/about)
- [SUI methodology](https://latency.glassnode.com/sui/about)
- [Arbitrum methodology](https://latency.glassnode.com/arbitrum/about)
- [Arbitrage routes](https://latency.glassnode.com/routes)

These links define the reference product's public behavior as observed during
analysis. Target configuration must still be checked against each provider's
official documentation immediately before implementation because public hosts,
methods, policies, and rate limits can change.
