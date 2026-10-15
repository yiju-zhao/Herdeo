import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { readConfig } from '../server/config.js';
import { createPiHost } from '../server/pi-native.js';
import { connectPaseo } from '../server/paseo.js';

const root = resolve(import.meta.dirname, '..');
const config = readConfig(join(root, '.dev/claude-native.json'));
assert.equal(config.paseoUrl, 'ws://127.0.0.1:6797/ws'); assert.ok(config.nativePi);
const route = await createPiHost(config, config.workspaceRoots[0]!, true);
let metadata: any;
for (let i = 0; i < 200; i++) {
  metadata = JSON.parse(await readFile(route.socket + '.json', 'utf8'));
  if (metadata.paseoAgentId) break;
  await delay(300);
}
assert.ok(metadata.paseoAgentId, 'Herdr Pi automatic registration did not finish');
if (process.argv.includes('--check')) {
  const client = await connectPaseo(config);
  try {
    const agent = client.agents.ref(metadata.paseoAgentId);
    const result = await agent.run('Reply exactly PI_AUTO_REGISTERED. Do not use tools, read files, change anything, or explain.', {timeoutMs: 120000});
    assert.equal(result.status, 'idle'); assert.ok(result.lastMessage?.includes('PI_AUTO_REGISTERED'));
    const state = (await agent.refresh())!.agent;
    const current = JSON.parse(await readFile(route.socket + '.json', 'utf8'));
    assert.equal(current.enginePid, metadata.enginePid); assert.equal(state.provider, 'pi');
    await writeFile(join(root, '.dev/pi-registration-evidence.json'), JSON.stringify({paseoAgentId: agent.id, provider: state.provider, model: state.model, nativeSessionId: current.sessionId, nativeSessionFile: current.sessionFile, enginePid: current.enginePid, pane: route.pane, socket: route.socket, autoRegistered: true, originalPidPreserved: true}, null, 2) + '\n');
  } finally { await client.close(); }
}
console.log(JSON.stringify({port: 6797, paseoAgentId: metadata.paseoAgentId, pane: route.pane, provider: 'pi'}));
