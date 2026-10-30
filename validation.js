export const MAX_NAME_LENGTH = 18;
export const AVATAR_COUNT = 8;

export function cleanName(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKC').replace(/[<>\u0000-\u001F\u007F]/g, '').trim().slice(0, MAX_NAME_LENGTH);
}

export function normalizeRoomCode(value) {
  if (typeof value !== 'string') return '';
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

export function sanitizeAvatar(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return 0;
  return Math.max(0, Math.min(AVATAR_COUNT - 1, parsed));
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isCurrentSocket(player, socketId) {
  return Boolean(player && player.socketId && player.socketId === socketId);
}
