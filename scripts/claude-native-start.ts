import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { readConfig } from '../server/config.js';
import { connectPaseo } from '../server/paseo.js';
import { transport } from '../server/herdr.js';

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const file = join(root, '.dev/claude-native.json');
const config = readConfig(file);
if (config.paseoUrl !== 'ws://127.0.0.1:6797/ws' || !config.nativeClaude) throw Error('Use only the independent native Claude test host');
const cwd = config.workspaceRoots[0]!;
const env: NodeJS.ProcessEnv = {...process.env, HERDR_SOCKET_PATH: config.herdr[0]!.socket, HERDR_ENV: '1'};
for (const key of ['HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID']) delete env[key];
const created = JSON.parse((await execute('herdr', ['workspace', 'create', '--cwd', cwd, '--label', 'Claude', '--no-focus'], {env})).stdout);
const pane = created.result.root_pane.pane_id;
const folder = '/private/tmp/hpc-' + process.getuid!(); await mkdir(folder, {recursive: true, mode: 0o700});
const socket = join(folder, randomUUID().slice(0, 8) + '.sock');
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
await execute('herdr', ['pane', 'run', pane, ['env', 'HERDR_BRIDGE_CONFIG=' + file, 'HERDR_BRIDGE_CLAUDE_REGISTER=1', 'HERDR_BRIDGE_CLAUDE_SOCKET=' + socket, 'node', join(root, 'dist/scripts/claude-host.js')].map(quote).join(' ')], {env});
let metadata: any;
for (let i = 0; i < 150; i++) {
 try { metadata = JSON.parse(await readFile(socket + '.json', 'utf8')); if (metadata.paseoAgentId) break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
 await delay(200);
}
assert.ok(metadata?.paseoAgentId, 'Herdr-origin native Claude registration did not finish');
const client = await connectPaseo(config);
try {
 const agent = client.agents.ref(metadata.paseoAgentId);
 const state = (await agent.refresh())!.agent; assert.equal(state.provider, 'claude');
 if (process.argv.includes('--check')) {
  const result = await agent.run('Reply exactly HERDR_AUTO_REGISTERED. Do not use tools, read files or change anything.', {timeoutMs: 90000});
  assert.equal(result.status, 'idle'); assert.ok(result.lastMessage?.includes('HERDR_AUTO_REGISTERED'));
  const after = JSON.parse(await readFile(socket + '.json', 'utf8'));
  assert.equal(after.enginePid, metadata.enginePid);
  const info = await transport.request<any>(config.herdr[0]!.socket, 'pane.process_info', {pane_id: pane});
  assert.ok(info.process_info.foreground_processes.some((p: any) => p.pid === after.enginePid));
  await writeFile(join(root, '.dev/claude-registration-evidence.json'), JSON.stringify({paseoAgentId: agent.id, provider: 'claude', nativeSessionId: after.sessionId, enginePid: after.enginePid, pane, autoRegistered: true, originalPidPreserved: true}, null, 2) + '\n');
 }
 console.log(JSON.stringify({paseoAgentId: agent.id, provider: 'claude', pane, port: 6797}));
} finally { await client.close(); }
