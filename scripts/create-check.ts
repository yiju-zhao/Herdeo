import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from '../server/config.js';
import { connectPaseo, listBridgeAgents, bridgeKey } from '../server/paseo.js';
import { discover } from '../server/herdr.js';
import { canonicalKey } from '../server/bindings.js';
import { loadRoute } from '../server/codex-native.js';

const root = resolve(import.meta.dirname, '..');
const config = readConfig(join(root, '.dev/bridge.json'));
const client = await connectPaseo(config);
const evidence = [];
try {
  for (const kind of ['codex', 'claude']) {
    const workspace = await client.workspaces.open(config.workspaceRoots[0]!);
    const agent = await workspace.agents.create({ config: { provider: config.nativeCodex && kind === 'codex' ? 'codex/gpt-6.1-sol' : 'herdr/' + kind }, title: kind + ' created from Paseo' });
    const marker = 'HPB_NEW_' + kind.toUpperCase() + '_' + Date.now().toString(36).toUpperCase();
    const result = await agent.run('Reply exactly ' + marker + '. Do not use tools, read files, or change anything.', { timeoutMs: 60000 });
    assert.equal(result.status, 'idle');
    assert.ok(result.lastMessage?.includes(marker), 'The new ' + kind + ' did not return its test reply: ' + result.lastMessage);
    await delay(1200);
    const snapshot = (await agent.refresh())!.agent;
    const key = await canonicalKey(config, bridgeKey(snapshot) ?? (await loadRoute(config, agent.id))!.key);
    const native = (await discover(config)).find(x => x.key === key);
    assert.ok(native, 'No matching Herdr terminal for the Paseo-created agent.');
    const all = await listBridgeAgents(client);
    const matching = await Promise.all(all.filter(x => !x.archivedAt).map(async x => ({ id: x.id, key: await canonicalKey(config, bridgeKey(x)!) })));
    assert.equal(matching.filter(x => x.key === key).length, 1, 'Automatic discovery registered a duplicate.');
    evidence.push({ provider: kind, paseoAgentId: agent.id, pane: native.pane, nativeId: native.nativeId, marker });
    console.log('PASS: Paseo-created ' + kind + ' opens in Herdr, returns its first reply and has exactly one Paseo view.');
  }
  await writeFile(join(root, '.dev/create-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
} finally { await client.close(); }
