import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
const root = process.env.HS_RUNTIME_ENV_DIR ?? '/etc/hyperspace';
const parse = file => Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter(line => /^[A-Z_][A-Z0-9_]*=/.test(line)).map(line => [line.slice(0,line.indexOf('=')),line.slice(line.indexOf('=')+1)]));
const credentials = parse(`${root}/probes-instance.env`);
for (const name of ['PROBES_DATABASE_URL','PROBES_CATALOG_DATABASE_URL']) {
  if (!credentials[name]) throw new Error(`Missing ${name}`);
}
const worker = parse(`${root}/control-plane-worker.env`);
const backupDir = `${root}/before-probes-isolation-20261006`;
mkdirSync(backupDir,{recursive:true,mode:0o700});
function update(name,values) {
  const file=`${root}/${name}.env`;
  if(!existsSync(`${backupDir}/${name}.env`))copyFileSync(file,`${backupDir}/${name}.env`);
  const original=readFileSync(file,'utf8').split('\n').filter(line=>!Object.keys(values).some(key=>line.startsWith(`${key}=`)));
  writeFileSync(file,`${original.join('\n').trimEnd()}\n${Object.entries(values).map(([k,v])=>`${k}=${v}`).join('\n')}\n`,{mode:0o600});
}
update('control-plane-api',{PROBES_DATABASE_URL:credentials.PROBES_DATABASE_URL,BENCHMARK_DATABASE_STATEMENT_TIMEOUT_MS:'3000'});
update('control-plane-worker',{PROBES_SEPARATED:'true'});
const optional=Object.fromEntries(Object.entries(worker).filter(([key])=>key.startsWith('BENCHMARK_')||key.startsWith('NTP_DISCOVERY_')||key==='TRADING_PROBES_ENABLED'));
writeFileSync(`${root}/probes-worker.env`,Object.entries({...optional,...credentials,PROBES_OBSERVABILITY_HOST:process.env.PROBES_OBSERVABILITY_HOST??'127.0.0.1',PROBES_OBSERVABILITY_PORT:'9092'}).map(([k,v])=>`${k}=${v}`).join('\n')+'\n',{mode:0o600});
console.log('Separate runtime configured; credentials were not printed. Original core env files retained.');
