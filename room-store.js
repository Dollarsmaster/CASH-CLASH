import { decodeRoomSnapshot } from './room-snapshot.js';
import crypto from 'node:crypto';
let client = null;
let ready = false;
let lastError = null;
const PREFIX = 'cash-clash:room:';
const TTL_SECONDS = 24 * 60 * 60;
const SERVER_LEASE_KEY = 'cash-clash:coordination:server-lease';
const SERVER_LEASE_TTL_MS = 30_000;
let serverLeaseToken = null;
let serverLeaseHeld = false;
let serverLeaseRenewal = null;
const roomWriteQueues = new Map();

export async function initializeRoomStore() {
  if (!process.env.REDIS_URL) return { enabled: false, ready: false };
  try {
    const { createClient } = await import('redis');
    client = createClient({ url: process.env.REDIS_URL, socket: { reconnectStrategy: retries => Math.min(retries * 250, 3000) } });
    client.on('error', error => { lastError = error.message; ready = false; console.error('Redis error:', error.message); });
    client.on('ready', () => { ready = true; lastError = null; });
    client.on('end', () => { ready = false; });
    await client.connect();
    ready = true;
    lastError = null;
    return { enabled: true, ready: true };
  } catch (error) {
    lastError = error.message;
    console.error('Redis initialization failed:', error.message);
    return { enabled: true, ready: false, error: error.message };
  }
}

function encodeRoom(room) {
  return JSON.stringify({
    code: room.code, matchId: room.matchId || null, hostId: room.hostId, status: room.status, round: room.round,
    roundEndsAt: room.roundEndsAt, players: [...room.players.values()].map(p => ({ ...p, socketId: null, connected: false, disconnectTimer: null })),
    actions: [...room.actions.entries()], reveal: room.reveal, lastResults: room.lastResults, history: room.history || [], privateIntel: room.privateIntel || {}, awards: room.awards || [], pendingFinish: Boolean(room.pendingFinish), winner: room.winner,
  });
}

export async function persistRoom(room) {
  if (!client || !ready) return false;
  // Serialize writes per room so a slower older snapshot cannot overwrite a
  // newer state when multiple socket events arrive close together.
  const code = room.code;
  const key = `${PREFIX}${code}`;
  const snapshot = encodeRoom(room);
  const previous = roomWriteQueues.get(code) || Promise.resolve();
  const write = previous.catch(() => {}).then(async () => {
    if (!client || !ready) return false;
    await client.set(key, snapshot, { EX: TTL_SECONDS });
    return true;
  });
  roomWriteQueues.set(code, write);
  try { return await write; }
  finally { if (roomWriteQueues.get(code) === write) roomWriteQueues.delete(code); }
}


export async function deleteStoredRoom(code) {
  if (!client || !ready) return false;
  const previous = roomWriteQueues.get(code) || Promise.resolve();
  await previous.catch(() => {});
  await client.del(`${PREFIX}${code}`);
  return true;
}

export async function loadStoredRooms() {
  if (!client || !ready) return [];
  const restored = [];
  let batch = [];
  const loadBatch = async keys => {
    if (!keys.length) return;
    const values = await client.mGet(keys);
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      if (!value) continue;
      try {
        restored.push(decodeRoomSnapshot(value));
      } catch (error) {
        // One damaged/old snapshot must not prevent other rooms from loading.
        console.error(`Skipping invalid Redis room snapshot ${keys[index]}:`, error.message);
        await client.del(keys[index]).catch(() => {});
      }
    }
  };
  for await (const key of client.scanIterator({ MATCH: `${PREFIX}*`, COUNT: 100 })) {
    batch.push(key);
    if (batch.length >= 100) {
      await loadBatch(batch);
      batch = [];
    }
  }
  await loadBatch(batch);
  return restored;
}

// A deliberately single-owner lease protects the current in-memory game engine.
// It prevents accidental horizontal scaling until room state is truly shared.
export async function acquireServerLease() {
  if (!client || !ready) return { enabled: Boolean(process.env.REDIS_URL), acquired: !process.env.REDIS_URL };
  const token = crypto.randomUUID();
  const result = await client.set(SERVER_LEASE_KEY, token, { NX: true, PX: SERVER_LEASE_TTL_MS });
  if (result !== 'OK') return { enabled: true, acquired: false };
  serverLeaseToken = token;
  serverLeaseHeld = true;
  const renewScript = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`;
  serverLeaseRenewal = setInterval(async () => {
    try {
      const renewed = await client.eval(renewScript, { keys: [SERVER_LEASE_KEY], arguments: [token, String(SERVER_LEASE_TTL_MS)] });
      if (renewed !== 1) {
        serverLeaseHeld = false;
        ready = false;
        console.error('CASH CLASH server lease was lost; exiting to prevent split-brain gameplay.');
        setTimeout(() => process.exit(1), 1000).unref();
      }
    } catch (error) {
      serverLeaseHeld = false;
      ready = false;
      lastError = error.message;
      console.error('Could not renew CASH CLASH server lease; exiting fail-closed:', error.message);
      setTimeout(() => process.exit(1), 1000).unref();
    }
  }, 10_000);
  serverLeaseRenewal.unref();
  return { enabled: true, acquired: true };
}

export function roundResolutionKey(code, matchId, round) {
  // Match identity is essential: room codes are reused for rematches, so a
  // key based only on room + round would block round 1 of every later match.
  return `cash-clash:round-resolution:${code}:${matchId}:${round}`;
}

export async function claimRoundResolution(code, matchId, round) {
  if (!process.env.REDIS_URL) return true;
  if (!client || !ready || !serverLeaseHeld || !matchId) return false;
  const key = roundResolutionKey(code, matchId, round);
  const result = await client.set(key, serverLeaseToken || 'single-process', { NX: true, EX: 120 });
  return result === 'OK';
}

export async function releaseServerLease() {
  if (serverLeaseRenewal) clearInterval(serverLeaseRenewal);
  serverLeaseRenewal = null;
  if (!client || !client.isOpen || !serverLeaseToken) return;
  const script = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;
  await client.eval(script, { keys: [SERVER_LEASE_KEY], arguments: [serverLeaseToken] });
  serverLeaseToken = null;
  serverLeaseHeld = false;
}

export function roomStoreStatus() {
  return { enabled: Boolean(process.env.REDIS_URL), ready, leaseHeld: serverLeaseHeld, error: lastError };
}

export async function closeRoomStore() {
  await releaseServerLease().catch(error => console.error('Could not release server lease:', error.message));
  if (client?.isOpen) await client.quit();
  roomWriteQueues.clear();
  ready = false;
}
