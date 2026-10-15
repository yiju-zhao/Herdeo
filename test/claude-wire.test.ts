import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeWire } from '../server/claude-wire.js';

test('successive SDK frontends receive their own control replies and the original native payload', () => {
  const wire = new ClaudeWire();
  const a = wire.input('first', { type: 'control_request', request_id: 'same-id', request: { subtype: 'initialize' } })!;
  const b = wire.input('second', { type: 'control_request', request_id: 'same-id', request: { subtype: 'initialize' } })!;
  assert.notEqual(a.request_id, b.request_id);
  const response = { type: 'control_response', response: { subtype: 'success', request_id: b.request_id, response: { models: ['native-model'] } } };
  assert.deepEqual(wire.output(response), { peer: 'second', message: { ...response, response: { ...response.response, request_id: 'same-id' } } });
  assert.equal(wire.initialized, true);
});

test('the broker forwards exactly one native permission decision without choosing it', () => {
  const wire = new ClaudeWire();
  const request = { type: 'control_request', request_id: 'permission-1', request: { subtype: 'can_use_tool', tool_name: 'Read', input: { file_path: 'README.md' } } };
  wire.output(request);
  const decision = { type: 'control_response', response: { request_id: 'permission-1', subtype: 'success', response: { behavior: 'deny', message: 'User denied' } } };
  assert.deepEqual(wire.input('first', decision), decision);
  assert.equal(wire.input('second', decision), undefined);
  assert.deepEqual(wire.pendingRequests(), []);
});

test('native streaming events pass through unchanged', () => {
  const wire = new ClaudeWire();
  const event = { type: 'stream_event', session_id: 'original', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'real token' } } };
  assert.deepEqual(wire.output(event), { message: event });
});
