import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, access, readFile, writeFile, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { transport } from '../server/herdr.js';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const runtime = '/private/tmp/hpc-' + process.getuid!();
const xdg = join(runtime, 'config');
const herdrSocket = join(xdg, 'herdr/sessions/claude-native-development/herdr.sock');
const cwd = join(root, '.dev/workspace');
await mkdir(xdg, { recursive: true, mode: 0o700 });
try { await transport.request(herdrSocket, 'ping'); }
catch {
  const server = spawn('herdr', ['--session', 'claude-native-development', 'server'], { cwd, env: { ...process.env, XDG_CONFIG_HOME: xdg }, stdio: 'ignore', detached: true });
  server.unref();
  for (let attempt=0;;attempt++) { try { await transport.request(herdrSocket, 'ping'); break; } catch { if(attempt>50)throw Error('Test Herdr did not start');await delay(200); } }
}
const env: NodeJS.ProcessEnv = { ...process.env, HERDR_SOCKET_PATH: herdrSocket, HERDR_ENV: '1' };
for(const name of ['HERDR_PANE_ID','HERDR_WORKSPACE_ID','HERDR_TAB_ID','CLAUDECODE','CLAUDE_CODE_SESSION_ID'])delete env[name];
const result=JSON.parse((await execute('herdr',['workspace','create','--cwd',cwd,'--label','Claude shared SDK validation','--no-focus'],{env})).stdout);
const pane=result.result.root_pane.pane_id;
const socket=join(runtime,randomUUID().slice(0,8)+'.sock');
const quote=(text:string)=>"'"+text.replaceAll("'","'\\''")+"'";
const command=['env','HERDR_BRIDGE_CLAUDE_SOCKET='+socket,'HERDR_BRIDGE_CLAUDE_CWD='+cwd,'node',join(root,'dist/scripts/claude-host.js')].map(quote).join(' ');
await execute('herdr',['pane','run',pane,command],{env});
for(let attempt=0;;attempt++){try{await access(socket);break}catch{if(attempt>50)throw Error('Claude host did not start');await delay(200)}}
const proxy=join(root,'dist/scripts/claude-proxy.js');await chmod(proxy,0o755);
const nativeSessionId=randomUUID();
const evidence: unknown[]=[];
let firstPid:number|undefined;
for(const phase of ['first','reconnected']){
  const messages:SDKUserMessage[]=[];let wake:(()=>void)|undefined;let closed=false;
  async function* input(){while(!closed){if(!messages.length)await new Promise<void>(resolveWake=>{wake=resolveWake});while(messages.length)yield messages.shift()!;}}
  const instance=query({prompt:input(),options:{cwd,pathToClaudeCodeExecutable:'claude',includePartialMessages:true,
    permissionMode:'default',...(phase==='first'?{sessionId:nativeSessionId}:{resume:nativeSessionId}),
    spawnClaudeCodeProcess: options=>spawn(proxy,options.args,{cwd,env:{...options.env,HERDR_BRIDGE_CLAUDE_SOCKET:socket},stdio:['pipe','pipe','pipe']}),
    canUseTool:async(_tool,input)=>({behavior:'deny',message:'The transport check does not permit tool execution.'}),
  }});
  try{
    await instance.initializationResult();
    const metadata=JSON.parse(await readFile(socket+'.json','utf8'));
    assert.ok(metadata.enginePid);
    firstPid??=metadata.enginePid;assert.equal(metadata.enginePid,firstPid);
    const marker='HPB_CLAUDE_'+phase.toUpperCase()+'_'+Date.now().toString(36).toUpperCase();
    messages.push({type:'user',message:{role:'user',content:'Reply exactly '+marker+'. Do not use tools, read files, or change anything.'},parent_tool_use_id:null,session_id:nativeSessionId});wake?.();
    let text='';let partials=0;let sid:string|undefined;
    for await(const event of instance){
      sid=event.session_id;
      if(event.type==='stream_event')partials++;
      if(event.type==='assistant')for(const block of event.message.content)if(block.type==='text')text+=block.text;
      if(event.type==='result'){assert.equal(event.subtype,'success');break;}
    }
    assert.ok(text.includes(marker));assert.equal(sid,nativeSessionId);
    const current=JSON.parse(await readFile(socket+'.json','utf8'));assert.equal(current.enginePid,firstPid);
    evidence.push({phase,pane,nativeSessionId,enginePid:firstPid,partialEvents:partials,replyMatches:true});
    console.log('PASS: '+phase+' SDK frontend uses original Claude PID/session and genuine partial events.');
  }finally{closed=true;wake?.();instance.close();}
  await delay(500);
}
await writeFile(join(root,'.dev/claude-wire-evidence.json'),JSON.stringify({herdrSocket,socket,evidence},null,2)+'\n');
console.log('Herdr terminal retained at '+pane+' in claude-native-development.');
