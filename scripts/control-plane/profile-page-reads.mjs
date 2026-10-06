// Run from a built release with node --env-file=<api.env>. Never print rows,
// credentials, SQL parameters, wallet addresses, or RPC URLs.
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const root = process.cwd();
const fromRelease = path => import(pathToFileURL(resolve(root, path)).href);
const { createDatabase } = await fromRelease("packages/db/dist/index.js");
const reads = await fromRelease("packages/control-plane/dist/index.js");
const { loadConfig } = await fromRelease("apps/control-plane-api/dist/config.js");
const config = loadConfig();
const db = createDatabase({ connectionString: config.databaseUrl,
  applicationName: "hyperspace-page-read-profiler", maxConnections: 10, statementTimeoutMs: 15_000 });
let spans = [];
const round = n => Math.round(n * 100) / 100;
const query = db.query.bind(db);
db.query = async (sql, params) => {
  const start = performance.now();
  const fingerprint = createHash("sha256").update(sql).digest("hex").slice(0, 12);
  try { return await query(sql, params); }
  finally { spans.push({ kind: "database", fingerprint, ms: round(performance.now() - start),
    tables: [...new Set([...sql.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_]+)/gi)].map(m => m[1]))] }); }
};
const fetchImpl = async (url, init) => {
  const method = JSON.parse(init?.body ?? "{}").method ?? "unknown";
  const start = performance.now();
  try { return await fetch(url, init); }
  finally { spans.push({ kind: "rpc", method, ms: round(performance.now() - start) }); }
};
try {
  const account = await query(`SELECT accounts.id FROM accounts
    JOIN custodial_wallets ON custodial_wallets.account_id = accounts.id
    WHERE custodial_wallets.chain = 'solana'
      AND EXISTS (SELECT 1 FROM users WHERE users.account_id = accounts.id AND users.disabled_at IS NULL)
    ORDER BY accounts.created_at LIMIT 1`);
  const accountId = account.rows[0]?.id;
  const cases = [
    ["gates", () => reads.listPublicGates(db)],
    ["benchmarks", () => reads.readPublicGateBenchmarkMatrix(db)],
    ["trading_latency", () => reads.readPublicTradingLatency(db)],
    ["trading_cex", () => reads.readPublicTradingLatency(db, "cex")],
    ["trading_hyperliquid", () => reads.readPublicTradingLatency(db, "hyperliquid")],
    ["admin_customers", () => reads.listBillingCustomers(db)],
    ["admin_configs", () => reads.listAdminBillingConfigs(db)],
    ["admin_payments", () => reads.listAdminSolanaConfigPayments(db)],
    ["admin_deposits", () => reads.listAdminSolanaDeposits(db)],
    ...(accountId ? [
      ["sessions", () => reads.listPublicSessions(db, accountId)],
      ["personal_billing", () => reads.readAccountBillingSummary(db, accountId, { ...config.billing, fetchImpl })],
      ["personal_billing_metadata", () => reads.readAccountBillingSummary(db, accountId, { ...config.billing, fetchImpl }, { includeNativeBalance: false })]
    ] : [])
  ];
  for (const [name, run] of cases) {
    for (let iteration = 1; iteration <= 3; iteration++) {
      spans = [];
      const start = performance.now();
      const data = await run();
      console.log(JSON.stringify({ name, iteration, ms: round(performance.now() - start),
        rows: Array.isArray(data) ? data.length : undefined,
        bytes: Buffer.byteLength(JSON.stringify(data)),
        spans: spans.sort((a, b) => b.ms - a.ms) }));
    }
  }
} finally { await db.close(); }
