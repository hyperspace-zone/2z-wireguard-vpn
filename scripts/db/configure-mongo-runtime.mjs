import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
const root=process.env.HS_RUNTIME_ENV_DIR??'/etc/hyperspace';
const parse=file=>Object.fromEntries(readFileSync(file,'utf8').split('\n').filter(line=>/^[A-Z_][A-Z0-9_]*=/.test(line)).map(line=>{const i=line.indexOf('=');return[line.slice(0,i),line.slice(i+1)];}));
const credentials=parse(`${root}/measurements-mongo.env`);
for(const key of ['MEASUREMENTS_MONGO_URL','MEASUREMENTS_MONGO_CA_FILE'])if(!credentials[key])throw new Error(`Missing ${key}`);
if(!credentials.MEASUREMENTS_MONGO_URL.startsWith('mongodb'))throw new Error('Invalid Mongo configuration');
const backup=`${root}/before-mongo-${new Date().toISOString().replace(/[:.]/g,'-')}`;
mkdirSync(backup,{mode:0o700});
for(const name of ['control-plane-api','probes-worker']){
  const file=`${root}/${name}.env`;
  if(!parse(file).PROBES_DATABASE_URL)throw new Error('Only isolated probes deployments can use Mongo');
  copyFileSync(file,`${backup}/${name}.env`);
  const original=readFileSync(file,'utf8').split('\n').filter(line=>!Object.keys(credentials).some(key=>line.startsWith(key+'=')));
  writeFileSync(file,original.join('\n').trimEnd()+'\n'+Object.entries(credentials).map(([k,v])=>`${k}=${v}`).join('\n')+'\n',{mode:0o600});
}
console.log(`Mongo configured only for API/probes worker; original env retained at ${backup}`);
