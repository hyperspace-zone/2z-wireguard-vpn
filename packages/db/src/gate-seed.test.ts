import assert from "node:assert/strict";
import test from "node:test";
import { inferRegionFromCountryCode, normalizeGateSeeds, type GateSeed } from "./gate-seed.js";

const fraGate: GateSeed = {
  name: "gate-eu-fra-01",
  identity: "7pFRA2uV4q2Jr7mN8pQ9sT3wX5yZ7aB9cD2eF4gH6",
  city: "Frankfurt",
  country: "Germany",
  countryCode: "de",
  publicEndpoint: "203.0.113.10",
  probeUrl: "https://gate-eu-fra-01.example.net/.well-known/hyperspace-probe",
  doubleZeroEnv: "mainnet-beta"
};

const chiGate: GateSeed = {
  name: "gate-na-chi-01",
  identity: "8qCH3vT5wX7yZ9aB2cD4eF6gH8jK9mN2pQ4rS6tU8V",
  city: "Chicago",
  country: "United States",
  countryCode: "US",
  publicEndpoint: "203.0.113.20",
  probeUrl: "https://203.0.113.20/.well-known/hyperspace-probe",
  doubleZeroEnv: "mainnet-beta"
};

test("gate seed derives coarse region from country code", () => {
  const seeds = normalizeGateSeeds([fraGate, chiGate]);
  assert.equal(seeds.length, 2);
  const seed = seeds[0];
  assert.ok(seed);

  assert.equal(seed.region, "eu");
  assert.equal(seed.countryCode, "DE");
  assert.equal(seed.doubleZeroEnv, "mainnet-beta");
});

test("gate seed allows an explicit region override", () => {
  const seeds = normalizeGateSeeds([
    {
      ...fraGate,
      name: "gate-custom-01",
      identity: "9YGHJEuxtnhhnCinsWB8bCTF5CY2fUXMjU4jmbUDEu5y",
      region: "lab",
      countryCode: "ZZ",
      publicEndpoint: "203.0.113.11",
      probeUrl: "https://gate-custom-01.example.net/.well-known/hyperspace-probe",
      doubleZeroEnv: undefined
    },
    chiGate
  ]);
  assert.equal(seeds.length, 2);
  const seed = seeds[0];
  assert.ok(seed);

  assert.equal(seed.region, "lab");
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

test("gate seed rejects duplicate public endpoints", () => {
  assert.throws(
    () => normalizeGateSeeds([fraGate, { ...chiGate, publicEndpoint: fraGate.publicEndpoint }]),
    /duplicate gate publicEndpoint/
  );
});

test("gate seed rejects duplicate probe urls", () => {
  assert.throws(
    () => normalizeGateSeeds([fraGate, { ...chiGate, probeUrl: fraGate.probeUrl }]),
    /duplicate gate probeUrl/
  );
});

test("gate seed requires HTTPS probe urls", () => {
  assert.throws(
    () => normalizeGateSeeds([fraGate, { ...chiGate, probeUrl: "http://gate-na-chi-01.example.net/.well-known/hyperspace-probe" }]),
    /probeUrl must use https/
  );
});

test("gate seed region inference uses two-letter coarse groups", () => {
  assert.equal(inferRegionFromCountryCode("US"), "na");
  assert.equal(inferRegionFromCountryCode("SG"), "ap");
  assert.equal(inferRegionFromCountryCode("BR"), "sa");
  assert.equal(inferRegionFromCountryCode("ZA"), "af");
  assert.equal(inferRegionFromCountryCode("ZZ"), "xx");
});
