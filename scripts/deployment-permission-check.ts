import {readFile,writeFile,access,mkdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,dirname} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createConnection} from 'node:net';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {readConfig} from '../server/config.js';
import {connectPaseo} from '../server/paseo.js';
import {loadClaudeRoute} from '../server/claude-native.js';
import {createPiHost,piRouteFile} from '../server/pi-native.js';
import {readJsonLines} from '../server/jsonl.js';

const base=join(homedir(),'.hb'),cfg=readConfig(join(base,'config.json')),kind=process.argv[2];
assert.equal(new URL(cfg.paseoUrl).port,'6795');assert.ok(kind==='claude'||kind==='pi');
const execute=promisify(execFile),client=await connectPaseo(cfg),bins=JSON.parse(await readFile(join(base,'executables.json'),'utf8'));
let socket:ReturnType<typeof createConnection>|undefined;
try{
 let agent,route:any;
 if(kind==='claude'){
  agent=await client.agents.create({cwd:join(base,'workspace'),config:{provider:'claude/'+cfg.launch.claudeModel,modeId:'default'},title:'Claude · Herdr 权限接手验证'});
  // Claude drafts start lazily. Initialize the actual SDK before attaching a
  // read-only observer, so an observer cannot choose the executor's CLI args.
  await agent.commands();
  route=await loadClaudeRoute(cfg,agent.id);assert.ok(route);
 }else{
  const fixture=join(base,'pi-question-fixture.ts');
  await writeFile(fixture,`import { Type } from '@sinclair/typebox';
export default function(pi){pi.registerTool({name:'bridge_question',label:'Bridge question',description:'Ask the human to choose yes or no. No file operations.',parameters:Type.Object({}),async execute(_id,_params,_signal,_update,ctx){const yes=await ctx.ui.confirm('Herdr takeover check','Choose No for this transport test.');return {content:[{type:'text',text:yes?'HB_ALLOWED':'HB_DENIED'}],details:{confirmed:yes}};}});}
`,{mode:0o600});
  route=await createPiHost(cfg,join(base,'workspace'));
  const id=randomUUID(),file=piRouteFile(cfg,id);await mkdir(dirname(file),{recursive:true,mode:0o700});await writeFile(file,JSON.stringify(route),{mode:0o600});
  socket=createConnection(route.socket);
  await new Promise<void>((ready,reject)=>{socket!.once('error',reject);readJsonLines(socket!,f=>{if(f.type==='bridge.ready')ready();if(f.type==='bridge.error')reject(Error(f.message));},reject);socket!.once('connect',()=>socket!.write(JSON.stringify({type:'bridge.attach',cwd:route.cwd,args:['--mode','rpc','--no-extensions','--session-dir',join(base,'pi-sessions'),'--model',cfg.launch.piModel,'--extension',fixture]})+'\n'));});
  agent=await client.agents.create({agentId:id,cwd:route.cwd,config:{provider:'pi/'+cfg.launch.piModel},title:'Pi · Herdr 问答接手验证'});
 }
 const nativePending:Array<any>=[];
 if(!socket)socket=createConnection(route.socket);
 else socket.destroy(),socket=createConnection(route.socket);
 await new Promise<void>((ready,reject)=>{
  socket!.once('error',reject);
  readJsonLines(socket!,frame=>{
   if(frame.type==='bridge.ready')ready();
   if(frame.type==='bridge.stdout'&&((kind==='claude'&&frame.message.type==='control_request'&&frame.message.request?.subtype==='can_use_tool')||(kind==='pi'&&frame.message.type==='extension_ui_request'&&frame.message.method==='confirm')))nativePending.push(frame.message);
   if(frame.type==='bridge.error')reject(Error(frame.message));
  },reject);
  socket!.once('connect',()=>socket!.write(JSON.stringify({type:'bridge.attach',cwd:route.cwd,args:kind==='claude'?['--input-format','stream-json']:['--mode','rpc']})+'\n'));
 });
 const target=join(base,'workspace','denied-'+Date.now().toString(36)+'.txt');
 const prompt=kind==='claude'?'Use only the Write tool to create '+target+' containing TEST. If permission is denied, stop and reply HB_DENIED. Do not retry or use other tools.':'Call bridge_question exactly once. Do not use other tools or perform file operations. Then reply exactly with the tool result.';
 const started=await agent.run(prompt,{timeoutMs:120000});assert.equal(started.status,'permission');
 for(let i=0;!nativePending.length&&i<30;i++)await delay(100);
 assert.equal(nativePending.length,1,'Expected one exact native request');
 const nativeId=kind==='claude'?nativePending[0].request_id:nativePending[0].id;
 const before=JSON.parse(await readFile(route.socket+'.json','utf8'));
 await execute(bins.herdr,['pane','run',route.pane,'/deny '+nativeId],{env:{...process.env,HERDR_ENV:'1',HERDR_SOCKET_PATH:route.herdrSocket},timeout:15000});
 for(let i=0;i<100;i++){
  if(!((await agent.refresh())!.agent.pendingPermissions?.length))break;
  await delay(100);
 }
 const finished=await agent.waitForFinish(120000);assert.equal(finished.status,'idle');
 const state=(await agent.refresh())!.agent;assert.equal(state.pendingPermissions?.length??0,0,'Paseo permission card was not resolved');
 assert.ok(finished.lastMessage?.includes(kind==='claude'?'HB_DENIED':'HB_DENIED'));
 if(kind==='claude')await assert.rejects(access(target),{code:'ENOENT'});
 const after=JSON.parse(await readFile(route.socket+'.json','utf8'));assert.equal(after.enginePid,before.enginePid);assert.equal(after.sessionId,before.sessionId);
 await writeFile(join(base,kind+'-permission-verification.json'),JSON.stringify({provider:kind,paseoAgentId:agent.id,herdrAnswered:true,nativePaseoCardResolved:true,originalPidPreserved:true,sessionId:after.sessionId,pid:after.enginePid},null,2)+'\n',{mode:0o600});
 console.log('PASS: '+kind+' question is answered in Herdr, Paseo resolves the same native card, and the original executor continues.');
}finally{socket?.destroy();await client.close();}
