import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { discover, sendPrompt, resolveSession, sessionKey, type HerdrTransport } from '../server/herdr.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '../server/config.js';
import { createProvider } from '../server/provider.js';
import { decodeTranscript } from '../server/transcripts.js';
import type { ProviderEvent } from '@getpaseo/plugin/server/provider';

const home = mkdtempSync(join(tmpdir(), 'hpb-tests-'));
after(() => rmSync(home, { recursive: true, force: true }));
const config = configSchema.parse({
  herdr: [{ name: 'test', socket: '/tmp/herdr-bridge-test.sock' }],
  transcriptRoots: { codex: '/tmp/codex', claude: '/tmp/claude' },
  intervalMs: 100, autoRegister: false, paseoHome: home, paseoUrl: 'ws://127.0.0.1:6796/ws', packageRoot: '/tmp/plugin',
});

test('a blank CLI binds by its foreground PID, upgrades once to a native session and rejects a later replacement', async () => {
  let id: string | undefined;
  let pid = 100;
  const connection: HerdrTransport = { async request<T>(_socket: string, method: string) {
    if (method === 'pane.process_info') return { process_info: { foreground_processes: [{ pid, name: 'codex' }] } } as T;
    return { agents: [{ ...native, terminal_id: 'term-pending', agent_session: id ? { value: id } : undefined }] } as T;
  } };
  const provisional = (await discover(config, connection))[0]!;
  assert.ok(provisional.nativeId.startsWith('pending:'));
  id = 'first-real-session';
  const upgraded = await resolveSession(config, provisional.key, connection);
  assert.equal(upgraded.nativeId, 'first-real-session');
  id = 'replacement-session'; pid = 200;
  await assert.rejects(resolveSession(config, provisional.key, connection), /original Herdr session/);
});
const native = { agent: 'codex', pane_id: 'w1:p1', agent_status: 'idle', cwd: '/tmp/project', agent_session: { value: 'native-a', kind: 'id' } };
const key = sessionKey(config.herdr[0]!.socket, 'codex', 'native-a');

test('refuses to send to a replacement agent occupying the same pane', async () => {
  const calls: string[] = [];
  const connection: HerdrTransport = { async request<T>(_socket: string, method: string) {
    calls.push(method);
    return { agents: [{ ...native, agent_session: { value: 'native-b', kind: 'id' } }] } as T;
  } };
  await assert.rejects(sendPrompt(config, key, 'dangerous stale message', connection), /original Herdr session/);
  assert.deepEqual(calls, ['agent.list']);
});

test('uses distinct session identities for two Herdr servers with the same pane ID', async () => {
  const other = { ...config, herdr: [...config.herdr, { name: 'other', socket: '/tmp/herdr-other.sock' }] };
  const connection: HerdrTransport = { async request<T>() { return { agents: [native] } as T; } };
  const sessions = await discover(other, connection);
  assert.equal(new Set(sessions.map(x => x.key)).size, 2);
});

test('sends a Paseo message through Herdr and closing the view does not kill the agent', async () => {
  const calls: string[] = [];
  const connection: HerdrTransport = { async request<T>(_socket: string, method: string, params?: Record<string, unknown>) {
    calls.push(method);
    if (method === 'agent.prompt') assert.deepEqual(params, { target: 'w1:p1', text: 'hello original agent' });
    return { agents: [native] } as T;
  } };
  const provider = await createProvider(config, { connection, transcript: async () => [] }).connect({ versions: [1], capabilities: ['prompt.message', 'session.persistence'] });
  const events: ProviderEvent[] = []; provider.onEvent(event => events.push(event));
  await provider.send({ type: 'session.open', requestId: 'open', sessionId: 'paseo-view', history: 'replay',
    config: { cwd: native.cwd, env: {}, mcpServers: {}, settings: {}, persist: true, providerOptions: { nativeKey: key } } });
  await provider.send({ type: 'session.prompt', sessionId: 'paseo-view', prompt: { clientMessageId: 'm1', delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: 'hello original agent' }] } } });
  assert.equal(events.filter(x => x.type === 'session.prompt_result').length, 1);
  assert.ok(calls.includes('agent.prompt'));
  await provider.send({ type: 'session.close', sessionId: 'paseo-view', requestId: 'close' });
  await provider.close();
  assert.ok(!calls.some(x => ['pane.close', 'server.stop', 'agent.send_keys'].includes(x)));
});

test('Codex history keeps user/assistant messages and resolves a tool call', () => {
  const lines = [
    { type: 'event_msg', payload: { type: 'user_message', message: 'Read the file' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Read the file' }] } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'call-1', name: 'exec_command', arguments: '{"cmd":"cat README.md"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'hello' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'The file says hello.' } },
  ].map(x => JSON.stringify(x)).join('\n');
  const rows = decodeTranscript('codex', lines);
  assert.equal(rows.filter(x => x.item.type === 'user_message').length, 1);
  assert.ok(rows.some(x => x.item.type === 'assistant_message' && x.item.text === 'The file says hello.'));
  assert.ok(rows.some(x => x.item.type === 'tool_call' && x.item.status === 'completed'));
});

test('Claude history handles tool results and an incomplete trailing JSON line', () => {
  const lines = [
    { uuid: 'u1', type: 'user', message: { content: 'hello' } },
    { uuid: 'a1', type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'README.md' } }] } },
    { uuid: 'u2', type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'contents' }] } },
    { uuid: 'a2', type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } },
  ].map(x => JSON.stringify(x)).join('\n') + '\n{"type":"assistant"';
  const rows = decodeTranscript('claude', lines);
  assert.equal(rows.filter(x => x.item.type === 'user_message').length, 1);
  assert.ok(rows.some(x => x.item.type === 'assistant_message' && x.item.text === 'Done.'));
  assert.ok(rows.some(x => x.item.type === 'tool_call' && x.item.status === 'completed'));
});

test('Codex 0.161 canonical response items render replies even without legacy agent_message events', () => {
  const lines = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { type: 'response_item', payload: { type: 'message', id: 'u1', role: 'user', content: [{ type: 'input_text', text: 'Reply exactly HPB_CODEX_NATIVE.' }] } },
    { type: 'response_item', payload: { type: 'message', id: 'a1', role: 'assistant', content: [{ type: 'output_text', text: 'HPB_CODEX_NATIVE' }], phase: 'final_answer' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'HPB_CODEX_NATIVE' } },
  ].map(x => JSON.stringify(x)).join('\n');
  const rows = decodeTranscript('codex', lines);
  assert.deepEqual(rows.map(x => x.item), [
    { type: 'user_message', id: 'codex:user:u1', text: 'Reply exactly HPB_CODEX_NATIVE.' },
    { type: 'assistant_message', id: 'codex:assistant:a1', text: 'HPB_CODEX_NATIVE' },
  ]);
});

test('first reply upgrades a blank CLI binding without changing Paseo persistence mid-turn', async () => {
  let id: string | undefined;
  const connection: HerdrTransport = { async request<T>(_socket: string, method: string) {
    if (method === 'pane.process_info') return { process_info: { foreground_processes: [{ pid: 321, name: 'codex' }] } } as T;
    if (method === 'agent.prompt') id = 'reply-native';
    return { agents: [{ ...native, terminal_id: 'term-reply', agent_session: id ? { value: id } : undefined }] } as T;
  } };
  const initial = (await discover(config, connection))[0]!;
  const provider = await createProvider(config, { connection, transcript: async () => id ? [
    { item: { type: 'user_message', id: 'user-native', text: 'hello' } },
    { item: { type: 'assistant_message', id: 'reply-native', text: 'received' } },
  ] : [] }).connect({ versions: [1], capabilities: ['prompt.message', 'session.persistence'] });
  const events: ProviderEvent[] = []; provider.onEvent(event => events.push(event));
  try {
    await provider.send({ type: 'session.open', requestId: 'open', sessionId: 'first-turn-view', history: 'replay', config: { cwd: native.cwd, env: {}, mcpServers: {}, settings: {}, persist: true, providerOptions: { nativeKey: initial.key } } });
    await provider.send({ type: 'session.prompt', sessionId: 'first-turn-view', prompt: { clientMessageId: 'first-message', delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: 'hello' }] } } });
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.ok(events.some(x => x.type === 'session.turn' && x.state === 'completed'));
    assert.equal(events.filter(x => x.type === 'session.persistence').length, 0);
    assert.equal(events.filter(x => x.type === 'timeline.item' && x.item.type === 'user_message').length, 1);
  } finally { await provider.close(); }
});
