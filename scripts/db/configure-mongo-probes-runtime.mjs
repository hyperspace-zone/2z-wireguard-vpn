import {readFileSync,writeFileSync,copyFileSync,mkdirSync,chmodSync} from 'node:fs';
const root=process.env.HS_RUNTIME_ENV_DIR??'/etc/hyperspace';
const parse=file=>Object.fromEntries(readFileSync(file,'utf8').split('\n').filter(line=>/^[A-Z_][A-Z0-9_]*=/.test(line)).map(line=>{const i=line.indexOf('=');return[line.slice(0,i),line.slice(i+1)];}));
// Validate every file before changing any of them. Never write a Mongo URL to
// the core worker, or silently fall back to core for probes workloads.
const files=['control-plane-api','probes-worker'].map(name=>`${root}/${name}.env`);
for(const file of files) if(!parse(file).MEASUREMENTS_MONGO_URL) throw new Error('Mongo credentials must already be installed in API and probes worker');
if(!parse(files[1]).PROBES_CATALOG_DATABASE_URL) throw new Error('Read-only catalog URL required');
if(parse(`${root}/control-plane-worker.env`).PROBES_SEPARATED!=='true') throw new Error('Core worker must already have isolated probes');
const backup=`${root}/before-mongo-probes-${new Date().toISOString().replace(/[:.]/g,'-')}`;
mkdirSync(backup,{mode:0o700});
for(const [i,file] of files.entries()){
  copyFileSync(file,`${backup}/${i}.env`);chmodSync(`${backup}/${i}.env`,0o600);
  const lines=readFileSync(file,'utf8').split('\n').filter(line=>!/^PROBES_(BACKEND|DATABASE_URL)=/.test(line));
  writeFileSync(file,`${lines.join('\n').trimEnd()}\nPROBES_BACKEND=mongodb\n`,{mode:0o600});chmodSync(file,0o600);
}
console.log(`Mongo probes enabled; SQL probes URL removed from runtime. Protected rollback env: ${backup}`);
