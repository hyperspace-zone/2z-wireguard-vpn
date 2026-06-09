import { createDatabase } from "@hyperspace-zone/db";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const db = createDatabase({
  connectionString: config.databaseUrl,
  applicationName: "hyperspace-control-plane-api"
});

const app = createApp({
  db,
  config
});

process.on("SIGTERM", () => {
  void app.close().finally(() => db.close());
});

await app.listen({ host: config.host, port: config.port });
