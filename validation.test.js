import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanName, normalizeRoomCode, sanitizeAvatar, isPlainObject, isCurrentSocket } from '../validation.js';

test('player names are normalized, trimmed, bounded, and stripped of control/html delimiters', () => {
  assert.equal(cleanName('  <Alex>\n'), 'Alex');
  assert.equal(cleanName('A'.repeat(30)).length, 18);
  assert.equal(cleanName(null), '');
});

test('room codes normalize to six uppercase alphanumeric characters', () => {
  assert.equal(normalizeRoomCode(' ab-cd 23 '), 'ABCD23');
  assert.equal(normalizeRoomCode(null), '');
});

test('avatar indexes are clamped to the eight supported choices', () => {
  assert.equal(sanitizeAvatar(7), 7);
  assert.equal(sanitizeAvatar(99), 7);
  assert.equal(sanitizeAvatar(-3), 0);
  assert.equal(sanitizeAvatar('not-a-number'), 0);
});

test('only plain object-like payloads are accepted', () => {
  assert.equal(isPlainObject({ name: 'Alex' }), true);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject([]), false);
});

test('stale socket disconnects cannot take a replacement player offline', () => {
  const player = { socketId: 'new-socket' };
  assert.equal(isCurrentSocket(player, 'old-socket'), false);
  assert.equal(isCurrentSocket(player, 'new-socket'), true);
  assert.equal(isCurrentSocket(null, 'new-socket'), false);
});
