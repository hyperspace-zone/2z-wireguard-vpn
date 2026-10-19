// Run only during the fenced cutover, after dump/restore and parity checks.
// Does not restart services, migrate rows, or edit Mongo credentials.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync, renameSync } from 'node:fs';
const root = process.env.HS_RUNTIME_ENV_DIR ?? '/etc/hyperspace';
const credentials = JSON.parse(readFileSync(process.env.HS_NEON_RUNTIME_FILE ?? `${root}/neon-runtime.json`, 'utf8'));
function validate(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid Neon connection URI'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname.endsWith('.neon.tech') ||
      !url.username || !url.password || !/^\/[a-zA-Z_][a-zA-Z0-9_]*$/.test(url.pathname) ||
      url.searchParams.get('sslmode') !== 'verify-full' || /[\r\n]/.test(value)) {
    throw new Error('Neon runtime requires credentials, a database and verified TLS');
  }
  return url;
}
const main = validate(credentials.databaseUrl), catalog = validate(credentials.catalogDatabaseUrl);
if (main.hostname !== catalog.hostname || main.pathname !== catalog.pathname || main.username === catalog.username) {
  throw new Error('Catalog must use a separate read-only role on the same database');
}
const changes = [
  ['control-plane-api', 'DATABASE_URL', credentials.databaseUrl],
  ['control-plane-worker', 'DATABASE_URL', credentials.databaseUrl],
  ['probes-worker', 'PROBES_CATALOG_DATABASE_URL', credentials.catalogDatabaseUrl]
].map(([name, key, value]) => {
  const file = `${root}/${name}.env`, original = readFileSync(file, 'utf8');
  if (original.split('\n').filter(line => line.startsWith(`${key}=`)).length !== 1) throw new Error(`Expected one ${key} in ${name}`);
  return { name, file, original, next: original.split('\n').map(line => line.startsWith(`${key}=`) ? `${key}=${value}` : line).join('\n') };
});
// Validate every input before editing anything. Keep recoverable originals and
// stage all new files before atomic per-file replacement. Services stay stopped
// until the operator has verified all three files; this isn't a live reload.
const backup = `${root}/before-neon-${new Date().toISOString().replace(/[:.]/g, '-')}`;
mkdirSync(backup, { mode: 0o700 });
for (const change of changes) {
  copyFileSync(change.file, `${backup}/${change.name}.env`);
  chmodSync(`${backup}/${change.name}.env`, 0o600);
  writeFileSync(`${change.file}.neon-next`, change.next, { mode: 0o600 });
  chmodSync(`${change.file}.neon-next`, 0o600);
}
for (const change of changes) renameSync(`${change.file}.neon-next`, change.file);
console.log(`Neon connection settings prepared; services NOT restarted. Originals: ${backup}`);
