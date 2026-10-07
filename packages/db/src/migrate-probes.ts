import { createDatabase } from "./index.js";
import { runProbesMigrations } from "./probes.js";
if (!process.env.PROBES_DATABASE_URL) throw new Error("PROBES_DATABASE_URL is required; refusing to use core");
const db = createDatabase({ connectionString: process.env.PROBES_DATABASE_URL, applicationName: "hyperspace-probes-migrations", maxConnections: 1 });
try { await runProbesMigrations(db.pool); console.log("Probes schema ready (no user/payment tables)."); }
finally { await db.close(); }
