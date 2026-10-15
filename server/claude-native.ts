import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { PluginSessionOpenRequest } from '@getpaseo/plugin/server';
import { bridgeRuntime, configurationFile, inScope, type BridgeConfig } from './config.js';
import { transport } from './herdr.js';

const execute=promisify(execFile);
const quote=(text:string)=>"'"+text.replaceAll("'","'\\''")+"'";
const routeSchema=z.object({socket:z.string(),herdrSocket:z.string(),pane:z.string(),workspace:z.string(),cwd:z.string(),hostPid:z.number().int().positive()});
export type ClaudeRoute=z.infer<typeof routeSchema>;
export const claudeRouteFile=(config:BridgeConfig,id:string)=>{
 if(!/^[a-zA-Z0-9_-]+$/.test(id))throw Error('Invalid native Claude agent ID');
 return join(config.paseoHome,'herdr-bridge/native-claude',id+'.json');
};
export async function loadClaudeRoute(config:BridgeConfig,id:string):Promise<ClaudeRoute|undefined>{
 try{return routeSchema.parse(JSON.parse(await readFile(claudeRouteFile(config,id),'utf8')))}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e}
}
export async function assertClaudeRoute(config:BridgeConfig,route:ClaudeRoute){
 route=routeSchema.parse(route);
 if(!resolve(route.socket).startsWith(bridgeRuntime(config)+'/')||!route.socket.endsWith('.sock'))throw Error('Native Claude socket belongs to another runtime');
 if(!inScope(config,route.cwd)||!config.herdr.some(h=>h.socket===route.herdrSocket))throw Error('Native Claude route belongs to another bridge workspace');
 const info=await transport.request<any>(route.herdrSocket,'pane.process_info',{pane_id:route.pane});
 if(!info.process_info.foreground_processes.some((p:any)=>p.pid===route.hostPid))throw Error('The original Herdr Claude host is no longer present; it was not relaunched');
 await access(route.socket);
}
export async function createClaudeHost(config:BridgeConfig,cwd:string):Promise<ClaudeRoute>{
 if(!inScope(config,cwd))throw Error('Native Claude must use a configured bridge workspace');
 const host=config.herdr[0]!;
 const env:NodeJS.ProcessEnv={...process.env,HERDR_SOCKET_PATH:host.socket,HERDR_ENV:'1'};
 for(const name of ['HERDR_PANE_ID','HERDR_WORKSPACE_ID','HERDR_TAB_ID'])delete env[name];
 const created=JSON.parse((await execute('herdr',['workspace','create','--cwd',cwd,'--label','Claude','--no-focus'],{env})).stdout);
 const pane=created.result.root_pane.pane_id;const workspace=created.result.workspace.workspace_id;
 const folder=bridgeRuntime(config);await mkdir(folder,{recursive:true,mode:0o700});
 const socket=join(folder,randomUUID().slice(0,8)+'.sock');
 try{
  const args=['env','-u','CLAUDECODE','-u','CLAUDE_CODE_SESSION_ID','-u','CODEX_THREAD_ID','HERDR_BRIDGE_CLAUDE_SOCKET='+socket,'HERDR_BRIDGE_CLAUDE_CWD='+cwd,
   'HERDR_BRIDGE_CONFIG='+configurationFile(config),'node',join(config.packageRoot,'dist/scripts/claude-host.js')];
  await execute('herdr',['pane','run',pane,args.map(quote).join(' ')],{env});
  for(let i=0;;i++){try{await access(socket+'.json');break}catch{if(i>50)throw Error('Native Claude terminal host did not start');await delay(200)}}
  const metadata=JSON.parse(await readFile(socket+'.json','utf8'));
  return routeSchema.parse({socket,herdrSocket:host.socket,pane,workspace,cwd:resolve(cwd),hostPid:metadata.hostPid});
 }catch(e){await transport.request(host.socket,'workspace.close',{workspace_id:workspace}).catch(()=>{});throw e}
}
export async function openNativeClaude(config:BridgeConfig,request:PluginSessionOpenRequest):Promise<PluginSessionOpenRequest>{
 if(!config.nativeClaude||request.provider!=='claude'||request.purpose==='history')return request;
 let route=await loadClaudeRoute(config,request.agentId);
 if(!route&&request.reason==='create')route=await createClaudeHost(config,request.cwd);
 if(!route)throw Error('No shared Herdr Claude executor is registered for this session');
 if(resolve(request.cwd)!==resolve(route.cwd))throw Error('Native Claude session cannot move to a different workspace');
 await assertClaudeRoute(config,route);
 const path=claudeRouteFile(config,request.agentId);await mkdir(join(config.paseoHome,'herdr-bridge/native-claude'),{recursive:true,mode:0o700});
 await writeFile(path,JSON.stringify(route),{mode:0o600});
 return {...request,env:{...request.env,HERDR_BRIDGE_CONFIG:configurationFile(config),HERDR_BRIDGE_PASEO_AGENT_ID:request.agentId,HERDR_BRIDGE_CLAUDE_SOCKET:route.socket,HERDR_BRIDGE_CLAUDE_ROUTE:path}};
}
