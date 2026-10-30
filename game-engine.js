export const GAME_RULES = Object.freeze({
  startingCash: 1000,
  collectReward: 100,
  stealAmount: 150,
  rounds: 10,
  roundSeconds: 15,
  jackpotRounds: Object.freeze([5, 10]),
  jackpotMultiplier: 2,
  leaderBounty: 50,
  powerUpRounds: Object.freeze([3, 7]),
});

/** Resolve a complete round from a frozen set of player actions. */
export function resolveActions(players, submittedActions, round = 1) {
  const jackpot = GAME_RULES.jackpotRounds.includes(round);
  const collectReward = GAME_RULES.collectReward * (jackpot ? GAME_RULES.jackpotMultiplier : 1);
  const stealAmount = GAME_RULES.stealAmount * (jackpot ? GAME_RULES.jackpotMultiplier : 1);
  const leader = [...players].sort((a, b) => b.balance - a.balance)[0];
  const actions = new Map();
  for (const player of players) {
    const action = submittedActions.get(player.id) || { type: 'collect' };
    actions.set(player.id, action);
  }

  const protectedIds = new Set([...actions.entries()].filter(([, action]) => action.type === 'protect').map(([id]) => id));
  const attacksByTarget = new Map();
  for (const [attackerId, action] of actions) {
    if (action.type !== 'steal' || !actions.has(action.targetId) || action.targetId === attackerId) continue;
    if (!attacksByTarget.has(action.targetId)) attacksByTarget.set(action.targetId, []);
    attacksByTarget.get(action.targetId).push(attackerId);
  }

  const deltas = new Map(players.map(player => [player.id, 0]));
  const events = [];
  for (const [targetId, attackers] of attacksByTarget) {
    const target = players.find(player => player.id === targetId);
    if (!target || protectedIds.has(targetId)) {
      for (const attackerId of attackers) events.push({ type: 'blocked', attackerId, targetId, amount: 0 });
      continue;
    }
    const weights = attackers.map(attackerId => actions.get(attackerId).powerUp === 'double-steal' ? 2 : 1);
    const totalRequested = stealAmount * weights.reduce((sum, weight) => sum + weight, 0);
    const allocationScale = Math.min(1, Math.max(0, target.balance) / totalRequested);
    for (let index = 0; index < attackers.length; index += 1) {
      const attackerId = attackers[index];
      // If the target cannot cover every request, distribute the remaining cash
      // proportionally to each attack's requested size.
      const amount = Number((stealAmount * weights[index] * allocationScale).toFixed(2));
      if (amount <= 0) continue;
      deltas.set(attackerId, deltas.get(attackerId) + amount);
      deltas.set(targetId, deltas.get(targetId) - amount);
      const bounty = targetId === leader?.id ? GAME_RULES.leaderBounty : 0;
      if (bounty) deltas.set(attackerId, deltas.get(attackerId) + bounty);
      events.push({ type: 'stolen', attackerId, targetId, amount, bounty });
    }
  }

  for (const [id, action] of actions) {
    if (action.type === 'collect') deltas.set(id, deltas.get(id) + collectReward);
  }

  const updatedPlayers = players.map(player => {
    const action = actions.get(player.id);
    const powerUps = [...(player.powerUps || [])];
    if (action.powerUp === 'double-steal' || action.type === 'spy') {
      const used = action.powerUp || 'spy';
      const index = powerUps.indexOf(used);
      if (index >= 0) powerUps.splice(index, 1);
    }
    return { ...player, powerUps, balance: Math.max(0, Number((player.balance + deltas.get(player.id)).toFixed(2))) };
  });

  return {
    players: updatedPlayers,
    jackpot,
    collectReward,
    stealAmount,
    actions: [...actions.entries()].map(([playerId, action]) => ({ playerId, type: action.type, targetId: action.targetId || null, powerUp: action.powerUp || null })),
    events,
    deltas: [...deltas.entries()].map(([playerId, delta]) => ({ playerId, delta: Number(delta.toFixed(2)) })),
  };
}

export function calculateAwards(history, players) {
  const stats = new Map(players.map(p => [p.id, { steals: 0, blocked: 0, biggestSwing: 0 }]));
  for (const round of history || []) {
    for (const event of round.events || []) {
      if (event.type === 'stolen') {
        const stat = stats.get(event.attackerId);
        if (stat) { stat.steals += 1; stat.biggestSwing = Math.max(stat.biggestSwing, event.amount + (event.bounty || 0)); }
      }
      if (event.type === 'blocked') {
        const stat = stats.get(event.targetId);
        if (stat) stat.blocked += 1;
      }
    }
    for (const delta of round.deltas || []) {
      const stat = stats.get(delta.playerId);
      if (stat) stat.biggestSwing = Math.max(stat.biggestSwing, Math.abs(delta.delta));
    }
  }
  const rows = [...stats.entries()].map(([playerId, value]) => ({ playerId, ...value }));
  const pick = (key, title) => {
    const top = [...rows].sort((a, b) => b[key] - a[key])[0];
    return top && top[key] > 0 ? { title, playerId: top.playerId, value: top[key] } : null;
  };
  return [pick('steals', 'MOST STEALS'), pick('blocked', 'MOST BLOCKED'), pick('biggestSwing', 'BIGGEST SWING')].filter(Boolean);
}
