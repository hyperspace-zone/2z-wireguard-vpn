# Deployment Guide

This guide describes a bare-metal deployment of DoubleZero WireGuard VPN. It
does not assume any Hyperspace-owned servers. Replace every placeholder with
your own DNS names, public IPs, secrets, and gate metadata.

The deployment can target DoubleZero testnet or DoubleZero mainnet-beta. Choose
the DoubleZero environment before requesting `access-pass` records and use that
same environment everywhere: DoubleZero CLI, `doublezerod`, gate catalog, and
control-plane gate metadata.

## Required Hosts

Absolute minimum for a first deployment is three servers:

| Server | Role |
| --- | --- |
| 1 | Web UI, control-plane API, control-plane worker, and PostgreSQL |
| 2 | Ingress gate |
| 3 | Egress gate |

The two gate servers must be separate hosts and each must have its own
DoubleZero `access-pass`.

Minimum production-like layout:

| Role | Minimum count | Notes |
| --- | ---: | --- |
| Web | 1 | Static UI behind HTTPS. Can share the control-plane host for small deployments. |
| Control plane | 1 | Runs API and worker systemd services. |
| PostgreSQL | 1 | Transaction source of truth. Keep private. |
| Gate | 2 | Minimum for distinct ingress and egress routing. Each gate must expose HTTPS probes. |
| Observability | 0-1 | Recommended for Prometheus, Grafana, and exporters. |

For small test deployments, web, control-plane, and PostgreSQL can be collapsed
onto one host. Gate hosts should remain separate from the control plane.

## Choose DoubleZero Environment

Pick exactly one DoubleZero environment for the cluster before provisioning
gates:

| Target | Set `DZ_ENV` to | Notes |
| --- | --- | --- |
| DoubleZero testnet | `testnet` | Use for integration, demos, and non-production validation. |
| DoubleZero mainnet-beta | `mainnet-beta` | Use only with mainnet-beta `access-pass` records issued for the same gate identities and public IPs. |

Export the selected value in every shell session used for gate setup:

```bash
export DZ_ENV=testnet
# or:
export DZ_ENV=mainnet-beta
```

Do not mix environments. A gate with a `testnet` `access-pass` must run
`doublezero`, `doublezerod`, and the Hyperspace gate catalog entry with
`DZ_ENV=testnet`. A gate with a `mainnet-beta` `access-pass` must use
`DZ_ENV=mainnet-beta` consistently.

## TLS Requirements

Do not run browser, automation, or gate-agent traffic over plain HTTP. The web
UI, public API, gate-agent API, and browser gate probes must all use HTTPS.

Use normal Let's Encrypt domain certificates when stable DNS names are
available. If a bootstrap or disposable cluster only has public IP addresses,
use Let's Encrypt IP address certificates. IP address certificates require
Certbot 5.4 or newer, the `--ip-address` option, and the Let's Encrypt
`shortlived` profile.

Install Certbot outside Docker:

```bash
apt-get update
apt-get install -y python3-venv
python3 -m venv /opt/certbot-venv
/opt/certbot-venv/bin/pip install --upgrade pip certbot
/opt/certbot-venv/bin/certbot --version
```

Prepare a webroot for HTTP-01 challenges:

```bash
install -d -o root -g root -m 0755 /var/www/acme-challenges
```

During bootstrap, configure Caddy on port 80 to serve only
`/.well-known/acme-challenge/*` from that webroot and to redirect all other
HTTP traffic to HTTPS. Use two `handle` blocks so Caddy directive ordering does
not redirect ACME challenge files:

```caddy
{
  auto_https disable_redirects
}

:80 {
  @acme path /.well-known/acme-challenge/*
  handle @acme {
    root * /var/www/acme-challenges
    file_server
  }

  handle {
    redir https://{host}{uri} permanent
  }
}
```

Request an IP address certificate:

```bash
/opt/certbot-venv/bin/certbot certonly \
  --webroot \
  --webroot-path /var/www/acme-challenges \
  --ip-address <public-ip> \
  --preferred-profile shortlived \
  --agree-tos \
  --email <ops-email> \
  --non-interactive
```

For a DNS name, replace `--ip-address <public-ip>` with
`-d <public-domain-name>`. Keep HTTPS mandatory either way.

Certbot stores certificates under `/etc/letsencrypt/live/<name>/`. Copy them to
a Caddy-readable location and keep private keys group-readable only by Caddy:

```bash
cat >/usr/local/sbin/hyperspace-sync-ip-cert <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
name="${1:?certificate name or IP required}"
install -d -o root -g caddy -m 0750 "/etc/caddy/certs/${name}"
install -o root -g caddy -m 0640 "/etc/letsencrypt/live/${name}/fullchain.pem" "/etc/caddy/certs/${name}/fullchain.pem"
install -o root -g caddy -m 0640 "/etc/letsencrypt/live/${name}/privkey.pem" "/etc/caddy/certs/${name}/privkey.pem"
SCRIPT
chmod 0755 /usr/local/sbin/hyperspace-sync-ip-cert
/usr/local/sbin/hyperspace-sync-ip-cert <public-ip-or-cert-name>
```

Create a deploy hook for renewal:

```bash
cat >/usr/local/sbin/hyperspace-sync-certs-and-reload <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
/usr/local/sbin/hyperspace-sync-ip-cert <public-ip-or-cert-name>
systemctl reload caddy
SCRIPT
chmod 0755 /usr/local/sbin/hyperspace-sync-certs-and-reload
```

Install renewal checks. Short-lived IP certificates expire in about six days, so
run renewal checks at least twice per day:

```ini
# /etc/systemd/system/hyperspace-certbot-renew.service
[Unit]
Description=Renew Hyperspace short-lived certificates

[Service]
Type=oneshot
ExecStart=/opt/certbot-venv/bin/certbot renew --quiet --no-random-sleep-on-renew --deploy-hook /usr/local/sbin/hyperspace-sync-certs-and-reload
```

```ini
# /etc/systemd/system/hyperspace-certbot-renew.timer
[Unit]
Description=Run Hyperspace certificate renewal checks

[Timer]
OnBootSec=10min
OnUnitActiveSec=12h
RandomizedDelaySec=30min
Persistent=true

[Install]
WantedBy=timers.target
```

The deploy hook should copy renewed certificates into `/etc/caddy/certs` and
reload Caddy. Validate renewal before accepting users:

```bash
/opt/certbot-venv/bin/certbot renew \
  --dry-run \
  --no-random-sleep-on-renew \
  --deploy-hook /usr/local/sbin/hyperspace-sync-certs-and-reload
```

After Caddy is serving HTTPS, verify the certificate contains the expected
domain or IP subject alternative name:

```bash
echo | openssl s_client -connect <public-ip-or-domain>:443 -servername <public-ip-or-domain> 2>/dev/null \
  | openssl x509 -noout -issuer -dates -ext subjectAltName
```

## Gate Prerequisites

Every gate host must have:

- Stable public IPv4 address.
- Linux with systemd.
- `wireguard-tools`, `iproute2`, `nftables`, `curl`, and `jq`.
- DoubleZero client and daemon installed.
- DoubleZero identity/keypair.
- DoubleZero `access-pass` issued for the gate public IP and identity.
- A working `doublezero0` interface after `doublezero connect`.

Verify on each gate:

```bash
export DZ_ENV=testnet
# or:
# export DZ_ENV=mainnet-beta

doublezero config set --env "$DZ_ENV" --keypair ~/.config/doublezero/id.json
doublezero address
doublezero access-pass list | grep "$(doublezero address)"
doublezero connect ibrl
doublezero status
ip link show doublezero0
```

If the packaged `doublezerod.service` starts in a different environment than
the target deployment, add a systemd drop-in before connecting:

```bash
export DZ_ENV=testnet
# or:
# export DZ_ENV=mainnet-beta

install -d /etc/systemd/system/doublezerod.service.d
cat >/etc/systemd/system/doublezerod.service.d/10-env.conf <<EOF
[Service]
ExecStart=
ExecStart=/usr/bin/doublezerod -sock-file /run/doublezerod/doublezerod.sock -env ${DZ_ENV}
EOF
```

Then run:

```bash
systemctl daemon-reload
systemctl restart doublezerod
doublezero --env "$DZ_ENV" --keypair ~/.config/doublezero/id.json connect ibrl
```

The `access-pass` row must match the `doublezero address` output and the public
IPv4 address of that gate. The DoubleZero troubleshooting guide documents this
verification flow:

https://docs.malbeclabs.com/troubleshooting/

Access is permissioned. If you do not have matching `access-pass` records,
contact the DoubleZero team through the official New Tenant contact form:

https://docs.malbeclabs.com/New%20Tenant/

## Database

Install PostgreSQL as a native package:

```bash
apt-get update
apt-get install -y postgresql postgresql-contrib
```

Create the application database and least-privilege user. Keep PostgreSQL
private to the control-plane host or private network.

Run migrations from the control-plane checkout:

```bash
npm install
npm run build
DATABASE_URL=postgres://<user>:<password>@<db-host>:5432/<db-name> npm run db:migrate
```

Configure backups and test restore before accepting users.

## Control Plane

Install Node.js active LTS, build the workspace, and install:

- `hyperspace-control-plane-api.service`
- `hyperspace-control-plane-worker.service`

Create `/etc/hyperspace/control-plane-api.env`:

```bash
HOST=127.0.0.1
PORT=8080
DATABASE_URL=postgres://<user>:<password>@<db-host>:5432/<db-name>
AUTH_SESSION_TTL_SECONDS=2592000
ARTIFACT_DOWNLOAD_TTL_SECONDS=300
ADMIN_TOKEN=<random-admin-token>
ARTIFACT_ENCRYPTION_KEY=<32-byte-base64url-key>
```

Create `/etc/hyperspace/control-plane-worker.env`:

```bash
DATABASE_URL=postgres://<user>:<password>@<db-host>:5432/<db-name>
WORKER_POLL_MS=2000
WORKER_ID=control-plane-worker-01
ARTIFACT_ENCRYPTION_KEY=<same-32-byte-base64url-key>
```

`ARTIFACT_ENCRYPTION_KEY` must be identical for API and worker. Do not rotate it
without a migration plan for existing artifacts.

Install Caddy or another reverse proxy for the public control-plane API host.
The API must be reachable by browsers, automation clients, and gate agents over
HTTPS. Browsers and gate agents must use the same externally reachable HTTPS
origin.

## Gate Catalog

Create your own gate inventory from the example in `infra/gates.example.json`.
Use real values:

```json
[
  {
    "name": "gate-ingress-01",
    "identity": "replace-with-doublezero-address-ingress",
    "region": "example-ingress",
    "city": "Example City",
    "country": "Example Country",
    "countryCode": "EX",
    "publicEndpoint": "203.0.113.10",
    "probeUrl": "https://gate-ingress-01.example.net/.well-known/hyperspace-probe",
    "doubleZeroEnv": "testnet",
    "schedulingWeight": 100,
    "capacityLimit": 128
  }
]
```

`identity` is the DoubleZero `user_payer` identity for the gate. Use the exact
output of `doublezero address` on that gate host. The same identity and public
endpoint must be authorized by the gate's DoubleZero `access-pass`.

Set `doubleZeroEnv` to the same value as `DZ_ENV` for every gate:
`testnet` for DoubleZero testnet clusters, or `mainnet-beta` for DoubleZero
mainnet-beta clusters.

Seed gates into PostgreSQL for an interactive operator flow:

```bash
npm run db:seed:gates -- /path/to/your-gates.json
```

The seed command prints per-gate tokens. Store each token only on the
corresponding gate host.

For automation, use the quiet JSON entrypoint. It suppresses build output and
writes machine-readable JSON only to stdout:

```bash
scripts/seed-gates-json /path/to/your-gates.json | jq .
```

The seed command validates the gate catalog before writing to PostgreSQL:
`identity` must be non-empty and unique, `publicEndpoint` must be IPv4, and
`doubleZeroEnv` must be `testnet` or `mainnet-beta`.

## Gate Agents

Install the `hyperspace-gate-agent` binary and
`hyperspace-gate-agent.service` on each gate.

Create `/etc/hyperspace/gate-agent.env` on each gate:

```bash
CONTROL_PLANE_URL=https://<control-plane-domain-or-ip>
GATE_NAME=<gate-name-from-catalog>
GATE_TOKEN=<issued-gate-token>
POLL_INTERVAL=2s
HEARTBEAT_INTERVAL=10s
GATE_AGENT_EXECUTION_MODE=apply
GATE_AGENT_STATE_DIR=/var/lib/hyperspace-gate
```

Enable a gate only after:

1. `doublezero0` is up.
2. `wg`, `ip`, and `nft` are present.
3. `doublezero status` reports `BGP Session Up`.
4. `doublezero status` network matches the gate catalog `doubleZeroEnv`.
5. `doublezero status` tunnel source matches the gate catalog `publicEndpoint`.
6. The gate heartbeat is visible in the control plane.
7. Actual-state reporting works.
8. The gate can reach at least one other gate through DoubleZero.

Execution modes:

- `apply`: mutate host WireGuard, route, and nftables state.
- `observe`: report health and actual state, but refuse mutation jobs.
- `ack`: acknowledge jobs without host mutation; only for control-plane tests.

## Web

Build the UI and sync static assets to your web host:

```bash
npm run build -w @hyperspace-zone/web
```

Serve the static directory through HTTPS. Reverse proxy `/api/*` to the
control-plane API and strip the `/api` prefix. If the web UI and API are
collapsed onto the same host, also expose `/v1/*` directly for gate agents and
automation clients over the same HTTPS host. See
`infra/caddy/Caddyfile.combined.example`.

## Browser Gate Probes

Browser RTT measurement requires each gate to expose an HTTPS probe endpoint:

```text
GET /.well-known/hyperspace-probe -> 204 No Content
```

Enable CORS and Timing-Allow-Origin for your web UI origin. See
`infra/caddy/Caddyfile.gate-probe.example` and replace all placeholders.

## Validation

Before giving the UI to users, validate:

1. Register and log in.
2. Create an IP-to-target config with explicit ingress and egress gates.
3. Download and start the WireGuard config on a client.
4. Verify the target is reachable through the selected egress.
5. Verify a non-target IP is not reachable through the restricted config.
6. Revoke the config and verify traffic stops.
7. Create a config with a user-provided WireGuard public key and verify that
   only the matching private key can connect.
8. Create a full-tunnel config from a disposable client and verify egress IP.

Keep validation clients separate from gate hosts so the results reflect the
user path.

## Observability

Recommended components:

- Prometheus for metrics.
- Grafana for dashboards.
- node_exporter on every host.
- postgres_exporter on the database host.

Track at minimum: gate readiness, gate heartbeat age, provisioning latency,
revocation latency, reconciliation retries, dead jobs, active sessions, address
lease counts, and artifact issuance/download events.
