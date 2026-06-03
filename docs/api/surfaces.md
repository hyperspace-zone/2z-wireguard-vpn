# API Surfaces

All API contracts are versioned under `/v1`.

## `/v1/public/*`

Human and web flows:

- create session
- list own sessions
- read session status
- revoke session
- request artifact download token

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
