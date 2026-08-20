#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { Keypair } from "@solana/web3.js";
import {
  decryptJsonPayload,
  encryptJsonPayload,
  parseAes256GcmKey
} from "@hyperspace-zone/shared";

const { Pool } = pg;

export async function main(argv = process.argv.slice(2), runtimeEnv = process.env) {
  const args = parseArgs(argv);
  const sourceEnv = readEnvFile(args.sourceEnvFile);
  const targetEnv = readEnvFile(args.targetEnvFile);
  const sourceDatabaseUrl = runtimeEnv.SOURCE_DATABASE_URL || sourceEnv.DATABASE_URL;
  const targetDatabaseUrl = runtimeEnv.TARGET_DATABASE_URL || targetEnv.DATABASE_URL;
  const sourceKeyRaw = runtimeEnv.SOURCE_CUSTODIAL_WALLET_ENCRYPTION_KEY
    || sourceEnv.CUSTODIAL_WALLET_ENCRYPTION_KEY;
  const targetKeyRaw = runtimeEnv.TARGET_CUSTODIAL_WALLET_ENCRYPTION_KEY
    || targetEnv.CUSTODIAL_WALLET_ENCRYPTION_KEY;
  const solanaRpcUrl = runtimeEnv.TARGET_SOLANA_RPC_URL || targetEnv.SOLANA_RPC_URL;
  const cutoverHistoryRpcUrl = runtimeEnv.CUTOVER_SOLANA_HISTORY_RPC_URL || solanaRpcUrl;
  const solanaRpcHostHeader = runtimeEnv.TARGET_SOLANA_RPC_HOST_HEADER
    || targetEnv.SOLANA_RPC_HOST_HEADER;
  if (!sourceDatabaseUrl || !targetDatabaseUrl) {
    throw new Error("source and target DATABASE_URL values are required");
  }
  if (!sourceKeyRaw || !targetKeyRaw) {
    throw new Error("source and target CUSTODIAL_WALLET_ENCRYPTION_KEY values are required");
  }
  if (args.execute && !solanaRpcUrl) {
    throw new Error("target SOLANA_RPC_URL is required with --execute to establish the deposit cutover cursor");
  }

  const sourceKey = parseAes256GcmKey(sourceKeyRaw, "SOURCE_CUSTODIAL_WALLET_ENCRYPTION_KEY");
  const targetKey = parseAes256GcmKey(targetKeyRaw, "TARGET_CUSTODIAL_WALLET_ENCRYPTION_KEY");
  const sourcePool = new Pool({
    connectionString: sourceDatabaseUrl,
    application_name: "hyperspace-wallet-migration-source",
    max: 1
  });
  const targetPool = new Pool({
    connectionString: targetDatabaseUrl,
    application_name: "hyperspace-wallet-migration-target",
    max: 1
  });

  try {
    const plans = [];
    for (const email of args.emails) {
      const source = await readSourceWallet(sourcePool, email);
      const target = await readTargetAccount(targetPool, email);
      const migrated = reencryptCustodialWallet({
        encryptedKey: source.encryptedKey,
        sourceAccountId: source.accountId,
        targetAccountId: target.accountId,
        publicKey: source.publicKey,
        sourceKey,
        targetKey
      });
      const existing = await readTargetWallet(targetPool, target.accountId);
      if (existing && existing.publicKey !== source.publicKey) {
        throw new Error(`target account ${email} already has a different Solana wallet`);
      }
      if (existing) {
        validateTargetWallet(existing, target.accountId, targetKey);
      }
      const latestSignature = args.execute
        ? await readLatestFinalizedSignature(
          cutoverHistoryRpcUrl,
          source.publicKey,
          cutoverHistoryRpcUrl === solanaRpcUrl ? solanaRpcHostHeader : undefined
        )
        : null;
      plans.push({ email, source, target, migrated, existing, latestSignature });
    }

    if (args.execute) {
      const client = await targetPool.connect();
      try {
        await client.query("BEGIN");
        for (const plan of plans) {
          const walletId = await upsertTargetWallet(client, plan);
          await establishNativeSolanaCutoverCursor(client, {
            walletId,
            publicKey: plan.source.publicKey,
            latestSignature: plan.latestSignature
          });
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    console.log(JSON.stringify({
      ok: true,
      mode: args.execute ? "execute" : "dry-run",
      wallets: plans.map((plan) => ({
        email: plan.email,
        publicKey: plan.source.publicKey,
        targetAccountId: plan.target.accountId,
        targetWalletState: plan.existing ? "already-present" : args.execute ? "migrated" : "would-migrate",
        cutoverCursor: !args.execute
          ? "not-queried-in-dry-run"
          : plan.latestSignature
            ? "finalized-signature-recorded"
            : "no-existing-signature"
      }))
    }, null, 2));
  } finally {
    sourceKey.fill(0);
    targetKey.fill(0);
    await Promise.all([sourcePool.end(), targetPool.end()]);
  }
}

export function reencryptCustodialWallet(input) {
  const expectedSourceAad = walletAad(input.sourceAccountId, input.publicKey);
  if (input.encryptedKey.aad !== expectedSourceAad) {
    throw new Error("source wallet encryption context does not match its account and public key");
  }
  const decrypted = decryptJsonPayload(input.encryptedKey, input.sourceKey);
  if (decrypted?.format !== "ed25519-jwk-seed-v1" || typeof decrypted.seed !== "string") {
    throw new Error("unsupported custodial wallet key format");
  }
  const seed = Buffer.from(decrypted.seed, "base64url");
  try {
    if (seed.length !== 32) throw new Error("custodial wallet seed must be 32 bytes");
    const derivedPublicKey = Keypair.fromSeed(seed).publicKey.toBase58();
    if (derivedPublicKey !== input.publicKey) {
      throw new Error("custodial wallet seed does not match the stored public key");
    }
    return encryptJsonPayload(
      { seed: decrypted.seed, format: decrypted.format },
      input.targetKey,
      walletAad(input.targetAccountId, input.publicKey)
    );
  } finally {
    seed.fill(0);
  }
}

export function parseArgs(argv) {
  const sourceEnvFile = readSingleArg(argv, "--source-env-file");
  const targetEnvFile = readSingleArg(argv, "--target-env-file");
  const emails = readRepeatedArg(argv, "--email").map(normalizeEmail);
  if (emails.length === 0) {
    throw new Error("at least one --email is required");
  }
  const allowed = new Set(["--source-env-file", "--target-env-file", "--email", "--execute"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!allowed.has(arg)) throw new Error(`unknown argument: ${arg}`);
    if (arg !== "--execute") index += 1;
  }
  return {
    sourceEnvFile,
    targetEnvFile,
    emails: [...new Set(emails)],
    execute: argv.includes("--execute")
  };
}

async function readSourceWallet(db, email) {
  const result = await db.query(
    `SELECT users.account_id AS "accountId",
            custodial_wallets.public_key AS "publicKey",
            custodial_wallets.encrypted_key AS "encryptedKey"
     FROM users
     JOIN custodial_wallets ON custodial_wallets.account_id = users.account_id
     WHERE lower(users.email::text) = $1
       AND custodial_wallets.chain = 'solana'
       AND custodial_wallets.status = 'active'`,
    [email]
  );
  if (result.rowCount !== 1) throw new Error(`source wallet not found for ${email}`);
  return result.rows[0];
}

async function readTargetAccount(db, email) {
  const result = await db.query(
    `SELECT account_id AS "accountId" FROM users
     WHERE lower(email::text) = $1 AND disabled_at IS NULL`,
    [email]
  );
  if (result.rowCount !== 1) throw new Error(`unique active target user not found for ${email}`);
  return result.rows[0];
}

async function readTargetWallet(db, accountId) {
  const result = await db.query(
    `SELECT id, public_key AS "publicKey", encrypted_key AS "encryptedKey"
     FROM custodial_wallets
     WHERE account_id = $1 AND chain = 'solana' AND status = 'active'`,
    [accountId]
  );
  return result.rows[0] ?? null;
}

function validateTargetWallet(wallet, accountId, targetKey) {
  const decrypted = decryptJsonPayload(wallet.encryptedKey, targetKey);
  const seed = Buffer.from(decrypted.seed ?? "", "base64url");
  try {
    if (decrypted.format !== "ed25519-jwk-seed-v1" || seed.length !== 32) {
      throw new Error("existing target wallet has an unsupported key format");
    }
    if (Keypair.fromSeed(seed).publicKey.toBase58() !== wallet.publicKey) {
      throw new Error("existing target wallet key does not match its public key");
    }
    if (wallet.encryptedKey.aad !== walletAad(accountId, wallet.publicKey)) {
      throw new Error("existing target wallet encryption context is invalid");
    }
  } finally {
    seed.fill(0);
  }
}

async function upsertTargetWallet(client, plan) {
  if (plan.existing) return plan.existing.id;
  const result = await client.query(
    `INSERT INTO custodial_wallets (
       account_id, chain, public_key, encrypted_key, key_fingerprint, metadata, created_at, updated_at
     ) VALUES ($1, 'solana', $2, $3::jsonb, $4, $5::jsonb, now(), now())
     RETURNING id`,
    [
      plan.target.accountId,
      plan.source.publicKey,
      JSON.stringify(plan.migrated),
      plan.migrated.keyFingerprint,
      JSON.stringify({ createdBy: "production-wallet-cutover", keyFormat: "ed25519-jwk-seed-v1" })
    ]
  );
  return result.rows[0].id;
}

async function establishNativeSolanaCutoverCursor(client, input) {
  const latestSignatures = input.latestSignature ? { [input.publicKey]: input.latestSignature } : {};
  await client.query(
    `INSERT INTO solana_deposit_scan_cursors (
       wallet_id, token_mint, token_accounts, latest_signatures,
       next_scan_at, last_scanned_at, last_error
     ) VALUES ($1, 'native', $2::jsonb, $3::jsonb, now(), now(), NULL)
     ON CONFLICT (wallet_id, token_mint) DO UPDATE
     SET token_accounts = EXCLUDED.token_accounts,
         latest_signatures = EXCLUDED.latest_signatures,
         next_scan_at = now(),
         last_scanned_at = now(),
         last_error = NULL,
         updated_at = now()`,
    [input.walletId, JSON.stringify([input.publicKey]), JSON.stringify(latestSignatures)]
  );
}

async function readLatestFinalizedSignature(rpcUrl, publicKey, hostHeader) {
  const requestBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "getSignaturesForAddress",
    params: [publicKey, { commitment: "finalized", limit: 1 }]
  });
  const { status, body } = hostHeader
    ? await postJsonWithHostHeader(rpcUrl, requestBody, hostHeader)
    : await postJson(rpcUrl, requestBody);
  if (status < 200 || status >= 300) throw new Error(`Solana RPC returned HTTP ${status}`);
  if (!body.trim()) throw new Error("Solana RPC returned an empty response");
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error("Solana RPC returned a non-JSON response");
  }
  if (payload.error) throw new Error(`Solana RPC error ${payload.error.code ?? "unknown"}`);
  const record = payload.result?.[0];
  if (record?.err) throw new Error("latest Solana wallet transaction is failed");
  return typeof record?.signature === "string" ? record.signature : null;
}

async function postJson(rpcUrl, body) {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body
  });
  return { status: response.status, body: await response.text() };
}

function postJsonWithHostHeader(rpcUrl, body, hostHeader) {
  return new Promise((resolve, reject) => {
    const url = new URL(rpcUrl);
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers: {
        host: hostHeader,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body)
      }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.on("error", reject);
    request.end(body);
  });
}

function walletAad(accountId, publicKey) {
  return `custodial-wallet:${accountId}:solana:${publicKey}`;
}

function readEnvFile(path) {
  const values = {};
  for (const rawLine of fs.readFileSync(path, "utf8").split(/\r?\n/u)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(rawLine.trim());
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function readSingleArg(argv, name) {
  const values = readRepeatedArg(argv, name);
  if (values.length !== 1) throw new Error(`${name} must be supplied exactly once`);
  return values[0];
}

function readRepeatedArg(argv, name) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== name) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    values.push(value);
  }
  return values;
}

function normalizeEmail(value) {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new Error(`invalid email: ${value}`);
  return email;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
