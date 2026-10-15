import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { BridgeConfig } from './config.js';
import { codexSocketDirectory, inScope } from './config.js';
import { discover, resolveSession, transport, type NativeSession } from './herdr.js';

const execute = promisify(execFile);
const schema = z.object({
  key: z.string(), nativeId: z.string().regex(/^[a-zA-Z0-9_-]+$/), socket: z.string(),
  herdrSocket: z.string(), pane: z.string(), cwd: z.string(), pid: z.number().int().positive(),
});
export type CodexRoute = z.infer<typeof schema>;
export const routeDirectory = (config: BridgeConfig) => join(config.paseoHome, 'herdr-bridge/native-codex');
const safeAgentId = (id: string) => { if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid Paseo agent ID.'); return id; };
export const routeFile = (config: BridgeConfig, id: string) => join(routeDirectory(config), 'agents', safeAgentId(id) + '.json');
export const importClaimFile = (config: BridgeConfig) => join(routeDirectory(config), 'pending-import.json');

export function socketFromCommand(config: BridgeConfig, command: string): string | undefined {
  const socket = command.match(/(?:^|\s)--remote\s+unix:\/\/(\S+)/)?.[1];
  if (!socket) return undefined;
  const folder = resolve(codexSocketDirectory(config));
  const path = resolve(socket);
  if (!path.startsWith(folder + '/') || !path.endsWith('.sock')) throw new Error('Codex endpoint is outside the terminal-owned bridge sockets.');
  return path;
}

/** A metadata connection never creates, resumes or executes a native thread. */
export async function codexMetadata(socket: string) {
  const ws = new WebSocket('ws+unix://' + socket + ':/');
  let nextId = 0;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const fail = (error: Error) => { for (const wait of pending.values()) { clearTimeout(wait.timer); wait.reject(error); } pending.clear(); };
  ws.on('error', fail); ws.on('close', () => fail(new Error('The original Codex app-server connection closed.')));
  ws.on('message', bytes => {
    const message = JSON.parse(bytes.toString());
    if (message.method) return;
    const wait = pending.get(message.id);
    if (!wait) return;
    pending.delete(message.id); clearTimeout(wait.timer);
    if (message.error) wait.reject(new Error(message.error.message)); else wait.resolve(message.result);
  });
  const request = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolveResult, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Codex metadata request timed out: ' + method)); }, 5000);
    pending.set(id, { resolve: resolveResult, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  try {
    await new Promise<void>((resolveResult, reject) => {
      const timer = setTimeout(() => reject(new Error('Codex metadata connection timed out.')), 5000);
      ws.once('open', () => { clearTimeout(timer); resolveResult(); });
      ws.once('error', error => { clearTimeout(timer); reject(error); });
    });
    await request('initialize', { clientInfo: { name: 'herdr_paseo_bridge_discovery', title: 'Herdr Paseo bridge', version: '0.2.0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
    ws.send(JSON.stringify({ method: 'initialized' }));
    return { request, close() { ws.terminate(); fail(new Error('Metadata observation ended.')); } };
  } catch (error) { ws.terminate(); throw error; }
}

export async function codexForegroundEndpoint(config: BridgeConfig, processes: Array<{pid:number;name:string;argv0?:string}>, commandForPid=(pid:number)=>execute('ps',['-p',String(pid),'-o','args=']).then(r=>r.stdout)) {
  const candidates=processes.filter(p=>p.name.toLowerCase().includes('codex')||p.argv0?.split('/').at(-1)==='codex');
  if(!candidates.length)throw Error('The original Codex terminal is no longer in the foreground.');
  // Linux can list the terminal-owned app-server before the TUI. Only the
  // actual --remote client identifies which endpoint this pane is using.
  for(const process of candidates){
    let command:string;
    try{command=await commandForPid(process.pid);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')continue;throw error;}
    const socket=socketFromCommand(config,command);
    if(socket)return {pid:process.pid,socket};
  }
  throw Error('Native Codex adoption requires the terminal-owned app-server launcher.');
}
async function foreground(config: BridgeConfig, session: NativeSession) {
  const { process_info: info } = await transport.request<{ process_info: { foreground_processes: Array<{ pid: number; name: string; argv0?: string }> } }>(session.socket, 'pane.process_info', { pane_id: session.pane });
  return codexForegroundEndpoint(config,info.foreground_processes);
}

export async function nativeCodexRoute(config: BridgeConfig, session: NativeSession): Promise<CodexRoute> {
  if (session.provider !== 'codex' || !inScope(config, session.cwd)) throw new Error('This is not a configured native Codex workspace.');
  let process:Awaited<ReturnType<typeof foreground>>;
  for(let attempt=0;;attempt++){
    try{process=await foreground(config,session);break;}
    catch(error){if(!session.nativeId.startsWith('pending:')||attempt>=40||(error as Error).message!=='Native Codex adoption requires the terminal-owned app-server launcher.')throw error;await delay(100);}
  }
  const client = await codexMetadata(process.socket);
  try {
    let loaded: string[] = (await client.request('thread/loaded/list')).data;
    // The CLI is detected before it finishes opening its first blank thread.
    for (let attempt = 0; session.nativeId.startsWith('pending:') && loaded.length === 0 && attempt < 40; attempt++) {
      await delay(250);
      loaded = (await client.request('thread/loaded/list')).data;
    }
    let nativeId = session.nativeId;
    if (nativeId.startsWith('pending:')) {
      if (loaded.length !== 1) throw new Error('A blank terminal must identify exactly one native thread before adoption.');
      nativeId = loaded[0]!;
    }
    if (!loaded.includes(nativeId)) throw new Error('The original Herdr thread is not loaded in this app-server; it will not be recreated.');
    const response = await client.request('thread/read', { threadId: nativeId, includeTurns: false });
    if (resolve(response.thread.cwd) !== resolve(session.cwd)) throw new Error('Codex and Herdr report different workspace directories.');
    // Codex's blank TUI draft is loaded before it has a rollout file. Saving
    // its existing terminal title persists metadata without adding a message,
    // so the builtin provider can join the very same thread before turn one.
    if (!response.thread.name && !response.thread.preview) await client.request('thread/name/set', { threadId: nativeId, name: session.title });
    // Once the original TUI owns a live thread, its ID is available even before
    // the first transcript exists. Bind that ID to the same foreground PID.
    if (nativeId !== session.nativeId) {
      await transport.request(session.socket, 'pane.report_agent_session', { pane_id: session.pane, source: 'herdr:codex', agent: 'codex', agent_session_id: nativeId });
      session = (await discover(config)).find(x => x.pane === session.pane && x.socket === session.socket)!;
      if (!session || session.nativeId !== nativeId) throw new Error('Herdr did not bind the original native Codex thread.');
    }
    return { key: session.key, nativeId, socket: process.socket, herdrSocket: session.socket, pane: session.pane, cwd: session.cwd, pid: process.pid };
  } finally { client.close(); }
}

export async function assertRoute(config: BridgeConfig, input: unknown): Promise<CodexRoute> {
  const route = schema.parse(input);
  const session = await resolveSession(config, route.key);
  if (session.nativeId !== route.nativeId || session.socket !== route.herdrSocket || session.pane !== route.pane || resolve(session.cwd) !== resolve(route.cwd)) throw new Error('The original native Codex session has been replaced.');
  const current = await foreground(config, session);
  if (current.pid !== route.pid || current.socket !== route.socket) throw new Error('The original Codex terminal process has been replaced.');
  return route;
}

export async function saveRoute(config: BridgeConfig, agentId: string, route: CodexRoute): Promise<void> {
  const file = routeFile(config, agentId);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(schema.parse(route)), { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
}

export async function loadRoute(config: BridgeConfig, agentId: string): Promise<CodexRoute | undefined> {
  try { return schema.parse(JSON.parse(await readFile(routeFile(config, agentId), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

export async function claimImport(config: BridgeConfig, route: CodexRoute, action: () => Promise<void>) {
  await mkdir(routeDirectory(config), { recursive: true, mode: 0o700 });
  const file = importClaimFile(config);
  const owner = randomUUID();
  try { await writeFile(file, JSON.stringify({ route, owner, createdAt: Date.now() }), { mode: 0o600, flag: 'wx' }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const previous = JSON.parse(await readFile(file, 'utf8'));
    if (typeof previous.createdAt !== 'number' || Date.now() - previous.createdAt < 120000) throw new Error('Another native Codex import is still pending.');
    await unlink(file);
    await writeFile(file, JSON.stringify({ route, owner, createdAt: Date.now() }), { mode: 0o600, flag: 'wx' });
  }
  try { await action(); }
  finally {
    const current = JSON.parse(await readFile(file, 'utf8').catch(() => '{}'));
    if (current.owner === owner) await unlink(file).catch(() => {});
  }
}

export async function pendingImport(config: BridgeConfig, cwd: string): Promise<CodexRoute | undefined> {
  try {
    const claim = JSON.parse(await readFile(importClaimFile(config), 'utf8'));
    if (Date.now() - claim.createdAt > 60000 || resolve(claim.route.cwd) !== resolve(cwd)) throw new Error('The native import claim is stale or belongs to another workspace.');
    return await assertRoute(config, claim.route);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
