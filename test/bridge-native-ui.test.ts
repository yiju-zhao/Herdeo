import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';

const root=resolve(import.meta.dirname,'..');
const ptyRunner=String.raw`
import os,pty,subprocess,select,sys,time,json,signal
request=json.loads(sys.stdin.read())
master,slave=pty.openpty()
env=dict(os.environ);env.update(request['env'])
p=subprocess.Popen(request['command'],stdin=slave,stdout=slave,stderr=slave,env=env,cwd=request['cwd'],start_new_session=True)
os.close(slave);data=bytearray();deadline=time.monotonic()+12
while time.monotonic()<deadline:
 if select.select([master],[],[],0.1)[0]:
  try:
   chunk=os.read(master,65536)
   if not chunk:break
   data.extend(chunk)
  except OSError:break
 if p.poll() is not None:
  while select.select([master],[],[],0)[0]:
   try:data.extend(os.read(master,65536))
   except OSError:break
  break
if p.poll() is None:
 try:os.killpg(p.pid,signal.SIGTERM)
 except ProcessLookupError:pass
p.wait(timeout=5);os.close(master)
print(json.dumps({'status':p.returncode,'output':data.decode('utf-8','replace')}))
`;
for(const kind of ['claude','pi'])test('native '+kind+' launch in a real Herdr-like PTY preserves the original interactive CLI and its arguments',async()=>{
 const dir=await realpath(await mkdtemp(join(tmpdir(),'hb-native-ui-')));
 try{
  const cli=join(dir,'original-cli');
  await writeFile(cli,'#!/usr/bin/env node\nconsole.log("NATIVE_ORIGINAL "+JSON.stringify({tty:!!process.stdin.isTTY&&!!process.stdout.isTTY,args:process.argv.slice(2)}));\n',{mode:0o700});
  const config=join(dir,'config.json');
  await writeFile(config,JSON.stringify({terminalFrontend:'native',herdr:[{name:'fixture',socket:join(dir,'herdr.sock')}],transcriptRoots:{codex:dir,claude:dir},paseoHome:join(dir,'paseo'),paseoUrl:'ws://127.0.0.1:6795/ws',runtimeDirectory:join(dir,'runtime'),packageRoot:root,workspaceRoots:[dir],nativeClaude:true,nativePi:true,launch:{claudeCommand:cli,piCommand:cli,piModel:'fixture/model'}}));
  const args=kind==='claude'?['--model','opus']:['--model','fixture/model'];
  const actual=JSON.parse(execFileSync('python3',['-c',ptyRunner],{input:JSON.stringify({command:[process.execPath,'--import',import.meta.resolve('tsx'),join(root,'scripts/bridge-entry.ts'),kind,...args],cwd:dir,env:{HERDR_BRIDGE_CONFIG:config,HERDR_ENV:'1',HERDR_SOCKET_PATH:join(dir,'herdr.sock'),HERDR_PANE_ID:'w1:p1',HERDR_WORKSPACE_ID:'w1'}}),encoding:'utf8',timeout:18000}));
  assert.equal(actual.status,0,actual.output);
  const row=actual.output.split(/\r?\n/).find((s:string)=>s.startsWith('NATIVE_ORIGINAL '));
  assert.ok(row,'Herdr launched the simplified bridge frontend instead of the original '+kind+' CLI:\n'+actual.output);
  assert.deepEqual(JSON.parse(row.slice('NATIVE_ORIGINAL '.length)),{tty:true,args});
 }finally{await rm(dir,{recursive:true,force:true});}
});
