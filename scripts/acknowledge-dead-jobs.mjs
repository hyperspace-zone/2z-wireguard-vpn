#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import pg from "pg";

const { Pool } = pg;

function usage() {
  console.log(`Usage:
  scripts/acknowledge-dead-jobs.mjs [options]

Options:
  --env-file <path>          Load DATABASE_URL from an environment file.
  --older-than <interval>    PostgreSQL interval for candidate jobs. Default: 24 hours.
  --type <job_type>          Limit to one job type. Can be repeated.
  --gate <gate_name>         Limit to one gate name.
  --reason <text>            Operator note stored in the job payload.
  --acknowledged-by <name>   Operator name stored in the job payload.
  --limit <number>           Number of summary rows to print. Default: 25.
  --execute                  Update candidates to acknowledged_dead.
  --dry-run                  Print candidates only. This is the default.
  --help                     Show this help.

Examples:
  scripts/acknowledge-dead-jobs.mjs --env-file /etc/hyperspace/control-plane-worker.env --older-than "24 hours"
  scripts/acknowledge-dead-jobs.mjs --env-file /etc/hyperspace/control-plane-worker.env --older-than "24 hours" --execute --reason "reviewed old setup failures"`);
}

function readEnvFile(path) {
  const content = fs.readFileSync(path, "utf8");
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match) {
      continue;
    }
    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
}

function parseArgs(argv) {
  const options = {
    envFile: null,
    olderThan: "24 hours",
    types: [],
    gate: null,
    reason: "operator acknowledged reviewed dead jobs",
    acknowledgedBy: process.env.USER || os.userInfo().username || "operator",
    limit: 25,
    execute: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      return value;
    };

    switch (arg) {
      case "--env-file":
        options.envFile = readValue();
        break;
      case "--older-than":
        options.olderThan = readValue();
        break;
      case "--type":
        options.types.push(readValue());
        break;
      case "--gate":
        options.gate = readValue();
        break;
      case "--reason":
        options.reason = readValue();
        break;
      case "--acknowledged-by":
        options.acknowledgedBy = readValue();
        break;
      case "--limit":
        options.limit = Number.parseInt(readValue(), 10);
        if (!Number.isSafeInteger(options.limit) || options.limit <= 0) {
          throw new Error("--limit must be a positive integer");
        }
        break;
      case "--execute":
        options.execute = true;
        break;
      case "--dry-run":
        options.execute = false;
        break;
      case "--help":
        usage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function buildCandidateFilter(options) {
  const params = [options.olderThan];
  const where = ["jobs.phase = 'dead'::job_phase", "jobs.updated_at < now() - ($1::interval)"];

  if (options.types.length > 0) {
    params.push(options.types);
    where.push(`jobs.type::text = ANY($${params.length}::text[])`);
  }

  if (options.gate) {
    params.push(options.gate);
    where.push(`gates.name = $${params.length}`);
  }

  return { params, whereSql: where.join("\n        AND ") };
}

function formatTimestamp(value) {
  return value instanceof Date ? value.toISOString() : String(value);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.envFile) {
    readEnvFile(options.envFile);
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required. Pass --env-file or export DATABASE_URL.");
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const { params, whereSql } = buildCandidateFilter(options);

  try {
    const totalResult = await pool.query(
      `
        SELECT count(*)::int AS count
        FROM jobs
        LEFT JOIN gates ON gates.id = jobs.gate_id
        WHERE ${whereSql}
      `,
      params
    );
    const total = totalResult.rows[0]?.count ?? 0;

    const summaryParams = [...params, options.limit];
    const summaryResult = await pool.query(
      `
        SELECT
          jobs.type::text AS type,
          COALESCE(gates.name, '(none)') AS gate,
          count(*)::int AS count,
          min(jobs.created_at) AS oldest_created_at,
          max(jobs.updated_at) AS newest_updated_at
        FROM jobs
        LEFT JOIN gates ON gates.id = jobs.gate_id
        WHERE ${whereSql}
        GROUP BY jobs.type::text, COALESCE(gates.name, '(none)')
        ORDER BY count DESC, type, gate
        LIMIT $${summaryParams.length}
      `,
      summaryParams
    );

    console.log(`dead job candidates: ${total}`);
    for (const row of summaryResult.rows) {
      console.log(
        `${row.count}\t${row.type}\t${row.gate}\toldest=${formatTimestamp(row.oldest_created_at)}\tnewest=${formatTimestamp(row.newest_updated_at)}`
      );
    }

    if (!options.execute) {
      console.log("dry-run only; pass --execute to mark these jobs as acknowledged_dead");
      return;
    }

    const updateParams = [...params, options.acknowledgedBy, options.reason];
    const acknowledgedByParam = updateParams.length - 1;
    const reasonParam = updateParams.length;
    const updateResult = await pool.query(
      `
        WITH candidates AS (
          SELECT jobs.id
          FROM jobs
          LEFT JOIN gates ON gates.id = jobs.gate_id
          WHERE ${whereSql}
        ),
        updated AS (
          UPDATE jobs
          SET
            phase = 'acknowledged_dead'::job_phase,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = now(),
            payload = jsonb_set(
              COALESCE(payload, '{}'::jsonb),
              '{operatorAcknowledgement}',
              jsonb_build_object(
                'acknowledgedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                'acknowledgedBy', $${acknowledgedByParam}::text,
                'reason', $${reasonParam}::text
              ),
              true
            )
          FROM candidates
          WHERE jobs.id = candidates.id
          RETURNING jobs.id
        )
        SELECT count(*)::int AS count FROM updated
      `,
      updateParams
    );

    console.log(`acknowledged_dead updated: ${updateResult.rows[0]?.count ?? 0}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
