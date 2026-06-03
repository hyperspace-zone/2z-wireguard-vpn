# Secrets

The control plane treats VPN configs, gate credentials, database credentials,
payment credentials, and private keys as secrets.

## Rules

- Do not commit secret material.
- Do not log private keys, raw WireGuard configs, bearer tokens, gate tokens, or
  decrypted artifact payloads.
- Store only fingerprints, identifiers, and encrypted payload references in
  audit and operational records.
- Gate private keys remain on gate hosts.
- Artifact download tokens are short lived and attributable.

## Environment Files

Systemd environment files live under `/etc/hyperspace` on target hosts and must
be readable only by the service user or root.
