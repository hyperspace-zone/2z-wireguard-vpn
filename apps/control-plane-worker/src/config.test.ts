import assert from "node:assert/strict";
import test from "node:test";
import { Keypair } from "@solana/web3.js";
import { loadConfig } from "./config.js";

const encryptionKey = Buffer.alloc(32, 7).toString("base64url");

test("revenue sweeps fail closed when the treasury is missing", () => {
  assert.throws(
    () => loadConfig(payoutEnv({ SOLANA_REVENUE_TREASURY_ADDRESS: "" })),
    /SOLANA_REVENUE_TREASURY_ADDRESS is required/
  );
});

test("revenue sweeps reject an invalid treasury address", () => {
  assert.throws(
    () => loadConfig(payoutEnv({ SOLANA_REVENUE_TREASURY_ADDRESS: "not-a-solana-address" })),
    /must be a valid Solana public key/
  );
});

test("revenue sweeps accept a complete signer configuration", () => {
  const treasury = Keypair.generate().publicKey.toBase58();
  const config = loadConfig(payoutEnv({ SOLANA_REVENUE_TREASURY_ADDRESS: treasury }));
  assert.equal(config.solanaRevenueSweeps.enabled, true);
  assert.equal(config.solanaRevenueSweeps.treasuryAddress, treasury);
  assert.ok(config.solanaWithdrawals.custodialEncryptionKey);
  assert.ok(config.solanaWithdrawals.feePayer);
});

test("worker separates private transaction verification from history RPC", () => {
  const config = loadConfig({
    DATABASE_URL: "postgresql://billing-test.invalid/hyperspace",
    ARTIFACT_ENCRYPTION_KEY: encryptionKey,
    SOLANA_RPC_URL: "https://private-rpc.invalid",
    SOLANA_HISTORY_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=fixture",
    HELIUS_PROJECT_ID: "918f7c24-95cf-47fc-b48b-690d47d1a1f8"
  });
  assert.equal(config.billing.solanaRpcUrl, "https://private-rpc.invalid");
  assert.equal(config.billing.solanaHistoryRpcUrl, "https://mainnet.helius-rpc.com/?api-key=fixture");
  assert.equal(config.billing.solanaHistoryRpcRequestsPerSecond, 8);
  assert.equal(config.solanaDirectDepositScanIntervalSeconds, 600);
  assert.equal(config.heliusUsage.projectId, "918f7c24-95cf-47fc-b48b-690d47d1a1f8");
});

function payoutEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgresql://billing-test.invalid/hyperspace",
    ARTIFACT_ENCRYPTION_KEY: encryptionKey,
    SOLANA_RPC_URL: "https://solana-rpc.invalid",
    SOLANA_REVENUE_SWEEPS_ENABLED: "true",
    SOLANA_REVENUE_TREASURY_ADDRESS: Keypair.generate().publicKey.toBase58(),
    CUSTODIAL_WALLET_ENCRYPTION_KEY: encryptionKey,
    SOLANA_FEE_PAYER_SECRET_KEY: JSON.stringify(Array.from(Keypair.generate().secretKey)),
    ...overrides
  };
}
