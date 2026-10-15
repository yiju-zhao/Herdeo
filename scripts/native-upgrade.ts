import { chmod, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { readConfig } from '../server/config.js';
import { discover } from '../server/herdr.js';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const file = join(root, '.dev/bridge.json');
const config = readConfig(file);
if (config.paseoUrl !== 'ws://127.0.0.1:6796/ws' || !config.paseoHome.includes('/hpb-') || config.packageRoot !== root) throw new Error('Upgrade targets only the isolated local bridge test host.');
if ((await discover(config)).some(x => x.status === 'working')) throw new Error('An original test agent is working. Upgrade after its current task finishes.');
const proxy = join(root, 'dist/scripts/codex-proxy.js');
await chmod(proxy, 0o755);
const previous = JSON.parse(await readFile(file, 'utf8'));
await writeFile(file, JSON.stringify({ ...previous, nativeCodex: true }, null, 2) + '\n', { mode: 0o600 });
const env: NodeJS.ProcessEnv = { ...process.env, HERDR_BRIDGE_CONFIG: file };
for (const name of ['PASEO_HOST', 'PASEO_PASSWORD', 'PASEO_LISTEN', 'PORT']) delete env[name];
const run = (...args: string[]) => execute('paseo', [...args, '--home', config.paseoHome], { env, timeout: 60000 });
if (!previous.nativeCodex) await run('plugin', 'reload', 'herdr-bridge');
// Paseo's CLI edits record-valued dynamic keys at their containing object.
const stored = JSON.parse(await readFile(join(config.paseoHome, 'config.json'), 'utf8'));
await run('daemon', 'config', 'set', 'agents.providers', JSON.stringify({ ...stored.agents?.providers,
  codex: { enabled: true, command: [proxy], env: { CODEX_HOME: config.launch.codexHome, HERDR_BRIDGE_CONFIG: file } } }));
console.log('Native Codex routing enabled on the isolated Paseo host at 127.0.0.1:6796. Existing idle Codex views will migrate automatically.');
