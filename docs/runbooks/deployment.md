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
`POLL_INTERVAL`, `HEARTBEAT_INTERVAL`, and `ACTUAL_STATE_INTERVAL`. Heartbeats
default to 10 seconds while actual-state/counter reports default to 60 seconds
to avoid unnecessary database growth. Legacy names such as `API_URL`,
`GATE_ID`, and `POLL_INTERVAL_SEC` are not used by the current agent.

Gate hosts must be dedicated network hosts. Do not run Docker/containerd or
other software that rewrites forwarding policy on a gate. Docker commonly sets
`iptables` `FORWARD` policy to `DROP`; Hyperspace nftables rules can then show
accepted packets while Docker drops forwarding later in the host firewall path.

## Host Baseline Hardening

Run this section on every Hyperspace host role: web, control-plane, PostgreSQL,
gate, and observability. Small cloud VMs can become temporarily unreachable when
desktop-oriented maintenance daemons wake up and consume memory. On cloud
servers, guest firmware updates are normally not actionable from inside the VM;
the provider owns host firmware.

Disable and mask `fwupd` background activation:

```bash
for unit in \
  fwupd-refresh.timer \
  fwupd-refresh.service \
  fwupd.service
do
  systemctl stop "$unit" 2>/dev/null || true
  systemctl disable "$unit" 2>/dev/null || true
  systemctl mask "$unit" 2>/dev/null || true
done

systemctl reset-failed \
  fwupd-refresh.timer \
  fwupd-refresh.service \
  fwupd.service 2>/dev/null || true
```

Divert PackageKit's apt hook before masking its services. The hook can return
`UnitMasked` and fail an otherwise successful manual package transaction. Do
not purge PackageKit directly: on Ubuntu that also removes the `ubuntu-server`
metapackage.

```bash
systemctl unmask packagekit.service packagekit-offline-update.service 2>/dev/null || true
systemctl disable --now packagekit.service packagekit-offline-update.service 2>/dev/null || true
install -d -m 0750 /etc/hyperspace/disabled-apt-hooks
if dpkg-divert --list /etc/apt/apt.conf.d/20packagekit 2>/dev/null \
  | grep -q '20packagekit.distrib'; then
  dpkg-divert --local --rename --remove /etc/apt/apt.conf.d/20packagekit
fi
if ! dpkg-divert --list /etc/apt/apt.conf.d/20packagekit 2>/dev/null \
  | grep -q '/etc/hyperspace/disabled-apt-hooks/20packagekit'; then
  dpkg-divert --local --rename \
    --divert /etc/hyperspace/disabled-apt-hooks/20packagekit \
    --add /etc/apt/apt.conf.d/20packagekit
fi
systemctl mask packagekit.service packagekit-offline-update.service
```

The diversion persists across PackageKit package upgrades. During an explicit
maintenance window, temporarily unmasking the service is not required because
apt no longer loads the diverted hook.

Disable unattended APT activity as well. A 1 GB gate can enter sustained
memory and I/O pressure while `unattended-upgrade` reads package metadata;
the gate-agent, SSH, and node exporter can then all stop responding before a
five-minute resource alert becomes firing. Run the repository script on every
host role:

```bash
install -m 0755 "$HS_REPO_DIR/scripts/disable-automatic-upgrades.sh" \
  /usr/local/sbin/hyperspace-disable-automatic-upgrades
/usr/local/sbin/hyperspace-disable-automatic-upgrades
```

The script disables APT periodic policy and masks `apt-daily.timer`,
`apt-daily-upgrade.timer`, their services, and `unattended-upgrades.service`.
It deliberately does not terminate an already-running apt/dpkg transaction;
let such a transaction finish, repair it if necessary, and run the script
again. Verify the baseline with:

```bash
systemctl is-enabled \
  apt-daily.timer \
  apt-daily-upgrade.timer \
  apt-daily.service \
  apt-daily-upgrade.service \
  unattended-upgrades.service
apt-config dump | grep -E '^APT::Periodic'
pgrep -a 'apt|dpkg|unattended' || true
```

Every listed unit should be `masked`, all `APT::Periodic` values should be
`"0"`, and no package transaction should remain. Reapply this baseline after
an image replacement or distribution upgrade because package installation can
restore vendor presets.

For 1 GB hosts, add swap unless the provider already supplies enough memory.
This does not make undersized hosts fast, but it prevents short-lived metadata
jobs from pushing the VM into an OOM/user-space stall:

```bash
if ! swapon --show=NAME --noheadings | grep -qx '/swapfile'; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
fi

grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab

cat >/etc/sysctl.d/99-hyperspace-vm-memory.conf <<'EOF'
vm.swappiness=10
vm.vfs_cache_pressure=50
EOF
sysctl --system
```

Do not rely on unattended background jobs for security patching after this
hardening. Apply operating-system updates through an explicit maintenance
window and reboot policy.

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
`gate-eu-fra-01.testnet.hyperspace.zone`.

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
names such as `app.testnet.hyperspace.zone`,
`control-plane.testnet.hyperspace.zone`, and
`gate-eu-fra-01.testnet.hyperspace.zone`.

Use this path only when:

- public DNS already resolves to the host;
- ports `80` and `443` are reachable from the Internet;
- the host does not need Let's Encrypt IP address certificates.

With Caddy-managed TLS, omit explicit `tls <fullchain> <privkey>` lines from
the final Caddyfiles and include an operations email in the global options:

```caddy
{
  email gatekeepers@hyperspace.zone
}

app.testnet.hyperspace.zone {
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
  logrotate \
  prometheus-node-exporter \
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

For production gates, also install the passive route-liveness tuning drop-in.
This keeps DoubleZero route liveness enabled, but reduces background traffic by
using longer passive liveness intervals. Do not enable active route liveness
unless the DoubleZero team explicitly asks for it; active mode can remove kernel
routes when peers are considered down.

Use a late-sorting `zz-` filename because other service drop-ins may also reset
`ExecStart`:

```bash
install -d /etc/systemd/system/doublezerod.service.d
cat >/etc/systemd/system/doublezerod.service.d/zz-route-liveness-passive-tuning.conf <<EOF
[Service]
ExecStart=
ExecStart=/usr/bin/doublezerod -sock-file /run/doublezerod/doublezerod.sock -env ${DZ_ENV} -route-liveness-tx-min 10s -route-liveness-rx-min 10s -route-liveness-max-tx-ceil 30s
EOF
```

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

On each standard-tier gate, apply the forwarding, conntrack and UDP
receive-buffer profile below. The receive-buffer settings protect `doublezerod`
UDP/44880 from bursts that would otherwise increment `UdpRcvbufErrors` and drop
route-liveness traffic. The default is 4 MiB and applications may request up to
16 MiB; these limits do not preallocate that amount for every UDP socket.

```bash
install -d -m 0755 /etc/modules-load.d
printf 'nf_conntrack\n' >/etc/modules-load.d/90-hyperspace-gate.conf
modprobe nf_conntrack
cat >/etc/sysctl.d/99-hyperspace-gate.conf <<'EOF'
net.ipv4.ip_forward=1
net.netfilter.nf_conntrack_max=65536
net.netfilter.nf_conntrack_acct=1
net.core.rmem_default=4194304
net.core.rmem_max=16777216
EOF
sysctl --system
sysctl net.ipv4.ip_forward
sysctl net.netfilter.nf_conntrack_max net.netfilter.nf_conntrack_acct
sysctl net.core.rmem_default net.core.rmem_max
```

`scripts/gates/bootstrap-host` installs the same values in
`/etc/sysctl.d/90-hyperspace-gate.conf` for all new or repaired gates. After
restarting `doublezerod`, verify its UDP socket and record the cumulative UDP
error counters twice. Existing non-zero counters are historical; they are not
a rollout failure unless they continue to increase.

```bash
systemctl restart doublezerod
ss -uapm 'sport = :44880'
nstat -az UdpRcvbufErrors UdpSndbufErrors
sleep 120
nstat -az UdpRcvbufErrors UdpSndbufErrors
```

The `ss` output should show `rb4194304` for the `doublezerod` socket. Confirm
that BGP and DoubleZero readiness recover after the restart and that neither
UDP buffer-error counter grows. If only `UdpSndbufErrors` grows, investigate
the send path separately; increasing receive buffers does not correct a send
queue problem.

Open the required firewall/security-group paths:

| Direction | Protocol/port | Purpose |
| --- | --- | --- |
| Internet to web/control-plane | TCP 80, 443 | ACME challenge, web UI, public API, gate-agent API. |
| Internet to each gate | TCP 80, 443 | ACME challenge and browser RTT probe. |
| Each gate to control-plane | TCP 443 | Gate heartbeat and reconciliation jobs. |
| Between DoubleZero clients | UDP 44880 | DoubleZero route-liveness traffic. |
| Gates to gates | UDP 19192 by default | Milestone 2 public-vs-DoubleZero benchmark probes. Restrict to known gate IPs and keep `GATE_PROBE_SHARED_SECRET` enabled. |
| Observability to each gate | TCP 9100 | Prometheus `node_exporter` host resource metrics. Restrict to the observability host IPs only. |
| WireGuard clients to ingress gates | UDP listen ports assigned by Hyperspace | Client tunnel traffic. Keep the assigned/dynamic UDP range open, or open the intended WireGuard UDP ports until the range is constrained in deployment config. |
| Egress gates to targets | As required by policy | User traffic exiting through the selected egress gate. |

Provisioning can succeed while client traffic still fails if the cloud firewall
blocks the assigned WireGuard UDP port on the ingress gate.

Gate bootstrap persists the host-level UFW rules for TCP/9100 and UDP/19192 in
`/etc/hyperspace/gate-firewall.env`. The enabled
`hyperspace-gate-firewall.service` reapplies and verifies them after every boot.
It does not enable UFW or change the default policy, so keep the provider
firewall synchronized and make the host-level enablement decision explicitly.
Rerun the fleet rollout whenever a gate or observability IPv4 changes.

```bash
systemctl is-enabled hyperspace-gate-firewall.service
/usr/local/sbin/hyperspace-gate-firewall --check
ufw show added
```

### Gate disk janitor

Install the local disk janitor on every gate. It prevents noisy system logs
from filling the root filesystem and emits node-exporter textfile metrics for
operator evidence.

```bash
install -d -m 0755 /usr/local/sbin
install -m 0755 "$HS_REPO_DIR/scripts/hyperspace-disk-janitor.sh" \
  /usr/local/sbin/hyperspace-disk-janitor

install -d -m 0755 /etc/systemd/journald.conf.d
rm -f /etc/systemd/journald.conf.d/90-hyperspace-gate-limits.conf
install -m 0644 "$HS_REPO_DIR/infra/journald/zz-hyperspace-gate-limits.conf" \
  /etc/systemd/journald.conf.d/zz-hyperspace-gate-limits.conf

install -d -m 2755 -o root -g systemd-journal /var/log/journal

# Remove the obsolete file from deployments made before 2026-07-15. It
# duplicates the distribution rsyslog entries and makes logrotate fail.
rm -f /etc/logrotate.d/hyperspace-gate-logs

install -d -m 0755 /etc/systemd/system/doublezerod.service.d
install -m 0644 "$HS_REPO_DIR/infra/systemd/doublezerod-log-filter.conf" \
  /etc/systemd/system/doublezerod.service.d/20-log-filter.conf

install -d -m 0755 /var/lib/node_exporter/textfile_collector
cat >/etc/default/prometheus-node-exporter <<'EOF'
ARGS="--collector.textfile.directory=/var/lib/node_exporter/textfile_collector"
EOF

install -m 0644 "$HS_REPO_DIR/infra/systemd/hyperspace-disk-janitor.service" \
  /etc/systemd/system/hyperspace-disk-janitor.service
install -m 0644 "$HS_REPO_DIR/infra/systemd/hyperspace-disk-janitor.timer" \
  /etc/systemd/system/hyperspace-disk-janitor.timer

systemctl daemon-reload
systemctl restart systemd-journald
journalctl --flush
systemctl enable --now prometheus-node-exporter
systemctl restart prometheus-node-exporter
systemctl enable --now hyperspace-disk-janitor.timer
systemctl start hyperspace-disk-janitor.service
systemctl restart doublezerod
systemctl list-timers --all | grep hyperspace-disk-janitor
```

The janitor runs every minute. It checks both the root filesystem and the
RAM-backed `/run` filesystem. At 70% `/run` usage it rotates and vacuums only
runtime journals to 8MiB; at 85% it restarts journald and retries. If `/` is at
least 85% used, it vacuums persistent journald to 200MiB, runs `apt-get clean`,
and forces logrotate. If `/` is still at least 95% used after that soft cleanup,
it truncates only known system log files (`/var/log/syslog*` and
`/var/log/kern.log*`) and reloads/restarts `rsyslog`.

Gate journald uses persistent storage with a 200MiB cap. Runtime journals are
limited to 16MiB and must leave at least 32MiB free in `/run`; this is critical
on 1GiB VMs where `/run` itself can be only about 100MiB. The DoubleZero unit
filters the high-volume passive no-op liveness message while retaining errors,
warnings, connection changes, and other service logs. `ForwardToSyslog=no`
avoids writing every service log to both journald and `/var/log/syslog`.

The textfile collector exports root and `/run` before/after values. Prometheus
raises a warning at 70% `/run` usage and an immediate critical alert at 85%,
even when the janitor recovered the host before the next run. It also alerts on
low available RAM and Linux OOM kills.

It must not remove or mutate `/etc/hyperspace`, `/var/lib/hyperspace-gate`,
WireGuard state, DoubleZero identity files, or control-plane data.

## Control-Plane Host Bootstrap

Run these steps on the host that will run the web UI, API, worker, and
PostgreSQL for the minimum three-server deployment.

### Control-plane log and disk maintenance

Install the control-plane maintenance timer before starting application
services. API and worker stdout remains available in the persistent journal,
but is not duplicated into `/var/log/syslog`. The journal keeps at most seven
days and 256 MiB while reserving 2 GiB on the root filesystem.

```bash
apt-get update
apt-get install -y logrotate util-linux

install -d -m 0755 /usr/local/sbin
install -m 0755 "$HS_REPO_DIR/scripts/hyperspace-control-plane-log-maintenance.sh" \
  /usr/local/sbin/hyperspace-control-plane-log-maintenance

install -d -m 0755 /etc/systemd/journald.conf.d
install -m 0644 "$HS_REPO_DIR/infra/journald/zz-hyperspace-control-plane-limits.conf" \
  /etc/systemd/journald.conf.d/zz-hyperspace-control-plane-limits.conf
install -d -m 2755 -o root -g systemd-journal /var/log/journal

install -m 0644 "$HS_REPO_DIR/infra/systemd/hyperspace-control-plane-log-maintenance.service" \
  /etc/systemd/system/hyperspace-control-plane-log-maintenance.service
install -m 0644 "$HS_REPO_DIR/infra/systemd/hyperspace-control-plane-log-maintenance.timer" \
  /etc/systemd/system/hyperspace-control-plane-log-maintenance.timer

systemctl daemon-reload
systemctl restart systemd-journald
journalctl --flush
systemctl enable --now hyperspace-control-plane-log-maintenance.timer
systemctl start hyperspace-control-plane-log-maintenance.service

systemctl is-active hyperspace-control-plane-log-maintenance.timer
systemctl status hyperspace-control-plane-log-maintenance.service --no-pager
df -h /
journalctl --disk-usage
```

The timer runs every ten minutes. Every run rotates and vacuums journald and
runs normal logrotate processing. At 80% root usage it also clears the apt
package cache and forces log rotation. At 95%, it first truncates only the
duplicated `/var/log/syslog*` and `/var/log/kern.log*` files, reloads rsyslog,
then clears the package cache without trying to compress multi-gigabyte logs on
an already full filesystem. It never removes PostgreSQL data, `/etc/hyperspace`,
application artifacts, WireGuard state, or backups.

If the service still exits unsuccessfully, identify the remaining large files
instead of expanding the cleanup allowlist blindly:

```bash
find /var -xdev -type f -printf '%s %p\n' | sort -nr | head -n 30
journalctl -u hyperspace-control-plane-log-maintenance.service -n 50 --no-pager
```

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
export CUSTODIAL_WALLET_ENCRYPTION_KEY="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))')"
```

Create `/etc/hyperspace/control-plane-api.env`:

Load environment-specific RPC endpoints from secret management before rendering
the control-plane env files. The API and worker values may differ: the API needs
transaction execution methods, while the deposit worker requires finalized
history through `getSignaturesForAddress`, `getSignatureStatuses` and
`getTransaction`. The private endpoint is only for Solana-mainnet-backed
staging and production; testnet must use its Solana testnet RPC. Never commit a
real endpoint.

```bash
# Non-resolving placeholder; inject the real staging/production value securely.
export SOLANA_RPC_URL=https://solana-rpc.example.invalid
```

```bash
cat >/etc/hyperspace/control-plane-api.env <<EOF
HOST=127.0.0.1
PORT=8080
DATABASE_URL=${DATABASE_URL}
AUTH_SESSION_TTL_SECONDS=2592000
ARTIFACT_DOWNLOAD_TTL_SECONDS=300
ADMIN_TOKEN=${ADMIN_TOKEN}
# Comma-separated verified account emails allowed to open the network admin.
BILLING_ADMIN_EMAILS=
ARTIFACT_ENCRYPTION_KEY=${ARTIFACT_ENCRYPTION_KEY}
GATE_AGENT_RELEASE_DIR=/var/lib/hyperspace/gate-agent-releases
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

# Milestone 3 onboarding and billing.
EMAIL_PROVIDER=resend
EMAIL_FROM="Hyperspace <no-reply@hyperspace.zone>"
EMAIL_REPLY_TO=support@hyperspace.zone
RESEND_API_KEY=replace-with-resend-api-key
EMAIL_OTP_HASH_SECRET=replace-with-random-32-byte-secret
EMAIL_OTP_TTL_SECONDS=600
EMAIL_OTP_EXPOSE_CODES=false

# Google OAuth is optional until a Google OAuth client is provisioned.
APP_PUBLIC_URL=https://app.testnet.hyperspace.zone
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_OAUTH_REDIRECT_URL=
GOOGLE_OAUTH_STATE_TTL_SECONDS=600

# Permanent account-scoped Solana deposit wallets.
CUSTODIAL_WALLET_ENCRYPTION_KEY=${CUSTODIAL_WALLET_ENCRYPTION_KEY}
BILLING_CURRENCY=SOL
SOLANA_ASSET_KIND=native
SOLANA_TOKEN_SYMBOL=SOL
SOLANA_TOKEN_MINT=native
SOLANA_TOKEN_DECIMALS=9
SOLANA_TOKEN_BASE_UNITS_PER_BILLING_MINOR=1
SOLANA_RPC_URL=${SOLANA_RPC_URL:?set an environment-specific Solana RPC URL}
SOLANA_EXPLORER_TX_BASE_URL=https://orbmarkets.io/tx/
SOLANA_CONFIG_PAYMENT_ENABLED=true
SOLANA_CONFIG_PRICE_LAMPORTS=100000
SOLANA_REVENUE_TREASURY_ADDRESS=replace-with-platform-solana-wallet
BILLING_USAGE_MARKUP_BPS=1500
BILLING_ENFORCE_POSITIVE_BALANCE=false
BILLING_REQUIRED_MIN_BALANCE_MINOR=0
EOF
chown root:hyperspace /etc/hyperspace/control-plane-api.env
chmod 0640 /etc/hyperspace/control-plane-api.env
install -d -o hyperspace -g hyperspace -m 0750 /var/lib/hyperspace/gate-agent-releases
```

The self-service API enables basic abuse controls by default. Public API rate
limits are in-memory per API process and are intended to absorb accidental or
low-effort abuse. Session create controls are enforced transactionally per
account: active non-terminal VPN configs are capped, create bursts are capped
per window, IP-to-IP targets must be public IPv4 `/32` destinations unless
explicitly overridden. Full-tunnel configs may be unrestricted by source; if a
source restriction is supplied, the API only validates that it is an IPv4 CIDR.

New deposits use the permanent account address. In native SOL mode, the worker
scans that address and requires finalized RPC confirmation plus a positive
recipient lamport delta before claiming the
globally unique transaction signature and crediting the immutable balance ledger.
Fixed-amount payment intents are not part of the product or database schema. See
`docs/runbooks/milestone3-billing-and-wallets.md` for the direct-deposit model.

Google OAuth setup prompt for a browser automation agent after you log in to
Google Cloud Console:

```text
Open Google Cloud Console and create or update an OAuth 2.0 Web application
client for Hyperspace.

Authorized JavaScript origins:
- https://app.testnet.hyperspace.zone
- https://app.hyperspace.zone

Authorized redirect URIs:
- https://app.testnet.hyperspace.zone/api/v1/public/auth/google/callback
- https://app.hyperspace.zone/api/v1/public/auth/google/callback

Copy the Client ID and Client Secret, then update GOOGLE_CLIENT_ID,
GOOGLE_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URL, and APP_PUBLIC_URL in
/etc/hyperspace/control-plane-api.env for testnet or mainnet. Do not print the
secret into the chat.
```

The callback uses the public app origin. Caddy proxies `/api/*` to the control
plane, where the authorization code is exchanged without exposing the Google
client secret to the browser. Configure the exact matching value per cluster:

```text
# testnet
APP_PUBLIC_URL=https://app.testnet.hyperspace.zone
GOOGLE_OAUTH_REDIRECT_URL=https://app.testnet.hyperspace.zone/api/v1/public/auth/google/callback

# mainnet
APP_PUBLIC_URL=https://app.hyperspace.zone
GOOGLE_OAUTH_REDIRECT_URL=https://app.hyperspace.zone/api/v1/public/auth/google/callback
```

### Account identity linking

An account may have password, email OTP, Google, and wallet identities. The
canonical rules are independent of sign-in order:

- password registration creates a pending account and sends an OTP; it does
  not create an authenticated session until the email is verified;
- password login is rejected until the matching email identity is verified;
- Google login first resolves the immutable Google `sub`, then links a new
  Google identity to an existing account only by the verified Google email;
- OTP after Google, and Google after verified password registration, reuse the
  same account because the normalized email identity is unique;
- if Google encounters a legacy unverified password account, the old password
  and sessions are revoked before Google claims it, preventing account
  pre-hijacking;
- Google display name replaces only an email-shaped placeholder, while its
  avatar is synchronized into the public profile.

Do not bypass email verification for password registrations. Migration
`0021_verified_identity_linking.sql` backfills legacy password identities as
pending unless they were already verified by OTP or Google.

DoubleZero tenant billing snapshots can be ingested by an operator with
`ADMIN_TOKEN`:

```bash
curl -fsS -X POST "$HS_API_ORIGIN/v1/admin/billing/doublezero/tenant-snapshots" \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  --data @tenant-billing-snapshot.json
```

The JSON must include `cluster`, `tenant`, and `raw`. Optional normalized fields
are `paymentStatus`, `tokenAccount`, `billingRate`, and
`lastDeductionDzEpoch`. Keep the raw DoubleZero output intact for auditability.

DoubleZero usage imports are replay-safe and apply Hyperspace markup before
writing debit entries to the immutable balance ledger. `BILLING_USAGE_MARKUP_BPS`
is basis points over the DoubleZero cost, so `1500` means 15%.

```bash
curl -fsS -X POST "$HS_API_ORIGIN/v1/admin/billing/doublezero/usage-imports" \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  --data @doublezero-usage-import.json
```

Example record shape:

```json
{
  "cluster": "mainnet",
  "tenant": "hyperspace",
  "importSource": "doublezero-metering-2026-07-09T13:00Z",
  "raw": {},
  "records": [
    {
      "recordId": "dz-usage-unique-id",
      "sessionId": "hyperspace-session-id",
      "windowStart": "2026-07-09T13:00:00Z",
      "windowEnd": "2026-07-09T14:00:00Z",
      "bytesIn": 123456,
      "bytesOut": 654321,
      "doubleZeroCostMinor": 17,
      "currency": "USD"
    }
  ]
}
```

If `sessionId` is absent, the record may include `accountId` directly. Replaying
the same `recordId` is safe: the rated usage event is unique by source and will
not double-charge the account.

Milestone 3 gate scale-out should use the repository automation scripts instead
of hand-copying commands from this runbook. The scripts are designed for rollout
waves and support dry-run output before mutating any host:

```bash
npm run gates:rollout-wave -- \
  --inventory infra/gates.mainnet.json \
  --wave 2026-07-a \
  --canary-gate gate-eu-fra-21 \
  --ssh-key /root/hyperspace/.ssh_keys/hyperspace_mainnet_gatekeeper_20260526 \
  --known-hosts-file /root/.ssh/known_hosts \
  --control-plane-url https://control-plane.hyperspace.zone \
  --web-origin https://app.hyperspace.zone \
  --observability-ip 84.32.83.71 \
  --gate-token-dir /root/hyperspace/secrets/mainnet-gate-tokens \
  --probe-secret-file /root/hyperspace/secrets/mainnet-gate-probe-secret

# execute only after reviewing the dry-run
npm run gates:rollout-wave -- ... --execute
```

The canary must pass the exact artifact's on-host nftables parser self-test,
restart cleanly, and report the expected SHA-256 back through a fresh
control-plane heartbeat. The remaining wave does not start before those checks
pass. Each host keeps an append-only deployment history, build/install dates,
the previous artifact, and an automatic rollback path. A failed candidate is
never treated as deployed merely because its systemd process remained active.

The SSH rollout is also the one-time bootstrap path for agents installed before
managed releases were introduced. The control plane refuses to queue a managed
release until the gate heartbeat reports `control-plane-agent-rollout:v1`.
After that bootstrap, normal binary rollout is initiated by the control plane;
operators no longer copy a binary to every gate:

```bash
# Build from a clean committed revision first.
scripts/gates/build-agent --output /tmp/hyperspace-gate-agent

# Run as root: nft --check needs CAP_NET_ADMIN even though no rules are applied.
# Dry-run validates the exact artifact and canary order without API mutations.
sudo npm run gates:control-plane-rollout -- \
  --binary /tmp/hyperspace-gate-agent \
  --control-plane-url https://control-plane.hyperspace.zone \
  --admin-token-file /root/hyperspace/secrets/mainnet-admin.token \
  --gate gate-eu-fra-21 \
  --gate gate-eu-lon-01 \
  --canary-gate gate-eu-fra-21

# Run this on the control-plane API host so the immutable artifact is staged in
# GATE_AGENT_RELEASE_DIR, then registered and distributed through gate jobs.
sudo npm run gates:control-plane-rollout -- ... --execute
```

The runner stages the non-secret immutable binary with mode `0755` inside the
API-owned `GATE_AGENT_RELEASE_DIR`; the API remains unprivileged and verifies
the registered metadata and SHA-256 again before serving it to a gate.
Release `builtAt` values are RFC3339 instants. PostgreSQL may serialize the
same instant with fractional seconds, so agents compare parsed timestamps
rather than requiring byte-for-byte timestamp formatting.

The managed rollout processes one canary to a terminal `succeeded` state before
requesting any remaining gate. A gate is temporarily excluded from new session
scheduling while its deployment is active. Success requires all of the
following from the specific host: the exact registered SHA-256, a heartbeat
newer than activation, a connected lease, and the startup nftables self-test
capability. A verification timeout requests rollback to the previous immutable
artifact; rollback is retried up to three times. Release metadata and
`requestedAt`, `stagedAt`, `installedAt`, `verifiedAt`, `rolledBackAt`, and
`failedAt` remain queryable from `/v1/admin/gate-agent/deployments`.

`HyperspaceGateAgentDeploymentStalled` and
`HyperspaceGateAgentDeploymentFailed` are critical. They include gate access
labels in Telegram, so a failed rollout cannot remain invisible for weeks.

The gate-agent also protects an enabled gate from remaining attached to an
administratively `drained` DoubleZero device. It reads the current device from
`doublezero status`, confirms the on-chain device status with
`doublezero device get --json`, and requires the drained condition to persist
for at least two minutes. It then performs exactly one asynchronous
`doublezero disconnect ibrl` / `doublezero connect ibrl` cycle while heartbeats
continue, and verifies both `BGP Session Up` and installed BGP routes. The
result, timestamps, previous/new device, and six-hour retry cooldown are
persisted in `/var/lib/hyperspace-gate/doublezero-recovery.json` and reported in
every heartbeat. Each new completion is also copied to the central audit log as
`gate_doublezero_recovery_completed`. Healthy devices, transient observations,
unknown device state, and ordinary non-drained BGP failures are never
disconnected automatically.

`HyperspaceEnabledGateDoubleZeroNotReady` is critical. Its Telegram text says
whether guarded recovery already ran and failed, is running, or was not
eligible and therefore needs operator inspection. Operators must not loop the
disconnect/connect commands during the reported cooldown. Defaults can be
overridden in `/etc/hyperspace/gate-agent.env` with
`DOUBLEZERO_AUTO_RECOVERY`, `DOUBLEZERO_RECOVERY_CONFIRMATION`,
`DOUBLEZERO_RECOVERY_COOLDOWN`, `DOUBLEZERO_RECOVERY_VERIFY_TIMEOUT`, and
`DOUBLEZERO_KEYPAIR_PATH`; production defaults enable recovery, require two
minutes of confirmation, and allow one attempt per six hours.

The automation installs host packages, HWE kernel where available, DoubleZero,
chrony, Caddy, WireGuard tooling, node exporter, `vnstat`, `sysstat`, journald
limits, the disk janitor, the gate resource exporter, the passive DoubleZero
route-liveness tuning and aggregate DoubleZero metrics. It also derives the
UDP/19192 gate allowlist from all non-removed inventory entries and persists
TCP/9100 access from every repeated `--observability-ip`. Mainnet currently
uses `84.32.83.71`, testnet uses `81.27.101.158`, and staging uses
`84.32.110.4`. It configures a `standard` conntrack tier (`65536`) by default.
Inventory entries may request the `hub` tier (`262144`), but bootstrap rejects
that tier below 2 GiB RAM and requires a canary.
The bootstrap persists both the tier and module ordering: it installs
`nf_conntrack` in `/etc/modules-load.d/90-hyperspace-gate.conf` before storing
the tier values in `/etc/sysctl.d/90-hyperspace-gate.conf`. This ordering is
required because `systemd-sysctl` runs early during boot and otherwise may skip
`nf_conntrack_max` and `nf_conntrack_acct` while the module-owned sysctls do not
yet exist.
It never overwrites `/root/.config/doublezero/id.json`; if a host does not yet
have a DoubleZero identity or access-pass, keep that gate `Disabled` or
`Maintenance` in the catalog until DoubleZero approves it.

Validate every new or rebooted standard-tier gate before enabling traffic:

```bash
grep -x nf_conntrack /etc/modules-load.d/90-hyperspace-gate.conf
sysctl net.netfilter.nf_conntrack_max net.netfilter.nf_conntrack_acct
```

Expected output is `nf_conntrack_max = 65536` and `nf_conntrack_acct = 1`.
Anything lower is a bootstrap failure and can cause new flows, including SSH,
to be dropped when the default conntrack table fills.

All fleet scripts require verified SSH host keys. Populate the selected
`known_hosts` file out of band and review fingerprints before `--execute`; a
new or changed key must stop the rollout.

Create `/etc/hyperspace/control-plane-worker.env` with the same
`ARTIFACT_ENCRYPTION_KEY`. `SOLANA_RPC_URL` is the private live endpoint used
for transaction hashes supplied to the live payment flow.
`SOLANA_HISTORY_RPC_URL` is worker-only and runs the complete periodic history
reconciliation path. Never put its credential in Git:

```bash
cat >/etc/hyperspace/control-plane-worker.env <<EOF
DATABASE_URL=${DATABASE_URL}
WORKER_POLL_MS=2000
BENCHMARK_SCHEDULER_POLL_MS=15000
WORKER_SNAPSHOT_INTERVAL_MS=15000
WORKER_ID=control-plane-worker-01
WORKER_OBSERVABILITY_HOST=0.0.0.0
WORKER_OBSERVABILITY_PORT=9091
ARTIFACT_ENCRYPTION_KEY=${ARTIFACT_ENCRYPTION_KEY}
SOLANA_RPC_URL=${SOLANA_RPC_URL:?set an environment-specific Solana RPC URL}
SOLANA_HISTORY_RPC_URL=${SOLANA_HISTORY_RPC_URL:?set a history-capable Solana RPC URL}
SOLANA_HISTORY_RPC_REQUESTS_PER_SECOND=8
HELIUS_PROJECT_ID=${HELIUS_PROJECT_ID:-}
HELIUS_USAGE_POLL_INTERVAL_SECONDS=300
SOLANA_ASSET_KIND=${SOLANA_ASSET_KIND:-native}
SOLANA_TOKEN_SYMBOL=${SOLANA_TOKEN_SYMBOL:-SOL}
SOLANA_TOKEN_MINT=${SOLANA_TOKEN_MINT:-native}
SOLANA_TOKEN_DECIMALS=${SOLANA_TOKEN_DECIMALS:-9}
SOLANA_TOKEN_BASE_UNITS_PER_BILLING_MINOR=${SOLANA_TOKEN_BASE_UNITS_PER_BILLING_MINOR:-1}
SOLANA_DEPOSIT_RECONCILE_INTERVAL_SECONDS=15
SOLANA_DIRECT_DEPOSIT_SCAN_INTERVAL_SECONDS=600
SOLANA_DIRECT_DEPOSIT_SCAN_BATCH_SIZE=25
BILLING_CURRENCY=${BILLING_CURRENCY:-SOL}
BILLING_USAGE_MARKUP_BPS=${BILLING_USAGE_MARKUP_BPS:-1500}
RETAIL_BILLING_ENABLED=${RETAIL_BILLING_ENABLED:-false}
RETAIL_BILLING_MODE=${RETAIL_BILLING_MODE:-shadow}
RETAIL_BILLING_INTERVAL_SECONDS=${RETAIL_BILLING_INTERVAL_SECONDS:-300}
RETAIL_BILLING_SETTLEMENT_LAG_SECONDS=${RETAIL_BILLING_SETTLEMENT_LAG_SECONDS:-120}
RETAIL_BILLING_BATCH_SIZE=${RETAIL_BILLING_BATCH_SIZE:-250}
EMAIL_PROVIDER=${EMAIL_PROVIDER:-resend}
RESEND_API_KEY=${RESEND_API_KEY:-}
EMAIL_FROM=${EMAIL_FROM:-Hyperspace <no-reply@hyperspace.zone>}
EMAIL_REPLY_TO=${EMAIL_REPLY_TO:-gatekeepers@hyperspace.zone}
SOLANA_WITHDRAWALS_ENABLED=${SOLANA_WITHDRAWALS_ENABLED:-false}
SOLANA_WITHDRAWAL_INTERVAL_SECONDS=${SOLANA_WITHDRAWAL_INTERVAL_SECONDS:-30}
CUSTODIAL_WALLET_ENCRYPTION_KEY=${CUSTODIAL_WALLET_ENCRYPTION_KEY:-}
SOLANA_FEE_PAYER_SECRET_KEY=${SOLANA_FEE_PAYER_SECRET_KEY:-}
DOUBLEZERO_METERING_URL=${DOUBLEZERO_METERING_URL:-}
DOUBLEZERO_METERING_BEARER_TOKEN=${DOUBLEZERO_METERING_BEARER_TOKEN:-}
DOUBLEZERO_METERING_SOURCE_NAME=${DOUBLEZERO_METERING_SOURCE_NAME:-doublezero-hyperspace}
DOUBLEZERO_METERING_CLUSTER=${DOUBLEZERO_METERING_CLUSTER:-mainnet-beta}
DOUBLEZERO_METERING_TENANT=${DOUBLEZERO_METERING_TENANT:-hyperspace}
DOUBLEZERO_METERING_INTERVAL_SECONDS=${DOUBLEZERO_METERING_INTERVAL_SECONDS:-300}
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

The worker runs reconciliation, benchmark scheduling, and Prometheus snapshot
collection as independent loops. Keep `WORKER_POLL_MS` low for lifecycle work,
but do not run the all-pairs benchmark scheduler on that cadence;
`BENCHMARK_SCHEDULER_POLL_MS=15000` is sufficient for a five-minute benchmark
interval. `WORKER_SNAPSHOT_INTERVAL_MS=15000` keeps business metrics fresh even
while reconciliation or scheduling is slow. The
`HyperspaceControlPlaneSnapshotStale` warning detects a completed snapshot age
above one minute.

The scheduler migrations include partial indexes for active and recent
benchmark and NTP-discovery jobs. Apply every migration before restarting a
worker; on a large historical `jobs` table, omitting these indexes can turn a
scheduler cycle into a minute-long sequential scan.

`ARTIFACT_ENCRYPTION_KEY` must be identical for API and worker. Do not rotate it
without a migration plan for existing artifacts.

`CUSTODIAL_WALLET_ENCRYPTION_KEY` must also be identical for API and worker
when withdrawals are enabled. Start retail billing with `shadow`; inspect
ratings and assign an explicit priced plan before changing it to `enforce`.
Keep withdrawals disabled until the dedicated fee payer is funded with SOL and
the configured SPL mint has passed a live top-up/withdrawal test. See
`docs/architecture/retail-billing.md` for the accounting invariants and admin
role command.

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

install -o root -g root -m 0644 infra/systemd/hyperspace-control-plane-api.service /etc/systemd/system/
install -o root -g root -m 0644 infra/systemd/hyperspace-control-plane-worker.service /etc/systemd/system/
install -o root -g root -m 0755 scripts/control-plane/restart-after-migrations \
  /usr/local/sbin/hyperspace-control-plane-restart

/usr/local/sbin/hyperspace-control-plane-restart \
  --repo-dir "$HS_REPO_DIR" \
  --env-file /etc/hyperspace/control-plane-api.env \
  --worker-env-file /etc/hyperspace/control-plane-worker.env \
  --api-health-url "https://${HS_API_HOST}/health"
```

The restart wrapper applies every migration shipped with the deployed tree,
runs the migration command a second time to prove that no migration remains
pending, and only then restarts API and worker. A migration or verification
failure leaves the old processes running. Do not replace this ordering with a
bare `systemctl restart`: code that expects a newer schema can otherwise keep
the worker business snapshot incomplete.

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

The deployed mainnet-backed staging topology and its gate transfer procedure are
documented in [staging-cluster.md](staging-cluster.md).

Run this section on the observability host. Set `HS_CLUSTER` to `testnet`,
`staging`, or `mainnet`; set `OBSERVABILITY_DOMAIN` to the public Grafana host.

Grafana 13 plus Prometheus should run on a host with at least 2 GB RAM. On
1 GB disposable validation hosts, add a 2 GB swap file before starting Grafana;
without swap, dashboard/API requests can hit Grafana handler timeouts under
load.

```bash
export HS_CLUSTER=testnet
export OBSERVABILITY_DOMAIN=observability.testnet.hyperspace.zone
export HS_REPO_DIR=/opt/2z-wireguard-vpn
```

### Service host and PostgreSQL exporters

Every cluster monitors only its own web, control-plane, PostgreSQL, and
observability VMs. Prefer a private scrape address; use a public address only
when the cluster has no private network. The installer binds node exporter to
that address and permits TCP/9100 only from the same cluster's observability
source address.

Current scrape inventory:

| Cluster | Role | Scrape address | Public access label | Observability source |
| --- | --- | --- | --- | --- |
| mainnet | web | `10.179.228.36` | `app.hyperspace.zone` / `84.32.83.69` | `10.179.228.19` |
| mainnet | control-plane | `10.179.228.41` | `control-plane.hyperspace.zone` / `5.199.161.13` | `10.179.228.19` |
| mainnet | PostgreSQL | `10.179.228.12` | `db.hyperspace.zone` / `84.32.51.45` | `10.179.228.19` |
| testnet | web | `212.147.234.79` | `app.testnet.hyperspace.zone` / `212.147.234.79` | `81.27.101.158` |
| testnet | control-plane | `81.27.100.130` | `control-plane.testnet.hyperspace.zone` / `81.27.100.130` | `81.27.101.158` |
| testnet | PostgreSQL | `81.27.100.29` | `db.testnet.hyperspace.zone` / `81.27.100.29` | `81.27.101.158` |
| staging | web | `10.179.228.40` | `app.staging.hyperspace.zone` / `84.32.25.11` | `10.179.228.54` |
| staging | control-plane | `10.179.228.44` | `control-plane.staging.hyperspace.zone` / `84.32.83.198` | `10.179.228.54` |
| staging | PostgreSQL | `10.179.228.4` | `db.staging.hyperspace.zone` / `84.32.97.140` | `10.179.228.54` |

Run on each web, control-plane, and PostgreSQL VM from its repository checkout:

```bash
scripts/observability/install-service-node-exporter \
  --listen-ip "$HOST_SCRAPE_IPV4" \
  --observability-ip "$CLUSTER_OBSERVABILITY_SOURCE_IPV4"
```

Run additionally on the PostgreSQL VM:

```bash
scripts/observability/install-postgres-monitoring \
  --listen-ip "$HOST_SCRAPE_IPV4" \
  --observability-ip "$CLUSTER_OBSERVABILITY_SOURCE_IPV4" \
  --database hyperspace
```

`postgres_exporter` authenticates over the local Unix socket as a dedicated
`prometheus` role with `pg_monitor`; no database password is stored. The local
textfile collector exports connection utilization, longest transaction,
autovacuum backlog, oldest XID, database size, WAL size, and latest dump age.
TCP/9187 is restricted like TCP/9100. TCP/5432 is admitted from the local
observability host for the blackbox TCP handshake while existing application
access remains unchanged.

Install and verify the daily backup timer on a new DB VM before accepting users:

```bash
scripts/db/install-backup
systemctl status hyperspace-db-backup.timer
systemctl start hyperspace-postgres-health-exporter.service
grep '^hyperspace_postgres_backup_' \
  /var/lib/node_exporter/textfile_collector/hyperspace_postgres_health.prom
```

Do not start a local production dump when free disk cannot hold the dump plus
PostgreSQL working space. Add backup storage first. Until a verified dump is
visible, `HyperspacePostgreSQLBackupMissing` intentionally remains critical.

For offsite object storage, place a root-only
`/etc/hyperspace/db-backup-offsite.env` on the DB host before running the
installer. The file must provide the Restic repository, its independently
generated encryption password, and the provider credentials. For an EU R2
bucket, the shape is:

```dotenv
AWS_ACCESS_KEY_ID=<bucket-scoped-access-key>
AWS_SECRET_ACCESS_KEY=<bucket-scoped-secret>
AWS_DEFAULT_REGION=auto
RESTIC_REPOSITORY=s3:https://<account-id>.eu.r2.cloudflarestorage.com/<bucket>
RESTIC_PASSWORD=<independent-random-restic-password>
RESTIC_CACHE_DIR=/var/cache/hyperspace-restic
HS_DB_RESTIC_KEEP_DAILY=7
HS_DB_RESTIC_KEEP_WEEKLY=4
```

Run `scripts/observability/install-postgres-monitoring`, then set
`HS_DB_OFFSITE_BACKUP_ENABLED=1` in
`/etc/hyperspace/postgres-monitoring.env`, restart the health exporter, and verify both
`hyperspace_postgres_backup_last_success_timestamp_seconds` and
`hyperspace_postgres_offsite_backup_last_success_timestamp_seconds`. Object
storage credentials must be restricted to one private bucket; where supported,
also restrict them to the DB host's egress IP.

For provider-managed NFS storage, mount the export exactly at
`/var/backups/hyperspace` and set
`HS_DB_OFFSITE_BACKUP_MODE=filesystem` plus
`HS_DB_OFFSITE_FILESYSTEM_TYPE=nfs4` in `/etc/hyperspace/db-backup.env`. The
backup unit requires the mount, and the script verifies its exact target and
filesystem type before writing. Enable offsite monitoring as above. Never use
`nofail` without the script mount check: otherwise an unavailable NFS export
can silently redirect large dumps to the local root filesystem.

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

Install Prometheus, Alertmanager, Grafana, and Caddy:

```bash
apt-get update
apt-get install -y prometheus prometheus-alertmanager prometheus-node-exporter \
  prometheus-blackbox-exporter caddy gettext-base jq \
  apt-transport-https software-properties-common wget gpg

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
install -m 0644 "$HS_REPO_DIR/infra/observability/blackbox/blackbox.yml" \
  /etc/prometheus/blackbox.yml
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

### Observability host disk alerts

Prometheus must scrape the observability host itself so low disk space is
reported before TSDB writes and alert evaluation fail. The cluster Prometheus
configuration includes the observability role in `hyperspace-host-node` at
`127.0.0.1:9100`; enable its node exporter during every observability-host
deployment:

```bash
systemctl enable --now prometheus-node-exporter
curl -fsS http://127.0.0.1:9100/metrics >/dev/null
```

The self-monitoring rules are critical and route through the normal critical
Alertmanager receivers:

- `HyperspaceHostNodeExporterDown` fires after any service-host exporter is
  unavailable for two minutes.
- `HyperspaceHostRootFilesystemPressure` warns below 15% or 4 GiB free.
- `HyperspaceHostRootFilesystemCritical` fires below 5% or 1 GiB free and
  keeps firing for 30 minutes.
- The same host job covers inode, RAM, OOM-kill, and sustained CPU pressure.

Keep enough free space for TSDB compaction. A mainnet observability host should
have at least 40 GiB of root storage for 30-day retention; use shorter retention
or size-based retention when projected TSDB usage plus at least 20% compaction
headroom does not fit. Because a fully exhausted disk can prevent Prometheus
from emitting its own alert, install the independent meta-monitor below in
addition to these early-warning rules. A fully powered-off observability VM
cannot notify through its own Prometheus and Alertmanager, so the neighboring
cluster checks its public Prometheus readiness endpoint.

### Blackbox and PostgreSQL alerts

`scripts/observability/install-gate-discovery` installs and starts blackbox
exporter. The cluster Prometheus configuration probes its own app home page,
app `/api/health`, direct control-plane `/health`, and PostgreSQL TCP/5432.
HTTPS probes also export certificate expiry. Alerts cover HTTP/TCP failure and
TLS expiry at 14-day warning and 3-day critical thresholds.

PostgreSQL alerts cover postgres exporter loss, 80%/95% connection pressure,
5/30-minute transactions, sustained autovacuum backlog, transaction-ID age,
24-hour database growth, 4/8-GiB WAL pressure, collector staleness, and
36/72-hour backup age. All host, PostgreSQL, and blackbox targets include
`role`, `service_host`, and `service_ipv4`; Telegram therefore names the exact
VM to inspect.

### Gate host resource alerts

Gate host disk and RAM alerts use Prometheus `node_exporter` on every active
gate. Install it during gate bootstrap and whenever a gate is added to the
catalog:

```bash
apt-get update
apt-get install -y prometheus-node-exporter
install -d -m 0755 /var/lib/node_exporter/textfile_collector
cat >/etc/default/prometheus-node-exporter <<'EOF'
ARGS="--collector.textfile.directory=/var/lib/node_exporter/textfile_collector"
EOF
systemctl enable --now prometheus-node-exporter
systemctl restart prometheus-node-exporter
```

The explicit restart is required: changing the service `EnvironmentFile` does
not update an already-running process, and `systemctl enable --now` does not
restart one. After the gate resource exporter has run, verify the file is
actually exposed rather than merely present on disk:

```bash
systemctl start hyperspace-gate-resource-exporter.service
curl -fsS http://127.0.0.1:9100/metrics \
  | awk '$1 == "hyperspace_gate_resource_exporter_last_run_timestamp_seconds" { found = 1 } END { exit !found }'
```

`scripts/gates/validate-host` reports `resourceMetricsPresent` and
`resourceMetricsExposed`; both must be `true` before a gate is accepted.

Prometheus scrapes gate node exporters with the `hyperspace-gate-node` job in
`infra/observability/prometheus/prometheus.${HS_CLUSTER}.yml`. Targets are
generated from Enabled catalog records; do not maintain a second static gate
list. Install the discovery renderer on the observability host:

```bash
case "$HS_CLUSTER" in
  mainnet)
    GATE_CATALOG_URL=https://control-plane.hyperspace.zone/v1/public/gates
    PROMETHEUS_RETENTION=30d
    ;;
  staging)
    GATE_CATALOG_URL=https://control-plane.staging.hyperspace.zone/v1/public/gates
    PROMETHEUS_RETENTION=14d
    ;;
  testnet)
    GATE_CATALOG_URL=https://control-plane.testnet.hyperspace.zone/v1/public/gates
    PROMETHEUS_RETENTION=90d
    ;;
  *)
    echo "unsupported HS_CLUSTER: $HS_CLUSTER" >&2
    exit 2
    ;;
esac
scripts/observability/install-gate-discovery \
  --cluster "$HS_CLUSTER" \
  --catalog-url "$GATE_CATALOG_URL" \
  --retention "$PROMETHEUS_RETENTION"
```

For the production cluster use
`https://control-plane.hyperspace.zone/v1/public/gates`; for staging use
`https://control-plane.staging.hyperspace.zone/v1/public/gates`; for testnet
use `https://control-plane.testnet.hyperspace.zone/v1/public/gates`. The timer
refreshes `/etc/prometheus/file_sd/gates.json` every minute, refuses an empty
catalog response, and leaves the last valid target file in place on failure.
Mainnet uses `30d` only with at least 40 GiB of observability storage. Do not
select `90d` unless the projected TSDB size plus at least 20% compaction
headroom fits the host.

The host-resource alerts are intentionally independent from gate-agent
heartbeats:

- `HyperspaceGateNodeExporterDown` warns when host resource metrics are not
  scrapeable.
- `HyperspaceGateRootFilesystemCritical` pages when `/` has less than 5% or
  512MiB available.
- `HyperspaceGateMemoryPressure` warns when RAM has less than 20% or 256MiB
  available for five minutes.
- `HyperspaceGateMemoryCritical` pages when RAM has less than 10% or 128MiB
  available for 30 seconds. Prometheus keeps it firing for 10 minutes so a
  rapid host stall cannot erase the notification as soon as node exporter
  becomes unreachable.
- `HyperspaceGateOOMKill` pages immediately when Linux reports an OOM kill.
- `HyperspaceGateRuntimeFilesystemPressure` warns when `/run` reaches 70%.
- `HyperspaceGateRuntimeFilesystemCritical` pages immediately when `/run`
  reaches 85%, even when the janitor recovers it on the same run.
- `HyperspaceGateDiskJanitorStale` warns when the local disk janitor has not
  reported a run for more than five minutes.
- `HyperspaceGateDiskJanitorFailed` warns when the local disk janitor reports
  its last run as failed.
- Conntrack alerts fire at 70% and 90%; table-full events are critical.
- Network, UDP-buffer and softnet drops, sustained CPU/memory pressure, vnstat
  freshness and aggregate DoubleZero metric availability are monitored
  independently from the gate-agent heartbeat.

The resource exporter reports physical-interface and `doublezero0` counters
separately. Never add them together for provider billing: overlay bytes also
cross the physical interface. `vnstat` and centrally persisted assignment
forwarding deltas are reconciliation sources. Financial debits are created only
from idempotent DoubleZero metering imports in `rated_usage_events`, with the
configured Hyperspace markup; host/interface counters must not create a second
charge for the same packet.

The janitor publishes these textfile metrics through node exporter:

- `hyperspace_gate_disk_janitor_last_run_timestamp_seconds`
- `hyperspace_gate_disk_janitor_last_before_used_percent`
- `hyperspace_gate_disk_janitor_last_after_used_percent`
- `hyperspace_gate_disk_janitor_last_before_avail_bytes`
- `hyperspace_gate_disk_janitor_last_after_avail_bytes`
- `hyperspace_gate_disk_janitor_last_success`
- `hyperspace_gate_disk_janitor_last_action{action="..."}`
- `hyperspace_gate_disk_janitor_runs_total`
- `hyperspace_gate_runtime_filesystem_last_before_used_percent`
- `hyperspace_gate_runtime_filesystem_last_after_used_percent`
- `hyperspace_gate_runtime_filesystem_last_before_avail_bytes`
- `hyperspace_gate_runtime_filesystem_last_after_avail_bytes`

Provision Alertmanager Telegram notifications. Create a Telegram bot with
BotFather, add it to the target chats, send one message in each chat, then
discover the chat IDs from the bot updates:

```bash
export TELEGRAM_BOT_TOKEN='<bot-token-from-botfather>'
curl -fsS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates"
```

For groups, `chat.id` is usually a negative number. For channels and
supergroups, Telegram Bot API IDs usually have the `-100...` form even when
the Telegram UI shows the positive suffix. For private user delivery, use the
user's Telegram `chat_id`; Telegram bots cannot send to a phone number and the
user must start a conversation with the bot first. For channels, the bot must
be allowed to post to the channel.

Store the bot token outside git. Store the routing policy in
`/etc/prometheus/alertmanager_telegram_receivers.json`: each receiver declares
the Telegram `chatId` and the alert `severities` it should receive. Add more
receivers for extra chats, channels, or private users.

```bash
export TELEGRAM_BOT_TOKEN='<bot-token-from-botfather>'

install -d -m 0755 /etc/prometheus/alertmanager_templates
install -m 0644 "$HS_REPO_DIR/infra/observability/alertmanager/templates/telegram.tmpl" \
  /etc/prometheus/alertmanager_templates/telegram.tmpl

install -m 0640 -o root -g prometheus /dev/null /etc/prometheus/telegram_bot_token
printf '%s\n' "$TELEGRAM_BOT_TOKEN" >/etc/prometheus/telegram_bot_token

if [[ "$HS_CLUSTER" == staging ]]; then
  RECEIVER_EXAMPLE="$HS_REPO_DIR/infra/observability/alertmanager/telegram-receivers.staging.example.json"
else
  RECEIVER_EXAMPLE="$HS_REPO_DIR/infra/observability/alertmanager/telegram-receivers.example.json"
fi
install -m 0640 -o root -g prometheus "$RECEIVER_EXAMPLE" \
  /etc/prometheus/alertmanager_telegram_receivers.json
nano /etc/prometheus/alertmanager_telegram_receivers.json

"$HS_REPO_DIR/scripts/render-alertmanager-telegram-config" \
  --receivers /etc/prometheus/alertmanager_telegram_receivers.json \
  --output /etc/prometheus/alertmanager.yml

amtool check-config /etc/prometheus/alertmanager.yml
```

Example receiver policy:

```json
{
  "receivers": [
    {
      "name": "hyperspace-telegram-critical",
      "chatId": -1003866413153,
      "severities": ["critical"]
    },
    {
      "name": "hyperspace-telegram-default",
      "chatId": -5402171626,
      "severities": ["critical", "warning", "info"],
      "default": true
    },
    {
      "name": "hyperspace-telegram-personal-yadrena",
      "chatId": 366795,
      "severities": ["critical"]
    }
  ]
}
```

`default: true` is the fallback receiver for alerts whose severity is not
matched by any explicit route. If no receiver has `default: true`, unmatched
alerts are intentionally dropped by an empty `hyperspace-null` receiver.

After changing `/etc/prometheus/alertmanager_telegram_receivers.json`, render
and reload Alertmanager:

```bash
jq . /etc/prometheus/alertmanager_telegram_receivers.json
"$HS_REPO_DIR/scripts/render-alertmanager-telegram-config" \
  --receivers /etc/prometheus/alertmanager_telegram_receivers.json \
  --output /etc/prometheus/alertmanager.yml
amtool check-config /etc/prometheus/alertmanager.yml
systemctl restart prometheus-alertmanager
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
systemctl enable --now prometheus prometheus-alertmanager prometheus-node-exporter \
  prometheus-blackbox-exporter grafana-server caddy
systemctl restart prometheus prometheus-alertmanager prometheus-blackbox-exporter grafana-server caddy

promtool check config /etc/prometheus/prometheus.yml
promtool check rules /etc/prometheus/rules/hyperspace-alerts.yml
promtool test rules "$HS_REPO_DIR/infra/observability/prometheus/tests/hyperspace-gate-resources.test.yml"
amtool check-config /etc/prometheus/alertmanager.yml
curl -fsS "http://127.0.0.1:9090/-/ready"
curl -fsS "http://127.0.0.1:9093/-/ready"
curl -fsSG "http://127.0.0.1:9090/api/v1/query" \
  --data-urlencode 'query=up{job="hyperspace-host-node",role="observability"}' \
  | jq -e '.data.result | length == 1 and .[0].value[1] == "1"'
curl -fsS "http://127.0.0.1:3000/api/health"
curl -fsS "https://${OBSERVABILITY_DOMAIN}/api/health"
curl -fsS "https://${OBSERVABILITY_DOMAIN}/prometheus/-/ready"
```

Send a synthetic alert to verify Telegram delivery:

```bash
amtool --alertmanager.url=http://127.0.0.1:9093 alert add \
  alertname=HyperspaceSyntheticTest severity=info cluster="${HS_CLUSTER}" \
  summary="Hyperspace synthetic Telegram alert"
```

### Independent alert-delivery meta-monitor

Install `hyperspace-meta-watch` on every observability host. It runs every two
minutes outside Prometheus and Alertmanager and checks:

- the separate meta bot token and access to the operator's private chat;
- local Alertmanager readiness and Telegram notification-failure counters;
- the primary cluster Telegram token and access to every configured receiver;
- one peer observability readiness endpoint, forming this ring:
  production → staging → testnet → production.

Two identical failed runs create an incident; two healthy runs resolve it. The
monitor sends transitions directly to the operator through a separate Telegram
bot and through Resend. It also exports `hyperspace_meta_watch_*` metrics through
node exporter's textfile collector for secondary in-cluster visibility.

Keep all credentials outside Git. Copy the cluster's existing send-capable
Resend API key from its control-plane secret store into the meta-monitor key
file. The Telegram user must first start a private conversation with
`HyperspaceMetaWatcher_bot`.

```bash
install -d -m 0750 /etc/hyperspace
install -m 0600 /dev/null /etc/hyperspace/meta-watch-telegram-bot-token
install -m 0600 /dev/null /etc/hyperspace/meta-watch-resend-api-key
printf '%s\n' "$META_WATCH_TELEGRAM_BOT_TOKEN" \
  >/etc/hyperspace/meta-watch-telegram-bot-token
printf '%s\n' "$RESEND_API_KEY" \
  >/etc/hyperspace/meta-watch-resend-api-key

install -m 0600 \
  "$HS_REPO_DIR/infra/observability/systemd/hyperspace-meta-watch.env.example" \
  /etc/hyperspace/meta-watch.env
nano /etc/hyperspace/meta-watch.env

cat >/etc/hyperspace/meta-watch-peers.tsv <<'EOF'
# peer<TAB>public Prometheus readiness URL
EOF
# Add exactly the next member of the ring for this cluster.

"$HS_REPO_DIR/scripts/observability/install-meta-watch"
systemctl start hyperspace-meta-watch.service
systemctl status hyperspace-meta-watch.timer --no-pager
cat /var/lib/prometheus/node-exporter/hyperspace_meta_watch.prom

# Explicitly tests both independent delivery channels and sends labelled TEST
# notifications to Telegram and email.
set -a; source /etc/hyperspace/meta-watch.env; set +a
/usr/local/sbin/hyperspace-meta-watch test
```

The Prometheus rules `HyperspaceMetaWatchStale` and
`HyperspaceMetaWatchDetectedFailure` are deliberately secondary. The direct
meta-monitor message is authoritative when the local observability stack is
unavailable.

Dead control-plane jobs are retained for review. `phase="dead"` means an
operator still needs to inspect the failed job and it triggers
`HyperspaceDeadJobsPresent`. After review, keep the row for history but move it
to `phase="acknowledged_dead"` so old incidents do not keep paging:

```bash
cd "$HS_REPO_DIR"

# Dry-run first. This prints grouped candidates without mutating the database.
scripts/acknowledge-dead-jobs.mjs \
  --env-file /etc/hyperspace/control-plane-worker.env \
  --older-than "24 hours"

# Execute only after the candidates are understood.
scripts/acknowledge-dead-jobs.mjs \
  --env-file /etc/hyperspace/control-plane-worker.env \
  --older-than "24 hours" \
  --execute \
  --reason "reviewed old dead jobs"
```

Use `--type probe`, `--type apply_assignment`, or `--gate gate-name` to narrow
the acknowledgement. New failures still enter `dead` first and will alert until
they are reviewed.

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
    "probeUrl": "https://gate-eu-fra-01.testnet.hyperspace.zone/.well-known/hyperspace-probe",
    "doubleZeroEnv": "mainnet-beta",
    "desiredState": "Enabled"
  },
  {
    "name": "gate-na-chi-01",
    "identity": "8qCH3vT5wX7yZ9aB2cD4eF6gH8jK9mN2pQ4rS6tU8V",
    "city": "Chicago",
    "country": "United States",
    "publicIpv4": "203.0.113.20",
    "probeUrl": "https://203.0.113.20/.well-known/hyperspace-probe",
    "doubleZeroEnv": "mainnet-beta",
    "desiredState": "Disabled"
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
The control plane also stores the lower-cased `probeUrl` hostname as
`probeHost`; this hostname must be unique as well. This prevents adding the
same HTTPS probe endpoint twice under different paths or gate names.

`desiredState` is optional and defaults to `Enabled`. Use `Disabled` when a
gate is intentionally powered off or temporarily removed from the active
footprint but may be brought back later. Disabled gates remain in the
operator/admin catalog and keep historical benchmark data, but they are hidden
from the public gate catalog, excluded from scheduling and benchmark planning,
and do not produce enabled-gate alerts. Use `Maintenance` for gates that should
remain visible in the public Gates inventory but must not accept new work yet,
for example when a host is prepared and waiting for DoubleZero `access-pass`
approval. Use `Draining` for operator workflows where the gate should remain
visible to admins while existing work is being removed.

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
rejects duplicate `name`, `identity`, `publicIpv4`, duplicate `probeUrl`, and
duplicate `probeUrl` host values.

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
`publicIpv4` must be unique, `probeUrl` and its hostname must be unique when
present, `publicIpv4` must be a public IPv4 address, `doubleZeroEnv` must be
`testnet` or `mainnet-beta`, and `desiredState` must be one of `Enabled`,
`Draining`, `Disabled`, or `Maintenance`.

To temporarily remove a gate from the active footprint without deleting
history, set it to `Disabled` in the seed file and apply the seed:

```bash
jq 'map(if .name == "gate-na-chi-02" or .publicIpv4 == "152.44.43.130" then .desiredState = "Disabled" else . end)' \
  /etc/hyperspace/gates.json >/tmp/gates.json
install -o root -g hyperspace -m 0640 /tmp/gates.json /etc/hyperspace/gates.json
sudo -u hyperspace env DATABASE_URL="$DATABASE_URL" scripts/seed-gates-json /etc/hyperspace/gates.json | jq .
```

To bring the same gate back, change `desiredState` to `Enabled`, confirm the VM
and `hyperspace-gate-agent` are running, and apply the seed again.

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

On the same control-plane or builder host, build and test an immutable
gate-agent artifact. Do not use a bare `go build` or an untracked prebuilt
binary for a rollout:

```bash
cd "$HS_REPO_DIR"
sudo -u hyperspace env PATH="/usr/local/go/bin:$PATH" \
  scripts/gates/build-agent --output /tmp/hyperspace-gate-agent
/tmp/hyperspace-gate-agent --build-info | jq .
```

The build command refuses any dirty or untracked worktree files, runs the unit suite, embeds
the commit and UTC build time, and verifies that the binary reports its own
SHA-256. Build as the `hyperspace` repository owner.

Deploy through the release playbook. Direct `scp` to the live binary path is
prohibited because it bypasses artifact validation, history and rollback:

```bash
scripts/gates/deploy-agent \
  --host "$GATE_PUBLIC_IPV4" \
  --binary /tmp/hyperspace-gate-agent \
  --reuse-existing-env \
  --ssh-key "$GATE_SSH_KEY" \
  --known-hosts-file /root/.ssh/known_hosts
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
ACTUAL_STATE_INTERVAL=60s
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
  email gatekeepers@hyperspace.zone
}

app.testnet.hyperspace.zone {
  handle /api/* {
    uri strip_prefix /api
    reverse_proxy https://control-plane.testnet.hyperspace.zone {
      header_up Host control-plane.testnet.hyperspace.zone
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
