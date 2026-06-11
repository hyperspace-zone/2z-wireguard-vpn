# API Automation

Use this runbook when automation needs to download a WireGuard client config
without using the web UI.

Prerequisites:

- The deployment is complete and the public API is reachable over HTTPS.
- The automation has a valid public API access token.
- The automation knows the session ID for the VPN config to download.
- `curl` and `jq` are installed on the runner host.

Configure the API base, access token, and session ID:

```bash
export HS_WEB_HOST="${HS_WEB_HOST:-$(cat /etc/hyperspace/tls-cert-name 2>/dev/null || true)}"
export HS_API_HOST="${HS_API_HOST:-$HS_WEB_HOST}"
export HS_PUBLIC_API_BASE="${HS_PUBLIC_API_BASE:-https://${HS_WEB_HOST}/api}"
# If calling the API host directly, use:
# export HS_PUBLIC_API_BASE="https://${HS_API_HOST}"

export HS_ACCESS_TOKEN="${HS_ACCESS_TOKEN:-}"
export SESSION_ID="${SESSION_ID:-}"

if [ -z "$HS_PUBLIC_API_BASE" ] || [ -z "$HS_ACCESS_TOKEN" ] || [ -z "$SESSION_ID" ]; then
  echo "set HS_PUBLIC_API_BASE, HS_ACCESS_TOKEN, and SESSION_ID before downloading a config" >&2
fi
```

Request a client-config download token:

```bash
token_response="$(
  curl -fsS -X POST \
    -H "authorization: Bearer $HS_ACCESS_TOKEN" \
    "$HS_PUBLIC_API_BASE/v1/public/sessions/$SESSION_ID/artifacts/client-config/download-token"
)"
```

Fetch the raw WireGuard config with `downloadConfigUrl`:

```bash
curl -fsSL \
  "$HS_PUBLIC_API_BASE$(jq -r '.downloadConfigUrl' <<<"$token_response")" \
  > hyperspace.conf
```

The resulting `hyperspace.conf` should be raw WireGuard config text with
`[Interface]` and `[Peer]` sections.

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

