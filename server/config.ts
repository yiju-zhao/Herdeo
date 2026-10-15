import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { z } from 'zod';

export const configSchema = z.object({
  herdr: z.array(z.object({ name: z.string().min(1), socket: z.string().min(1) })).min(1),
  transcriptRoots: z.object({ codex: z.string(), claude: z.string() }),
  intervalMs: z.number().int().min(100).default(800),
  autoRegister: z.boolean().default(true),
  nativeCodex: z.boolean().default(false),
  nativeClaude: z.boolean().default(false),
  nativePi: z.boolean().default(false),
  paseoHome: z.string().min(1),
  paseoUrl: z.string().startsWith('ws://'),
  paseoPasswordFile: z.string().optional(),
  packageRoot: z.string().min(1),
  runtimeDirectory: z.string().optional(),
  terminalFrontend: z.enum(['shared', 'native']).default('shared'),
  nativeTerminalProviders: z.object({claude:z.boolean().default(false),pi:z.boolean().default(false)}).default({claude:false,pi:false}),
  workspaceRoots: z.array(z.string()).default([]),
  launch: z.object({ codexHome: z.string().optional(), codexCommand: z.string().optional(), claudeCommand: z.string().optional(), claudeModel: z.string().optional(), claudeSettings: z.string().optional(), piCommand: z.string().optional(), piModel: z.string().optional() }).default({}),
});
export type BridgeConfig = z.infer<typeof configSchema>;
const sourceFiles = new WeakMap<BridgeConfig, string>();

export function configurationFile(config: BridgeConfig): string {
  return sourceFiles.get(config) ?? process.env.HERDR_BRIDGE_CONFIG ?? join(homedir(), '.config', 'herdr-paseo-bridge', 'config.json');
}

export function readConfig(file = process.env.HERDR_BRIDGE_CONFIG): BridgeConfig {
  const path = file ?? join(homedir(), '.config', 'herdr-paseo-bridge', 'config.json');
  const result = configSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  for (const host of result.herdr) host.socket = resolve(host.socket);
  result.workspaceRoots = result.workspaceRoots.map(p => resolve(p));
  if(result.runtimeDirectory)result.runtimeDirectory=resolve(result.runtimeDirectory);
  sourceFiles.set(result, resolve(path));
  return result;
}

export function bridgeRuntime(config?: Pick<BridgeConfig, 'runtimeDirectory'>): string {
  return config?.runtimeDirectory ?? join(process.platform === 'darwin' ? '/private/tmp' : '/tmp', 'hpc-' + process.getuid!());
}

export function codexSocketDirectory(config: BridgeConfig): string {
  return config.runtimeDirectory ? join(config.runtimeDirectory, 'codex') : join(config.paseoHome, 'herdr-bridge/codex-terminals');
}

export function inScope(config: BridgeConfig, cwd: string): boolean {
  const path = resolve(cwd);
  return !config.workspaceRoots.length || config.workspaceRoots.some(root => path === root || path.startsWith(root + '/'));
}
