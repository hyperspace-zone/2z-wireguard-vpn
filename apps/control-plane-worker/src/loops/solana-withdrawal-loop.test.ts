import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import { associatedTokenAddress, createTransferCheckedInstruction } from "./solana-withdrawal-loop.js";

test("withdrawal signer derives deterministic ATAs and encodes SPL TransferChecked", () => {
  const owner = new PublicKey("AYSnuQirKADWjN2kPRq7UPwubK4QQsA6nDjkg53ag3co");
  const mint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const source = associatedTokenAddress(mint, owner);
  const destination = associatedTokenAddress(mint, new PublicKey("11111111111111111111111111111111"));
  const instruction = createTransferCheckedInstruction(source, mint, destination, owner, 25_000_000n, 6);

  assert.equal(source.toBase58(), associatedTokenAddress(mint, owner).toBase58());
  assert.equal(instruction.data.readUInt8(0), 12);
  assert.equal(instruction.data.readBigUInt64LE(1), 25_000_000n);
  assert.equal(instruction.data.readUInt8(9), 6);
  assert.equal(instruction.keys[3]?.isSigner, true);
});

test("withdrawal signer rejects an SPL amount larger than u64", () => {
  const key = new PublicKey("11111111111111111111111111111111");
  assert.throws(
    () => createTransferCheckedInstruction(key, key, key, key, 0x1_0000_0000_0000_0000n, 6),
    /does not fit/
  );
});
