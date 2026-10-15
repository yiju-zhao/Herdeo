import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { PiWire } from '../server/pi-wire.js';
import { readJsonLines } from '../server/jsonl.js';

test('Pi responses route to their original frontend even when frontend IDs collide', () => {
  const wire = new PiWire();
  const a = wire.input('a', {type: 'get_state', id: 'same'})!;
  const b = wire.input('b', {type: 'get_state', id: 'same'})!;
  assert.notEqual(a.id, b.id);
  const native = {type: 'response', id: b.id, command: 'get_state', success: true, data: {sessionId: 'original'}};
  assert.deepEqual(wire.output(native), {peer: 'b', command: 'get_state', message: {...native, id: 'same'}});
});
test('Pi extension questions forward one actual answer and never choose an answer', () => {
  const wire = new PiWire();
  const request = {type: 'extension_ui_request', id: 'q1', method: 'confirm', title: 'Run tool?'};
  assert.deepEqual(wire.output(request), {message: request});
  const response = {type: 'extension_ui_response', id: 'q1', confirmed: false};
  assert.deepEqual(wire.input('a', response), response);
  assert.equal(wire.input('b', response), undefined);
  assert.deepEqual(wire.pendingRequests(), []);
});
test('late Pi prompt results retain their frontend ID after command acceptance', () => {
  const wire = new PiWire();
  const request = wire.input('paseo', {type: 'prompt', id: 'original', message: '/example'})!;
  wire.output({type: 'response', id: request.id, command: 'prompt', success: true});
  const event = {type: 'prompt_result', id: request.id, agentInvoked: false};
  assert.deepEqual(wire.output(event), {peer: 'paseo', command: 'prompt', message: {...event, id: 'original'}});
});
test('Pi session replacement is rejected while native streaming is preserved', () => {
  const wire = new PiWire();
  for (const type of ['new_session', 'switch_session', 'fork']) assert.throws(() => wire.input('a', {type}), /original Pi session/);
  const event = {type: 'message_update', assistantMessageEvent: {type: 'text_delta', delta: 'actual text'}};
  assert.deepEqual(wire.output(event), {message: event});
});
test('JSONL preserves Unicode separators and split UTF-8 characters inside native messages', () => {
  const input = new PassThrough(), messages: any[] = [], errors: Error[] = [];
  readJsonLines(input, message => messages.push(message), error => errors.push(error));
  const message = {text: '你好\u2028Pi\u2029'};
  const encoded = Buffer.from(JSON.stringify(message) + '\r\n');
  for (const byte of encoded) input.write(Buffer.from([byte]));
  input.end();
  assert.deepEqual(messages, [message]); assert.deepEqual(errors, []);
});
