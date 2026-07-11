import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDoubleZeroUsageRecords } from "./doublezero-metering-loop.js";

test("metering normalization preserves explicit zero usage and cost", () => {
  const records = normalizeDoubleZeroUsageRecords([{
    recordId: "usage-1",
    accountId: "account-1",
    windowStart: "2026-07-11T00:00:00.000Z",
    windowEnd: "2026-07-11T00:05:00.000Z",
    bytesIn: 0,
    bytesOut: 0,
    doubleZeroCostMinor: 0,
    currency: "USD"
  }]);

  assert.equal(records[0]?.doubleZeroCostMinor, 0);
  assert.equal(records[0]?.bytesIn, 0);
});

test("metering normalization marks missing numeric fields invalid instead of treating them as free", () => {
  const records = normalizeDoubleZeroUsageRecords([{
    recordId: "usage-2",
    windowStart: "2026-07-11T00:00:00.000Z",
    windowEnd: "2026-07-11T00:05:00.000Z"
  }]);

  assert.equal(records[0]?.bytesIn, -1);
  assert.equal(records[0]?.bytesOut, -1);
  assert.equal(records[0]?.doubleZeroCostMinor, -1);
});
