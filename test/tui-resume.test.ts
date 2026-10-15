import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {configSchema} from '../server/config.js';
import {saveTuiSession,resolveLiveTuiSession,loadConversationTuiHistory,type TuiSession} from '../server/tui-session.js';
import type {HerdrTransport} from '../server/herdr.js';

async function fixture(){
 const root=await mkdtemp(join(process.platform==='darwin'?'/private/tmp':'/tmp','hb-tui-resume-'));
 const cfg=configSchema.parse({herdr:[{name:'fixture',socket:join(root,'herdr.sock')}],transcriptRoots:{claude:root,codex:root},paseoHome:join(root,'paseo'),paseoUrl:'ws://127.0.0.1:6795/ws',packageRoot:root,runtimeDirectory:join(root,'run'),workspaceRoots:[root]});
 const old:TuiSession={key:'old',kind:'claude',socket:join(root,'run/old.sock'),hostPid:1,cliPid:2,nativeSessionId:'vendor-original',cwd:root,pane:'w1:p1',workspace:'w1',herdrSocket:cfg.herdr[0]!.socket,ready:true};
 const fresh:TuiSession={...old,key:'new',socket:join(root,'run/new.sock'),hostPid:3,cliPid:4,pane:'w2:p1',workspace:'w2'};
 const live=new Map([[fresh.pane,[fresh.hostPid,fresh.cliPid!]]]);
 const connection:HerdrTransport={async request<T>(_socket:string,_method:string,params?:Record<string,unknown>){return {process_info:{foreground_processes:(live.get(params?.pane_id as string)??[]).map(pid=>({pid}))}} as T;}};
 await saveTuiSession(cfg,old);await saveTuiSession(cfg,fresh);
 return {root,cfg,old,fresh,live,connection};
}
test('a stopped native binding reattaches only to one verified process with the same vendor session and project',async()=>{
 const f=await fixture();try{
  assert.equal((await resolveLiveTuiSession(f.cfg,f.old,f.connection)).key,f.fresh.key);
  await saveTuiSession(f.cfg,{...f.fresh,nativeSessionId:'another-conversation'});
  await assert.rejects(resolveLiveTuiSession(f.cfg,f.old,f.connection),/Resume the original/);
  await saveTuiSession(f.cfg,{...f.fresh,cwd:join(f.root,'different-project')});
  await assert.rejects(resolveLiveTuiSession(f.cfg,f.old,f.connection),/Resume the original/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('two live native processes sharing one conversation cannot silently claim an archived view',async()=>{
 const f=await fixture();try{
  const extra={...f.fresh,key:'ambiguous',pane:'w3:p1',hostPid:5,cliPid:6};await saveTuiSession(f.cfg,extra);f.live.set(extra.pane,[5,6]);
  await assert.rejects(resolveLiveTuiSession(f.cfg,f.old,f.connection),/Several live terminals/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test('resume history combines native generations by item ID without importing another conversation',async()=>{
 const f=await fixture();try{
  const unrelated={...f.old,key:'unrelated',nativeSessionId:'different'};await saveTuiSession(f.cfg,unrelated);
  for(const [state,items]of [[f.old,[{type:'user_message',id:'u1',text:'original'},{type:'assistant_message',id:'a1',text:'original reply'}]],[f.fresh,[{type:'assistant_message',id:'a1',text:'original reply'},{type:'assistant_message',id:'a2',text:'resumed reply'}]],[unrelated,[{type:'assistant_message',id:'wrong',text:'must not appear'}]]]as const){
   const dir=join(f.cfg.paseoHome,'herdr-bridge/tui-data',state.key);await mkdir(dir,{recursive:true});await writeFile(join(dir,'snapshot.json'),JSON.stringify({state,nativeSessionId:state.nativeSessionId,items}));
  }
  assert.deepEqual((await loadConversationTuiHistory(f.cfg,f.fresh)).map(i=>i.id),['u1','a1','a2']);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
