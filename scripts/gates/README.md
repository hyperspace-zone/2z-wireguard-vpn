# Gate Deployment Automation

Milestone 3 gate automation is intentionally shell-first and idempotent. The
scripts assume a clean Ubuntu gate host reachable over SSH as root.

## Scripts

- `bootstrap-host` installs host packages, the HWE kernel package when
  available, DoubleZero, chrony, Caddy, WireGuard tooling, node exporter,
  `vnstat`, `sysstat`, log hygiene and resource-exporter timers. It disables
  unattended package/firmware jobs and installs the passive DoubleZero
  route-liveness tuning and aggregate metrics endpoint.
- `deploy-agent` builds or copies `hyperspace-gate-agent`, installs the systemd
  unit, writes `/etc/hyperspace/gate-agent.env` from secret files, optionally
  writes a Caddy HTTPS probe host, and restarts the service. For binary-only
  fleet upgrades, `--reuse-existing-env` requires the existing secret env and
  does not read or replace it.
- `validate-host` prints a JSON readiness summary for operator review.
- `rollout-wave.mjs` runs the previous scripts for every inventory entry in a
  selected rollout wave. It defaults to dry-run; pass `--execute` after review.

## Example

```bash
scripts/gates/rollout-wave.mjs \
  --inventory infra/gates.mainnet.json \
  --wave 2026-07-a \
  --ssh-key /root/hyperspace/.ssh_keys/hyperspace_mainnet_gatekeeper_20260526 \
  --known-hosts-file /root/.ssh/known_hosts \
  --control-plane-url https://control-plane.hyperspace.zone \
  --web-origin https://app.hyperspace.zone \
  --gate-token-dir /root/hyperspace/secrets/mainnet-gate-tokens \
  --probe-secret-file /root/hyperspace/secrets/mainnet-gate-probe-secret

# execute only after reviewing the rendered commands
scripts/gates/rollout-wave.mjs ... --execute
```

Each gate token is read from `${gateTokenDir}/${gateName}.token`. Secrets are
not printed in dry-run output. Fleet execution requires a populated, verified
`known_hosts` file; the scripts do not accept unknown or changed host keys.

Inventory entries may set `resourceTier` to `standard` or `hub`. `standard`
sets `nf_conntrack_max=65536`. `hub` sets `262144` and is rejected on hosts with
less than 2 GiB RAM. Promote a gate to `hub` only after resizing the VM and a
testnet or single-host mainnet canary.

Prometheus gate targets are not maintained in this inventory. Run
`scripts/observability/install-gate-discovery` on each observability host; its
timer renders Enabled gates from the public control-plane catalog into
Prometheus `file_sd` every minute.
