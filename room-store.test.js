import test from 'node:test';
import assert from 'node:assert/strict';
import { roundResolutionKey } from '../room-store.js';

test('round-resolution keys are isolated between rematches in the same room', () => {
  const firstMatch = roundResolutionKey('ABC234', 'match-one', 1);
  const secondMatch = roundResolutionKey('ABC234', 'match-two', 1);
  assert.notEqual(firstMatch, secondMatch);
});

test('round-resolution keys are isolated by round within one match', () => {
  assert.notEqual(
    roundResolutionKey('ABC234', 'match-one', 1),
    roundResolutionKey('ABC234', 'match-one', 2),
  );
});
