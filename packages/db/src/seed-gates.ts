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
    const existing = await client.query<{
      name: string;
      identity: string;
      publicIpv4: string;
      probeHost: string | null;
    }>(
      `
        SELECT
          name,
          identity,
          public_ipv4 AS "publicIpv4",
          lower(NULLIF(spec->>'probeHost', '')) AS "probeHost"
        FROM gates
        WHERE name = ANY($1::text[])
           OR identity = ANY($2::text[])
           OR public_ipv4 = ANY($3::text[])
           OR lower(NULLIF(spec->>'probeHost', '')) = ANY($4::text[])
      `,
      [
        seeds.map((seed) => seed.name),
        seeds.map((seed) => seed.identity),
        seeds.map((seed) => seed.publicIpv4),
        seeds.map((seed) => seed.probeHost).filter((value): value is string => Boolean(value))
      ]
    );
    for (const row of existing.rows) {
      for (const seed of seeds) {
        if (row.name === seed.name) {
          continue;
        }
        if (row.identity === seed.identity) {
          throw new Error(`gate identity ${seed.identity} is already used by ${row.name}`);
        }
        if (row.publicIpv4 === seed.publicIpv4) {
          throw new Error(`gate publicIpv4 ${seed.publicIpv4} is already used by ${row.name}`);
        }
        if (row.probeHost && seed.probeHost && row.probeHost === seed.probeHost) {
          throw new Error(`gate probe host ${seed.probeHost} is already used by ${row.name}`);
        }
      }
    }

    for (const seed of seeds) {
      const gate = await client.query<{ id: string }>(
        `
          INSERT INTO gates (
            name,
            desired_state,
            identity,
            city,
            country,
            public_ipv4,
            scheduling_weight,
            capacity_limit,
            spec
          )
          VALUES ($1, $9::gate_desired_state, $2, $3, $4, $5, $6, $7, $8::jsonb)
          ON CONFLICT (name) DO UPDATE
          SET
            identity = EXCLUDED.identity,
            city = EXCLUDED.city,
            country = EXCLUDED.country,
            public_ipv4 = EXCLUDED.public_ipv4,
            scheduling_weight = EXCLUDED.scheduling_weight,
            capacity_limit = EXCLUDED.capacity_limit,
            desired_state = EXCLUDED.desired_state,
            spec = EXCLUDED.spec,
            updated_at = now()
          RETURNING id
        `,
        [
          seed.name,
          seed.identity,
          seed.city,
          seed.country,
          seed.publicIpv4,
          100,
          0,
          JSON.stringify({
            doubleZeroEnv: seed.doubleZeroEnv,
            ...(seed.probeUrl ? { probeUrl: seed.probeUrl } : {}),
            ...(seed.probeHost ? { probeHost: seed.probeHost } : {}),
            location: {
              city: seed.city,
              country: seed.country
            }
          }),
          seed.desiredState
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
