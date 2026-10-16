import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const read=path=>readFileSync(new URL(path,import.meta.url),'utf8');
test('Mongo probes cutover protects core and imports only bounded synthetic work',()=>{
  const migrate=read('./migrate-probe-queue-mongo.mjs');
  assert.match(migrate,/REPEATABLE READ, READ ONLY/);assert.match(migrate,/hyperspace_probes/);
  assert.match(migrate,/Stop \$\{service\}/);assert.match(migrate,/10001/);
  assert.doesNotMatch(migrate,/DELETE FROM|TRUNCATE|DROP TABLE/);
  const deploy=read('../control-plane/deploy-mongo-probes');
  assert.match(deploy,/previous-runtime/);assert.match(deploy,/trap on_exit EXIT/);
  assert.match(deploy,/--execute/);assert.match(deploy,/readlink -f/);
  assert.match(deploy,/--upgrade/);assert.match(deploy,/grep -qx PROBES_BACKEND=mongodb/);
  assert.doesNotMatch(deploy,/systemctl (?:stop|restart) hyperspace-control-plane-worker/);
});

test('live Mongo outage drill includes a host-local failsafe and automatic recovery acceptance',()=>{
  const drill=read('./check-mongo-probes-isolation');
  assert.match(drill,/--on-active=60s/);assert.match(drill,/trap restore EXIT/);
  assert.match(drill,/verify-mongo-probes.mjs --require-new-results/);
  assert.doesNotMatch(drill,/systemctl (?:stop|restart) hyperspace-control-plane-worker/);
  assert.equal(spawnSync('bash',['-n',new URL('./check-mongo-probes-isolation',import.meta.url).pathname]).status,0);
});
test('Mongo probes configuration removes only probes SQL credentials, preserving core and unrelated secrets',()=>{
  const dir=mkdtempSync(join(tmpdir(),'hs-mongo-probes-env-'));
  try{
    const api='DATABASE_URL=postgres://core\nPROBES_DATABASE_URL=postgres://probes\nMEASUREMENTS_MONGO_URL=mongodb://example.invalid/db\nUNCHANGED=secret\n';
    const probes='PROBES_DATABASE_URL=postgres://probes\nPROBES_CATALOG_DATABASE_URL=postgres://readonly\nMEASUREMENTS_MONGO_URL=mongodb://example.invalid/db\n';
    const core='DATABASE_URL=postgres://core\nPROBES_SEPARATED=true\n';
    for(const [name,value] of [['control-plane-api',api],['probes-worker',probes],['control-plane-worker',core]])writeFileSync(join(dir,`${name}.env`),value);
    const result=spawnSync(process.execPath,[new URL('./configure-mongo-probes-runtime.mjs',import.meta.url).pathname],{env:{...process.env,HS_RUNTIME_ENV_DIR:dir},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    const changed=readFileSync(join(dir,'control-plane-api.env'),'utf8');
    assert.match(changed,/PROBES_BACKEND=mongodb/);assert.doesNotMatch(changed,/PROBES_DATABASE_URL/);
    assert.match(changed,/DATABASE_URL=postgres:\/\/core/);assert.match(changed,/UNCHANGED=secret/);
    assert.equal(readFileSync(join(dir,'control-plane-worker.env'),'utf8'),core);
    assert.doesNotMatch(result.stdout,/secret|mongodb:\/\//);
    const legacy=spawnSync(process.execPath,[new URL('./configure-probes-runtime.mjs',import.meta.url).pathname],{env:{...process.env,HS_RUNTIME_ENV_DIR:dir},encoding:'utf8'});
    assert.notEqual(legacy.status,0);assert.match(legacy.stderr,/refusing to restore the retired SQL backend/);
    assert.equal(readFileSync(join(dir,'control-plane-api.env'),'utf8'),changed);
    writeFileSync(join(dir,'measurements-mongo.env'),'MEASUREMENTS_MONGO_URL=mongodb://rotated.invalid/db\nMEASUREMENTS_MONGO_CA_FILE=/etc/hyperspace/ca.crt\n');
    const rotate=spawnSync(process.execPath,[new URL('./configure-mongo-runtime.mjs',import.meta.url).pathname],{env:{...process.env,HS_RUNTIME_ENV_DIR:dir},encoding:'utf8'});
    assert.equal(rotate.status,0,rotate.stderr);
    const rotated=readFileSync(join(dir,'control-plane-api.env'),'utf8');
    assert.match(rotated,/rotated.invalid/);assert.match(rotated,/PROBES_BACKEND=mongodb/);assert.doesNotMatch(rotated,/PROBES_DATABASE_URL/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
