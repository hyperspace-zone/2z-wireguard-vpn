import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { buildSolanaRevenueSweepTransaction } from "./solana-revenue-sweep-loop.js";

test("revenue sweep signs an exact paid-usage transfer with an auditable memo", () => {
  const feePayer = Keypair.generate();
  const sourceWallet = Keypair.generate();
  const mint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const treasuryOwner = Keypair.generate().publicKey;
  const sweepId = "4a89a01d-8c7a-4cb4-90b0-bc17e49b65ef";
  const built = buildSolanaRevenueSweepTransaction({
    feePayer,
    sourceWallet,
    mint,
    treasuryOwner,
    amountBaseUnits: 3_000_000n,
    tokenDecimals: 6,
    sweepId,
    recentBlockhash: Keypair.generate().publicKey.toBase58()
  });

  assert.equal(built.transaction.instructions.length, 3);
  const transfer = built.transaction.instructions[1];
  assert.ok(transfer);
  assert.equal(transfer.data.readUInt8(0), 12);
  assert.equal(transfer.data.readBigUInt64LE(1), 3_000_000n);
  assert.equal(transfer.data.readUInt8(9), 6);
  assert.equal(transfer.keys[3]?.pubkey.toBase58(), sourceWallet.publicKey.toBase58());
  assert.equal(transfer.keys[3]?.isSigner, true);
  assert.equal(
    built.transaction.instructions[2]?.data.toString("utf8"),
    `hyperspace-revenue-sweep:${sweepId}`
  );
  assert.equal(built.transaction.signatures[0]?.publicKey.toBase58(), feePayer.publicKey.toBase58());
  assert.ok(built.transaction.signatures.every((signature) => signature.signature));
});
