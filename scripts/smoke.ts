import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from '../server/config.js';
import { transport, sessionKey } from '../server/herdr.js';
import { connectPaseo, listBridgeAgents } from '../server/paseo.js';

const root = resolve(import.meta.dirname, '..');
const config = readConfig(join(root, '.dev/bridge.json'));
const env: NodeJS.ProcessEnv = { ...process.env, HERDR_SOCKET_PATH: config.herdr[0]!.socket, HERDR_ENV: '1' };
delete env.HERDR_PANE_ID;
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const panes: string[] = [];
const workspaces: string[] = [];
const nativeKeys = new Map<string, string>();
const client = await connectPaseo(config);
try {
  for (const provider of ['codex', 'claude'] as const) {
    const nativeId = randomUUID();
    nativeKeys.set(provider, sessionKey(config.herdr[0]!.socket, provider, nativeId));
    const created = JSON.parse(execFileSync('herdr', ['workspace', 'create', '--cwd', join(root, '.dev/workspace'), '--label', provider + ' bridge test', '--no-focus'], { env, encoding: 'utf8' }));
    const pane = created.result.root_pane.pane_id as string; panes.push(pane);
    workspaces.push(created.result.workspace.workspace_id);
    const fixture = ['node', join(root, 'dist/scripts/fixture.js'), provider, nativeId, join(root, '.dev'), config.transcriptRoots[provider]].map(quote).join(' ');
    const command = ['/bin/bash', '-c', 'exec -a ' + quote(provider) + ' ' + fixture].map(quote).join(' ');
    execFileSync('herdr', ['pane', 'run', pane, command], { env, encoding: 'utf8' });
  }
  let registered = await listBridgeAgents(client);
  for (let attempt = 0; registered.filter(x => !x.archivedAt && [...nativeKeys.values()].includes(x.labels?.['herdr.session-key'] ?? '')).length < 2; attempt++) {
    if (attempt > 60) throw new Error('The two Herdr fixture agents were not automatically registered.');
    await delay(500); registered = await listBridgeAgents(client);
  }
  console.log('PASS: Herdr-started Codex and Claude sessions automatically appear as native Paseo agents.');
  for (const provider of ['codex', 'claude']) {
    const agent = registered.find(x => !x.archivedAt && x.labels?.['herdr.session-key'] === nativeKeys.get(provider))!;
    assert.ok(agent);
    const pid = Number(await readFile(join(root, '.dev', provider + '-fixture.pid'), 'utf8'));
    const result = await client.agents.ref(agent.id).run('hello-' + provider, { timeoutMs: 15000 });
    assert.equal(result.status, 'idle');
    assert.ok(result.lastMessage?.includes(provider.toUpperCase() + '-REPLY: hello-' + provider));
    process.kill(pid, 0);
    console.log('PASS: Paseo → original Herdr ' + provider + ' process → Paseo reply; original PID remains alive.');
  }
  const count = (await listBridgeAgents(client)).filter(x => !x.archivedAt).length;
  await delay(1700);
  assert.equal((await listBridgeAgents(client)).filter(x => !x.archivedAt).length, count);
  console.log('PASS: repeated discovery does not duplicate agents.');
  for (const provider of ['codex', 'claude']) {
    const agent = registered.find(x => !x.archivedAt && x.labels?.['herdr.session-key'] === nativeKeys.get(provider))!;
    const pid = Number(await readFile(join(root, '.dev', provider + '-fixture.pid'), 'utf8'));
    await client.agents.ref(agent.id).archive();
    process.kill(pid, 0);
  }
  console.log('PASS: archiving a Paseo view leaves the original Herdr agent alive.');
} finally {
  for (const workspace of workspaces) await transport.request(config.herdr[0]!.socket, 'workspace.close', { workspace_id: workspace }).catch(() => {});
  await client.close();
}
