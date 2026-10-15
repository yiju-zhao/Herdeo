import { resolve, join } from 'node:path';
import { readConfig } from '../server/config.js';
import { discover } from '../server/herdr.js';
import { connectPaseo, listBridgeAgents, bridgeKey } from '../server/paseo.js';
import { canonicalKey } from '../server/bindings.js';
const config = readConfig(process.argv[2] ?? join(resolve(import.meta.dirname, '..'), '.dev/bridge.json'));
const client = await connectPaseo(config);
try {
  const native = await discover(config);
  const agents = (await listBridgeAgents(client)).filter(x => !x.archivedAt);
  const views = await Promise.all(agents.map(async x => ({ id: x.id, title: x.title, status: x.status, key: await canonicalKey(config, bridgeKey(x)!) })));
  console.log(JSON.stringify({ herdr: native.map(x => ({ key: x.key, pane: x.pane, provider: x.provider, status: x.status })), paseo: views }, null, 2));
} finally { await client.close(); }
