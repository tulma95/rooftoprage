import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clientMessageValidators,
  sendClientMessage,
  sendServerMessage,
} from '../shared/protocol.js';

// Checked by tsc, deliberately never executed.
function invalidMessages() {
  const sender = { send() {} };
  // @ts-expect-error readiness must be boolean
  sendClientMessage(sender, 'ready', 'true');
  // @ts-expect-error equipment requires a payload
  sendClientMessage(sender, 'equipment');
  // @ts-expect-error unknown message name
  sendClientMessage(sender, 'damage', 100);
  // @ts-expect-error server notices are strings
  sendServerMessage(sender, 'notice', 123);
}
void invalidMessages;

test('message boundary rejects forged controls and readiness before handlers run', () => {
  assert.equal(clientMessageValidators.ready('true'), false);
  assert.equal(clientMessageValidators.ready(false), true);
  assert.equal(
    clientMessageValidators.input({ forward: Infinity, turn: 0, front: false, top: false }),
    false,
  );
  assert.equal(clientMessageValidators.equipment({ front: 'cannon', top: 'ram' }), false);
  assert.equal(clientMessageValidators.start({ playerId: 'host' }), false);
  assert.equal(clientMessageValidators.start(undefined), true);
});
