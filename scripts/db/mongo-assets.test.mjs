import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,statSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
test('Mongo provisioning enforces TLS/auth, kernel compatibility and limited resources',()=>{
  execFileSync('bash',['-n',new URL('./install-measurements-mongo',import.meta.url).pathname]);
  const script=read('./install-measurements-mongo');
  assert.match(script,/version_signature/);assert.match(script,/lt 7\.0\.14/);
  assert.match(script,/ufw allow from 5\.199\.161\.13/);
  assert.match(script,/Existing credentials: refusing bootstrap/);
  const config=read('../../infra/mongodb/measurements.conf');
  assert.match(config,/requireTLS/);assert.match(config,/authorization: enabled/);assert.match(config,/cacheSizeGB: 0\.5/);
  assert.match(read('../../infra/mongodb/limits.conf'),/MemoryMax=1536M/);
});
test('Mongo runtime configuration changes only optional measurement entrypoints and preserves rollback',()=>{
  const root=mkdtempSync(join(tmpdir(),'hs-mongo-env-'));
  const core='DATABASE_URL=core-secret\nBILLING_ENABLED=true\n';
  try{
    mkdirSync(join(root,'mongodb'));
    writeFileSync(join(root,'control-plane-worker.env'),core,{mode:0o600});
    for(const name of ['control-plane-api','probes-worker'])writeFileSync(join(root,name+'.env'),'PROBES_DATABASE_URL=probes\nUNCHANGED=yes\n',{mode:0o600});
    writeFileSync(join(root,'measurements-mongo.env'),'MEASUREMENTS_MONGO_URL=mongodb://test\nMEASUREMENTS_MONGO_CA_FILE=/test/ca\n',{mode:0o600});
    execFileSync(process.execPath,[new URL('./configure-mongo-runtime.mjs',import.meta.url).pathname],{env:{...process.env,HS_RUNTIME_ENV_DIR:root}});
    assert.equal(readFileSync(join(root,'control-plane-worker.env'),'utf8'),core);
    for(const name of ['control-plane-api','probes-worker']){
      const file=join(root,name+'.env');assert.match(readFileSync(file,'utf8'),/UNCHANGED=yes/);
      assert.match(readFileSync(file,'utf8'),/MEASUREMENTS_MONGO_URL=/);assert.equal(statSync(file).mode&0o777,0o600);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('Mongo deployment retains history and does not stop/restart core worker or PostgreSQL',()=>{
  const script=read('./cutover-mongo-runtime');execFileSync('bash',['-n',new URL('./cutover-mongo-runtime',import.meta.url).pathname]);
  assert.doesNotMatch(script,/systemctl (?:stop|restart)[^\n]*(?:control-plane-worker|postgresql)/);
  assert.doesNotMatch(script,/TRUNCATE|DROP|DELETE FROM/);assert.match(script,/rollback\/runtime/);
  assert.match(read('./package-mongo-runtime.mjs'),/visit\(dependency,dir\)/);
});
test('SQL measurement cleanup requires verification, a readable checkpoint and healthy retained delivery',()=>{
  const script=read('./finalize-mongo-measurements');execFileSync('bash',['-n',new URL('./finalize-mongo-measurements',import.meta.url).pathname]);
  assert.match(script,/--mongo-cutover-verified/);assert.match(script,/sha256sum --check/);assert.match(script,/pg_restore --list/);
  const sql=read('./finalize-mongo-measurements.sql');assert.match(sql,/current_database\(\)<>'hyperspace_probes'/);
  assert.match(sql,/EXISTS\(SELECT 1 FROM measurement_delivery_outbox WHERE created_at<now\(\)-interval '5 minutes'\)/);
  assert.match(sql,/TRUNCATE gate_benchmark_results,trading_latency_latest,trading_latency_rollups/);
  assert.doesNotMatch(sql,/TRUNCATE (?:users|sessions|jobs|measurement_delivery_outbox)/);
});
test('legacy measurement guards allow empty FK maintenance, but reject actual row writes',()=>{
  for (const file of ['./finalize-mongo-measurements.sql','./repair-mongo-measurement-guards.sql']) {
    const sql=read(file);
    assert.equal((sql.match(/FOR EACH ROW EXECUTE FUNCTION reject_legacy_measurement_write/g)||[]).length,3);
    assert.doesNotMatch(sql,/FOR EACH STATEMENT/);
  }
  const repair=read('./repair-mongo-measurement-guards.sql');
  assert.match(repair,/current_database\(\)<>'hyperspace_probes'/);
  assert.match(repair,/IF EXISTS\(SELECT 1 FROM gate_benchmark_results\)/);
  assert.doesNotMatch(repair,/TRUNCATE|DELETE FROM|DISABLE TRIGGER/);
});
