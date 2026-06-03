import { createDatabase, runMigrations } from "./index.js";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

const db = createDatabase({
  connectionString,
  applicationName: "hyperspace-migrations"
});

try {
  const applied = await runMigrations(db.pool);
  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        applied
      },
      null,
      2
    ) + "\n"
  );
} finally {
  await db.close();
}
