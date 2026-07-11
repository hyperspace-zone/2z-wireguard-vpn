import assert from "node:assert/strict";
import test from "node:test";
import {
  findFinalizedSolanaSignaturesForReference,
  verifySolanaTopupTransaction
} from "./solana-rpc-verifier.js";

const signature = "5".repeat(88);
const sender = "Sender1111111111111111111111111111111111111";
const treasury = "Treasury11111111111111111111111111111111111";
const mint = "Mint111111111111111111111111111111111111111";
const reference = "hs_reference_123";

test("Solana top-up verifier requires finalized status, exact memo, recipient, mint, amount, and sender", async () => {
  const result = await verifySolanaTopupTransaction({
    transactionSignature: signature,
    treasuryAddress: treasury,
    reference,
    amountMinor: 2500,
    expectedSender: sender
  }, {
    rpcUrl: "https://rpc.testnet.hyperspace.zone",
    tokenMint: mint,
    tokenBaseUnitsPerBillingMinor: 10_000,
    fetchImpl: rpcFixture()
  });

  assert.equal(result.status, "verified");
  if (result.status === "verified") {
    assert.equal(result.evidence.amountBaseUnits, "25000000");
  }
});

test("Solana top-up verifier keeps a non-finalized transaction pending", async () => {
  const result = await verifySolanaTopupTransaction({
    transactionSignature: signature,
    treasuryAddress: treasury,
    reference,
    amountMinor: 2500
  }, {
    rpcUrl: "https://rpc.testnet.hyperspace.zone",
    tokenMint: mint,
    tokenBaseUnitsPerBillingMinor: 10_000,
    fetchImpl: rpcFixture({ confirmationStatus: "confirmed" })
  });

  assert.deepEqual(result, { status: "pending", reason: "transaction_not_finalized" });
});

test("Solana top-up verifier rejects a transaction without the intent memo", async () => {
  const result = await verifySolanaTopupTransaction({
    transactionSignature: signature,
    treasuryAddress: treasury,
    reference: "different-reference",
    amountMinor: 2500
  }, {
    rpcUrl: "https://rpc.testnet.hyperspace.zone",
    tokenMint: mint,
    tokenBaseUnitsPerBillingMinor: 10_000,
    fetchImpl: rpcFixture()
  });

  assert.deepEqual(result, { status: "invalid", reason: "topup_reference_memo_missing" });
});

test("Solana top-up verifier rejects an amount that does not match the treasury token delta", async () => {
  const result = await verifySolanaTopupTransaction({
    transactionSignature: signature,
    treasuryAddress: treasury,
    reference,
    amountMinor: 2501
  }, {
    rpcUrl: "https://rpc.testnet.hyperspace.zone",
    tokenMint: mint,
    tokenBaseUnitsPerBillingMinor: 10_000,
    fetchImpl: rpcFixture()
  });

  assert.deepEqual(result, { status: "invalid", reason: "token_amount_or_recipient_mismatch" });
});

test("Solana reference lookup requests finalized signatures in one RPC config object", async () => {
  let params: unknown[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { params: unknown[] };
    params = request.params;
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: [{ signature, err: null }]
    }));
  };

  const signatures = await findFinalizedSolanaSignaturesForReference(reference, {
    rpcUrl: "https://rpc.testnet.hyperspace.zone",
    fetchImpl
  });

  assert.deepEqual(signatures, [signature]);
  assert.deepEqual(params, [reference, { limit: 10, commitment: "finalized" }]);
});

function rpcFixture(options: { confirmationStatus?: string } = {}): typeof fetch {
  return async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string };
    const result = request.method === "getSignatureStatuses"
      ? { value: [{ err: null, confirmationStatus: options.confirmationStatus ?? "finalized" }] }
      : {
        slot: 123,
        blockTime: 1_700_000_000,
        transaction: {
          message: {
            accountKeys: [
              { pubkey: sender, signer: true },
              { pubkey: treasury, signer: false }
            ],
            instructions: [
              { program: "spl-memo", parsed: reference },
              {
                program: "spl-token",
                parsed: { type: "transferChecked", info: { authority: sender, mint } }
              }
            ]
          }
        },
        meta: {
          err: null,
          innerInstructions: [],
          preTokenBalances: [{ accountIndex: 1, mint, owner: treasury, uiTokenAmount: { amount: "1000000" } }],
          postTokenBalances: [{ accountIndex: 1, mint, owner: treasury, uiTokenAmount: { amount: "26000000" } }]
        }
      };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
}
