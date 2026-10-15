import { randomUUID } from 'node:crypto';
import {
  negotiateProviderCapabilities, type ProviderRegistration, type ProviderConnection,
  type ProviderEvent, type ProviderInput, type ProviderTimelineItem,
} from '@getpaseo/plugin/server/provider';
import type { BridgeConfig } from './config.js';
import { discover, resolveSession, sendPrompt, interrupt, transport, type HerdrTransport, type NativeSession } from './herdr.js';
import { readTranscript, type TranscriptItem } from './transcripts.js';
import { launchNative } from './launch.js';

const capabilities = ['prompt.message', 'session.list', 'session.persistence'] as const;
const models = [{ id: 'codex', label: 'Codex in Herdr' }, { id: 'claude', label: 'Claude Code in Herdr' }];
interface View {
  id: string;
  key: string;
  emitted: Map<string, string>;
  userCorrelation: Map<string, string>;
  active?: { id: string; observedWork: boolean; response: boolean; started: number; settled: number };
  pending?: { text: string; clientMessageId: string; baseline: Set<string> };
  blocked: boolean;
  timer?: ReturnType<typeof setTimeout>;
  stopped: boolean;
}

export function createProvider(config: BridgeConfig, dependencies: {
  connection?: HerdrTransport;
  transcript?: typeof readTranscript;
} = {}): ProviderRegistration {
  return {
    id: 'herdr', label: 'Herdr live agents',
    description: 'Connect to an existing agent process in Herdr.',
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error('Provider protocol version 1 is required.');
      return createConnection(config, negotiateProviderCapabilities(request.capabilities, capabilities), dependencies);
    },
  };
}

function createConnection(config: BridgeConfig, negotiated: readonly string[], dependencies: {
  connection?: HerdrTransport;
  transcript?: typeof readTranscript;
}): ProviderConnection {
  const connection = dependencies.connection ?? transport;
  const loadTranscript = dependencies.transcript ?? readTranscript;
  const listeners = new Set<(event: ProviderEvent) => void>();
  const views = new Map<string, View>();
  let closed = false;
  const emit = (event: ProviderEvent) => { if (!closed) for (const listener of listeners) listener(event); };

  function publish(view: View, rows: TranscriptItem[]) {
    const latest = new Map(rows.map(row => [row.item.id, row]));
    for (const row of latest.values()) {
      let item: ProviderTimelineItem = row.item;
      if (view.pending && item.type === 'user_message' && item.text === view.pending.text && !view.pending.baseline.has(item.id)) {
        item = { ...item, clientMessageId: view.pending.clientMessageId };
        view.userCorrelation.set(item.id, view.pending.clientMessageId);
        view.pending = undefined;
      }
      if (item.type === 'user_message' && view.userCorrelation.has(item.id)) item = { ...item, clientMessageId: view.userCorrelation.get(item.id) };
      const encoded = JSON.stringify(item);
      if (view.emitted.get(item.id) === encoded) continue;
      const isNew = !view.emitted.has(item.id);
      view.emitted.set(item.id, encoded);
      emit({ type: 'timeline.item', sessionId: view.id, item, timestamp: row.timestamp });
      if (isNew && item.type === 'assistant_message' && view.active) view.active.response = true;
    }
  }

  function startTurn(view: View, id = randomUUID()) {
    view.active = { id, observedWork: false, response: false, started: Date.now(), settled: 0 };
    emit({ type: 'session.turn', sessionId: view.id, turnId: id, state: 'started' });
  }

  function endTurn(view: View, state: 'completed' | 'failed' | 'canceled', message?: string) {
    if (!view.active) return;
    emit({ type: 'session.turn', sessionId: view.id, turnId: view.active.id, state, error: message ? { message } : undefined });
    view.active = undefined;
    view.pending = undefined;
  }

  async function refresh(view: View, initial = false): Promise<NativeSession> {
    const native = await resolveSession(config, view.key, connection);
    if (native.key !== view.key) {
      view.key = native.key;
      // Keep Paseo's persistence/session ID stable during a turn. The durable
      // provisional binding resolves to this native key when the view reopens.
    }
    if (!initial && native.status === 'working' && !view.active) startTurn(view);
    publish(view, await loadTranscript(config, native));
    if (native.status === 'working' && view.active) { view.active.observedWork = true; view.active.settled = 0; }
    if (native.status === 'blocked' && !view.blocked) emit({
      type: 'session.notice', sessionId: view.id,
      notice: { id: 'herdr-blocked', severity: 'warning', title: 'This agent needs input in Herdr', description: 'Approval and question cards are not yet supported by this bridge.' },
    });
    if (native.status !== 'blocked' && view.blocked) emit({ type: 'session.notice', sessionId: view.id,
      notice: { id: 'herdr-blocked', severity: 'info', title: 'Herdr input resolved', dismissed: true } });
    view.blocked = native.status === 'blocked';
    if (!initial && view.active && ['idle', 'done'].includes(native.status)) {
      if (view.active.response) {
        view.active.settled++;
        if (view.active.settled >= 2) endTurn(view, 'completed');
      } else if (Date.now() - view.active.started > 30000) {
        endTurn(view, 'failed', 'Herdr did not show activity after the message was submitted. The message was not retried.');
      }
    }
    return native;
  }

  function schedule(view: View) {
    if (closed || view.stopped) return;
    view.timer = setTimeout(async () => {
      try { await refresh(view); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        endTurn(view, 'failed', message);
        emit({ type: 'session.runtime_failed', sessionId: view.id, error: { message } });
        view.stopped = true;
      }
      schedule(view);
    }, config.intervalMs);
  }

  function detach(view: View) {
    view.stopped = true;
    clearTimeout(view.timer);
    views.delete(view.id);
    // A view owns only its subscription. Herdr owns the original agent process.
  }

  async function dispatch(input: ProviderInput) {
    if (input.type === 'catalog') {
      emit({ type: 'catalog', requestId: input.requestId, catalog: { models, modes: [], defaultModel: 'codex' } }); return;
    }
    if (input.type === 'sessions') {
      const native = await discover(config, connection);
      emit({ type: 'sessions', requestId: input.requestId, sessions: native.map(session => ({
        persistence: { version: 1, data: { key: session.key } }, cwd: session.cwd, title: session.title,
      })) }); return;
    }
    if (input.type === 'session.open') {
      const persistence = input.persistence?.data as { key?: string } | undefined;
      let key = persistence?.key ?? input.config.providerOptions?.nativeKey;
      if (typeof key !== 'string') {
        const kind = input.config.model;
        if (kind !== 'codex' && kind !== 'claude') throw new Error('Choose Codex or Claude Code for the Herdr agent.');
        key = (await launchNative(config, kind, input.config.cwd, input.config.env.PASEO_AGENT_ID ?? input.sessionId)).key;
      }
      const native = await resolveSession(config, key, connection);
      const view: View = { id: input.sessionId, key, emitted: new Map(), userCorrelation: new Map(), stopped: false, blocked: false };
      views.set(view.id, view);
      emit({ type: 'session.opened', requestId: input.requestId, sessionId: view.id,
        capabilities: negotiated, restoration: 'core', persistence: { version: 1, data: { key } }, title: input.config.title ?? native.title, cwd: native.cwd });
      emit({ type: 'session.config', sessionId: view.id,
        config: { model: native.provider, models, modes: [], thinkingOptions: [], settings: [] } });
      if (input.history === 'replay') publish(view, await loadTranscript(config, native));
      emit({ type: 'session.ready', requestId: input.requestId, sessionId: view.id });
      if (native.status === 'working') startTurn(view);
      schedule(view); return;
    }
    if (!('sessionId' in input)) throw new Error('This operation is not supported by Herdr bridge.');
    const view = views.get(input.sessionId);
    if (!view) throw new Error('The Herdr view is not open.');
    if (input.type === 'session.prompt') {
      if (input.prompt.delivery === 'steer' || input.prompt.input.type !== 'message') throw new Error('Only text messages to an idle agent are currently supported.');
      const parts = input.prompt.input.content;
      if (parts.some(part => part.type !== 'text')) throw new Error('Only text attachments are currently supported.');
      const text = parts.filter(part => part.type === 'text').map(part => part.text).join('\n');
      if (!text.trim()) throw new Error('The message is empty.');
      await refresh(view);
      if (view.active) throw new Error('The original agent is already working.');
      view.pending = { text, clientMessageId: input.prompt.clientMessageId, baseline: new Set(view.emitted.keys()) };
      const turnId = randomUUID();
      try { await sendPrompt(config, view.key, text, connection); }
      catch (error) { view.pending = undefined; throw error; }
      emit({ type: 'session.prompt_result', sessionId: view.id, clientMessageId: input.prompt.clientMessageId, result: { type: 'turn', turnId } });
      startTurn(view, turnId); return;
    }
    if (input.type === 'session.interrupt') {
      await interrupt(config, view.key, connection);
      endTurn(view, 'canceled'); emit({ type: 'request.completed', requestId: input.requestId }); return;
    }
    if (input.type === 'session.close') {
      detach(view); emit({ type: 'session.closed', sessionId: view.id });
      emit({ type: 'request.completed', requestId: input.requestId }); return;
    }
    throw new Error('This operation is not supported by Herdr bridge.');
  }

  return {
    version: 1, capabilities: negotiated,
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async send(input) {
      if (closed) throw new Error('The bridge connection is closed.');
      try { await dispatch(input); }
      catch (error) {
        const detail = { message: error instanceof Error ? error.message : String(error) };
        if (input.type === 'session.prompt') emit({ type: 'session.prompt_result', sessionId: input.sessionId,
          clientMessageId: input.prompt.clientMessageId, result: { type: 'failed', error: detail } });
        else if ('requestId' in input) emit({ type: 'request.failed', requestId: input.requestId, error: detail });
        else throw error;
      }
    },
    async close() { for (const view of views.values()) detach(view); closed = true; listeners.clear(); },
  };
}
