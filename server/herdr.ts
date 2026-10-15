import { createConnection } from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { BridgeConfig } from './config.js';
import { inScope } from './config.js';
import { bindings, saveBinding, canonicalKey } from './bindings.js';

export type AgentKind = 'codex' | 'claude';
export interface NativeSession {
  key: string;
  host: string;
  socket: string;
  pane: string;
  provider: AgentKind;
  nativeId: string;
  terminal?: string;
  cwd: string;
  title: string;
  status: string;
}
interface AgentRecord {
  agent: string;
  pane_id: string;
  terminal_id?: string;
  agent_status: string;
  cwd: string;
  terminal_title_stripped?: string;
  agent_session?: { value?: string; kind?: string };
}
export interface HerdrTransport {
  request<T = Record<string, unknown>>(socket: string, method: string, params?: Record<string, unknown>): Promise<T>;
}

export const transport: HerdrTransport = {
  request<T>(socketPath: string, method: string, params = {}): Promise<T> {
    return new Promise((resolveResult, reject) => {
      const socket = createConnection(socketPath);
      const id = randomUUID();
      let buffered = '';
      const timer = setTimeout(() => finish(new Error('Herdr request timed out: ' + method)), 10000);
      function finish(error?: Error, value?: T) {
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error); else resolveResult(value as T);
      }
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write(JSON.stringify({ id, method, params }) + '\n'));
      socket.on('error', error => finish(error));
      socket.on('data', data => {
        buffered += data;
        for (;;) {
          const newline = buffered.indexOf('\n');
          if (newline < 0) break;
          const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
          try {
            const message = JSON.parse(line);
            if (message.id !== id) continue;
            if (message.error) finish(new Error(String(message.error.code) + ': ' + String(message.error.message)));
            else finish(undefined, message.result as T);
          } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
        }
      });
      socket.on('close', () => { clearTimeout(timer); reject(new Error('Herdr connection closed before its response')); });
    });
  },
};

export function sessionKey(socket: string, provider: string, nativeId: string): string {
  return createHash('sha256').update(resolve(socket) + '\0' + provider + '\0' + nativeId).digest('hex');
}

export async function discover(config: BridgeConfig, connection = transport): Promise<NativeSession[]> {
  const result: NativeSession[] = [];
  const pending = await bindings(config);
  for (const host of config.herdr) {
    let listing:{agents:AgentRecord[]};
    try{listing=await connection.request<{ agents: AgentRecord[] }>(host.socket, 'agent.list');}
    catch(error){if(['ENOENT','ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code??''))continue;throw error;}
    for (const agent of listing.agents) {
      if (agent.agent !== 'codex' && agent.agent !== 'claude') continue;
      let nativeId = agent.agent_session?.value;
      if (!inScope(config, agent.cwd)) continue;
      const related = pending.filter(x => x.socket === host.socket && x.terminal === agent.terminal_id);
      if (!nativeId || related.some(x => !x.nativeKey)) {
        const info = await connection.request<{ process_info: { foreground_processes: Array<{ pid: number; name: string; argv0?: string }> } }>(host.socket, 'pane.process_info', { pane_id: agent.pane_id });
        const process = info.process_info.foreground_processes.find(p => p.name.toLowerCase().includes(agent.agent) || p.argv0?.split('/').at(-1) === agent.agent);
        if (!process || !agent.terminal_id) continue;
        if (!nativeId) {
          nativeId = 'pending:' + agent.terminal_id + ':' + process.pid;
          const key = sessionKey(host.socket, agent.agent, nativeId);
          if (!pending.some(x => x.key === key)) await saveBinding(config, { key, socket: host.socket, terminal: agent.terminal_id, pid: process.pid });
        } else for (const binding of related) {
          if (!binding.nativeKey && binding.pid === process.pid) await saveBinding(config, { ...binding, nativeKey: sessionKey(host.socket, agent.agent, nativeId) });
        }
      }
      result.push({
        key: sessionKey(host.socket, agent.agent, nativeId), host: host.name, socket: host.socket, terminal: agent.terminal_id,
        pane: agent.pane_id, provider: agent.agent, nativeId, cwd: agent.cwd,
        title: agent.terminal_title_stripped || agent.agent + ' · ' + agent.cwd.split('/').at(-1),
        status: agent.agent_status,
      });
    }
  }
  return result;
}

export async function resolveSession(config: BridgeConfig, key: string, connection = transport): Promise<NativeSession> {
  const sessions = await discover(config, connection);
  const resolved = await canonicalKey(config, key);
  const found = sessions.find(session => session.key === resolved);
  if (!found) throw new Error('The original Herdr session is no longer present. Input was not sent.');
  return found;
}

export async function sendPrompt(config: BridgeConfig, key: string, text: string, connection = transport): Promise<void> {
  const session = await resolveSession(config, key, connection);
  if (session.status === 'blocked') throw new Error('This agent needs an answer in Herdr before it can accept another message.');
  if (session.status === 'working') throw new Error('This agent is working. Wait for it to finish; active-turn steering is not implemented.');
  await connection.request(session.socket, 'agent.prompt', { target: session.pane, text });
}

export async function interrupt(config: BridgeConfig, key: string, connection = transport): Promise<void> {
  const session = await resolveSession(config, key, connection);
  if (session.status === 'working') await connection.request(session.socket, 'agent.send_keys', { target: session.pane, keys: ['esc'] });
}
