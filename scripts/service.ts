import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from '../server/config.js';
import { transport } from '../server/herdr.js';

const config = readConfig(), mode = process.argv[2];
const base = process.env.HERDR_BRIDGE_BASE!;
const executables = JSON.parse(await readFile(join(base, 'executables.json'), 'utf8'));
const env: NodeJS.ProcessEnv = {...process.env, PATH: join(base, 'bin') + ':' + executables.path};
for (const key of ['HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID', 'HERDR_SOCKET_PATH', 'HERDR_ENV', 'CODEX_THREAD_ID', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'PASEO_HOST', 'PASEO_PASSWORD', 'PASEO_LISTEN', 'PORT']) delete env[key];
let command: string, args: string[];
if (mode === 'herdr') {
  command = executables.herdr; args = ['--session', 'paseo', 'server'];
  env.HERDR_CONFIG_PATH = join(base, 'herdr.toml');
} else if (mode === 'paseo') {
  for (let i = 0;; i++) { try { await transport.request(config.herdr[0]!.socket, 'ping'); break; } catch { if (i > 200) throw Error('The shared Herdr server did not become ready'); await delay(300); } }
  command = executables.paseo; args = ['daemon', 'run', '--home', config.paseoHome];
  env.PASEO_PASSWORD = (await readFile(join(base, 'password'), 'utf8')).trim();
} else throw Error('Choose herdr or paseo');
const child = spawn(command, args, {env, cwd: base, stdio: 'inherit'});
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => child.kill(signal));
