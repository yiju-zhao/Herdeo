import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { z } from 'zod';
import type { BridgeConfig } from './config.js';

const itemSchema = z.object({ id: z.string(), type: z.string() }).passthrough();
const statuses = z.enum(['completed', 'interrupted', 'failed', 'inProgress']);

/** Codex 0.162 stores the canonical app-server ThreadItem JSON here. Read the
 * same items losslessly when that release's paginated read RPC is unavailable.
 * The source database is opened read-only; this is not a second transcript. */
export function readNativeHistory(config: BridgeConfig, nativeId: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(nativeId)) throw new Error('Invalid native Codex thread ID.');
  const database = new DatabaseSync(join(config.transcriptRoots.codex, 'thread_history_1.sqlite'), { readOnly: true });
  try {
    for (const [table, required] of [
      ['thread_turns', ['thread_id', 'turn_id', 'rollout_ordinal', 'status', 'error_json', 'started_at', 'completed_at', 'duration_ms']],
      ['thread_items', ['thread_id', 'turn_id', 'item_id', 'item_json', 'rollout_ordinal']],
    ] as const) {
      const columns = new Set(database.prepare('PRAGMA table_info(' + table + ')').all().map(row => row.name));
      if (required.some(name => !columns.has(name))) throw new Error('Unsupported Codex native history schema: ' + table);
    }
    database.exec('BEGIN');
    const turns = database.prepare('SELECT turn_id, status, error_json, started_at, completed_at, duration_ms FROM thread_turns WHERE thread_id = ? ORDER BY rollout_ordinal').all(nativeId);
    const items = database.prepare('SELECT turn_id, item_id, item_json FROM thread_items WHERE thread_id = ? ORDER BY rollout_ordinal').all(nativeId);
    const byTurn = new Map<string, Array<Record<string, unknown>>>();
    for (const row of items) {
      const item = itemSchema.parse(JSON.parse(String(row.item_json)));
      if (item.id !== row.item_id) throw new Error('Native history item identity does not match its source row.');
      const id = String(row.turn_id);
      const entries = byTurn.get(id) ?? []; entries.push(item); byTurn.set(id, entries);
    }
    return turns.map(row => ({
      id: String(row.turn_id), items: byTurn.get(String(row.turn_id)) ?? [], itemsView: 'full' as const,
      status: statuses.parse(row.status === 'in_progress' ? 'inProgress' : row.status),
      error: row.error_json === null ? null : JSON.parse(String(row.error_json)),
      startedAt: row.started_at, completedAt: row.completed_at, durationMs: row.duration_ms,
    }));
  } finally { database.close(); }
}

export const needsHistoryCompatibility = (message: string) => /(?:list_turns|thread\/items\/list).*not supported yet/.test(message);
