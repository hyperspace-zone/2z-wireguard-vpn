import assert from "node:assert/strict";
import test from "node:test";
import {
  applyBucketCredit,
  availableBillingBalance,
  calculateRetailChargeMicrominor,
  consumeBillingCharge
} from "./prepaid-billing.scenario.js";

test("retail rating charges active time and accepted egress payload without double counting", () => {
  const charge = calculateRetailChargeMicrominor({
    activeSeconds: 30 * 24 * 60 * 60,
    activeConfigMonthlyMinor: 1_000,
    bytesToDestination: 600_000_000n,
    bytesFromDestination: 400_000_000n,
    trafficPerGbMinor: 25
  });

  assert.equal(charge, 1_025_000_000n);
});

test("usage consumes promotional credits before withdrawable cash and then records debt", () => {
  const result = consumeBillingCharge({
    cashMinor: 500,
    promotionalMinor: 200,
    reservedWithdrawalMinor: 100,
    debtMinor: 0
  }, 750);

  assert.deepEqual(result, {
    cashMinor: 100,
    promotionalMinor: 0,
    reservedWithdrawalMinor: 100,
    debtMinor: 150
  });
  assert.equal(availableBillingBalance(result), -150);
});

test("cash and promotional credits repay debt before becoming available", () => {
  const initial = {
    cashMinor: 100,
    promotionalMinor: 0,
    reservedWithdrawalMinor: 0,
    debtMinor: 250
  };
  const afterPromo = applyBucketCredit(initial, 100, "promotional");
  const afterCash = applyBucketCredit(afterPromo, 300, "cash");

  assert.deepEqual(afterPromo, { ...initial, debtMinor: 150 });
  assert.deepEqual(afterCash, {
    cashMinor: 250,
    promotionalMinor: 0,
    reservedWithdrawalMinor: 0,
    debtMinor: 0
  });
});

test("sub-cent charges retain deterministic microminor precision", () => {
  const charge = calculateRetailChargeMicrominor({
    activeSeconds: 60,
    activeConfigMonthlyMinor: 1_000,
    bytesToDestination: 0n,
    bytesFromDestination: 0n,
    trafficPerGbMinor: 0
  });

  assert.equal(charge, 23_148n);
});
