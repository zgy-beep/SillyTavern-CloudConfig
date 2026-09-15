import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeJson, calcJsonChecksum } from '../../src/common/utils.js';

test('canonicalizeJson: sorts keys in ascending order recursively', () => {
  const objA = {
    z: 'last',
    a: 'first',
    m: {
      foo: 1,
      bar: 2,
    },
    list: [3, 2, 1],
  };

  const objB = {
    m: {
      bar: 2,
      foo: 1,
    },
    a: 'first',
    list: [3, 2, 1],
    z: 'last',
  };

  const bufA = canonicalizeJson(objA);
  const bufB = canonicalizeJson(objB);

  assert.equal(bufA.toString('utf8'), bufB.toString('utf8'));
  assert.equal(calcJsonChecksum(objA), calcJsonChecksum(objB));
});

test('canonicalizeJson: differentiates different content', () => {
  const objA = { a: 1, b: 2 };
  const objB = { a: 1, b: 3 };

  assert.notEqual(calcJsonChecksum(objA), calcJsonChecksum(objB));
});
