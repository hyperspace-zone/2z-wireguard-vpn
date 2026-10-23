// Read production connection settings, but operate ONLY on session-local temporary
// tables. No public schema objects or production records are read or changed.
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const source = readFileSync(new URL('./hyperspace-pg-history-archive', import.meta.url), 'utf8');
const definition = name => source.slice(source.indexOf(`${name}() {`), source.indexOf('\n}\n', source.indexOf(`${name}() {`)) + 3);
const root = mkdtempSync(join(tmpdir(), 'hs-archive-guard-'));
try {
  const row = {id:'00000000-0000-0000-0000-000000000001',job_id:'00000000-0000-0000-0000-000000000010',completed_at:'2026-09-21T12:00:00+00:00',details:'archived'};
  const changed = {...row,id:'00000000-0000-0000-0000-000000000002'};
  const data = execFileSync('zstd',['-q','-c'],{input:JSON.stringify(row)+'\n'+JSON.stringify(changed)+'\n'});
  writeFileSync(join(root,'job_attempts.jsonl.zst'), data);
  writeFileSync(join(root,'job_attempts.jsonl.zst.sha256'),createHash('sha256').update(data).digest('hex')+'  job_attempts.jsonl.zst\n');
  const setup = `SET search_path=pg_temp;
    CREATE TEMP TABLE jobs(id uuid PRIMARY KEY,type text);
    CREATE TEMP TABLE job_attempts(id uuid PRIMARY KEY,job_id uuid,completed_at timestamptz,details text);
    INSERT INTO jobs VALUES ('${row.job_id}','deploy_agent');
    INSERT INTO job_attempts VALUES
    ('${row.id}','${row.job_id}','2026-09-21T12:00:00Z','archived'),
    ('${changed.id}','${row.job_id}','2026-09-21T12:00:00Z','changed-after-export'),
    ('00000000-0000-0000-0000-000000000003','${row.job_id}','2026-09-21T12:00:00Z','never-archived');
  `;
  const wrapper = join(root,'psql.mjs');
  writeFileSync(wrapper, `import {readFileSync}from'node:fs';import{spawnSync}from'node:child_process';
const sql=${JSON.stringify(setup)}+readFileSync(0,'utf8')+"SELECT count(*) FROM job_attempts;";
const p=spawnSync('psql',['-X','-q','-t','-A','-v','ON_ERROR_STOP=1','-d',process.env.PGDATABASE??'hyperspace'],{input:sql,encoding:'utf8'});
if(p.status!==0){console.error('temporary-table SQL check failed');process.exit(1);}process.stdout.write(p.stdout);`);
  const harness = `set -Eeuo pipefail
psql_base=(node '${wrapper}')
delete_batch_size=1000
${['dataset_condition','dataset_table_and_time','period_condition','delete_archived_core_batch'].map(definition).join('\n')}
delete_archived_core_batch core_job_attempts '2026-09-21 00:00:00+00' '2026-09-22 00:00:00+00' '${root}'`;
  const output = execFileSync('bash',['-c',harness],{encoding:'utf8'}).trim();
  assert.equal(output,'1\n2','Only the unchanged archived row can be deleted; changed/new rows must survive');
  console.log('PASS: exact archived row removed; modified and unarchived rows preserved; temporary tables only.');
} finally {rmSync(root,{recursive:true,force:true});}
