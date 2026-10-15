import type { CodexRoute } from './codex-native.js';

export interface RpcMessage { id?: number | string; method?: string; params?: Record<string, any>; result?: unknown; error?: unknown }

/** Keep Paseo's builtin Codex adapter and translate only its launch into a join. */
export function joinRequest(message: RpcMessage, route: CodexRoute, created: boolean): RpcMessage {
  if (!message.method) return message;
  const params = message.params ?? {};
  if (typeof params.threadId === 'string' && params.threadId !== route.nativeId) throw new Error('This view cannot send commands to a different native Codex thread.');
  if (message.method === 'thread/resume') return { ...message, params: { ...params, excludeTurns: true } };
  if (message.method !== 'thread/start') return message;
  const overrides: Record<string, unknown> = {};
  if (created) for (const name of ['model', 'modelProvider', 'serviceTier', 'cwd', 'approvalPolicy', 'approvalsReviewer', 'sandbox', 'config', 'baseInstructions', 'developerInstructions', 'personality']) {
    if (params[name] !== undefined) overrides[name] = params[name];
  }
  return { ...message, method: 'thread/resume', params: { ...overrides, threadId: route.nativeId, excludeTurns: true } };
}
