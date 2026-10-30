import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';
import crypto from 'node:crypto';
import { GAME_RULES, resolveActions, calculateAwards } from './game-engine.js';
import { initializeStorage, saveCompletedMatch, storageStatus, closeStorage } from './storage.js';
import { initializeRoomStore, persistRoom, deleteStoredRoom, loadStoredRooms, roomStoreStatus, closeRoomStore, acquireServerLease, claimRoundResolution } from './room-store.js';
import { initializeSocketAdapter, socketAdapterStatus, closeSocketAdapter } from './socket-adapter.js';
import { cleanName, normalizeRoomCode, sanitizeAvatar, isPlainObject, isCurrentSocket } from './validation.js';

const PORT = Number(process.env.PORT || 3001);
const CLIENT_ORIGINS = (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',').map(value => value.trim()).filter(Boolean);
const corsOrigin = (origin, callback) => {
  if (!origin || CLIENT_ORIGINS.includes('*') || CLIENT_ORIGINS.includes(origin)) return callback(null, true);
  return callback(new Error('Origin not allowed by CASH CLASH server.'));
};
const ROUND_SECONDS = GAME_RULES.roundSeconds;
const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2;
const STARTING_CASH = GAME_RULES.startingCash;
const RECONNECT_GRACE_MS = 60_000;
const rooms = new Map();
const resolvingRounds = new Set();
const resolutionRetryTimers = new Map();
const app = express();
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.get('/health', (_req, res) => { const database = storageStatus(); const redis = roomStoreStatus(); const socketAdapter = socketAdapterStatus(); const dependenciesReady = (!database.enabled || database.ready) && (!redis.enabled || (redis.ready && redis.leaseHeld)) && (!socketAdapter.enabled || socketAdapter.ready); res.status(dependenciesReady ? 200 : 503).json({ ok: dependenciesReady, service: 'cash-clash-server', uptimeSeconds: Math.floor(process.uptime()), rooms: rooms.size, database, redis, socketAdapter, gameStateMode: 'single-authoritative-process', multiInstanceSafe: false }); });
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: corsOrigin, methods: ['GET', 'POST'], credentials: true }, pingInterval: 10_000, pingTimeout: 20_000, maxHttpBufferSize: 16_384 });

const codeChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode() {
  let code;
  do { code = Array.from({ length: 6 }, () => codeChars[crypto.randomInt(codeChars.length)]).join(''); } while (rooms.has(code));
  return code;
}
const publicPlayer = p => ({ id: p.id, name: p.name, avatar: p.avatar, balance: p.balance, connected: p.connected, isBot: Boolean(p.isBot), powerUps: p.powerUps || [], isHost: p.id === p.hostId });
function snapshot(room, viewerId) {
  const players = [...room.players.values()].map(p => ({ ...publicPlayer({ ...p, hostId: room.hostId }) })).sort((a,b) => b.balance-a.balance || a.name.localeCompare(b.name));
  const ownAction = room.actions.get(viewerId) || null;
  return {
    code: room.code, status: room.status, round: room.round, maxRounds: GAME_RULES.rounds,
    roundEndsAt: room.roundEndsAt, serverNow: Date.now(), players,
    hostId: room.hostId, myId: viewerId, myAction: ownAction,
    reveal: room.reveal, lastResults: room.lastResults,
    recentMoves: (room.history || []).slice(-3).reverse().map(item => ({ round: item.round, actions: item.actions })),
    jackpot: GAME_RULES.jackpotRounds.includes(room.round),
    myIntel: room.privateIntel?.[viewerId] || null,
    awards: room.awards || [],
    reconnecting: [...room.players.values()].filter(p => !p.connected && !p.isBot).map(p => ({ id: p.id, name: p.name })),
    winner: room.winner || null
  };
}
function sendRoom(room) {
  for (const p of room.players.values()) if (p.socketId) io.to(p.socketId).emit('room:update', snapshot(room, p.id));
  for (const socketId of room.spectators || []) io.to(socketId).emit('room:update', snapshot(room, null));
  persistRoom(room).catch(error => console.error(`Could not persist room ${room.code}:`, error.message));
}
function emitError(socket, message) { socket.emit('app:error', { message }); }
function clearTimer(room) { if (room.timer) clearTimeout(room.timer); room.timer = null; }

function resetIncompleteGame(room) {
  clearTimer(room);
  room.status = 'lobby';
  room.round = 0;
  room.roundEndsAt = null;
  room.actions.clear();
  room.reveal = null;
  room.lastResults = null;
  room.winner = null;
  room.history = []; room.privateIntel = {}; room.awards = []; room.pendingFinish = false;
  for (const player of room.players.values()) { player.balance = STARTING_CASH; player.powerUps = []; }
}

function chooseNewHost(room) {
  if (room.players.has(room.hostId) && room.players.get(room.hostId).connected && !room.players.get(room.hostId).isBot) return;
  const next = [...room.players.values()].find(p => p.connected && !p.isBot);
  room.hostId = next?.id || null;
}
function startRound(room) {
  clearTimer(room);
  room.status = 'playing';
  room.actions = new Map();
  room.reveal = null;
  if (GAME_RULES.powerUpRounds.includes(room.round)) {
    const reward = room.round === 3 ? 'double-steal' : 'spy';
    for (const player of room.players.values()) {
      player.powerUps = [...(player.powerUps || []), reward];
    }
  }
  room.lastResults = null;
  room.roundEndsAt = Date.now() + ROUND_SECONDS * 1000;
  sendRoom(room);
  room.timer = setTimeout(() => resolveRound(room.code), ROUND_SECONDS * 1000);
  for (const bot of room.players.values()) {
    if (!bot.isBot) continue;
    const botRound = room.round;
    const botMatchId = room.matchId;
    const delay = 1500 + Math.floor(Math.random() * Math.max(1000, (ROUND_SECONDS - 3) * 650));
    const botTimer = setTimeout(() => {
      const current = rooms.get(room.code);
      if (!current || current.status !== 'playing' || current.round !== botRound || current.matchId !== botMatchId || current.actions.has(bot.id)) return;
      const rivals = [...current.players.values()].filter(player => player.id !== bot.id);
      const leader = [...rivals].sort((a, b) => b.balance - a.balance)[0];
      const roll = Math.random();
      let action = roll < 0.18 ? { type: 'protect' } : roll < 0.65 && leader ? { type: 'steal', targetId: leader.id } : { type: 'collect' };
      if (action.type === 'steal' && (bot.powerUps || []).includes('double-steal') && Math.random() < 0.5) action.powerUp = 'double-steal';
      current.actions.set(bot.id, action);
      const activePlayers = [...current.players.values()].filter(player => player.connected);
      const submittedActive = activePlayers.filter(player => current.actions.has(player.id)).length;
      if (submittedActive >= activePlayers.length) resolveRound(current.code); else sendRoom(current);
    }, delay);
    botTimer.unref?.();
  }
}
function scheduleResolutionRetry(code, matchId, round, delay = 1500) {
  const key = `${code}:${matchId}:${round}`;
  if (resolutionRetryTimers.has(key)) return;
  const timer = setTimeout(() => {
    resolutionRetryTimers.delete(key);
    const current = rooms.get(code);
    if (current?.status === 'playing' && current.matchId === matchId && current.round === round) {
      resolveRound(code);
    }
  }, delay);
  timer.unref?.();
  resolutionRetryTimers.set(key, timer);
}

async function resolveRound(code) {
  const room = rooms.get(code);
  if (!room || room.status !== 'playing') return;
  const resolvingRound = room.round;
  const matchId = room.matchId;
  const resolutionKey = `${code}:${matchId}:${resolvingRound}`;
  if (resolvingRounds.has(resolutionKey)) return;
  resolvingRounds.add(resolutionKey);
  try {
    let claimed;
    try {
      claimed = await claimRoundResolution(code, matchId, resolvingRound);
    } catch (error) {
      console.error(`Could not claim round ${resolvingRound} resolution for ${code}:`, error.message);
      scheduleResolutionRetry(code, matchId, resolvingRound);
      return;
    }
    if (!claimed) {
      // A transient Redis outage must not leave the round permanently frozen.
      // If another claim is genuinely active, the retry will safely wait for
      // that claim to expire; only one local resolution can run at a time.
      scheduleResolutionRetry(code, matchId, resolvingRound);
      return;
    }
    if (room.status !== 'playing' || room.round !== resolvingRound || room.matchId !== matchId) return;
    clearTimer(room);
    const submitted = new Map();
    for (const player of room.players.values()) {
      submitted.set(player.id, room.actions.get(player.id) || { type: 'collect' });
    }
    const resolution = resolveActions([...room.players.values()], submitted, resolvingRound);
    for (const updated of resolution.players) {
      const player = room.players.get(updated.id);
      if (player) player.balance = updated.balance;
    }
    room.lastResults = { actions: resolution.actions, events: resolution.events, deltas: resolution.deltas, jackpot: resolution.jackpot, collectReward: resolution.collectReward, stealAmount: resolution.stealAmount };
    room.history = [...(room.history || []), { round: resolvingRound, actions: resolution.actions, events: resolution.events, deltas: resolution.deltas }];
    for (const [playerId, action] of submitted) {
      if (action.type === 'spy') {
        const previous = room.history.length > 1 ? room.history[room.history.length - 2] : null;
        const seen = previous?.actions?.find(item => item.playerId === action.targetId);
        room.privateIntel[playerId] = { targetId: action.targetId, round: previous?.round || null, move: seen?.type || 'unknown' };
      }
    }
    room.reveal = room.lastResults;
    room.roundEndsAt = null;
    room.status = 'reveal';
    if (room.round >= GAME_RULES.rounds) {
      room.pendingFinish = true;
      const ranked = [...room.players.values()].sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name));
      room.winner = ranked[0] ? { id: ranked[0].id, name: ranked[0].name, balance: ranked[0].balance } : null;
      room.awards = calculateAwards(room.history, ranked);
    }
    sendRoom(room);
    if (room.status === 'reveal') {
      room.timer = setTimeout(() => {
        const current = rooms.get(code);
        if (current?.status === 'reveal' && current.matchId === matchId) {
          if (current.pendingFinish) {
            current.pendingFinish = false;
            current.status = 'finished';
            const ranked = [...current.players.values()].sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name));
            saveCompletedMatch({ roomCode: current.code, roundsCompleted: current.round, winner: current.winner, players: ranked.map(({ id, name, avatar, balance }) => ({ id, name, avatar, balance })), results: current.history })
              .then(result => { if (result.saved) console.log(`Saved CASH CLASH match ${result.id}`); })
              .catch(error => console.error('Could not save completed match:', error.message));
            sendRoom(current);
          } else {
            current.round += 1;
            startRound(current);
          }
        }
      }, 4500);
    }
  } catch (error) {
    console.error(`Round ${resolvingRound} resolution failed for ${code}:`, error);
    // Avoid a silent unhandled rejection. The server remains healthy enough to
    // report the failure; operator intervention may be needed if Redis has
    // already recorded the resolution claim.
  } finally {
    resolvingRounds.delete(resolutionKey);
  }
}

function removePlayer(room, playerId) {
  const p = room.players.get(playerId);
  if (!p) return;
  if (p.socketId) io.to(p.socketId).emit('room:closed', { message: 'You were removed from the room.' });
  room.players.delete(playerId);
  room.actions.delete(playerId);
  chooseNewHost(room);
  if (![...room.players.values()].some(player => !player.isBot)) { clearTimer(room); rooms.delete(room.code); deleteStoredRoom(room.code).catch(error => console.error('Could not delete stored room:', error.message)); return; }
  if ((room.status === 'playing' || room.status === 'reveal') && [...room.players.values()].filter(player => player.connected).length < MIN_PLAYERS) {
    resetIncompleteGame(room);
  }
  sendRoom(room);
}

io.on('connection', socket => {
  socket.use((packet, next) => {
    const now = Date.now();
    const recent = (socket.data.eventTimes || []).filter(time => now - time < 10_000);
    if (recent.length >= 40) { socket.emit('app:error', { message: 'You are sending actions too quickly. Please wait a moment.' }); return; }
    recent.push(now); socket.data.eventTimes = recent;
    const eventName = packet[0];
    if (eventName === 'room:create' || eventName === 'room:join') {
      const joins = (socket.data.roomEventTimes || []).filter(time => now - time < 60_000);
      if (joins.length >= 8) { socket.emit('app:error', { message: 'Too many room attempts. Please wait a minute.' }); return; }
      joins.push(now); socket.data.roomEventTimes = joins;
    }
    next();
  });
  socket.on('room:create', rawPayload => {
    const payload = isPlainObject(rawPayload) ? rawPayload : {};
    const { name, avatar } = payload;
    const playerName = cleanName(name);
    if (!playerName) return emitError(socket, 'Enter a player name first.');
    if (socket.data.roomCode) return emitError(socket, 'Leave your current room before creating another.');
    const code = makeCode();
    const id = crypto.randomUUID();
    const room = { code, matchId: null, hostId: id, players: new Map(), spectators: new Set(), status: 'lobby', round: 0, roundEndsAt: null, actions: new Map(), reveal: null, lastResults: null, history: [], privateIntel: {}, awards: [], winner: null, timer: null };
    room.players.set(id, { id, name: playerName, avatar: sanitizeAvatar(avatar), balance: STARTING_CASH, powerUps: [], connected: true, socketId: socket.id, disconnectTimer: null });
    rooms.set(code, room); socket.join(code); socket.data.roomCode = code; socket.data.playerId = id;
    socket.emit('room:joined', { code, playerId: id }); sendRoom(room);
  });
  socket.on('room:join', rawPayload => {
    const payload = isPlainObject(rawPayload) ? rawPayload : {};
    const { code: rawCode, name, avatar, playerId } = payload;
    const code = normalizeRoomCode(rawCode);
    const room = rooms.get(code); const playerName = cleanName(name);
    if (socket.data.spectator && socket.data.roomCode) { const previous = rooms.get(socket.data.roomCode); previous?.spectators?.delete(socket.id); socket.leave(socket.data.roomCode); socket.data.roomCode = null; socket.data.spectator = false; }
    if (socket.data.roomCode) return emitError(socket, 'Leave your current room before joining another.');
    if (!room) return emitError(socket, 'Room not found. Check the code and try again.');
    if (!playerName) return emitError(socket, 'Enter a player name first.');
    if (room.status !== 'lobby' && room.status !== 'playing' && room.status !== 'reveal') return emitError(socket, 'This game is no longer accepting players.');
    let existing = playerId ? room.players.get(playerId) : null;
    if (existing?.isBot) return emitError(socket, 'That player session is not available.');
    if (existing) {
      if (existing.disconnectTimer) clearTimeout(existing.disconnectTimer);
      existing.connected = true; existing.socketId = socket.id;
    } else {
      if (room.status !== 'lobby') return emitError(socket, 'The game has already started.');
      if (room.players.size >= MAX_PLAYERS) return emitError(socket, 'This room is full (8 players maximum).');
      const id = crypto.randomUUID();
      existing = { id, name: playerName, avatar: sanitizeAvatar(avatar), balance: STARTING_CASH, powerUps: [], connected: true, socketId: socket.id, disconnectTimer: null };
      room.players.set(id, existing);
    }
    socket.join(code); socket.data.roomCode = code; socket.data.playerId = existing.id; socket.data.spectator = false;
    socket.emit('room:joined', { code, playerId: existing.id }); chooseNewHost(room); sendRoom(room);
  });
  socket.on('game:add-bot', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'lobby') return emitError(socket, 'Bots can only be added in the lobby.');
    if (socket.data.playerId !== room.hostId) return emitError(socket, 'Only the host can add AI players.');
    if (room.players.size >= MAX_PLAYERS) return emitError(socket, 'This room is full.');
    const names = ['Nova AI', 'Blitz AI', 'Midas AI', 'Rook AI', 'Echo AI', 'Vega AI'];
    const used = new Set([...room.players.values()].map(player => player.name));
    const name = names.find(candidate => !used.has(candidate)) || `Bot ${room.players.size}`;
    const id = `bot-${crypto.randomUUID()}`;
    room.players.set(id, { id, name, avatar: room.players.size % 8, balance: STARTING_CASH, powerUps: [], connected: true, socketId: null, disconnectTimer: null, isBot: true });
    sendRoom(room);
  });
  socket.on('room:spectate', rawPayload => {
    const code = normalizeRoomCode(isPlainObject(rawPayload) ? rawPayload.code : '');
    const room = rooms.get(code);
    if (socket.data.playerId) return emitError(socket, 'Leave your player room before spectating another match.');
    if (!room || !['playing', 'reveal'].includes(room.status)) return emitError(socket, 'There is no active game to spectate in that room.');
    if (socket.data.spectator && socket.data.roomCode) { const previous = rooms.get(socket.data.roomCode); previous?.spectators?.delete(socket.id); socket.leave(socket.data.roomCode); }
    room.spectators ||= new Set(); room.spectators.add(socket.id);
    socket.join(code); socket.data.roomCode = code; socket.data.playerId = null; socket.data.spectator = true;
    socket.emit('room:spectated', { code }); socket.emit('room:update', snapshot(room, null));
  });
  socket.on('room:leave', () => { const room = rooms.get(socket.data.roomCode); if (room?.spectators) room.spectators.delete(socket.id); if (room && socket.data.playerId) removePlayer(room, socket.data.playerId); socket.leave(socket.data.roomCode || ''); socket.data.roomCode = null; socket.data.playerId = null; socket.data.spectator = false; });
  socket.on('game:start', () => {
    const room = rooms.get(socket.data.roomCode); if (!room) return emitError(socket, 'Room no longer exists.');
    if (socket.data.playerId !== room.hostId) return emitError(socket, 'Only the host can start the game.');
    const connected = [...room.players.values()].filter(p => p.connected);
    if (connected.length < MIN_PLAYERS) return emitError(socket, 'At least two connected players are required.');
    if (room.status !== 'lobby') return;
    room.matchId = crypto.randomUUID();
    room.round = 1; room.history = []; room.privateIntel = {}; room.awards = []; room.pendingFinish = false; for (const p of room.players.values()) { p.balance = STARTING_CASH; p.powerUps = []; }
    startRound(room);
  });
  socket.on('game:action', rawPayload => {
    const payload = isPlainObject(rawPayload) ? rawPayload : {};
    const { type, targetId } = payload;
    const room = rooms.get(socket.data.roomCode); const playerId = socket.data.playerId;
    if (!room || room.status !== 'playing') return emitError(socket, 'This round is not accepting actions.');
    if (!room.players.has(playerId)) return emitError(socket, 'Player session not found.');
    if (Date.now() >= room.roundEndsAt) return emitError(socket, 'Time is up for this round.');
    if (room.actions.has(playerId)) return emitError(socket, 'Your action is already locked in.');
    if (!['collect', 'steal', 'protect', 'spy'].includes(type)) return emitError(socket, 'Invalid action.');
    if ((type === 'steal' || type === 'spy') && (!targetId || targetId === playerId || !room.players.has(targetId))) return emitError(socket, 'Choose a valid opponent to target.');
    const player = room.players.get(playerId);
    const powerUp = payload.powerUp || null;
    if (powerUp && !['double-steal'].includes(powerUp)) return emitError(socket, 'Invalid power-up.');
    if (powerUp && type !== 'steal') return emitError(socket, 'Double Steal can only be used with a steal action.');
    if (powerUp && !(player.powerUps || []).includes(powerUp)) return emitError(socket, 'You do not have that power-up available.');
    if (type === 'spy' && !(player.powerUps || []).includes('spy')) return emitError(socket, 'You do not have a Spy power-up available.');
    if (type === 'spy' && !room.history?.length) return emitError(socket, 'There is no previous move to inspect yet.');
    room.actions.set(playerId, { type, ...(targetId ? { targetId } : {}), ...(powerUp ? { powerUp } : {}), ...(type === 'spy' ? { powerUp: 'spy' } : {}) });
    socket.emit('action:locked', { type });
    // Never broadcast the submitted action or target before reveal.
    const connectedCount = [...room.players.values()].filter(p => p.connected).length;
    const submittedConnected = [...room.actions.keys()].filter(id => room.players.get(id)?.connected).length;
    if (submittedConnected >= connectedCount) resolveRound(room.code); else sendRoom(room);
  });
  socket.on('room:reaction', rawPayload => {
    const room = rooms.get(socket.data.roomCode);
    const emoji = isPlainObject(rawPayload) && typeof rawPayload.emoji === 'string' ? rawPayload.emoji : '';
    if (!room || (!room.players.has(socket.data.playerId) && !socket.data.spectator) || !['😂','😱','🔥','👏','💀','🛡️'].includes(emoji)) return;
    io.to(room.code).emit('room:reaction', { playerId: socket.data.playerId || null, spectator: Boolean(socket.data.spectator), emoji, at: Date.now() });
  });
  socket.on('game:play-again', () => {
    const room = rooms.get(socket.data.roomCode); if (!room || room.status !== 'finished') return;
    if (socket.data.playerId !== room.hostId) return emitError(socket, 'Only the host can start a rematch.');
    room.status = 'lobby'; room.matchId = null; room.round = 0; room.winner = null; room.reveal = null; room.lastResults = null; room.actions.clear(); room.roundEndsAt = null; room.history = []; room.privateIntel = {}; room.awards = []; room.pendingFinish = false;
    for (const p of room.players.values()) { p.balance = STARTING_CASH; p.powerUps = []; }
    sendRoom(room);
  });
  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    if (room?.spectators) room.spectators.delete(socket.id);
    if (socket.data.spectator) return; const p = room?.players.get(socket.data.playerId);
    // A superseded socket may disconnect after the player has reconnected.
    // It must not mark the replacement connection offline.
    if (!isCurrentSocket(p, socket.id)) return;
    p.connected = false; p.socketId = null; chooseNewHost(room);
    p.disconnectTimer = setTimeout(() => { const current = rooms.get(room.code); if (current?.players.has(p.id) && !p.connected) removePlayer(current, p.id); }, RECONNECT_GRACE_MS);
    if (room.status === 'playing') {
      const connected = [...room.players.values()].filter(x => x.connected);
      const submitted = [...room.actions.keys()].filter(id => room.players.get(id)?.connected).length;
      if (connected.length >= MIN_PLAYERS && submitted >= connected.length) resolveRound(room.code);
      else if (connected.length < MIN_PLAYERS) resetIncompleteGame(room);
    }
    sendRoom(room);
  });
});

let httpServer = null;

async function bootstrap() {
  const status = await initializeStorage();
  console.log(status.enabled ? (status.ready ? 'PostgreSQL persistence is ready.' : 'PostgreSQL persistence is unavailable; match history will not be saved.') : 'DATABASE_URL not set; running without match-history persistence.');
  const redisStatus = await initializeRoomStore();
  console.log(redisStatus.enabled ? (redisStatus.ready ? 'Redis active-room recovery is ready.' : 'Redis unavailable; active rooms will remain memory-only.') : 'REDIS_URL not set; active rooms will remain memory-only.');
  const lease = await acquireServerLease();
  if (!lease.acquired) {
    throw new Error('Another CASH CLASH backend instance already owns the gameplay lease. Keep the backend at one instance until shared authoritative room state is implemented.');
  }
  console.log(lease.enabled ? 'Exclusive Redis gameplay lease acquired.' : 'Redis lease disabled; local single-process mode.');

  const adapterStatus = await initializeSocketAdapter(io);
  console.log(adapterStatus.enabled ? (adapterStatus.ready ? 'Socket.IO Redis adapter is ready for cross-instance broadcasts.' : 'Socket.IO Redis adapter is unavailable.') : 'REDIS_URL not set; Socket.IO is operating locally.');
  if (adapterStatus.enabled && !adapterStatus.ready) {
    throw new Error('Redis is configured but the Socket.IO Redis adapter could not initialize. Refusing to start with a misleading partial Redis setup.');
  }

  if (redisStatus.ready) {
    try {
      const savedRooms = await loadStoredRooms();
      for (const saved of savedRooms) {
        const room = { ...saved, matchId: saved.matchId || null, history: saved.history || [], privateIntel: saved.privateIntel || {}, awards: saved.awards || [], players: new Map((saved.players || []).map(player => [player.id, { ...player, connected: false, socketId: null, disconnectTimer: null }])), actions: new Map(saved.actions || []), timer: null };
        rooms.set(room.code, room);
        for (const player of room.players.values()) {
          player.disconnectTimer = setTimeout(() => { const current = rooms.get(room.code); if (current?.players.has(player.id) && !player.connected) removePlayer(current, player.id); }, RECONNECT_GRACE_MS);
        }
        // A process restart disconnects every socket. Never resolve a round
        // using stale actions from the previous process.
        if (room.status === 'playing' || room.status === 'reveal') {
          resetIncompleteGame(room);
          await persistRoom(room);
        }
      }
      console.log(`Restored ${savedRooms.length} room(s) from Redis.`);
    } catch (error) { console.error('Could not restore Redis rooms:', error.message); }
  }

  httpServer = server.listen(PORT, '0.0.0.0', () => console.log(`CASH CLASH server listening on ${PORT}`));
}
bootstrap().catch(async error => {
  console.error('CASH CLASH startup failed:', error);
  await closeSocketAdapter().catch(() => {});
  await closeStorage().catch(() => {});
  await closeRoomStore().catch(() => {});
  process.exitCode = 1;
});

async function shutdown(signal) {
  console.log(`${signal} received; shutting down CASH CLASH.`);
  for (const room of rooms.values()) clearTimer(room);
  if (io) io.close();
  await closeSocketAdapter().catch(error => console.error('Socket adapter shutdown error:', error.message));
  await closeStorage().catch(error => console.error('Database shutdown error:', error.message));
  await closeRoomStore().catch(error => console.error('Redis shutdown error:', error.message));
  if (httpServer) httpServer.close(() => process.exit(0)); else process.exit(0);
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

