import { readFile, writeFile, mkdir, chmod, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { readJsonLines } from '../server/jsonl.js';
import { readConfig } from '../server/config.js';
import { connectPaseo } from '../server/paseo.js';
import { piRuntime } from '../server/pi-native.js';

const execute = promisify(execFile), root = resolve(import.meta.dirname, '..');
const file = join(root, '.dev/claude-native.json'), config = readConfig(file);
assert.equal(config.paseoUrl, 'ws://127.0.0.1:6797/ws');
assert.equal(config.paseoHome, '/private/tmp/hpc-' + process.getuid!() + '/paseo');
const before = await connectPaseo(config);
try {
  const agents = await before.agents.list({filter: {includeArchived: true}, page: {limit: 100}});
  assert.ok(!agents.entries.some(e => e.agent.status === 'running'), 'Wait for the current test turn to finish before reloading providers');
} finally { await before.close(); }
const command = join(homedir(), '.local/bin/pi'); await access(command);
const model = await new Promise<string>((ready, reject) => {
  const child = spawn(command, ['--offline', '--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills', '--no-mcp', '--no-context-files', '--no-prompt-templates', '--no-themes', '--no-approve', '--no-tools'], {cwd: config.workspaceRoots[0], stdio: ['pipe', 'pipe', 'pipe']});
  const timer = setTimeout(() => { child.kill(); reject(Error('Pi metadata probe timed out')); }, 15000);
  child.stderr.on('data', () => {});
  child.once('error', reject);
  readJsonLines(child.stdout, response => {
    if (response.type !== 'response' || response.command !== 'get_state') return;
    clearTimeout(timer); child.kill();
    if (!response.success || !response.data?.model?.provider || !response.data.model.id) reject(Error('Pi has no configured default model'));
    else ready(response.data.model.provider + '/' + response.data.model.id);
  }, reject);
  child.stdin.write(JSON.stringify({id: 'pi-model-probe', type: 'get_state'}) + '\n');
});
await mkdir(join(piRuntime(), 'sessions'), {recursive: true, mode: 0o700});
await writeFile(file, JSON.stringify({...config, nativePi: true, launch: {...config.launch, piCommand: command, piModel: model}}, null, 2) + '\n', {mode: 0o600});
const proxy = join(root, 'dist/scripts/pi-proxy.js'); await chmod(proxy, 0o755);
const stored = JSON.parse(await readFile(join(config.paseoHome, 'config.json'), 'utf8'));
const env: NodeJS.ProcessEnv = {...process.env, HERDR_BRIDGE_CONFIG: file};
for (const key of ['PASEO_HOST', 'PASEO_PASSWORD', 'PASEO_LISTEN', 'PORT']) delete env[key];
const run = (...args: string[]) => execute('paseo', [...args, '--home', config.paseoHome], {env, timeout: 60000});
await run('plugin', 'reload', 'herdr-bridge');
await run('daemon', 'config', 'set', 'agents.providers', JSON.stringify({...stored.agents?.providers,
  pi: {enabled: true, command: [proxy, '--offline', '--session-dir', join(piRuntime(), 'sessions'), '--no-approve'], env: {HERDR_BRIDGE_CONFIG: file}},
}));
console.log(JSON.stringify({port: 6797, piEnabled: true, defaultModel: model, claudeProviderPreserved: stored.agents?.providers?.claude?.enabled === true}));
