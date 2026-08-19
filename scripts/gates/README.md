# Gate Deployment Automation

Milestone 3 gate automation is intentionally shell-first and idempotent. The
scripts assume a clean Ubuntu gate host reachable over SSH as root.

## Scripts

- `bootstrap-host` installs host packages, the HWE kernel package when
  available, DoubleZero, chrony, Caddy, WireGuard tooling, node exporter,
  `vnstat`, `sysstat`, log hygiene and resource-exporter timers. It disables
  unattended package/firmware jobs and installs the passive DoubleZero
  route-liveness tuning and aggregate metrics endpoint.
- `build-agent` requires a completely clean worktree (including no untracked
  files), runs all Go tests, embeds the
  Git revision and UTC build time, and verifies the resulting artifact SHA.
- `deploy-agent` stages an immutable `hyperspace-gate-agent` artifact and uses
  `hyperspace-gate-agent-release` to test the exact binary with the host's real
  nftables parser before activation. It snapshots the previous release,
  restarts the service, waits until the control plane observes the exact new
  SHA in a heartbeat, and rolls back automatically on any failure. For
  binary-only upgrades, `--reuse-existing-env` preserves gate secrets.
- `validate-host` prints the installed revision, build/install dates and SHA,
  and can fail the rollout unless the service and artifact self-test pass.
- `rollout-wave.mjs` runs the previous scripts for every inventory entry in a
  selected rollout wave. It always completes a named `--canary-gate` (or the
  first gate by name) before continuing. Any failed canary or gate stops the
  wave. It defaults to dry-run; pass `--execute` after review.
- `control-plane-rollout.mjs` is the normal post-bootstrap binary release path.
  It validates and stages one immutable artifact on the control-plane API host,
  registers its revision/build date/SHA, requests a canary through the admin
  API, waits for host-level verification, and only then proceeds gate by gate.
  No SSH gate credentials are used by this path.

## Example

```bash
scripts/gates/rollout-wave.mjs \
  --inventory infra/gates.mainnet.json \
  --wave 2026-07-a \
  --canary-gate gate-eu-fra-21 \
  --ssh-key /root/hyperspace/.ssh_keys/hyperspace_mainnet_gatekeeper_20260526 \
  --known-hosts-file /root/.ssh/known_hosts \
  --control-plane-url https://control-plane.hyperspace.zone \
  --web-origin https://app.hyperspace.zone \
  --web-origin https://app.staging.hyperspace.zone \
  --observability-ip 84.32.83.71 \
  --gate-token-dir /root/hyperspace/secrets/mainnet-gate-tokens \
  --probe-secret-file /root/hyperspace/secrets/mainnet-gate-probe-secret

# execute only after reviewing the rendered commands
scripts/gates/rollout-wave.mjs ... --execute
```

Each gate token is read from `${gateTokenDir}/${gateName}.token`. Secrets are
not printed in dry-run output. Fleet execution requires a populated, verified
`known_hosts` file; the scripts do not accept unknown or changed host keys.
Repeat `--web-origin` for every web application allowed to run browser RTT
probes. The generated Caddy configuration reflects the request origin only
after it matches this explicit allowlist; it never enables wildcard CORS.

Every activation appends a timestamped record to
`/var/lib/hyperspace-gate/agent-deployments.jsonl`; the current release is in
`/var/lib/hyperspace-gate/agent-release.json`, and rollback artifacts are kept
under `/var/lib/hyperspace-gate/agent-releases/<sha256>/`. Manual rollback is:

```bash
sudo /usr/local/sbin/hyperspace-gate-agent-release rollback --sha <previous-sha256>
```

An older gate must first receive one successful SSH deployment of an agent and
release helper that report `control-plane-agent-rollout:v1`. Subsequent releases
and rollbacks are requested by the control plane. The gate pulls the artifact
with gate authentication, verifies its SHA and build metadata, runs its
nftables parser self-test before and after activation, and reports the installed
SHA in a fresh heartbeat. The local helper automatically restores the previous
artifact if any of those checks fail.

Inventory entries may set `resourceTier` to `standard` or `hub`. `standard`
sets `nf_conntrack_max=65536`. `hub` sets `262144` and is rejected on hosts with
less than 2 GiB RAM. Promote a gate to `hub` only after resizing the VM and a
testnet or single-host mainnet canary.

`bootstrap-host` makes the conntrack tier reboot-safe. It writes
`nf_conntrack` to `/etc/modules-load.d/90-hyperspace-gate.conf` so the kernel
module is loaded before `systemd-sysctl` processes
`/etc/sysctl.d/90-hyperspace-gate.conf`. Without the modules-load entry, a gate
may start with the kernel default (for example `7168`) even though the sysctl
file requests `65536`. The bootstrap also loads the module and applies the
selected limit immediately during installation.

After installation, and again after any reboot, verify the standard tier with:

```bash
grep -x nf_conntrack /etc/modules-load.d/90-hyperspace-gate.conf
sysctl net.netfilter.nf_conntrack_max net.netfilter.nf_conntrack_acct
```

The expected standard-tier values are `65536` and `1`. Treat a lower limit or
disabled accounting as a failed gate bootstrap; do not wait for the conntrack
table to fill before repairing it.

The rollout derives the UDP/19192 source allowlist from every non-removed gate
IPv4 in the inventory. Each `--observability-ip` becomes a TCP/9100 source
allowlist entry. Bootstrap stores both lists in
`/etc/hyperspace/gate-firewall.env` and enables
`hyperspace-gate-firewall.service`, which recreates and verifies the UFW rules
at boot. Rerun the rollout for existing gates whenever the inventory or an
observability address changes. The service deliberately does not enable UFW or
change its default policy; manage that decision and the provider firewall
separately.

After provisioning or reboot, verify persistence with:

```bash
systemctl is-enabled hyperspace-gate-firewall.service
/usr/local/sbin/hyperspace-gate-firewall --check
ufw show added
```

Prometheus gate targets are not maintained in this inventory. Run
`scripts/observability/install-gate-discovery` on each observability host; its
timer renders Enabled gates from the public control-plane catalog into
Prometheus `file_sd` every minute.
