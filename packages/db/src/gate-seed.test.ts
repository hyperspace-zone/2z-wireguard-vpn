import assert from "node:assert/strict";
import test from "node:test";
import { inferRegionFromCountryCode, normalizeGateSeeds } from "./gate-seed.js";

test("gate seed derives coarse region from country code", () => {
  const seeds = normalizeGateSeeds([
    {
      name: "gate-eu-fra-01",
      identity: "7pFRA2uV4q2Jr7mN8pQ9sT3wX5yZ7aB9cD2eF4gH6",
      city: "Frankfurt",
      country: "Germany",
      countryCode: "de",
      publicEndpoint: "203.0.113.10",
      doubleZeroEnv: "mainnet-beta"
    }
  ]);
  assert.equal(seeds.length, 1);
  const seed = seeds[0];
  assert.ok(seed);

  assert.equal(seed.region, "eu");
  assert.equal(seed.countryCode, "DE");
  assert.equal(seed.doubleZeroEnv, "mainnet-beta");
});

test("gate seed allows an explicit region override", () => {
  const seeds = normalizeGateSeeds([
    {
      name: "gate-custom-01",
      identity: "9YGHJEuxtnhhnCinsWB8bCTF5CY2fUXMjU4jmbUDEu5y",
      region: "lab",
      city: "Lab City",
      country: "Example Country",
      countryCode: "ZZ",
      publicEndpoint: "203.0.113.11"
    }
  ]);
  assert.equal(seeds.length, 1);
  const seed = seeds[0];
  assert.ok(seed);

  assert.equal(seed.region, "lab");
  assert.equal(seed.doubleZeroEnv, "testnet");
});

test("gate seed rejects duplicate DoubleZero identities", () => {
  assert.throws(
    () => normalizeGateSeeds([
      {
        name: "gate-eu-fra-01",
        identity: "7pFRA2uV4q2Jr7mN8pQ9sT3wX5yZ7aB9cD2eF4gH6",
        city: "Frankfurt",
        country: "Germany",
        countryCode: "DE",
        publicEndpoint: "203.0.113.10"
      },
      {
        name: "gate-na-chi-01",
        identity: "7pFRA2uV4q2Jr7mN8pQ9sT3wX5yZ7aB9cD2eF4gH6",
        city: "Chicago",
        country: "United States",
        countryCode: "US",
        publicEndpoint: "203.0.113.20"
      }
    ]),
    /duplicate gate identity/
  );
});

test("gate seed region inference uses two-letter coarse groups", () => {
  assert.equal(inferRegionFromCountryCode("US"), "na");
  assert.equal(inferRegionFromCountryCode("SG"), "ap");
  assert.equal(inferRegionFromCountryCode("BR"), "sa");
  assert.equal(inferRegionFromCountryCode("ZA"), "af");
  assert.equal(inferRegionFromCountryCode("ZZ"), "xx");
});
