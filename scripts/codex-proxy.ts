#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import WebSocket from 'ws';
import { readConfig } from '../server/config.js';
import { assertRoute, routeDirectory, codexMetadata } from '../server/codex-native.js';
import { joinRequest, type RpcMessage } from '../server/codex-proxy.js';
import { readNativeHistory, needsHistoryCompatibility } from '../server/codex-history.js';

const args = process.argv.slice(2);
const routePath = process.env.HERDR_BRIDGE_CODEX_ROUTE;
if (args[0] !== 'app-server' || !routePath) {
  // Version/catalog probes have no agent route and contain no live thread.
  // Paseo's metadata clients continue using the ordinary Codex command.
  const env = { ...process.env };
  delete env.HERDR_BRIDGE_CODEX_ROUTE;
  const config = process.env.HERDR_BRIDGE_CONFIG ? readConfig() : undefined;
  const child = spawn(config?.launch.codexCommand ?? 'codex', args, { env, stdio: 'inherit' });
  child.once('exit', code => process.exit(code ?? 1));
  process.once('SIGTERM', () => child.kill('SIGTERM'));
  process.once('SIGINT', () => child.kill('SIGINT'));
} else {
  const config = readConfig();
  if (!resolve(routePath).startsWith(resolve(routeDirectory(config)) + '/')) throw new Error('Native route is outside this bridge instance.');
  const route = await assertRoute(config, JSON.parse(await readFile(routePath, 'utf8')));
  const ws = new WebSocket('ws+unix://' + route.socket + ':/');
  const lines = createInterface({ input: process.stdin });
  const queue: RpcMessage[] = [];
  let ready = false;
  let joining = false;
  let stopped = false;
  let checked = 0;
  let serial = Promise.resolve();
  let joinTimer: ReturnType<typeof setTimeout> | undefined;
  const historyRequests = new Set<number | string>();
  const resumeRequests = new Set<number | string>();
  const publish = (message: unknown) => process.stdout.write(JSON.stringify(message) + '\n');
  const send = (message: RpcMessage) => ws.send(JSON.stringify(message));
  const flush = () => { if (ready && !joining) for (const message of queue.splice(0)) send(message); };
  function stop(error?: Error) {
    if (stopped) return;
    stopped = true; clearTimeout(joinTimer);
    if (error) console.error('Herdr native Codex transport: ' + error.message);
    ws.terminate(); lines.close(); process.exitCode = error ? 1 : 0;
  }
  ws.on('open', () => { ready = true; flush(); });
  lines.on('line', line => {
    serial = serial.then(async () => {
      const message: RpcMessage = JSON.parse(line);
      // Revalidate every mutation and permission response, even within one
      // second. Read-only discovery requests share a short liveness check.
      const readOnly = message.method && /^(?:initialize|initialized|model\/list|config\/read|skills\/list|collaborationMode\/list|thread\/read|thread\/loaded\/list|getUserSavedConfig)$/.test(message.method);
      if (!readOnly || Date.now() - checked > 1000) { await assertRoute(config, route); checked = Date.now(); }
      if (message.method === 'initialized') {
        send(message); joining = true;
        joinTimer = setTimeout(() => stop(new Error('Joining the original Codex thread timed out.')), 10000);
        send({ id: 'herdr-native-subscribe', method: 'thread/resume', params: { threadId: route.nativeId, excludeTurns: true } });
        return;
      }
      try {
        const outgoing = joinRequest(message, route, process.env.HERDR_BRIDGE_CODEX_CREATED === '1');
        if (outgoing.id !== undefined && outgoing.method === 'thread/read' && outgoing.params?.includeTurns === true) historyRequests.add(outgoing.id);
        if (outgoing.id !== undefined && outgoing.method === 'thread/resume') resumeRequests.add(outgoing.id);
        queue.push(outgoing); flush();
      }
      catch (error) {
        if (message.id !== undefined) publish({ id: message.id, error: { code: -32602, message: (error as Error).message } });
        else throw error;
      }
    }).catch(error => stop(error instanceof Error ? error : new Error(String(error))));
  });
  ws.on('message', async bytes => {
    const message: RpcMessage = JSON.parse(bytes.toString());
    if (message.id === 'herdr-native-subscribe') {
      clearTimeout(joinTimer);
      // Codex 0.162 subscribes the connection before attempting paginated
      // hydration. Its list_turns error therefore follows a successful join;
      // verified against thread/unsubscribe's notSubscribed/unsubscribed state.
      if (message.error && !needsHistoryCompatibility(String((message.error as any).message))) { stop(new Error('The original Codex thread could not be joined.')); return; }
      joining = false; flush(); return;
    }
    const history = message.id !== undefined && historyRequests.delete(message.id);
    const resume = message.id !== undefined && resumeRequests.delete(message.id);
    if ((history || resume) && message.error && needsHistoryCompatibility(String((message.error as any).message))) {
      let metadata: Awaited<ReturnType<typeof codexMetadata>> | undefined;
      try {
        await assertRoute(config, route);
        metadata = await codexMetadata(route.socket);
        const summary = await metadata.request('thread/read', { threadId: route.nativeId, includeTurns: false });
        const turns = readNativeHistory(config, route.nativeId);
        if (summary.thread.preview && turns.length === 0) throw new Error('Native history is not yet available; refusing to show an empty history.');
        const thread = { ...summary.thread, turns };
        // Return only values actually exposed by the native metadata API.
        // Effective permissions are not guessed or changed by this fallback.
        publish({ id: message.id, result: resume ? { thread, model: thread.model, modelProvider: thread.modelProvider, cwd: thread.cwd, reasoningEffort: thread.reasoningEffort } : { thread } });
      } catch (error) { publish({ id: message.id, error: { code: -32603, message: 'Native Codex history: ' + (error as Error).message } }); }
      finally { metadata?.close(); }
      return;
    }
    publish(message);
  });
  ws.on('error', error => stop(error));
  ws.on('close', () => stop());
  process.once('SIGTERM', () => stop());
  process.once('SIGINT', () => stop());
  lines.on('close', () => stop());
}
