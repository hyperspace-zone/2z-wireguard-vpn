import { readFile } from "node:fs/promises";
import { normalizeGateSeeds } from "./gate-seed.js";
import { createDatabase, newSecretToken, sha256Hex } from "./index.js";

const connectionString = process.env.DATABASE_URL;
const args = process.argv.slice(2);
const quietJson = args.includes("--quiet-json");
const seedPath = args.find((arg) => !arg.startsWith("--"));

if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

if (!seedPath) {
  throw new Error("seed JSON path is required");
}

const seeds = normalizeGateSeeds(JSON.parse(await readFile(seedPath, "utf8")));
const db = createDatabase({
  connectionString,
  applicationName: "hyperspace-gate-seed"
});

try {
  const issuedTokens: Array<{ gate: string; token: string }> = [];

  await db.transaction(async (client) => {
    for (const seed of seeds) {
      const gate = await client.query<{ id: string }>(
        `
          INSERT INTO gates (
            name,
            desired_state,
            identity,
            city,
            country,
            public_endpoint,
            scheduling_weight,
            capacity_limit,
            spec
          )
          VALUES ($1, 'Enabled', $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
          ON CONFLICT (name) DO UPDATE
          SET
            identity = EXCLUDED.identity,
            city = EXCLUDED.city,
            country = EXCLUDED.country,
            public_endpoint = EXCLUDED.public_endpoint,
            scheduling_weight = EXCLUDED.scheduling_weight,
            capacity_limit = EXCLUDED.capacity_limit,
            desired_state = 'Enabled',
            spec = EXCLUDED.spec,
            updated_at = now()
          RETURNING id
        `,
        [
          seed.name,
          seed.identity,
          seed.city,
          seed.country,
          seed.publicEndpoint,
          100,
          0,
          JSON.stringify({
            doubleZeroEnv: seed.doubleZeroEnv,
            ...(seed.probeUrl ? { probeUrl: seed.probeUrl } : {}),
            location: {
              city: seed.city,
              country: seed.country
            }
          })
        ]
      );

      const gateId = gate.rows[0]?.id;
      if (!gateId) {
        throw new Error(`failed to seed gate ${seed.name}`);
      }

      const existingToken = await client.query(
        "SELECT 1 FROM gate_auth_tokens WHERE gate_id = $1 AND name = 'default' AND revoked_at IS NULL",
        [gateId]
      );

      if (existingToken.rowCount === 0) {
        const token = newSecretToken();
        await client.query(
          `
            INSERT INTO gate_auth_tokens (gate_id, token_hash, name)
            VALUES ($1, $2, 'default')
          `,
          [gateId, sha256Hex(token)]
        );
        issuedTokens.push({ gate: seed.name, token });
      }

      await client.query(
        `
          INSERT INTO gate_status (gate_id, observed_generation)
          VALUES ($1, 0)
          ON CONFLICT (gate_id) DO NOTHING
        `,
        [gateId]
      );
    }
  });

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        issuedTokens,
        note: "Store issued tokens in /etc/hyperspace/gate-agent.env on each gate. They are not recoverable from the database."
      },
      null,
      quietJson ? 0 : 2
    ) + "\n"
  );
} finally {
  await db.close();
}
