import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeRoomSnapshot } from '../room-snapshot.js';

const validRoom = {
  code: 'ABC234', status: 'lobby', hostId: 'player-1', round: 0,
  players: [{ id: 'player-1', name: 'Alex', balance: 1000 }], actions: [],
};

test('valid room snapshots decode without changing their contents', () => {
  assert.deepEqual(decodeRoomSnapshot(JSON.stringify(validRoom)), validRoom);
});

test('malformed JSON is rejected', () => {
  assert.throws(() => decodeRoomSnapshot('{not-json'), SyntaxError);
});

test('invalid room codes and statuses are rejected', () => {
  assert.throws(() => decodeRoomSnapshot(JSON.stringify({ ...validRoom, code: 'bad' })), /room code/);
  assert.throws(() => decodeRoomSnapshot(JSON.stringify({ ...validRoom, status: 'unknown' })), /status/);
});

test('missing collections and invalid player balances are rejected', () => {
  assert.throws(() => decodeRoomSnapshot(JSON.stringify({ code: 'ABC234', status: 'lobby' })), /collections/);
  assert.throws(() => decodeRoomSnapshot(JSON.stringify({ ...validRoom, players: [{ id: 'x', name: 'X', balance: NaN }] })), /player data/);
});

test('snapshots cannot restore more than eight players', () => {
  const players = Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, balance: 1000 }));
  assert.throws(() => decodeRoomSnapshot(JSON.stringify({ ...validRoom, players })), /player data/);
});

test('room snapshots preserve player power-ups and recent match history', () => {
  const input = JSON.stringify({
    code: 'ABC234', status: 'lobby', players: [{ id: 'p1', name: 'A', balance: 1000, powerUps: ['spy'] }],
    actions: [], history: [{ round: 1, actions: [] }],
  });
  const room = decodeRoomSnapshot(input);
  assert.deepEqual(room.players[0].powerUps, ['spy']);
  assert.equal(room.history.length, 1);
});

test('room snapshots reject unknown power-ups', () => {
  const input = JSON.stringify({ code: 'ABC234', status: 'lobby', players: [{ id: 'p1', name: 'A', balance: 1000, powerUps: ['unlimited-cash'] }], actions: [] });
  assert.throws(() => decodeRoomSnapshot(input), /power-ups/);
});
