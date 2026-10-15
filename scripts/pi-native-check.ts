import { readFile, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { readConfig } from '../server/config.js';
import { connectPaseo } from '../server/paseo.js';
import { loadPiRoute } from '../server/pi-native.js';
import { transport } from '../server/herdr.js';
import { readJsonLines } from '../server/jsonl.js';

const root = resolve(import.meta.dirname, '..'), config = readConfig(join(root, '.dev/claude-native.json'));
assert.equal(config.paseoUrl, 'ws://127.0.0.1:6797/ws'); assert.ok(config.nativePi && config.launch.piModel);
const client = await connectPaseo(config);
try {
  const agent = await client.agents.create({cwd: config.workspaceRoots[0]!, config: {provider: 'pi/' + config.launch.piModel}, title: 'Pi native validation'});
  const route = await loadPiRoute(config, agent.id); assert.ok(route);
  const observer = createConnection(route.socket);
  const nativeTypes: string[] = []; let nativeTextDeltas = 0;
  let terminalSettled: (() => void) | undefined;
  await new Promise<void>((ready, reject) => {
    observer.once('error', reject);
    readJsonLines(observer, frame => {
      if (frame.type === 'bridge.ready') ready();
      if (frame.type === 'bridge.error') reject(Error(frame.message));
      if (frame.type !== 'bridge.stdout') return;
      nativeTypes.push(frame.message.type);
      if (frame.message.type === 'message_update' && frame.message.assistantMessageEvent?.type === 'text_delta') nativeTextDeltas++;
      if (frame.message.type === 'agent_settled') terminalSettled?.();
    }, reject);
    observer.once('connect', () => observer.write(JSON.stringify({type: 'bridge.attach', cwd: route.cwd, args: ['--mode', 'rpc']}) + '\n'));
  });
  try {
    const before = JSON.parse(await readFile(route.socket + '.json', 'utf8'));
    const streams: string[] = [], sub = agent.timeline.subscribe(event => { if ('event' in event) streams.push(event.event.type); }); await sub.ready;
    const marker = 'HPB_PI_NATIVE_' + Date.now().toString(36).toUpperCase();
    const result = await agent.run('Use the read tool to read only README.md in the current directory. Do not use other tools or change anything. Then reply exactly ' + marker + '.', {timeoutMs: 120000});
    assert.equal(result.status, 'idle'); assert.ok(result.lastMessage?.includes(marker));
    assert.ok(nativeTextDeltas > 0, 'Native Pi text deltas were not streamed');
    const terminalMarker = 'HPB_PI_TERMINAL_' + Date.now().toString(36).toUpperCase();
    const settled = new Promise<void>((ready, reject) => {
      const timer = setTimeout(() => reject(Error('Terminal-origin Pi turn timed out')), 120000);
      terminalSettled = () => { clearTimeout(timer); ready(); };
    });
    observer.write(JSON.stringify({type: 'bridge.user', text: 'Reply exactly ' + terminalMarker + '. Do not use tools, read files or change anything.'}) + '\n');
    await settled; sub();
    const timeline = await agent.timeline.refetch({limit: 200});
    const tools = timeline.entries.map(e => e.item).filter(item => item.type === 'tool_call');
    assert.ok(tools.some(item => item.detail?.type === 'read' && item.status === 'completed'), 'Missing native Pi Read card');
    assert.ok(timeline.entries.some(e => e.item.type === 'assistant_message' && e.item.text.includes(terminalMarker)), 'Terminal reply missing from native Paseo timeline');
    const state = (await agent.refresh())!.agent, after = JSON.parse(await readFile(route.socket + '.json', 'utf8'));
    assert.equal(state.provider, 'pi'); assert.equal(state.persistence?.sessionId, after.sessionId);
    assert.equal(before.enginePid, after.enginePid); assert.equal(before.sessionId, after.sessionId);
    const info = await transport.request<any>(route.herdrSocket, 'pane.process_info', {pane_id: route.pane});
    assert.ok(info.process_info.foreground_processes.some((p: any) => p.pid === after.enginePid));
    assert.ok(state.workspaceId);
    await client.workspaces.ref(state.workspaceId).setTitle('Pi 原生桥接测试');
    const evidence = {paseoAgentId: agent.id, provider: state.provider, model: state.model, nativeSessionId: after.sessionId, nativeSessionFile: after.sessionFile, enginePid: after.enginePid, pane: route.pane, socket: route.socket, herdrSocket: route.herdrSocket, paseoHome: config.paseoHome, bidirectional: true, originalPidPreserved: true, typedToolCards: tools.map(item => item.detail?.type), nativeTextDeltas, nativeStreamTypes: [...new Set(nativeTypes)], paseoStreamTypes: [...new Set(streams)], markers: [marker, terminalMarker]};
    await writeFile(join(root, '.dev/pi-native-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    console.log('PASS: builtin Pi creation opens Herdr, Read renders natively, real token deltas stream, and terminal-origin messages use the same PID/session.');
    console.log(JSON.stringify({port: 6797, paseoAgentId: agent.id, provider: state.provider, model: state.model, pane: route.pane}));
  } finally { observer.destroy(); }
} finally { await client.close(); }
