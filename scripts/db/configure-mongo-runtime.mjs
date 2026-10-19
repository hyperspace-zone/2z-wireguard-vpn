import { readFileSync, writeFileSync, copyFileSync, mkdirSync, chmodSync } from 'node:fs';
const root=process.env.HS_RUNTIME_ENV_DIR??'/etc/hyperspace';
const parse=file=>Object.fromEntries(readFileSync(file,'utf8').split('\n').filter(line=>/^[A-Z_][A-Z0-9_]*=/.test(line)).map(line=>{const i=line.indexOf('=');return[line.slice(0,i),line.slice(i+1)];}));
const credentials=parse(`${root}/measurements-mongo.env`);
const keys=['MEASUREMENTS_MONGO_URL','MEASUREMENTS_MONGO_CA_FILE'];
if(!/^mongodb(?:\+srv)?:\/\//.test(credentials.MEASUREMENTS_MONGO_URL??''))throw new Error('Invalid Mongo configuration');
if(!credentials.MEASUREMENTS_MONGO_URL.startsWith('mongodb+srv://')&&!credentials.MEASUREMENTS_MONGO_CA_FILE)throw new Error('Self-hosted Mongo requires MEASUREMENTS_MONGO_CA_FILE');
// Atlas SRV uses public CA trust. Remove a stale self-hosted CA even when the
// new credentials file deliberately omits it. Copy no unrelated env keys.
const values=keys.filter(key=>credentials[key]).map(key=>`${key}=${credentials[key]}`);
const files=['control-plane-api','probes-worker'].map(name=>({name,file:`${root}/${name}.env`}));
for(const {file} of files){
  const runtime=parse(file);
  if(!runtime.PROBES_DATABASE_URL && runtime.PROBES_BACKEND!=='mongodb')throw new Error('Only isolated probes deployments can use Mongo');
}
const backup=`${root}/before-mongo-${new Date().toISOString().replace(/[:.]/g,'-')}`;
mkdirSync(backup,{mode:0o700});
for(const {name,file} of files){
  copyFileSync(file,`${backup}/${name}.env`);
  chmodSync(`${backup}/${name}.env`,0o600);
  const original=readFileSync(file,'utf8').split('\n').filter(line=>!keys.some(key=>line.startsWith(key+'=')));
  writeFileSync(file,original.join('\n').trimEnd()+'\n'+values.join('\n')+'\n',{mode:0o600});
  chmodSync(file,0o600);
}
console.log(`Mongo configured only for API/probes worker; original env retained at ${backup}`);
