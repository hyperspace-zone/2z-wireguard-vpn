import assert from "node:assert/strict";
import test from "node:test";
import { evaluateGateReadiness, readGateDoubleZeroEnv } from "./readiness.js";
import { resolveGateHeartbeatConditions, resolveGateStaleConditions } from "./transitions.js";

const readyCapabilities = [
  "wireguard-tools:present",
  "iproute2:present",
  "nft:present",
  "doublezero0:up"
];

const readyDoubleZero = {
  tunnelStatus: "BGP Session Up",
  tunnelSrc: "203.0.113.10",
  network: "testnet"
};

test("gate is ready when host tools are present", () => {
  const readiness = evaluateGateReadiness({
    capabilities: readyCapabilities,
    doubleZero: readyDoubleZero,
    publicEndpoint: "203.0.113.10",
    doubleZeroEnv: "testnet",
    hostReady: true
  });
  assert.equal(readiness.ready, true);
  assert.equal(readiness.reason, "HostReady");
  assert.equal(readiness.doubleZeroReady, true);
});

test("gate is ready but not DoubleZero-ready when doublezero0 is not up", () => {
  const readiness = evaluateGateReadiness({
    capabilities: readyCapabilities.filter((capability) => capability !== "doublezero0:up"),
    doubleZero: readyDoubleZero,
    publicEndpoint: "203.0.113.10",
    doubleZeroEnv: "testnet",
    hostReady: true
  });
  assert.equal(readiness.ready, true);
  assert.equal(readiness.doubleZeroReady, false);
  assert.equal(readiness.doubleZeroReason, "DoubleZeroInterfaceDown");
});

test("gate is ready but not DoubleZero-ready when DoubleZero BGP session is down", () => {
  const readiness = evaluateGateReadiness({
    capabilities: readyCapabilities,
    doubleZero: { ...readyDoubleZero, tunnelStatus: "Connecting" },
    publicEndpoint: "203.0.113.10",
    doubleZeroEnv: "testnet",
    hostReady: true
  });
  assert.equal(readiness.ready, true);
  assert.equal(readiness.doubleZeroReady, false);
  assert.equal(readiness.doubleZeroReason, "DoubleZeroTunnelDown");
});

test("gate is ready but not DoubleZero-ready when DoubleZero environment mismatches catalog", () => {
  const readiness = evaluateGateReadiness({
    capabilities: readyCapabilities,
    doubleZero: { ...readyDoubleZero, network: "mainnet-beta" },
    publicEndpoint: "203.0.113.10",
    doubleZeroEnv: "testnet",
    hostReady: true
  });
  assert.equal(readiness.ready, true);
  assert.equal(readiness.doubleZeroReady, false);
  assert.equal(readiness.doubleZeroReason, "DoubleZeroEnvMismatch");
});

test("gate is ready but not DoubleZero-ready when tunnel source mismatches public endpoint", () => {
  const readiness = evaluateGateReadiness({
    capabilities: readyCapabilities,
    doubleZero: { ...readyDoubleZero, tunnelSrc: "203.0.113.11" },
    publicEndpoint: "203.0.113.10",
    doubleZeroEnv: "testnet",
    hostReady: true
  });
  assert.equal(readiness.ready, true);
  assert.equal(readiness.doubleZeroReady, false);
  assert.equal(readiness.doubleZeroReason, "DoubleZeroTunnelSourceMismatch");
});

test("gate catalog defaults DoubleZero environment to testnet", () => {
  assert.equal(readGateDoubleZeroEnv({}), "testnet");
  assert.equal(readGateDoubleZeroEnv({ doubleZeroEnv: "mainnet-beta" }), "mainnet-beta");
});

test("gate schedulability requires enabled desired state", () => {
  for (const desiredState of ["Draining", "Disabled", "Maintenance"] as const) {
    const conditions = resolveGateHeartbeatConditions({
      ready: true,
      reason: "HostReady",
      message: "Gate agent heartbeat is fresh and required host tools are present",
      doubleZeroReady: true,
      doubleZeroReason: "DoubleZeroReady",
      doubleZeroMessage: "DoubleZero tunnel is connected and matches the gate catalog",
      desiredState
    });
    const schedulable = conditions.find((condition) => condition.type === "Schedulable");
    assert.equal(schedulable?.status, "False");
    assert.equal(schedulable?.reason, `DesiredState${desiredState}`);
  }

  const enabled = resolveGateHeartbeatConditions({
    ready: true,
    reason: "HostReady",
    message: "Gate agent heartbeat is fresh and required host tools are present",
    doubleZeroReady: true,
    doubleZeroReason: "DoubleZeroReady",
    doubleZeroMessage: "DoubleZero tunnel is connected and matches the gate catalog",
    desiredState: "Enabled"
  }).find((condition) => condition.type === "Schedulable");
  assert.equal(enabled?.status, "True");
});

test("gate schedulability requires DoubleZero readiness", () => {
  const conditions = resolveGateHeartbeatConditions({
    ready: true,
    reason: "HostReady",
    message: "Gate agent heartbeat is fresh and required host tools are present",
    doubleZeroReady: false,
    doubleZeroReason: "DoubleZeroTunnelDown",
    doubleZeroMessage: "DoubleZero tunnel is disconnected",
    desiredState: "Enabled"
  });
  const ready = conditions.find((condition) => condition.type === "Ready");
  const schedulable = conditions.find((condition) => condition.type === "Schedulable");
  assert.equal(ready?.status, "True");
  assert.equal(schedulable?.status, "False");
  assert.equal(schedulable?.reason, "DoubleZeroTunnelDown");
});

test("stale gate conditions are resolved by gate lifecycle policy", () => {
  const conditions = resolveGateStaleConditions();
  assert.deepEqual(conditions.map((condition) => condition.type), [
    "AgentConnected",
    "Ready",
    "Schedulable"
  ]);
  assert.equal(conditions.every((condition) => condition.status === "False"), true);
  assert.equal(conditions.find((condition) => condition.type === "Schedulable")?.reason, "HeartbeatStale");
});
