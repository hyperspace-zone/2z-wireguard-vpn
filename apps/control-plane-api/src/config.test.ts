import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "./config.js";

test("native SOL billing defaults use lamports and the 0.0001 SOL config price", () => {
  const config = loadConfig({
    DATABASE_URL: "postgres://hyperspace:secret@db.test/hyperspace",
    SOLANA_ASSET_KIND: "native",
    SOLANA_CONFIG_PAYMENT_ENABLED: "true",
    SOLANA_REVENUE_TREASURY_ADDRESS: "DWAg34bbga73yiCh1ic9KLAv3B7FDk62GmUcamXF2Ds8"
  });

  assert.equal(config.billing.solanaAssetKind, "native");
  assert.equal(config.billing.solanaTokenSymbol, "SOL");
  assert.equal(config.billing.solanaTokenMint, "native");
  assert.equal(config.billing.solanaTokenDecimals, 9);
  assert.equal(config.billing.solanaTokenBaseUnitsPerBillingMinor, 1);
  assert.equal(config.billing.configPriceLamports, 100_000);
  assert.equal(config.billing.configPaymentEnabled, true);
});
