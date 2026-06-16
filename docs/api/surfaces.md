# API Surfaces

All API contracts are versioned under `/v1`.

The control-plane API applies basic in-process abuse controls to high-risk
mutation and authentication surfaces. Limited requests receive `429` with
`Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and
`X-RateLimit-Reset` headers. Operators can tune or disable these controls with
the `ABUSE_*` environment variables in the control-plane API service
environment.

## `/v1/public/*`

Human and web flows:

- create session
- list own sessions
- read session status
- revoke session
- request artifact download token

Client-config artifacts support two download forms:

- `GET /v1/public/artifacts/download/:token` returns the JSON artifact
  envelope, including metadata and `payload.configText`.
- `GET /v1/public/artifacts/download/:token?format=conf` or
  `Accept: text/plain` returns the raw WireGuard `.conf` body with
  `Content-Type: text/plain; charset=utf-8` and an attachment filename.

## `/v1/agent/*`

Agent and pay.sh flows:

- list available gates
- create prepaid session
- read session metadata
- apply top-up
- revoke session

## `/v1/admin/*`

Operator flows:

- manage gates
- inspect sessions, assignments, jobs, artifacts, and audit
- view drift and failed cleanup
- force reconcile
- drain, enable, disable, and maintain gates
- apply operator overrides

## `/v1/gate/*`

Gate-agent flows:

- heartbeat
- renew lease
- claim jobs
- report job result
- report actual host state

Gate endpoints are authenticated as gate service principals and are always
initiated by outbound agent requests.
