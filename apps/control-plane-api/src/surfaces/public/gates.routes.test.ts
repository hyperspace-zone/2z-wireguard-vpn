import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Database } from "@hyperspace-zone/db";
import { registerPublicGatesRoutes } from "./gates.routes.js";

test("the public gate catalog exposes AWG readiness without excluding WG-only egresses", async () => {
  const base = {
    desiredState: "Enabled", publicIpv4: "192.0.2.1", ready: true, schedulable: true,
    agentConnected: true, doubleZeroLowestLatencyDeviceWarning: null
  };
  const db = { query: async () => ({ rows: [
    { ...base, id: "awg", name: "awg", observedCapabilities: ["client-tunnel:amneziawg-3.1"] },
    { ...base, id: "wg", name: "wg", observedCapabilities: ["doublezero0:up"] },
    { ...base, id: "unknown", name: "unknown", observedCapabilities: null },
    { ...base, id: "stale", name: "stale", ready: false, schedulable: false,
      agentConnected: false, observedCapabilities: ["client-tunnel:amneziawg-3.1"] }
  ] }) } as unknown as Database;
  const app = Fastify();
  registerPublicGatesRoutes(app, { db });
  try {
    const response = await app.inject("/v1/public/gates");
    assert.equal(response.statusCode, 200);
    const gates = response.json().gates;
    assert.deepEqual(gates.map((gate: { name: string; amneziaWGReady: boolean }) =>
      [gate.name, gate.amneziaWGReady]), [["awg", true], ["wg", false], ["unknown", false], ["stale", false]]);
    assert.equal(gates[1].schedulable, true, "WG-only gates remain selectable as egress");
    assert.doesNotMatch(response.body, /observedCapabilities|agentConnected/);
  } finally {
    await app.close();
  }
});
