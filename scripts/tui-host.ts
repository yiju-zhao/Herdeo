/** Hosts transport only. The real CLI owns stdin/stdout and renders its own TUI. */
import {createServer,type Socket} from 'node:net';
import {spawn,type ChildProcess} from 'node:child_process';
import {mkdir,writeFile,readFile,unlink} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readConfig,bridgeRuntime,inScope} from '../server/config.js';
import {readJsonLines} from '../server/jsonl.js';
import {NativeTuiState} from '../server/tui-state.js';
import {saveTuiSession,type TuiSession,type TuiKind,tuiFile} from '../server/tui-session.js';
import {connectPaseo} from '../server/paseo.js';
import {transport} from '../server/herdr.js';
import {setTimeout as delay} from 'node:timers/promises';
import {registerTuiSession} from '../server/tui-registration.js';
import {PromptDelivery} from '../server/prompt-delivery.js';
import {SnapshotWriter} from '../server/snapshot-writer.js';
import {version} from '../server/version.js';

const cfg=readConfig(),kind=process.argv[2] as TuiKind,args=process.argv.slice(3);
if(!['claude','pi'].includes(kind)||!inScope(cfg,process.cwd()))throw Error('Native TUI requires a configured kind and project');
const pane=process.env.HERDR_PANE_ID!,herdrSocket=process.env.HERDR_SOCKET_PATH!,workspace=process.env.HERDR_WORKSPACE_ID!;
if(!pane||!workspace||!cfg.herdr.some(h=>h.socket===herdrSocket))throw Error('Start this connector inside its configured Herdr terminal');
const key=process.env.HERDR_BRIDGE_TUI_KEY??randomUUID(),socketPath=join(bridgeRuntime(cfg),'live-'+key.slice(0,8)+'.sock');
await mkdir(bridgeRuntime(cfg),{recursive:true,mode:0o700});
const folder=join(cfg.paseoHome,'herdr-bridge/tui-data',key);await mkdir(folder,{recursive:true,mode:0o700});
const state:TuiSession={key,kind,socket:socketPath,hostPid:process.pid,cwd:process.cwd(),pane,workspace,herdrSocket,ready:false,version,startedAt:new Date().toISOString()};
const subscribers=new Set<Socket>();let channel:Socket|undefined,nativePeer:Socket|undefined,cli:ChildProcess|undefined,registering=false,closed=false;
const rpcPending=new Map<string,{done:(v:any)=>void;fail:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
let stopTimer:ReturnType<typeof setTimeout>|undefined,invalidated=false,nativeActivity=false,idleChecking=false;
const delivery=new PromptDelivery();
const data=new NativeTuiState(kind,event=>{if(event.type==='session.turn')nativeActivity=false;for(const s of subscribers)if(s.writable)s.write(JSON.stringify({type:'tui.event',event})+'\n');writer.schedule();});
const snapshot=()=>({...data.snapshot(),state,receipts:delivery.snapshot()});
const writer=new SnapshotWriter(join(folder,'snapshot.json'),snapshot);
async function report(){state.nativeSessionId=data.nativeSessionId;state.model=data.model;await saveTuiSession(cfg,state);writer.schedule();if(data.nativeSessionId)await transport.request(herdrSocket,'pane.report_agent_session',{pane_id:pane,source:'herdr:'+kind,agent:kind,agent_session_id:data.nativeSessionId}).catch(()=>{});await autoRegister();}
async function autoRegister(){
 // Resume hooks can omit a model. Keep model selection in the real CLI rather
 // than blocking registration or guessing from an older assistant response.
 const model=data.model??(kind==='claude'?'native':undefined);
 if(invalidated||process.env.HERDR_BRIDGE_TUI_REGISTER==='0'||registering||state.paseoAgentId&&!state.registrationError||!state.ready||!data.nativeSessionId||!model||model==='unknown/unknown')return;
 registering=true;
 try{await registerTuiSession(cfg,state);}catch(error){state.registrationError=(error as Error).message;await saveTuiSession(cfg,state).catch(()=>{});}finally{registering=false;}
}
function nativeRequest(method:string,params:any={}){return new Promise<any>((done,fail)=>{if(!nativePeer){fail(Error('Native Pi extension is not ready'));return;}const id=randomUUID(),timer=setTimeout(()=>{rpcPending.delete(id);fail(Error('Native Pi control timed out'));},15000);rpcPending.set(id,{done,fail,timer});nativePeer.write(JSON.stringify({type:'native.request',id,method,params})+'\n');});}
function clearStopTimer(){if(stopTimer)clearTimeout(stopTimer);stopTimer=undefined;}
async function nativeClaudeIsIdle(){
 try{
  const result=await (await import('node:util')).promisify((await import('node:child_process')).execFile)(cfg.launch.claudeCommand!,['agents','--json'],{env:{...process.env,HERDR_ENV:undefined,HERDR_PANE_ID:undefined,HERDR_SOCKET_PATH:undefined},timeout:10000});
  const values=JSON.parse(result.stdout);const entries=Array.isArray(values)?values:values.sessions??[];
  return entries.some((e:any)=>e.pid===cli?.pid&&e.sessionId===data.nativeSessionId&&e.status==='idle');
 }catch{}
 return false;
}
async function finishWhenIdle(failed:boolean,error?:string,turnId=data.turnId){
 if(!turnId||turnId!==data.turnId)return;
 clearStopTimer();
 const idle=await nativeClaudeIsIdle();if(turnId!==data.turnId)return;
 if(idle){data.finish(failed?'failed':'completed',error);return;}
 if(!closed)stopTimer=setTimeout(()=>void finishWhenIdle(failed,error,turnId),300);
}
async function observeNativeIdle(){
 // Native No/Esc interrupts do not emit Stop. Only check after the original CLI
 // has emitted real activity; an undelivered channel message can still be idle.
 if(kind!=='claude'||!data.turnId||!nativeActivity||idleChecking||stopTimer)return;
 idleChecking=true;const turnId=data.turnId;
 try{if(await nativeClaudeIsIdle()&&data.turnId===turnId)data.finish();}finally{idleChecking=false;}
}
const server=createServer(client=>{
 readJsonLines(client,async frame=>{
  try{
   if(frame.type==='channel.hello'){if(cli?.pid&&frame.parentPid!==cli.pid)throw Error('Channel belongs to another CLI');channel=client;}
   else if(frame.type==='channel.ready'){state.ready=true;await report();}
   else if(frame.type==='channel.permission'){data.claudePermission(frame.params);nativeActivity=true;}
   else if(frame.type==='hook.event'){
    client.end(JSON.stringify({ok:true})+'\n');
    if(frame.payload.cwd&&!inScope(cfg,frame.payload.cwd)||data.nativeSessionId&&frame.payload.session_id!==data.nativeSessionId){invalidated=true;state.invalidated=true;state.ready=false;await saveTuiSession(cfg,state);writer.schedule();for(const s of subscribers)s.end(JSON.stringify({type:'tui.event',event:{type:'session.runtime_failed',error:{message:'The native CLI changed conversation or left the configured project roots. This view cannot send to it.'}}})+'\n');return;}
    data.claudeHook(frame.payload);
    if(['UserPromptSubmit','MessageDisplay','PreToolUse'].includes(frame.payload.hook_event_name))nativeActivity=true;
    await report();
    if(frame.payload.hook_event_name==='Stop'||frame.payload.hook_event_name==='StopFailure'){
     clearStopTimer();stopTimer=setTimeout(()=>void finishWhenIdle(frame.payload.hook_event_name==='StopFailure',frame.payload.error),150);
    }
   }else if(frame.type==='native.ready'){
    if(frame.pid!==cli?.pid)throw Error('The native Pi extension belongs to a different process');
    if(data.nativeSessionId&&frame.state.sessionId!==data.nativeSessionId){invalidated=true;state.invalidated=true;state.ready=false;await saveTuiSession(cfg,state);writer.schedule();throw Error('The native Pi conversation changed');}
    nativePeer=client;data.nativeSessionId=frame.state.sessionId;data.model=frame.state.model;state.models=frame.state.models;state.ready=true;await report();
   }else if(frame.type==='native.state'){data.model=frame.state.model;state.models=frame.state.models;await report();}
   else if(frame.type==='native.event')data.piEvent(frame.event);
   else if(frame.type==='native.idle')data.finish();
   else if(frame.type==='native.question')data.piQuestion(frame.request);
   else if(frame.type==='native.question_resolved')data.resolvePermission(frame.id);
   else if(frame.type==='native.response'){const p=rpcPending.get(frame.id);if(p){clearTimeout(p.timer);rpcPending.delete(frame.id);frame.error?p.fail(Error(frame.error)):p.done(frame.result);}}
   else if(frame.type==='tui.subscribe'){
    if(frame.key!==key||frame.expectedSessionId&&frame.expectedSessionId!==data.nativeSessionId)throw Error('The original native conversation has changed');
    if(frame.paseoAgentId!==undefined){
     if(typeof frame.paseoAgentId!=='string'||!/^[a-zA-Z0-9_-]+$/.test(frame.paseoAgentId)||state.paseoAgentId&&state.paseoAgentId!==frame.paseoAgentId)throw Error('This native terminal belongs to its original Paseo agent');
     state.paseoAgentId=frame.paseoAgentId;await saveTuiSession(cfg,state);writer.schedule();
    }
    subscribers.add(client);client.write(JSON.stringify({type:'tui.snapshot',snapshot:snapshot()})+'\n');
   }else if(frame.type==='tui.request'){
    if(invalidated&&frame.method!=='snapshot')throw Error('This native terminal changed conversations; its previous view cannot send messages');
    if(frame.key!==key||frame.expectedSessionId&&frame.expectedSessionId!==data.nativeSessionId)throw Error('The original native conversation has changed');
    let result:any={};
    if(frame.method==='snapshot')result=snapshot();
    else if(frame.method==='prompt'){
     const {text,clientMessageId}=frame.params;
     result=await delivery.deliver(clientMessageId,text,async accept=>{
     // Paseo can submit immediately after creating the terminal, before Pi's
     // extension or Claude's MCP channel has finished its normal initialization.
     const deadline=Date.now()+8000;
     while(!state.ready&&!closed&&!invalidated&&Date.now()<deadline)await delay(50);
     if(!state.ready)throw Error('Complete the native CLI startup dialogs in Herdr first');
     await observeNativeIdle();
     if(data.turnId)throw Error('The native CLI is already working; wait for the current turn');
     const turnId=data.start();data.prompt(text,clientMessageId);
     accept(turnId);
     try{
      // Persist the accepted ID before handing it to the original executor.
      await writer.flush();
      if(kind==='claude'){if(!channel)throw Error('Native Claude channel disconnected');channel.write(JSON.stringify({type:'channel.notification',notification:{jsonrpc:'2.0',method:'notifications/claude/channel',params:{content:text,meta:{paseo_message_id:clientMessageId}}}})+'\n');}
      else await nativeRequest('prompt',{text});
     }catch(error){data.finish('failed',(error as Error).message);throw error;}
     return {turnId};
     });
     await writer.flush();
    }else if(frame.method==='permission'){
     const request=data.permissions.get(frame.params.id);if(!request)throw Error('This native permission is no longer pending');
     if(kind==='claude'){
      if(frame.params.response.behavior==='allow'&&!request.metadata?.fullInputVerified)throw Error('Full tool arguments are not available; approve this request in the native terminal');
      channel!.write(JSON.stringify({type:'channel.notification',notification:{jsonrpc:'2.0',method:'notifications/claude/channel/permission',params:{request_id:request.id,behavior:frame.params.response.behavior}}})+'\n');
     }else await nativeRequest('answer',{request,response:frame.params.response});
     data.resolvePermission(request.id);
    }else if(frame.method==='interrupt'){
     if(data.turnId){if(kind==='pi')await nativeRequest('abort');else await transport.request(herdrSocket,'agent.send_keys',{target:pane,keys:['esc']});data.finish('canceled');}
    }else if(frame.method==='configure'&&kind==='pi'){result=await nativeRequest('configure',frame.params);if(result.model)data.model=result.model;}
    else throw Error('This control is available in the original native CLI');
    client.end(JSON.stringify({result})+'\n');
   }else throw Error('Unknown native terminal bridge message');
  }catch(error){if(client.writable)client.end(JSON.stringify({error:(error as Error).message})+'\n');}
 },error=>{if(client.writable)client.end(JSON.stringify({error:error.message})+'\n');});
 client.on('error',()=>{});client.once('close',()=>{subscribers.delete(client);let changed=false;if(client===channel){channel=undefined;state.ready=false;changed=true;}if(client===nativePeer){nativePeer=undefined;state.ready=false;changed=true;}if(changed){writer.schedule();void saveTuiSession(cfg,state).catch(()=>{});}});
});
await new Promise<void>((done,fail)=>{server.once('error',fail);server.listen(socketPath,done);});
await (await import('node:fs/promises')).chmod(socketPath,0o600);await saveTuiSession(cfg,state);
const env:NodeJS.ProcessEnv={...process.env,HERDR_BRIDGE_TUI_SOCKET:socketPath,HERDR_BRIDGE_NODE:process.execPath,HERDR_BRIDGE_PACKAGE_ROOT:cfg.packageRoot};
for(const key of ['CLAUDECODE','CLAUDE_CODE_SESSION_ID','CODEX_THREAD_ID'])delete env[key];
let nativeArgs=[...args];
if(kind==='claude'){
 const mcp=join(folder,'mcp.json');await writeFile(mcp,JSON.stringify({mcpServers:{paseo_native_bridge:{command:process.execPath,args:[join(cfg.packageRoot,'dist/scripts/claude-tui-channel.js')],env:{HERDR_BRIDGE_TUI_SOCKET:socketPath}}}}),{mode:0o600});
 nativeArgs.push('--plugin-dir',join(cfg.packageRoot,'plugins/claude-native'),'--mcp-config',mcp,'--dangerously-load-development-channels','server:paseo_native_bridge');
}else nativeArgs.push('--extension',join(cfg.packageRoot,'dist/scripts/pi-tui-extension.js'));
cli=spawn(kind==='claude'?cfg.launch.claudeCommand!:cfg.launch.piCommand!,nativeArgs,{env,cwd:state.cwd,stdio:'inherit'});
state.cliPid=cli.pid;await saveTuiSession(cfg,state);
const registrationTimer=setInterval(()=>void autoRegister(),3000);registrationTimer.unref();
const idleTimer=setInterval(()=>void observeNativeIdle(),1000);idleTimer.unref();
cli.once('exit',async code=>{closed=true;state.ready=false;state.endedAt=new Date().toISOString();state.exitCode=code;clearStopTimer();clearInterval(registrationTimer);clearInterval(idleTimer);data.finish(code?'failed':'completed',code?'Native CLI exited with code '+code:undefined);for(const s of subscribers)s.end(JSON.stringify({type:'tui.exited',code})+'\n');server.close();void unlink(socketPath).catch(()=>{});process.exitCode=code??1;try{await saveTuiSession(cfg,state);await writer.flush();}catch{console.error('Herdeo could not save the final native session snapshot');}});
cli.once('error',error=>{console.error(error.message);server.close();process.exitCode=1;});
for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{if(!closed)cli?.kill(signal);});
