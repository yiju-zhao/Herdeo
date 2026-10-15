import { readFile, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { readConfig } from '../server/config.js';
import { connectPaseo } from '../server/paseo.js';
import { loadClaudeRoute } from '../server/claude-native.js';
import { transport } from '../server/herdr.js';

const root=resolve(import.meta.dirname,'..');const config=readConfig(join(root,'.dev/claude-native.json'));
if(config.paseoUrl!=='ws://127.0.0.1:6797/ws'||!config.nativeClaude)throw Error('This check uses only the independent native Claude test host');
const client=await connectPaseo(config);
try{
 const workspace=await client.workspaces.open(config.workspaceRoots[0]!);
 const agent=await workspace.agents.create({config:{provider:'claude/claude-opus-5-5'},title:'Claude native validation'});
 const route=await loadClaudeRoute(config,agent.id);assert.ok(route);
 const marker='HPB_CLAUDE_CREATED_'+Date.now().toString(36).toUpperCase();
 const result=await agent.run('Reply exactly '+marker+'. Do not use tools, read files or change anything.',{timeoutMs:90000});
 assert.equal(result.status,'idle');assert.ok(result.lastMessage?.includes(marker));
 const state=(await agent.refresh())!.agent;assert.equal(state.provider,'claude');
 const metadata=JSON.parse(await readFile(route.socket+'.json','utf8'));assert.equal(metadata.sessionId,state.persistence?.sessionId);
 const before=await transport.request<any>(route.herdrSocket,'pane.process_info',{pane_id:route.pane});
 assert.ok(before.process_info.foreground_processes.some((p:any)=>p.pid===metadata.enginePid));
 const second='HPB_CLAUDE_TERMINAL_'+Date.now().toString(36).toUpperCase();
 const socket=createConnection(route.socket);const input=createInterface({input:socket});
 await new Promise<void>((ready,reject)=>{
  socket.once('connect',()=>socket.write(JSON.stringify({type:'bridge.attach',cwd:route.cwd,args:['--input-format','stream-json']})+'\n'));
  socket.once('error',reject);input.on('line',line=>{const frame=JSON.parse(line);if(frame.type==='bridge.ready')ready();});
 });
 const sub=agent.timeline.subscribe(()=>{});await sub.ready;
 const done=new Promise<void>((complete,reject)=>{
  const timeout=setTimeout(()=>reject(Error('Terminal-origin Claude turn timed out')),90000);
  input.on('line',line=>{const frame=JSON.parse(line);if(frame.type==='bridge.stdout'&&frame.message.type==='result'){clearTimeout(timeout);complete();}});
 });
 socket.write(JSON.stringify({type:'bridge.user',text:'Reply exactly '+second+'. Do not use tools, read files or change anything.'})+'\n');
 await done;socket.end();sub();
 const timeline=await agent.timeline.refetch({limit:200});
 assert.ok(timeline.entries.some(x=>x.item.type==='assistant_message'&&x.item.text.includes(second)),'Herdr-origin reply missing from native Paseo timeline');
 assert.equal(JSON.parse(await readFile(route.socket+'.json','utf8')).enginePid,metadata.enginePid);
 const after=await transport.request<any>(route.herdrSocket,'pane.process_info',{pane_id:route.pane});
 assert.equal(after.process_info.foreground_process_group_id,before.process_info.foreground_process_group_id);
 const proof={paseoAgentId:agent.id,provider:state.provider,model:state.model,nativeSessionId:metadata.sessionId,enginePid:metadata.enginePid,pane:route.pane,
  socket:route.socket,herdrSocket:route.herdrSocket,paseoHome:config.paseoHome,bidirectional:true,originalProcessGroupPreserved:true,markers:[marker,second]};
 await writeFile(join(root,'.dev/claude-native-evidence.json'),JSON.stringify(proof,null,2)+'\n');
 console.log('PASS: ordinary Paseo Claude creation opens a Herdr-owned executor; messages from both frontends render natively using one PID/session.');
 console.log(JSON.stringify({paseoAgentId:agent.id,provider:state.provider,model:state.model,pane:route.pane,port:6797}));
}finally{await client.close();}
