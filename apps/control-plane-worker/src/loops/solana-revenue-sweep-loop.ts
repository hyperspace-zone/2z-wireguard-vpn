import {
  claimCashSweepSigningJob,
  confirmCashSweep,
  failCashSweep,
  listCashSweepConfirmations,
  recordCashSweepSubmission
} from "@hyperspace-zone/control-plane";
import type { Database } from "@hyperspace-zone/db";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import type { ControlPlaneWorkerConfig } from "../config.js";
import {
  associatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  encodeBase58
} from "./solana-withdrawal-loop.js";

const memoProgram = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

export function buildSolanaRevenueSweepTransaction(input: {
  feePayer: Keypair;
  sourceWallet: Keypair;
  mint: PublicKey;
  treasuryOwner: PublicKey;
  amountBaseUnits: bigint;
  tokenDecimals: number;
  sweepId: string;
  recentBlockhash: string;
}): {
  transaction: Transaction;
  sourceTokenAccount: PublicKey;
  treasuryTokenAccount: PublicKey;
} {
  const sourceTokenAccount = associatedTokenAddress(input.mint, input.sourceWallet.publicKey);
  const treasuryTokenAccount = associatedTokenAddress(input.mint, input.treasuryOwner);
  const transaction = new Transaction({
    feePayer: input.feePayer.publicKey,
    recentBlockhash: input.recentBlockhash
  }).add(
    createAssociatedTokenAccountIdempotentInstruction(
      input.feePayer.publicKey,
      treasuryTokenAccount,
      input.treasuryOwner,
      input.mint
    ),
    createTransferCheckedInstruction(
      sourceTokenAccount,
      input.mint,
      treasuryTokenAccount,
      input.sourceWallet.publicKey,
      input.amountBaseUnits,
      input.tokenDecimals
    ),
    new TransactionInstruction({
      programId: memoProgram,
      keys: [],
      data: Buffer.from(`hyperspace-revenue-sweep:${input.sweepId}`, "utf8")
    })
  );
  transaction.sign(input.feePayer, input.sourceWallet);
  return { transaction, sourceTokenAccount, treasuryTokenAccount };
}

export function createSolanaRevenueSweepLoop(db: Database, config: ControlPlaneWorkerConfig): {
  due(): boolean;
  runOnce(): Promise<{ signed: number; confirmed: number; failed: number }>;
} {
  let nextRunAt = 0;
  const connection = config.solanaRevenueSweeps.enabled && config.billing.solanaRpcUrl
    ? new Connection(config.billing.solanaRpcUrl, "confirmed")
    : null;
  return {
    due() {
      return Boolean(connection) && Date.now() >= nextRunAt;
    },
    async runOnce() {
      nextRunAt = Date.now() + Math.max(10, config.solanaRevenueSweeps.intervalSeconds) * 1000;
      const result = { signed: 0, confirmed: 0, failed: 0 };
      const encryptionKey = config.solanaWithdrawals.custodialEncryptionKey;
      const feePayer = config.solanaWithdrawals.feePayer;
      if (!connection || !encryptionKey || !feePayer || !config.solanaRevenueSweeps.treasuryAddress) {
        return result;
      }

      const submitted = await listCashSweepConfirmations(db);
      if (submitted.length > 0) {
        const statuses = await connection.getSignatureStatuses(
          submitted.map((sweep) => sweep.transactionSignature ?? ""),
          { searchTransactionHistory: true }
        );
        for (let index = 0; index < submitted.length; index += 1) {
          const sweep = submitted[index];
          const status = statuses.value[index];
          if (!sweep) continue;
          if (status?.err) {
            await failCashSweep(db, sweep.id, `Solana transaction failed: ${JSON.stringify(status.err)}`);
            result.failed += 1;
          } else if (status?.confirmationStatus === "finalized") {
            await confirmCashSweep(db, sweep.id);
            result.confirmed += 1;
          } else if (!status && sweep.submittedAt && Date.now() - Date.parse(sweep.submittedAt) > 10 * 60 * 1000) {
            await failCashSweep(db, sweep.id, "Revenue sweep transaction was not observed before blockhash expiry");
            result.failed += 1;
          }
        }
      }

      const job = await claimCashSweepSigningJob(db, encryptionKey);
      if (!job) return result;
      let submissionRecorded = false;
      try {
        const sourceWallet = Keypair.fromSeed(job.sourceWalletSeed);
        if (sourceWallet.publicKey.toBase58() !== job.sourceWalletAddress) {
          throw new Error("custodial wallet key does not match stored public key");
        }
        const mint = new PublicKey(job.sweep.tokenMint);
        const treasuryOwner = new PublicKey(config.solanaRevenueSweeps.treasuryAddress);
        const blockhash = await connection.getLatestBlockhash("finalized");
        const { transaction, sourceTokenAccount, treasuryTokenAccount } = buildSolanaRevenueSweepTransaction({
          feePayer,
          sourceWallet,
          mint,
          treasuryOwner,
          amountBaseUnits: BigInt(job.sweep.tokenAmountBaseUnits),
          tokenDecimals: config.billing.solanaTokenDecimals,
          sweepId: job.sweep.id,
          recentBlockhash: blockhash.blockhash
        });
        if (!transaction.signature) throw new Error("signed transaction is missing fee-payer signature");
        const signature = encodeBase58(transaction.signature);
        await recordCashSweepSubmission(db, job.sweep.id, signature, {
          recentBlockhash: blockhash.blockhash,
          lastValidBlockHeight: blockhash.lastValidBlockHeight,
          sourceWalletAddress: job.sourceWalletAddress,
          sourceTokenAccount: sourceTokenAccount.toBase58(),
          treasuryAddress: treasuryOwner.toBase58(),
          treasuryTokenAccount: treasuryTokenAccount.toBase58()
        });
        submissionRecorded = true;
        const sentSignature = await connection.sendRawTransaction(transaction.serialize(), {
          preflightCommitment: "confirmed",
          maxRetries: 3
        });
        if (sentSignature !== signature) throw new Error("Solana RPC returned an unexpected transaction signature");
        result.signed += 1;
      } catch (error) {
        if (!submissionRecorded) {
          await failCashSweep(db, job.sweep.id, error instanceof Error ? error.message : String(error));
        }
        result.failed += 1;
      } finally {
        job.sourceWalletSeed.fill(0);
      }
      return result;
    }
  };
}
