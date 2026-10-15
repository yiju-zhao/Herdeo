import { readConfig } from '../server/config.js';
import { discover } from '../server/herdr.js';
import { connectPaseo, connectPaseoDriver, listBridgeAgents, bridgeKey } from '../server/paseo.js';
import { readClaims } from '../server/launch.js';
import { canonicalKey } from '../server/bindings.js';
import { claimImport, nativeCodexRoute } from '../server/codex-native.js';
import type { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import type { PaseoClient } from '@getpaseo/client';

const config = readConfig(process.argv[2]);
let client: PaseoClient | undefined;
let driver: DaemonClient | undefined;
let stopped = false;
let timer: ReturnType<typeof setTimeout>;
let lastError = '';
const nativeErrors = new Map<string, { message: string; until: number; status: string }>();
async function scan() {
  if (stopped) return;
  try {
    client ??= await connectPaseo(config);
    const native = await discover(config);
    const registered = await listBridgeAgents(client);
    const known = new Set(await Promise.all(registered.map(agent => bridgeKey(agent)).filter((key): key is string => Boolean(key)).map(key => canonicalKey(config, key))));
    const claims = await readClaims(config);
    for (const session of native) {
      // Native Claude hosts register their builtin card themselves. Ordinary
      // existing TUIs are left intact instead of creating a duplicate legacy view.
      if (config.nativeClaude && session.provider === 'claude') continue;
      if (config.nativeCodex && session.provider === 'codex') {
        const previousError = nativeErrors.get(session.key);
        if (previousError && previousError.until > Date.now() && previousError.status === session.status) continue;
        const matches = await Promise.all(registered.map(async agent => ({ agent, key: bridgeKey(agent) ? await canonicalKey(config, bridgeKey(agent)!) : undefined })));
        if (matches.some(x => x.key === session.key && x.agent.provider === 'codex')) continue;
        const claimKeys = await Promise.all(claims.map(claim => claim.key ? canonicalKey(config, claim.key) : Promise.resolve(undefined)));
        if ((!matches.some(x => x.key === session.key) && claimKeys.includes(session.key)) || claims.some(claim => !claim.key && claim.socket === session.socket && claim.pane === session.pane && Date.now() - claim.createdAt < 120000)) continue;
        // Migration waits for the existing view to be idle so it cannot cancel
        // a task merely because the bridge presentation is being upgraded.
        if (matches.some(x => x.key === session.key && !x.agent.archivedAt && x.agent.status === 'running')) continue;
        let route;
        try { route = await nativeCodexRoute(config, session); }
        catch (error) {
          const message = (error as Error).message;
          if (previousError?.message !== message) console.error('Native Codex discovery (' + session.pane + '): ' + message);
          nativeErrors.set(session.key, { message, until: Date.now() + 10000, status: session.status }); continue;
        }
        const current = await Promise.all(registered.map(async agent => ({ agent, key: bridgeKey(agent) ? await canonicalKey(config, bridgeKey(agent)!) : undefined })));
        if (current.some(x => x.key === route.key && x.agent.provider === 'codex')) continue;
        driver ??= await connectPaseoDriver(config);
        const workspace = await client.workspaces.open(session.cwd);
        try { await claimImport(config, route, async () => {
          const agent = await driver!.importAgent({ provider: 'codex', sessionId: route.nativeId, cwd: route.cwd, workspaceId: workspace.id,
            labels: { 'herdr.bridge': 'true', 'herdr.session-key': route.key, 'herdr.host': session.host, 'herdr.native-provider': 'codex' } });
          for (const previous of current) if (previous.key === route.key && previous.agent.provider === 'herdr' && !previous.agent.archivedAt && previous.agent.status !== 'running') {
            await client!.agents.ref(previous.agent.id).archive();
          }
          console.log(JSON.stringify({ event: 'registered-native', pane: session.pane, provider: 'codex', agentId: agent.id }));
        }); nativeErrors.delete(session.key); }
        catch (error) {
          const message = (error as Error).message;
          if (previousError?.message !== message) console.error('Native Codex import (' + session.pane + '): ' + message);
          nativeErrors.set(session.key, { message, until: Date.now() + 10000, status: session.status });
        }
        continue;
      }
      if (known.has(session.key)) continue;
      const claimKeys = await Promise.all(claims.map(claim => claim.key ? canonicalKey(config, claim.key) : Promise.resolve(undefined)));
      if (claimKeys.includes(session.key) || claims.some(claim => !claim.key && claim.socket === session.socket && claim.pane === session.pane && Date.now() - claim.createdAt < 120000)) continue;
      const workspace = await client.workspaces.open(session.cwd);
      const agent = await workspace.agents.create({
        idempotencyKey: 'herdr-session:' + session.key,
        config: { provider: 'herdr/' + session.provider, options: { nativeKey: session.key } },
        title: session.title,
        labels: { 'herdr.bridge': 'true', 'herdr.session-key': session.key, 'herdr.host': session.host, 'herdr.native-provider': session.provider },
      });
      known.add(session.key);
      console.log(JSON.stringify({ event: 'registered', pane: session.pane, provider: session.provider, agentId: agent.id }));
    }
    lastError = '';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== lastError) console.error('Herdr discovery: ' + message);
    lastError = message;
    await client?.close().catch(() => {}); client = undefined;
    await driver?.close().catch(() => {}); driver = undefined;
  }
  if (!stopped) timer = setTimeout(scan, config.intervalMs);
}
async function stop() { stopped = true; clearTimeout(timer); await client?.close(); await driver?.close(); }
process.once('SIGTERM', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
void scan();
