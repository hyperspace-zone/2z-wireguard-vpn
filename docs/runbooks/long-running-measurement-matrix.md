# Long-Running Measurement Matrix

This workflow is for placement and performance evidence after the cluster is
already deployed. It is not required for routine deployment and should not be
run as part of `npm test` or the basic live smoke checks.

The matrix can create many temporary VPN configs and probe every directed pair
of testnodes over both public internet paths and Hyperspace paths.

## Prerequisites

You need:

- One deployed control-plane/API/web cluster with at least two ready and
  schedulable gates.
- At least two dedicated testnode servers. Use three or four if you also want
  separate source, denied-source, target, and non-target roles for policy
  validation.
- Testnodes must be separate from gate hosts and from the control-plane host.
- SSH access from the runner host to every testnode. The scripts use `ssh -i`
  with `BatchMode=yes`, so key-based login must work without a password prompt.
- Root access on every testnode, or an equivalent account that can install
  packages, run `wg-quick`, create network interfaces, and bind UDP ports.
- `wireguard-tools`, `wg-quick`, Python 3, `chrony`, and the
  `scripts/testnodes/one_way_probe.py` probe installed on every testnode.
- UDP reachability between testnodes on probe port `19191`, unless you override
  `--probe-port`.
- Stable clocks on every testnode. RTT, jitter, and packet loss do not require
  cross-host clock sync, but forward/reverse one-way latency does.

Run the matrix from the control-plane host, an operator workstation, or a CI
runner that has:

- the repository checkout and Node/Python dependencies;
- HTTPS access to the public API;
- SSH access to every testnode.

## Inventory

Create an inventory from the example and replace it with your real testnodes
and gates:

```bash
export HS_REPO_DIR="${HS_REPO_DIR:-/opt/2z-wireguard-vpn}"
cd "$HS_REPO_DIR"

cp scripts/testnodes/inventory.example.json ./m1-testnodes.json
nano ./m1-testnodes.json
jq empty ./m1-testnodes.json
```

The inventory must contain at least two testnodes and two gates:

```json
{
  "testnodes": [
    {
      "key": "ams",
      "host": "testnode-eu-ams-01.hyperspace.zone",
      "publicIp": "84.32.190.156"
    },
    {
      "key": "fra",
      "host": "testnode-eu-fra-01.hyperspace.zone",
      "publicIp": "84.32.223.76"
    }
  ],
  "gates": [
    {
      "name": "gate-eu-fra-21",
      "publicIpv4": "84.32.59.174"
    },
    {
      "name": "gate-na-chi-21",
      "publicIpv4": "88.216.68.89"
    }
  ]
}
```

`host` is the SSH target for the testnode. `publicIp` is the public IPv4 address
used in probes and source/target restrictions. Gate `name` must match the gate
catalog seeded into the control-plane.

## Prepare Testnodes

Set the SSH key used to reach the testnodes:

```bash
export HS_TESTNODE_SSH_KEY="${HS_TESTNODE_SSH_KEY:-}"

if [ -z "$HS_TESTNODE_SSH_KEY" ]; then
  echo "set HS_TESTNODE_SSH_KEY to the private key used for testnode SSH" >&2
fi
```

Copy the testnode tools and install packages on every testnode listed in the
inventory:

```bash
jq -r '.testnodes[].host' ./m1-testnodes.json | while IFS= read -r host; do
  rsync -az -e "ssh -i $HS_TESTNODE_SSH_KEY -o IdentitiesOnly=yes" \
    scripts/testnodes/ "root@${host}:/opt/hyperspace-testnodes/"

  ssh -i "$HS_TESTNODE_SSH_KEY" -o IdentitiesOnly=yes "root@${host}" \
    'bash /opt/hyperspace-testnodes/prepare-testnode.sh'
done
```

Start the one-way probe server on every testnode:

```bash
jq -r '.testnodes[].host' ./m1-testnodes.json | while IFS= read -r host; do
  ssh -i "$HS_TESTNODE_SSH_KEY" -o IdentitiesOnly=yes "root@${host}" \
    'pkill -f one_way_probe.py || true; nohup /opt/hyperspace-testnodes/one_way_probe.py server --port 19191 >/var/log/hyperspace-one-way-probe.log 2>&1 &'
done
```

Wait for chrony to stabilize before running one-way measurements:

```bash
jq -r '.testnodes[].host' ./m1-testnodes.json | while IFS= read -r host; do
  ssh -i "$HS_TESTNODE_SSH_KEY" -o IdentitiesOnly=yes "root@${host}" \
    'chronyc waitsync 60 0.05 && chronyc tracking'
done
```

## Run Matrix

Configure the API and output directory:

```bash
export HS_WEB_HOST="${HS_WEB_HOST:-$(cat /etc/hyperspace/tls-cert-name 2>/dev/null || true)}"
export HS_API_BASE="${HS_API_BASE:-https://${HS_WEB_HOST}/api}"
export HS_TEST_OUTPUT_DIR="${HS_TEST_OUTPUT_DIR:-m1-results/live-cluster/matrix}"
```

For Hyperspace measurements, provide an access token for a verified operator
account. Alternatively, set both `HS_MATRIX_EMAIL` and `HS_MATRIX_PASSWORD` for
an existing verified password account. The matrix runner never creates an
account or bypasses email verification.

```bash
read -rsp "Hyperspace access token: " HS_MATRIX_TOKEN; echo
export HS_MATRIX_TOKEN
```

Run both public and Hyperspace measurements:

```bash
npm run measure:matrix -- \
  --mode all \
  --inventory ./m1-testnodes.json \
  --api-base "$HS_API_BASE" \
  --token "$HS_MATRIX_TOKEN" \
  --ssh-key "$HS_TESTNODE_SSH_KEY" \
  --output-dir "$HS_TEST_OUTPUT_DIR" \
  --active-timeout 120 \
  --revoke-timeout 120
```

Compare the results:

```bash
npm run measure:compare -- \
  --public "$HS_TEST_OUTPUT_DIR/public.json" \
  --hyperspace "$HS_TEST_OUTPUT_DIR/hyperspace.json" \
  --output "$HS_TEST_OUTPUT_DIR/comparison.md"
```

Expected result:

- `public.json`, `gate-ping.json`, `hyperspace.json`, and `comparison.md` are
  produced.
- Every directed pair reaches `active` before the Hyperspace probe.
- Packet loss is acceptable for both public and Hyperspace samples.
- `hyperspace.json` records the selected ingress/egress gate pair per directed
  measurement.
- Temporary sessions are revoked and deleted after each measurement.
