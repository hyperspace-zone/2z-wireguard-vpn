// Measure the real API, including authenticated pages. A short-lived diagnostic
// session is always removed; no token, user data, wallet address or RPC URL is
// printed. Run from a built release with the API environment file.
import { randomBytes, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const load = path => import(pathToFileURL(resolve(path)).href);
const { createDatabase } = await load("packages/db/dist/index.js");
const { loadConfig } = await load("apps/control-plane-api/dist/config.js");
const config = loadConfig();
const db = createDatabase({ connectionString: config.databaseUrl, applicationName: "hyperspace-page-api-verifier", maxConnections: 1 });
const token = randomBytes(32).toString("base64url");
const tokenHash = createHash("sha256").update(token).digest("hex");
const base = process.env.PAGE_API_BASE_URL ?? "http://127.0.0.1:8080";
const samples = [];
try {
  const user = (await db.query(`SELECT users.id FROM users JOIN custodial_wallets ON custodial_wallets.account_id = users.account_id
    WHERE users.disabled_at IS NULL AND custodial_wallets.chain='solana'
    ORDER BY (SELECT COUNT(*) FROM sessions WHERE sessions.account_id=users.account_id) DESC LIMIT 1`)).rows[0];
  if (!user) throw new Error("No existing wallet account available for verification");
  await db.query("INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES ($1,$2,now()+interval '10 minutes')", [user.id, tokenHash]);
  const paths = [
    "/v1/public/gates", "/v1/public/auth/me", "/v1/public/sessions",
    "/v1/public/billing?walletBalance=deferred",
    "/v1/public/billing/wallet-balance",
    "/v1/public/trading/latency?category=hyperliquid&target=default",
    "/v1/public/trading/latency?category=cex&target=default",
    "/v1/public/benchmarks/gate-matrix",
    "/v1/public/trading/pairs",
    "/v1/admin/billing/customers?customers=count&treasury=deferred",
    "/v1/admin/billing/traffic",
    "/v1/admin/billing/treasury"
  ];
  for (const path of paths) {
    for (let iteration = 1; iteration <= 5; iteration++) {
      const start = performance.now();
      const response = await fetch(base + path, { headers: { authorization: `Bearer ${token}`, "x-admin-token": config.adminToken ?? "" }, signal: AbortSignal.timeout(10_000) });
      const bytes = Buffer.from(await response.arrayBuffer());
      const match = response.headers.get("server-timing")?.match(/app;dur=([\d.]+)/);
      const sample = { path, iteration, status: response.status, serverMs: match ? Number(match[1]) : null,
        stages: response.headers.get("server-timing"),
        totalMs: Math.round((performance.now() - start) * 100) / 100, bytes: bytes.length };
      samples.push(sample); console.log(JSON.stringify(sample));
      if (!response.ok) throw new Error(`Page verification failed (${response.status})`);
    }
  }
} finally {
  await db.query("DELETE FROM auth_sessions WHERE token_hash=$1", [tokenHash]);
  await db.close();
}
