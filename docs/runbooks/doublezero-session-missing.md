# Missing DoubleZero session: operator response

`HyperspaceGateDoubleZeroSessionMissing` is a **critical** alert for an enabled
gate whose agent heartbeat is fresh, whose DoubleZero readiness is false, and
whose recovery state requires manual intervention because there is no current
device (`N/A`, `unknown`, or empty). It fires after five continuous minutes.
The Telegram template includes the gate hostname and public IPv4 from the
existing `probe_host` and `public_ipv4` labels.

This condition means the gate cannot be scheduled for new VPN configurations.
It is distinct from a drained device or failed BGP session with a known device.
The more general `HyperspaceEnabledGateDoubleZeroNotReady` alert excludes this
condition, so the same incident does not produce two DoubleZero alerts.
Disabled/maintenance gates, stale agents, and brief provisioning transitions do
not trigger the new alert.

## Diagnose and restore

1. SSH to the hostname/IP in the alert and run `doublezero status`. Verify the
   configured network and identity using `doublezero address`.
2. Inspect the access-pass for that identity and IP, and list users on the
   appropriate DZ Ledger. A valid pass and a missing user are different states;
   the access-pass can remain valid after a connection is removed.
3. Inspect relevant DZ Ledger transactions. `DeleteUser` removes the connection
   account; the local reconciler then removes the tunnel and routes. A foundation
   operator can initiate this without an SSH command on the gate. A missing
   device alone does **not** prove an administrative deletion, identify its
   signer, or establish the reason for deletion.
4. When reconnection is authorized and the pass is valid, run
   `doublezero --env mainnet-beta connect ibrl` (use the correct network for a
   different environment). Preserve the existing tenant selection. With no
   active user, a preliminary `disconnect` is unnecessary.
5. Verify `BGP Session Up`, `doublezero0`, learned routes and a controlled packet
   test through the DoubleZero route. Confirm `Ready=true` and
   `Schedulable=true` in the control-plane public gate catalog.
6. If an administrator removed the user, or it is removed again, contact
   DoubleZero with the gate IP, identity, transaction signatures and UTC times.
   Do not run an unattended reconnect loop against an administrative removal.

The gate-agent intentionally does not auto-reconnect this missing-session
condition. Its existing guarded recovery for drained devices and persistent
BGP session failure is unchanged.

## Confirmed incident: 2026-09-23

Three connections were successfully removed by `DeleteUser` transactions signed
by `DZ44dbatT5wgb1ijXZ54XBkRpfxWRLi7H5uNHM3tBTvE`. Its Permission account
`4Acw2H1dFSDQT8UBj8ExeSUj9GL2kYWcBA5GrRoPAiDh` was observed active with the
`foundation` role during investigation on 2026-10-05. The transaction history
does not reveal whether a person or automation initiated deletion or why.

| Gate | IP | DeleteUser time (UTC) | Transaction |
| --- | --- | --- | --- |
| `gate-eu-osl-01` | `91.190.155.145` | 2026-09-23 13:55:55 | `2JXPvAgrXVvWXXQMSKFJAuzE6n9Tpacr3URU3hdvG7GjAcniYHgQuWNyVaB3E8ejnw2RV7tsjcwVLbCiQ2CYqCwp` |
| `gate-ap-sin-21` | `5.199.166.24` | 2026-09-23 14:02:05 | `4WPwn3SrEXGJBRYBGJR4zckUZXeYrdMAsmicFYjdPZyL4KrMrSi1kJA4LbANCzwnMzZWoRuk9itXS3tnYfesB3uZ` |
| `gate-na-sea-81` | `45.77.214.182` | 2026-09-23 14:05:31 | `2Nur9joCmeXrPV24iGbysdxsP72gErDpA2YvGfEHtExzY66Hdp8s4eL4syWVuku9w1TkHSQ3tU58BXnRhQYrs9Xa` |

All three were reconnected with operator authorization on 2026-10-05. BGP,
routes, controlled inter-gate pings and control-plane schedulability passed.
