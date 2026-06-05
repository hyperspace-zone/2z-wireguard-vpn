# Cluster Inventory Template

Copy this template into your private operations repository and fill it with
your own hosts. Do not commit production IPs, access tokens, private keys, or
WireGuard configs to this repository.

## Control Plane

| Role | DNS / IP | Notes |
| --- | --- | --- |
| Web | `<web-domain>` | Static UI and HTTPS reverse proxy |
| Control plane | `<control-plane-domain>` | API and worker services |
| PostgreSQL | `<private-db-host>` | Private network only |
| Observability | `<observability-domain>` | Optional Prometheus/Grafana |

## Gates

| Gate name | DNS / IP | City | Country | DoubleZero env | `access-pass` verified | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `<gate-ingress-01>` | `<public-ip-or-dns>` | `<city>` | `<country>` | `testnet` or `mainnet-beta` | `no` | Candidate ingress |
| `<gate-egress-01>` | `<public-ip-or-dns>` | `<city>` | `<country>` | `testnet` or `mainnet-beta` | `no` | Candidate egress |

## Required Gate Checks

Run on every gate before marking it schedulable:

```bash
doublezero config set --env <testnet-or-mainnet-beta> --keypair ~/.config/doublezero/id.json
doublezero address
doublezero access-pass list | grep "$(doublezero address)"
doublezero connect ibrl
doublezero status
ip link show doublezero0
```

The control plane should treat missing DoubleZero reachability as a gate
readiness or path eligibility failure.
