import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from '../server/config.js';
import { discover, transport } from '../server/herdr.js';
import { connectPaseo, listBridgeAgents, bridgeKey } from '../server/paseo.js';

const root = resolve(import.meta.dirname, '..');
const config = readConfig(join(root, '.dev/bridge.json'));
const demos = JSON.parse(await readFile(join(root, '.dev/native-demos.json'), 'utf8'));
const client = await connectPaseo(config);
const evidence: unknown[] = [];
try {
  for (const kind of ['codex', 'claude']) {
    let native = (await discover(config)).find(x => x.pane === demos[kind]?.pane);
    for (let attempt = 0; !native; attempt++) {
      if (attempt > 50) throw new Error(kind + ' did not automatically report its session identity.');
      await delay(400); native = (await discover(config)).find(x => x.pane === demos[kind]?.pane);
    }
    let agent = (await listBridgeAgents(client)).find(x => !x.archivedAt && bridgeKey(x) === native!.key);
    for (let attempt = 0; !agent; attempt++) {
      if (attempt > 50) throw new Error(kind + ' did not appear in Paseo.');
      await delay(400); agent = (await listBridgeAgents(client)).find(x => !x.archivedAt && bridgeKey(x) === native!.key);
    }
    const before = await transport.request(config.herdr[0]!.socket, 'pane.process_info', { pane_id: native.pane });
    const marker = 'HPB_PASEO_' + kind.toUpperCase() + '_' + Date.now().toString(36).toUpperCase();
    const result = await client.agents.ref(agent.id).run('Reply exactly ' + marker + '. Do not use tools, read files, or change anything.', { timeoutMs: 60000 });
    assert.equal(result.status, 'idle');
    assert.ok(result.lastMessage?.includes(marker), 'Missing reply from actual ' + kind + ': ' + result.lastMessage);
    const after = await transport.request(config.herdr[0]!.socket, 'pane.process_info', { pane_id: native.pane });
    const pids = (value: unknown): number[] => {
      if (!value || typeof value !== 'object') return [];
      const record = value as Record<string, unknown>;
      return Object.entries(record).flatMap(([key, entry]) => key === 'pid' && typeof entry === 'number' ? [entry] : Array.isArray(entry) ? entry.flatMap(pids) : pids(entry));
    };
    assert.ok(pids(before).some(pid => pids(after).includes(pid)), 'Original CLI PID disappeared.');
    const row = { provider: kind, pane: native.pane, nativeId: native.nativeId, paseoAgentId: agent.id, marker, originalPidPreserved: true };
    evidence.push(row); console.log('PASS: true ' + kind + ' automatically registered; Paseo message received by original CLI and reply synchronized.');
  }
  await writeFile(join(root, '.dev/native-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
} finally { await client.close(); }
