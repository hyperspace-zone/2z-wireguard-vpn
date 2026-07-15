#!/usr/bin/env node
import fs from "node:fs";
import pg from "pg";

const { Pool } = pg;
const args = process.argv.slice(2);
const email = readArg(args, "--email");
const envFile = readArg(args, "--env-file", false);
const revoke = args.includes("--revoke");
if (!email) {
  console.error("Usage: scripts/grant-billing-admin.mjs --email user@domain [--env-file /etc/hyperspace/control-plane-api.env] [--revoke]");
  process.exit(2);
}
if (envFile) loadEnvFile(envFile);
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, application_name: "grant-billing-admin" });
try {
  const result = revoke
    ? await pool.query(
      `DELETE FROM user_roles USING users
       WHERE user_roles.user_id = users.id AND users.email = $1 AND user_roles.role = 'billing_admin'
       RETURNING user_roles.user_id`,
      [email]
    )
    : await pool.query(
      `INSERT INTO user_roles (user_id, role, granted_by)
       SELECT id, 'billing_admin', $2 FROM users WHERE email = $1 AND disabled_at IS NULL
       ON CONFLICT (user_id, role) DO UPDATE SET granted_by = EXCLUDED.granted_by, granted_at = now()
       RETURNING user_id`,
      [email, process.env.USER || "operator"]
    );
  if (result.rowCount !== 1) throw new Error(`active user not found or role unchanged for ${email}`);
  console.log(`${revoke ? "revoked" : "granted"} billing_admin for ${email}`);
} finally {
  await pool.end();
}

function readArg(argv, name, required = true) {
  const index = argv.indexOf(name);
  if (index < 0) return required ? "" : null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function loadEnvFile(path) {
  for (const rawLine of fs.readFileSync(path, "utf8").split(/\r?\n/u)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(rawLine.trim());
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] ??= value;
  }
}
