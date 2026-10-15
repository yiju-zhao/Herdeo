import { readFile, writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { readConfig } from '../server/config.js';
import { connectPaseo } from '../server/paseo.js';
import { loadClaudeRoute } from '../server/claude-native.js';

const root = resolve(import.meta.dirname, '..');
const config = readConfig(join(root, '.dev/claude-native.json'));
if (config.paseoUrl !== 'ws://127.0.0.1:6797/ws' || !config.nativeClaude) throw Error('Use only the independent Claude test instance');
const client = await connectPaseo(config);
try {
 const agent = await client.agents.create({cwd: config.workspaceRoots[0]!, config: {provider: 'claude/claude-opus-5-5', modeId: 'default'}, title: 'Claude native permission validation'});
 const route = await loadClaudeRoute(config, agent.id); assert.ok(route);
 const target = join(route.cwd, 'permission-denied-' + Date.now().toString(36) + '.txt');
 const result = await agent.run('Use the Write tool to create ' + target + ' containing BRIDGE_PERMISSION_TEST. Do not use any other tool. If permission is denied, stop and reply DENIED; do not retry or find another way.', {timeoutMs: 90000});
 assert.equal(result.status, 'permission', 'Expected a real builtin Claude permission request');
 const current = (await agent.refresh())!.agent;
 const request = current.pendingPermissions?.[0]; assert.ok(request);
 assert.equal(request.provider, 'claude'); assert.equal(request.kind, 'tool');
 await assert.rejects(access(target), {code: 'ENOENT'});
 const before = JSON.parse(await readFile(route.socket + '.json', 'utf8'));
 await agent.respondToPermission({requestId: request.id, response: {behavior: 'deny', message: 'Permission test: deny this write and stop. Do not retry.'}});
 const finished = await agent.waitForFinish(90000); assert.equal(finished.status, 'idle');
 await assert.rejects(access(target), {code: 'ENOENT'});
 const after = JSON.parse(await readFile(route.socket + '.json', 'utf8'));
 assert.equal(after.enginePid, before.enginePid); assert.equal(after.sessionId, before.sessionId);
 await writeFile(join(root, '.dev/claude-permission-evidence.json'), JSON.stringify({paseoAgentId: agent.id, provider: 'claude', kind: request.kind, tool: request.name, denied: true, fileAbsent: true, enginePid: after.enginePid, nativeSessionId: after.sessionId}, null, 2) + '\n');
 console.log('PASS: builtin Claude permission request reaches Paseo, denial reaches the same executor, and the file is never written.');
} finally { await client.close(); }
