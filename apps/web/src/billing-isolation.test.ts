import assert from "node:assert/strict";
import test from "node:test";
import { readRequestTimeoutMs, shouldLoadAdminBilling } from "./billing-isolation.js";

test("only the Admin view fetches global billing inventories and traffic", () => {
  assert.equal(shouldLoadAdminBilling("admin-billing"), true);
  for (const view of ["dashboard", "billing", "create-config", "benchmarks", "login", "register"]) {
    assert.equal(shouldLoadAdminBilling(view), false);
  }
  assert.equal(readRequestTimeoutMs, 10_000);
});
