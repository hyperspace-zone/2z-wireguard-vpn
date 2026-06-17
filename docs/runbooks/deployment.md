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
| 2 | Universal gate |
| 3 | Universal gate |

The two gate servers must be separate hosts and each must have its own
DoubleZero `access-pass`.

Minimum production-like layout:

| Role | Minimum count | Notes |
| --- | ---: | --- |
| Web | 1 | Static UI behind HTTPS. Can share the control-plane host for small deployments. |
| Control plane | 1 | Runs API and worker systemd services. |
| PostgreSQL | 1 | Transaction source of truth. Keep private. |
| Gate | 2 | Minimum for a route that uses distinct ingress and egress roles. Gates are universal; each gate must expose HTTPS probes. |
| Observability | 1 | Prometheus, Grafana, alert rules, and dashboard provisioning from `infra/observability`. |

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

Set these input variables before following the copy/paste examples. The
`<...>` placeholders are intentionally invalid shell values: replace them with
your real public IPs/DNS names and operations email before running the block.
Keep the same values across the control-plane and gate hosts where applicable:

```bash
export HS_REPO_URL=https://github.com/hyperspace-zone/2z-wireguard-vpn.git
export HS_REPO_DIR=/opt/2z-wireguard-vpn

# Example for a combined web/API/control-plane host. Replace with your values.
export HS_WEB_HOST=<web-public-ip-or-dns>
export HS_API_HOST=<control-plane-public-ip-or-dns>
export HS_DB_HOST=127.0.0.1
export OPS_EMAIL=<ops-email>

export DZ_ENV=mainnet-beta
# or:
# export DZ_ENV=testnet

# Derived values; normally do not edit.
export HS_WEB_ORIGIN="https://$HS_WEB_HOST"
export HS_API_ORIGIN="https://$HS_API_HOST"
```

For the minimum combined-host deployment, set `HS_WEB_HOST` and `HS_API_HOST`
to the same public IP address or DNS name. For a split deployment, set
`HS_WEB_HOST` to the web UI host and `HS_API_HOST` to the public control-plane
API host. The web UI should call the API through `/api/*` on the web origin;
gate agents and automation clients should call `HS_API_ORIGIN` directly.
Set `HS_DB_HOST` to `127.0.0.1` only when PostgreSQL runs on the same host as
the control plane. For a split deployment, set it to the private database DNS
name or IP that is reachable only from the control-plane host.
Override `HS_WEB_ORIGIN` or `HS_API_ORIGIN` manually only when the public origin
is not `https://<host>`, for example when a non-standard public port or external
reverse proxy is used.

These `export` values live only in the current SSH shell. If you reconnect,
reboot, or switch to another host, rerun the Bootstrap Variables block before
continuing.

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

Gate hosts must be dedicated network hosts. Do not run Docker/containerd or
other software that rewrites forwarding policy on a gate. Docker commonly sets
`iptables` `FORWARD` policy to `DROP`; Hyperspace nftables rules can then show
accepted packets while Docker drops forwarding later in the host firewall path.

Run this preflight on every gate before installing Hyperspace:

```bash
systemctl is-active --quiet docker && {
  echo "docker is active; use a clean dedicated gate host or disable Docker first" >&2
  exit 1
}
systemctl is-active --quiet containerd && {
  echo "containerd is active; use a clean dedicated gate host or disable containerd first" >&2
  exit 1
}

iptables -S FORWARD 2>/dev/null || true
iptables -S FORWARD 2>/dev/null | grep -q '^-P FORWARD DROP' && {
  echo "iptables FORWARD policy is DROP; gate forwarding will fail" >&2
  exit 1
}
```

On a disposable gate host where Docker/containerd is not used by any workload,
clean it before continuing:

```bash
systemctl disable --now docker docker.socket containerd 2>/dev/null || true
iptables -P FORWARD ACCEPT 2>/dev/null || true
iptables -F DOCKER-USER 2>/dev/null || true
```

## Host Freshness Preflight

Start from clean, fully updated Ubuntu hosts. Do not continue deployment on a
host with a pending kernel upgrade, pending reboot, or interactive
`needrestart` prompt. If Ubuntu login prints `*** System restart required ***`,
or if this preflight reports `/var/run/reboot-required`, reboot first,
reconnect, then rerun this preflight.

Run this on every control-plane, web, gate, and validation host before
installing Hyperspace components:

```bash
apt-get update
apt-get full-upgrade -y

preflight_reboot_required=0

if [ -f /var/run/reboot-required ]; then
  cat /var/run/reboot-required
  echo "reboot this host, reconnect, and rerun the host freshness preflight" >&2
  preflight_reboot_required=1
fi

running_kernel="$(uname -r)"
latest_kernel="$(
  find /boot -maxdepth 1 -type f -name 'vmlinuz-*' -printf '%f\n' \
    | sed 's/^vmlinuz-//' \
    | sort -V \
    | tail -n1
)"

printf 'running kernel: %s\n' "$running_kernel"
printf 'latest installed kernel: %s\n' "${latest_kernel:-unknown}"

if [ -n "$latest_kernel" ] && [ "$running_kernel" != "$latest_kernel" ]; then
  echo "running kernel is not the latest installed kernel; reboot before continuing" >&2
  preflight_reboot_required=1
fi

if [ "$preflight_reboot_required" -eq 1 ]; then
  echo "STOP: run reboot now, then reconnect and rerun this preflight" >&2
else
  echo "host freshness preflight passed"
fi
```

After reboot, rerun the same block. It should finish without asking for input,
without `/var/run/reboot-required`, and with the running kernel matching the
latest installed kernel.

If the preflight exits with a reboot message, run:

```bash
reboot
```

Then reconnect over SSH and rerun the preflight block. Continue only when the
host no longer prints `*** System restart required ***` at login and the final
kernel check succeeds, for example:

```text
running kernel: 6.8.0-124-generic
latest installed kernel: 6.8.0-124-generic
```

The `full-upgrade` step is required before platform installation because these
hosts carry kernel networking, WireGuard, nftables, Caddy, PostgreSQL, Node.js,
and DoubleZero daemon workloads. Starting from a fully upgraded and rebooted
host avoids half-applied security updates, old running kernels, stale system
libraries, and interactive `needrestart` dialogs during later package
installation. If `full-upgrade` installs a newer kernel, reboot before
continuing so dataplane tests run on the same kernel that the package manager
considers current.

## TLS Requirements

Do not run browser, automation, or gate-agent traffic over plain HTTP. The web
UI, public API, gate-agent API, and browser gate probes must all use HTTPS.

Use normal Let's Encrypt domain certificates when stable DNS names are
available. If a bootstrap or disposable cluster only has public IP addresses,
use Let's Encrypt IP address certificates. IP address certificates require
Certbot 5.4 or newer, the `--ip-address` option, and the Let's Encrypt
`shortlived` profile.

Install Caddy and Certbot outside Docker on every host that needs a public
HTTPS endpoint:

```bash
apt-get update
apt-get install -y caddy python3-venv
python3 -m venv /opt/certbot-venv
/opt/certbot-venv/bin/pip install --upgrade pip certbot
caddy version
/opt/certbot-venv/bin/certbot --version
```

Prepare a webroot for HTTP-01 challenges:

```bash
install -d -o root -g root -m 0755 /etc/caddy
install -d -o root -g root -m 0755 /var/www/acme-challenges
```

During bootstrap, write a temporary Caddyfile that serves only
`/.well-known/acme-challenge/*` from that webroot on port 80 and redirects all
other HTTP traffic to HTTPS. Use two `handle` blocks so Caddy directive ordering
does not redirect ACME challenge files:

```bash
cat >/etc/caddy/Caddyfile <<'EOF'
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
EOF

caddy fmt --overwrite /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl enable --now caddy
systemctl reload caddy
```

Set the certificate name for the current host. Use the public routable IPv4
address for an IP-only bootstrap, or the DNS name if you already have stable DNS
pointing at this host. Do not use a private/local address.

```bash
# Example only. Replace on each host with that host's public IP or DNS name.
export TLS_CERT_NAME=<host-public-ip-or-dns>
```

For the combined web/control-plane host this is usually `HS_WEB_HOST`. For a
gate, this is the gate's public IP or DNS name, for example
`gate-eu-fra-01.example.net`.

For an IP address certificate, run:

```bash
/opt/certbot-venv/bin/certbot certonly \
  --webroot \
  --webroot-path /var/www/acme-challenges \
  --ip-address "$TLS_CERT_NAME" \
  --preferred-profile shortlived \
  --agree-tos \
  --email "$OPS_EMAIL" \
  --non-interactive
```

For a DNS name certificate, run:

```bash
/opt/certbot-venv/bin/certbot certonly \
  --webroot \
  --webroot-path /var/www/acme-challenges \
  -d "$TLS_CERT_NAME" \
  --agree-tos \
  --email "$OPS_EMAIL" \
  --non-interactive
```

Keep HTTPS mandatory either way.

Certbot stores certificates under `/etc/letsencrypt/live/<name>/`. Copy them to
a Caddy-readable location and keep private keys group-readable only by Caddy:

```bash
install -d -o root -g root -m 0755 /etc/hyperspace
printf '%s\n' "$TLS_CERT_NAME" >/etc/hyperspace/tls-cert-name

cat >/usr/local/sbin/hyperspace-sync-ip-cert <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
name="${1:?certificate name or IP required}"
install -d -o root -g caddy -m 0750 "/etc/caddy/certs/${name}"
install -o root -g caddy -m 0640 "/etc/letsencrypt/live/${name}/fullchain.pem" "/etc/caddy/certs/${name}/fullchain.pem"
install -o root -g caddy -m 0640 "/etc/letsencrypt/live/${name}/privkey.pem" "/etc/caddy/certs/${name}/privkey.pem"
SCRIPT
chmod 0755 /usr/local/sbin/hyperspace-sync-ip-cert
/usr/local/sbin/hyperspace-sync-ip-cert "$TLS_CERT_NAME"
```

Verify the copied certificate on disk. This check works while the temporary
port-80-only Caddyfile is still installed:

```bash
TLS_CERT_NAME="$(cat /etc/hyperspace/tls-cert-name)"
openssl x509 -in "/etc/caddy/certs/${TLS_CERT_NAME}/fullchain.pem" \
  -noout -issuer -dates -ext subjectAltName
```

Create a deploy hook for renewal:

```bash
cat >/usr/local/sbin/hyperspace-sync-certs-and-reload <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
name="$(cat /etc/hyperspace/tls-cert-name)"
/usr/local/sbin/hyperspace-sync-ip-cert "$name"
systemctl reload caddy
SCRIPT
chmod 0755 /usr/local/sbin/hyperspace-sync-certs-and-reload
```

Install renewal checks. Short-lived IP certificates expire in about six days, so
run renewal checks at least twice per day:

```bash
cat >/etc/systemd/system/hyperspace-certbot-renew.service <<'EOF'
[Unit]
Description=Renew Hyperspace short-lived certificates

[Service]
Type=oneshot
ExecStart=/opt/certbot-venv/bin/certbot renew --quiet --no-random-sleep-on-renew --deploy-hook /usr/local/sbin/hyperspace-sync-certs-and-reload
EOF

cat >/etc/systemd/system/hyperspace-certbot-renew.timer <<'EOF'
[Unit]
Description=Run Hyperspace certificate renewal checks

[Timer]
OnBootSec=10min
OnUnitActiveSec=12h
RandomizedDelaySec=30min
Persistent=true

[Install]
WantedBy=timers.target

EOF

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

Do not run a network `:443` certificate check yet. The temporary bootstrap
Caddyfile only serves port 80. Network HTTPS validation appears later, after
the final web/API or gate Caddyfile is installed.

### Caddy-Managed ACME Alternative

For DNS-based deployments, it is also acceptable to let Caddy manage Let's
Encrypt certificates directly instead of provisioning Certbot certificates and
copying them into `/etc/caddy/certs`. This is the shorter path for stable DNS
names such as `app.example.net`, `control-plane.example.net`, and
`gate-eu-fra-01.example.net`.

Use this path only when:

- public DNS already resolves to the host;
- ports `80` and `443` are reachable from the Internet;
- the host does not need Let's Encrypt IP address certificates.

With Caddy-managed TLS, omit explicit `tls <fullchain> <privkey>` lines from
the final Caddyfiles and include an operations email in the global options:

```caddy
{
  email ops@example.net
}

example.net {
  respond "ok" 200
}
```

Run `caddy validate --config /etc/caddy/Caddyfile` before reloading. If Caddy
cannot obtain a certificate, inspect `journalctl -u caddy --no-pager` and fix
DNS/firewall problems before continuing.

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

Verify the host tools before starting the agent. A gate can heartbeat while
remaining `Ready=false` if `wg`, `ip`, or `nft` is missing:

```bash
command -v wg
command -v ip
command -v nft
```

Install the DoubleZero CLI and daemon by following the official DoubleZero
connect documentation for the stable package/version:

https://docs.malbeclabs.com/connect/

Use the Cloudsmith repository that matches the target DoubleZero network. Do
not install testnet gates from the mainnet-beta `doublezero` repository: the
package name is the same, but the repository default environment and available
versions can differ.

```bash
case "$DZ_ENV" in
  testnet)
    DOUBLEZERO_CLOUDSMITH_REPO=doublezero-testnet
    ;;
  mainnet-beta)
    DOUBLEZERO_CLOUDSMITH_REPO=doublezero
    ;;
  *)
    echo "unsupported DZ_ENV=$DZ_ENV; expected testnet or mainnet-beta" >&2
    exit 1
    ;;
esac

# Remove the other public DoubleZero package channel if this host was
# previously bootstrapped for the opposite network.
if [ "$DOUBLEZERO_CLOUDSMITH_REPO" = "doublezero-testnet" ]; then
  rm -f /etc/apt/sources.list.d/malbeclabs-doublezero.list
else
  rm -f /etc/apt/sources.list.d/malbeclabs-doublezero-testnet.list
fi

curl -1sLf "https://dl.cloudsmith.io/public/malbeclabs/${DOUBLEZERO_CLOUDSMITH_REPO}/setup.deb.sh" \
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

Install or restore the DoubleZero keypair for this gate before connecting. If
an `access-pass` has already been issued, use the exact same keypair that was
used when requesting it. Generating a new keypair changes the DoubleZero
address, so a new `access-pass` must be issued for the new address and this
gate public IP.

```bash
check_doublezero_access_pass() {
  case "$DZ_ENV" in
    mainnet-beta|testnet) ;;
    *)
      echo "unsupported DZ_ENV=$DZ_ENV; set DZ_ENV to mainnet-beta or testnet" >&2
      return 1
      ;;
  esac

  install -d -m 0700 ~/.config/doublezero
  if ! test -s ~/.config/doublezero/id.json; then
    echo "missing DoubleZero keypair: ~/.config/doublezero/id.json" >&2
    echo "restore the keypair that already has an access-pass" >&2
    echo "if you generate a new keypair, you must request a new access-pass from DoubleZero before continuing" >&2
    return 1
  fi
  chmod 0600 ~/.config/doublezero/id.json

  doublezero config set --env "$DZ_ENV" --keypair ~/.config/doublezero/id.json </dev/null
  DOUBLEZERO_ADDRESS="$(doublezero --env "$DZ_ENV" --keypair ~/.config/doublezero/id.json address </dev/null)"
  printf 'DoubleZero address: %s\n' "$DOUBLEZERO_ADDRESS"

  if [ "$DOUBLEZERO_ADDRESS" = "11111111111111111111111111111111" ]; then
    echo "invalid DoubleZero address; the CLI is not using a real gate keypair" >&2
    return 1
  fi

  if ! doublezero --env "$DZ_ENV" --keypair ~/.config/doublezero/id.json access-pass list </dev/null | grep -F "$DOUBLEZERO_ADDRESS"; then
    echo "no access-pass found for DoubleZero address $DOUBLEZERO_ADDRESS" >&2
    echo "request an access-pass for this address and this gate public IP before continuing" >&2
    return 1
  fi
}

if check_doublezero_access_pass; then
  echo "DoubleZero keypair and access-pass check passed"
else
  echo "STOP: fix the DoubleZero keypair/access-pass before continuing" >&2
fi
```

If you must create a new DoubleZero identity, run this only on the gate host.
Generate the keypair if it does not already exist, then stop there. Send the
printed DoubleZero address and gate public IPv4 to the DoubleZero team and wait
for a matching `access-pass` before continuing deployment:

```bash
if [ "$DZ_ENV" = "mainnet-beta" ] || [ "$DZ_ENV" = "testnet" ]; then
  install -d -m 0700 ~/.config/doublezero
  if test -s ~/.config/doublezero/id.json; then
    echo "DoubleZero keypair already exists; not overwriting ~/.config/doublezero/id.json"
  else
    doublezero keygen --outfile ~/.config/doublezero/id.json
  fi
  chmod 0600 ~/.config/doublezero/id.json
  DOUBLEZERO_ADDRESS="$(doublezero --env "$DZ_ENV" --keypair ~/.config/doublezero/id.json address </dev/null)"
  GATE_PUBLIC_IPV4="$(curl -fsS4 https://api.ipify.org || true)"

  if ! printf '%s' "$GATE_PUBLIC_IPV4" | grep -Eq '^[0-9]+(\.[0-9]+){3}$'; then
    echo "STOP: could not determine a public IPv4 for this gate; do not use an IPv6 address for the access-pass request" >&2
  else
    printf 'DoubleZero address: %s\n' "$DOUBLEZERO_ADDRESS"
    printf 'Gate public IPv4: %s\n' "$GATE_PUBLIC_IPV4"
  fi
else
  echo "STOP: set DZ_ENV to mainnet-beta or testnet before generating a DoubleZero identity" >&2
fi
```

Do not run `doublezero connect` until `doublezero access-pass list` shows an
`access-pass` for that new address and the gate public IP.

Redirect stdin from `/dev/null` when running these commands inside an SSH
heredoc. Some DoubleZero CLI commands may read stdin, which can otherwise
consume the remaining heredoc body and skip later bootstrap commands.

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
doublezero --env "$DZ_ENV" --keypair ~/.config/doublezero/id.json connect ibrl </dev/null
doublezero --env "$DZ_ENV" --keypair ~/.config/doublezero/id.json status </dev/null
ip link show doublezero0
```

The `access-pass` row must match the `doublezero address` output and the public
IPv4 address of that gate. The DoubleZero troubleshooting guide documents this
verification flow:

https://docs.malbeclabs.com/troubleshooting/

Access is permissioned. If you do not have matching `access-pass` records,
contact the DoubleZero team through the official New Tenant contact form:

https://docs.malbeclabs.com/New%20Tenant/

On each gate, run only the following shell block to enable IPv4 forwarding:

```bash
cat >/etc/sysctl.d/99-hyperspace-gate.conf <<'EOF'
net.ipv4.ip_forward=1
EOF
sysctl --system
sysctl net.ipv4.ip_forward
```

Open the required firewall/security-group paths:

| Direction | Protocol/port | Purpose |
| --- | --- | --- |
| Internet to web/control-plane | TCP 80, 443 | ACME challenge, web UI, public API, gate-agent API. |
| Internet to each gate | TCP 80, 443 | ACME challenge and browser RTT probe. |
| Each gate to control-plane | TCP 443 | Gate heartbeat and reconciliation jobs. |
| Between DoubleZero clients | UDP 44880 | DoubleZero route-liveness traffic. |
| Gates to gates | UDP 19192 by default | Milestone 2 public-vs-DoubleZero benchmark probes. Restrict to known gate IPs and keep `GATE_PROBE_SHARED_SECRET` enabled. |
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
case "$HS_REPO_DIR" in
  /*)
    getent group hyperspace >/dev/null || addgroup --system hyperspace
    getent passwd hyperspace >/dev/null || adduser --system --ingroup hyperspace --home "$HS_REPO_DIR" --no-create-home hyperspace
    install -d -o hyperspace -g hyperspace -m 0755 "$HS_REPO_DIR"
    install -d -o root -g hyperspace -m 0750 /etc/hyperspace
    ;;
  *)
    echo "STOP: HS_REPO_DIR must be set to an absolute path, for example /opt/2z-wireguard-vpn" >&2
    echo "rerun the Bootstrap Variables block in this SSH session before continuing" >&2
    ;;
esac
```

Check out and build the repository:

```bash
if [ -z "${HS_REPO_URL:-}" ] || [ -z "${HS_REPO_DIR:-}" ]; then
  echo "STOP: HS_REPO_URL and HS_REPO_DIR must be set; rerun Bootstrap Variables first" >&2
else
  git clone "$HS_REPO_URL" "$HS_REPO_DIR"
  chown -R hyperspace:hyperspace "$HS_REPO_DIR"

  cd "$HS_REPO_DIR"
  sudo -u hyperspace npm ci
  sudo -u hyperspace npm run build
  sudo -u hyperspace npm run typecheck
  sudo -u hyperspace npm test --workspaces --if-present
fi
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

Create the application database and least-privilege user. Generate a real
password on the host; do not use a placeholder string as the database password.
This block is safe to rerun: it creates the role/database if missing and rotates
the role password to the generated value.

```bash
DB_PASSWORD="$(openssl rand -base64 36 | tr -d '\n')"

sudo -u postgres psql -v db_password="$DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE hyperspace LOGIN PASSWORD %L', :'db_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hyperspace')\gexec
ALTER ROLE hyperspace LOGIN PASSWORD :'db_password';

SELECT 'CREATE DATABASE hyperspace OWNER hyperspace'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'hyperspace')\gexec
ALTER DATABASE hyperspace OWNER TO hyperspace;
SQL
```

Use this connection string in the API, worker, seed, and migration commands:

```bash
DB_PASSWORD_URLENCODED="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$DB_PASSWORD")"
export DATABASE_URL="postgres://hyperspace:${DB_PASSWORD_URLENCODED}@${HS_DB_HOST:-127.0.0.1}:5432/hyperspace"
```

For a split database host, PostgreSQL must listen on the database network
interface and accept only the control-plane host. On the DB host, replace
`<control-plane-public-or-private-ip>` with the exact source IP used by the
control-plane host:

```bash
sed -i "s/^#\\?listen_addresses = .*/listen_addresses = '*'/" /etc/postgresql/*/main/postgresql.conf

cat >>/etc/postgresql/*/main/pg_hba.conf <<EOF
host hyperspace hyperspace <control-plane-public-or-private-ip>/32 scram-sha-256
EOF

systemctl restart postgresql
systemctl is-active postgresql
```

Verify the connection from the control-plane host before running migrations:

```bash
apt-get install -y postgresql-client
psql "$DATABASE_URL" -c 'select 1;'
```

Run migrations from the control-plane checkout after `npm ci` and build:

```bash
if [ -f "$HS_REPO_DIR/package.json" ]; then
  sudo -u hyperspace env DATABASE_URL="$DATABASE_URL" npm --prefix "$HS_REPO_DIR" run db:migrate
else
  echo "STOP: HS_REPO_DIR does not point to the cloned checkout; rerun Bootstrap Variables first" >&2
fi
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
PUBLIC_RATE_LIMIT_ENABLED=true
PUBLIC_RATE_LIMIT_READ_WINDOW_SECONDS=60
PUBLIC_RATE_LIMIT_READ_MAX=300
PUBLIC_RATE_LIMIT_AUTH_WINDOW_SECONDS=300
PUBLIC_RATE_LIMIT_AUTH_MAX=30
PUBLIC_RATE_LIMIT_MUTATION_WINDOW_SECONDS=60
PUBLIC_RATE_LIMIT_MUTATION_MAX=60
PUBLIC_RATE_LIMIT_DOWNLOAD_WINDOW_SECONDS=60
PUBLIC_RATE_LIMIT_DOWNLOAD_MAX=30
SELF_SERVICE_MAX_ACTIVE_SESSIONS_PER_ACCOUNT=5
SELF_SERVICE_MAX_SESSION_CREATES_PER_WINDOW=20
SELF_SERVICE_SESSION_CREATE_WINDOW_SECONDS=3600
SELF_SERVICE_ALLOW_PRIVATE_DESTINATIONS=false
EOF
chown root:hyperspace /etc/hyperspace/control-plane-api.env
chmod 0640 /etc/hyperspace/control-plane-api.env
```

The self-service API enables basic abuse controls by default. Public API rate
limits are in-memory per API process and are intended to absorb accidental or
low-effort abuse. Session create controls are enforced transactionally per
account: active non-terminal VPN configs are capped, create bursts are capped
per window, IP-to-IP targets must be public IPv4 `/32` destinations unless
explicitly overridden. Full-tunnel configs may be unrestricted by source; if a
source restriction is supplied, the API only validates that it is an IPv4 CIDR.

Create `/etc/hyperspace/control-plane-worker.env` with the same
`ARTIFACT_ENCRYPTION_KEY`:

```bash
cat >/etc/hyperspace/control-plane-worker.env <<EOF
DATABASE_URL=${DATABASE_URL}
WORKER_POLL_MS=2000
WORKER_ID=control-plane-worker-01
WORKER_OBSERVABILITY_HOST=0.0.0.0
WORKER_OBSERVABILITY_PORT=9091
ARTIFACT_ENCRYPTION_KEY=${ARTIFACT_ENCRYPTION_KEY}
BENCHMARK_PROBES_ENABLED=true
BENCHMARK_INTERVAL_SECONDS=300
BENCHMARK_PROBE_PORT=19192
BENCHMARK_PROBE_COUNT=10
BENCHMARK_PROBE_INTERVAL_MS=100
BENCHMARK_PROBE_TIMEOUT_MS=1000
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

The API exposes Prometheus metrics at `/metrics` on the public control-plane
origin. The worker exposes `/health` and `/metrics` on
`WORKER_OBSERVABILITY_HOST:WORKER_OBSERVABILITY_PORT`; restrict this port to the
observability host in production firewalls.

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
export TLS_PRIVKEY=/etc/caddy/certs/"$HS_WEB_HOST"/privkey.pem
: "${APP_HOST:?APP_HOST is required}"
: "${TLS_FULLCHAIN:?TLS_FULLCHAIN is required}"
: "${TLS_PRIVKEY:?TLS_PRIVKEY is required}"
test -f "$TLS_FULLCHAIN" || { echo "missing TLS_FULLCHAIN: $TLS_FULLCHAIN" >&2; exit 1; }
test -f "$TLS_PRIVKEY" || { echo "missing TLS_PRIVKEY: $TLS_PRIVKEY" >&2; exit 1; }
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

Verify that clients receive the expected certificate from the combined web/API
host:

```bash
echo | openssl s_client -connect "${HS_WEB_HOST}:443" -servername "${HS_WEB_HOST}" 2>/dev/null \
  | openssl x509 -noout -issuer -dates -ext subjectAltName
```

Health check paths depend on which host you call:

```bash
# API origin directly:
curl --retry 30 --retry-delay 1 --retry-all-errors -fsS "https://${HS_API_HOST}/health"
curl --retry 30 --retry-delay 1 --retry-all-errors -fsS "https://${HS_API_HOST}/v1/public/health"

# Web/API host where /api/* is proxied to the API:
curl --retry 30 --retry-delay 1 --retry-all-errors -fsS "https://${HS_WEB_HOST}/api/health"
curl --retry 30 --retry-delay 1 --retry-all-errors -fsS "https://${HS_WEB_HOST}/api/v1/public/health"
```

The API process exposes OpenAPI at `/openapi.json` on a direct API origin. In
the combined web/API deployment, the public Caddy entrypoint serves the SPA at
the root and proxies API traffic only under `/api/*`, so use
`/api/openapi.json` from the public web host:

```bash
# Direct API origin or dedicated API vhost:
curl -fsS "https://${HS_API_HOST}/openapi.json" | jq '.paths["/health"]'

# Combined web/API public host:
curl -fsS "https://${HS_WEB_HOST}/api/openapi.json" | jq '.paths["/v1/public/health"]'
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
sudo -u hyperspace env DATABASE_URL="$DATABASE_URL" npm --prefix "$HS_REPO_DIR" run db:migrate

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
rsync -a --delete "$HS_REPO_DIR/apps/web/dist/" "root@${HS_WEB_HOST}:/var/www/hyperspace-web/"
ssh "root@${HS_WEB_HOST}" 'chown -R caddy:caddy /var/www/hyperspace-web && systemctl reload caddy'
```

Validate the public entrypoint after every upgrade. These checks do not require
gate catalog records or running gate agents:

```bash
curl --retry 30 --retry-delay 1 --retry-all-errors -fsS "https://${HS_WEB_HOST}/api/health" | jq .
curl --retry 30 --retry-delay 1 --retry-all-errors -fsS "https://${HS_WEB_HOST}/api/openapi.json" \
  | jq -e '.paths["/health"] and .paths["/v1/public/health"] and .paths["/v1/public/auth/me"]'
```

Run the live UI/API smoke only after the gate catalog is seeded and at least two
gate agents are reporting `ready=true` and `schedulable=true`; see
[Live Smoke Tests](live-smoke-tests.md).

## Observability

Run this section on the observability host. Set `HS_CLUSTER` to either
`testnet` or `mainnet`; set `OBSERVABILITY_DOMAIN` to the public Grafana host.

Grafana 13 plus Prometheus should run on a host with at least 2 GB RAM. On
1 GB disposable validation hosts, add a 2 GB swap file before starting Grafana;
without swap, dashboard/API requests can hit Grafana handler timeouts under
load.

```bash
export HS_CLUSTER=testnet
export OBSERVABILITY_DOMAIN=observability.testnet.hyperspace.zone
export HS_REPO_DIR=/opt/2z-wireguard-vpn
```

For a small observability host, provision swap once:

```bash
if ! swapon --show=NAME --noheadings | grep -qx '/swapfile'; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
fi

grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab

cat >/etc/sysctl.d/99-hyperspace-observability.conf <<'EOF'
vm.swappiness=10
vm.vfs_cache_pressure=50
EOF
sysctl --system
```

Install Prometheus, Grafana, and Caddy:

```bash
apt-get update
apt-get install -y prometheus caddy apt-transport-https software-properties-common wget gpg

install -d -m 0755 /etc/apt/keyrings
wget -q -O - https://apt.grafana.com/gpg.key | gpg --dearmor >/etc/apt/keyrings/grafana.gpg
echo "deb [signed-by=/etc/apt/keyrings/grafana.gpg] https://apt.grafana.com stable main" \
  >/etc/apt/sources.list.d/grafana.list
apt-get update
apt-get install -y grafana
```

Provision Prometheus rules, Grafana datasource, and dashboard:

```bash
install -d -m 0755 /etc/prometheus/rules
install -m 0644 "$HS_REPO_DIR/infra/observability/prometheus/prometheus.${HS_CLUSTER}.yml" \
  /etc/prometheus/prometheus.yml
install -m 0644 "$HS_REPO_DIR/infra/observability/prometheus/rules/hyperspace-alerts.yml" \
  /etc/prometheus/rules/hyperspace-alerts.yml

install -d -m 0755 /etc/grafana/provisioning/datasources
install -d -m 0755 /etc/grafana/provisioning/dashboards
install -d -o grafana -g grafana -m 0755 /var/lib/grafana/dashboards/hyperspace
install -m 0644 "$HS_REPO_DIR/infra/observability/grafana/provisioning/datasources/prometheus.yml" \
  /etc/grafana/provisioning/datasources/prometheus.yml
install -m 0644 "$HS_REPO_DIR/infra/observability/grafana/provisioning/dashboards/hyperspace.yml" \
  /etc/grafana/provisioning/dashboards/hyperspace.yml
install -o grafana -g grafana -m 0644 "$HS_REPO_DIR/infra/observability/grafana/dashboards/hyperspace-control-plane.json" \
  /var/lib/grafana/dashboards/hyperspace/hyperspace-control-plane.json
```

Expose Grafana over HTTPS and Prometheus under `/prometheus/*`:

```bash
install -m 0644 "$HS_REPO_DIR/infra/observability/caddy/Caddyfile" /etc/caddy/Caddyfile
cat >/etc/caddy/observability.env <<EOF
OBSERVABILITY_DOMAIN=${OBSERVABILITY_DOMAIN}
EOF
install -d -m 0755 /etc/systemd/system/caddy.service.d
cat >/etc/systemd/system/caddy.service.d/observability-env.conf <<EOF
[Service]
EnvironmentFile=/etc/caddy/observability.env
EOF
```

Start services and validate:

```bash
systemctl daemon-reload
systemctl enable --now prometheus grafana-server caddy
systemctl restart prometheus grafana-server caddy

promtool check config /etc/prometheus/prometheus.yml
promtool check rules /etc/prometheus/rules/hyperspace-alerts.yml
curl -fsS "http://127.0.0.1:9090/-/ready"
curl -fsS "http://127.0.0.1:3000/api/health"
curl -fsS "https://${OBSERVABILITY_DOMAIN}/api/health"
curl -fsS "https://${OBSERVABILITY_DOMAIN}/prometheus/-/ready"
```

## Gate Catalog

Create your own gate inventory from the example in `infra/gates.example.json`.
Run this on the control-plane host as root, after the `hyperspace` system user
has been created. Create the real seed file, edit it, and replace all example
values:

```bash
cd "$HS_REPO_DIR"
install -d -o root -g hyperspace -m 0750 /etc/hyperspace
install -o root -g hyperspace -m 0640 infra/gates.example.json /etc/hyperspace/gates.json
nano /etc/hyperspace/gates.json
jq empty /etc/hyperspace/gates.json
```

The file should look like this after replacing values:

```json
[
  {
    "name": "gate-eu-fra-01",
    "identity": "7pFRA2uV4q2Jr7mN8pQ9sT3wX5yZ7aB9cD2eF4gH6",
    "city": "Frankfurt",
    "country": "Germany",
    "publicIpv4": "203.0.113.10",
    "probeUrl": "https://gate-eu-fra-01.example.net/.well-known/hyperspace-probe",
    "doubleZeroEnv": "mainnet-beta"
  },
  {
    "name": "gate-na-chi-01",
    "identity": "8qCH3vT5wX7yZ9aB2cD4eF6gH8jK9mN2pQ4rS6tU8V",
    "city": "Chicago",
    "country": "United States",
    "publicIpv4": "203.0.113.20",
    "probeUrl": "https://203.0.113.20/.well-known/hyperspace-probe",
    "doubleZeroEnv": "mainnet-beta"
  }
]
```

`name` is the Hyperspace resource name for the gate. It is chosen by the
operator, shown in the API/UI, used by `GATE_NAME` in `gate-agent.env`, and used
when users or tests select explicit gates. Gate names should describe location
or inventory identity, not fixed traffic direction. The same deployed gate can
be selected as ingress for one session and egress for another session. `name`
must be unique in the catalog. It may look like a hostname, but it is not used
as a network endpoint; avoid using a raw IP address as the name unless you want
renaming whenever the host IP changes.

`identity` is the DoubleZero `user_payer` identity for the gate. It is not a
hostname and not a Hyperspace name. Use the exact output of `doublezero address`
on that gate host. The same identity and public IPv4 must be authorized by
the gate's DoubleZero `access-pass`. The value above is only a Solana-style
example; replace it with the real address for this gate.

`publicIpv4` is the gate public IPv4 address used for DoubleZero tunnel
source validation and WireGuard endpoint generation. Hostnames are not accepted
in this field. `publicIpv4` must be unique in the catalog.

`probeUrl` is the HTTPS browser probe endpoint. It may use either a DNS name or
an IP address, as long as clients can validate the HTTPS certificate for that
URL. If you use DNS names such as `gate-eu-fra-02.hyperspace.zone`, put that
hostname in `probeUrl`, for example
`https://gate-eu-fra-02.hyperspace.zone/.well-known/hyperspace-probe`.
`probeUrl` must be unique when present.

Set `doubleZeroEnv` to the same value as `DZ_ENV` for every gate:
`testnet` for DoubleZero testnet clusters, or `mainnet-beta` for DoubleZero
mainnet-beta clusters. The control plane compares this expected value with the
`network` reported by `doublezero status`; a gate connected to the wrong
DoubleZero network remains not schedulable.

Do not mix DoubleZero testnet and mainnet-beta gates in one schedulable
deployment. The data model stores `doubleZeroEnv` per gate, but current path
selection is intended for one DoubleZero environment per control-plane cluster
and does not provide separate scheduling pools for mixed environments.

The seed file must contain at least two gates because the current platform
requires distinct ingress and egress gates for a session. The seed command also
rejects duplicate `name`, `identity`, `publicIpv4`, and duplicate
`probeUrl` values.

Use `city` and `country` as operator-facing location fields. The control plane
does not validate or normalize spelling; values are displayed as provided.

The ordinary gate catalog does not expose scheduling weights or capacity
limits. Internally, new gates use `scheduling_weight=100`, which only affects
API-created sessions that do not specify explicit gate names. The web UI orders
gate choices by measured Browser RTT. The database also has a reserved
`capacity_limit` column, but the current scheduler does not enforce it; do not
use it as admission control until active-session capacity accounting and
limit-exceeded tests are implemented.

Seed gates into PostgreSQL for an interactive operator flow:

```bash
cd "$HS_REPO_DIR"
sudo -u hyperspace env DATABASE_URL="$DATABASE_URL" npm --silent run db:seed:gates -- /etc/hyperspace/gates.json
```

The seed command prints per-gate tokens. Store each token only on the
corresponding gate host.

For automation, use the quiet JSON entrypoint. It suppresses build output and
writes machine-readable JSON only to stdout:

```bash
cd "$HS_REPO_DIR"
sudo -u hyperspace env DATABASE_URL="$DATABASE_URL" scripts/seed-gates-json /etc/hyperspace/gates.json | jq .
```

Do not use `npm run db:seed:gates -- --quiet-json` in automation and pipe that
directly into `jq`: npm lifecycle output and workspace build logs can be
printed before the JSON payload. Use `scripts/seed-gates-json` whenever another
script needs to parse issued gate tokens.

The seed command validates the gate catalog before writing to PostgreSQL:
the file must contain at least two gates, `name`, `identity`, and
`publicIpv4` must be unique, `probeUrl` must be unique when present,
`publicIpv4` must be a public IPv4 address, and `doubleZeroEnv` must be `testnet` or
`mainnet-beta`.

## Gate Agents

This section starts on the control-plane host or another Linux builder, not on
the gate hosts. Build the `hyperspace-gate-agent` binary once, then copy it to
each gate. The builder must have the same CPU architecture as the gates. The
agent requires Go 1.23 or newer. Ubuntu 24.04 `apt` can provide Go 1.22, which
is too old for `apps/gate-agent/go.mod`.

On the control-plane or builder host, install Go outside Docker. This example
uses a Go tarball; replace `GO_VERSION` with the current supported Go release
from https://go.dev/dl/ if needed:

```bash
export GO_VERSION=1.23.12
curl -fsSLO "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz"
rm -rf /usr/local/go
tar -C /usr/local -xzf "go${GO_VERSION}.linux-amd64.tar.gz"
export PATH=/usr/local/go/bin:$PATH
go version
```

On the same control-plane or builder host, build and test the gate-agent
binary:

```bash
cd "$HS_REPO_DIR/apps/gate-agent"
sudo -u hyperspace env PATH="/usr/local/go/bin:$PATH" /usr/local/go/bin/go test ./...
sudo -u hyperspace env PATH="/usr/local/go/bin:$PATH" /usr/local/go/bin/go build -buildvcs=false -o /tmp/hyperspace-gate-agent ./cmd/hyperspace-gate-agent
chmod 0755 /tmp/hyperspace-gate-agent
```

Build as the `hyperspace` repository owner. Building as root from a checkout
owned by `hyperspace` can fail with Git dubious ownership or VCS stamping
errors. `-buildvcs=false` keeps the binary build independent from local Git
ownership metadata.

From the control-plane or builder host, copy the binary and systemd unit to
each gate:

```bash
export GATE_PUBLIC_IPV4=203.0.113.10

scp /tmp/hyperspace-gate-agent "root@${GATE_PUBLIC_IPV4}:/usr/local/bin/hyperspace-gate-agent"
scp "$HS_REPO_DIR/infra/systemd/hyperspace-gate-agent.service" "root@${GATE_PUBLIC_IPV4}:/etc/systemd/system/hyperspace-gate-agent.service"
ssh "root@${GATE_PUBLIC_IPV4}" 'chown root:root /usr/local/bin/hyperspace-gate-agent /etc/systemd/system/hyperspace-gate-agent.service && chmod 0755 /usr/local/bin/hyperspace-gate-agent && chmod 0644 /etc/systemd/system/hyperspace-gate-agent.service'
```

On each gate host, create `/etc/hyperspace/gate-agent.env`:

```bash
export CONTROL_PLANE_URL="${HS_API_ORIGIN}"
export GATE_NAME=gate-eu-fra-01
: "${GATE_PROBE_SHARED_SECRET:?set the same benchmark probe shared secret on every gate}"
read -rsp "Issued gate token for ${GATE_NAME}: " GATE_TOKEN
echo

install -d -o root -g root -m 0750 /etc/hyperspace
cat >/etc/hyperspace/gate-agent.env <<EOF
CONTROL_PLANE_URL=${CONTROL_PLANE_URL}
GATE_NAME=${GATE_NAME}
GATE_TOKEN=${GATE_TOKEN}
POLL_INTERVAL=2s
HEARTBEAT_INTERVAL=10s
GATE_AGENT_EXECUTION_MODE=apply
GATE_AGENT_STATE_DIR=/var/lib/hyperspace-gate
GATE_PROBE_LISTEN_ADDRESS=0.0.0.0
GATE_PROBE_PORT=19192
GATE_PROBE_SHARED_SECRET=${GATE_PROBE_SHARED_SECRET}
EOF
chown root:root /etc/hyperspace/gate-agent.env
chmod 0600 /etc/hyperspace/gate-agent.env
unset GATE_TOKEN
```

`CONTROL_PLANE_URL` must point to the API origin that exposes `/v1/gate/*`.
For a combined host it can equal `HS_WEB_ORIGIN`; for a split deployment it
should be `HS_API_ORIGIN`.

Use one identical `GATE_PROBE_SHARED_SECRET` across all gates in the same
benchmarking cluster. This signs UDP benchmark probes. See
[Gate Benchmarking](gate-benchmarking.md) for probe firewall and verification
steps.

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
5. `doublezero status` tunnel source matches the gate catalog `publicIpv4`.
6. The gate heartbeat is visible in the control plane.
7. Actual-state reporting works.
8. The gate can reach at least one other gate through DoubleZero.

The control plane marks a gate `ready` when the gate agent heartbeat is fresh
and the required host tools are present. It marks a gate `schedulable` only
when the gate is ready, desired state is `Enabled`, `doublezero0` is up,
`doublezero status` reports `BGP Session Up`, the DoubleZero network matches
the gate catalog `doubleZeroEnv`, and the tunnel source matches the gate
catalog `publicIpv4`.

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

For a split web/control-plane deployment with Caddy-managed TLS, the web host
can use this shape. The explicit `Host` header is important: without it, the
upstream Caddy/API origin can return the wrong virtual host response.

```caddy
{
  email ops@example.net
}

app.example.net {
  handle /api/* {
    uri strip_prefix /api
    reverse_proxy https://control-plane.example.net {
      header_up Host control-plane.example.net
    }
  }

  handle {
    root * /var/www/hyperspace-web
    header Cache-Control "no-store, max-age=0"
    try_files {path} /index.html
    file_server
  }
}
```

Validate both the API proxy and the static app shell from outside the cluster:

```bash
curl -fsS "https://${HS_WEB_HOST}/api/health" | jq .
curl -fsSI "https://${HS_WEB_HOST}/benchmarks"
```

## Browser Gate Probes

Browser RTT measurement requires each gate to expose an HTTPS probe endpoint:

```text
GET /.well-known/hyperspace-probe -> 204 No Content
```

Copy the Caddy probe template from the control-plane host to each gate:

```bash
jq -r '.[].publicIpv4' /etc/hyperspace/gates.json | while IFS= read -r GATE_PUBLIC_IPV4; do
  scp "$HS_REPO_DIR/infra/caddy/Caddyfile.gate-probe.example" "root@${GATE_PUBLIC_IPV4}:/tmp/Caddyfile.gate-probe.example"
done
```

On each gate host, render and reload the probe Caddyfile. For split web/API
deployments, set `HS_WEB_ORIGIN` to the web UI origin before running this block:

```bash
set -a
. /etc/hyperspace/gate-agent.env
set +a

export GATE_HOST="$(cat /etc/hyperspace/tls-cert-name)"
export WEB_ORIGIN="${HS_WEB_ORIGIN:-$CONTROL_PLANE_URL}"
export TLS_FULLCHAIN=/etc/caddy/certs/${GATE_HOST}/fullchain.pem
export TLS_PRIVKEY=/etc/caddy/certs/${GATE_HOST}/privkey.pem
export GATE_CADDYFILE_TEMPLATE=/tmp/Caddyfile.gate-probe.example

envsubst < "$GATE_CADDYFILE_TEMPLATE" > /etc/caddy/Caddyfile
caddy fmt --overwrite /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl enable --now caddy
systemctl reload caddy
```

Verify the certificate and probe:

```bash
echo | openssl s_client -connect "${GATE_HOST}:443" -servername "${GATE_HOST}" 2>/dev/null \
  | openssl x509 -noout -issuer -dates -ext subjectAltName

curl -i "https://${GATE_HOST}/.well-known/hyperspace-probe"
```

Expected result is `204 No Content` with `Access-Control-Allow-Origin` and
`Timing-Allow-Origin` matching the web UI origin.

## Open the Web UI

At this point the deployment is usable for normal operator testing. From a
browser on your workstation, open the web origin and register or log in:

```bash
export HS_WEB_HOST="${HS_WEB_HOST:-$(cat /etc/hyperspace/tls-cert-name 2>/dev/null || true)}"
printf 'Open: https://%s\n' "$HS_WEB_HOST"
```

Use the Gates view to confirm at least two gates are `Ready=yes` and
`Schedulable=yes`, then create and download a VPN config from the UI.

## Validation

The canonical test-case catalog is
[docs/testing/test-cases.md](../testing/test-cases.md). Use it as the source of
truth for release validation. Provision at least two validation clients that
are not gates and not the control-plane host. For restricted IP-to-target
validation, also choose a target IP that is reachable from the egress gate and
a different non-target IP that must remain blocked. Provisioning, artifact
download, and revoke checks alone do not prove that real WireGuard traffic is
routed correctly.

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

For Milestone 2 benchmark validation, a route with `Internet` success and
`DoubleZero` failure is not automatically a deployment failure. Verify the path
from the source gate with interface-bound probes before changing application
configuration:

```bash
ping -c 3 -I eth0 <peer-gate-public-ip>
ping -c 3 -I doublezero0 <peer-gate-public-ip>
```

If the public interface succeeds and `doublezero0` has 100% loss, treat that as
a DoubleZero route/device issue for that gate pair and record it with the
benchmark evidence.

Related runbooks:

- [Live Smoke Tests](live-smoke-tests.md)
- [Gate Benchmarking](gate-benchmarking.md)
- [Long-Running Measurement Matrix](long-running-measurement-matrix.md)
- [API Automation](api-automation.md)
