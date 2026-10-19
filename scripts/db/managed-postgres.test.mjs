import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, chmodSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');

test('Neon cutover preserves Mongo and wallet keys; validates all files before editing', () => {
  const root = mkdtempSync(join(tmpdir(), 'hs-neon-env-'));
  const script = new URL('./configure-neon-runtime.mjs', import.meta.url).pathname;
  const api = 'DATABASE_URL=postgres://old/core\nARTIFACT_ENCRYPTION_KEY=keep\nMEASUREMENTS_MONGO_URL=mongodb+srv://keep/db\n';
  try {
    const credentials = { databaseUrl: 'postgresql://app:secret@db.neon.tech/core?sslmode=verify-full', catalogDatabaseUrl: 'postgresql://reader:secret@db.neon.tech/core?sslmode=verify-full' };
    writeFileSync(join(root, 'neon-runtime.json'), JSON.stringify(credentials));
    writeFileSync(join(root, 'control-plane-api.env'), api);
    writeFileSync(join(root, 'control-plane-worker.env'), api);
    writeFileSync(join(root, 'probes-worker.env'), 'MISSING_CATALOG=yes\n');
    assert.throws(() => execFileSync(process.execPath, [script], { env: { ...process.env, HS_RUNTIME_ENV_DIR: root }, stdio: 'pipe' }));
    assert.equal(readFileSync(join(root, 'control-plane-api.env'), 'utf8'), api);
    writeFileSync(join(root, 'probes-worker.env'), 'PROBES_CATALOG_DATABASE_URL=old\nMEASUREMENTS_MONGO_URL=mongodb+srv://keep/db\n');
    execFileSync(process.execPath, [script], { env: { ...process.env, HS_RUNTIME_ENV_DIR: root } });
    const output = readFileSync(join(root, 'control-plane-api.env'), 'utf8');
    assert.match(output, /ARTIFACT_ENCRYPTION_KEY=keep/);
    assert.match(output, /MEASUREMENTS_MONGO_URL=mongodb\+srv:\/\/keep\/db/);
    assert.match(output, /sslmode=verify-full/);
    assert.equal(statSync(join(root, 'control-plane-api.env')).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(join(root, 'probes-worker.env'), 'utf8'), /ARTIFACT_ENCRYPTION_KEY|postgresql:\/\/app:/);
    credentials.databaseUrl = credentials.databaseUrl.replace('verify-full', 'disable');
    writeFileSync(join(root, 'neon-runtime.json'), JSON.stringify(credentials));
    assert.throws(() => execFileSync(process.execPath, [script], { env: { ...process.env, HS_RUNTIME_ENV_DIR: root }, stdio: 'pipe' }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('remote maintenance cannot start the retired local PostgreSQL service', () => {
  const conf = read('../../infra/systemd/hyperspace-postgres-managed.conf');
  for (const path of ['../../infra/systemd/hyperspace-db-backup.service', '../../infra/systemd/hyperspace-db-restore-check.service', '../../infra/systemd/hyperspace-db-history-archive.service', '../../infra/observability/systemd/hyperspace-postgres-health-exporter.service']) {
    const unit = read(path);
    assert.doesNotMatch(unit, /^(?:Requires|Wants|After)=.*postgresql/m);
    assert.match(unit, /After=network-online.target/);
  }
  assert.match(conf, /HS_POSTGRES_MANAGED=1/);
  assert.match(conf, /postgresql\/18\/bin/);
});

test('managed database TCP probe prefers the routed IPv4 family', () => {
  const blackbox = read('../../infra/observability/blackbox/blackbox.yml');
  assert.match(blackbox, /tcp_connect:[\s\S]*tcp:[\s\S]*preferred_ip_protocol: ip4/);
});

test('managed restore remaps owners and does not replay provider ACLs', () => {
  const script = read('./hyperspace-pg-restore-core');
  assert.match(script, /--no-owner --no-acl --role="\$app_owner"/);
  assert.match(script, /Refusing to overwrite an existing database/);
  assert.doesNotMatch(script, /--clean/);
});

test('catalog permissions include deployment status columns, not deployment secrets', () => {
  const grants = read('./neon-catalog-grants.sql');
  assert.match(grants, /GRANT SELECT \(id, gate_id, phase\) ON gate_agent_deployments/);
  assert.doesNotMatch(grants, /GRANT SELECT ON ALL TABLES|GRANT SELECT ON gate_agent_deployments/);
  for (const table of ['gates','gate_status','gate_conditions','gate_leases','trading_probe_nodes','trading_probe_auth_tokens','trading_probe_targets']) assert.ok(grants.includes(table));
});

test('core guards reject actual rows but allow empty FK maintenance', () => {
  const guard = read('./activate-core-isolation.sql');
  assert.doesNotMatch(guard, /FOR EACH STATEMENT/);
  assert.match(guard, /FOR EACH ROW EXECUTE FUNCTION reject_core_probe_write/);
  const repair = read('./repair-core-probe-guards.sql');
  assert.match(repair, /Core still contains probe rows/);
  assert.match(repair, /BEGIN;/);
  assert.match(repair, /COMMIT;/);
});

test('archive never changes local process priority using a remote backend PID', () => {
  const script = read('./hyperspace-pg-history-archive');
  assert.match(script, /managed" == 0 && \( -z "\$\{PGHOST:-\}"/);
});

test('managed health omits unsupported WAL and fails closed on SQL errors', () => {
  const root = mkdtempSync(join(tmpdir(), 'hs-managed-health-'));
  try {
    const bin = join(root, 'bin'), metrics = join(root, 'metrics'), backups = join(root, 'backups');
    for (const path of [bin, metrics, backups]) mkdirSync(path);
    const psql = join(bin, 'psql');
    writeFileSync(psql, '#!/bin/sh\nprintf "%s\\n" "$@" >"$HS_TEST_SQL"\nif [ "$HS_TEST_SQL_FAIL" = 1 ]; then exit 1; fi\nprintf "8\\t104\\t0\\t0\\t32\\t0\\t4096\\t\\n"\n');
    chmodSync(psql, 0o755);
    const script = new URL('../observability/hyperspace-postgres-health-exporter', import.meta.url).pathname;
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HS_POSTGRES_MANAGED: '1', HS_POSTGRES_METRICS_DIR: metrics, HS_DB_BACKUP_DIR: backups, HS_TEST_SQL: join(root, 'sql') };
    execFileSync('bash', [script], { env });
    const output = join(metrics, 'hyperspace_postgres_health.prom');
    const good = readFileSync(output, 'utf8');
    assert.match(good, /hyperspace_postgres_connections 8/);
    assert.doesNotMatch(good, /hyperspace_postgres_wal_size_bytes/);
    assert.doesNotMatch(readFileSync(env.HS_TEST_SQL, 'utf8'), /pg_ls_waldir/);
    assert.throws(() => execFileSync('bash', [script], { env: { ...env, HS_TEST_SQL_FAIL: '1' } }));
    assert.equal(readFileSync(output, 'utf8'), good, 'last good snapshot must not be overwritten on failure');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
