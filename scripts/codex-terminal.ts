import { spawn } from 'node:child_process';
import { mkdir, access, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { codexSocketDirectory, readConfig } from '../server/config.js';

// One app-server per terminal keeps SessionStart hook environment tied to the
// correct Herdr pane. A shared daemon can retain a different pane's environment.
const config = readConfig();
const folder = codexSocketDirectory(config);
await mkdir(folder, { recursive: true, mode: 0o700 });
const socket = join(folder, randomUUID().slice(0, 10) + '.sock');
const endpoint = 'unix://' + socket;
const env: NodeJS.ProcessEnv = { ...process.env };
delete env.CODEX_THREAD_ID;
if (config.launch.codexHome) env.CODEX_HOME = config.launch.codexHome;
const server = spawn(config.launch.codexCommand ?? 'codex', ['app-server', '--listen', endpoint], { env, stdio: ['ignore', 'ignore', 'pipe'] });
server.stderr.resume();
let terminal: ReturnType<typeof spawn> | undefined;
const stop = () => { terminal?.kill('SIGTERM'); server.kill('SIGTERM'); void unlink(socket).catch(() => {}); };
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
process.once('exit', () => { terminal?.kill('SIGTERM'); server.kill('SIGTERM'); });
for (let attempt = 0; ; attempt++) {
  try { await access(socket); break; }
  catch { if (attempt > 100 || server.exitCode !== null) throw new Error('The terminal-owned Codex app-server did not start.'); await delay(100); }
}
terminal = spawn(config.launch.codexCommand ?? 'codex', ['--remote', endpoint, ...process.argv.slice(2)], { env, stdio: 'inherit' });
terminal.once('exit', stop);
server.once('exit', () => { terminal?.kill('SIGTERM'); });
