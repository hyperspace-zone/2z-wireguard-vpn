import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root=process.cwd();
const output=process.argv[2];
if(!output?.startsWith('/tmp/hyperspace-mongo-release-')||!output.endsWith('.tar.gz'))throw new Error('An explicit /tmp/hyperspace-mongo-release-*.tar.gz output is required');
const seen=new Set();
function locate(name,from){
  let dir=from;
  while(true){const candidate=join(dir,'node_modules',name);if(existsSync(join(candidate,'package.json')))return candidate;
    const parent=dirname(dir);if(parent===dir)throw new Error(`Missing dependency: ${name}`);dir=parent;}
}
function visit(name,from){
  const dir=locate(name,from);
  if(!dir.startsWith(resolve(root,'node_modules')+'/'))throw new Error('Dependency resolves outside repository');
  if(seen.has(dir))return;seen.add(dir);
  const pkg=JSON.parse(readFileSync(join(dir,'package.json')));
  for(const dependency of Object.keys(pkg.dependencies??{}))visit(dependency,dir);
}
visit('mongodb',root);
// The staged schedule seeder imports PostgreSQL before any live files change.
visit('pg',root);
const entries=[...seen].map(dir=>relative(root,dir));
entries.push('node_modules/@hyperspace-zone');
for(const name of ['db','contracts','shared','control-plane'])entries.push(`packages/${name}/dist`,`packages/${name}/package.json`);
for(const name of ['control-plane-api','control-plane-worker'])entries.push(`apps/${name}/dist`,`apps/${name}/package.json`);
entries.push('packages/db/probes-migrations','scripts/db/configure-mongo-runtime.mjs','scripts/db/cutover-mongo-runtime','scripts/db/copy-measurements-mongo.mjs','scripts/db/seed-mongo-schedule.mjs','package-lock.json');
const result=spawnSync('tar',['-czf',output,...entries],{stdio:'inherit'});
if(result.status!==0)throw new Error('Runtime packaging failed');
console.log(`Packaged ${seen.size} dependency locations, including nested dependency versions.`);
