# CASH CLASH

A real-time browser strategy game for 2–8 players. No accounts or downloads are required.

## What's included

- Premium responsive dark emerald / gold interface
- Create and join rooms with six-character room codes
- Player names, avatars, lobby and host-controlled start
- 10 rounds with a server-controlled 15-second timer
- Secret action submission and simultaneous reveal
- Server-authoritative balance and action resolution
- Collect (+$100), targeted steal (up to $150 transferred), protect (blocks all incoming steals)
- Jackpot payouts on rounds 5 and 10, plus a $50 bounty for stealing from the current leader
- One-use Double Steal (round 3) and Spy (round 7) power-ups
- Recent move history, reveal animations, sound/haptic feedback, and emoji reactions
- Add AI opponents for solo testing, plus spectator mode for active matches
- Final awards for most steals, most blocked, and biggest swing
- Shareable room invite links with the room code pre-filled
- Live leaderboard, final winner screen and host-controlled rematch
- 60-second reconnect grace period and host migration
- Health endpoint at `/health`

## Run locally

Requirements: Node.js 20+ and npm.

```bash
npm install
npm run dev
```

Open `http://localhost:5173` in multiple browser tabs or devices on the same network. For another device on the same LAN, use the computer's LAN IP for the Vite page and set `VITE_SERVER_URL` to the server's LAN address.

Build the frontend:

```bash
npm run build
```

Start the backend:

```bash
npm start
```

## Tests

Run the server game-engine unit tests (no external services required):

```bash
npm test
```

The tests cover default actions, multiple targeted steals, protection, insufficient target funds, collect timing, jackpot payouts, leader bounties, one-use power-ups, award calculation, Redis room-snapshot validation, unique round-resolution identity across rematches, input sanitization, and stale-socket reconnect handling.

## Environment

Backend (`server/.env` or hosting environment):

```env
PORT=3001
CLIENT_ORIGIN=https://your-frontend-domain.example
```

Frontend (`client/.env`):

```env
VITE_SERVER_URL=https://your-backend-domain.example
```

The frontend should be deployed as a static Vite site. Deploy the Node server as a persistent WebSocket-capable service. Configure the frontend origin in `CLIENT_ORIGIN` and the backend URL in `VITE_SERVER_URL`.

## Database setup (optional)

CASH CLASH can save completed match records to PostgreSQL. Set `DATABASE_URL` in the backend environment; the server creates the `cash_clash_matches` table and its date index automatically. Set `DATABASE_SSL=true` for hosted databases that require TLS (the default), or `false` for a trusted local database. If no `DATABASE_URL` is configured, the game continues to run without match-history storage. The `/health` endpoint reports database readiness and returns HTTP 503 if a configured database cannot initialize.

## Important production note

Live room mutations are held in one authoritative server process, with serialized Redis snapshots for restart recovery. PostgreSQL stores completed match history. The Socket.IO Redis adapter distributes Socket.IO broadcasts/server-side events, but it does NOT make the in-memory game state shared or provide distributed room ownership/atomic round resolution. A Redis lease prevents a second backend from starting gameplay. Therefore, run exactly one backend instance for live gameplay. Do not scale the backend horizontally until authoritative room state and atomic round transitions are moved into a coordinated shared store. Serverless functions are not suitable for this long-lived Socket.IO game server. If Redis is configured but unavailable, startup fails closed rather than silently running with an incomplete Redis configuration. If PostgreSQL is configured but unavailable, the health endpoint reports HTTP 503. Frontend dependency installation and production build must be verified in the deployment environment before launch.

## Game resolution details

- Missing action at the 15-second deadline defaults to COLLECT.
- A steal transfers up to $150 from the selected opponent; rounds 5 and 10 double the standard collect and steal payouts.
- Stealing from the pre-round leader earns an additional $50 bounty for each successful attacker.
- Each player receives a one-use Double Steal power-up in round 3 and a one-use Spy power-up in round 7. Spy reveals the selected rival's previous-round action privately to the player who used it.
- A target who chose PROTECT cannot be stolen from that round.
- Multiple successful attackers share the target's available balance proportionally to the size of their requests if the target cannot cover all requests.
- Collect rewards are applied after steal transfers, so cash collected in a round cannot be stolen during that same round.
- If all connected players and AI opponents have submitted, the server resolves early; otherwise the deadline resolves the round.
- Hosts can add AI opponents in the lobby; active matches can be watched in read-only spectator mode. Reactions are cosmetic and do not affect balances.
- If fewer than two participants remain connected mid-game (AI opponents count as participants), the match resets safely to the lobby rather than silently awarding a win.

## Redis active-room recovery (optional)

Set `REDIS_URL` to a Redis connection URL to persist active room snapshots. Room snapshots are refreshed whenever the server broadcasts a room update and expire after 24 hours. After a backend restart, saved rooms are loaded so players can reconnect using the room code and the player ID already stored in their browser. Since a process restart disconnects every socket, an in-progress round is safely reset to the lobby rather than resolving actions from players who are no longer connected. Completed match history remains in PostgreSQL.

Redis snapshot persistence improves recovery for a **single authoritative backend instance**. The Socket.IO Redis adapter is enabled when `REDIS_URL` is configured and distributes Socket.IO broadcasts between instances, but it does not synchronize the in-memory room maps. Keep exactly one backend instance until distributed room ownership, shared authoritative room state, and atomic round resolution are implemented. Redis is optional for local development.


## Socket.IO Redis adapter

When `REDIS_URL` is configured, the server also initializes the official Socket.IO Redis adapter using dedicated Redis pub/sub connections. This is a prerequisite for cross-instance Socket.IO broadcasts and is reported by `/health` under `socketAdapter`. It is not, by itself, safe multi-instance gameplay: room objects, player balances, action submissions, and round timers are still authoritative only inside one Node.js process. Do not increase the backend instance count yet. The next backend milestone is moving room ownership and all state transitions into Redis with atomic scripts/transactions and a lease/fencing strategy.

## Single-owner gameplay lease and round idempotency

When Redis is configured, the backend now acquires an exclusive 30-second server lease before it starts listening. The lease is renewed every 10 seconds using a token-checked Redis Lua script. If another backend already owns the lease, startup fails rather than allowing two processes to mutate separate in-memory copies of the same game. If lease renewal fails or ownership is lost, the process exits fail-closed. Round resolution also uses a Redis `SET NX` claim keyed by room code, a unique match ID, and round number, plus an in-process guard, to prevent duplicate resolution attempts. The unique match ID prevents a completed match's old round-1 claim from blocking round 1 after a rematch in the same room. These safeguards make the current single-process architecture safer; they do **not** make it horizontally scalable. Authoritative room state and all mutations still need to move into Redis (or another transactional shared store) before multiple game servers can serve the same rooms.


## Rematch idempotency fix (October 2026)

Each newly started match receives a fresh UUID match ID, which is persisted in the Redis room snapshot. Redis round-resolution claims include this match ID as well as the room code and round number. This prevents stale claims from a previous game in the same room from blocking a later rematch. Automated tests verify that claim keys differ across matches and rounds. This is an idempotency fix for the current single-owner server; it does not enable multi-instance authoritative gameplay.

## Security and input hardening

The Socket.IO server applies per-connection event throttling, stricter room create/join attempt limits, a 16 KiB maximum event payload, and basic HTTP security headers. Player names are normalized and bounded, room codes are normalized, and avatar indexes are clamped to the eight supported avatars. These controls reduce abuse but are not a substitute for a managed WAF, abuse monitoring, or application-level moderation for a public launch.

## Deployment checklist

### Backend (Render or another persistent Node host)

1. Deploy the `server` directory as a persistent Node.js web service (not a serverless function).
2. Set `CLIENT_ORIGIN` to the exact deployed frontend origin, without a trailing slash. Multiple comma-separated origins are supported.
3. Set `REDIS_URL` to a managed Redis-compatible service. Redis is used for room snapshots, the exclusive single-server gameplay lease, round-resolution claims, and Socket.IO pub/sub.
4. Optionally set `DATABASE_URL` for PostgreSQL match history. Set `DATABASE_SSL=true` for hosted TLS databases.
5. Keep the service at exactly **one instance**. The current authoritative room map and round timers are still process-local. The Redis adapter distributes Socket.IO broadcasts but does not make game state multi-instance safe.
6. Confirm `/health` returns HTTP 200 and shows configured dependencies as ready.

### Frontend (Vercel or another static host)

1. Set the project root/build context to the repository root.
2. Build command: `npm run build --workspace client`.
3. Output directory: `client/dist`.
4. Set `VITE_SERVER_URL` to the backend's public HTTPS origin (for example, `https://your-api.example.com`).
5. Set the backend `CLIENT_ORIGIN` to the deployed frontend origin, redeploy the backend, then redeploy the frontend.

### Before inviting players

- Test create/join from at least two separate devices and networks.
- Test all core actions, jackpot rounds, power-ups, AI opponents, spectator mode, reactions, the 15-second deadline, reconnects, host migration, all ten rounds, final reveal, awards, and rematch.
- Restart the backend while a room is in the lobby and verify that players can reconnect from the saved room code/player ID.
- Verify PostgreSQL match history if database persistence is enabled.
- Review hosting logs and `/health` during a test session.

## Current release limitations

This repository is a deployable **single-backend-instance release candidate**, not a verified public production launch. This environment does not have your hosting accounts, Redis URL, PostgreSQL URL, or DNS configuration, so hosted connectivity, deployment, and real multi-device internet tests cannot be performed here. Horizontal scaling is intentionally disabled by the Redis server lease and `/health` reports `multiInstanceSafe: false`. True multi-instance authoritative state, distributed timers, and cross-instance atomic round transitions remain future engineering work. Do not remove the lease or scale backend instances until those features have been implemented and load-tested.

## Latest hardening changes

- Prevented an old socket's delayed disconnect event from marking a player's newer reconnect as offline.
- Serialized Redis room snapshot writes per room so delayed writes cannot overwrite newer room state.
- Made room deletion wait for pending snapshot writes.
- Added retry scheduling for transient round-resolution claim failures.
- Added startup cleanup when configured dependencies fail to initialize.
- Health checks now include uptime and require the Redis gameplay lease when Redis is configured.
- Redis reconnect events restore connection-readiness reporting after transient outages; lease ownership remains a separate health requirement.
- Room recovery reads Redis keys in bounded batches and skips/deletes malformed snapshots instead of allowing one corrupt room to block recovery of every other room.
- Added room-snapshot schema validation and automated tests for malformed JSON, invalid status/code, missing collections, invalid player data, over-capacity snapshots, and persisted power-ups/history.
- Added jackpot rounds 5 and 10, one-use Double Steal and Spy power-ups, a leader bounty, recent move history, animated reveal, sound/haptic cues, emoji reactions, AI opponents, spectator mode, reconnect banners, and end-of-match awards.
