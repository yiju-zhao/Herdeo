import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {configSchema} from '../server/config.js';
import {saveTuiSession,type TuiSession} from '../server/tui-session.js';
import {createTuiProvider} from '../server/tui-provider.js';

test('archived native history remains readable after its original terminal exits, without permitting live mutations',async()=>{
 const root=await mkdtemp(join(process.platform==='darwin'?'/private/tmp':'/tmp','hb-tui-archive-'));
 const cfg=configSchema.parse({herdr:[{name:'fixture',socket:join(root,'closed-herdr.sock')}],transcriptRoots:{claude:root,codex:root},paseoHome:join(root,'paseo'),paseoUrl:'ws://127.0.0.1:6795/ws',packageRoot:root,runtimeDirectory:join(root,'run'),workspaceRoots:[root]});
 const state:TuiSession={key:'original-key',kind:'claude',socket:join(root,'run/closed.sock'),hostPid:123,cliPid:124,nativeSessionId:'original-session',cwd:root,pane:'w1:p1',workspace:'w1',herdrSocket:cfg.herdr[0]!.socket,ready:false,model:'original-model'};
 await saveTuiSession(cfg,state);const folder=join(cfg.paseoHome,'herdr-bridge/tui-data',state.key);await mkdir(folder,{recursive:true});
 await writeFile(join(folder,'snapshot.json'),JSON.stringify({state,nativeSessionId:state.nativeSessionId,model:state.model,items:[{type:'user_message',id:'u1',text:'original owner message'},{type:'assistant_message',id:'a1',text:'original archived reply'}],permissions:[{id:'expired',name:'Read',kind:'tool',title:'Expired permission'}]}));
 const connection=await createTuiProvider(cfg,'claude').connect({versions:[1],capabilities:['prompt.message','session.persistence','session.list','permission']});const events:any[]=[];connection.onEvent(e=>events.push(e));
 try{
  await connection.send({type:'session.open',requestId:'open',sessionId:'view',config:{cwd:root,env:{},mcpServers:{},settings:{},persist:true},persistence:{version:1,data:{key:state.key}},history:'replay'});
  assert.ok(events.some(e=>e.type==='session.ready'),'Archived history incorrectly requires a running CLI');
  assert.deepEqual(events.filter(e=>e.type==='timeline.item').map(e=>e.item.text),['original owner message','original archived reply']);
  assert.ok(!events.some(e=>e.type==='session.permission'),'Expired tool requests must never become actionable');
  await connection.send({type:'session.prompt',sessionId:'view',prompt:{clientMessageId:'new',delivery:'auto',input:{type:'message',content:[{type:'text',text:'must not start another executor'}]}}});
  assert.ok(events.some(e=>e.type==='session.prompt_result'&&e.result.type==='failed'));
 }finally{await connection.close();await rm(root,{recursive:true,force:true});}
});
