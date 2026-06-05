import { readFile } from "node:fs/promises";
import { createDatabase, newSecretToken, sha256Hex } from "./index.js";

interface GateSeed {
  name: string;
  identity: string;
  region: string;
  city: string;
  country: string;
  countryCode: string;
  publicEndpoint: string;
  probeUrl?: string;
  doubleZeroEnv?: "testnet" | "mainnet-beta";
  schedulingWeight?: number;
  capacityLimit?: number;
}

const connectionString = process.env.DATABASE_URL;
const seedPath = process.argv[2];

if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

if (!seedPath) {
  throw new Error("seed JSON path is required");
}

const seeds = JSON.parse(await readFile(seedPath, "utf8")) as GateSeed[];
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
            region,
            city,
            country,
            country_code,
            public_endpoint,
            scheduling_weight,
            capacity_limit,
            spec
          )
          VALUES ($1, 'Enabled', $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
          ON CONFLICT (name) DO UPDATE
          SET
            identity = EXCLUDED.identity,
            region = EXCLUDED.region,
            city = EXCLUDED.city,
            country = EXCLUDED.country,
            country_code = EXCLUDED.country_code,
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
          seed.region,
          seed.city,
          seed.country,
          seed.countryCode,
          seed.publicEndpoint,
          seed.schedulingWeight ?? 100,
          seed.capacityLimit ?? 128,
          JSON.stringify({
            doubleZeroEnv: seed.doubleZeroEnv ?? "testnet",
            ...(seed.probeUrl ? { probeUrl: seed.probeUrl } : {}),
            location: {
              city: seed.city,
              country: seed.country,
              countryCode: seed.countryCode
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
      2
    ) + "\n"
  );
} finally {
  await db.close();
}
