import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { configSchema } from '../server/config.js';
import { connectPaseo, connectPaseoDriver } from '../server/paseo.js';
import { transport } from '../server/herdr.js';

const execute=promisify(execFile);
const root=resolve(import.meta.dirname,'..');
const wire=JSON.parse(await readFile(join(root,'.dev/claude-wire-evidence.json'),'utf8'));
const original=wire.evidence[0];
const home='/private/tmp/hpc-'+process.getuid!()+'/paseo';
const cwd=join(root,'.dev/workspace');
const proxy=join(root,'dist/scripts/claude-proxy.js');await chmod(proxy,0o755);
await mkdir(home,{recursive:true,mode:0o700});
const env:NodeJS.ProcessEnv={...process.env};for(const key of ['PASEO_HOST','PASEO_PASSWORD','PASEO_LISTEN','PORT'])delete env[key];
const set=(key:string,value:string)=>execute('paseo',['daemon','config','set',key,value,'--home',home],{env,timeout:30000});
await set('daemon.listen','127.0.0.1:6797');await set('daemon.relay.enabled','false');
await set('agents.providers',JSON.stringify({...Object.fromEntries(['codex','pi','copilot','opencode','omp'].map(name=>[name,{enabled:false}])),
 claude:{enabled:true,command:[proxy],env:{HERDR_BRIDGE_CLAUDE_SOCKET:wire.socket}}}));
const server=spawn('paseo',['daemon','run','--home',home],{env,cwd:root,stdio:'ignore',detached:true});server.unref();
const config=configSchema.parse({herdr:[{name:'claude-native-development',socket:wire.herdrSocket}],transcriptRoots:{codex:'/tmp/unused',claude:'/tmp/unused'},
 paseoHome:home,paseoUrl:'ws://127.0.0.1:6797/ws',packageRoot:root,workspaceRoots:[cwd],autoRegister:false});
let client:Awaited<ReturnType<typeof connectPaseo>>|undefined;
for(let attempt=0;;attempt++){try{client=await connectPaseo(config);break}catch(e){if(attempt>50)throw e;await delay(300)}}
const driver=await connectPaseoDriver(config);
try{
 const imported=await driver.importAgent({provider:'claude',sessionId:original.nativeSessionId,cwd,labels:{'herdr.claude-native-proof':'true'}});
 assert.equal(imported.provider,'claude');
 const agent=client.agents.ref(imported.id);
 const marker='HPB_PASEO_NATIVE_CLAUDE_'+Date.now().toString(36).toUpperCase();
 const streams:string[]=[];const sub=agent.timeline.subscribe(event=>{if('event'in event)streams.push(event.event.type)});await sub.ready;
 const result=await agent.run('Use the Read tool to read only README.md in the current directory. Do not read other files, execute commands or change anything. Then reply exactly '+marker+'.',{timeoutMs:90000});
 sub();
 assert.equal(result.status,'idle');assert.ok(result.lastMessage?.includes(marker));
 const state=(await agent.refresh())!.agent;
 assert.equal(state.provider,'claude');assert.equal(state.persistence?.sessionId,original.nativeSessionId);
 const metadata=JSON.parse(await readFile(wire.socket+'.json','utf8'));assert.equal(metadata.enginePid,original.enginePid);
 const timeline=await agent.timeline.refetch({limit:200});
 const tools=timeline.entries.map(x=>x.item).filter(x=>x.type==='tool_call');
 assert.ok(tools.some(x=>x.detail?.type==='read'&&x.status==='completed'),'Missing native Read card');
 const processes=await transport.request<any>(wire.herdrSocket,'pane.process_info',{pane_id:original.pane});
 assert.ok(processes.process_info.foreground_processes.some((x:any)=>x.pid===original.enginePid),'Original Claude executor is no longer owned by the Herdr terminal');
 const evidence={provider:state.provider,model:state.model,paseoAgentId:state.id,nativeSessionId:original.nativeSessionId,enginePid:original.enginePid,pane:original.pane,
  herdrSocket:wire.herdrSocket,socket:wire.socket,paseoHome:home,paseoUrl:config.paseoUrl,typedToolCards:tools.map(x=>x.detail?.type),nativeStreamTypes:[...new Set(streams)],marker};
 await writeFile(join(root,'.dev/claude-paseo-evidence.json'),JSON.stringify(evidence,null,2)+'\n');
 console.log('PASS: builtin Paseo Claude renders original SDK session, streaming and native Read card; original Herdr-owned Claude PID is unchanged.');
 console.log(JSON.stringify({paseoAgentId:state.id,provider:state.provider,model:state.model,pane:original.pane,port:6797}));
}finally{await driver.close();await client.close();}
