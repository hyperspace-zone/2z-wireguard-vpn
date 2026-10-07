import { createDatabase } from "@hyperspace-zone/db";
import { attachMeasurementStore, MongoMeasurementStore } from "@hyperspace-zone/control-plane";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const db = createDatabase({
  connectionString: config.databaseUrl,
  applicationName: "hyperspace-control-plane-api",
  minConnections: 10
});
const benchmarkDb = createDatabase({
  connectionString: config.probesDatabaseUrl ?? config.databaseUrl,
  applicationName: "hyperspace-control-plane-benchmarks",
  maxConnections: config.benchmarkDatabaseMaxConnections,
  minConnections: config.benchmarkDatabaseMaxConnections,
  connectionTimeoutMs: config.probesDatabaseUrl ? 1500 : 5000,
  statementTimeoutMs: config.benchmarkDatabaseStatementTimeoutMs
});

const measurements = process.env.MEASUREMENTS_MONGO_URL
  ? new MongoMeasurementStore(process.env.MEASUREMENTS_MONGO_URL, process.env.MEASUREMENTS_MONGO_CA_FILE) : undefined;
if (measurements) {
  if (!config.probesDatabaseUrl) throw new Error("Mongo measurements require an isolated probes database");
  attachMeasurementStore(benchmarkDb, measurements);
}
const app = createApp({
  db,
  benchmarkDb,
  ...(config.probesDatabaseUrl ? { probesDb: benchmarkDb } : {}),
  config
});

// Establish the bounded pools before accepting page reads. Otherwise a quiet
// site pays PostgreSQL/TLS connection setup on its next visitor's first request.
app.addHook("onReady", async () => {
  // Only core is a startup dependency. Probes reconnect lazily, even when the
  // probes server is completely unavailable during this API restart.
  for (const [database, count] of [[db, 10]] as const) {
    const connections = await Promise.allSettled(Array.from({ length: count }, () => database.pool.connect()));
    try {
      const failed = connections.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      await Promise.all(connections.map(result => result.status === "fulfilled" ? result.value.query("SELECT 1") : undefined));
    } finally {
      for (const result of connections) if (result.status === "fulfilled") result.value.release();
    }
  }
});

process.on("SIGTERM", () => {
  void app.close().finally(() => Promise.all([db.close(), benchmarkDb.close(), measurements?.close()]));
});

await app.listen({ host: config.host, port: config.port });
