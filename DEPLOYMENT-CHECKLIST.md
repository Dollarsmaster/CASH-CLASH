# CASH CLASH deployment checklist

## Required services

- Persistent Node.js backend host with WebSocket support.
- Managed Redis-compatible instance (required when `REDIS_URL` is configured; used for recovery, lease protection, round claims and Socket.IO adapter).
- Static frontend host.
- Optional PostgreSQL database for completed-match history.

## Backend environment

```env
PORT=3001
NODE_ENV=production
CLIENT_ORIGIN=https://YOUR-FRONTEND-DOMAIN
REDIS_URL=redis://USER:PASSWORD@HOST:PORT
DATABASE_URL=postgresql://USER:PASSWORD@HOST:PORT/DATABASE
DATABASE_SSL=true
```

`DATABASE_URL` is optional. `REDIS_URL` is strongly recommended for a hosted service so lobby rooms can be recovered after a restart. Keep the backend at one instance; the current architecture is not horizontally scalable.

## Frontend environment

```env
VITE_SERVER_URL=https://YOUR-BACKEND-DOMAIN
```

Build command: `npm run build --workspace client`  
Output directory: `client/dist`

## Launch verification

- [ ] Backend `/health` responds with HTTP 200.
- [ ] `database.ready` is true if PostgreSQL is configured.
- [ ] `redis.ready`, `redis.leaseHeld` and `socketAdapter.ready` are true if Redis is configured.
- [ ] `multiInstanceSafe` remains `false`; use one backend instance.
- [ ] Two separate devices can create/join the same room.
- [ ] Host can start the match and all clients see synchronized round transitions.
- [ ] Collect, steal, protect, timeout default and simultaneous reveal work.
- [ ] Disconnect/reconnect and host migration work.
- [ ] Match completion and rematch work.
- [ ] Restart recovery works for rooms saved in Redis.
- [ ] A malformed Redis room snapshot is skipped without preventing other valid rooms from restoring.
- [ ] Redis reconnects after a short network interruption and health status recovers only when the gameplay lease is still held.
- [ ] Reconnect test: reconnect a player quickly while the old socket is still closing; the old socket must not mark the new connection offline.
- [ ] Run `npm test` and `npm run build` successfully in the deployment environment.
- [ ] Completed match history is saved when PostgreSQL is enabled.

Do not advertise the game as production-ready until these checks have been completed against the actual deployed services.


## New gameplay feature checks

- Add one or more AI opponents in the lobby and start a match with only one human player.
- Verify Double Steal is awarded in round 3, can be used once, and is removed after use.
- Verify Spy is awarded in round 7 and privately reports the selected rival's previous-round action.
- Verify rounds 5 and 10 double collect and base steal payouts, and a successful steal against the pre-round leader adds the $50 bounty.
- Verify the round 10 reveal remains visible before the winner screen and awards are shown at the end.
- Open the same active room on another browser as a spectator; confirm actions are read-only and reactions appear for everyone.
- Test the invite URL on a fresh browser and confirm its room code is pre-filled.
- Test sound toggle, vibration support, reconnect banner, and mobile touch targets.
