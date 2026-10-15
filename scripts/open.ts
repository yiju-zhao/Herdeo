import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { readConfig } from '../server/config.js';
import { diagnose, formatDiagnostics } from '../server/diagnostics.js';
import { productName, version } from '../server/version.js';

const help=`${productName} ${version} — Herdr 中的原生 agent，随时从 Paseo 接手。

herdeo doctor [--json] [--all]  检查连接、原生 CLI、通道及归档状态
herdeo status [--json] [--all]  查看相同的会话状态
herdeo start claude|codex|pi [--cwd DIRECTORY] [CLI 参数]
herdeo attach                 打开专属 Herdr paseo 界面
herdeo connection             显示本机连接信息（含私密密码）
herdeo restart                仅重启专属 Paseo，保留 Herdr 进程
herdeo version                显示版本

在 Herdr 的项目目录直接运行 claude / codex / pi 即可。
hb 与 herdeo 完全兼容。Paseo 中恢复归档不会自动拉起已退出的 CLI。`;
const command=process.argv[2];
if(['help','--help','-h'].includes(command??'')){console.log(help);process.exit(0);}
if(['version','--version','-v'].includes(command??'')){console.log(productName+' '+version);process.exit(0);}
if(command&&!['connection','pair','restart','status','doctor','start','native','shared','attach'].includes(command)){
 console.error(`未知命令：${command}\n\n${help}`);process.exit(2);
}
const config = readConfig(), base = process.env.HERDR_BRIDGE_BASE??dirname(config.paseoHome);
if(['doctor','status'].includes(command??'')){
 const args=process.argv.slice(3);if(args.some(a=>!['--json','--all'].includes(a))){console.error('Usage: herdeo doctor|status [--json] [--all]');process.exit(2);}
 const report=await diagnose(config);console.log(args.includes('--json')?JSON.stringify(report,null,2):formatDiagnostics(report,args.includes('--all')));
 process.exitCode=report.paseo.connected&&report.herdr[0]?.connected&&!['invalid','mismatch'].includes(report.release.status)?0:1;
}else{
const executables = JSON.parse(await readFile(join(base, 'executables.json'), 'utf8'));
const env: NodeJS.ProcessEnv = {...process.env, HERDR_SOCKET_PATH: config.herdr[0]!.socket, HERDR_ENV: '1', HERDR_CONFIG_PATH: join(base, 'herdr.toml'), PATH: join(base, 'bin') + ':' + executables.path};
if(process.argv[2]==='connection'){
 const url=new URL(config.paseoUrl);
 console.log('Host: '+url.hostname+'\nPort: '+url.port+'\nSSL: off\nPassword: '+(await readFile(config.paseoPasswordFile!,'utf8')).trim());
}else if(['pair','restart'].includes(process.argv[2]??'')){
 env.PASEO_PASSWORD=(await readFile(config.paseoPasswordFile!,'utf8')).trim();
 const child=spawn(executables.paseo,['daemon',process.argv[2]!,'--home',config.paseoHome,...process.argv.slice(3)],{env,stdio:'inherit'});
 child.once('exit',code=>{process.exitCode=code??1;});
} else if (['start','native','shared'].includes(process.argv[2]??'')) {
 const kind = process.argv[3]; if(!['claude','codex','pi'].includes(kind??''))throw Error('Usage: hb start|native|shared claude|codex|pi [--cwd DIRECTORY]');
 const args=process.argv.slice(4);const at=args.indexOf('--cwd');if(at>=0&&(!args[at+1]||args[at+1]!.startsWith('--')))throw Error('--cwd requires a project directory');const cwd=at<0?process.cwd():resolve(args.splice(at,2)[1]!);
 let frontend=process.argv[2]==='native'?'native':process.argv[2]==='shared'?'shared':undefined;
 const nativeAt=args.indexOf('--native'),sharedAt=args.indexOf('--shared');
 if(nativeAt>=0&&sharedAt>=0)throw Error('Choose --native or --shared');
 if(nativeAt>=0){args.splice(nativeAt,1);frontend='native';}
 if(sharedAt>=0){args.splice(sharedAt,1);frontend='shared';}
 const execute=promisify(execFile);const created=JSON.parse((await execute(executables.herdr,['workspace','create','--cwd',cwd,'--label',kind!,'--no-focus'],{env})).stdout);
 const pane=created.result.root_pane.pane_id;
 const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
 const command=[...(frontend?['env','HERDR_BRIDGE_TERMINAL_UI='+frontend]:[]),process.execPath,join(config.packageRoot,'dist/scripts/bridge-entry.js'),kind!,...args];
 await execute(executables.herdr,['pane','run',pane,command.map(quote).join(' ')],{env});
 console.log(JSON.stringify({pane,provider:kind,frontend:frontend??config.terminalFrontend,endpoint:config.paseoUrl}));
} else if(!command&&process.env.HERDR_ENV==='1'){
 console.log('当前已在 Herdr 中。直接运行 claude / codex / pi；用 herdeo doctor 检查同步状态。\n若需打开专属 Herdr paseo 界面，运行 herdeo attach。');
} else {
 delete env.HERDR_SOCKET_PATH; delete env.HERDR_ENV;
 const child=spawn(executables.herdr,['--session','paseo'],{env,stdio:'inherit'});
 child.once('exit',code=>{process.exitCode=code??1;});
}
}
