import { mkdir, readFile, writeFile, copyFile, symlink, access } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { readJsonLines } from '../server/jsonl.js';
import { configSchema } from '../server/config.js';
import { connectPaseo } from '../server/paseo.js';
import { transport } from '../server/herdr.js';

const execute=promisify(execFile),root=resolve(import.meta.dirname,'../..'),base=join(homedir(),'.hb');
const args=process.argv.slice(2), address=args[args.indexOf('--address')+1];
if(!args.includes('--address')||!address||!/^(127\.0\.0\.1|100\.\d+\.\d+\.\d+)$/.test(address))throw Error('Specify --address with this machine’s loopback or Tailscale IPv4');
if(root!==join(base,'app'))throw Error('Install only from the reviewed ~/.hb/app deployment copy');
const file=join(base,'config.json');
try{await access(file);throw Error('A deployment already exists; use its service controls instead of overwriting it');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
for(const folder of [base,join(base,'bin'),join(base,'logs'),join(base,'run'),join(base,'pi-sessions'),join(base,'workspace')])await mkdir(folder,{recursive:true,mode:0o700});
const path=process.env.PATH!;
const binaries:Record<string,string>={};
for(const kind of ['herdr','paseo','codex','claude','pi']){
 const found=(await execute('which',['-a',kind],{env:{...process.env,PATH:join(homedir(),'.local/bin')+':'+path}})).stdout.split('\n').find(p=>p&&!p.startsWith(join(base,'bin')+'/'));
 if(!found)throw Error('Missing '+kind);binaries[kind]=found;
}
const piModel=await new Promise<string>((ready,reject)=>{
 const child=spawn(binaries.pi!,['--mode','rpc','--no-session','--no-extensions'],{cwd:base,stdio:['pipe','pipe','pipe']});
 const timeout=setTimeout(()=>{child.kill();reject(Error('Pi default-model query timed out'));},20000);child.stderr.on('data',()=>{});child.once('error',reject);
 readJsonLines(child.stdout,m=>{if(m.type!=='response'||m.command!=='get_state')return;clearTimeout(timeout);child.kill();if(m.success&&m.data?.model?.provider&&m.data.model.id)ready(m.data.model.provider+'/'+m.data.model.id);else if(m.success&&args.includes('--allow-unconfigured-pi'))ready('unknown/unknown');else reject(Error('Pi has no configured default model'));},reject);
 child.stdin.write(JSON.stringify({type:'get_state',id:'deployment-model'})+'\n');
});
const herdrSocket=join(homedir(),'.config/herdr/sessions/paseo/herdr.sock');
const defaultSocket=join(homedir(),'.config/herdr/herdr.sock');
const config=configSchema.parse({herdr:[{name:'paseo',socket:herdrSocket},{name:'default',socket:defaultSocket}],transcriptRoots:{codex:join(homedir(),'.codex'),claude:join(homedir(),'.claude')},
 autoRegister:true,nativeCodex:true,nativeClaude:true,nativePi:true,terminalFrontend:'native',nativeTerminalProviders:{claude:true,pi:true},paseoHome:join(base,'paseo'),paseoUrl:'ws://'+address+':6795/ws',paseoPasswordFile:join(base,'password'),runtimeDirectory:join(base,'run'),packageRoot:root,workspaceRoots:[homedir()],
 launch:{codexHome:join(homedir(),'.codex'),codexCommand:binaries.codex,claudeCommand:binaries.claude,claudeModel:'claude-opus-5-5',piCommand:binaries.pi,piModel}});
await writeFile(file,JSON.stringify(config,null,2)+'\n',{mode:0o600});
await writeFile(join(base,'executables.json'),JSON.stringify({...binaries,path:join(homedir(),'.local/bin')+':'+path},null,2)+'\n',{mode:0o600});
await writeFile(join(base,'password'),randomBytes(24).toString('base64url')+'\n',{mode:0o600,flag:'wx'});
await writeFile(join(base,'herdr.toml'),'onboarding = false\n[session]\nresume_agents_on_restore = false\n',{mode:0o600});
await writeFile(join(base,'workspace/README.md'),'# Shared Herdr/Paseo deployment verification\n',{mode:0o600});
await execute('git',['init',join(base,'workspace')]);
await mkdir(config.paseoHome,{recursive:true,mode:0o700});
await writeFile(join(config.paseoHome,'config.json'),JSON.stringify({daemon:{listen:address+':6795',relay:{enabled:false}},pluginsEnabled:true,agents:{providers:{
 codex:{enabled:true,command:[join(root,'dist/scripts/codex-proxy.js')],env:{HERDR_BRIDGE_CONFIG:file,CODEX_HOME:config.launch.codexHome}},
 claude:{enabled:true,command:[join(root,'dist/scripts/claude-proxy.js')],env:{HERDR_BRIDGE_CONFIG:file}},
 pi:{enabled:true,command:[join(root,'dist/scripts/pi-proxy.js'),'--session-dir',join(base,'pi-sessions')],env:{HERDR_BRIDGE_CONFIG:file}},
 ...Object.fromEntries(['copilot','opencode','omp'].map(k=>[k,{enabled:false}]))}}},null,2)+'\n',{mode:0o600});
const {chmod}=await import('node:fs/promises');
for(const kind of ['codex','claude','pi']){
 await chmod(join(root,'dist/scripts/'+kind+'-proxy.js'),0o755);
 const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
 const script='#!/bin/sh\nexport HERDR_BRIDGE_CONFIG='+quote(file)+'\nexport PATH='+quote(dirname(process.execPath))+':"$PATH"\nexec '+quote(process.execPath)+' '+quote(join(root,'dist/scripts/bridge-entry.js'))+' '+kind+' "$@"\n';
 await writeFile(join(base,'bin',kind),script,{mode:0o700});
}
const q=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
await writeFile(join(base,'bin/hb'),'#!/bin/sh\nexport HERDR_BRIDGE_CONFIG='+q(file)+'\nexport HERDR_BRIDGE_BASE='+q(base)+'\nexec '+q(process.execPath)+' '+q(join(root,'dist/scripts/open.js'))+' "$@"\n',{mode:0o700});
await mkdir(join(homedir(),'.local/bin'),{recursive:true});
try{await symlink(join(base,'bin/hb'),join(homedir(),'.local/bin/hb'));}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
await symlink('hb',join(base,'bin/herdeo'));
try{await symlink(join(base,'bin/herdeo'),join(homedir(),'.local/bin/herdeo'));}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
const marker='# >>> herdr-paseo shared agents >>>';
for(const name of ['.zshrc','.bashrc']){
 const rc=join(homedir(),name);let original='';
 try{original=await readFile(rc,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 if(original.includes(marker))continue;
 if(original)await copyFile(rc,join(base,name.slice(1)+'.before-bridge'));
 const block='\n'+marker+'\nif [ "${HERDR_ENV:-}" = "1" ]; then\n  export PATH='+q(join(base,'bin'))+':"$PATH"\nfi\n# <<< herdr-paseo shared agents <<<\n';
 await writeFile(rc,original+block,{mode:0o600});
}
if(process.platform==='darwin'){
 const escape=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
 await mkdir(join(homedir(),'Library/LaunchAgents'),{recursive:true});
 for(const mode of ['herdr','paseo']){
  const label='dev.herdr-paseo.'+mode;
  const plist='<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>'+
   '<key>Label</key><string>'+label+'</string><key>ProgramArguments</key><array>'+[process.execPath,join(root,'dist/scripts/service.js'),mode].map(s=>'<string>'+escape(s)+'</string>').join('')+'</array>'+
   '<key>EnvironmentVariables</key><dict><key>HERDR_BRIDGE_CONFIG</key><string>'+escape(file)+'</string><key>HERDR_BRIDGE_BASE</key><string>'+escape(base)+'</string></dict>'+
   '<key>WorkingDirectory</key><string>'+escape(base)+'</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>'+escape(join(base,'logs',mode+'.log'))+'</string><key>StandardErrorPath</key><string>'+escape(join(base,'logs',mode+'.log'))+'</string></dict></plist>';
  const target=join(homedir(),'Library/LaunchAgents',label+'.plist');await writeFile(target,plist,{mode:0o600});
  await execute('launchctl',['bootstrap','gui/'+process.getuid!(),target]);
 }
}else if(process.platform==='linux'){
 const folder=join(homedir(),'.config/systemd/user');await mkdir(folder,{recursive:true});
 for(const mode of ['herdr','paseo']){
  const unit='[Unit]\nDescription=Shared Herdr Paseo '+mode+'\n[Service]\nType=simple\nEnvironment=HERDR_BRIDGE_CONFIG='+file+'\nEnvironment=HERDR_BRIDGE_BASE='+base+'\nExecStart='+JSON.stringify(process.execPath)+' '+JSON.stringify(join(root,'dist/scripts/service.js'))+' '+mode+'\nWorkingDirectory='+base+'\nRestart=on-failure\nRestartSec=3\n[Install]\nWantedBy=default.target\n';
  await writeFile(join(folder,'herdr-paseo-'+mode+'.service'),unit,{mode:0o600});
 }
 await execute('systemctl',['--user','daemon-reload']);
 await execute('systemctl',['--user','enable','--now','herdr-paseo-herdr.service','herdr-paseo-paseo.service']);
}else throw Error('Only macOS and Linux are supported');
for(let i=0;;i++){try{await transport.request(herdrSocket,'ping');const client=await connectPaseo(config);await client.close();break;}catch(error){if(i>100)throw error;await delay(300);}}
await execute(binaries.paseo!,['plugin','install',root,'--home',config.paseoHome],{env:{...process.env,HERDR_BRIDGE_CONFIG:file,PASEO_PASSWORD:(await readFile(join(base,'password'),'utf8')).trim()},timeout:60000});
console.log(JSON.stringify({installed:true,endpoint:config.paseoUrl,config:file,herdrSession:'paseo',providers:['codex','claude','pi'],piModel,persistentState:base,passwordFile:join(base,'password')}));
