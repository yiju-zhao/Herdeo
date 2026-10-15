import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,chmod} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createConnection} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {configSchema} from '../server/config.js';
import {loadTuiSession,tuiRequest,type TuiSession} from '../server/tui-session.js';
import {readJsonLines} from '../server/jsonl.js';

test('the actual native host waits for extension initialization before delivering the first Paseo prompt',async()=>{
 const temp=await mkdtemp(join(process.platform==='darwin'?'/private/tmp':'/tmp','hb-tui-ready-')),root=resolve(import.meta.dirname,'..'),file=join(temp,'config.json');
 const fake=join(temp,'native-cli.mjs'),received=join(temp,'received.json');
 await writeFile(fake,`import {createConnection} from 'node:net';
setTimeout(()=>{
 const s=createConnection(process.env.HERDR_BRIDGE_TUI_SOCKET);let buffer='';
 s.once('connect',()=>s.write(JSON.stringify({type:'native.ready',pid:process.pid,state:{sessionId:'original-native-session',model:'test/model',models:[]}})+'\\n'));
 s.on('data',chunk=>{buffer+=chunk;for(;;){const i=buffer.indexOf('\\n');if(i<0)break;const f=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);if(f.type==='native.request'){
  import('node:fs/promises').then(fs=>fs.writeFile(${JSON.stringify(received)},JSON.stringify(f)));
  s.write(JSON.stringify({type:'native.response',id:f.id,result:{accepted:true}})+'\\n');
 }}});
},800);
`);
 const cfg=configSchema.parse({herdr:[{name:'fixture',socket:join(temp,'herdr.sock')}],transcriptRoots:{codex:temp,claude:temp},paseoHome:join(temp,'paseo'),paseoUrl:'ws://127.0.0.1:6795/ws',packageRoot:root,runtimeDirectory:join(temp,'run'),workspaceRoots:[temp],launch:{piCommand:process.execPath}});
 await writeFile(file,JSON.stringify(cfg));
 const child=spawn(process.execPath,['--import',import.meta.resolve('tsx'),join(root,'scripts/tui-host.ts'),'pi',fake],{cwd:temp,env:{...process.env,HERDR_BRIDGE_CONFIG:file,HERDR_BRIDGE_TUI_KEY:'fixture',HERDR_BRIDGE_TUI_REGISTER:'0',HERDR_PANE_ID:'w1:p1',HERDR_WORKSPACE_ID:'w1',HERDR_SOCKET_PATH:cfg.herdr[0]!.socket},stdio:['ignore','ignore','pipe']});
 const exited=new Promise<void>(done=>child.once('exit',()=>done()));let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
 try{
  let state;for(let i=0;i<100;i++){try{state=await loadTuiSession(cfg,'fixture');break;}catch{await delay(20);}}
  assert.ok(state,stderr);assert.equal(state.ready,false);
  const accepted=await tuiRequest(state,'prompt',{text:'first owner message',clientMessageId:'owner'});assert.ok(accepted.turnId);
  for(let i=0;i<50;i++){try{const request=JSON.parse(await readFile(received,'utf8'));assert.equal(request.params.text,'first owner message');return;}catch{await delay(10);}}
  assert.fail('The original native CLI did not receive the first prompt');
 }finally{child.kill('SIGTERM');await exited;await rm(temp,{recursive:true,force:true});}
});

test('native terminal denial returns Paseo to idle even when Claude emits no Stop hook',async()=>{
 const temp=await mkdtemp(join(process.platform==='darwin'?'/private/tmp':'/tmp','hb-tui-idle-')),root=resolve(import.meta.dirname,'..'),file=join(temp,'config.json');
 const fake=join(temp,'claude.mjs'),status=join(temp,'status.json');
 await writeFile(fake,`#!${process.execPath}
import {readFileSync,writeFileSync} from 'node:fs';import {createConnection} from 'node:net';
if(process.argv[2]==='agents'){console.log(readFileSync(${JSON.stringify(status)},'utf8'));process.exit(0);}
writeFileSync(${JSON.stringify(status)},JSON.stringify([{pid:process.pid,sessionId:'original',status:'waiting'}]));
const s=createConnection(process.env.HERDR_BRIDGE_TUI_SOCKET);
s.once('connect',()=>{
 s.write(JSON.stringify({type:'channel.hello',parentPid:process.pid})+'\\n');
 s.write(JSON.stringify({type:'channel.ready'})+'\\n');
 const h=createConnection(process.env.HERDR_BRIDGE_TUI_SOCKET);
 h.once('connect',()=>h.write(JSON.stringify({type:'hook.event',payload:{session_id:'original',model:'test/model',hook_event_name:'PreToolUse',tool_use_id:'native-read',tool_name:'Read',tool_input:{file_path:'declined.txt'}}})+'\\n'));
 h.once('data',()=>{h.end();s.write(JSON.stringify({type:'channel.permission',params:{request_id:'abcde',tool_name:'Read',input_preview:'declined.txt'}})+'\\n');});
});

`);await chmod(fake,0o700);
 const cfg=configSchema.parse({herdr:[{name:'fixture',socket:join(temp,'herdr.sock')}],transcriptRoots:{codex:temp,claude:temp},paseoHome:join(temp,'paseo'),paseoUrl:'ws://127.0.0.1:6795/ws',packageRoot:root,runtimeDirectory:join(temp,'run'),workspaceRoots:[temp],launch:{claudeCommand:fake}});
 await writeFile(file,JSON.stringify(cfg));
 const child=spawn(process.execPath,['--import',import.meta.resolve('tsx'),join(root,'scripts/tui-host.ts'),'claude'],{cwd:temp,env:{...process.env,HERDR_BRIDGE_CONFIG:file,HERDR_BRIDGE_TUI_KEY:'fixture',HERDR_BRIDGE_TUI_REGISTER:'0',HERDR_PANE_ID:'w1:p1',HERDR_WORKSPACE_ID:'w1',HERDR_SOCKET_PATH:cfg.herdr[0]!.socket},stdio:['ignore','ignore','pipe']});
 const exited=new Promise<void>(done=>child.once('exit',()=>done()));let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
 try{
  let state,snapshot;for(let i=0;i<100;i++){try{state=await loadTuiSession(cfg,'fixture');snapshot=await tuiRequest(state,'snapshot');if(snapshot.permissions.length)break;}catch{}await delay(20);}
  assert.ok(state,stderr);assert.equal(snapshot.permissions.length,1);assert.ok(snapshot.turnId);
  const actual=JSON.parse(await readFile(status,'utf8'));actual[0].status='idle';await writeFile(status,JSON.stringify(actual));
  for(let i=0;i<60;i++){snapshot=await tuiRequest(state,'snapshot');if(!snapshot.turnId)break;await delay(50);}
  assert.equal(snapshot.turnId,undefined);assert.equal(snapshot.permissions.length,0);assert.equal(snapshot.items.find((x:any)=>x.type==='tool_call').status,'canceled');
 }finally{child.kill('SIGTERM');await exited;await rm(temp,{recursive:true,force:true});}
});

test('a phone retry across native-host socket reconnects never repeats a completed prompt and exit flushes final history',async()=>{
 const temp=await mkdtemp(join(process.platform==='darwin'?'/private/tmp':'/tmp','hb-tui-retry-')),root=resolve(import.meta.dirname,'..'),file=join(temp,'config.json');
 const fake=join(temp,'pi.mjs'),received=join(temp,'received.jsonl');
 await writeFile(fake,`import {createConnection} from 'node:net';import {appendFileSync} from 'node:fs';
const s=createConnection(process.env.HERDR_BRIDGE_TUI_SOCKET);let buffer='';
s.once('connect',()=>s.write(JSON.stringify({type:'native.ready',pid:process.pid,state:{sessionId:'original',model:'test/model',models:[]}})+'\\n'));
s.on('data',chunk=>{buffer+=chunk;for(;;){const i=buffer.indexOf('\\n');if(i<0)break;const f=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);if(f.type==='native.request'&&f.method==='prompt'){
 appendFileSync(${JSON.stringify(received)},JSON.stringify(f.params)+'\\n');
 setTimeout(()=>{s.write(JSON.stringify({type:'native.response',id:f.id,result:{accepted:true}})+'\\n');s.write(JSON.stringify({type:'native.idle'})+'\\n');},80);
}}});
`);
 const cfg=configSchema.parse({herdr:[{name:'fixture',socket:join(temp,'herdr.sock')}],transcriptRoots:{codex:temp,claude:temp},paseoHome:join(temp,'paseo'),paseoUrl:'ws://127.0.0.1:6795/ws',packageRoot:root,runtimeDirectory:join(temp,'run'),workspaceRoots:[temp],launch:{piCommand:process.execPath}});
 await writeFile(file,JSON.stringify(cfg));
 const child=spawn(process.execPath,['--import',import.meta.resolve('tsx'),join(root,'scripts/tui-host.ts'),'pi',fake],{cwd:temp,env:{...process.env,HERDR_BRIDGE_CONFIG:file,HERDR_BRIDGE_TUI_KEY:'fixture',HERDR_BRIDGE_TUI_REGISTER:'0',HERDR_PANE_ID:'w1:p1',HERDR_WORKSPACE_ID:'w1',HERDR_SOCKET_PATH:cfg.herdr[0]!.socket},stdio:['ignore','ignore','pipe']});
 const exited=new Promise<void>(done=>child.once('exit',()=>done()));let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
 try{
  let state:TuiSession|undefined;for(let i=0;i<100;i++){try{state=await loadTuiSession(cfg,'fixture');if(state.ready)break;}catch{}await delay(20);}
  assert.ok(state?.ready,stderr);
  const binding=state;
  const subscribe=(paseoAgentId:string)=>new Promise<any>((done,fail)=>{
   const socket=createConnection(binding.socket),timer=setTimeout(()=>{socket.destroy();fail(Error('subscription timeout'));},2000);
   socket.once('connect',()=>socket.write(JSON.stringify({type:'tui.subscribe',key:binding.key,expectedSessionId:'original',paseoAgentId})+'\n'));
   socket.once('error',fail);readJsonLines(socket,frame=>{clearTimeout(timer);socket.destroy();frame.error?fail(Error(frame.error)):done(frame);},fail);
  });
  assert.equal((await subscribe('original-paseo-card')).snapshot.state.paseoAgentId,'original-paseo-card');
  await assert.rejects(subscribe('replacement-card'),/original Paseo agent/);
  const prompt={text:'do this exactly once',clientMessageId:'phone-original'};
  const [first,retry]=await Promise.all([tuiRequest(state,'prompt',prompt),tuiRequest(state,'prompt',prompt)]);assert.equal(first.turnId,retry.turnId);
  assert.equal((await tuiRequest(state,'prompt',prompt)).turnId,first.turnId);
  await assert.rejects(tuiRequest(state,'prompt',{...prompt,text:'different command'}),/different text/);
  await tuiRequest(state,'prompt',{text:'a deliberate second message',clientMessageId:'phone-next'});
  assert.equal((await readFile(received,'utf8')).trim().split('\n').length,2);
  child.kill('SIGTERM');await exited;
  state=await loadTuiSession(cfg,'fixture');assert.ok(state.endedAt);assert.equal(state.ready,false);assert.equal(state.paseoAgentId,'original-paseo-card');
  const snapshot=JSON.parse(await readFile(join(cfg.paseoHome,'herdr-bridge/tui-data/fixture/snapshot.json'),'utf8'));
  assert.equal(snapshot.turnId,undefined);assert.equal(snapshot.receipts.length,2);assert.equal(snapshot.receipts[0].status,'delivered');
 }finally{if(child.exitCode===null&&!child.signalCode)child.kill('SIGTERM');await exited;await rm(temp,{recursive:true,force:true});}
});
