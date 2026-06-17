# Metro UI and route research

Date: 2026-06-17
Environment: `https://app.testnet.hyperspace.zone/benchmarks`
Branch: `milestone2-benchmarking-monitoring`

## UI changes

- Renamed benchmark UI text from City to Metro:
  - `Metro filter`
  - `All metros`
  - dashboard gate column `Metro`
  - route labels prefer `doubleZero.metro` over catalog `city`
- Matched Lake-style improvement badge text colors:
  - green text `#16a34a`
  - yellow text `#ca8a04`
  - red text `#dc2626`
- Removed bold weight from green/yellow/red improvement badges.

## Research 1: Frankfurt -> New York failed

Latest API sample:

```text
gate-eu-fra-01 -> gate-na-nyc-01
public:     succeeded, RTT p50 99.273 ms
doublezero: failed, no_probe_responses, loss 100%

gate-na-nyc-01 -> gate-eu-fra-01
public:     succeeded, RTT p50 99.346 ms
doublezero: failed, no_probe_responses, loss 100%
```

Route checks show the DoubleZero BGP route is missing for this pair.

On Frankfurt:

```text
85.9.199.104 via 212.147.228.1 dev eth0 src 212.147.230.200
85.9.199.104 dev doublezero0 src 169.254.0.211
```

Working DoubleZero peers from Frankfurt have BGP routes:

```text
85.9.219.252 via 169.254.0.210 dev doublezero0 proto bgp src 212.147.230.200
94.237.62.140 via 169.254.0.210 dev doublezero0 proto bgp src 212.147.230.200
213.163.192.30 via 169.254.0.210 dev doublezero0 proto bgp src 212.147.230.200
```

On New York, the reverse route to Frankfurt is also missing:

```text
212.147.230.200 via 85.9.196.1 dev eth0 src 85.9.199.104
212.147.230.200 dev doublezero0 src 169.254.4.71
```

Conclusion: `FRA <-> NYC` fails because DoubleZero is not advertising the gate
public IPs for that pair into `doublezero0`. The probe binds to `doublezero0`,
but without a BGP route it falls back to an unusable link-local source path and
the target never returns probe responses. This is a DoubleZero route availability
issue for that pair, not a public Internet/firewall issue.

## Research 2: Frankfurt -> Amsterdam DoubleZero overhead

Latest API sample:

```text
gate-eu-fra-01 -> gate-eu-ams-01
Internet RTT p50: 6.089 ms
DZ RTT p50:       29.217 ms
Delta:            +23.128 ms

gate-eu-ams-01 -> gate-eu-fra-01
Internet RTT p50: 6.155 ms
DZ RTT p50:       29.157 ms
Delta:            +23.002 ms
```

The overhead is reproducible outside the benchmark UDP probe:

```text
FRA -> AMS ICMP via doublezero0:
rtt min/avg/max/mdev = 29.094/29.175/29.288/0.064 ms

AMS -> FRA ICMP via doublezero0:
rtt min/avg/max/mdev = 29.134/29.152/29.173/0.016 ms
```

Local gate-to-DZ edge overhead is small:

```text
Frankfurt edgeRttMs:  ~0.54 ms to 195.219.220.58
Amsterdam edgeRttMs:  ~0.98 ms to 195.219.138.96
```

Conclusion: the extra ~23 ms is not caused by Hyperspace gate edge overhead or
the UDP benchmark implementation. It is inside the current DoubleZero testnet
path between `fra-dz001` and `ams-dz001`. Public Internet between these VPS
locations is unusually short at ~6 ms, while the current DoubleZero route is
~29 ms.

## Verification

```bash
npm run build
npm run typecheck
npm test
HS_TEST_OUTPUT_DIR=m2-results/live-testnet-benchmark-metro-research npm run test:live:ui
```

Live UI smoke status: `passed`

Artifacts:

- `2026-06-17T07-05-35-995Z-03-benchmarks.png`
- `live-ui-smoke-2026-06-17T07-05-35-995Z.json`
