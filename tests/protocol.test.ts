import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clientMessageValidators,
  sendClientMessage,
  sendServerMessage,
} from '../shared/protocol.js';
import { EMPTY_INPUT } from '../shared/game.js';

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

test('burst input accepts legacy controls and bounded directions but rejects forged values', () => {
  assert.equal(clientMessageValidators.input(EMPTY_INPUT), true);
  assert.equal(
    clientMessageValidators.input({ ...EMPTY_INPUT, boost: true, boostX: 1, boostZ: 0 }),
    true,
  );
  for (const boost of [1, 'true', null])
    assert.equal(clientMessageValidators.input({ ...EMPTY_INPUT, boost }), false);
  for (const key of ['boostX', 'boostZ']) {
    for (const value of [Infinity, NaN, 2, -2, '1', null])
      assert.equal(clientMessageValidators.input({ ...EMPTY_INPUT, [key]: value }), false);
  }
});
