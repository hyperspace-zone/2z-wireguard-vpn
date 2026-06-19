# Gate Benchmarking

Use this runbook for Milestone 2 gate-to-gate benchmarking. The benchmark runs
on gate hosts and compares the Internet path with the DoubleZero path for
every directed gate pair.

This does not replace validation clients for user dataplane tests. Gate
benchmarks measure gate-to-gate transport quality. Validation clients are still
needed for source-IP restrictions, target-IP restrictions, custom client keys,
and full client-to-ingress WireGuard behavior.

## Architecture

The control-plane worker owns scheduling. It periodically creates `probe` jobs
for stale directed gate pairs. The source gate-agent claims a job, sends UDP
timestamp probes to the target gate, and reports results back through the normal
gate job report API.

Each probe job measures two transports:

- `public`: source socket bound to the gate public underlay interface.
- `doublezero`: source socket bound to `doublezero0`.

The responder side is transport-aware as well. Each gate-agent opens
interface-bound responder sockets on the same UDP port, one bound to the public
underlay interface and one bound to `doublezero0`. Replies are sent from the
same bound socket that received the request, so the measured path is symmetric:

- `public`: public interface -> Internet -> public interface.
- `doublezero`: `doublezero0` -> DoubleZero -> `doublezero0`.

Do not use a simple `ping <peer-public-ip>` as benchmark evidence. DoubleZero can
install routes to peer public IPs through `doublezero0`, so an unbound ping can
already be using DoubleZero. The gate-agent uses `SO_BINDTODEVICE` to make the
transport explicit. Binding only the source socket is not enough: the target
gate may receive a public probe on the underlay interface and then route the
reply back through `doublezero0`.

The API stores latest and historical rows in `gate_benchmark_results`. The web
Benchmarks page renders two route tables:

- one directed gate pair per row
- `Gate benchmark routes — RTT` with sortable columns for city-directed route,
  DoubleZero RTT, Internet RTT,
  RTT improvement, RTT saved, DoubleZero RTT jitter, Internet RTT jitter, RTT
  jitter improvement, RTT jitter saved, loss with DoubleZero and Internet
  values, ingress gate ↔ DZ RTT, and egress gate ↔ DZ RTT
- `Gate benchmark routes — One-Way` with sortable columns for city-directed
  route, DZ One-Way, Internet One-Way, One-Way improvement, and One-Way saved
- a City filter for narrowing routes by source or target location
- a freshness line with the latest sample time and transport coverage within
  the last 15 minutes
- a green/yellow/pink legend for DZ faster, similar, and Internet faster
  routes

One-way values depend on synchronized clocks. Install and run chrony on all gate
hosts and treat RTT as the primary metric if clock quality is unknown.

The platform also has a gate-side NTP discovery maintenance job. The
control-plane can periodically ask each gate-agent to sample candidate NTP
servers and report whether a closer source exists. This is intentionally a
discovery step, not an automatic clock-source mutation: the agent adds
candidates with `chronyc ... noselect`, waits for samples, ranks them, reports
the result in the normal job report path, and removes the runtime candidates.
Operators can then decide whether a chrony config change is justified.

The ingress/egress DZ RTT columns use the latest gate heartbeat field
`doubleZero.edgeRttMs`. The gate-agent measures it by pinging DoubleZero
`Tunnel Dst` through the gate public interface. This is the local edge overhead
around each gate, not half of the full gate-to-gate route.

## Gate Configuration

Open the UDP probe port between known gate public IPs. The default is `19192`.
Restrict it in the cloud firewall to the gate inventory where possible.

On every gate, set the same probe port and shared HMAC secret in
`/etc/hyperspace/gate-agent.env`:

```bash
GATE_PROBE_LISTEN_ADDRESS=0.0.0.0
GATE_PROBE_PORT=19192
GATE_PROBE_SHARED_SECRET=<same-random-secret-on-every-gate>
```

The shared secret signs UDP probe payloads. If it is omitted, agents can still
run unsigned probes, but production-like deployments should use a shared secret
and firewall allowlists.

Restart the gate-agent after changing the environment:

```bash
systemctl daemon-reload
systemctl restart hyperspace-gate-agent
systemctl is-active hyperspace-gate-agent
journalctl -u hyperspace-gate-agent -n 50 --no-pager
```

Expected heartbeat capabilities include:

- `udp-probe:enabled`
- `udp-probe-public-bind:enabled`
- `udp-probe-doublezero-bind:enabled`
- `udp-probe-hmac:enabled`
- `chrony:sync` when chrony reports synchronized clocks
- `ntp-discovery:enabled` when the agent has `chronyc` and can run NTP
  candidate discovery jobs

## Worker Configuration

The control-plane worker schedules benchmark probe jobs by default. Tune with:

```bash
BENCHMARK_PROBES_ENABLED=true
BENCHMARK_INTERVAL_SECONDS=300
BENCHMARK_PROBE_PORT=19192
BENCHMARK_PROBE_COUNT=10
BENCHMARK_PROBE_INTERVAL_MS=100
BENCHMARK_PROBE_TIMEOUT_MS=1000
```

NTP discovery jobs are off by default. Enable them when you want periodic
maintenance evidence for gate clock quality:

```bash
NTP_DISCOVERY_ENABLED=true
NTP_DISCOVERY_INTERVAL_SECONDS=86400
NTP_DISCOVERY_SAMPLE_SECONDS=30
NTP_DISCOVERY_MAX_CANDIDATES=96
```

The worker schedules one `probe` job per eligible gate with
`payload.kind = gate_ntp_discovery_v1`. Eligibility requires a fresh gate lease,
Ready/Schedulable conditions, `chrony:sync`, and `ntp-discovery:enabled`.

For a five-gate testnet this produces 20 directed jobs per interval. For larger
mainnet-beta footprints, increase `BENCHMARK_INTERVAL_SECONDS` or introduce a
sampling policy before moving beyond routine pilot scale.

After changing worker settings:

```bash
systemctl restart hyperspace-control-plane-worker
systemctl is-active hyperspace-control-plane-worker
```

## API Verification

Check the public matrix endpoint:

```bash
curl -fsS "https://${HS_WEB_HOST}/api/v1/public/benchmarks/gate-matrix" \
  | jq '{gates:(.gates|length), routes:(.routes|length), latest:[.routes[] | select(.public or .doublezero)][0]}'
```

For a five-gate directed matrix, `.routes | length` should be `20`.

Inspect latest RTT deltas:

```bash
curl -fsS "https://${HS_WEB_HOST}/api/v1/public/benchmarks/gate-matrix" \
  | jq -r '
    .routes[]
    | select(.public.rttMs.p50 and .doublezero.rttMs.p50)
    | [.sourceGateName, .targetGateName, .public.rttMs.p50, .doublezero.rttMs.p50, .delta.rttP50Ms, .doublezero.lossPercent]
    | @tsv
  '
```

`delta.rttP50Ms` is `doublezero - public`. Negative values mean DoubleZero is
faster for that source/target pair.

## Web Verification

Open the web UI and sign in:

```bash
printf 'Open: https://%s\n' "$HS_WEB_HOST"
```

Expected dashboard sections:

- `VPN configs`
- `Gates`

Open the `Benchmarks` navigation item. Expected benchmark sections:

- `DZ vs Internet`
- `Gate benchmark routes — RTT`
- `Gate benchmark routes — One-Way`

Capture screenshots after the route table has first samples:

```bash
HS_WEB_BASE="https://${HS_WEB_HOST}" \
HS_API_BASE="https://${HS_WEB_HOST}/api" \
HS_TEST_OUTPUT_DIR=m2-results/live-cluster \
PLAYWRIGHT_CHROMIUM_EXECUTABLE="${PLAYWRIGHT_CHROMIUM_EXECUTABLE:-/snap/bin/chromium}" \
npm run test:live:ui
```

The live UI smoke captures both the dashboard and the separate Benchmarks page
once samples are present.

## Troubleshooting

If route table rows stay missing or `pending`:

- Confirm `hyperspace-control-plane-worker` is active.
- Confirm at least two gates are `ready=true` and `schedulable=true`.
- Confirm every gate-agent heartbeat includes `udp-probe:enabled`.
- Confirm UDP `GATE_PROBE_PORT` is open between gate public IPs.
- Confirm all gates use the same `GATE_PROBE_SHARED_SECRET` when HMAC is enabled.
- Inspect recent `probe` jobs in the admin jobs API or database.

If public and DoubleZero values look identical or suspicious:

- Confirm the source agent is reporting the expected `sourceInterface`.
- Confirm public measurements bind to the underlay interface, not `doublezero0`.
- Confirm DoubleZero measurements bind to `doublezero0`.
- Confirm gate-agent logs show separate `probe_server_started` entries for the
  public interface and `doublezero0`.
- Use `ip route get <peer-public-ip>` only as diagnostic context, not as the
benchmark itself.

If one-way values are noisy or negative:

- Confirm `chrony` is installed and synchronized on all gates.
- Prefer RTT and packet loss for acceptance evidence when clock sync is not
tight enough for directional latency.
- Check the Gates debug view with `?showclockerror=true`. Green means the gate
  estimate is `<= 3ms`, yellow is `> 3ms` and `<= 10ms`, and pink is `> 10ms`.

## NTP Discovery

NTP source selection has to optimize for clock uncertainty, not just hostname
location. A source named after the local city can still be bad if the provider
routes to it through another region.

The gate-agent ranks candidates with a conservative estimate derived from
`chronyc ntpdata`:

```text
estimatedClockErrorMs = (rootDelayMs + peerDelayMs) / 2 + rootDispersionMs
```

This is not a full replacement for the selected-source `Clock Error` shown in
the UI, which also includes the selected source's `last offset` and `RMS
offset`. It is a safe ranking signal for candidate proximity because candidates
are sampled as `noselect` and do not affect the system clock.

Default discovery candidates include:

- NTP Pool global, Europe, Asia, North America, and the gate's inferred country
  pool where the gate name has a known city token.
- Major public time providers such as Cloudflare, Google, AWS, Facebook, Apple,
  ESA, RIPE, PTB, INRiM, and TimeNL.
- Spain-specific public candidates such as `tick.espanix.net`,
  `tock.espanix.net`, `hora.roa.es`, `minuto.roa.es`, and `ntp.i2t.ehu.eus`.

The result is stored in `job_attempts.result_summary` and includes:

- current chrony tracking summary and current selected-source Clock Error when
  available
- top ranked candidate list
- recommendation with `improvesCurrent` and estimated savings
- a note that no chrony configuration was mutated

For example, Madrid on UpCloud can resolve Spanish NTP sources but still fail to
reach green Clock Error if the route to the source hairpins through other
metros. In that case the correct fix is provider routing or moving the gate to a
location/provider with a close time source, not forcing a misleading local
clock.
