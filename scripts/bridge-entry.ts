#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { readConfig, inScope } from '../server/config.js';
import { isDirectCliInvocation } from '../server/cli-invocation.js';

const kind = process.argv[2], args = process.argv.slice(3), config = readConfig();
if (!['codex', 'claude', 'pi'].includes(kind ?? '')) throw Error('Choose codex, claude or pi');
const real = kind === 'codex' ? config.launch.codexCommand : kind === 'claude' ? config.launch.claudeCommand : config.launch.piCommand;
if (!real) throw Error('The original CLI path is not configured');
const managed = process.env.HERDR_ENV === '1' && config.herdr.some(h => h.socket === process.env.HERDR_SOCKET_PATH) && process.stdin.isTTY && process.stdout.isTTY;
const probe = isDirectCliInvocation(kind!,args);
let command = real, argv = args;
const env: NodeJS.ProcessEnv = {...process.env};
const frontend=process.env.HERDR_BRIDGE_TERMINAL_UI??config.terminalFrontend;
if(frontend!=='native'&&frontend!=='shared')throw Error('Unknown terminal frontend');
if(managed&&!probe&&(kind==='claude'||kind==='pi')&&config.nativeTerminalProviders[kind]&&frontend==='native'){
  if(!inScope(config,process.cwd()))throw Error('This project is outside the configured bridge workspace roots');
  command=process.execPath;argv=[join(config.packageRoot,'dist/scripts/tui-host.js'),kind,...args];
}else if (managed && !probe && (kind==='codex'||frontend==='shared')) {
  if (!inScope(config, process.cwd())) throw Error('This directory is outside the shared bridge workspace roots');
  if (kind === 'codex') { command = process.execPath; argv = [join(config.packageRoot, 'dist/scripts/codex-terminal.js'), ...args]; }
  else {
    const prompt: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const flag = args[i]!;
      if (flag === '--model' && args[i + 1]) env.HERDR_BRIDGE_AGENT_MODEL = args[++i];
      else if (flag === '--thinking' && kind === 'pi' && args[i + 1]) env.HERDR_BRIDGE_AGENT_THINKING = args[++i];
      else if (flag === '--permission-mode' && kind === 'claude' && args[i + 1]) env.HERDR_BRIDGE_AGENT_MODE = args[++i];
      else if (flag === '--dangerously-skip-permissions' && kind === 'claude') env.HERDR_BRIDGE_AGENT_MODE = 'bypassPermissions';
      else if (flag === '--') prompt.push(...args.slice(i + 1));
      else if (flag.startsWith('-')) throw Error('This shared terminal does not support ' + flag + '. Use the corresponding Paseo control or invoke the original CLI explicitly.');
      else prompt.push(flag);
      if (flag === '--') break;
    }
    if (kind === 'pi' && env.HERDR_BRIDGE_AGENT_MODEL && !env.HERDR_BRIDGE_AGENT_MODEL.includes('/')) env.HERDR_BRIDGE_AGENT_MODEL = config.launch.piModel!.split('/')[0] + '/' + env.HERDR_BRIDGE_AGENT_MODEL;
    if (prompt.length) env.HERDR_BRIDGE_INITIAL_PROMPT = prompt.join(' ');
    env[kind === 'pi' ? 'HERDR_BRIDGE_PI_REGISTER' : 'HERDR_BRIDGE_CLAUDE_REGISTER'] = '1';
    env[kind === 'pi' ? 'HERDR_BRIDGE_PI_CWD' : 'HERDR_BRIDGE_CLAUDE_CWD'] = resolve(process.cwd());
    command = process.execPath; argv = [join(config.packageRoot, 'dist/scripts/' + kind + '-host.js')];
  }
}
const child = spawn(command, argv, {stdio: 'inherit', env});
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 128 : 1); });
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => child.kill(signal));
