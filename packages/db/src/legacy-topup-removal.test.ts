import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationsUrl = new URL("../migrations/", import.meta.url);

test("fresh schemas never create the removed fixed-amount top-up model", async () => {
  const identityBilling = await readFile(new URL("0019_milestone3_identity_billing.sql", migrationsUrl), "utf8");
  const custodialWallets = await readFile(new URL("0022_custodial_solana_topups.sql", migrationsUrl), "utf8");
  const directDeposits = await readFile(new URL("0027_direct_solana_deposits.sql", migrationsUrl), "utf8");

  assert.doesNotMatch(identityBilling, /CREATE\s+TABLE\s+topup_intents/i);
  assert.doesNotMatch(custodialWallets, /topup_intents/i);
  assert.doesNotMatch(directDeposits, /topup_intent/i);
  assert.match(directDeposits, /CHECK\s*\(source_type\s*=\s*'direct_deposit'\)/i);
});

test("upgraded schemas drop the removed model and reject legacy receipts", async () => {
  const removal = await readFile(new URL("0036_remove_legacy_topup_intents.sql", migrationsUrl), "utf8");

  assert.match(removal, /DROP\s+TABLE\s+IF\s+EXISTS\s+topup_intents/i);
  assert.match(removal, /source_type\s*<>\s*'direct_deposit'/i);
  assert.match(removal, /CHECK\s*\(source_type\s*=\s*'direct_deposit'\)/i);
});
