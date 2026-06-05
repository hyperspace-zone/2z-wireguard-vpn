# Contributing

This repository is organized around the target control-plane architecture. New
work should keep resource intent, observed status, host reality, and audit as
separate concerns.

## Local Checks

```bash
npm install
npm run build
npm test
cd apps/gate-agent && go test ./...
```

## Pull Requests

Pull requests should include:

- concise problem and solution summary
- local validation evidence
- migration notes for database changes
- runbook updates for operational changes
- screenshots or request/response examples for UI and API changes

Unless explicitly stated otherwise, contributions submitted to this repository
are licensed under the Apache License, Version 2.0 (`Apache-2.0`).

## Coding Standards

- TypeScript: explicit domain types and small modules.
- Go: small packages, explicit errors, no shell string assembly for untrusted
  input.
- SQL: migrations are reviewed as part of the public API of the control plane.
- Runtime: prefer native packages and systemd services over containers.
