import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveActions, calculateAwards } from '../game-engine.js';

const players = (...balances) => balances.map((balance, i) => ({ id: `p${i + 1}`, balance }));

test('missing action defaults to collect', () => {
  const result = resolveActions(players(1000, 1000), new Map([['p1', { type: 'protect' }]]));
  assert.deepEqual(result.players.map(p => p.balance), [1000, 1100]);
});

test('two successful targeted steals each transfer $150', () => {
  const actions = new Map([
    ['p1', { type: 'steal', targetId: 'p3' }],
    ['p2', { type: 'steal', targetId: 'p3' }],
    ['p3', { type: 'collect' }],
  ]);
  const result = resolveActions(players(1000, 1000, 1000), actions);
  assert.deepEqual(result.players.map(p => p.balance), [1150, 1150, 800]);
});

test('protection blocks all incoming steals', () => {
  const actions = new Map([
    ['p1', { type: 'steal', targetId: 'p3' }],
    ['p2', { type: 'steal', targetId: 'p3' }],
    ['p3', { type: 'protect' }],
  ]);
  const result = resolveActions(players(1000, 1000, 1000), actions);
  assert.deepEqual(result.players.map(p => p.balance), [1000, 1000, 1000]);
  assert.equal(result.events.filter(e => e.type === 'blocked').length, 2);
});

test('insufficient target balance is divided evenly without negative balances', () => {
  const actions = new Map([
    ['p1', { type: 'steal', targetId: 'p3' }],
    ['p2', { type: 'steal', targetId: 'p3' }],
    ['p3', { type: 'collect' }],
  ]);
  const result = resolveActions(players(1000, 1000, 100), actions);
  assert.deepEqual(result.players.map(p => p.balance), [1050, 1050, 100]);
});

test('collect adds $100 and cannot be stolen in the same round', () => {
  const actions = new Map([
    ['p1', { type: 'steal', targetId: 'p2' }],
    ['p2', { type: 'collect' }],
  ]);
  const result = resolveActions(players(1000, 1000), actions);
  assert.deepEqual(result.players.map(p => p.balance), [1150, 950]);
});

test('jackpot rounds double collect and steal payouts', () => {
  const players = [{ id: 'a', balance: 1000 }, { id: 'b', balance: 1000 }];
  const actions = new Map([['a', { type: 'collect' }], ['b', { type: 'steal', targetId: 'a' }]]);
  const result = resolveActions(players, actions, 5);
  assert.equal(result.jackpot, true);
  assert.equal(result.collectReward, 200);
  assert.equal(result.stealAmount, 300);
  assert.equal(result.players.find(p => p.id === 'a').balance, 900);
  assert.equal(result.players.find(p => p.id === 'b').balance, 1350);
});

test('stealing from the current leader adds the catch-up bounty', () => {
  const players = [{ id: 'leader', balance: 1500 }, { id: 'challenger', balance: 1000 }];
  const actions = new Map([['leader', { type: 'collect' }], ['challenger', { type: 'steal', targetId: 'leader' }]]);
  const result = resolveActions(players, actions, 1);
  assert.equal(result.events[0].bounty, 50);
  assert.equal(result.players.find(p => p.id === 'challenger').balance, 1200);
});

test('double steal power-up doubles a steal and is consumed once', () => {
  const players = [{ id: 'a', balance: 1000, powerUps: ['double-steal'] }, { id: 'b', balance: 1000, powerUps: [] }];
  const actions = new Map([['a', { type: 'steal', targetId: 'b', powerUp: 'double-steal' }], ['b', { type: 'collect' }]]);
  const result = resolveActions(players, actions, 1);
  assert.equal(result.players.find(p => p.id === 'a').balance, 1300);
  assert.deepEqual(result.players.find(p => p.id === 'a').powerUps, []);
});

test('spy consumes its power-up without changing cash', () => {
  const players = [{ id: 'a', balance: 1000, powerUps: ['spy'] }, { id: 'b', balance: 1000, powerUps: [] }];
  const actions = new Map([['a', { type: 'spy', targetId: 'b', powerUp: 'spy' }], ['b', { type: 'collect' }]]);
  const result = resolveActions(players, actions, 7);
  assert.equal(result.players.find(p => p.id === 'a').balance, 1000);
  assert.deepEqual(result.players.find(p => p.id === 'a').powerUps, []);
});

test('scarce target balance is shared proportionally when one attacker doubles', () => {
  const players = [{ id: 'a', balance: 1000, powerUps: ['double-steal'] }, { id: 'b', balance: 1000 }, { id: 'target', balance: 300 }];
  const actions = new Map([['a', { type: 'steal', targetId: 'target', powerUp: 'double-steal' }], ['b', { type: 'steal', targetId: 'target' }], ['target', { type: 'collect' }]]);
  const result = resolveActions(players, actions, 1);
  assert.equal(result.events.find(e => e.attackerId === 'a').amount, 200);
  assert.equal(result.events.find(e => e.attackerId === 'b').amount, 100);
  assert.equal(result.players.find(p => p.id === 'target').balance, 100);
});

test('award calculation identifies steals, blocks, and biggest swing', () => {
  const history = [{ events: [{ type: 'stolen', attackerId: 'a', targetId: 'b', amount: 150 }, { type: 'blocked', attackerId: 'a', targetId: 'b' }], deltas: [{ playerId: 'a', delta: 150 }, { playerId: 'b', delta: -150 }] }];
  const awards = calculateAwards(history, [{ id: 'a' }, { id: 'b' }]);
  assert.equal(awards.find(a => a.title === 'MOST STEALS').playerId, 'a');
  assert.equal(awards.find(a => a.title === 'MOST BLOCKED').playerId, 'b');
  assert.ok(awards.find(a => a.title === 'BIGGEST SWING').value === 150);
});
