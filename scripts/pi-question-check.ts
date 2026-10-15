import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { readConfig } from '../server/config.js';
import { connectPaseo } from '../server/paseo.js';
import { createPiHost, piRouteFile, piRuntime } from '../server/pi-native.js';
import { readJsonLines } from '../server/jsonl.js';

const root = resolve(import.meta.dirname, '..'), config = readConfig(join(root, '.dev/claude-native.json'));
assert.equal(config.paseoUrl, 'ws://127.0.0.1:6797/ws'); assert.ok(config.nativePi && config.launch.piModel);
const extension = join(root, '.dev/pi-question-fixture.ts');
// Scoped to one newly created test executor, never installed in global Pi settings.
await writeFile(extension, `import { Type } from 'typebox';
export default function (pi) {
 pi.registerTool({name:'bridge_question',label:'Bridge question',description:'Ask the user for a yes/no bridge transport test. Does not read or write files.',parameters:Type.Object({}),
  async execute(_id,_params,_signal,_update,ctx){
   const yes=await ctx.ui.confirm('Pi bridge verification','Choose No to complete this transport test. No files will be changed.');
   return {content:[{type:'text',text:yes?'PI_QUESTION_ALLOWED':'PI_QUESTION_DENIED'}],details:{confirmed:yes}};
  }});
}
`);
const route = await createPiHost(config, config.workspaceRoots[0]!);
const socket = createConnection(route.socket);
let deniedToolResult = false;
await new Promise<void>((ready, reject) => {
 socket.once('error', reject);
 readJsonLines(socket, frame => {
  if (frame.type === 'bridge.ready') ready();
  if (frame.type === 'bridge.error') reject(Error(frame.message));
  if (frame.type === 'bridge.stdout' && frame.message.type === 'tool_execution_end' && frame.message.result?.content?.some((c: any) => c.text === 'PI_QUESTION_DENIED')) deniedToolResult = true;
 }, reject);
 socket.once('connect', () => socket.write(JSON.stringify({type:'bridge.attach',cwd:route.cwd,args:['--offline','--mode','rpc','--session-dir',join(piRuntime(),'sessions'),'--no-approve','--no-mcp','--model',config.launch.piModel,'--extension',extension]})+'\n'));
});
let original: any;
for (let i = 0; i < 100; i++) { original = JSON.parse(await readFile(route.socket + '.json', 'utf8')); if (original.sessionId) break; await delay(100); }
assert.ok(original.sessionId);
const id = randomUUID(), file = piRouteFile(config, id);
await mkdir(dirname(file), {recursive: true, mode: 0o700}); await writeFile(file, JSON.stringify(route), {mode: 0o600});
const client = await connectPaseo(config);
try {
 const agent = await client.agents.create({agentId: id, cwd: route.cwd, config: {provider: 'pi/' + config.launch.piModel}, title: 'Pi native question validation'});
 const result = await agent.run('Call bridge_question exactly once. Do not use any other tool. After it returns, reply exactly with the text returned by the tool. Do not retry or perform any file operations.', {timeoutMs: 120000});
 assert.equal(result.status, 'permission', 'Expected a real Pi extension UI request');
 const request = (await agent.refresh())!.agent.pendingPermissions?.[0]; assert.ok(request);
 assert.equal(request.provider, 'pi'); assert.equal(request.kind, 'question');
 await agent.respondToPermission({requestId: request.id, response: {behavior: 'deny', message: 'Test answer: No'}});
 const finished = await agent.waitForFinish(120000); assert.equal(finished.status, 'idle');
 assert.ok(deniedToolResult, 'Native Pi tool did not receive the negative answer');
 const after = JSON.parse(await readFile(route.socket + '.json', 'utf8'));
 assert.equal(after.enginePid, original.enginePid); assert.equal(after.sessionId, original.sessionId);
 await writeFile(join(root, '.dev/pi-question-evidence.json'), JSON.stringify({paseoAgentId: id, provider: 'pi', questionRendered: true, denied: true, nativeToolReceivedDenial: true, originalPidPreserved: true, enginePid: after.enginePid, nativeSessionId: after.sessionId, pane: route.pane}, null, 2)+'\n');
 console.log('PASS: real Pi extension confirmation renders as a native Paseo question, and No reaches the original executor.');
} finally { socket.destroy(); await client.close(); }
