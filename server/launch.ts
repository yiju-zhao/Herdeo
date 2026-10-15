import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, unlink, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { BridgeConfig } from './config.js';
import { configurationFile, inScope } from './config.js';
import { discover, transport, type AgentKind, type NativeSession } from './herdr.js';

const execute = promisify(execFile);
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const claimsDirectory = (config: BridgeConfig) => join(config.paseoHome, 'herdr-bridge', 'claims');

export async function readClaims(config: BridgeConfig): Promise<Array<{ socket: string; pane: string; key?: string; owner: string; createdAt: number }>> {
  let files: string[];
  try { files = await readdir(claimsDirectory(config)); } catch { return []; }
  const result = [];
  for (const file of files) if (file.endsWith('.json')) {
    try { result.push(JSON.parse(await readFile(join(claimsDirectory(config), file), 'utf8'))); } catch { /* In-flight atomic writes are not claims. */ }
  }
  return result;
}

export async function launchNative(config: BridgeConfig, kind: AgentKind, cwd: string, owner: string): Promise<NativeSession> {
  if (!inScope(config, cwd)) throw new Error('This directory is outside the configured bridge workspace roots.');
  const host = config.herdr[0]!;
  const env: NodeJS.ProcessEnv = { ...process.env, HERDR_SOCKET_PATH: host.socket, HERDR_ENV: '1' };
  for (const key of ['HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID']) delete env[key];
  const created = JSON.parse((await execute('herdr', ['workspace', 'create', '--cwd', cwd, '--label', kind + ' from Paseo', '--no-focus'], { env })).stdout);
  const pane = created.result.root_pane.pane_id as string;
  const workspace = created.result.workspace.workspace_id as string;
  const claimFile = join(claimsDirectory(config), randomUUID() + '.json');
  await mkdir(claimsDirectory(config), { recursive: true, mode: 0o700 });
  const claim = { socket: host.socket, pane, owner, createdAt: Date.now() };
  await writeFile(claimFile, JSON.stringify(claim), { mode: 0o600, flag: 'wx' });
  try {
    const args = kind === 'codex' ? ['node', join(config.packageRoot, 'dist/scripts/codex-terminal.js')] : ['claude'];
    if (kind === 'claude' && config.launch.claudeSettings) args.push('--settings', config.launch.claudeSettings);
    const environment = ['env', '-u', 'CODEX_THREAD_ID', '-u', 'PASEO_AGENT_ID', '-u', 'CLAUDE_CODE_SESSION_ID'];
    environment.push('HERDR_BRIDGE_CONFIG='+configurationFile(config));
    if (kind === 'codex' && config.launch.codexHome) environment.push('CODEX_HOME=' + config.launch.codexHome);
    const command = [...environment, ...args].map(quote).join(' ');
    await execute('herdr', ['pane', 'run', pane, command], { env });
    for (let attempt = 0; attempt < 120; attempt++) {
      const session = (await discover(config)).find(x => x.socket === host.socket && x.pane === pane && x.provider === kind);
      if (session && ['idle', 'done', 'working'].includes(session.status)) {
        await writeFile(claimFile, JSON.stringify({ ...claim, key: session.key }), { mode: 0o600 });
        return session;
      }
      await delay(500);
    }
    throw new Error('The new ' + kind + ' session did not report its identity and become ready in Herdr. Check its startup/authentication screen.');
  } catch (error) {
    await unlink(claimFile).catch(() => {});
    await transport.request(host.socket, 'workspace.close', { workspace_id: workspace }).catch(() => {});
    throw error;
  }
}
