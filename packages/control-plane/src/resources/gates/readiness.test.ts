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

test("gate is ready only when host tools and DoubleZero tunnel match catalog", () => {
  assert.equal(evaluateGateReadiness({
    capabilities: readyCapabilities,
    doubleZero: readyDoubleZero,
    publicEndpoint: "203.0.113.10",
    doubleZeroEnv: "testnet",
    hostReady: true
  }).ready, true);
});

test("gate is not ready when doublezero0 is not up", () => {
  const readiness = evaluateGateReadiness({
    capabilities: readyCapabilities.filter((capability) => capability !== "doublezero0:up"),
    doubleZero: readyDoubleZero,
    publicEndpoint: "203.0.113.10",
    doubleZeroEnv: "testnet",
    hostReady: true
  });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.reason, "DoubleZeroInterfaceDown");
});

test("gate is not ready when DoubleZero BGP session is down", () => {
  const readiness = evaluateGateReadiness({
    capabilities: readyCapabilities,
    doubleZero: { ...readyDoubleZero, tunnelStatus: "Connecting" },
    publicEndpoint: "203.0.113.10",
    doubleZeroEnv: "testnet",
    hostReady: true
  });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.reason, "DoubleZeroTunnelDown");
});

test("gate is not ready when DoubleZero environment mismatches catalog", () => {
  const readiness = evaluateGateReadiness({
    capabilities: readyCapabilities,
    doubleZero: { ...readyDoubleZero, network: "mainnet-beta" },
    publicEndpoint: "203.0.113.10",
    doubleZeroEnv: "testnet",
    hostReady: true
  });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.reason, "DoubleZeroEnvMismatch");
});

test("gate is not ready when tunnel source mismatches public endpoint", () => {
  const readiness = evaluateGateReadiness({
    capabilities: readyCapabilities,
    doubleZero: { ...readyDoubleZero, tunnelSrc: "203.0.113.11" },
    publicEndpoint: "203.0.113.10",
    doubleZeroEnv: "testnet",
    hostReady: true
  });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.reason, "DoubleZeroTunnelSourceMismatch");
});

test("gate catalog defaults DoubleZero environment to testnet", () => {
  assert.equal(readGateDoubleZeroEnv({}), "testnet");
  assert.equal(readGateDoubleZeroEnv({ doubleZeroEnv: "mainnet-beta" }), "mainnet-beta");
});

test("gate schedulability requires enabled desired state", () => {
  for (const desiredState of ["Draining", "Disabled", "Maintenance"] as const) {
    const conditions = resolveGateHeartbeatConditions({
      ready: true,
      reason: "DoubleZeroReady",
      message: "Gate host tools and DoubleZero tunnel are ready",
      desiredState
    });
    const schedulable = conditions.find((condition) => condition.type === "Schedulable");
    assert.equal(schedulable?.status, "False");
    assert.equal(schedulable?.reason, `DesiredState${desiredState}`);
  }

  const enabled = resolveGateHeartbeatConditions({
    ready: true,
    reason: "DoubleZeroReady",
    message: "Gate host tools and DoubleZero tunnel are ready",
    desiredState: "Enabled"
  }).find((condition) => condition.type === "Schedulable");
  assert.equal(enabled?.status, "True");
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
