#!/usr/bin/env node
import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { readJsonLines } from '../server/jsonl.js';
import { readConfig } from '../server/config.js';
import { assertPiRoute, piRuntime } from '../server/pi-native.js';

const config = readConfig();
const args = process.argv.slice(2), path = process.env.HERDR_BRIDGE_PI_SOCKET;
if (!path) {
  // Catalog and diagnostic probes are ordinary ephemeral Pi invocations.
  const child = spawn(config.launch.piCommand ?? 'pi', args, {stdio: 'inherit', env: process.env});
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  child.once('exit', code => process.exit(code ?? 1));
  process.once('SIGTERM', () => child.kill('SIGTERM'));
} else {
  if (!path.startsWith(piRuntime(config) + '/')) throw Error('Pi transport requires its configured private socket');
  const routeFile = process.env.HERDR_BRIDGE_PI_ROUTE;
  if (routeFile) {
    const route = JSON.parse(await readFile(routeFile, 'utf8')); await assertPiRoute(config, route);
    if (route.socket !== path || route.cwd !== process.cwd()) throw Error('Pi transport does not match its registered route');
  }
  const socket = createConnection(path), queue: object[] = [];
  let attached = false;
  const send = (message: unknown) => { if (!socket.write(JSON.stringify(message) + '\n')) { process.stdin.pause(); socket.once('drain', () => process.stdin.resume()); } };
  socket.once('connect', () => send({type: 'bridge.attach', cwd: process.cwd(), args, env: process.env}));
  const fail = (error: Error) => { console.error('Pi shared transport: ' + error.message); process.exitCode = 1; socket.destroy(); };
  readJsonLines(socket, frame => {
    if (frame.type === 'bridge.ready') { attached = true; for (const row of queue.splice(0)) send(row); }
    else if (frame.type === 'bridge.stdout') { if (!process.stdout.write(JSON.stringify(frame.message) + '\n')) { socket.pause(); process.stdout.once('drain', () => socket.resume()); } }
    else if (frame.type === 'bridge.stderr') process.stderr.write(frame.text);
    else if (frame.type === 'bridge.error') fail(Error(frame.message));
    else if (frame.type === 'bridge.exit') { process.exitCode = frame.code ?? 1; socket.destroy(); }
  }, fail);
  readJsonLines(process.stdin, message => { const frame = {type: 'bridge.stdin', message}; if (attached) send(frame); else queue.push(frame); }, fail);
  process.stdin.once('end', () => socket.end());
  socket.once('error', fail); socket.once('close', () => process.exit(process.exitCode ?? 0));
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { socket.destroy(); process.exit(0); });
}
