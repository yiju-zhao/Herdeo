import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinRequest } from '../server/codex-proxy.js';
import { codexForegroundEndpoint, socketFromCommand, type CodexRoute } from '../server/codex-native.js';
import { configSchema } from '../server/config.js';

const config = configSchema.parse({ herdr: [{ name: 'test', socket: '/tmp/herdr.sock' }],
  transcriptRoots: { codex: '/tmp/codex', claude: '/tmp/claude' }, paseoHome: '/tmp/native-test', paseoUrl: 'ws://127.0.0.1:6796/ws', packageRoot: '/tmp/plugin' });
const route: CodexRoute = { key: 'bound-key', nativeId: 'original-thread', socket: '/tmp/native-test/herdr-bridge/codex-terminals/own.sock',
  herdrSocket: '/tmp/herdr.sock', pane: 'w1:p1', cwd: '/tmp/project', pid: 42 };

test('Linux foreground ordering selects the remote TUI rather than its earlier app-server',async()=>{
 const processes=[{pid:20,name:'codex'},{pid:21,name:'codex'}];
 const selected=await codexForegroundEndpoint(config,processes,async pid=>pid===20?'codex app-server --listen unix://'+route.socket:'codex --remote unix://'+route.socket);
 assert.deepEqual(selected,{pid:21,socket:route.socket});
});

test('Paseo creation joins the blank Herdr TUI thread instead of starting another executor', () => {
  assert.deepEqual(joinRequest({ id: 3, method: 'thread/start', params: { cwd: route.cwd, model: 'selected-model', dynamicTools: [{ name: 'tool' }] } }, route, true),
    { id: 3, method: 'thread/resume', params: { threadId: route.nativeId, cwd: route.cwd, model: 'selected-model', excludeTurns: true } });
});

test('adopting an original thread preserves its settings instead of replacing them with Paseo launch defaults', () => {
  assert.deepEqual(joinRequest({ id: 5, method: 'thread/start', params: { model: 'different-model', approvalPolicy: 'never', sandbox: 'danger-full-access' } }, route, false),
    { id: 5, method: 'thread/resume', params: { threadId: route.nativeId, excludeTurns: true } });
});

test('native mutations cannot target a different session on the same app-server', () => {
  for (const method of ['turn/start', 'turn/steer', 'turn/interrupt', 'thread/resume', 'thread/rollback']) {
    assert.throws(() => joinRequest({ id: 7, method, params: { threadId: 'replacement-thread' } }, route, false), /different native Codex thread/);
  }
});

test('terminal endpoint adoption accepts only this instance’s terminal-owned socket path', () => {
  assert.equal(socketFromCommand(config, 'codex --remote unix://' + route.socket), route.socket);
  assert.equal(socketFromCommand(config, 'codex'), undefined);
  assert.throws(() => socketFromCommand(config, 'codex --remote unix:///tmp/other.sock'), /outside/);
  assert.throws(() => socketFromCommand(config, 'codex --remote unix:///tmp/native-test/herdr-bridge/codex-terminals/../../stale.sock'), /outside/);
});
