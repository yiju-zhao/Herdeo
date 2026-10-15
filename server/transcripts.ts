import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProviderTimelineItem } from '@getpaseo/plugin/server/provider';
import type { NativeSession } from './herdr.js';
import type { BridgeConfig } from './config.js';

export interface TranscriptItem { item: ProviderTimelineItem; timestamp?: string }
type Json = Record<string, any>;
const textContent = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value)
  ? value.filter(x => x && ['text', 'input_text', 'output_text'].includes(x.type)).map(x => x.text ?? '').join('\n') : '';

export function decodeTranscript(provider: NativeSession['provider'], source: string): TranscriptItem[] {
  const events: TranscriptItem[] = [];
  const tools = new Map<string, Extract<ProviderTimelineItem, { type: 'tool_call' }>>();
  const lines = source.split('\n');
  const canonicalMessages = new Set<string>();
  if (provider === 'codex') for (const line of lines) {
    try {
      const row = JSON.parse(line);
      const p = row.payload;
      if (row.type === 'response_item' && p?.type === 'message' && ['user', 'assistant'].includes(p.role)) canonicalMessages.add(p.role + ':' + textContent(p.content));
    } catch { /* The writer may still be appending the last line. */ }
  }
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]?.trim()) continue;
    let row: Json;
    try { row = JSON.parse(lines[i]!); } catch { if (i === lines.length - 1) break; else continue; }
    const emit = (item: ProviderTimelineItem) => events.push({ item, timestamp: row.timestamp });
    if (provider === 'codex') {
      const p = row.payload ?? {};
      if (row.type === 'event_msg') {
        if (p.type === 'user_message' && typeof p.message === 'string' && !canonicalMessages.has('user:' + p.message)) emit({ type: 'user_message', id: 'codex:user:' + i, text: p.message });
        if (p.type === 'agent_message' && typeof p.message === 'string' && !canonicalMessages.has('assistant:' + p.message)) emit({ type: 'assistant_message', id: 'codex:assistant:' + i, text: p.message });
      }
      if (row.type !== 'response_item') continue;
      if (p.type === 'message' && ['user', 'assistant'].includes(p.role)) {
        const text = textContent(p.content);
        if (text) emit(p.role === 'user' ? { type: 'user_message', id: 'codex:user:' + (p.id ?? i), text }
          : { type: 'assistant_message', id: 'codex:assistant:' + (p.id ?? i), text });
      }
      if (p.type === 'reasoning') {
        const text = textContent(p.summary?.map((x: Json) => ({ type: 'text', text: x.text })));
        if (text) emit({ type: 'reasoning', id: 'codex:reasoning:' + i, text });
      }
      if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        let input: any = p.arguments ?? p.input ?? '';
        try { input = JSON.parse(input); } catch { /* Native custom tools may use plain text. */ }
        const item: Extract<ProviderTimelineItem, { type: 'tool_call' }> = {
          type: 'tool_call', id: 'tool:' + p.call_id, callId: p.call_id, name: p.name ?? 'Tool',
          detail: { type: 'unknown', input, output: null }, status: 'running', error: null,
        };
        tools.set(p.call_id, item); emit(item);
      }
      if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        const before = tools.get(p.call_id);
        if (before) emit({ ...before, status: 'completed', error: null, detail: { type: 'unknown', input: before.detail.type === 'unknown' ? before.detail.input : null, output: p.output ?? null } });
      }
    } else {
      const message = row.message ?? {};
      const content = message.content;
      const id = String(row.uuid ?? message.id ?? i);
      if (row.type === 'user' && !row.isMeta && !row.isSynthetic) {
        const text = textContent(content);
        if (text) emit({ type: 'user_message', id: 'claude:user:' + id, text });
      }
      if (row.type === 'assistant' && Array.isArray(content)) {
        for (let j = 0; j < content.length; j++) {
          const block = content[j];
          if (block.type === 'text' && block.text) emit({ type: 'assistant_message', id: 'claude:assistant:' + id + ':' + j, text: block.text });
          if (block.type === 'thinking' && block.thinking) emit({ type: 'reasoning', id: 'claude:thinking:' + id + ':' + j, text: block.thinking });
          if (block.type === 'tool_use') {
            const item: Extract<ProviderTimelineItem, { type: 'tool_call' }> = {
              type: 'tool_call', id: 'tool:' + block.id, callId: block.id, name: block.name,
              detail: { type: 'unknown', input: block.input ?? {}, output: null }, status: 'running', error: null,
            };
            tools.set(block.id, item); emit(item);
          }
        }
      }
      if (row.type === 'user' && Array.isArray(content)) for (const block of content) {
        if (block.type !== 'tool_result') continue;
        const before = tools.get(block.tool_use_id);
        if (before) {
          const detail = { type: 'unknown' as const, input: before.detail.type === 'unknown' ? before.detail.input : null, output: block.content ?? null };
          emit(block.is_error ? { ...before, status: 'failed', error: block.content ?? 'Tool failed', detail } : { ...before, status: 'completed', error: null, detail });
        }
      }
    }
  }
  return events;
}

const paths = new Map<string, string>();
const snapshots = new Map<string, { size: number; mtime: number; items: TranscriptItem[] }>();
async function findById(directory: string, id: string, depth: number): Promise<string | undefined> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return undefined; }
  for (const entry of entries) if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.jsonl') && (entry.name === id + '.jsonl' || entry.name.endsWith('-' + id + '.jsonl'))) return join(directory, entry.name);
  if (depth > 0) for (const entry of entries) if (entry.isDirectory()) {
    const found = await findById(join(directory, entry.name), id, depth - 1);
    if (found) return found;
  }
  return undefined;
}

export async function readTranscript(config: BridgeConfig, session: NativeSession): Promise<TranscriptItem[]> {
  if (session.nativeId.startsWith('pending:')) return [];
  let path = paths.get(session.key);
  if (!path) {
    path = await findById(join(config.transcriptRoots[session.provider], session.provider === 'codex' ? 'sessions' : 'projects'), session.nativeId, session.provider === 'codex' ? 3 : 1);
    if (!path) return [];
    paths.set(session.key, path);
  }
  try {
    const info = await stat(path);
    if (info.size > 64 * 1024 * 1024) throw new Error('Transcript exceeds the initial 64 MiB history limit.');
    const cached = snapshots.get(session.key);
    if (cached?.size === info.size && cached.mtime === info.mtimeMs) return cached.items;
    const items = decodeTranscript(session.provider, await readFile(path, 'utf8'));
    snapshots.set(session.key, { size: info.size, mtime: info.mtimeMs, items });
    return items;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { paths.delete(session.key); return []; }
    throw error;
  }
}
