import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { readConfig } from '../server/config.js';
import { discover, transport } from '../server/herdr.js';
import { connectPaseo, listBridgeAgents, bridgeKey } from '../server/paseo.js';
import { canonicalKey } from '../server/bindings.js';

const config = readConfig(join(resolve(import.meta.dirname, '..'), '.dev/bridge.json'));
if (config.paseoUrl !== 'ws://127.0.0.1:6796/ws' || !config.paseoHome.includes('/hpb-')) throw new Error('This check can restart only the isolated bridge test instance.');
const native = await discover(config);
if (native.some(x => x.status === 'working')) throw new Error('A test agent is working; wait until it is idle before this check.');
let client = await connectPaseo(config);
const before = (await listBridgeAgents(client)).filter(x => !x.archivedAt);
const information = await Promise.all(native.map(async x => ({ pane: x.pane, info: await transport.request<{ process_info: { foreground_process_group_id: number } }>(x.socket, 'pane.process_info', { pane_id: x.pane }) })));
await client.close();
await promisify(execFile)('paseo', ['daemon', 'restart', '--home', config.paseoHome], { timeout: 60000 });
client = await connectPaseo(config);
try {
  const after = (await listBridgeAgents(client)).filter(x => !x.archivedAt);
  assert.deepEqual(after.map(x => x.id).sort(), before.map(x => x.id).sort());
  for (const agent of after) {
    const key = await canonicalKey(config, bridgeKey(agent)!);
    const source = native.find(x => x.key === key);
    if (!source) continue;
    await client.agents.ref(agent.id).commands();
    const current = await transport.request<{ process_info: { foreground_process_group_id: number } }>(source.socket, 'pane.process_info', { pane_id: source.pane });
    const previous = information.find(x => x.pane === source.pane)!;
    assert.equal(current.process_info.foreground_process_group_id, previous.info.process_info.foreground_process_group_id);
  }
  console.log('PASS: restarting only the test Paseo preserves existing agent IDs, provisional bindings and original Herdr process groups.');
} finally { await client.close(); }
