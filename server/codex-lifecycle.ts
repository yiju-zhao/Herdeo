import type { PluginSessionOpenRequest } from '@getpaseo/plugin/server';
import type { BridgeConfig } from './config.js';
import { inScope, configurationFile } from './config.js';
import { assertRoute, loadRoute, nativeCodexRoute, pendingImport, routeFile, saveRoute } from './codex-native.js';
import { launchNative } from './launch.js';

export async function openNativeCodex(config: BridgeConfig, request: PluginSessionOpenRequest): Promise<PluginSessionOpenRequest> {
  if (!config.nativeCodex || request.provider !== 'codex' || request.purpose === 'history') return request;
  if (!inScope(config, request.cwd)) throw new Error('Native Herdr Codex sessions must use a configured bridge workspace.');
  let route = await loadRoute(config, request.agentId);
  const creating = request.reason === 'create' && !route;
  if (!route && request.reason === 'import') route = await pendingImport(config, request.cwd);
  if (!route && creating) route = await nativeCodexRoute(config, await launchNative(config, 'codex', request.cwd, request.agentId));
  if (!route) throw new Error('No original Herdr Codex route is registered. This session was not relaunched.');
  route = await assertRoute(config, route);
  await saveRoute(config, request.agentId, route);
  return { ...request, env: { ...request.env, HERDR_BRIDGE_CONFIG: configurationFile(config),
    HERDR_BRIDGE_CODEX_ROUTE: routeFile(config, request.agentId), HERDR_BRIDGE_CODEX_CREATED: creating ? '1' : '0' } };
}
