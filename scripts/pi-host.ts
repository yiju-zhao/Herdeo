import { createServer, type Socket } from 'node:net';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, writeFile, chmod, unlink, rename } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { PiWire, type PiMessage } from '../server/pi-wire.js';
import { readJsonLines } from '../server/jsonl.js';
import { readConfig } from '../server/config.js';
import { connectPaseo } from '../server/paseo.js';
import { assertPiRoute, piRouteFile, piRuntime } from '../server/pi-native.js';
import { transport } from '../server/herdr.js';
import { terminalControl } from '../server/terminal-controls.js';
import { respondFromTerminal } from '../server/terminal-permission.js';

const config = readConfig();
const autoRegister = process.env.HERDR_BRIDGE_PI_REGISTER === '1';
const socketPath = process.env.HERDR_BRIDGE_PI_SOCKET ?? join(piRuntime(config), randomUUID().slice(0, 8) + '.sock');
const cwd = resolve(process.env.HERDR_BRIDGE_PI_CWD ?? process.cwd());
if (!config.nativePi || !resolve(socketPath).startsWith(piRuntime(config) + '/')) throw Error('Pi requires its configured private runtime');
const wire = new PiWire();
const peers = new Map<string, Socket>();
const blocked = new Set<Socket>();
let engine: ChildProcessWithoutNullStreams | undefined;
let everStarted = false, sessionId: string | undefined, sessionFile: string | undefined, paseoAgentId: string | undefined;
let metadataWrites = Promise.resolve();
const metadata = () => ({type: 'bridge.ready', hostPid: process.pid, enginePid: engine?.pid, sessionId, sessionFile, paseoAgentId});
function saveMetadata() {
  const value = JSON.stringify(metadata());
  metadataWrites = metadataWrites.then(async () => {
    await writeFile(socketPath + '.json.tmp', value, {mode: 0o600});
    await rename(socketPath + '.json.tmp', socketPath + '.json');
  });
  return metadataWrites;
}
function write(socket: Socket, frame: unknown) {
  if (!socket.writable) return;
  if (!socket.write(JSON.stringify(frame) + '\n') && !blocked.has(socket)) {
    blocked.add(socket); engine?.stdout.pause();
    socket.once('drain', () => { blocked.delete(socket); if (!blocked.size) engine?.stdout.resume(); });
  }
}
function broadcast(frame: unknown) { for (const socket of peers.values()) write(socket, frame); }
function send(peer: string, message: PiMessage, socket?: Socket) {
  if (!engine?.stdin.writable) throw Error('The original Pi executor is no longer running');
  const native = wire.input(peer, message);
  if (native && !engine.stdin.write(JSON.stringify(native) + '\n') && socket) {
    socket.pause(); engine.stdin.once('drain', () => socket.resume());
  }
}
function nativeOutput(native: PiMessage) {
  const result = wire.output(native);
  if (native.type === 'response' && native.command === 'get_state' && native.success) {
    const state = native.data;
    if (sessionId && state.sessionId !== sessionId) throw Error('The Pi executor changed sessions unexpectedly');
    sessionId = state.sessionId; sessionFile = state.sessionFile;
    void saveMetadata();
    const socket = process.env.HERDR_SOCKET_PATH, pane = process.env.HERDR_PANE_ID;
    if (socket && pane && config.herdr.some(h => h.socket === socket)) void transport.request(socket, 'pane.report_agent_session', {pane_id: pane, source: 'herdr:pi', agent: 'pi', agent_session_id: sessionId}).catch(() => {});
  }
  if (result.peer) { const socket = peers.get(result.peer); if (socket) write(socket, {type: 'bridge.stdout', message: result.message}); }
  else broadcast({type: 'bridge.stdout', message: result.message});
  if(native.type==='message_start'&&native.message?.role==='user'){
    const content=native.message.content;
    const text=typeof content==='string'?content:Array.isArray(content)?content.filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('\n'):'';
    if(text)process.stdout.write('\nYou: '+text+'\n');
  }
  if (native.type === 'message_update' && native.assistantMessageEvent?.type === 'text_delta') process.stdout.write(native.assistantMessageEvent.delta ?? '');
  if (native.type === 'tool_execution_start') process.stdout.write('\n[' + native.toolName + ']\n');
  if (native.type === 'extension_ui_request' && ['select', 'input', 'editor', 'confirm'].includes(native.method)) process.stdout.write('\nPi requires input. Use /pending, /allow [ID], /deny [ID], /answer ID value, or reply in Paseo.\n');
  if (native.type === 'agent_settled') process.stdout.write('\nYou> ');
}
const server = createServer(socket => {
  const id = randomUUID(); let attached = false;
  const fail = (error: Error) => { write(socket, {type: 'bridge.error', message: error.message}); socket.end(); };
  readJsonLines(socket, frame => {
    if (!attached) {
      if (frame.type !== 'bridge.attach' || resolve(frame.cwd) !== cwd || !Array.isArray(frame.args) || frame.args.some((a: unknown) => typeof a !== 'string')) throw Error('Invalid Pi attachment');
      if(typeof frame.env?.HERDR_BRIDGE_PASEO_AGENT_ID==='string'){
        if(paseoAgentId&&paseoAgentId!==frame.env.HERDR_BRIDGE_PASEO_AGENT_ID)throw Error('This Pi executor belongs to its original Paseo agent');
        paseoAgentId=frame.env.HERDR_BRIDGE_PASEO_AGENT_ID;
      }
      const mode = frame.args.indexOf('--mode');
      if (mode < 0 || frame.args[mode + 1] !== 'rpc') throw Error('Only Pi native RPC is supported');
      const resume = frame.args.indexOf('--session');
      if (sessionFile && resume >= 0 && frame.args[resume + 1] !== sessionFile) throw Error('This transport is bound to the original Pi session file');
      if (!engine) {
        if (everStarted) throw Error('The original Pi executor exited; no replacement was created');
        const env: NodeJS.ProcessEnv = {...process.env, ...frame.env};
        for (const key of ['HERDR_SOCKET_PATH', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID', 'HERDR_ENV', 'HERDR_BRIDGE_CONFIG']) if (process.env[key]) env[key] = process.env[key];
        for (const key of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID']) delete env[key];
        engine = spawn(config.launch.piCommand ?? 'pi', frame.args, {cwd, env, stdio: ['pipe', 'pipe', 'pipe']});
        everStarted = true;
        engine.once('error', error => broadcast({type: 'bridge.error', message: error.message}));
        readJsonLines(engine.stdout, nativeOutput, error => broadcast({type: 'bridge.error', message: error.message}));
        engine.stderr.on('data', data => broadcast({type: 'bridge.stderr', text: data.toString()}));
        engine.once('exit', code => { broadcast({type: 'bridge.exit', code}); engine = undefined; void saveMetadata(); });
        void saveMetadata();
        send('host', {type: 'get_state'});
      }
      peers.set(id, socket); attached = true; write(socket, metadata());
      for (const message of wire.pendingRequests()) write(socket, {type: 'bridge.stdout', message});
      return;
    }
    try {
      if (frame.type === 'bridge.stdin') send(id, frame.message, socket);
      else if (frame.type === 'bridge.user' && typeof frame.text === 'string') { send(id, {type: 'prompt', message: frame.text}, socket); write(socket, {type: 'bridge.accepted'}); }
      else throw Error('Unknown Pi bridge frame');
    } catch (error) {
      if (frame.type === 'bridge.stdin') write(socket, {type: 'bridge.stdout', message: {type: 'response', id: frame.message?.id, command: frame.message?.type, success: false, error: (error as Error).message}});
      else throw error;
    }
  }, fail);
  socket.on('error', () => {});
  socket.once('close', () => { peers.delete(id); blocked.delete(socket); wire.detached(id); if (!blocked.size) engine?.stdout.resume(); });
});
await mkdir(dirname(socketPath), {recursive: true, mode: 0o700});
await new Promise<void>((ready, reject) => { server.once('error', reject); server.listen(socketPath, ready); });
await chmod(socketPath, 0o600); await saveMetadata();
process.stdout.write('Pi shared executor — waiting for Paseo.\nYou> ');
if (process.stdin.isTTY) createInterface({input: process.stdin, output: process.stdout}).on('line', async text => {
  if (!text.trim()) return;
  try{
    const decision=terminalControl('pi',text,wire.pendingRequests());
    if(typeof decision==='string'){process.stdout.write('\n'+decision+'\nYou> ');return;}
    if(decision){if(await respondFromTerminal(config,paseoAgentId,'pi',decision,wire.pendingRequests()))return;send('terminal',decision);return;}
  }catch(error){console.error((error as Error).message);return;}
  if (!sessionId) { process.stdout.write('Connect Paseo first.\nYou> '); return; }
  try { send('terminal', {type: 'prompt', message: text}); } catch (error) { console.error((error as Error).message); }
});
function stop() { engine?.kill('SIGTERM'); for (const socket of peers.values()) socket.destroy(); server.close(); void unlink(socketPath).catch(() => {}); }
process.once('SIGTERM', stop); process.once('SIGINT', stop);
if (autoRegister) {
  const pane = process.env.HERDR_PANE_ID, herdrSocket = process.env.HERDR_SOCKET_PATH, workspace = process.env.HERDR_WORKSPACE_ID;
  if (!pane || !herdrSocket || !workspace) throw Error('Pi auto-registration requires its configured Herdr terminal');
  const route = {socket: socketPath, herdrSocket, pane, workspace, cwd, hostPid: process.pid};
  await assertPiRoute(config, route);
  const agentId = randomUUID(), file = piRouteFile(config, agentId);
  await mkdir(dirname(file), {recursive: true, mode: 0o700});
  await writeFile(file, JSON.stringify(route), {mode: 0o600});
  const client = await connectPaseo(config);
  try {
    let model=process.env.HERDR_BRIDGE_AGENT_MODEL??config.launch.piModel;
    if(!model||model==='unknown/unknown'){
      await client.providers.refresh({providers:['pi'],cwd});
      const models=(await client.providers.listModels('pi',{cwd})).models??[];
      model=models.find(m=>m.isDefault)?.id??models[0]?.id;
      if(!model)throw Error('Pi has no available model account. Log in to Pi outside Herdr, then start a new shared Pi.');
    }
    const agent = await client.agents.create({agentId, cwd, config: {provider: 'pi/' + model,...(process.env.HERDR_BRIDGE_AGENT_THINKING?{thinkingOptionId:process.env.HERDR_BRIDGE_AGENT_THINKING}:{})}, title: 'Pi'});
    await agent.commands();
    if(process.env.HERDR_BRIDGE_INITIAL_PROMPT)await agent.send(process.env.HERDR_BRIDGE_INITIAL_PROMPT);
    paseoAgentId = agent.id; await saveMetadata();
    process.stdout.write('\nRegistered native Pi in Paseo: ' + agent.id + '\nYou> ');
  } catch (error) { await unlink(file).catch(() => {}); stop(); throw error; }
  finally { await client.close(); }
}
