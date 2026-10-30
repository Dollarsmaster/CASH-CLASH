/** Decode and validate the durable shape of a Redis room snapshot. */
export function decodeRoomSnapshot(value) {
  if (typeof value !== 'string') throw new TypeError('Room snapshot must be a string');
  const room = JSON.parse(value);
  if (!room || typeof room !== 'object' || Array.isArray(room)) {
    throw new TypeError('Room snapshot must be an object');
  }
  if (typeof room.code !== 'string' || !/^[A-Z0-9]{6}$/.test(room.code)) {
    throw new TypeError('Room snapshot has an invalid room code');
  }
  if (!Array.isArray(room.players) || !Array.isArray(room.actions)) {
    throw new TypeError('Room snapshot is missing player or action collections');
  }
  if (!['lobby', 'playing', 'reveal', 'finished'].includes(room.status)) {
    throw new TypeError('Room snapshot has an invalid status');
  }
  if (room.players.length > 8 || room.players.some(player => (
    !player || typeof player !== 'object' || typeof player.id !== 'string' ||
    typeof player.name !== 'string' || !Number.isFinite(player.balance)
  ))) {
    throw new TypeError('Room snapshot contains invalid player data');
  }
  for (const player of room.players) {
    if (player.powerUps !== undefined && (!Array.isArray(player.powerUps) || player.powerUps.some(power => !['double-steal', 'spy'].includes(power)))) {
      throw new TypeError('Room snapshot contains invalid player power-ups');
    }
  }
  if (room.history !== undefined && !Array.isArray(room.history)) throw new TypeError('Room snapshot has invalid move history');
  return room;
}
