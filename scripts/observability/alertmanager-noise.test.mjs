import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {readFileSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import test from 'node:test';
const repo = new URL('../../',import.meta.url).pathname;

test('production routing is exclusive and inhibition preserves real outages and other clusters', async () => {
  const root=mkdtempSync(join(tmpdir(),'hs-alert-policy-'));
  let child;
  try {
    const config=join(root,'alertmanager.yml');
    const rendered=execFileSync('bash',[repo+'scripts/render-alertmanager-telegram-config',
      '--receivers',repo+'infra/observability/alertmanager/telegram-receivers.example.json',
      '--template-glob',repo+'infra/observability/alertmanager/templates/*.tmpl'],{encoding:'utf8'});
    // This isolated Alertmanager has named receivers but NO external transports.
    let skip=false;
    const isolated=rendered.split('\n').filter(line=>{
      if(line==='    telegram_configs:'){skip=true;return false;}
      if(skip && (/^  - name:/.test(line)||/^\S/.test(line)))skip=false;
      return !skip;
    }).join('\n');
    writeFileSync(config,isolated);
    execFileSync('amtool',['check-config',config]);
    for(const [name,severity,receiver]of [
      ['HyperspacePostgreSQLHistoryArchiveFailed','critical','hyperspace-telegram-critical'],
      ['HyperspaceEnabledGateAgentDisconnected','critical','hyperspace-telegram-critical'],
      ['HyperspaceControlPlaneApiDown','critical','hyperspace-telegram-critical'],
      ['HyperspaceHeliusUsagePollFailed','warning','hyperspace-telegram-default']]){
      execFileSync('amtool',['config','routes','test','--config.file='+config,'--verify.receivers='+receiver,'alertname='+name,'severity='+severity]);
    }
    const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const port=server.address().port;await new Promise(r=>server.close(r));
    child=spawn('prometheus-alertmanager',['--config.file='+config,'--storage.path='+join(root,'data'),'--web.listen-address=127.0.0.1:'+port,'--cluster.listen-address='],{stdio:'ignore'});
    const url='http://127.0.0.1:'+port;
    for(let i=0;i<80;i++){try{if((await fetch(url+'/-/ready')).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
    const mk=(alertname,extra={})=>({labels:{alertname,cluster:'mainnet',service_host:'obs',instance:'worker',...extra},startsAt:new Date().toISOString(),endsAt:new Date(Date.now()+120000).toISOString()});
    const alerts=[
      mk('HyperspacePostgreSQLHistoryArchiveFailed'), mk('HyperspacePostgreSQLHistoryArchiveStale'),
      mk('HyperspacePostgreSQLHistoryArchiveStale',{service_host:'other'}),
      mk('HyperspaceHeliusUsageDataStale'),mk('HyperspaceHeliusUsagePollFailed'),
      mk('HyperspaceMeasurementsMongoUnavailable'),mk('HyperspaceTradingTargetDataStale'),
      mk('HyperspaceBenchmarkRouteDataStale'),mk('HyperspacePublicMeasurementSnapshotStale'),
      mk('HyperspaceTradingTargetDataStale',{cluster:'testnet'}),
      mk('HyperspaceEnabledGateAgentDisconnected'),mk('HyperspaceControlPlaneApiDown')];
    assert.equal((await fetch(url+'/api/v2/alerts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(alerts)})).status,200);
    let received=[];
    for(let i=0;i<80;i++){
      received=await(await fetch(url+'/api/v2/alerts?active=true&inhibited=true&silenced=true')).json();
      if(received.length===alerts.length && received.filter(a=>a.status.inhibitedBy.length).length===5)break;
      await new Promise(r=>setTimeout(r,50));
    }
    assert.equal(received.filter(a=>a.status.inhibitedBy.length).length,5);
    for(const a of received.filter(a=>/AgentDisconnected|ApiDown/.test(a.labels.alertname)||a.labels.cluster==='testnet'||a.labels.service_host==='other'))assert.equal(a.status.inhibitedBy.length,0);
    // Recovery of root failures must make their unresolved symptoms visible again.
    const recovered=alerts.filter(a=>/ArchiveFailed|UsageDataStale|MongoUnavailable/.test(a.labels.alertname)).map(a=>({...a,startsAt:new Date(Date.now()-60000).toISOString(),endsAt:new Date(Date.now()-1000).toISOString()}));
    await fetch(url+'/api/v2/alerts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(recovered)});
    for(let i=0;i<80;i++){
      received=await(await fetch(url+'/api/v2/alerts?active=true&inhibited=true&silenced=true')).json();
      if(received.every(a=>a.status.inhibitedBy.length===0))break;
      await new Promise(r=>setTimeout(r,50));
    }
    assert.ok(received.every(a=>a.status.inhibitedBy.length===0));
    assert.match(rendered,/repeat_interval: 12h/);
    assert.match(rendered,/repeat_interval: 4h/);
  } finally {
    if(child && child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}
    rmSync(root,{recursive:true,force:true});
  }
});
