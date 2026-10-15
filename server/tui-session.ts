import {readFile,readdir,mkdir,writeFile,rename,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createConnection} from 'node:net';
import type {BridgeConfig} from './config.js';
import {bridgeRuntime,inScope,configurationFile} from './config.js';
import {transport,type HerdrTransport} from './herdr.js';
import {readJsonLines} from './jsonl.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import type {ProviderTimelineItem} from '@getpaseo/plugin/server/provider';

export type TuiKind='claude'|'pi';
export interface TuiSession{key:string;kind:TuiKind;socket:string;hostPid:number;cliPid?:number;nativeSessionId?:string;model?:string;models?:any[];cwd:string;pane:string;workspace:string;herdrSocket:string;paseoAgentId?:string;registrationError?:string;ready:boolean;version?:string;startedAt?:string;endedAt?:string;exitCode?:number|null;invalidated?:boolean;}
const folder=(cfg:BridgeConfig)=>join(cfg.paseoHome,'herdr-bridge/native-tui');
export function tuiFile(cfg:BridgeConfig,key:string){if(!/^[a-zA-Z0-9_-]+$/.test(key))throw Error('Invalid native TUI binding');return join(folder(cfg),key+'.json');}
const saves=new Map<string,Promise<void>>();
export async function saveTuiSession(cfg:BridgeConfig,state:TuiSession){const file=tuiFile(cfg,state.key),value=JSON.stringify(state);const pending=(saves.get(file)??Promise.resolve()).catch(()=>{}).then(async()=>{await mkdir(folder(cfg),{recursive:true,mode:0o700});const tmp=file+'.tmp';await writeFile(tmp,value,{mode:0o600});await rename(tmp,file);});saves.set(file,pending);await pending;}
export async function loadTuiSession(cfg:BridgeConfig,key:string):Promise<TuiSession>{const state=JSON.parse(await readFile(tuiFile(cfg,key),'utf8'));if(state.key!==key)throw Error('Native binding key does not match its file');return state;}
export async function listTuiSessions(cfg:BridgeConfig,kind:TuiKind){let names:string[];try{names=await readdir(folder(cfg));}catch{return [];}const sessions:TuiSession[]=[];for(const name of names.filter(n=>n.endsWith('.json'))){const s=await loadTuiSession(cfg,name.slice(0,-5));if(s.kind===kind)sessions.push(s);}return sessions;}
export function validateTuiSession(cfg:BridgeConfig,state:TuiSession){
 tuiFile(cfg,state.key);
 if(!resolve(state.socket).startsWith(bridgeRuntime(cfg)+'/')||!inScope(cfg,state.cwd)||!cfg.herdr.some(h=>h.socket===state.herdrSocket))throw Error('The native terminal is outside this bridge');
}
export async function loadTuiHistory(cfg:BridgeConfig,state:TuiSession):Promise<{model?:string;items:ProviderTimelineItem[]}>{
 validateTuiSession(cfg,state);let snapshot:any;
 try{snapshot=JSON.parse(await readFile(join(cfg.paseoHome,'herdr-bridge/tui-data',state.key,'snapshot.json'),'utf8'));}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {model:state.model,items:[]};throw error;}
 if(snapshot.state?.key!==state.key||snapshot.state?.kind!==state.kind||resolve(snapshot.state?.cwd??'')!==resolve(state.cwd)||snapshot.state?.nativeSessionId!==state.nativeSessionId||snapshot.nativeSessionId!==state.nativeSessionId||!Array.isArray(snapshot.items))throw Error('Saved native history does not belong to this conversation');
 const items:ProviderTimelineItem[]=snapshot.items.map((item:any)=>{
  if(!item||typeof item.id!=='string')throw Error('Invalid native history item');
  if(item.type==='user_message'||item.type==='assistant_message'){if(typeof item.text!=='string')throw Error('Invalid saved native message');}
  else if(item.type==='tool_call'){if(typeof item.callId!=='string'||typeof item.name!=='string'||!item.detail||!['running','completed','canceled','failed'].includes(item.status))throw Error('Invalid saved native tool');}
  else throw Error('Unsupported saved native history item');
  return item.type==='tool_call'&&item.status==='running'?{...item,status:'canceled',error:null}:item;
 });
 return {model:snapshot.model??state.model,items};
}
export async function assertTuiSession(cfg:BridgeConfig,state:TuiSession,connection:HerdrTransport=transport){
 validateTuiSession(cfg,state);
 const info=await connection.request<any>(state.herdrSocket,'pane.process_info',{pane_id:state.pane});
 if(!info.process_info.foreground_processes.some((p:any)=>p.pid===state.hostPid)||state.cliPid&&!info.process_info.foreground_processes.some((p:any)=>p.pid===state.cliPid))throw Error('The original native terminal process has exited or been replaced');
}
export function sameTuiConversation(a:TuiSession,b:TuiSession){return !!a.nativeSessionId&&a.nativeSessionId===b.nativeSessionId&&a.kind===b.kind&&resolve(a.cwd)===resolve(b.cwd);}
export async function resolveLiveTuiSession(cfg:BridgeConfig,original:TuiSession,connection:HerdrTransport=transport){
 validateTuiSession(cfg,original);
 try{await assertTuiSession(cfg,original,connection);return original;}catch{}
 const live:TuiSession[]=[];
 for(const candidate of await listTuiSessions(cfg,original.kind)){
  if(candidate.key===original.key||!sameTuiConversation(original,candidate))continue;
  try{await assertTuiSession(cfg,candidate,connection);live.push(candidate);}catch{}
 }
 if(live.length!==1)throw Error(live.length?'Several live terminals use this native conversation; select one explicitly':'Resume the original conversation in Herdr before continuing');
 return live[0]!;
}
/** Merge generations by their real timeline IDs; unrelated native sessions never enter this history. */
export async function loadConversationTuiHistory(cfg:BridgeConfig,state:TuiSession){
 validateTuiSession(cfg,state);const snapshots:Array<{time:number;items:ProviderTimelineItem[]}>=[];
 for(const candidate of await listTuiSessions(cfg,state.kind)){
  if(candidate.key!==state.key&&!sameTuiConversation(state,candidate))continue;
  const history=await loadTuiHistory(cfg,candidate);
  let time=0;try{time=(await stat(join(cfg.paseoHome,'herdr-bridge/tui-data',candidate.key,'snapshot.json'))).mtimeMs;}catch{}
  snapshots.push({time,items:history.items});
 }
 const items=new Map<string,ProviderTimelineItem>();for(const snapshot of snapshots.sort((a,b)=>a.time-b.time))for(const item of snapshot.items)items.set(item.id,item);
 return [...items.values()];
}
export function tuiRequest(state:TuiSession,method:string,params:any={}){return new Promise<any>((done,reject)=>{
 const socket=createConnection(state.socket);const timeout=setTimeout(()=>{socket.destroy();reject(Error('Native terminal request timed out'));},15000);
 socket.once('connect',()=>socket.write(JSON.stringify({type:'tui.request',key:state.key,expectedSessionId:state.nativeSessionId,method,params})+'\n'));
 readJsonLines(socket,frame=>{clearTimeout(timeout);socket.end();if(frame.error)reject(Error(frame.error));else done(frame.result);},reject);
 socket.once('error',error=>{clearTimeout(timeout);reject(error);});
});}
export async function launchTuiSession(cfg:BridgeConfig,kind:TuiKind,cwd:string,options:{model?:string;mode?:string;autoRegister?:boolean}={}):Promise<TuiSession>{
 if(!inScope(cfg,cwd))throw Error('This project is outside the configured workspace roots');
 const execute=promisify(execFile),herdr=cfg.herdr[0]!,env:NodeJS.ProcessEnv={...process.env,HERDR_ENV:'1',HERDR_SOCKET_PATH:herdr.socket};
 for(const key of ['HERDR_PANE_ID','HERDR_WORKSPACE_ID','HERDR_TAB_ID'])delete env[key];
 const created=JSON.parse((await execute('herdr',['workspace','create','--cwd',cwd,'--label',kind==='claude'?'Claude Code':'Pi','--no-focus'],{env})).stdout);
 const key=(await import('node:crypto')).randomUUID(),pane=created.result.root_pane.pane_id;
 const q=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
 const args=['env','HERDR_BRIDGE_CONFIG='+configurationFile(cfg),'HERDR_BRIDGE_TUI_KEY='+key,'HERDR_BRIDGE_TUI_REGISTER='+(options.autoRegister===false?'0':'1'),process.execPath,join(cfg.packageRoot,'dist/scripts/tui-host.js'),kind];
 if(options.model&&!(kind==='claude'&&options.model==='native'))args.push('--model',options.model);if(options.mode&&kind==='claude')args.push('--permission-mode',options.mode);
 await execute('herdr',['pane','run',pane,args.map(q).join(' ')],{env});
 for(let i=0;i<100;i++){try{return await loadTuiSession(cfg,key);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await delay(100);}}
 throw Error('The native CLI did not start; inspect its Herdr terminal');
}
