import test from 'node:test';
import assert from 'node:assert/strict';
import { makeItemUid } from '../../src/common/utils.js';

test('makeItemUid: generates 64-char hex string deterministically', () => {
  const uid1 = makeItemUid('settings', 'settings.json');
  const uid2 = makeItemUid('settings', 'settings.json');
  const uid3 = makeItemUid('openai_preset', 'settings.json');

  assert.equal(uid1.length, 64);
  assert.match(uid1, /^[0-9a-f]{64}$/);
  assert.equal(uid1, uid2);
  assert.notEqual(uid1, uid3);
});

test('makeItemUid: throws on missing arguments', () => {
  assert.throws(() => makeItemUid('', 'foo'), /required/);
  assert.throws(() => makeItemUid('bar', ''), /required/);
});
