import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from '../server/config.js';
import { discover, transport } from '../server/herdr.js';
import { connectPaseo, listBridgeAgents, bridgeKey } from '../server/paseo.js';
import { loadRoute } from '../server/codex-native.js';

const root = resolve(import.meta.dirname, '..');
const config = readConfig(join(root, '.dev/bridge.json'));
if (!config.nativeCodex || config.paseoUrl !== 'ws://127.0.0.1:6796/ws' || !config.paseoHome.includes('/hpb-')) throw new Error('This check targets only the upgraded isolated test host.');
const client = await connectPaseo(config);
const evidence: unknown[] = [];
try {
  if (!process.argv.includes('--create-only')) {
  const native = (await discover(config)).find(x => x.pane === 'wP:p1' && x.provider === 'codex');
  assert.ok(native && ['idle', 'done'].includes(native.status), 'The original user test CLI must be idle.');
  const adopted = (await listBridgeAgents(client)).find(x => !x.archivedAt && x.provider === 'codex' && bridgeKey(x) === native.key);
  assert.ok(adopted, 'The original Herdr thread must be registered with the builtin Codex provider.');
  const before = await transport.request<any>(native.socket, 'pane.process_info', { pane_id: native.pane });
  const agent = client.agents.ref(adopted.id);
  const marker = 'HPB_NATIVE_RENDER_' + Date.now().toString(36).toUpperCase();
  const events: string[] = [];
  const sub = agent.timeline.subscribe(event => { if ('event' in event) events.push(event.event.type); });
  await sub.ready;
  const reply = await agent.run('Use exec_command to run exactly cat README.md in the current workspace. Do not read other files or change anything. Then reply exactly ' + marker + '.', { timeoutMs: 90000 });
  sub();
  assert.equal(reply.status, 'idle', 'The controlled native read must finish without requiring a terminal workaround.');
  assert.ok(reply.lastMessage?.includes(marker));
  const timeline = await agent.timeline.refetch({ limit: 200 });
  const tools = timeline.entries.map(x => x.item).filter(x => x.type === 'tool_call');
  assert.ok(tools.some(x => x.status === 'completed' && x.detail?.type !== 'unknown'), 'The native command must have a builtin typed tool card.');
  const after = await transport.request<any>(native.socket, 'pane.process_info', { pane_id: native.pane });
  assert.equal(before.process_info.foreground_process_group_id, after.process_info.foreground_process_group_id);
  assert.equal((await discover(config)).find(x => x.pane === native.pane)?.nativeId, native.nativeId);
  assert.equal((await agent.refresh())!.agent.persistence?.sessionId, native.nativeId);
  evidence.push({ direction: 'Herdr to Paseo', pane: native.pane, paseoAgentId: adopted.id, provider: 'codex', model: adopted.model,
    nativeId: native.nativeId, originalProcessGroupPreserved: true, typedToolCards: tools.map(x => x.detail?.type), marker,
    nativeStreamTypes: [...new Set(events)] });
  console.log('PASS: original Herdr CLI renders through builtin Codex with native typed tool cards, streaming events and unchanged native identity/process.');
  await writeFile(join(root, '.dev/native-parity-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  }

  const workspace = await client.workspaces.open(config.workspaceRoots[0]!);
  const created = await workspace.agents.create({ config: { provider: 'codex/gpt-6.1-sol' }, title: 'Native Codex validation' });
  const route = await loadRoute(config, created.id);
  assert.ok(route, 'Builtin Paseo creation must open a Herdr CLI and save its original route.');
  const createdBefore = await transport.request<any>(route.herdrSocket, 'pane.process_info', { pane_id: route.pane });
  const nextMarker = 'HPB_NATIVE_CREATE_' + Date.now().toString(36).toUpperCase();
  const result = await created.run('Reply exactly ' + nextMarker + '. Do not use tools, read files or change anything.', { timeoutMs: 90000 });
  assert.equal(result.status, 'idle');
  assert.ok(result.lastMessage?.includes(nextMarker));
  await delay(1200);
  const snapshot = (await created.refresh())!.agent;
  assert.equal(snapshot.provider, 'codex');
  assert.equal(snapshot.persistence?.sessionId, route.nativeId);
  const source = (await discover(config)).find(x => x.key === route.key);
  assert.ok(source);
  assert.equal((await transport.request<any>(route.herdrSocket, 'pane.process_info', { pane_id: route.pane })).process_info.foreground_process_group_id, createdBefore.process_info.foreground_process_group_id);
  assert.equal((await listBridgeAgents(client)).filter(x => !x.archivedAt && bridgeKey(x) === route.key).length, 1);
  evidence.push({ direction: 'Paseo to Herdr', pane: route.pane, paseoAgentId: created.id, provider: 'codex', model: snapshot.model,
    nativeId: route.nativeId, originalProcessGroupPreserved: true, exactlyOneView: true, marker: nextMarker });
  console.log('PASS: creating builtin Codex in Paseo opens a single matching Herdr CLI, returns its first reply and keeps one Paseo view.');
  await writeFile(join(root, '.dev/native-parity-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
} finally { await client.close(); }
