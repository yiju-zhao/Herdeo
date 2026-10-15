import {readFile,writeFile} from 'node:fs/promises';
import {homedir,hostname} from 'node:os';
import {join} from 'node:path';
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

const base=join(homedir(),'.hb'),file=join(base,'config.json'),cfg=readConfig(file),execute=promisify(execFile);
assert.equal(new URL(cfg.paseoUrl).port,'6795');
let client=await connectPaseo(cfg);
const originals:any[]=[];
try{
 const agents=await client.agents.list({filter:{includeArchived:false},page:{limit:100}});
 assert.ok(!agents.entries.some(e=>e.agent.status==='running'||e.agent.pendingPermissions?.length),'A live task or permission is pending; restart deferred');
 for(const {agent} of agents.entries.filter(e=>e.agent.cwd===join(base,'workspace'))){
  const route=agent.provider==='codex'?await loadRoute(cfg,agent.id):agent.provider==='claude'?await loadClaudeRoute(cfg,agent.id):agent.provider==='pi'?await loadPiRoute(cfg,agent.id):undefined;
  if(!route)continue;
  const pid=agent.provider==='codex'?(route as any).pid:JSON.parse(await readFile(route.socket+'.json','utf8')).enginePid;
  if(!pid)continue;
  const info=await transport.request<any>(route.herdrSocket,'pane.process_info',{pane_id:route.pane});
  if(!info.process_info.foreground_processes.some((p:any)=>p.pid===pid))continue;
  const state=(await client.agents.ref(agent.id).refresh())!.agent;
  originals.push({id:agent.id,provider:agent.provider,title:state.title,route,pid,nativeSessionId:state.persistence?.sessionId});
 }
}finally{await client.close();}
const bins=JSON.parse(await readFile(join(base,'executables.json'),'utf8'));
await execute(bins.paseo,['daemon','restart','--home',cfg.paseoHome],{env:{...process.env,HERDR_BRIDGE_CONFIG:file,PASEO_PASSWORD:(await readFile(cfg.paseoPasswordFile!,'utf8')).trim()},timeout:60000});
for(let i=0;;i++){try{client=await connectPaseo(cfg);break;}catch(error){if(i>60)throw error;await delay(300);}}
const checked=new Set<string>();
try{
 for(const old of originals){
  const info=await transport.request<any>(old.route.herdrSocket,'pane.process_info',{pane_id:old.route.pane});
  assert.ok(info.process_info.foreground_processes.some((p:any)=>p.pid===old.pid),'An original executor was lost during Paseo restart');
  if(checked.has(old.provider)||!old.nativeSessionId||old.title?.includes('问答接手验证'))continue;
  const agent=client.agents.ref(old.id),timeline=await agent.timeline.refetch({limit:200});
  assert.ok(timeline.entries.some(e=>e.item.type==='assistant_message'),'Native history missing after restart');
  const marker='HB_RECONNECTED_'+old.provider.toUpperCase()+'_'+Date.now().toString(36).toUpperCase();
  const result=await agent.run('Reply exactly '+marker+'. Do not use tools, read files or change anything.',{timeoutMs:120000});
  assert.equal(result.status,'idle');assert.ok(result.lastMessage?.includes(marker));
  const state=(await agent.refresh())!.agent;assert.equal(state.persistence?.sessionId,old.nativeSessionId);
  checked.add(old.provider);console.log('PASS: '+old.provider+' restores history and resumes on its original PID/session after Paseo restart.');
 }
 await writeFile(join(base,'reconnect-verification.json'),JSON.stringify({host:hostname(),providers:[...checked],originalExecutorsPreserved:originals.map(o=>({provider:o.provider,pid:o.pid,paseoAgentId:o.id,nativeSessionId:o.nativeSessionId})),paseoRestarted:true,herdrRestarted:false},null,2)+'\n',{mode:0o600});
}finally{await client.close();}
