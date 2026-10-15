import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { configSchema } from '../server/config.js';
import { connectPaseo } from '../server/paseo.js';

const execute=promisify(execFile);const root=resolve(import.meta.dirname,'..');
const evidence=JSON.parse(await readFile(join(root,'.dev/claude-paseo-evidence.json'),'utf8'));
const home=evidence.paseoHome;
if(home!=='/private/tmp/hpc-'+process.getuid!()+'/paseo'||evidence.paseoUrl!=='ws://127.0.0.1:6797/ws')throw Error('Only the independent Claude proof instance can be upgraded');
const cwd=join(root,'.dev/workspace');const file=join(root,'.dev/claude-native.json');
let previous:Record<string,unknown>={};
try{previous=JSON.parse(await readFile(file,'utf8'));if(previous.paseoHome!==home)throw Error('Existing native configuration belongs to a different test home');}
catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
const config=configSchema.parse({...previous,herdr:[{name:'claude-native-development',socket:evidence.herdrSocket}],transcriptRoots:{codex:'/tmp/unused',claude:join(root,'.dev/claude')},
 paseoHome:home,paseoUrl:evidence.paseoUrl,packageRoot:root,workspaceRoots:[cwd],autoRegister:false,nativeClaude:true});
await writeFile(file,JSON.stringify(config,null,2)+'\n',{mode:0o600});
const folder=join(home,'herdr-bridge/native-claude');await mkdir(folder,{recursive:true,mode:0o700});
const metadata=JSON.parse(await readFile(evidence.socket+'.json','utf8'));
await writeFile(join(folder,evidence.paseoAgentId+'.json'),JSON.stringify({socket:evidence.socket,herdrSocket:evidence.herdrSocket,pane:evidence.pane,workspace:evidence.pane.split(':')[0],cwd,hostPid:metadata.hostPid}),{mode:0o600});
const proxy=join(root,'dist/scripts/claude-proxy.js');await chmod(proxy,0o755);
const env:NodeJS.ProcessEnv={...process.env,HERDR_BRIDGE_CONFIG:file};for(const name of ['PASEO_HOST','PASEO_PASSWORD','PASEO_LISTEN','PORT'])delete env[name];
await execute('paseo',['daemon','stop','--home',home],{env,timeout:30000});
const stored=JSON.parse(await readFile(join(home,'config.json'),'utf8'));
await execute('paseo',['daemon','config','set','agents.providers',JSON.stringify({...Object.fromEntries(['codex','pi','copilot','opencode','omp'].map(name=>[name,{enabled:false}])),...stored.agents?.providers,
 claude:{enabled:true,command:[proxy],env:{HERDR_BRIDGE_CONFIG:file}}}),'--home',home],{env,timeout:30000});
await execute('paseo',['daemon','config','set','pluginsEnabled','true','--home',home],{env,timeout:30000});
const server=spawn('paseo',['daemon','run','--home',home],{env,cwd:root,stdio:'ignore',detached:true});server.unref();
for(let i=0;;i++){try{const client=await connectPaseo(config);await client.close();break}catch(e){if(i>50)throw e;await delay(300)}}
await execute('paseo',['plugin','install',root,'--home',home],{env,timeout:60000});
console.log('Per-session native Claude routing ready on 127.0.0.1:6797; existing executor retained.');
