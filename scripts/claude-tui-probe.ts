/** Diagnostic channel-only prototype. Production uses tui-host.ts; probe data stays under ~/.hb/probes. */
import {createServer,type Socket} from 'node:net';
import {spawn,execFile} from 'node:child_process';
import {readFile,writeFile,mkdir,chmod,open} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import {readJsonLines} from '../server/jsonl.js';
import {readConfig,bridgeRuntime} from '../server/config.js';

const cfg=readConfig(),base=join(homedir(),'.hb');
if(process.argv[2]==='serve'){
 const socketPath=process.argv[3]!,folder=process.argv[4]!;
 if(!socketPath.startsWith(bridgeRuntime(cfg)+'/')||!folder.startsWith(join(base,'probes')+'/'))throw Error('Only this deployment’s owned probe paths are allowed');
 let channel:Socket|undefined,sessionId:string|undefined,cliPid:number|undefined,ready=false,lastAssistant='',text='';
 const hookCounts:Record<string,number>={},permissions:any[]=[];
 const snapshot=()=>({sessionId,cliPid,channelReady:ready,hookCounts,lastAssistant,text,permissions});
 const server=createServer(client=>{
  readJsonLines(client,frame=>{
   if(frame.type==='channel.hello'){channel=client;cliPid=frame.parentPid;}
   else if(frame.type==='channel.ready')ready=true;
   else if(frame.type==='channel.permission')permissions.push(frame.params);
   else if(frame.type==='hook.event'){
    const p=frame.payload;
    if(sessionId&&p.session_id!==sessionId)throw Error('The probe cannot switch native sessions');
    sessionId=p.session_id;hookCounts[p.hook_event_name]=(hookCounts[p.hook_event_name]??0)+1;
    if(p.hook_event_name==='MessageDisplay')text+=p.delta??'';
    if(p.hook_event_name==='Stop')lastAssistant=p.last_assistant_message??'';
    client.end(JSON.stringify({ok:true})+'\n');
    void writeFile(join(folder,'metadata.json'),JSON.stringify({sessionId,cliPid,channelReady:ready,hookCounts},null,2)+'\n',{mode:0o600});
   }else if(frame.type==='probe.read')client.end(JSON.stringify(snapshot())+'\n');
   else if(frame.type==='probe.prompt'){
    if(!channel||!ready||typeof frame.text!=='string')throw Error('Native channel is not ready');
    channel.write(JSON.stringify({type:'channel.notification',notification:{jsonrpc:'2.0',method:'notifications/claude/channel',params:{content:frame.text,meta:{source:'paseo_native_ui_probe'}}}})+'\n');
    client.end(JSON.stringify({queued:true})+'\n');
   }else if(frame.type==='probe.permission'){
    if(!permissions.some(p=>p.request_id===frame.id)||!['allow','deny'].includes(frame.behavior))throw Error('No matching native permission');
    channel!.write(JSON.stringify({type:'channel.notification',notification:{jsonrpc:'2.0',method:'notifications/claude/channel/permission',params:{request_id:frame.id,behavior:frame.behavior}}})+'\n');
    client.end(JSON.stringify({sent:true})+'\n');
   }else throw Error('Unknown native TUI probe record');
  },error=>client.end(JSON.stringify({error:error.message})+'\n'));
  client.on('error',()=>{});
  client.once('close',()=>{if(client===channel){channel=undefined;ready=false;}});
 });
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});await chmod(socketPath,0o600);
 for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{server.close();process.exit(0);});
}else{
 const id=randomUUID().slice(0,8),folder=join(base,'probes','claude-tui-'+id),socket=join(bridgeRuntime(cfg),'tui-'+id+'.sock');
 await mkdir(folder,{recursive:true,mode:0o700});
 const log=await open(join(folder,'probe.log'),'a',0o600);
 const broker=spawn(process.execPath,[join(cfg.packageRoot,'dist/scripts/claude-tui-probe.js'),'serve',socket,folder],{env:process.env,stdio:['ignore',log.fd,log.fd],detached:true});broker.unref();await log.close();
 const q=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
 const hookCommand=[process.execPath,join(cfg.packageRoot,'dist/scripts/claude-tui-hook.js')].map(q).join(' ');
 const hooks=Object.fromEntries(['SessionStart','UserPromptSubmit','MessageDisplay','Stop','PermissionDenied','PostToolUse'].map(event=>[event,[{hooks:[{type:'command',command:hookCommand,timeout:2}]}]]));
 await writeFile(join(folder,'settings.json'),JSON.stringify({hooks},null,2)+'\n',{mode:0o600});
 const name='paseo_native_probe';
 await writeFile(join(folder,'mcp.json'),JSON.stringify({mcpServers:{[name]:{command:process.execPath,args:[join(cfg.packageRoot,'dist/scripts/claude-tui-channel.js')],env:{HERDR_BRIDGE_TUI_SOCKET:socket}}}},null,2)+'\n',{mode:0o600});
 const execute=promisify(execFile),bins=JSON.parse(await readFile(join(base,'executables.json'),'utf8'));
 const env:NodeJS.ProcessEnv={...process.env,HERDR_ENV:'1',HERDR_SOCKET_PATH:cfg.herdr[0]!.socket};
 for(const key of ['HERDR_PANE_ID','HERDR_WORKSPACE_ID','HERDR_TAB_ID'])delete env[key];
 const created=JSON.parse((await execute(bins.herdr,['workspace','create','--cwd',join(base,'workspace'),'--label','Claude native TUI probe','--no-focus'],{env})).stdout);
 const pane=created.result.root_pane.pane_id;
 const args=['env','HERDR_BRIDGE_TUI_SOCKET='+socket,cfg.launch.claudeCommand!,'--settings',join(folder,'settings.json'),'--mcp-config',join(folder,'mcp.json'),'--dangerously-load-development-channels','server:'+name,'--permission-mode','default'];
 await execute(bins.herdr,['pane','run',pane,args.map(q).join(' ')],{env});
 const descriptor={pane,workspace:created.result.workspace.workspace_id,socket,folder,brokerPid:broker.pid,herdrSocket:cfg.herdr[0]!.socket};
 await writeFile(join(folder,'probe.json'),JSON.stringify(descriptor,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify(descriptor));
}
