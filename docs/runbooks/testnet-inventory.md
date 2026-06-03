# Testnet Inventory

| Role | Hostname | Notes |
| --- | --- | --- |
| Web | `app.testnet.hyperspace.zone` | Static web app and Caddy |
| Control plane | `control-plane.testnet.hyperspace.zone` | API and worker |
| Database | `db.testnet.hyperspace.zone` | PostgreSQL |
| Observability | `observability.testnet.hyperspace.zone` | Prometheus and Grafana |
| FRA gate | `gate-eu-fra-01.testnet.hyperspace.zone` | DoubleZero gate |
| AMS gate | `gate-eu-ams-01.testnet.hyperspace.zone` | DoubleZero gate |
| LON gate | `gate-eu-lon-01.testnet.hyperspace.zone` | DoubleZero gate |
| NYC gate | `gate-na-nyc-01.testnet.hyperspace.zone` | DoubleZero gate |
| SIN gate | `gate-ap-sin-01.testnet.hyperspace.zone` | DoubleZero gate |

All gate-to-gate traffic must route through `doublezero0`. The scheduler should
treat missing DoubleZero reachability as a gate readiness or path eligibility
failure.
