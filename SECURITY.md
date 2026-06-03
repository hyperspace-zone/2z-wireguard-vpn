# Security Policy

## Reporting Vulnerabilities

Report security issues privately to the Hyperspace Zone maintainers. Do not
open public issues for vulnerabilities involving credentials, private keys,
session artifacts, control-plane authorization, or gate host access.

## Secret Handling

- Do not commit private keys, WireGuard client configs, gate tokens, database
  credentials, payment secrets, or raw encrypted payload keys.
- Logs and audit events must use identifiers, fingerprints, and references
  instead of secret material.
- Gate private keys stay on gate hosts.
- Client private keys are accepted only when explicitly generated as encrypted
  artifacts with controlled issuance.

## Supported Branches

Security fixes are accepted on `main` and on active milestone release branches.
