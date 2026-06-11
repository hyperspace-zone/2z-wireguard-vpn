# Gate Location Planning

Gate placement is the main performance decision in a DoubleZero WireGuard VPN
deployment. A gate is useful when it is close to a DoubleZero point of presence
and close to the traffic it serves.

## Routing Model

Every VPN config uses:

```text
WireGuard client
  -> ingress Hyperspace gate
  -> DoubleZero transit
  -> egress Hyperspace gate
  -> destination or internet
```

The current platform requires ingress and egress to be distinct gates. Plan at
least two gates before deploying.

## What To Optimize

For IP-to-target routes:

- Ingress should be near the users or systems that initiate WireGuard.
- Egress should be near the target service or network.

For full-tunnel routes:

- Ingress should be near the users.
- Egress should be near the desired internet exit region.

The best public-cloud region is not always the best gate region. Prefer a VPS
or bare-metal region that is close, in network terms, to the selected
DoubleZero device or metro.

## Measuring The Nearest DoubleZero PoP

From a representative source network:

```bash
doublezero config set --env testnet        # or mainnet-beta
doublezero latency
```

The DoubleZero troubleshooting guide documents `doublezero latency` and shows
that it reports DoubleZero device code, IP, min/max/avg latency, and
reachability:

https://docs.malbeclabs.com/troubleshooting/

Record:

- DoubleZero environment: `testnet` or `mainnet-beta`.
- Nearest reachable device code.
- Device public IP.
- Average and minimum latency.
- Metro/location if visible in `doublezero status` or `doublezero device list`.

Repeat the measurement from representative destination or exit-side locations.

## Choosing VPS Regions

For each planned gate:

1. Pick the DoubleZero device/metro with the lowest reliable latency from the
   relevant side of the route.
2. Find VPS or bare-metal providers with regions in the same metro or nearby
   carrier hotels.
3. Start with a small temporary instance in each candidate provider/region.
4. Install DoubleZero tooling and run `doublezero latency`.
5. Keep the instance with the lowest stable latency to the intended DoubleZero
   device and acceptable public-internet performance.
6. Record the final public IP and DoubleZero identity. The identity is the
   `user_payer` value printed by `doublezero address` and must match the
   `access-pass` issued for the gate.

Good signs:

- Single-digit or low double-digit milliseconds to the intended DoubleZero PoP.
- Low jitter over repeated runs.
- Stable route over several measurement windows.
- Public IPv4 address that will not change after reboot.

Bad signs:

- The closest DoubleZero device is in a different continent.
- Provider routing changes frequently.
- The VPS region is geographically close but has poor network path to the
  DoubleZero PoP.
- The provider cannot guarantee a stable public IPv4 address.

## Requesting `access-pass` Records

Once the gate servers are final, request DoubleZero `access-pass` records for
each gate. An `access-pass` is the DoubleZero permission record used by
`doublezero access-pass`; see the DoubleZero state model and CLI
implementation:

https://github.com/malbeclabs/doublezero/blob/main/smartcontract/programs/doublezero-serviceability/src/state/accesspass.rs

https://github.com/malbeclabs/doublezero/blob/main/smartcontract/cli/src/accesspass/set.rs

For each gate, prepare:

- DoubleZero environment: `testnet` or `mainnet-beta`.
- Gate public IPv4 address.
- Output of `doublezero address` from that gate.
- Intended placement/use case. Deployed gates are universal; ingress and egress
  are per-session path roles, not fixed host roles.
- Intended city/metro and provider.
- Short description of the WireGuard VPN use case.

Access is permissioned. Use the official DoubleZero contact path linked from
the New Tenant page:

https://docs.malbeclabs.com/New%20Tenant/

Direct contact form:

https://docs.google.com/forms/d/e/1FAIpQLSdp11kHtmcaKaLfYRZA92ylOvucipY86CdjVKdiggNdjlZniw/viewform

After `access-pass` records are issued, verify on each gate:

```bash
doublezero address
doublezero access-pass list | grep "$(doublezero address)"
doublezero connect ibrl
doublezero status
ip link show doublezero0
```

The `access-pass` row must match the gate public IP and the `doublezero address`
identity.

## Minimum Topology Examples

Small regional deployment:

```text
client region A -> ingress gate near DoubleZero PoP A
DoubleZero transit
egress gate near DoubleZero PoP B -> target region B
```

Public internet exit deployment:

```text
clients in one metro -> nearby ingress gate
DoubleZero transit
egress gate in desired internet exit metro -> internet
```

Multi-region deployment:

```text
several ingress gates near user clusters
several egress gates near target or exit regions
control plane schedules only ready gates with matching route policy
```
