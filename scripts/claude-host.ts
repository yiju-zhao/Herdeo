import { createServer, type Socket } from 'node:net';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, writeFile, chmod, unlink, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { ClaudeWire, type ClaudeMessage } from '../server/claude-wire.js';
import { bridgeRuntime, readConfig } from '../server/config.js';
import { transport } from '../server/herdr.js';
import { connectPaseo } from '../server/paseo.js';
import { assertClaudeRoute, claudeRouteFile } from '../server/claude-native.js';
import { terminalControl } from '../server/terminal-controls.js';
import { respondFromTerminal } from '../server/terminal-permission.js';

const autoRegister = process.env.HERDR_BRIDGE_CLAUDE_REGISTER === '1';
const startupConfig = process.env.HERDR_BRIDGE_CONFIG ? readConfig() : undefined;
const socketPath = process.env.HERDR_BRIDGE_CLAUDE_SOCKET ?? (autoRegister ? bridgeRuntime(startupConfig) + '/' + randomUUID().slice(0, 8) + '.sock' : undefined);
const expectedCwd = resolve(process.env.HERDR_BRIDGE_CLAUDE_CWD ?? process.cwd());
if (!socketPath || !resolve(socketPath).startsWith(bridgeRuntime(startupConfig)+'/')) throw new Error('Claude host requires its configured private runtime.');
const wire = new ClaudeWire();
const peers = new Map<string, Socket>();
let engine: ChildProcessWithoutNullStreams | undefined;
let sessionId: string | undefined;
let paseoAgentId: string | undefined;
let everStarted=false;
const write = (socket: Socket, message: unknown) => socket.write(JSON.stringify(message) + '\n');
const broadcast = (message: unknown) => { for (const peer of peers.values()) write(peer, message); };
const sendEngine = (message: ClaudeMessage) => {
 if (!engine?.stdin.writable) throw new Error('The original Claude executor is not running.');
 if(message.type==='user'){
  const content=message.message?.content;
  const text=typeof content==='string'?content:Array.isArray(content)?content.filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('\n'):'';
  if(text)process.stdout.write('\nYou: '+text+'\n');
 }
 engine.stdin.write(JSON.stringify(message) + '\n');
};
const metadata = () => ({ type: 'bridge.ready', hostPid: process.pid, enginePid: engine?.pid, sessionId, paseoAgentId });
const server = createServer(socket => {
  const peerId = randomUUID();
  let attached = false;
  const input = createInterface({ input: socket });
  input.on('line', line => {
    try {
      const frame = JSON.parse(line);
      if (!attached) {
        if (frame.type !== 'bridge.attach' || resolve(frame.cwd) !== expectedCwd || !Array.isArray(frame.args) || frame.args.some((x: unknown) => typeof x !== 'string')) throw new Error('Invalid native Claude attachment.');
        if(typeof frame.env?.HERDR_BRIDGE_PASEO_AGENT_ID==='string'){
          if(paseoAgentId&&paseoAgentId!==frame.env.HERDR_BRIDGE_PASEO_AGENT_ID)throw Error('This Claude executor belongs to its original Paseo agent');
          paseoAgentId=frame.env.HERDR_BRIDGE_PASEO_AGENT_ID;
        }
        if (sessionId) for (const option of ['--resume', '--session-id']) {
          const index=frame.args.indexOf(option);
          if(index>=0&&frame.args[index+1]!==sessionId)throw Error('This transport is bound to the original Claude session');
        }
        if (!engine) {
          if(everStarted)throw new Error('The original Claude executor has exited. This host will not create a replacement.');
          if (!frame.args.includes('--input-format') || !frame.args.includes('stream-json')) throw new Error('The host accepts only the Claude SDK machine protocol.');
          const format=frame.args.indexOf('--output-format');
          if(format<0||frame.args[format+1]!=='stream-json')throw Error('Initialize this host through the actual Claude SDK before attaching observers.');
          const env: NodeJS.ProcessEnv = { ...process.env, ...frame.env };
          for(const key of ['HERDR_SOCKET_PATH','HERDR_PANE_ID','HERDR_WORKSPACE_ID','HERDR_TAB_ID','HERDR_ENV','HERDR_BRIDGE_CONFIG'])if(process.env[key])env[key]=process.env[key];
          for (const name of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID']) delete env[name];
          engine = spawn(startupConfig?.launch.claudeCommand ?? 'claude', frame.args, { cwd: expectedCwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
          everStarted=true;
          createInterface({ input: engine.stdout }).on('line', row => {
            try {
              const native = JSON.parse(row);
              if (typeof native.session_id === 'string' && !native.parent_tool_use_id && native.session_id!==sessionId) {
                sessionId = native.session_id;void awaitMetadata();
                if(process.env.HERDR_BRIDGE_CONFIG&&process.env.HERDR_SOCKET_PATH&&process.env.HERDR_PANE_ID){
                  const config=readConfig();
                  if(config.herdr.some(h=>h.socket===process.env.HERDR_SOCKET_PATH))void transport.request(process.env.HERDR_SOCKET_PATH,'pane.report_agent_session',
                    {pane_id:process.env.HERDR_PANE_ID,source:'herdr:claude',agent:'claude',agent_session_id:sessionId}).catch(()=>{});
                }
              }
              const output = wire.output(native);
              if (output.peer) { const target = peers.get(output.peer); if (target) write(target, { type: 'bridge.stdout', message: output.message }); }
              else broadcast({ type: 'bridge.stdout', message: output.message });
              if (native.type === 'assistant') for (const block of native.message?.content ?? []) if (block.type === 'text') process.stdout.write('\nClaude: ' + block.text + '\n');
              if (native.type === 'control_request' && native.request?.subtype==='can_use_tool') process.stdout.write('\nClaude requires input. Use /pending, /allow [ID], /deny [ID], or reply in Paseo.\n');
              if (native.type === 'result') process.stdout.write('\nYou> ');
            } catch (error) { console.error('Claude host output: ' + (error as Error).message); }
          });
          engine.stderr.on('data', data => broadcast({ type: 'bridge.stderr', text: data.toString() }));
          engine.once('exit', code => { broadcast({ type: 'bridge.exit', code }); engine = undefined; });
          awaitMetadata();
        }
        peers.set(peerId, socket); attached = true; write(socket, metadata());
        for (const message of wire.pendingRequests()) write(socket, { type: 'bridge.stdout', message });
        return;
      }
      if(frame.type==='bridge.user'){
        if(!wire.initialized||typeof frame.text!=='string')throw Error('The native Claude session is not initialized');
        sendEngine({type:'user',message:{role:'user',content:frame.text},parent_tool_use_id:null,session_id:sessionId??'',uuid:randomUUID()});
        write(socket,{type:'bridge.accepted'});return;
      }
      if (frame.type === 'bridge.stdin') { const message = wire.input(peerId, frame.message); if (message) sendEngine(message); }
    } catch (error) { write(socket, { type: 'bridge.error', message: (error as Error).message }); socket.end(); }
  });
  socket.once('close', () => { peers.delete(peerId); wire.detached(peerId); });
});
let metadataWrites = Promise.resolve();
function awaitMetadata() {
 const value = JSON.stringify(metadata());
 metadataWrites = metadataWrites.then(async () => {
  const temporary = socketPath! + '.json.tmp';
  await writeFile(temporary, value, {mode: 0o600});
  await rename(temporary, socketPath! + '.json');
 });
 return metadataWrites;
}
await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
await new Promise<void>(resolveReady => server.listen(socketPath, resolveReady));
await chmod(socketPath, 0o600);
await awaitMetadata();
process.stdout.write('Claude shared executor — waiting for Paseo.\nYou> ');
if (process.stdin.isTTY) createInterface({ input: process.stdin, output: process.stdout }).on('line', async text => {
  if (!text.trim()) return;
  try{
   const decision=terminalControl('claude',text,wire.pendingRequests());
   if(typeof decision==='string'){process.stdout.write('\n'+decision+'\nYou> ');return;}
   if(decision){
    if(startupConfig&&await respondFromTerminal(startupConfig,paseoAgentId,'claude',decision,wire.pendingRequests()))return;
    const message=wire.input('terminal',decision);if(message)sendEngine(message);return;
   }
  }catch(error){console.error((error as Error).message);return;}
  if (!wire.initialized) { process.stdout.write('Connect Paseo before sending the first message.\nYou> '); return; }
  sendEngine({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: sessionId ?? '', uuid: randomUUID() });
});
function stop() { engine?.kill('SIGTERM'); for (const peer of peers.values()) peer.destroy(); server.close(); void unlink(socketPath!).catch(() => {}); }
process.once('SIGTERM', stop); process.once('SIGINT', stop);
if (autoRegister) {
 const config = readConfig();
 if (!config.nativeClaude) throw Error('Native Claude routing must be enabled');
 const pane = process.env.HERDR_PANE_ID;
 const herdrSocket = process.env.HERDR_SOCKET_PATH;
 const workspace = process.env.HERDR_WORKSPACE_ID;
 if (!pane || !herdrSocket || !workspace) throw Error('Start this shared Claude launcher inside its configured Herdr terminal');
 const route = {socket: socketPath, herdrSocket, pane, workspace, cwd: expectedCwd, hostPid: process.pid};
 await assertClaudeRoute(config, route);
 const agentId = randomUUID();
 const routeFile = claudeRouteFile(config, agentId);
 await mkdir(dirname(routeFile), {recursive: true, mode: 0o700});
 await writeFile(routeFile, JSON.stringify(route), {mode: 0o600});
 const client = await connectPaseo(config);
 try {
  const agent = await client.agents.create({agentId, cwd: expectedCwd, config: {provider: 'claude/' + (process.env.HERDR_BRIDGE_AGENT_MODEL ?? config.launch.claudeModel ?? 'claude-opus-5-5'),...(process.env.HERDR_BRIDGE_AGENT_MODE?{modeId:process.env.HERDR_BRIDGE_AGENT_MODE}:{})}, title: 'Claude'});
  // Initializes the actual SDK session without inserting a synthetic user turn.
  await agent.commands();
  if(process.env.HERDR_BRIDGE_INITIAL_PROMPT)await agent.send(process.env.HERDR_BRIDGE_INITIAL_PROMPT);
  paseoAgentId = agent.id;
  await awaitMetadata();
  process.stdout.write('\nRegistered native Claude in Paseo: ' + agent.id + '\nYou> ');
 } catch (error) {
  await unlink(routeFile).catch(() => {});
  stop();
  throw error;
 } finally { await client.close(); }
}
