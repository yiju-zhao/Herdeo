import {readFile,readdir,access,constants} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {hostname} from 'node:os';
import type {PaseoAgent} from '@getpaseo/client';
import type {BridgeConfig} from './config.js';
import {transport} from './herdr.js';
import {connectPaseo,includeKnownAgents} from './paseo.js';
import {validateTuiSession,tuiRequest,type TuiSession} from './tui-session.js';
import {routeDirectory,codexMetadata,type CodexRoute} from './codex-native.js';
import {verifyRelease} from './release.js';
import {productName,version} from './version.js';

type NativeStatus='alive'|'exited'|'unknown';
export interface SessionDiagnostic{
 key:string;provider:string;cwd:string;pane:string;nativeSessionId?:string;pid?:number;
 native:NativeStatus;channel:'ready'|'waiting'|'unavailable'|'unknown';
 activity:'working'|'permission'|'idle'|'unknown';view:'visible'|'archived'|'unregistered'|'rebound'|'unknown';
 agentId?:string;hint?:string;version?:string;startedAt?:string;endedAt?:string;
}
type Sources={herdr:typeof transport;connect:typeof connectPaseo;tui:typeof tuiRequest;codex?:typeof codexMetadata};
function persistedKey(agent:PaseoAgent){try{return agent.persistence?.sessionId?.startsWith('plugin:')?JSON.parse(agent.persistence.sessionId.slice(7)).data?.key:undefined;}catch{return undefined;}}
async function records<T>(folder:string,decorate?:(value:T,file:string)=>T):Promise<{values:T[];damaged:number}>{
 let names:string[];try{names=await readdir(folder);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {values:[],damaged:0};throw error;}
 const values:T[]=[];let damaged=0;
 for(const name of names.filter(n=>n.endsWith('.json'))){try{const value=JSON.parse(await readFile(join(folder,name),'utf8'));values.push(decorate?decorate(value,name):value);}catch{damaged++;}}
 return {values,damaged};
}

/** Read-only: no provider refresh, prompt, archive, process launch or agent creation. */
export async function diagnose(cfg:BridgeConfig,sources:Sources={herdr:transport,connect:connectPaseo,tui:tuiRequest}){
 const [tui,codex,release,herdr,cli]=await Promise.all([
  records<TuiSession>(join(cfg.paseoHome,'herdr-bridge/native-tui')),
  records<CodexRoute&{paseoAgentId?:string}>(join(routeDirectory(cfg),'agents'),(route,name)=>({...route,paseoAgentId:name.slice(0,-5)})),
  verifyRelease(cfg.packageRoot),
  Promise.all(cfg.herdr.map(async h=>{try{await sources.herdr.request(h.socket,'ping');return {name:h.name,socket:h.socket,connected:true};}catch{return {name:h.name,socket:h.socket,connected:false};}})),
  Promise.all((['claude','codex','pi'] as const).map(async kind=>{const path=cfg.launch[`${kind}Command`];try{if(!path)throw Error();await access(path,constants.X_OK);return {provider:kind,installed:true};}catch{return {provider:kind,installed:false};}})),
 ]);
 let connected=false;const agents:PaseoAgent[]=[];let paseoIssue:string|undefined;
 try{
  const client=await sources.connect(cfg);
  try{let cursor:string|undefined;do{const page=await client.agents.list({filter:{includeArchived:true},page:{limit:100,cursor}});agents.push(...page.entries.map(e=>e.agent));cursor=page.pageInfo.nextCursor??undefined;}while(cursor);const known=await includeKnownAgents(client,agents,[...tui.values.map(s=>s.paseoAgentId),...codex.values.map(s=>s.paseoAgentId)]);agents.splice(0,agents.length,...known);connected=true;}
  finally{await client.close();}
 }catch(error){
  const text=String((error as Error).message);
  paseoIssue=/credential|endpoint|daemon home|ENOENT/i.test(text)?'检查本机专属 Paseo 服务及其配置；连接地址必须与该 daemon home 相符。':/auth|password|unauthor|forbidden/i.test(text)?'认证失败：在手机重新填写本机 herdeo connection 显示的连接信息。':'Paseo 未连通：检查专属 6795 服务和本机 Tailscale 地址。';
 }
 const sessions:SessionDiagnostic[]=[];let damaged=tui.damaged+codex.damaged;
 const work=[...tui.values.map(state=>({state})),...codex.values.map(route=>({route}))] as Array<{state?:TuiSession;route?:CodexRoute}>;
 // Small batches avoid flooding Herdr when many archived generations exist.
 for(let offset=0;offset<work.length;offset+=8)await Promise.all(work.slice(offset,offset+8).map(async({state,route})=>{
  try{
   if(state)validateTuiSession(cfg,state);
   const key=state?.key??route!.key,provider=state?.kind??'codex',herdrSocket=state?.herdrSocket??route!.herdrSocket,pane=state?.pane??route!.pane;
   if(typeof key!=='string'||typeof pane!=='string'||!cfg.herdr.some(h=>h.socket===herdrSocket))throw Error('Invalid binding');
   const session:SessionDiagnostic={key,provider,cwd:state?.cwd??route!.cwd,pane,nativeSessionId:state?.nativeSessionId??route?.nativeId,pid:state?.cliPid??route?.pid,native:'unknown',channel:'unknown',activity:'unknown',view:connected?'unregistered':'unknown',version:state?.version,startedAt:state?.startedAt,endedAt:state?.endedAt};
   const agent=agents.find(a=>a.provider===provider+'-terminal'&&(persistedKey(a)??a.labels?.['herdr.native-tui'])===key)
    ??(provider==='codex'?agents.find(a=>a.provider==='codex'&&a.labels?.['herdr.session-key']===key):undefined)
    ??agents.find(a=>a.id===state?.paseoAgentId);
   if(agent){session.agentId=agent.id;const currentKey=persistedKey(agent)??agent.labels?.['herdr.native-tui'];session.view=state&&currentKey&&currentKey!==key?'rebound':agent.archivedAt?'archived':'visible';}
   if(herdr.find(h=>h.socket===herdrSocket)?.connected){
    try{
     const info=await sources.herdr.request<any>(herdrSocket,'pane.process_info',{pane_id:pane});
     const pids=new Set(info.process_info.foreground_processes.map((p:any)=>p.pid));
     session.native=(state?pids.has(state.hostPid)&&!!state.cliPid&&pids.has(state.cliPid):pids.has(route!.pid))?'alive':'exited';
    }catch(error){if(/not found|unknown pane|does not exist/i.test(String((error as Error).message)))session.native='exited';}
   }else if(state?.endedAt)session.native='exited';
   if(session.native==='alive'){
    if(state){
     try{const snapshot=await sources.tui(state,'snapshot');session.channel=snapshot.state.invalidated?'unavailable':snapshot.state.ready?'ready':'waiting';session.activity=snapshot.permissions?.length?'permission':snapshot.turnId?'working':'idle';}
     catch{session.channel='unavailable';}
    }else{
     try{const metadata=await (sources.codex??codexMetadata)(route!.socket);try{const loaded=await metadata.request('thread/loaded/list');session.channel=loaded.data?.includes(route!.nativeId)?'ready':'unavailable';}finally{metadata.close();}}catch{session.channel='unavailable';}
     session.activity=agent?.pendingPermissions?.length?'permission':agent?.status==='running'?'working':agent?'idle':'unknown';
    }
   }else if(session.native==='exited')session.channel='unavailable';
   if(session.native==='exited')session.hint='CLI 已退出，历史仍保留；先在 Herdr 中 resume 原会话，再从 Paseo 继续。';
   else if(session.native==='unknown')session.hint='尚未确认原生进程状态；先检查对应 Herdr 服务。';
   else if(session.channel==='waiting')session.hint=provider==='claude'?'在 Herdr 完成 Claude 登录、目录信任或开发通道确认。':'在 Herdr 完成 Pi 初始化、/login 和模型选择。';
   else if(session.channel==='unavailable')session.hint='原生进程仍在，但桥接通道不可用；查看 Herdr，若切换了会话请重新启动该 CLI。';
   else if(provider==='pi'&&(!state?.model||state.model==='unknown/unknown'))session.hint='Pi 尚无可用模型；先在原生界面 /login 并选择模型。';
   else if(session.view==='archived')session.hint='Paseo 会话已归档；在 History 中 Unarchive。原生 CLI 仍在运行。';
   else if(session.view==='unregistered')session.hint=state?.registrationError?'自动注册尚未成功；检查 Paseo 服务和插件，CLI 可继续使用。':'尚未注册到 Paseo；等待初始化及自动注册。';
   else if(session.activity==='permission')session.hint='正在等待授权；可在 Herdr 或 Paseo 回答当前请求。';
   if(state&&!state.version&&session.native==='alive')session.hint=(session.hint?session.hint+' ':'')+'此进程由旧版本启动，新会话会使用当前 Herdeo。';
   sessions.push(session);
  }catch{damaged++;}
 }));
 return {product:productName,version,host:hostname(),endpoint:cfg.paseoUrl,release,herdr,cli,paseo:{connected,hint:paseoIssue},damagedRecords:damaged,sessions:sessions.sort((a,b)=>(b.startedAt??'').localeCompare(a.startedAt??''))};
}
export type DiagnosticReport=Awaited<ReturnType<typeof diagnose>>;

export function formatDiagnostics(report:DiagnosticReport,all=false){
 const lines=[`${report.product} ${report.version} · ${report.host}`,`Paseo：${report.paseo.connected?'已连接并认证':'不可用'} · ${report.endpoint}`,`发布校验：${({verified:'通过',missing:'未生成发布清单',invalid:'清单无效',mismatch:'文件与发布清单不一致'} as const)[report.release.status]}`];
 for(const h of report.herdr)lines.push(`Herdr ${h.name}：${h.connected?'已连接':'不可用'}`);
 for(const c of report.cli)lines.push(`${c.provider} CLI：${c.installed?'已安装':'路径无效或未安装'}`);
 if(report.paseo.hint)lines.push(report.paseo.hint);
 const seen=new Set<string>();let hidden=0;
 for(const s of report.sessions){
  const conversation=s.provider+'\0'+s.cwd+'\0'+(s.nativeSessionId??s.key);
  if(!all&&s.native==='exited'&&(seen.has(conversation)||s.view!=='visible')){hidden++;continue;}
  seen.add(conversation);
  lines.push(`\n${s.provider} · ${basename(s.cwd)} · ${s.pane} · ${s.key.slice(0,8)}`);
  lines.push(`  CLI：${{alive:'运行中',exited:'已退出',unknown:'状态未知'}[s.native]}｜通道：${{ready:'就绪',waiting:'等待初始化',unavailable:'不可用',unknown:'未知'}[s.channel]}｜Paseo：${{visible:'可见',archived:'已归档',unregistered:'未注册',rebound:'已转到续接进程',unknown:'未知'}[s.view]}｜任务：${{working:'执行中',permission:'等待授权',idle:'空闲',unknown:'未知'}[s.activity]}`);
  if(s.hint)lines.push('  '+s.hint);
 }
 if(!report.sessions.length)lines.push('\n当前没有桥接会话。在 Herdr 项目目录直接运行 claude / codex / pi。');
 if(hidden)lines.push(`\n另有 ${hidden} 条已退出的历史绑定；用 herdeo doctor --all 查看。`);
 if(report.damagedRecords)lines.push(`\n发现 ${report.damagedRecords} 条无效绑定记录，诊断已跳过。`);
 lines.push('\n此检查只读取本机状态。手机连不上时，还需检查手机 Tailscale 和该 Host 的地址、端口及密码。');
 return lines.join('\n');
}
