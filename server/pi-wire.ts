import { randomUUID } from 'node:crypto';
export type PiMessage = Record<string, any>;
const sessionReplacements = new Set(['new_session', 'switch_session', 'fork']);

/** Keep command IDs frontend-local while preserving native RPC facts. */
export class PiWire {
  private commands = new Map<string, {peer: string; id?: string; type: string}>();
  private completed = new Map<string, {peer: string; id?: string; type: string}>();
  private questions = new Map<string, PiMessage>();

  input(peer: string, message: PiMessage): PiMessage | undefined {
    if (!message || typeof message.type !== 'string') throw Error('Invalid Pi RPC record');
    if (sessionReplacements.has(message.type)) throw Error('This view is bound to its original Pi session; create a new agent to change sessions');
    if (message.type === 'extension_ui_response') {
      if (!this.questions.has(message.id)) return;
      this.questions.delete(message.id);
      return message;
    }
    const id = randomUUID();
    this.commands.set(id, {peer, id: message.id, type: message.type});
    return {...message, id};
  }

  output(message: PiMessage): {message: PiMessage; peer?: string; command?: string} {
    // A bash stream is correlated with its originating RPC, too.
    const owner = typeof message.id === 'string' ? this.commands.get(message.id) ?? this.completed.get(message.id) : undefined;
    if (owner && (message.type === 'response' || message.type === 'bash_execution_update' || message.type === 'prompt_result')) {
      if (message.type === 'response') {
        this.commands.delete(message.id);
        this.completed.set(message.id, owner);
        // Older Pi versions can emit prompt_result after the acceptance response.
        // Bound the correlation cache; polling must not accumulate without limit.
        if (this.completed.size > 1024) this.completed.delete(this.completed.keys().next().value!);
      }
      const result = {...message};
      if (owner.id === undefined) delete result.id; else result.id = owner.id;
      return {peer: owner.peer, command: owner.type, message: result};
    }
    if (message.type === 'extension_ui_request' && ['select', 'input', 'editor', 'confirm'].includes(message.method)) this.questions.set(message.id, message);
    return {message};
  }

  pendingRequests() { return [...this.questions.values()]; }
  detached(peer: string) {
    for (const pending of [this.commands, this.completed]) for (const [id, owner] of pending) if (owner.peer === peer) pending.delete(id);
  }
}
