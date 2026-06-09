# Testnode Public vs Hyperspace Measurements

Generated at: `2026-06-09 07:26:02 UTC`.

Public source file: `m1-results/live-testnet/matrix-2026-06-09/public.json`.
Hyperspace source file: `m1-results/live-testnet/matrix-2026-06-09/hyperspace.json`.

RTT is measured with the source node monotonic clock. One-way values use
wall-clock timestamps from both nodes, so they require tight NTP/chrony
synchronization and should be treated as approximate directional diagnostics.

Positive delta means Hyperspace was faster. Negative delta means public
Internet was faster for that directed pair and sample window.

## Summary

- Directed pairs measured: `20`.
- Hyperspace faster by RTT p50: `6` pairs.
- Public Internet faster by RTT p50: `14` pairs.
- Zero packet loss in public runs: `True`.
- Zero packet loss in Hyperspace runs: `True`.

## Biggest RTT Improvements

| Pair | Hyperspace path | Public RTT p50 | Hyperspace RTT p50 | Delta RTT | Public fwd | Hyperspace fwd | Delta fwd | Public rev | Hyperspace rev | Delta rev |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `eu-sto->ap-syd` | `gate-eu-ams-01 -> gate-ap-sin-01` | 330.1 ms | 275.7 ms | +54.4 ms | 162.6 ms | 133.1 ms | +29.5 ms | 167.5 ms | 142.5 ms | +25.0 ms |
| `ap-syd->eu-mad` | `gate-ap-sin-01 -> gate-eu-ams-01` | 322.3 ms | 280.8 ms | +41.5 ms | 167.6 ms | 149.8 ms | +17.7 ms | 154.7 ms | 130.9 ms | +23.8 ms |
| `na-chi->eu-mad` | `gate-na-nyc-01 -> gate-eu-ams-01` | 134.4 ms | 112.8 ms | +21.6 ms | 69.7 ms | 58.9 ms | +10.8 ms | 64.7 ms | 53.9 ms | +10.8 ms |
| `eu-mad->na-chi` | `gate-eu-ams-01 -> gate-na-nyc-01` | 134.4 ms | 112.8 ms | +21.6 ms | 64.7 ms | 53.8 ms | +10.9 ms | 69.6 ms | 58.9 ms | +10.8 ms |
| `eu-sto->na-chi` | `gate-eu-ams-01 -> gate-na-nyc-01` | 130.5 ms | 109.7 ms | +20.8 ms | 68.4 ms | 58.0 ms | +10.4 ms | 62.0 ms | 51.6 ms | +10.4 ms |

## Biggest RTT Regressions

| Pair | Hyperspace path | Public RTT p50 | Hyperspace RTT p50 | Delta RTT | Public fwd | Hyperspace fwd | Delta fwd | Public rev | Hyperspace rev | Delta rev |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `ap-syd->na-sjc` | `gate-ap-sin-01 -> gate-na-nyc-01` | 148.8 ms | 394.4 ms | -245.6 ms | 74.6 ms | 190.1 ms | -115.6 ms | 74.2 ms | 204.2 ms | -130.0 ms |
| `na-sjc->ap-syd` | `gate-na-nyc-01 -> gate-ap-sin-01` | 148.8 ms | 382.2 ms | -233.4 ms | 74.2 ms | 191.9 ms | -117.7 ms | 74.6 ms | 190.3 ms | -115.8 ms |
| `na-sjc->na-chi` | `gate-na-nyc-01 -> gate-eu-fra-01` | 81.5 ms | 268.6 ms | -187.0 ms | 43.9 ms | 126.8 ms | -82.9 ms | 37.6 ms | 141.8 ms | -104.2 ms |
| `na-chi->ap-syd` | `gate-na-nyc-01 -> gate-ap-sin-01` | 184.4 ms | 346.4 ms | -162.0 ms | 88.9 ms | 176.6 ms | -87.7 ms | 95.4 ms | 169.7 ms | -74.3 ms |
| `ap-syd->na-chi` | `gate-ap-sin-01 -> gate-na-nyc-01` | 184.3 ms | 334.6 ms | -150.3 ms | 95.5 ms | 169.5 ms | -74.0 ms | 88.8 ms | 165.1 ms | -76.3 ms |

## Full Directed Matrix

| Pair | Hyperspace path | Public RTT p50 | Hyperspace RTT p50 | Delta RTT | Public fwd | Hyperspace fwd | Delta fwd | Public rev | Hyperspace rev | Delta rev |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `ap-syd->eu-mad` | `gate-ap-sin-01 -> gate-eu-ams-01` | 322.3 ms | 280.8 ms | +41.5 ms | 167.6 ms | 149.8 ms | +17.7 ms | 154.7 ms | 130.9 ms | +23.8 ms |
| `ap-syd->eu-sto` | `gate-ap-sin-01 -> gate-eu-ams-01` | 332.3 ms | 404.9 ms | -72.6 ms | 169.8 ms | 142.6 ms | +27.2 ms | 162.5 ms | 262.2 ms | -99.8 ms |
| `ap-syd->na-chi` | `gate-ap-sin-01 -> gate-na-nyc-01` | 184.3 ms | 334.6 ms | -150.3 ms | 95.5 ms | 169.5 ms | -74.0 ms | 88.8 ms | 165.1 ms | -76.3 ms |
| `ap-syd->na-sjc` | `gate-ap-sin-01 -> gate-na-nyc-01` | 148.8 ms | 394.4 ms | -245.6 ms | 74.6 ms | 190.1 ms | -115.6 ms | 74.2 ms | 204.2 ms | -130.0 ms |
| `eu-mad->ap-syd` | `gate-eu-ams-01 -> gate-ap-sin-01` | 283.0 ms | 419.0 ms | -136.0 ms | 154.5 ms | 269.2 ms | -114.7 ms | 128.5 ms | 149.8 ms | -21.3 ms |
| `eu-mad->eu-sto` | `gate-eu-ams-01 -> gate-eu-lon-01` | 44.2 ms | 62.5 ms | -18.3 ms | 16.4 ms | 21.8 ms | -5.3 ms | 27.7 ms | 40.7 ms | -13.0 ms |
| `eu-mad->na-chi` | `gate-eu-ams-01 -> gate-na-nyc-01` | 134.4 ms | 112.8 ms | +21.6 ms | 64.7 ms | 53.8 ms | +10.9 ms | 69.6 ms | 58.9 ms | +10.8 ms |
| `eu-mad->na-sjc` | `gate-eu-ams-01 -> gate-na-nyc-01` | 159.9 ms | 160.5 ms | -0.6 ms | 74.4 ms | 74.5 ms | -0.2 ms | 85.5 ms | 85.9 ms | -0.4 ms |
| `eu-sto->ap-syd` | `gate-eu-ams-01 -> gate-ap-sin-01` | 330.1 ms | 275.7 ms | +54.4 ms | 162.6 ms | 133.1 ms | +29.5 ms | 167.5 ms | 142.5 ms | +25.0 ms |
| `eu-sto->eu-mad` | `gate-eu-ams-01 -> gate-eu-lon-01` | 44.2 ms | 61.8 ms | -17.7 ms | 27.7 ms | 33.2 ms | -5.5 ms | 16.4 ms | 28.6 ms | -12.2 ms |
| `eu-sto->na-chi` | `gate-eu-ams-01 -> gate-na-nyc-01` | 130.5 ms | 109.7 ms | +20.8 ms | 68.4 ms | 58.0 ms | +10.4 ms | 62.0 ms | 51.6 ms | +10.4 ms |
| `eu-sto->na-sjc` | `gate-eu-ams-01 -> gate-na-nyc-01` | 156.8 ms | 157.5 ms | -0.7 ms | 78.5 ms | 78.8 ms | -0.3 ms | 78.3 ms | 78.7 ms | -0.4 ms |
| `na-chi->ap-syd` | `gate-na-nyc-01 -> gate-ap-sin-01` | 184.4 ms | 346.4 ms | -162.0 ms | 88.9 ms | 176.6 ms | -87.7 ms | 95.4 ms | 169.7 ms | -74.3 ms |
| `na-chi->eu-mad` | `gate-na-nyc-01 -> gate-eu-ams-01` | 134.4 ms | 112.8 ms | +21.6 ms | 69.7 ms | 58.9 ms | +10.8 ms | 64.7 ms | 53.9 ms | +10.8 ms |
| `na-chi->eu-sto` | `gate-na-nyc-01 -> gate-eu-ams-01` | 130.5 ms | 109.7 ms | +20.8 ms | 62.1 ms | 51.6 ms | +10.4 ms | 68.4 ms | 58.0 ms | +10.4 ms |
| `na-chi->na-sjc` | `gate-na-nyc-01 -> gate-eu-ams-01` | 81.5 ms | 225.5 ms | -143.9 ms | 37.6 ms | 109.4 ms | -71.8 ms | 43.9 ms | 116.0 ms | -72.1 ms |
| `na-sjc->ap-syd` | `gate-na-nyc-01 -> gate-ap-sin-01` | 148.8 ms | 382.2 ms | -233.4 ms | 74.2 ms | 191.9 ms | -117.7 ms | 74.6 ms | 190.3 ms | -115.8 ms |
| `na-sjc->eu-mad` | `gate-na-nyc-01 -> gate-eu-ams-01` | 159.9 ms | 160.6 ms | -0.7 ms | 85.5 ms | 86.0 ms | -0.5 ms | 74.3 ms | 74.5 ms | -0.2 ms |
| `na-sjc->eu-sto` | `gate-na-nyc-01 -> gate-eu-ams-01` | 156.8 ms | 157.5 ms | -0.7 ms | 78.4 ms | 78.8 ms | -0.5 ms | 78.4 ms | 78.7 ms | -0.2 ms |
| `na-sjc->na-chi` | `gate-na-nyc-01 -> gate-eu-fra-01` | 81.5 ms | 268.6 ms | -187.0 ms | 43.9 ms | 126.8 ms | -82.9 ms | 37.6 ms | 141.8 ms | -104.2 ms |
