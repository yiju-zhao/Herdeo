#!/usr/bin/env node
import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bridgeRuntime, readConfig } from '../server/config.js';
import { assertClaudeRoute } from '../server/claude-native.js';

const path = process.env.HERDR_BRIDGE_CLAUDE_SOCKET;
const args = process.argv.slice(2);
const config = process.env.HERDR_BRIDGE_CONFIG ? readConfig() : undefined;
if (!path || !args.includes('--input-format')) {
  const child = spawn(config?.launch.claudeCommand ?? 'claude', args, { stdio: 'inherit', env: process.env });
  child.once('exit', code => process.exit(code ?? 1));
  process.once('SIGTERM', () => child.kill('SIGTERM'));
} else {
  const routeFile=process.env.HERDR_BRIDGE_CLAUDE_ROUTE;
  if(routeFile){
    const route=JSON.parse(await readFile(routeFile,'utf8'));
    await assertClaudeRoute(readConfig(),route);
    if(route.socket!==path||route.cwd!==process.cwd())throw Error('Native Claude transport does not match its registered route');
  }
  if (!resolve(path).startsWith(bridgeRuntime(config)+'/')) throw new Error('Native Claude proxy requires its configured private socket.');
  const socket = createConnection(path);
  const queue: string[] = [];
  let attached = false;
  socket.once('connect', () => socket.write(JSON.stringify({ type: 'bridge.attach', cwd: process.cwd(), args, env: process.env }) + '\n'));
  createInterface({ input: socket }).on('line', line => {
    const frame = JSON.parse(line);
    if (frame.type === 'bridge.ready') { attached = true; for (const row of queue.splice(0)) socket.write(row); }
    else if (frame.type === 'bridge.stdout') process.stdout.write(JSON.stringify(frame.message) + '\n');
    else if (frame.type === 'bridge.stderr') process.stderr.write(frame.text);
    else if (frame.type === 'bridge.error') { console.error(frame.message); socket.destroy(); process.exitCode = 1; }
    else if (frame.type === 'bridge.exit') { process.exitCode = frame.code ?? 1; socket.destroy(); }
  });
  createInterface({ input: process.stdin }).on('line', line => {
    const row = JSON.stringify({ type: 'bridge.stdin', message: JSON.parse(line) }) + '\n';
    if (attached) socket.write(row); else queue.push(row);
  }).once('close', () => socket.end());
  socket.once('error', error => { console.error('Claude shared transport: ' + error.message); process.exitCode = 1; });
  socket.once('close', () => process.exit(process.exitCode ?? 0));
  process.once('SIGTERM', () => { socket.destroy(); process.exit(0); });
  process.once('SIGINT', () => { socket.destroy(); process.exit(0); });
}
