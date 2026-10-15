import { randomUUID } from 'node:crypto';

export type ClaudeMessage = Record<string, any>;

/** Correlate SDK controls across successive frontends without rewriting SDK
 * events, generating replies, or deciding tool permissions. */
export class ClaudeWire {
  private controls = new Map<string, { peer: string; id: string; subtype?: string }>();
  private pending = new Map<string, ClaudeMessage>();
  initialized = false;

  input(peer: string, message: ClaudeMessage): ClaudeMessage | undefined {
    if (message.type === 'control_request') {
      const id = randomUUID();
      this.controls.set(id, { peer, id: message.request_id, subtype: message.request?.subtype });
      return { ...message, request_id: id };
    }
    if (message.type === 'control_response') {
      const id = message.response?.request_id;
      if (!this.pending.has(id)) return undefined;
      this.pending.delete(id);
    }
    return message;
  }

  output(message: ClaudeMessage): { message: ClaudeMessage; peer?: string } {
    if (message.type === 'control_response') {
      const owner = this.controls.get(message.response?.request_id);
      if (owner) {
        this.controls.delete(message.response.request_id);
        if (owner.subtype === 'initialize' && message.response.subtype === 'success') this.initialized = true;
        return { peer: owner.peer, message: { ...message, response: { ...message.response, request_id: owner.id } } };
      }
    }
    if (message.type === 'control_request') this.pending.set(message.request_id, message);
    if (message.type === 'control_cancel_request') this.pending.delete(message.request_id);
    return { message };
  }

  pendingRequests(): ClaudeMessage[] { return [...this.pending.values()]; }
  detached(peer: string) {
    for (const [id, request] of this.controls) if (request.peer === peer) this.controls.delete(id);
  }
}
