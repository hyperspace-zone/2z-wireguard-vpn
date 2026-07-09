# Gate Deployment Automation

Milestone 3 gate automation is intentionally shell-first and idempotent. The
scripts assume a clean Ubuntu gate host reachable over SSH as root.

## Scripts

- `bootstrap-host` installs host packages, the HWE kernel package when
  available, DoubleZero, chrony, Caddy, WireGuard tooling, disables `fwupd`, and
  installs the passive DoubleZero route-liveness tuning drop-in.
- `deploy-agent` builds or copies `hyperspace-gate-agent`, installs the systemd
  unit, writes `/etc/hyperspace/gate-agent.env` from secret files, optionally
  writes a Caddy HTTPS probe host, and restarts the service.
- `validate-host` prints a JSON readiness summary for operator review.
- `rollout-wave.mjs` runs the previous scripts for every inventory entry in a
  selected rollout wave. It defaults to dry-run; pass `--execute` after review.

## Example

```bash
scripts/gates/rollout-wave.mjs \
  --inventory infra/gates.mainnet.json \
  --wave 2026-07-a \
  --ssh-key /root/hyperspace/.ssh_keys/hyperspace_mainnet_gatekeeper_20260526 \
  --control-plane-url https://control-plane.hyperspace.zone \
  --web-origin https://app.hyperspace.zone \
  --gate-token-dir /root/hyperspace/secrets/mainnet-gate-tokens \
  --probe-secret-file /root/hyperspace/secrets/mainnet-gate-probe-secret

# execute only after reviewing the rendered commands
scripts/gates/rollout-wave.mjs ... --execute
```

Each gate token is read from `${gateTokenDir}/${gateName}.token`. Secrets are
not printed in dry-run output.
