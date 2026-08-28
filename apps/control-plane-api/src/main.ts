import { createDatabase } from "@hyperspace-zone/db";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const db = createDatabase({
  connectionString: config.databaseUrl,
  applicationName: "hyperspace-control-plane-api"
});
const benchmarkDb = createDatabase({
  connectionString: config.databaseUrl,
  applicationName: "hyperspace-control-plane-benchmarks",
  maxConnections: config.benchmarkDatabaseMaxConnections,
  statementTimeoutMs: config.benchmarkDatabaseStatementTimeoutMs
});

const app = createApp({
  db,
  benchmarkDb,
  config
});

process.on("SIGTERM", () => {
  void app.close().finally(() => Promise.all([db.close(), benchmarkDb.close()]));
});

await app.listen({ host: config.host, port: config.port });
