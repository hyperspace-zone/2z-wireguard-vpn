import assert from "node:assert/strict";
import test from "node:test";
import {
  createSolanaRpcRequestLimiter,
  findFinalizedSolanaSignaturesForAddress,
  findSolanaTokenAccountsByOwner,
  readSolanaMinimumBalanceForRentExemption,
  readSolanaNativeBalance,
  verifyNativeSolDirectDepositTransaction,
  verifySolanaDirectDepositTransaction
} from "./solana-rpc-verifier.js";

const signature = "5".repeat(88);
const sender = "Sender1111111111111111111111111111111111111";
const treasury = "Treasury11111111111111111111111111111111111";
const mint = "Mint111111111111111111111111111111111111111";
const reference = "hs_reference_123";

test("historical transaction verification stays on the history RPC and rate limiter", async () => {
  const historyRpc = "https://mainnet.helius-rpc.com/?api-key=fixture";
  const calls: Array<{ url: string; method: string; params: unknown[] }> = [];
  let limiterCalls = 0;
  const fixture = nativeSolRpcFixture({ recipientDeltaLamports: 1_819_440 });
  const result = await verifyNativeSolDirectDepositTransaction({
    transactionSignature: signature,
    recipientOwner: treasury
  }, {
    rpcUrl: historyRpc,
    searchTransactionHistory: true,
    beforeRequest: async () => {
      limiterCalls += 1;
    },
    fetchImpl: async (url, init) => {
      const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      calls.push({ url: String(url), method: request.method, params: request.params });
      return fixture(url, init);
    }
  });

  assert.equal(result.status, "verified");
  assert.equal(limiterCalls, 2);
  assert.deepEqual(calls.map(({ url, method }) => ({ url, method })), [
    { url: historyRpc, method: "getSignatureStatuses" },
    { url: historyRpc, method: "getTransaction" }
  ]);
  assert.deepEqual(calls[0]?.params, [[signature], { searchTransactionHistory: true }]);
});

test("Solana RPC retries a rate-limited call using Retry-After", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: 429, message: "Too many requests for a specific RPC call" }
      }), { status: 429, headers: { "retry-after": "0" } });
    }
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: [{ signature, err: null }]
    }));
  };

  assert.deepEqual(await findFinalizedSolanaSignaturesForAddress(
    treasury,
    { limit: 10 },
    { rpcUrl: "https://solana-rpc.example.invalid", fetchImpl }
  ), [{ signature, blockTime: null }]);
  assert.equal(calls, 2);
});

test("Solana RPC request limiter spaces history calls at the configured rate", async () => {
  let now = 1_000;
  const waits: number[] = [];
  const limiter = createSolanaRpcRequestLimiter(8, {
    now: () => now,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
    }
  });
  await limiter();
  await limiter();
  await limiter();
  assert.deepEqual(waits, [125, 125]);
});

test("direct Solana deposits accept the finalized positive USDC delta without a memo", async () => {
  const result = await verifySolanaDirectDepositTransaction({
    transactionSignature: signature,
    recipientOwner: treasury
  }, {
    rpcUrl: "https://rpc.testnet.hyperspace.zone",
    tokenMint: mint,
    fetchImpl: rpcFixture({ includeMemo: false, amountBaseUnits: 1_819_440n })
  });

  assert.equal(result.status, "verified");
  if (result.status === "verified") {
    assert.equal(result.amountBaseUnits, 1_819_440n);
    assert.deepEqual(result.references, []);
  }
});

test("native SOL balance reads finalized lamports", async () => {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    calls.push(request);
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { context: { slot: 123 }, value: 1_819_440 }
    }));
  };

  assert.equal(await readSolanaNativeBalance(treasury, {
    rpcUrl: "https://rpc.testnet.hyperspace.zone",
    fetchImpl
  }), 1_819_440n);
  assert.deepEqual(calls, [{
    jsonrpc: "2.0",
    id: 1,
    method: "getBalance",
    params: [treasury, { commitment: "finalized" }]
  }]);
});

test("native SOL rent reserve reads the finalized zero-data account minimum", async () => {
  const fetchImpl: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    assert.equal(request.method, "getMinimumBalanceForRentExemption");
    assert.deepEqual(request.params, [0, { commitment: "finalized" }]);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 890_880 }));
  };

  assert.equal(await readSolanaMinimumBalanceForRentExemption({
    rpcUrl: "https://rpc.testnet.hyperspace.zone",
    fetchImpl
  }), 890_880n);
});

test("native SOL deposits use the recipient's finalized net lamport increase", async () => {
  const result = await verifyNativeSolDirectDepositTransaction({
    transactionSignature: signature,
    recipientOwner: treasury
  }, {
    rpcUrl: "https://rpc.testnet.hyperspace.zone",
    fetchImpl: nativeSolRpcFixture({ recipientDeltaLamports: 1_819_440 })
  });

  assert.equal(result.status, "verified");
  if (result.status === "verified") {
    assert.equal(result.amountBaseUnits, 1_819_440n);
    assert.deepEqual(result.references, [reference]);
  }
});

test("native SOL deposits reject transactions without a positive recipient delta", async () => {
  const result = await verifyNativeSolDirectDepositTransaction({
    transactionSignature: signature,
    recipientOwner: treasury
  }, {
    rpcUrl: "https://rpc.testnet.hyperspace.zone",
    fetchImpl: nativeSolRpcFixture({ recipientDeltaLamports: 0 })
  });

  assert.deepEqual(result, { status: "invalid", reason: "no_positive_recipient_sol_delta" });
});

test("custodial wallet scan discovers token accounts and uses its signature cursor", async () => {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    calls.push(request);
    const result = request.method === "getTokenAccountsByOwner"
      ? { value: [{ pubkey: "TokenAccount11111111111111111111111111111111" }] }
      : [{ signature, err: null, blockTime: 1_700_000_000 }];
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  };

  assert.deepEqual(await findSolanaTokenAccountsByOwner(treasury, {
    rpcUrl: "https://rpc.testnet.hyperspace.zone",
    tokenMint: mint,
    fetchImpl
  }), ["TokenAccount11111111111111111111111111111111"]);
  assert.deepEqual(await findFinalizedSolanaSignaturesForAddress(
    "TokenAccount11111111111111111111111111111111",
    { until: "EarlierSignature", limit: 25 },
    { rpcUrl: "https://rpc.testnet.hyperspace.zone", fetchImpl }
  ), [{ signature, blockTime: 1_700_000_000 }]);
  assert.deepEqual(calls[1]?.params, [
    "TokenAccount11111111111111111111111111111111",
    { limit: 25, commitment: "finalized", until: "EarlierSignature" }
  ]);
});

function rpcFixture(options: {
  includeMemo?: boolean;
  amountBaseUnits?: bigint;
} = {}): typeof fetch {
  return async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string };
    const result = request.method === "getSignatureStatuses"
      ? { value: [{ err: null, confirmationStatus: "finalized" }] }
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
              ...(options.includeMemo === false ? [] : [{ program: "spl-memo", parsed: reference }]),
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
          postTokenBalances: [{
            accountIndex: 1,
            mint,
            owner: treasury,
            uiTokenAmount: { amount: String(1_000_000n + (options.amountBaseUnits ?? 25_000_000n)) }
          }]
        }
      };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
}

function nativeSolRpcFixture(options: { recipientDeltaLamports: number }): typeof fetch {
  return async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string };
    const result = request.method === "getSignatureStatuses"
      ? { value: [{ err: null, confirmationStatus: "finalized" }] }
      : {
        slot: 123,
        blockTime: 1_700_000_000,
        transaction: {
          message: {
            accountKeys: [
              { pubkey: sender, signer: true },
              { pubkey: treasury, signer: false }
            ],
            instructions: [{ program: "spl-memo", parsed: reference }]
          }
        },
        meta: {
          err: null,
          innerInstructions: [],
          preBalances: [2_000_000, 500_000],
          postBalances: [1_995_000, 500_000 + options.recipientDeltaLamports]
        }
      };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
}
