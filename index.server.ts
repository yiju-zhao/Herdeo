import type { PluginServerContext } from '@getpaseo/plugin/server';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createProvider } from './server/provider.js';
import { readConfig } from './server/config.js';
import { openNativeCodex } from './server/codex-lifecycle.js';
import { loadRoute } from './server/codex-native.js';
import { connectPaseoDriver } from './server/paseo.js';
import { openNativeClaude } from './server/claude-native.js';
import { openNativePi } from './server/pi-native.js';
import { createTuiProvider } from './server/tui-provider.js';

export default function contribute(server: PluginServerContext) {
  const config = readConfig();
  server.registerProvider(createProvider(config));
  for(const kind of ['claude','pi'] as const)if(config.nativeTerminalProviders[kind])server.registerProvider(createTuiProvider(config,kind));
  const before = server.before('agent.session_open', async ({ request }) => {
    const prepared=await openNativePi(config, await openNativeClaude(config, await openNativeCodex(config, request)));
    if(prepared.provider==='claude-terminal'||prepared.provider==='pi-terminal')return {...prepared,env:{...prepared.env,HERDR_BRIDGE_PASEO_AGENT_ID:request.agentId,HERDR_BRIDGE_TUI_HISTORY:prepared.purpose==='history'?'1':'0'}};
    return prepared;
  });
  const created = server.on('agent.created', async ({ agent }, context) => {
    if (!config.nativeCodex || agent.provider !== 'codex') return;
    const route = await loadRoute(config, agent.id);
    if (!route || context.signal.aborted) return;
    const driver = await connectPaseoDriver(config);
    try { await driver.updateAgent(agent.id, { labels: { 'herdr.bridge': 'true', 'herdr.session-key': route.key, 'herdr.native-provider': 'codex' } }); }
    finally { await driver.close(); }
  });
  const watcher = config.autoRegister ? spawn('node', [join(config.packageRoot, 'dist/scripts/watch.js'), process.env.HERDR_BRIDGE_CONFIG ?? ''], {
    env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  }) : undefined;
  watcher?.stdout?.on('data', data => process.stdout.write(data));
  watcher?.stderr?.on('data', data => process.stderr.write(data));
  return () => { before(); created(); watcher?.kill('SIGTERM'); };
}
