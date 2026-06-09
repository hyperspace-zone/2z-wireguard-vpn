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

## Bootstrap Variables

Set these variables before following the copy/paste examples. Keep the same
values across the control-plane and gate hosts where applicable:

```bash
export HS_REPO_URL=https://github.com/hyperspace-zone/2z-wireguard-vpn.git
export HS_REPO_DIR=/opt/2z-wireguard-vpn
export HS_WEB_HOST=<web-public-ip-or-domain>
export HS_API_HOST=<control-plane-public-ip-or-domain>
export HS_WEB_ORIGIN=https://$HS_WEB_HOST
export HS_API_ORIGIN=https://$HS_API_HOST
export OPS_EMAIL=<ops-email-for-letsencrypt>

export DZ_ENV=mainnet-beta
# or:
# export DZ_ENV=testnet
```

For the minimum combined-host deployment, set `HS_WEB_HOST` and `HS_API_HOST`
to the same public IP address or DNS name. For a split deployment, set
`HS_WEB_HOST` to the web UI host and `HS_API_HOST` to the public control-plane
API host. The web UI should call the API through `/api/*` on the web origin;
gate agents and automation clients should call `HS_API_ORIGIN` directly.

Use an operations email for real deployments. For short-lived disposable tests
only, Certbot can be run with `--register-unsafely-without-email` instead of
`--email "$OPS_EMAIL"`, but do not use that for production-like clusters.

## Reused Hosts

If a host was used for an older Hyperspace deployment, stop conflicting services
before installing the current platform. Do this only after confirming the host
is not serving other traffic:

```bash
systemctl disable --now nginx 2>/dev/null || true
systemctl disable --now hyperspace-gate-probe 2>/dev/null || true
systemctl disable --now hyperspace-gate-agent 2>/dev/null || true

ss -ltnup | grep -E ':(80|443|9443)\b' || true
```

Current gate-agent env names are `CONTROL_PLANE_URL`, `GATE_NAME`,
`POLL_INTERVAL`, and `HEARTBEAT_INTERVAL`. Legacy names such as `API_URL`,
`GATE_ID`, and `POLL_INTERVAL_SEC` are not used by the current agent.

## SSH Host Key Verification

If a server was reimaged, its SSH host key should change. Treat any
`known_hosts` mismatch as a stop-and-verify event instead of blindly disabling
host key checks.

From the operator workstation, collect the expected fingerprint and compare it
with the provider console or another trusted out-of-band source:

```bash
export BOOTSTRAP_HOST=<public-ip-or-domain>
ssh-keyscan -t ed25519 "$BOOTSTRAP_HOST" >"/tmp/${BOOTSTRAP_HOST}.ed25519"
ssh-keygen -lf "/tmp/${BOOTSTRAP_HOST}.ed25519"
```

Only after the fingerprint is confirmed, update local trust:

```bash
ssh-keygen -R "$BOOTSTRAP_HOST"
install -d -m 0700 ~/.ssh
cat "/tmp/${BOOTSTRAP_HOST}.ed25519" >> ~/.ssh/known_hosts
```

## TLS Requirements

Do not run browser, automation, or gate-agent traffic over plain HTTP. The web
UI, public API, gate-agent API, and browser gate probes must all use HTTPS.
Run the role-specific package installation sections before applying Caddy
configuration; the control-plane and gate package lists both install Caddy.

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
  --email "$OPS_EMAIL" \
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

After writing both unit files, enable the renewal timer:

```bash
systemctl daemon-reload
systemctl enable --now hyperspace-certbot-renew.timer
systemctl list-timers --all | grep hyperspace-certbot-renew
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

Install base packages on each gate:

```bash
apt-get update
apt-get install -y \
  ca-certificates \
  curl \
  git \
  gnupg \
  build-essential \
  gettext-base \
  jq \
  wireguard-tools \
  iproute2 \
  nftables \
  caddy
```

Install the DoubleZero CLI and daemon by following the official DoubleZero
connect documentation for the stable package/version:

https://docs.malbeclabs.com/connect/

The DoubleZero repository documents the Cloudsmith APT setup flow for Ubuntu:

```bash
curl -1sLf \
  'https://dl.cloudsmith.io/public/malbeclabs/doublezero/setup.deb.sh' \
  | bash

apt-get update
apt-cache policy doublezero

# Optional but recommended for production reproducibility:
# export DOUBLEZERO_VERSION=<tested-version>
if [ -n "${DOUBLEZERO_VERSION:-}" ]; then
  apt-get install -y "doublezero=${DOUBLEZERO_VERSION}"
else
  apt-get install -y doublezero
fi

install -d -o root -g root -m 0750 /etc/hyperspace
dpkg-query -W -f='${Package} ${Version}\n' doublezero \
  | tee /etc/hyperspace/doublezero-version.txt
```

If DoubleZero documentation specifies a pinned package version for your target
network, install that exact version instead of the unpinned package. If you use
the unpinned package, keep `/etc/hyperspace/doublezero-version.txt` with the
deployment evidence so the installed version is explicit.

Configure the DoubleZero keypair and verify the `access-pass` on each gate:

```bash
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
install -d /etc/systemd/system/doublezerod.service.d
cat >/etc/systemd/system/doublezerod.service.d/10-env.conf <<EOF
[Service]
ExecStart=
ExecStart=/usr/bin/doublezerod -sock-file /run/doublezerod/doublezerod.sock -env ${DZ_ENV}
EOF
```

This drop-in deliberately uses the `DZ_ENV` selected in Bootstrap Variables.
Do not switch `DZ_ENV` between `testnet` and `mainnet-beta` after an
`access-pass` has been issued for a gate.

Then run:

```bash
systemctl daemon-reload
systemctl enable --now doublezerod
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

Enable IPv4 forwarding on each gate:

```bash
cat >/etc/sysctl.d/99-hyperspace-gate.conf <<'EOF'
net.ipv4.ip_forward=1
EOF
sysctl --system
```

Open the required firewall/security-group paths:

| Direction | Protocol/port | Purpose |
| --- | --- | --- |
| Internet to web/control-plane | TCP 80, 443 | ACME challenge, web UI, public API, gate-agent API. |
| Internet to each gate | TCP 80, 443 | ACME challenge and browser RTT probe. |
| Each gate to control-plane | TCP 443 | Gate heartbeat and reconciliation jobs. |
| Between DoubleZero clients | UDP 44880 | DoubleZero route-liveness traffic. |
| WireGuard clients to ingress gates | UDP listen ports assigned by Hyperspace | Client tunnel traffic. Keep the assigned/dynamic UDP range open, or open the intended WireGuard UDP ports until the range is constrained in deployment config. |
| Egress gates to targets | As required by policy | User traffic exiting through the selected egress gate. |

Provisioning can succeed while client traffic still fails if the cloud firewall
blocks the assigned WireGuard UDP port on the ingress gate.

## Control-Plane Host Bootstrap

Run these steps on the host that will run the web UI, API, worker, and
PostgreSQL for the minimum three-server deployment.

Install base packages:

```bash
apt-get update
apt-get install -y \
  ca-certificates \
  curl \
  git \
  gnupg \
  build-essential \
  gettext-base \
  jq \
  rsync \
  caddy
```

Install Node.js 24 or another Node.js release satisfying `node >=22`. The
Ubuntu 24.04 `nodejs` package can resolve to Node 18, which is too old for this
workspace. One bare-metal option is NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs
node --version
npm --version
```

Create the system user and file layout expected by the systemd units:

```bash
adduser --system --group --home "$HS_REPO_DIR" --no-create-home hyperspace
install -d -o hyperspace -g hyperspace -m 0755 "$HS_REPO_DIR"
install -d -o root -g hyperspace -m 0750 /etc/hyperspace
```

Check out and build the repository:

```bash
git clone "$HS_REPO_URL" "$HS_REPO_DIR"
chown -R hyperspace:hyperspace "$HS_REPO_DIR"

cd "$HS_REPO_DIR"
sudo -u hyperspace npm ci
sudo -u hyperspace npm run build
sudo -u hyperspace npm run typecheck
sudo -u hyperspace npm test --workspaces --if-present
```

These workspace tests are local regression tests. They do not run the
long-running public/Hyperspace connectivity matrix.

The TypeScript backend is organized as a modular monolith: thin API and worker
entrypoints in `apps/*` call domain/application code from
`packages/control-plane`, while API/resource contracts live in
`packages/contracts`. Always build and typecheck the full workspace after a
checkout or upgrade so route, reconciler, repository, and contract boundaries
are validated together.

## Database

Install PostgreSQL as a native package. Keep PostgreSQL private to the
control-plane host or a private network; do not expose it on the public
Internet.

```bash
apt-get update
apt-get install -y postgresql postgresql-contrib
```

Create the application database and least-privilege user:

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE hyperspace LOGIN PASSWORD '<replace-with-strong-db-password>';
CREATE DATABASE hyperspace OWNER hyperspace;
SQL
```

Use this connection string in the API, worker, seed, and migration commands:

```bash
export DATABASE_URL='postgres://hyperspace:<replace-with-strong-db-password>@127.0.0.1:5432/hyperspace'
```

Run migrations from the control-plane checkout after `npm ci` and build:

```bash
cd "$HS_REPO_DIR"
sudo -u hyperspace env DATABASE_URL="$DATABASE_URL" npm run db:migrate
```

Configure backups and test restore before accepting users.

## Control Plane

Generate secrets on the control-plane host:

```bash
export ADMIN_TOKEN="$(openssl rand -hex 32)"
export ARTIFACT_ENCRYPTION_KEY="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')"
```

Create `/etc/hyperspace/control-plane-api.env`:

```bash
cat >/etc/hyperspace/control-plane-api.env <<EOF
HOST=127.0.0.1
PORT=8080
DATABASE_URL=${DATABASE_URL}
AUTH_SESSION_TTL_SECONDS=2592000
ARTIFACT_DOWNLOAD_TTL_SECONDS=300
ADMIN_TOKEN=${ADMIN_TOKEN}
ARTIFACT_ENCRYPTION_KEY=${ARTIFACT_ENCRYPTION_KEY}
EOF
chown root:hyperspace /etc/hyperspace/control-plane-api.env
chmod 0640 /etc/hyperspace/control-plane-api.env
```

Create `/etc/hyperspace/control-plane-worker.env` with the same
`ARTIFACT_ENCRYPTION_KEY`:

```bash
cat >/etc/hyperspace/control-plane-worker.env <<EOF
DATABASE_URL=${DATABASE_URL}
WORKER_POLL_MS=2000
WORKER_ID=control-plane-worker-01
ARTIFACT_ENCRYPTION_KEY=${ARTIFACT_ENCRYPTION_KEY}
EOF
chown root:hyperspace /etc/hyperspace/control-plane-worker.env
chmod 0640 /etc/hyperspace/control-plane-worker.env
```

`ARTIFACT_ENCRYPTION_KEY` must be identical for API and worker. Do not rotate it
without a migration plan for existing artifacts.

Install and start the API and worker units:

```bash
cd "$HS_REPO_DIR"
install -o root -g root -m 0644 infra/systemd/hyperspace-control-plane-api.service /etc/systemd/system/
install -o root -g root -m 0644 infra/systemd/hyperspace-control-plane-worker.service /etc/systemd/system/

systemctl daemon-reload
systemctl enable --now hyperspace-control-plane-api
systemctl enable --now hyperspace-control-plane-worker
systemctl status --no-pager hyperspace-control-plane-api
systemctl status --no-pager hyperspace-control-plane-worker
```

Install Caddy or another reverse proxy for the public control-plane API host.
The API must be reachable by browsers, automation clients, and gate agents over
HTTPS. In a combined deployment, the web UI and API share one origin. In a split
deployment, browsers use the web origin and reach the API through the web
host's `/api/*` reverse proxy, while gate agents and automation clients use the
API origin directly.

For a combined web/API/control-plane host, copy the current web build and render
the provided Caddyfile. The provided template intentionally uses shell-style
`${APP_HOST}` variables because it is rendered with `envsubst`; do not replace
them with Caddy runtime `{$APP_HOST}` syntax when using this flow:

```bash
install -d -o caddy -g caddy -m 0755 /var/www/hyperspace-web
rsync -a --delete "$HS_REPO_DIR/apps/web/dist/" /var/www/hyperspace-web/

export APP_HOST="$HS_WEB_HOST"
export TLS_FULLCHAIN=/etc/caddy/certs/"$HS_WEB_HOST"/fullchain.pem
export TLS_PRIVKEY=/etc/caddy/certs/$"HS_WEB_HOST"/privkey.pem
: "${APP_HOST:?APP_HOST is required}"
: "${TLS_FULLCHAIN:?TLS_FULLCHAIN is required}"
: "${TLS_PRIVKEY:?TLS_PRIVKEY is required}"
envsubst < "$HS_REPO_DIR/infra/caddy/Caddyfile.combined.example" > /etc/caddy/Caddyfile
if grep -n '\${' /etc/caddy/Caddyfile; then
  echo "unrendered Caddy template variables remain" >&2
  exit 1
fi
caddy fmt --overwrite /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl enable --now caddy
systemctl reload caddy
```

Health check paths depend on which host you call:

```bash
wait_https() {
  url="${1:?url required}"
  for i in $(seq 1 30); do
    if curl -fsS "$url"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# API origin directly:
wait_https https://<api-host>/health
wait_https https://<api-host>/v1/public/health

# Web/API host where /api/* is proxied to the API:
wait_https https://<web-host>/api/health
wait_https https://<web-host>/api/v1/public/health
```

The API exposes OpenAPI at `/openapi.json`. If callers enter through the web
host's `/api/*` reverse proxy, use `/api/openapi.json` instead:

```bash
# API origin directly:
curl -fsS https://<api-host>/openapi.json | jq '.paths["/health"]'

# Web host reverse proxy:
curl -fsS https://<web-host>/api/openapi.json | jq '.paths["/v1/public/health"]'
```

Every registered route, including health routes, should have a runtime schema
and appear in the generated OpenAPI document.

## Upgrading an Existing Deployment

For an existing cluster, update the control-plane host before publishing static
web assets. This keeps migrations, API code, worker code, contracts, and the web
bundle aligned. The long-running public-vs-Hyperspace measurement matrix is not
part of the routine upgrade path; run it only when collecting placement or
milestone evidence.

On the control-plane host:

```bash
cd "$HS_REPO_DIR"

# If this host has a git checkout:
sudo -u hyperspace git fetch --all --prune
sudo -u hyperspace git checkout main
sudo -u hyperspace git pull --ff-only

# If this host receives release files by rsync instead of git, sync the new
# tree from your operator workstation first, excluding node_modules and dist.

chown -R hyperspace:hyperspace "$HS_REPO_DIR"
sudo -u hyperspace npm ci
sudo -u hyperspace npm run build
sudo -u hyperspace npm run typecheck
sudo -u hyperspace npm test --workspaces --if-present

set -a
. /etc/hyperspace/control-plane-api.env
set +a
sudo -u hyperspace env DATABASE_URL="$DATABASE_URL" npm run db:migrate

install -o root -g root -m 0644 infra/systemd/hyperspace-control-plane-api.service /etc/systemd/system/
install -o root -g root -m 0644 infra/systemd/hyperspace-control-plane-worker.service /etc/systemd/system/
systemctl daemon-reload
systemctl restart hyperspace-control-plane-api hyperspace-control-plane-worker
systemctl is-active hyperspace-control-plane-api hyperspace-control-plane-worker
```

If the web UI is served from the same host, sync the freshly built web assets
locally:

```bash
install -d -o caddy -g caddy -m 0755 /var/www/hyperspace-web
rsync -a --delete "$HS_REPO_DIR/apps/web/dist/" /var/www/hyperspace-web/
chown -R caddy:caddy /var/www/hyperspace-web
systemctl reload caddy
```

If the web UI is served from a separate web host, copy the same
`$HS_REPO_DIR/apps/web/dist/` directory from the control-plane build to that web
host and reload its reverse proxy:

```bash
rsync -a --delete "$HS_REPO_DIR/apps/web/dist/" root@<web-host>:/var/www/hyperspace-web/
ssh root@<web-host> 'chown -R caddy:caddy /var/www/hyperspace-web && systemctl reload caddy'
```

Validate the public entrypoint after every upgrade:

```bash
wait_https() {
  url="${1:?url required}"
  for i in $(seq 1 30); do
    if curl -fsS "$url"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_https https://<web-host>/api/health | jq .
curl -fsS https://<web-host>/api/openapi.json \
  | jq -e '.paths["/health"] and .paths["/v1/public/health"] and .paths["/v1/public/auth/me"]'

HS_WEB_BASE=https://<web-host> \
HS_API_BASE=https://<web-host>/api \
npm run test:live:ui
```

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
    "doubleZeroEnv": "mainnet-beta",
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
cd "$HS_REPO_DIR"
install -o root -g hyperspace -m 0640 /path/to/your-gates.json /etc/hyperspace/gates.json
sudo -u hyperspace env DATABASE_URL="$DATABASE_URL" npm --silent run db:seed:gates -- /etc/hyperspace/gates.json
```

The seed command prints per-gate tokens. Store each token only on the
corresponding gate host.

For automation, use the quiet JSON entrypoint. It suppresses build output and
writes machine-readable JSON only to stdout:

```bash
cd "$HS_REPO_DIR"
install -o root -g hyperspace -m 0640 /path/to/your-gates.json /etc/hyperspace/gates.json
sudo -u hyperspace env DATABASE_URL="$DATABASE_URL" scripts/seed-gates-json /etc/hyperspace/gates.json | jq .
```

The seed command validates the gate catalog before writing to PostgreSQL:
`identity` must be non-empty and unique, `publicEndpoint` must be IPv4, and
`doubleZeroEnv` must be `testnet` or `mainnet-beta`.

## Gate Agents

Build the `hyperspace-gate-agent` binary once on the control-plane host or on
another Linux builder with the same CPU architecture as the gates. The agent
requires Go 1.23 or newer. Ubuntu 24.04 `apt` can provide Go 1.22, which is too
old for `apps/gate-agent/go.mod`.

Install Go outside Docker. This example uses a Go tarball; replace
`GO_VERSION` with the current supported Go release from https://go.dev/dl/ if
needed:

```bash
export GO_VERSION=1.23.12
curl -fsSLO "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz"
rm -rf /usr/local/go
tar -C /usr/local -xzf "go${GO_VERSION}.linux-amd64.tar.gz"
export PATH=/usr/local/go/bin:$PATH
go version
```

Build and test the gate-agent binary:

```bash
cd "$HS_REPO_DIR/apps/gate-agent"
/usr/local/go/bin/go test ./...
/usr/local/go/bin/go build -o /tmp/hyperspace-gate-agent ./cmd/hyperspace-gate-agent
chmod 0755 /tmp/hyperspace-gate-agent
```

Copy the binary and systemd unit to each gate:

```bash
scp /tmp/hyperspace-gate-agent root@<gate-public-ip>:/usr/local/bin/hyperspace-gate-agent
scp "$HS_REPO_DIR/infra/systemd/hyperspace-gate-agent.service" root@<gate-public-ip>:/etc/systemd/system/hyperspace-gate-agent.service
ssh root@<gate-public-ip> 'chown root:root /usr/local/bin/hyperspace-gate-agent /etc/systemd/system/hyperspace-gate-agent.service && chmod 0755 /usr/local/bin/hyperspace-gate-agent && chmod 0644 /etc/systemd/system/hyperspace-gate-agent.service'
```

Create `/etc/hyperspace/gate-agent.env` on each gate:

```bash
install -d -o root -g root -m 0750 /etc/hyperspace
cat >/etc/hyperspace/gate-agent.env <<EOF
CONTROL_PLANE_URL=${HS_API_ORIGIN}
GATE_NAME=<gate-name-from-catalog>
GATE_TOKEN=<issued-gate-token>
POLL_INTERVAL=2s
HEARTBEAT_INTERVAL=10s
GATE_AGENT_EXECUTION_MODE=apply
GATE_AGENT_STATE_DIR=/var/lib/hyperspace-gate
EOF
chown root:root /etc/hyperspace/gate-agent.env
chmod 0600 /etc/hyperspace/gate-agent.env
```

`CONTROL_PLANE_URL` must point to the API origin that exposes `/v1/gate/*`.
For a combined host it can equal `HS_WEB_ORIGIN`; for a split deployment it
should be `HS_API_ORIGIN`.

Start the agent:

```bash
systemctl daemon-reload
systemctl enable --now hyperspace-gate-agent
systemctl status --no-pager hyperspace-gate-agent
```

Enable a gate for scheduling only after:

1. `doublezero0` is up.
2. `wg`, `ip`, and `nft` are present.
3. `doublezero status` reports `BGP Session Up`.
4. `doublezero status` network matches the gate catalog `doubleZeroEnv`.
5. `doublezero status` tunnel source matches the gate catalog `publicEndpoint`.
6. The gate heartbeat is visible in the control plane.
7. Actual-state reporting works.
8. The gate can reach at least one other gate through DoubleZero.

The control plane marks a gate `ready` when the gate agent heartbeat is fresh
and the required host tools are present. It marks a gate `schedulable` only
when the gate is ready, desired state is `Enabled`, `doublezero0` is up,
`doublezero status` reports `BGP Session Up`, the DoubleZero network matches
the gate catalog `doubleZeroEnv`, and the tunnel source matches the gate
catalog `publicEndpoint`.

In the web UI, the Gates table labels API `ready` as `Ready` and API
`schedulable` as `Schedulable`. If DoubleZero is disconnected, misconfigured,
or reporting a mismatched environment/source, `Ready` can remain `yes` while
`Schedulable` must show `no`.
The `DoubleZero node` column is informational runtime state from the gate
heartbeat; when DoubleZero is disconnected it may show `unavailable` or
`not reported` and the gate must not be selected for new VPN configs.

Execution modes:

- `apply`: mutate host WireGuard, route, and nftables state.
- `observe`: report health and actual state, but refuse mutation jobs.
- `ack`: acknowledge jobs without host mutation; only for control-plane tests.

## Web

The minimum combined-host flow already builds the full workspace and syncs web
assets in the Control Plane section. When redeploying only the UI, rebuild and
sync static assets to your web host:

```bash
cd "$HS_REPO_DIR"
sudo -u hyperspace npm run build -w @hyperspace-zone/web
rsync -a --delete "$HS_REPO_DIR/apps/web/dist/" /var/www/hyperspace-web/
systemctl reload caddy
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

Enable CORS and `Timing-Allow-Origin` for your web UI origin. Use the provided
Caddyfile example on each gate. The template uses shell-style `${GATE_HOST}`
variables for `envsubst`, not Caddy runtime `{$GATE_HOST}` variables:

```bash
export GATE_HOST=<gate-public-ip-or-domain>
export WEB_ORIGIN="$HS_WEB_ORIGIN"
export GATE_NAME=<gate-name-from-catalog>
export TLS_FULLCHAIN=/etc/caddy/certs/${GATE_HOST}/fullchain.pem
export TLS_PRIVKEY=/etc/caddy/certs/${GATE_HOST}/privkey.pem
export GATE_CADDYFILE_TEMPLATE=/opt/2z-wireguard-vpn/infra/caddy/Caddyfile.gate-probe.example
: "${GATE_HOST:?GATE_HOST is required}"
: "${WEB_ORIGIN:?WEB_ORIGIN is required}"
: "${GATE_NAME:?GATE_NAME is required}"
: "${TLS_FULLCHAIN:?TLS_FULLCHAIN is required}"
: "${TLS_PRIVKEY:?TLS_PRIVKEY is required}"

envsubst < "$GATE_CADDYFILE_TEMPLATE" > /etc/caddy/Caddyfile
if grep -n '\${' /etc/caddy/Caddyfile; then
  echo "unrendered Caddy template variables remain" >&2
  exit 1
fi
caddy fmt --overwrite /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl enable --now caddy
systemctl reload caddy
```

If the gate does not have a repository checkout, copy
`infra/caddy/Caddyfile.gate-probe.example` from the control-plane host first
and set `GATE_CADDYFILE_TEMPLATE` to that copied path, for example
`/tmp/Caddyfile.gate-probe.example`.

Validate the probe:

```bash
curl -i "https://${GATE_HOST}/.well-known/hyperspace-probe"
```

Expected result is `204 No Content` with `Access-Control-Allow-Origin` and
`Timing-Allow-Origin` matching the web UI origin.

## Validation

The canonical test-case catalog is `docs/testing/test-cases.md`. Use it as the
source of truth for release validation. Provision at least two validation
clients that are not gates and not the control-plane host. For restricted
IP-to-target validation, also choose a target IP that is reachable from the
egress gate and a different non-target IP that must remain blocked.
Provisioning, artifact download, and revoke checks alone do not prove that real
WireGuard traffic is routed correctly.

Before giving the UI to users, validate:

1. Register and log in.
2. Open the Gates table and confirm the visible status columns are `Ready`,
   `Browser RTT`, `Schedulable`, and `DoubleZero node`.
3. Confirm every gate selected for a VPN config has `Ready=yes`,
   `Schedulable=yes`, and a DoubleZero node reported.
4. Disconnect DoubleZero on a disposable gate, if available, and verify that
   the API reports `ready: true`, `schedulable: false` and the UI shows
   `Ready=yes`, `Schedulable=no`.
5. Create an IP-to-target config with explicit ingress and egress gates.
6. Download and start the WireGuard config on a client.
7. Verify the target is reachable through the selected egress.
8. Verify a non-target IP is not reachable through the restricted config.
9. Revoke the config and verify traffic stops.
10. Create a config with a user-provided WireGuard public key and verify that
   only the matching private key can connect.
11. Create a full-tunnel config from a disposable client and verify egress IP.

Keep validation clients separate from gate hosts so the results reflect the
user path.

### Automated UI/API smoke

Run this from an operator workstation, CI runner, or the control-plane host
after the web/API endpoint is reachable over HTTPS. The script uses
`playwright-core`, so provide a local Chromium/Chrome executable:

```bash
cd "$HS_REPO_DIR"

export HS_WEB_BASE=https://<web-host>
export HS_API_BASE=https://<web-host>/api
# If calling a split API host directly from automation, use:
# export HS_API_BASE=https://<api-host>

export HS_TEST_INGRESS=<schedulable-ingress-gate-name>
export HS_TEST_EGRESS=<different-schedulable-egress-gate-name>
export HS_TEST_TARGET_IP=<reachable-ipv4-target>
export HS_TEST_OUTPUT_DIR=m1-results/live-cluster
export HS_HEADLESS=true
export PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chromium-or-chrome

npm run test:live:ui
```

Expected result:

- `status: "passed"` in `live-ui-smoke-*.json`.
- No browser console errors.
- Registration, login, create-config Step 1/Step 2, provisioning to `active`,
  raw `.conf` download contract, UI download, revoke, and delete all succeed.
- The script does not persist raw WireGuard `.conf` files in the output
  directory.

### Automated WireGuard policy smoke

Run this after preparing validation clients with `wireguard-tools`,
`wg-quick`, SSH access, and the one-way probe from `scripts/testnodes`.

```bash
cd "$HS_REPO_DIR"

export HS_API_BASE=https://<web-host>/api
export HS_TEST_OUTPUT_DIR=m1-results/live-cluster
export HS_TESTNODE_SSH_KEY=/path/to/testnode-ssh-key

export HS_TEST_INGRESS=<schedulable-ingress-gate-name>
export HS_TEST_EGRESS=<different-schedulable-egress-gate-name>

export HS_ALLOWED_SOURCE_HOST=<allowed-source-testnode-host>
export HS_ALLOWED_SOURCE_IP=<allowed-source-public-ip>
export HS_DENIED_SOURCE_HOST=<denied-source-testnode-host>
export HS_DENIED_SOURCE_IP=<denied-source-public-ip>
export HS_TARGET_HOST=<target-testnode-host>
export HS_TARGET_IP=<target-public-ip>
export HS_NON_TARGET_HOST=<non-target-testnode-host>
export HS_NON_TARGET_IP=<non-target-public-ip>

npm run test:live:policy
```

Expected result:

- Target-restricted config works from the allowed source to the selected target.
- The same config cannot reach a non-target IP even if the client-side
  `AllowedIPs` line is widened.
- The same config cannot be used from a different public source IP.
- A user-provided WireGuard public key works only with its matching private key.
- Temporary sessions are revoked and deleted in cleanup.

### Optional Long-Running Measurement Matrix

This section is for placement/performance evidence, not for routine deployment
testing. It can create many temporary configs and probe every directed
testnode pair, so do not run it as part of `npm test` or the live smoke tests.

Prepare every validation testnode:

```bash
rsync -az scripts/testnodes/ root@<testnode-host>:/opt/hyperspace-testnodes/
ssh root@<testnode-host> 'bash /opt/hyperspace-testnodes/prepare-testnode.sh'
ssh root@<testnode-host> 'nohup /opt/hyperspace-testnodes/one_way_probe.py server --port 19191 >/var/log/hyperspace-one-way-probe.log 2>&1 &'
```

Create an inventory file modelled on `scripts/testnodes/inventory.example.json`
with at least two testnodes and two gates. Then run:

```bash
npm run measure:matrix -- \
  --mode all \
  --inventory ./m1-testnodes.json \
  --api-base "$HS_API_BASE" \
  --ssh-key "$HS_TESTNODE_SSH_KEY" \
  --output-dir m1-results/live-cluster/matrix \
  --active-timeout 120 \
  --revoke-timeout 120

npm run measure:compare -- \
  --public m1-results/live-cluster/matrix/public.json \
  --hyperspace m1-results/live-cluster/matrix/hyperspace.json \
  --output m1-results/live-cluster/matrix/comparison.md
```

Expected result:

- `public.json`, `gate-ping.json`, `hyperspace.json`, and `comparison.md` are
  produced.
- Every directed pair reaches `active` before the Hyperspace probe.
- Packet loss is acceptable for both public and Hyperspace samples.
- `hyperspace.json` records the selected ingress/egress gate pair per directed
  measurement.
- Temporary sessions are revoked and deleted after each measurement.

For API automation, first request a client-config download token, then fetch the
raw WireGuard config with either `downloadConfigUrl` or `?format=conf`:

```bash
export HS_PUBLIC_API_BASE=https://<web-host>/api
# If calling the API host directly, use:
# export HS_PUBLIC_API_BASE=https://<api-host>

token_response="$(
  curl -fsS -X POST \
    -H "authorization: Bearer $HS_ACCESS_TOKEN" \
    "$HS_PUBLIC_API_BASE/v1/public/sessions/$SESSION_ID/artifacts/client-config/download-token"
)"

curl -fsSL \
  "$HS_PUBLIC_API_BASE$(jq -r '.downloadConfigUrl' <<<"$token_response")" \
  > hyperspace.conf
```

`downloadUrl` without `?format=conf` intentionally returns the JSON artifact
envelope used by the web UI:

```json
{
  "payload": {
    "fileName": "hyperspace-xxxxxxxx.conf",
    "configText": "[Interface]\n..."
  }
}
```

If you intentionally use the JSON endpoint in shell automation, extract the
config text before starting WireGuard:

```bash
curl -fsSL "$HS_PUBLIC_API_BASE$(jq -r '.downloadUrl' <<<"$token_response")" \
  | jq -r '.payload.configText' \
  > hyperspace.conf
```

## Observability

Recommended components:

- Prometheus for metrics.
- Grafana for dashboards.
- node_exporter on every host.
- postgres_exporter on the database host.

Track at minimum: gate readiness, gate heartbeat age, provisioning latency,
revocation latency, reconciliation retries, dead jobs, active sessions, address
lease counts, and artifact issuance/download events.
