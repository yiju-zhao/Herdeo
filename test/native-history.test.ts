import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readNativeHistory } from '../server/codex-history.js';
import { configSchema } from '../server/config.js';

const home = mkdtempSync(join(tmpdir(), 'herdr-native-history-'));
after(() => rmSync(home, { recursive: true, force: true }));
const config = configSchema.parse({ herdr: [{ name: 'test', socket: '/tmp/herdr.sock' }], transcriptRoots: { codex: home, claude: '/tmp/claude' },
  paseoHome: home, paseoUrl: 'ws://127.0.0.1:6796/ws', packageRoot: '/tmp/plugin' });
const source = new DatabaseSync(join(home, 'thread_history_1.sqlite'));
source.exec('CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, status TEXT, error_json TEXT, started_at INTEGER, completed_at INTEGER, duration_ms INTEGER); CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT, rollout_ordinal INTEGER, item_json TEXT);');
const command = { type: 'commandExecution', id: 'tool-1', command: 'cat README.md', cwd: '/tmp/project', status: 'completed', aggregatedOutput: 'contents', exitCode: 0, commandActions: [{ type: 'read', name: 'README.md', path: 'README.md' }], durationMs: 12 };
source.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('original', 'turn-a', 1, 'completed', null, 100, 101, 12);
source.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('other-session', 'turn-a', 1, 'failed', '{"message":"private other-session message"}', 100, 101, 12);
source.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?)').run('original', 'turn-a', command.id, 2, JSON.stringify(command));
source.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?)').run('other-session', 'turn-a', 'reply-1', 2, JSON.stringify({ type: 'agentMessage', id: 'reply-1', text: 'other-session content' }));
source.close();

test('paginated history preserves canonical native command data and reads only the requested thread', () => {
  const turns = readNativeHistory(config, 'original');
  assert.deepEqual(turns, [{ id: 'turn-a', items: [command], itemsView: 'full', status: 'completed', error: null, startedAt: 100, completedAt: 101, durationMs: 12 }]);
  assert.equal(readNativeHistory(config, 'missing-thread').length, 0);
});

test('native history carries real failure state without modifying the source database', () => {
  assert.deepEqual(readNativeHistory(config, 'other-session')[0]!.error, { message: 'private other-session message' });
  const unchanged = new DatabaseSync(join(home, 'thread_history_1.sqlite'), { readOnly: true });
  assert.equal(unchanged.prepare('SELECT COUNT(*) AS count FROM thread_items').get()!.count, 2);
  unchanged.close();
});
