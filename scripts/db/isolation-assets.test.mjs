import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
test('probes instance has a bounded filesystem, memory, CPU and private access',()=>{
  const installer=read('./install-probes-instance');execFileSync('bash',['-n',new URL('./install-probes-instance',import.meta.url).pathname]);
  assert.match(installer,/fallocate -l 16G/);assert.match(installer,/chmod 0600/);assert.match(installer,/--port=5433/);
  assert.match(installer,/-E nodiscard/);assert.match(installer,/X-fstrim.notrim/);
  assert.match(installer,/default_transaction_read_only=on/);assert.match(installer,/CONNECTION LIMIT 2/);
  const limits=read('../../infra/postgres/probes-isolation.conf');assert.match(limits,/MemoryMax=1536M/);assert.match(limits,/CPUQuota=150%/);assert.match(limits,/RequiresMountsFor=/);
});
test('restore refuses existing databases and verifies checksums before creating a destination',()=>{
  const script=read('./hyperspace-pg-restore-core');execFileSync('bash',['-n',new URL('./hyperspace-pg-restore-core',import.meta.url).pathname]);
  assert.ok(script.indexOf('Backup checksum mismatch')<script.indexOf('createdb --template'));
  assert.ok(script.indexOf('Refusing to overwrite')<script.indexOf('createdb --template'));
  assert.match(script,/--exit-on-error --single-transaction/);
  assert.match(script,/--owner="\$app_owner"/);
  assert.match(script,/SET ROLE :"app_owner"/);
  assert.doesNotMatch(script,/dropdb|--clean|systemctl/);
});
test('runtime isolation keeps billing secrets out of the optional worker and preserves original env',()=>{
  const dir=mkdtempSync(join(tmpdir(),'hyperspace-isolation-test-'));
  try {
    writeFileSync(join(dir,'control-plane-api.env'),'DATABASE_URL=postgres://core/hyperspace\nPORT=8080\n');
    writeFileSync(join(dir,'control-plane-worker.env'),'DATABASE_URL=postgres://core/hyperspace\nARTIFACT_ENCRYPTION_KEY=must-not-copy\nTRADING_PROBES_ENABLED=true\nBENCHMARK_INTERVAL_SECONDS=300\n');
    writeFileSync(join(dir,'probes-instance.env'),'PROBES_DATABASE_URL=postgres://probes/hyperspace_probes\nPROBES_CATALOG_DATABASE_URL=postgres://readonly/hyperspace\n');
    execFileSync(process.execPath,[new URL('./configure-probes-runtime.mjs',import.meta.url).pathname],{env:{...process.env,HS_RUNTIME_ENV_DIR:dir}});
    const optional=readFileSync(join(dir,'probes-worker.env'),'utf8');
    assert.doesNotMatch(optional,/ARTIFACT_ENCRYPTION_KEY|must-not-copy|^DATABASE_URL=/m);
    assert.match(optional,/BENCHMARK_INTERVAL_SECONDS=300/);
    assert.match(readFileSync(join(dir,'control-plane-worker.env'),'utf8'),/PROBES_SEPARATED=true/);
    assert.doesNotMatch(readFileSync(join(dir,'before-probes-isolation-20261006/control-plane-worker.env'),'utf8'),/PROBES_SEPARATED/);
    assert.equal(statSync(join(dir,'probes-worker.env')).mode&0o777,0o600);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('cutover has automatic runtime rollback and refreshes only disposable target queue',()=>{
  execFileSync('bash',['-n',new URL('./cutover-probes-runtime',import.meta.url).pathname]);
  const cutover=read('./cutover-probes-runtime');
  assert.match(cutover,/trap rollback_on_failure EXIT/);
  assert.doesNotMatch(cutover,/DELETE FROM|TRUNCATE/);
  const copy=read('./copy-probes-data.mjs');
  assert.match(copy,/destination!=='hyperspace_probes'/);
  assert.match(copy,/await probes.query\('TRUNCATE/);
  assert.doesNotMatch(copy,/await core.query\(['`]TRUNCATE/);
});
test('all isolation/recovery helpers have valid syntax; probe deployment does not restart core',()=>{
  for(const file of ['./protect-probes-volume','./finalize-core-isolation','./check-production-probes-isolation','./hyperspace-pg-restore-check','../control-plane/restart-probes-after-migrations']) {
    execFileSync('bash',['-n',new URL(file,import.meta.url).pathname]);
  }
  const optional=read('../control-plane/restart-probes-after-migrations');
  assert.doesNotMatch(optional,/systemctl (stop|restart).*control-plane/);
  assert.match(optional,/migrate-probes\.js/);
});
