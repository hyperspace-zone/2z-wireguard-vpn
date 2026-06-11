# Milestone 1 Integration Validation

Use this runbook to produce reproducible evidence for Milestone 1:
DoubleZero-backed WireGuard routing, explicit ingress/egress gate selection,
route provisioning, and self-service config management.

This runbook is environment-neutral. It works for either DoubleZero `testnet`
or DoubleZero `mainnet-beta` as long as the deployed cluster follows
[Deployment Guide](deployment.md) and every gate uses the same `DZ_ENV`.

The runbook separates tests from measurements:

- Tests validate product behavior and should be run for every release or
  deployment candidate.
- Measurements build a directed public-vs-Hyperspace connectivity matrix and
  can take much longer. Run them only when placement/performance evidence is
  needed or after topology changes.

## Prerequisites

- A deployed DoubleZero WireGuard VPN cluster.
- `DZ_ENV=testnet` or `DZ_ENV=mainnet-beta` chosen before gate provisioning.
- At least two schedulable Hyperspace gates with matching DoubleZero
  `access-pass` records for that same environment.
- A public HTTPS web/API endpoint.
- At least two validation client VMs that are not gate hosts and not the
  control-plane host.
- SSH access as root or passwordless sudo to the validation client VMs.
- `python3`, `jq`, `wireguard-tools`, `iproute2`, and `chrony` on validation
  client VMs.

## Prepare Validation Clients

Copy the testnode scripts to every validation client and run the preparation
script:

```bash
rsync -az scripts/testnodes/ root@<testnode-host>:/opt/hyperspace-testnodes/
ssh root@<testnode-host> 'bash /opt/hyperspace-testnodes/prepare-testnode.sh'
ssh root@<testnode-host> 'nohup /opt/hyperspace-testnodes/one_way_probe.py server --port 19191 >/var/log/hyperspace-one-way-probe.log 2>&1 &'
```

Confirm time synchronization before one-way measurements:

```bash
ssh root@<testnode-host> 'chronyc waitsync 60 0.05 && chronyc tracking'
```

One-way values depend on both hosts' wall clocks. Treat one-way deltas as
directional diagnostics unless chrony offset is low and stable on both hosts.
RTT does not depend on cross-host clock synchronization.

## Inventory

Create an inventory file on the operator workstation:

```json
{
  "testnodes": [
    {
      "key": "client-a",
      "host": "client-a.example.net",
      "publicIp": "198.51.100.10"
    },
    {
      "key": "client-b",
      "host": "client-b.example.net",
      "publicIp": "198.51.100.20"
    }
  ],
  "gates": [
    {
      "name": "gate-eu-fra-01",
      "publicIpv4": "203.0.113.10"
    },
    {
      "name": "gate-na-chi-01",
      "publicIpv4": "203.0.113.20"
    }
  ]
}
```

Replace every host and IP with real validation nodes and deployed gates. The
`gates[].name` values must match the control-plane gate catalog. Gate names are
inventory identities, not fixed ingress/egress roles.

## Control-Plane Health

Check API health and gate readiness:

```bash
export HS_WEB_BASE=https://<web-host>
export HS_PUBLIC_API_BASE="$HS_WEB_BASE/api"

# If the API has its own public host instead of the web `/api` reverse proxy:
# export HS_PUBLIC_API_BASE=https://<api-host>

curl -fsS "$HS_PUBLIC_API_BASE/health" | jq .
curl -fsS "$HS_PUBLIC_API_BASE/v1/public/gates" | jq '.gates[] | {name, ready, schedulable, probeUrl, lastSeenAt}'
```

Use `$HS_WEB_BASE/api` when the public entrypoint is the web host, such as
`https://app.example.net/api`. Use the bare API origin when the API has its own
public host, such as `https://control-plane.example.net`.

Expected result:

- Health endpoint returns `ok: true`.
- At least two gates are `ready: true` and `schedulable: true`.
- Every gate probe URL is HTTPS.

## Product Tests

Run the fast local regression suite:

```bash
npm install
npm run build
npm run typecheck
npm test
```

Run the browser/API smoke against the deployed HTTPS cluster:

```bash
HS_WEB_BASE=https://<web-host> \
HS_API_BASE="$HS_PUBLIC_API_BASE" \
HS_TEST_INGRESS=<schedulable-ingress-gate-name> \
HS_TEST_EGRESS=<different-schedulable-egress-gate-name> \
HS_TEST_TARGET_IP=<reachable-ipv4-target> \
HS_TEST_OUTPUT_DIR=./m1-results/live \
npm run test:live:ui
```

Run the validation-client WireGuard policy smoke:

```bash
HS_API_BASE="$HS_PUBLIC_API_BASE" \
HS_TEST_OUTPUT_DIR=./m1-results/live \
HS_TESTNODE_SSH_KEY=~/.ssh/<validation-key> \
HS_TEST_INGRESS=<schedulable-ingress-gate-name> \
HS_TEST_EGRESS=<different-schedulable-egress-gate-name> \
HS_ALLOWED_SOURCE_HOST=<allowed-source-testnode-host> \
HS_ALLOWED_SOURCE_IP=<allowed-source-public-ip> \
HS_DENIED_SOURCE_HOST=<denied-source-testnode-host> \
HS_DENIED_SOURCE_IP=<denied-source-public-ip> \
HS_TARGET_HOST=<target-testnode-host> \
HS_TARGET_IP=<target-public-ip> \
HS_NON_TARGET_HOST=<non-target-testnode-host> \
HS_NON_TARGET_IP=<non-target-public-ip> \
npm run test:live:policy
```

Expected result:

- Local build, typecheck, and unit tests pass.
- UI smoke creates, downloads, revokes, and deletes a temporary config.
- Policy smoke verifies target allow, non-target deny, source deny, and custom
  client public key ownership.

## UI Acceptance Scenarios

Run these in the web UI over HTTPS:

1. Register a new account.
2. Log out and log back in.
3. Open `Create config`.
4. Create a target-restricted config with explicit ingress and egress gates.
5. Download the WireGuard config.
6. Start it on a validation client and verify the target IP is reachable.
7. Verify a non-target IP is not reachable through that restricted config.
8. Revoke the config and verify traffic stops.
9. Delete the config from the dashboard.
10. Create a full-tunnel config from a disposable validation client and verify
    the egress IP changes.
11. Create a config with a user-provided WireGuard public key and verify that
    only the matching private key can connect.

Record screenshots or terminal output for:

- Gate list showing `Ready`, `Browser RTT`, `Schedulable`, and
  `DoubleZero node` details.
- API gate-readiness output showing `ready` and `schedulable`.
- Create-config review screen showing ingress and egress.
- Dashboard showing the config becoming active.
- Downloaded client config starting successfully.
- Revoke flow ending in revoked/deleted state.

For API-driven validation, the download-token response includes two download
URLs:

- `downloadUrl` returns the JSON artifact envelope with `payload.configText`.
- `downloadConfigUrl` returns a raw WireGuard `.conf` file with
  `Content-Type: text/plain; charset=utf-8`.

Use the raw URL for `curl ... > hyperspace.conf` automation:

```bash
token_response="$(
  curl -fsS -X POST \
    -H "authorization: Bearer $HS_ACCESS_TOKEN" \
    "$HS_PUBLIC_API_BASE/v1/public/sessions/$SESSION_ID/artifacts/client-config/download-token"
)"

curl -fsSL \
  "$HS_PUBLIC_API_BASE$(jq -r '.downloadConfigUrl' <<<"$token_response")" \
  > hyperspace.conf
```

## Route Restriction Checks

For target-restricted configs:

```bash
wg-quick up ./downloaded.conf
curl --max-time 5 http://<target-ip>:<expected-port>
curl --max-time 5 http://<non-target-ip>:<same-or-known-port> || true
wg-quick down ./downloaded.conf
```

Expected result:

- The selected target is reachable.
- Non-target traffic is blocked or times out according to the route policy.

For source-restricted configs, repeat from:

- The allowed source public IP: expected to work.
- A different validation client public IP: expected to fail.

## Cleanup Verification

After validation, verify temporary configs were revoked and gate hosts do not
retain test interfaces:

```bash
curl -fsS "$HS_PUBLIC_API_BASE/v1/public/gates" | jq '.gates[] | {name, ready, schedulable, lastSeenAt}'
ssh root@<gate-host> 'wg show interfaces || true'
```

If a config was intentionally left active for a manual demo, record its label,
owner, ingress gate, and egress gate in the validation notes.

## Long-Running Measurements

The following sections produce a connectivity matrix. They are intentionally
not part of `npm test`, `npm run test:live:ui`, or
`npm run test:live:policy`.

### Public Baseline

Measure direct public Internet paths between validation clients:

```bash
npm run measure:matrix -- \
  --mode public \
  --inventory ./m1-testnodes.json \
  --ssh-key ~/.ssh/<validation-key> \
  --count 80 \
  --interval 0.04 \
  --timeout 2.0 \
  --output-dir ./m1-results
```

Expected result:

- `m1-results/public.json` is written.
- Every directed pair has `loss_percent` close to `0.0`.

### Hyperspace Route Matrix

Run the same directed matrix through issued WireGuard configs:

```bash
npm run measure:matrix -- \
  --mode hyperspace \
  --inventory ./m1-testnodes.json \
  --api-base "$HS_PUBLIC_API_BASE" \
  --ssh-key ~/.ssh/<validation-key> \
  --count 80 \
  --interval 0.04 \
  --timeout 2.0 \
  --active-timeout 120 \
  --revoke-timeout 120 \
  --wg-warmup-seconds 2.0 \
  --output-dir ./m1-results
```

What the script does:

1. Registers or logs in with a validation account.
2. Selects ingress and egress gates by nearest public ping from source and
   destination validation nodes.
3. Creates a target-restricted WireGuard config for each directed pair.
4. Waits until reconciliation reports the session `active`.
5. Downloads the client config and starts it on the source validation node.
6. Runs UDP RTT and one-way probes to the destination validation node.
7. Revokes and deletes the temporary config.

Expected result:

- `m1-results/hyperspace.json` is written.
- Every directed pair reaches `active` before measurement.
- Every directed pair has `loss_percent` close to `0.0`.
- The `path.ingressGateName` and `path.egressGateName` fields show the selected
  gate pair for each measurement.

### Compare Public vs Hyperspace

Create a markdown comparison report:

```bash
npm run measure:compare -- \
  --public ./m1-results/public.json \
  --hyperspace ./m1-results/hyperspace.json \
  --output ./m1-results/public-vs-hyperspace.md
```

Review:

- Directed pairs measured.
- Hyperspace path used for every pair.
- RTT p50 delta.
- Forward and reverse one-way deltas.
- Packet loss.

Positive deltas mean Hyperspace was faster than public Internet for that
sample window. Negative deltas are acceptable for Milestone 1 when gate
placement is not optimized for the measured pair. Milestone 1 requires a
working DoubleZero route and explicit gate selection, not universal performance
improvement for every geography.

## Submission Evidence

Attach these artifacts to Milestone 1 submission:

- Commit hash.
- `npm run build` output.
- `npm test` output.
- `go test ./...` output for `apps/gate-agent`.
- UI screenshots or Playwright smoke output.
- Live policy smoke JSON output.
- Notes identifying the DoubleZero environment used: `testnet` or
  `mainnet-beta`.

Attach these optional measurement artifacts when a performance/placement matrix
was requested:

- `m1-results/public.json`.
- `m1-results/hyperspace.json`.
- `m1-results/public-vs-hyperspace.md`.
