import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { readConfig } from '../server/config.js';
import { connectPaseo } from '../server/paseo.js';
import { loadPiRoute } from '../server/pi-native.js';
import { loadClaudeRoute, assertClaudeRoute } from '../server/claude-native.js';
import { transport } from '../server/herdr.js';

const execute = promisify(execFile), root = resolve(import.meta.dirname, '..'), file = join(root, '.dev/claude-native.json');
const config = readConfig(file);
assert.equal(config.paseoUrl, 'ws://127.0.0.1:6797/ws'); assert.equal(config.paseoHome, '/private/tmp/hpc-' + process.getuid!() + '/paseo');
const proof = JSON.parse(await readFile(join(root, '.dev/pi-native-evidence.json'), 'utf8'));
const route = await loadPiRoute(config, proof.paseoAgentId); assert.ok(route);
let client = await connectPaseo(config);
const liveClaude: Array<{socket: string; enginePid: number; sessionId: string}> = [];
try {
 const agents = await client.agents.list({filter: {includeArchived: true}, page: {limit: 100}});
 assert.ok(!agents.entries.some(e => e.agent.status === 'running'), 'A test turn is still running');
 for (const entry of agents.entries.filter(e => e.agent.provider === 'claude')) {
  const claude = await loadClaudeRoute(config, entry.agent.id); if (!claude) continue;
  try {
   await assertClaudeRoute(config, claude);
   const metadata = JSON.parse(await readFile(claude.socket + '.json', 'utf8'));
   const info = await transport.request<any>(claude.herdrSocket, 'pane.process_info', {pane_id: claude.pane});
   if (info.process_info.foreground_processes.some((p: any) => p.pid === metadata.enginePid)) liveClaude.push({socket: claude.socket, enginePid: metadata.enginePid, sessionId: metadata.sessionId});
  } catch { /* User-closed test terminals are not relaunched. */ }
 }
} finally { await client.close(); }
await execute('paseo', ['daemon', 'restart', '--home', config.paseoHome], {env: {...process.env, HERDR_BRIDGE_CONFIG: file}, timeout: 60000});
for (let i = 0;; i++) { try { client = await connectPaseo(config); break; } catch (error) { if (i > 40) throw error; await delay(300); } }
try {
 const agent = client.agents.ref(proof.paseoAgentId);
 const timeline = await agent.timeline.refetch({limit: 200});
 for (const marker of proof.markers) assert.ok(timeline.entries.some(e => e.item.type === 'assistant_message' && e.item.text.includes(marker)), 'Native Pi history not restored');
 const marker = 'HPB_PI_RECONNECT_' + Date.now().toString(36).toUpperCase();
 const result = await agent.run('Reply exactly ' + marker + '. Do not use tools, read files or change anything.', {timeoutMs: 120000});
 assert.equal(result.status, 'idle'); assert.ok(result.lastMessage?.includes(marker));
 const state = (await agent.refresh())!.agent;
 assert.equal(state.provider, 'pi'); assert.equal(state.persistence?.sessionId, proof.nativeSessionId);
 const metadata = JSON.parse(await readFile(route.socket + '.json', 'utf8'));
 assert.equal(metadata.enginePid, proof.enginePid); assert.equal(metadata.sessionId, proof.nativeSessionId);
 const info = await transport.request<any>(route.herdrSocket, 'pane.process_info', {pane_id: route.pane});
 assert.ok(info.process_info.foreground_processes.some((p: any) => p.pid === proof.enginePid));
 for (const claude of liveClaude) {
  const metadata = JSON.parse(await readFile(claude.socket + '.json', 'utf8'));
  assert.equal(metadata.enginePid, claude.enginePid); assert.equal(metadata.sessionId, claude.sessionId);
  process.kill(claude.enginePid, 0);
 }
 await writeFile(join(root, '.dev/pi-native-evidence.json'), JSON.stringify({...proof, restartPreservesPidAndSession: true, historyRestored: true, liveClaudeExecutorsPreserved: liveClaude.length, restartMarker: marker}, null, 2) + '\n');
 console.log('PASS: restarting only 6797 restores native Pi history and continues on the original PID/session; live Claude executors also remain present.');
} finally { await client.close(); }
