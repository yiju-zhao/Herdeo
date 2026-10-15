import { mkdir, writeFile, access, readFile, symlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { homedir } from 'node:os';
import { transport } from '../server/herdr.js';

const root = resolve(import.meta.dirname, '..');
const development = join(root, '.dev');
// macOS Unix socket paths have a small fixed length limit. Keep runtime homes short.
const runtimeRoot = join(process.platform === 'darwin' ? '/private/tmp' : '/tmp', 'hpb-' + (process.getuid?.() ?? 'user'));
const paseoHome = join(runtimeRoot, 'paseo');
const xdgConfig = join(runtimeRoot, 'config');
const socket = join(xdgConfig, 'herdr', 'sessions', 'bridge-development', 'herdr.sock');
const configFile = join(development, 'bridge.json');
try {
  const existing = JSON.parse(await readFile(configFile, 'utf8'));
  if (existing.paseoHome === paseoHome && existing.packageRoot === root) {
    const status = JSON.parse(execFileSync('paseo', ['daemon', 'status', '--home', paseoHome, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000 }));
    if (status.localDaemon === 'running' && status.connectedDaemon === 'reachable') {
      await transport.request(existing.herdr[0].socket, 'ping');
      console.log('Existing isolated bridge test host is ready at 127.0.0.1:6796. Configuration preserved.');
      process.exit(0);
    }
  }
} catch { /* No healthy test instance exists yet. */ }
await mkdir(paseoHome, { recursive: true, mode: 0o700 });
await mkdir(xdgConfig, { recursive: true, mode: 0o700 });
await mkdir(join(development, 'workspace'), { recursive: true });
await writeFile(join(development, 'workspace', 'README.md'), '# Isolated Herdr/Paseo bridge smoke workspace\n');
execFileSync('git', ['init', join(development, 'workspace')], { stdio: 'ignore' });
const codexHome = join(runtimeRoot, 'codex-native');
await mkdir(codexHome, { recursive: true, mode: 0o700 });
try { await access(join(codexHome, 'auth.json')); }
catch { try { await access(join(homedir(), '.codex', 'auth.json')); await symlink(join(homedir(), '.codex', 'auth.json'), join(codexHome, 'auth.json')); } catch { /* CLI authentication remains a normal startup step. */ } }
try { await access(join(codexHome, 'config.toml')); }
catch { await writeFile(join(codexHome, 'config.toml'), 'approval_policy = "never"\nsandbox_mode = "read-only"\n[features]\nhooks = true\n[projects.' + JSON.stringify(join(development, 'workspace')) + ']\ntrust_level = "trusted"\n', { mode: 0o600 }); }
const hook = (kind: string) => 'node ' + join(root, 'dist/scripts/session-hook.js') + ' ' + kind;
await writeFile(join(codexHome, 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: hook('codex'), timeout: 10 }] }] } }, null, 2) + '\n');
const claudeSettings = join(development, 'claude-hooks.json');
await writeFile(claudeSettings, JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup|resume|clear|compact|fork', hooks: [{ type: 'command', command: hook('claude') }] }] } }, null, 2) + '\n');
const env: NodeJS.ProcessEnv = { ...process.env, HERDR_BRIDGE_CONFIG: configFile };
for (const key of ['PASEO_HOST', 'PASEO_PASSWORD', 'PASEO_LISTEN', 'PORT', 'CODEX_THREAD_ID', 'PASEO_AGENT_ID', 'CLAUDE_CODE_SESSION_ID', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID', 'HERDR_SOCKET_PATH']) delete env[key];
const config = {
  herdr: [{ name: 'bridge-development', socket }],
  transcriptRoots: { codex: codexHome, claude: join(development, 'claude') },
  intervalMs: 500, autoRegister: true, paseoHome, paseoUrl: 'ws://127.0.0.1:6796/ws', packageRoot: root,
  workspaceRoots: [join(development, 'workspace')],
  launch: { codexHome, claudeSettings },
};
await writeFile(configFile, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
const configure = (path: string, value: string) => execFileSync('paseo', ['daemon', 'config', 'set', path, value, '--home', paseoHome], { env, stdio: ['ignore', 'pipe', 'pipe'] });
configure('daemon.listen', '127.0.0.1:6796');
configure('daemon.relay.enabled', 'false');
configure('pluginsEnabled', 'true');
configure('agents.providers', JSON.stringify(Object.fromEntries(['claude', 'codex', 'pi', 'copilot', 'opencode', 'omp'].map(provider => [provider, { enabled: false }]))));

const herdrLog = createWriteStream(join(development, 'herdr.log'), { flags: 'a' });
const paseoLog = createWriteStream(join(development, 'paseo.log'), { flags: 'a' });
const herdr = spawn('herdr', ['--session', 'bridge-development', 'server'], {
  cwd: join(development, 'workspace'), env: { ...env, XDG_CONFIG_HOME: xdgConfig }, stdio: ['ignore', 'pipe', 'pipe'],
});
herdr.stdout.pipe(herdrLog); herdr.stderr.pipe(herdrLog);
for (let attempt = 0; ; attempt++) {
  try { await access(socket); break; } catch { if (attempt > 60) throw new Error('Isolated Herdr did not start; inspect .dev/herdr.log'); await delay(200); }
}
const paseo = spawn('paseo', ['daemon', 'run', '--home', paseoHome], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
paseo.stdout.pipe(paseoLog); paseo.stderr.pipe(paseoLog);
for (let attempt = 0; ; attempt++) {
  try {
    const status = JSON.parse(execFileSync('paseo', ['daemon', 'status', '--home', paseoHome, '--json'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000 }));
    if (status.localDaemon !== 'running' || status.connectedDaemon !== 'reachable') throw new Error('Not ready yet');
    break;
  }
  catch { if (attempt > 40) throw new Error('Isolated Paseo did not start; inspect .dev/paseo.log'); await delay(400); }
}
execFileSync('paseo', ['plugin', 'install', root, '--home', paseoHome], { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
await writeFile(join(development, 'runtime.json'), JSON.stringify({ herdrPid: herdr.pid, paseoPid: paseo.pid, socket, paseoHome, configFile }, null, 2) + '\n');
console.log('Bridge test host ready at 127.0.0.1:6796. Run npm run smoke in another terminal.');
console.log('Configuration: ' + configFile);
async function stop() {
  try { execFileSync('herdr', ['server', 'stop'], { env: { ...env, HERDR_SOCKET_PATH: socket }, stdio: 'ignore', timeout: 10000 }); } catch { /* Only this isolated server is targeted. */ }
  try { execFileSync('paseo', ['daemon', 'stop', '--home', paseoHome], { env, stdio: 'ignore', timeout: 15000 }); } catch { /* Only this isolated home is targeted. */ }
  herdr.kill('SIGTERM'); paseo.kill('SIGTERM'); process.exit(0);
}
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
