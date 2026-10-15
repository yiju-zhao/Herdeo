import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { readConfig } from '../server/config.js';

const root = resolve(import.meta.dirname, '..');
const config = readConfig(join(root, '.dev/bridge.json'));
const kind = process.argv[2];
if (kind !== 'codex' && kind !== 'claude') throw new Error('Pass codex or claude.');
const env: NodeJS.ProcessEnv = { ...process.env, HERDR_SOCKET_PATH: config.herdr[0]!.socket, HERDR_ENV: '1' };
delete env.HERDR_PANE_ID;
const result = JSON.parse(execFileSync('herdr', ['workspace', 'create', '--cwd', join(root, '.dev/workspace'), '--label', kind + ' real bridge demo', '--no-focus'], { env, encoding: 'utf8' }));
const pane = result.result.root_pane.pane_id;
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const clean = ['env', '-u', 'CODEX_THREAD_ID', '-u', 'PASEO_AGENT_ID', '-u', 'CLAUDE_CODE_SESSION_ID'];
const args = kind === 'codex' ? [...clean, 'CODEX_HOME=' + config.launch.codexHome, 'node', join(root, 'dist/scripts/codex-terminal.js')]
  : [...clean, 'claude', '--settings', config.launch.claudeSettings!];
execFileSync('herdr', ['pane', 'run', pane, args.map(quote).join(' ')], { env, encoding: 'utf8' });
const file = join(root, '.dev/native-demos.json');
let demos: Record<string, unknown> = {};
try { demos = JSON.parse(await readFile(file, 'utf8')); } catch { /* First demo. */ }
demos[kind] = { pane, workspace: result.result.workspace.workspace_id };
await writeFile(file, JSON.stringify(demos, null, 2) + '\n');
console.log(JSON.stringify({ provider: kind, pane, workspace: result.result.workspace.workspace_id }));
