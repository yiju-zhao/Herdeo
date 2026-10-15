import { readFile, mkdir, readdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BridgeConfig } from './config.js';

export interface PendingBinding { key: string; socket: string; terminal: string; pid: number; nativeKey?: string }
const directory = (config: BridgeConfig) => join(config.paseoHome, 'herdr-bridge', 'bindings');
export async function bindings(config: BridgeConfig): Promise<PendingBinding[]> {
  let files: string[];
  try { files = await readdir(directory(config)); } catch { return []; }
  const values: PendingBinding[] = [];
  for (const file of files) if (file.endsWith('.json')) {
    try { values.push(JSON.parse(await readFile(join(directory(config), file), 'utf8'))); } catch { /* Atomic write in flight. */ }
  }
  return values;
}
export async function saveBinding(config: BridgeConfig, value: PendingBinding) {
  const path = directory(config);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const temporary = join(path, randomUUID() + '.tmp');
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, join(path, value.key + '.json'));
}
export async function canonicalKey(config: BridgeConfig, key: string): Promise<string> {
  return (await bindings(config)).find(value => value.key === key)?.nativeKey ?? key;
}
