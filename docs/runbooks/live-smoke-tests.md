# Live Smoke Tests

Use these checks after the deployment guide has completed, the web/API endpoint
is reachable over HTTPS, the gate catalog is seeded, and at least two gates are
reporting `ready=true` and `schedulable=true`.

## Automated UI/API Smoke

Run this from an operator workstation, CI runner, or the control-plane host. The
script uses `playwright-core`, so the host running the smoke needs a local
Chromium/Chrome executable.

On Ubuntu, install Chrome if no browser is already available:

```bash
if ! command -v google-chrome >/dev/null && ! command -v chromium >/dev/null && ! command -v chromium-browser >/dev/null; then
  curl -fsSL -o /tmp/google-chrome-stable_current_amd64.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt-get update
  apt-get install -y /tmp/google-chrome-stable_current_amd64.deb
fi
```

```bash
export HS_REPO_DIR="${HS_REPO_DIR:-/opt/2z-wireguard-vpn}"
export HS_WEB_HOST="${HS_WEB_HOST:-$(cat /etc/hyperspace/tls-cert-name 2>/dev/null || true)}"
export HS_API_HOST="${HS_API_HOST:-$HS_WEB_HOST}"

cd "$HS_REPO_DIR"

export HS_WEB_BASE="https://${HS_WEB_HOST}"
export HS_API_BASE="https://${HS_WEB_HOST}/api"
# If calling a split API host directly from automation, use:
# export HS_API_BASE="https://${HS_API_HOST}"

mapfile -t HS_TEST_GATES < <(
  curl -fsS "${HS_API_BASE}/v1/public/gates" \
    | jq -r '.gates[]? | select(.ready == true and .schedulable == true) | .name'
)
export HS_TEST_TARGET_IP=1.1.1.1
export HS_TEST_OUTPUT_DIR=m1-results/live-cluster
export HS_HEADLESS=true

for browser in google-chrome chromium chromium-browser /snap/bin/chromium; do
  if PLAYWRIGHT_CHROMIUM_EXECUTABLE="$(command -v "$browser" 2>/dev/null)" && [ -x "$PLAYWRIGHT_CHROMIUM_EXECUTABLE" ]; then
    export PLAYWRIGHT_CHROMIUM_EXECUTABLE
    break
  fi
done

if [ "${#HS_TEST_GATES[@]}" -lt 2 ]; then
  echo "expected at least two ready/schedulable gates" >&2
elif [ -z "${PLAYWRIGHT_CHROMIUM_EXECUTABLE:-}" ]; then
  echo "install Chromium or Chrome, then rerun this block" >&2
else
  export HS_TEST_INGRESS="${HS_TEST_GATES[0]}"
  export HS_TEST_EGRESS="${HS_TEST_GATES[1]}"
  echo "route: ${HS_TEST_INGRESS} -> ${HS_TEST_EGRESS}"
  echo "browser: ${PLAYWRIGHT_CHROMIUM_EXECUTABLE}"
  npm run test:live:ui
fi
```

Expected result:

- `status: "passed"` in `live-ui-smoke-*.json`.
- No browser console errors.
- Registration, login, create-config Step 1/Step 2, provisioning to `active`,
  raw `.conf` download contract, UI download, revoke, and delete all succeed.
- The script does not persist raw WireGuard `.conf` files in the output
  directory.

## Optional Automated WireGuard Policy Smoke

Skip this in a minimal deployment until you have dedicated validation clients.
Run it only after preparing validation clients with `wireguard-tools`,
`wg-quick`, SSH access, and the one-way probe from `scripts/testnodes`. Run it
from the control-plane host, an operator workstation, or CI runner that has the
repository checkout, Node dependencies, HTTPS access to the API, and SSH access
to the validation clients. Do not run this on gate hosts.

```bash
export HS_REPO_DIR="${HS_REPO_DIR:-/opt/2z-wireguard-vpn}"
export HS_WEB_HOST="${HS_WEB_HOST:-$(cat /etc/hyperspace/tls-cert-name 2>/dev/null || true)}"

cd "$HS_REPO_DIR"

export HS_API_BASE="https://${HS_WEB_HOST}/api"
export HS_TEST_OUTPUT_DIR=m1-results/live-cluster
export HS_TESTNODE_SSH_KEY="${HS_TESTNODE_SSH_KEY:-}"

mapfile -t HS_TEST_GATES < <(
  curl -fsS "${HS_API_BASE}/v1/public/gates" \
    | jq -r '.gates[]? | select(.ready == true and .schedulable == true) | .name'
)
export HS_TEST_INGRESS="${HS_TEST_INGRESS:-${HS_TEST_GATES[0]:-}}"
export HS_TEST_EGRESS="${HS_TEST_EGRESS:-${HS_TEST_GATES[1]:-}}"

export HS_ALLOWED_SOURCE_HOST="${HS_ALLOWED_SOURCE_HOST:-}"
export HS_ALLOWED_SOURCE_IP="${HS_ALLOWED_SOURCE_IP:-}"
export HS_DENIED_SOURCE_HOST="${HS_DENIED_SOURCE_HOST:-}"
export HS_DENIED_SOURCE_IP="${HS_DENIED_SOURCE_IP:-}"
export HS_TARGET_HOST="${HS_TARGET_HOST:-}"
export HS_TARGET_IP="${HS_TARGET_IP:-}"
export HS_NON_TARGET_HOST="${HS_NON_TARGET_HOST:-}"
export HS_NON_TARGET_IP="${HS_NON_TARGET_IP:-}"

missing=0
for name in \
  HS_TESTNODE_SSH_KEY \
  HS_TEST_INGRESS \
  HS_TEST_EGRESS \
  HS_ALLOWED_SOURCE_HOST \
  HS_ALLOWED_SOURCE_IP \
  HS_DENIED_SOURCE_HOST \
  HS_DENIED_SOURCE_IP \
  HS_TARGET_HOST \
  HS_TARGET_IP \
  HS_NON_TARGET_HOST \
  HS_NON_TARGET_IP; do
  if [ -z "${!name}" ]; then
    echo "set $name before running policy smoke" >&2
    missing=1
  fi
done

if [ "$missing" -eq 0 ]; then
  npm run test:live:policy
fi
```

Expected result:

- Target-restricted config works from the allowed source to the selected target.
- The same config cannot reach a non-target IP even if the client-side
  `AllowedIPs` line is widened.
- The same config cannot be used from a different public source IP.
- A user-provided WireGuard public key works only with its matching private key.
- Temporary sessions are revoked and deleted in cleanup.

