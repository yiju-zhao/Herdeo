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

const base=join(homedir(),'.hb'),config=readConfig(join(base,'config.json')),execute=promisify(execFile);
assert.equal(new URL(config.paseoUrl).port,'6795');assert.equal(config.paseoHome,join(base,'paseo'));
const bins=JSON.parse(await readFile(join(base,'executables.json'),'utf8'));
const client=await connectPaseo(config),cwd=join(base,'workspace');
const evidence:any[]=[];
try{
 const workspace=await client.workspaces.open(cwd);await workspace.setTitle(hostname()+' · 共享 agent 验证');
 for(const kind of (process.argv[2]?[process.argv[2]]:['codex','claude','pi'])){
  let model=kind==='codex'?'gpt-6.1-sol':kind==='claude'?config.launch.claudeModel:config.launch.piModel;
  const catalog=await client.providers.listModels(kind as any,{cwd});
  const models=catalog.models??[];
  if(!model||model==='unknown/unknown'||!models.some(m=>m.id===model))model=models.find(m=>m.isDefault)?.id??models[0]?.id;
  assert.ok(model,'No available model for '+kind);
  const agent=await workspace.agents.create({config:{provider:kind+'/'+model},title:kind+' · 双向接手验证'});
  const route=kind==='codex'?await loadRoute(config,agent.id):kind==='claude'?await loadClaudeRoute(config,agent.id):await loadPiRoute(config,agent.id);
  assert.ok(route,'No Herdr route for '+kind);
  console.log(JSON.stringify({phase:'created',provider:kind,paseoAgentId:agent.id,pane:route.pane,model}));
  const marker='HB_PASEO_'+kind.toUpperCase()+'_'+Date.now().toString(36).toUpperCase();
  const reply=await agent.run('Reply exactly '+marker+'. Do not use tools, read files, change anything, or explain.',{timeoutMs:120000});
  assert.equal(reply.status,'idle',kind+' did not complete its Paseo-origin test');assert.ok(reply.lastMessage?.includes(marker),kind+' returned the wrong reply');
  const initial=(await agent.refresh())!.agent;
  const pid=kind==='codex'?(route as any).pid:JSON.parse(await readFile(route.socket+'.json','utf8')).enginePid;
  const readPane=async()=>execute(bins.herdr,['pane','read',route.pane,'--source','recent-unwrapped','--lines','150'],{env:{...process.env,HERDR_ENV:'1',HERDR_SOCKET_PATH:route.herdrSocket},timeout:15000});
  const screen=await readPane();assert.ok(screen.stdout.includes(marker),'Paseo-origin message/reply not visible in Herdr for '+kind);
  const next='HB_HERDR_'+kind.toUpperCase()+'_'+Date.now().toString(36).toUpperCase();
  const sub=agent.timeline.subscribe(()=>{});await sub.ready;
  await execute(bins.herdr,['pane','run',route.pane,'Reply exactly '+next+'. Do not use tools, read files or change anything.'],{env:{...process.env,HERDR_ENV:'1',HERDR_SOCKET_PATH:route.herdrSocket},timeout:15000});
  let terminalReply=false;
  for(let i=0;i<240;i++){
   const timeline=await agent.timeline.refetch({limit:150});
   if(timeline.entries.some(e=>e.item.type==='assistant_message'&&e.item.text.includes(next))){terminalReply=true;break;}
   await delay(500);
  }
  sub();assert.ok(terminalReply,'Herdr-origin message missing from native Paseo timeline for '+kind);
  const current=(await agent.refresh())!.agent;
  assert.equal(current.provider,kind);assert.equal(current.persistence?.sessionId,initial.persistence?.sessionId);
  const info=await transport.request<any>(route.herdrSocket,'pane.process_info',{pane_id:route.pane});assert.ok(info.process_info.foreground_processes.some((p:any)=>p.pid===pid));
  const afterScreen=await readPane();assert.ok(afterScreen.stdout.includes(next));
  evidence.push({provider:kind,model,paseoAgentId:agent.id,pane:route.pane,herdrSocket:route.herdrSocket,nativeSessionId:current.persistence?.sessionId,originalPid:pid,bidirectional:true,paseoMessageVisibleInHerdr:true,herdrMessageVisibleInPaseo:true,markers:[marker,next]});
  await writeFile(join(base,'verification.json'),JSON.stringify({host:hostname(),endpoint:config.paseoUrl,evidence},null,2)+'\n',{mode:0o600});
  console.log('PASS: '+kind+' uses one original executor, with both frontends reflecting both directions.');
 }
}finally{await client.close();}
