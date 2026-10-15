import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { readConfig, inScope } from '../server/config.js';
import { transport } from '../server/herdr.js';

const kind = process.argv[2];
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
try {
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const config = readConfig();
  const nativeId = payload.session_id ?? payload.thread_id;
  const socket = process.env.HERDR_SOCKET_PATH;
  const pane = process.env.HERDR_PANE_ID;
  const parentMismatch = kind === 'codex' && Boolean(process.env.CODEX_THREAD_ID) && process.env.CODEX_THREAD_ID !== nativeId;
  if (!['codex', 'claude'].includes(kind ?? '') || !socket || !pane || typeof nativeId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(nativeId)) process.exit(0);
  if (!config.herdr.some(host => host.socket === socket) || !inScope(config, payload.cwd ?? process.cwd())) process.exit(0);
  if (parentMismatch) process.exit(0);
  await transport.request(socket, 'pane.report_agent_session', {
    pane_id: pane, source: 'herdr:' + kind, agent: kind, agent_session_id: nativeId,
  });
  if (kind === 'claude' && typeof payload.transcript_path === 'string') {
    const directory = join(config.transcriptRoots.claude, 'projects', 'linked');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try { await symlink(payload.transcript_path, join(directory, nativeId + '.jsonl')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
} catch (error) { console.error('Herdr bridge session hook: ' + (error instanceof Error ? error.message : String(error))); }
