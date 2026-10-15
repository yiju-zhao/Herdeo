import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { PluginSessionOpenRequest } from '@getpaseo/plugin/server';
import { bridgeRuntime, configurationFile, inScope, type BridgeConfig } from './config.js';
import { transport } from './herdr.js';

const execute = promisify(execFile);
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
const schema = z.object({socket: z.string(), herdrSocket: z.string(), pane: z.string(), workspace: z.string(), cwd: z.string(), hostPid: z.number().int().positive()});
export type PiRoute = z.infer<typeof schema>;
export const piRuntime = (config?: BridgeConfig) => join(bridgeRuntime(config), 'pi');
export function piRouteFile(config: BridgeConfig, id: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw Error('Invalid native Pi agent ID');
  return join(config.paseoHome, 'herdr-bridge/native-pi', id + '.json');
}
export async function loadPiRoute(config: BridgeConfig, id: string): Promise<PiRoute | undefined> {
  try { return schema.parse(JSON.parse(await readFile(piRouteFile(config, id), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
}
export async function assertPiRoute(config: BridgeConfig, route: PiRoute) {
  route = schema.parse(route);
  if (!resolve(route.socket).startsWith(piRuntime(config) + '/') || !route.socket.endsWith('.sock')) throw Error('Pi socket belongs to another runtime');
  if (!inScope(config, route.cwd) || !config.herdr.some(h => h.socket === route.herdrSocket)) throw Error('Pi route is outside the configured workspace');
  const info = await transport.request<any>(route.herdrSocket, 'pane.process_info', {pane_id: route.pane});
  if (!info.process_info.foreground_processes.some((p: any) => p.pid === route.hostPid)) throw Error('The original Herdr Pi host is no longer present; it was not relaunched');
  await access(route.socket);
}
export async function createPiHost(config: BridgeConfig, cwd: string, autoRegister = false): Promise<PiRoute> {
  if (!inScope(config, cwd)) throw Error('Pi must use a configured bridge workspace');
  const herdr = config.herdr[0]!;
  const env: NodeJS.ProcessEnv = {...process.env, HERDR_SOCKET_PATH: herdr.socket, HERDR_ENV: '1'};
  for (const name of ['HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID']) delete env[name];
  const created = JSON.parse((await execute('herdr', ['workspace', 'create', '--cwd', cwd, '--label', 'Pi', '--no-focus'], {env})).stdout);
  const pane = created.result.root_pane.pane_id, workspace = created.result.workspace.workspace_id;
  await mkdir(piRuntime(config), {recursive: true, mode: 0o700});
  const socket = join(piRuntime(config), randomUUID().slice(0, 8) + '.sock');
  try {
    const args = ['env', 'HERDR_BRIDGE_PI_SOCKET=' + socket, 'HERDR_BRIDGE_PI_CWD=' + cwd, 'HERDR_BRIDGE_PI_REGISTER=' + (autoRegister ? '1' : '0'), 'HERDR_BRIDGE_CONFIG=' + configurationFile(config), 'node', join(config.packageRoot, 'dist/scripts/pi-host.js')];
    await execute('herdr', ['pane', 'run', pane, args.map(quote).join(' ')], {env});
    for (let i = 0;; i++) {
      try {
        const metadata = JSON.parse(await readFile(socket + '.json', 'utf8'));
        return schema.parse({socket, herdrSocket: herdr.socket, pane, workspace, cwd: resolve(cwd), hostPid: metadata.hostPid});
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || i > 50) throw error; await delay(200); }
    }
  } catch (error) { await transport.request(herdr.socket, 'workspace.close', {workspace_id: workspace}).catch(() => {}); throw error; }
}
export async function openNativePi(config: BridgeConfig, request: PluginSessionOpenRequest): Promise<PluginSessionOpenRequest> {
  if (!config.nativePi || request.provider !== 'pi' || request.purpose === 'history') return request;
  let route = await loadPiRoute(config, request.agentId);
  if (!route && request.reason === 'create') route = await createPiHost(config, request.cwd);
  if (!route) throw Error('No shared Herdr Pi executor is registered for this session');
  if (resolve(request.cwd) !== route.cwd) throw Error('Pi session cannot move to a different workspace');
  await assertPiRoute(config, route);
  const file = piRouteFile(config, request.agentId);
  await mkdir(join(config.paseoHome, 'herdr-bridge/native-pi'), {recursive: true, mode: 0o700});
  await writeFile(file, JSON.stringify(route), {mode: 0o600});
  return {...request, env: {...request.env, HERDR_BRIDGE_CONFIG: configurationFile(config), HERDR_BRIDGE_PASEO_AGENT_ID:request.agentId, HERDR_BRIDGE_PI_SOCKET: route.socket, HERDR_BRIDGE_PI_ROUTE: file}};
}
