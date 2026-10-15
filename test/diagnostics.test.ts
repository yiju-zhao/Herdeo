import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {configSchema} from '../server/config.js';
import {saveTuiSession,type TuiSession} from '../server/tui-session.js';
import {diagnose,formatDiagnostics} from '../server/diagnostics.js';

test('diagnostics separate archived live CLI, startup wait and exited CLI without mutating Paseo or reading secrets',async()=>{
 const root=await mkdtemp((process.platform==='darwin'?'/private/tmp/':'/tmp/')+'herdeo-doctor-');
 const cfg=configSchema.parse({herdr:[{name:'dedicated',socket:join(root,'herdr.sock')}],transcriptRoots:{claude:root,codex:root},paseoHome:join(root,'paseo'),paseoUrl:'ws://127.0.0.1:6795/ws',packageRoot:root,runtimeDirectory:join(root,'run'),workspaceRoots:[root]});
 const base:TuiSession={key:'live',kind:'claude',socket:join(root,'run/live.sock'),hostPid:10,cliPid:11,nativeSessionId:'owner-session',cwd:root,pane:'live',workspace:'w1',herdrSocket:cfg.herdr[0]!.socket,ready:true,version:'0.2.0'};
 try{
  for(const state of [base,{...base,key:'startup',pane:'startup',nativeSessionId:undefined,ready:false},{...base,key:'exited',pane:'exited'}])await saveTuiSession(cfg,state);
  await writeFile(join(cfg.paseoHome,'herdr-bridge/native-tui/broken.json'),'{');
  let closed=false;const calls:string[]=[];
  const report=await diagnose(cfg,{
   herdr:{async request<T>(_socket:string,method:string,params?:Record<string,unknown>){calls.push(method);if(method==='ping')return {} as T;assert.equal(method,'pane.process_info');return {process_info:{foreground_processes:params?.pane_id==='exited'?[]:[{pid:10},{pid:11}]}} as T;}},
   connect:async()=>({agents:{list:async()=>({entries:[{agent:{id:'archived-card',provider:'claude-terminal',cwd:root,archivedAt:'2026-10-15',labels:{'herdr.native-tui':'live'}}}],pageInfo:{}})},close:async()=>{closed=true;}} as any),
   tui:async state=>({state:{ready:state.key!=='startup'},permissions:[],items:[]}),
  });
  assert.equal(closed,true);assert.equal(report.damagedRecords,1);
  const live=report.sessions.find(s=>s.key==='live')!,exited=report.sessions.find(s=>s.key==='exited')!,startup=report.sessions.find(s=>s.key==='startup')!;
  assert.deepEqual([live.native,live.view,live.channel],['alive','archived','ready']);
  assert.equal(exited.native,'exited');assert.match(exited.hint!,/Herdr 中 resume/);
  assert.equal(startup.channel,'waiting');assert.match(startup.hint!,/开发通道确认/);
  assert.ok(calls.every(c=>['ping','pane.process_info'].includes(c)));
  assert.ok(!JSON.stringify(report).includes('Password'));assert.match(formatDiagnostics(report),/运行中.*已归档/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('an unavailable Herdr or Paseo cannot be misreported as a dead CLI or an unregistered session',async()=>{
 const root=await mkdtemp((process.platform==='darwin'?'/private/tmp/':'/tmp/')+'herdeo-unavailable-');
 const cfg=configSchema.parse({herdr:[{name:'offline',socket:join(root,'missing.sock')}],transcriptRoots:{claude:root,codex:root},paseoHome:join(root,'paseo'),paseoUrl:'ws://127.0.0.1:6795/ws',packageRoot:root,runtimeDirectory:join(root,'run'),workspaceRoots:[root]});
 try{
  await saveTuiSession(cfg,{key:'owner',kind:'pi',socket:join(root,'run/live.sock'),hostPid:10,cliPid:11,cwd:root,pane:'p1',workspace:'w1',herdrSocket:cfg.herdr[0]!.socket,ready:true});
  const report=await diagnose(cfg,{herdr:{async request(){throw Error('offline');}},connect:async()=>{throw Error('connection timeout');},tui:async()=>{throw Error('must not connect to unverified PID');}});
  assert.equal(report.sessions[0]!.native,'unknown');assert.equal(report.sessions[0]!.view,'unknown');assert.equal(report.paseo.connected,false);
 }finally{await rm(root,{recursive:true,force:true});}
});
