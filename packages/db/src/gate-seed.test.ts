import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGateSeeds, type GateSeed } from "./gate-seed.js";

const fraGate: GateSeed = {
  name: "gate-eu-fra-01",
  identity: "7pFRA2uV4q2Jr7mN8pQ9sT3wX5yZ7aB9cD2eF4gH6",
  city: "Frankfurt",
  country: "Germany",
  publicIpv4: "203.0.113.10",
  probeUrl: "https://gate-eu-fra-01.testnet.hyperspace.zone/.well-known/hyperspace-probe",
  doubleZeroEnv: "mainnet-beta"
};

const chiGate: GateSeed = {
  name: "gate-na-chi-01",
  identity: "8qCH3vT5wX7yZ9aB2cD4eF6gH8jK9mN2pQ4rS6tU8V",
  city: "Chicago",
  country: "United States",
  publicIpv4: "203.0.113.20",
  probeUrl: "https://203.0.113.20/.well-known/hyperspace-probe",
  doubleZeroEnv: "mainnet-beta"
};

test("gate seed keeps human city and country fields", () => {
  const seeds = normalizeGateSeeds([fraGate, chiGate]);
  assert.equal(seeds.length, 2);
  const seed = seeds[0];
  assert.ok(seed);

  assert.equal(seed.city, "Frankfurt");
  assert.equal(seed.country, "Germany");
  assert.equal(seed.doubleZeroEnv, "mainnet-beta");
  assert.equal(seed.desiredState, "Enabled");
  assert.equal(seed.probeHost, "gate-eu-fra-01.testnet.hyperspace.zone");
});

test("gate seed defaults DoubleZero environment to testnet", () => {
  const seeds = normalizeGateSeeds([
    {
      ...fraGate,
      name: "gate-custom-01",
      identity: "9YGHJEuxtnhhnCinsWB8bCTF5CY2fUXMjU4jmbUDEu5y",
      publicIpv4: "203.0.113.11",
      probeUrl: "https://gate-custom-01.testnet.hyperspace.zone/.well-known/hyperspace-probe",
      doubleZeroEnv: undefined
    },
    chiGate
  ]);
  assert.equal(seeds.length, 2);
  const seed = seeds[0];
  assert.ok(seed);

  assert.equal(seed.doubleZeroEnv, "testnet");
});

test("gate seed rejects fewer than two gates", () => {
  assert.throws(
    () => normalizeGateSeeds([fraGate]),
    /at least two gates/
  );
});

test("gate seed rejects duplicate names", () => {
  assert.throws(
    () => normalizeGateSeeds([fraGate, { ...chiGate, name: fraGate.name }]),
    /duplicate gate name/
  );
});

test("gate seed rejects duplicate DoubleZero identities", () => {
  assert.throws(
    () => normalizeGateSeeds([fraGate, { ...chiGate, identity: fraGate.identity }]),
    /duplicate gate identity/
  );
});

test("gate seed rejects duplicate public IPv4 endpoints", () => {
  assert.throws(
    () => normalizeGateSeeds([fraGate, { ...chiGate, publicIpv4: fraGate.publicIpv4 }]),
    /duplicate gate publicIpv4/
  );
});

test("gate seed rejects duplicate probe urls", () => {
  assert.throws(
    () => normalizeGateSeeds([fraGate, { ...chiGate, probeUrl: fraGate.probeUrl }]),
    /duplicate gate probeUrl/
  );
});

test("gate seed rejects duplicate probe hosts", () => {
  assert.throws(
    () => normalizeGateSeeds([fraGate, { ...chiGate, probeUrl: "https://gate-eu-fra-01.testnet.hyperspace.zone/alternate-probe" }]),
    /duplicate gate probe host gate-eu-fra-01\.testnet\.hyperspace\.zone/
  );
});

test("gate seed accepts explicit desired state", () => {
  const seeds = normalizeGateSeeds([
    { ...fraGate, desiredState: "Disabled" },
    chiGate
  ]);
  assert.equal(seeds[0]?.desiredState, "Disabled");
});

test("gate seed rejects invalid desired state", () => {
  assert.throws(
    () => normalizeGateSeeds([fraGate, { ...chiGate, desiredState: "Offline" as never }]),
    /desiredState must be Enabled, Draining, Disabled, or Maintenance/
  );
});

test("gate seed requires publicIpv4 to be IPv4", () => {
  assert.throws(
    () => normalizeGateSeeds([fraGate, { ...chiGate, publicIpv4: "gate-na-chi-01.testnet.hyperspace.zone" }]),
    /publicIpv4 must be a public IPv4 address/
  );
});

test("gate seed requires HTTPS probe urls", () => {
  assert.throws(
    () => normalizeGateSeeds([fraGate, { ...chiGate, probeUrl: "http://gate-na-chi-01.testnet.hyperspace.zone/.well-known/hyperspace-probe" }]),
    /probeUrl must use https/
  );
});
