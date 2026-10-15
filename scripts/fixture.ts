import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

const [provider, nativeId, root, transcriptRoot] = process.argv.slice(2);
if (!provider || !nativeId || !root || !process.env.HERDR_PANE_ID || !process.env.HERDR_SOCKET_PATH) throw new Error('Fixture must run inside its isolated Herdr pane.');
process.title = provider;
const directory = join(transcriptRoot ?? join(root, provider), provider === 'codex' ? 'sessions/2026/10/08' : 'projects/fixture');
await mkdir(directory, { recursive: true });
const file = join(directory, nativeId + '.jsonl');
await writeFile(join(root, provider + '-fixture.pid'), String(process.pid));
const report = (state: string) => execFileSync('herdr', ['pane', 'report-agent', process.env.HERDR_PANE_ID!, '--source', 'custom:bridge-fixture', '--agent', provider, '--state', state], { env: process.env, stdio: 'ignore' });
const record = async (role: 'user' | 'assistant', text: string) => {
  const row = provider === 'codex' ? { timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: role === 'user' ? 'user_message' : 'agent_message', message: text } }
    : { timestamp: new Date().toISOString(), uuid: randomUUID(), type: role, sessionId: nativeId, message: { role, content: role === 'user' ? text : [{ type: 'text', text }] } };
  await appendFile(file, JSON.stringify(row) + '\n');
};
await record('assistant', provider + ' fixture ready; original PID ' + process.pid);
report('idle');
execFileSync('herdr', ['pane', 'report-agent-session', process.env.HERDR_PANE_ID, '--source', 'herdr:' + provider, '--agent', provider, '--agent-session-id', nativeId], { env: process.env, stdio: 'ignore' });
console.log(provider + ' fixture ready');
for await (const input of createInterface({ input: process.stdin })) {
  const text = input.replace(/\x1b\[20[01]~/g, '').trim();
  if (!text) continue;
  report('working'); await record('user', text); console.log('received: ' + text);
  await delay(300);
  const answer = provider.toUpperCase() + '-REPLY: ' + text;
  await record('assistant', answer); console.log(answer); report('idle');
}
