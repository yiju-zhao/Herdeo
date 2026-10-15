import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { readConfig } from '../server/config.js';
import { connectPaseo } from '../server/paseo.js';
import { loadClaudeRoute } from '../server/claude-native.js';
import { transport } from '../server/herdr.js';

const execute=promisify(execFile);const root=resolve(import.meta.dirname,'..');
const config=readConfig(join(root,'.dev/claude-native.json'));
if(config.paseoUrl!=='ws://127.0.0.1:6797/ws'||!config.paseoHome.startsWith('/private/tmp/hpc-'))throw Error('Restart is limited to the independent Claude test instance');
const proof=JSON.parse(await readFile(join(root,'.dev/claude-native-evidence.json'),'utf8'));
const route=await loadClaudeRoute(config,proof.paseoAgentId);assert.ok(route);
let client=await connectPaseo(config);
const before=(await client.agents.ref(proof.paseoAgentId).refresh())!.agent;assert.equal(before.status,'idle');
await client.close();
await execute('paseo',['daemon','restart','--home',config.paseoHome],{env:{...process.env,HERDR_BRIDGE_CONFIG:join(root,'.dev/claude-native.json')},timeout:60000});
for(let i=0;;i++){try{client=await connectPaseo(config);break}catch(e){if(i>40)throw e;await delay(300)}}
try{
 const agent=client.agents.ref(proof.paseoAgentId);
 const timeline=await agent.timeline.refetch({limit:200});
 for(const marker of proof.markers)assert.ok(timeline.entries.some(x=>x.item.type==='assistant_message'&&x.item.text.includes(marker)),'Native history not restored');
 const marker='HPB_CLAUDE_RESTART_'+Date.now().toString(36).toUpperCase();
 const result=await agent.run('Reply exactly '+marker+'. Do not use tools, read files or change anything.',{timeoutMs:90000});
 assert.equal(result.status,'idle');assert.ok(result.lastMessage?.includes(marker));
 const current=(await agent.refresh())!.agent;
 assert.equal(current.provider,'claude');assert.equal(current.persistence?.sessionId,proof.nativeSessionId);
 assert.equal(JSON.parse(await readFile(route.socket+'.json','utf8')).enginePid,proof.enginePid);
 const info=await transport.request<any>(route.herdrSocket,'pane.process_info',{pane_id:route.pane});
 assert.ok(info.process_info.foreground_processes.some((p:any)=>p.pid===proof.enginePid));
 await writeFile(join(root,'.dev/claude-native-evidence.json'),JSON.stringify({...proof,restartPreservesPidAndSession:true,historyRestored:true,restartMarker:marker},null,2)+'\n');
 console.log('PASS: restarting test Paseo restores native Claude history and sends a new turn to the original Herdr-owned PID/session.');
}finally{await client.close();}
