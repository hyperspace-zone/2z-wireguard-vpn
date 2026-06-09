import { createDatabase } from "@hyperspace-zone/db";
import { loadConfig } from "./config.js";
import { createWorkerRunner } from "./runners/worker-runner.js";

const config = loadConfig();
const db = createDatabase({
  connectionString: config.databaseUrl,
  applicationName: "hyperspace-control-plane-worker"
});
const runner = createWorkerRunner({ db, config });

process.on("SIGTERM", () => {
  void runner.stop().then(() => process.exit(0));
});

await runner.start();
