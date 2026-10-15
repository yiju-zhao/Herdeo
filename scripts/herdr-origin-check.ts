import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir,hostname} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {readConfig} from '../server/config.js';
import {connectPaseo} from '../server/paseo.js';
import {loadRoute} from '../server/codex-native.js';
import {loadClaudeRoute} from '../server/claude-native.js';
import {loadPiRoute} from '../server/pi-native.js';
import {transport} from '../server/herdr.js';

const base=join(homedir(),'.hb'),cfg=readConfig(join(base,'config.json')),execute=promisify(execFile);
assert.equal(new URL(cfg.paseoUrl).port,'6795');
const client=await connectPaseo(cfg),evidence:any[]=[];
try{
 for(const kind of (process.argv[2]?[process.argv[2]]:['codex','claude','pi'])){
  const started=JSON.parse((await execute(join(base,'bin/hb'),['start',kind,'--cwd',join(base,'workspace')],{timeout:20000})).stdout);
  let registered:any,route:any;
  for(let i=0;i<160&&!registered;i++){
   const agents=await client.agents.list({page:{limit:100}});
   for(const entry of agents.entries.filter(e=>e.agent.provider===kind&&!e.agent.archivedAt)){
    const candidate=kind==='codex'?await loadRoute(cfg,entry.agent.id):kind==='claude'?await loadClaudeRoute(cfg,entry.agent.id):await loadPiRoute(cfg,entry.agent.id);
    if(candidate&&candidate.pane===started.pane&&candidate.herdrSocket===cfg.herdr[0]!.socket){registered=entry.agent;route=candidate;break;}
   }
   if(!registered)await delay(400);
  }
  assert.ok(registered,'Herdr-started '+kind+' was not automatically registered');
  const agent=client.agents.ref(registered.id);
  const before=(await agent.refresh())!.agent;
  let pid=kind==='codex'?route.pid:undefined;
  for(let i=0;!pid&&i<100;i++){
   pid=JSON.parse(await readFile(route.socket+'.json','utf8')).enginePid;
   if(!pid)await delay(100);
  }
  assert.ok(pid,'The automatically registered executor did not initialize');
  const marker='HB_AUTO_'+kind.toUpperCase()+'_'+Date.now().toString(36).toUpperCase();
  const reply=await agent.run('Reply exactly '+marker+'. Do not use tools, read files or change anything.',{timeoutMs:120000});
  assert.equal(reply.status,'idle');assert.ok(reply.lastMessage?.includes(marker));
  const current=(await agent.refresh())!.agent;
  if(before.persistence?.sessionId)assert.equal(current.persistence?.sessionId,before.persistence.sessionId);
  if(kind!=='codex')assert.equal(current.persistence?.sessionId,JSON.parse(await readFile(route.socket+'.json','utf8')).sessionId);
  const info=await transport.request<any>(route.herdrSocket,'pane.process_info',{pane_id:route.pane});assert.ok(info.process_info.foreground_processes.some((p:any)=>p.pid===pid));
  evidence.push({provider:kind,paseoAgentId:agent.id,pane:route.pane,nativeSessionId:current.persistence?.sessionId,pid,automaticallyRegistered:true,originalExecutorPreserved:true});
  await writeFile(join(base,'herdr-origin-verification.json'),JSON.stringify({host:hostname(),evidence},null,2)+'\n',{mode:0o600});
  console.log('PASS: Herdr-started '+kind+' automatically registers natively and remains the original executor.');
 }
}finally{await client.close();}
