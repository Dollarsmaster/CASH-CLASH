# CASH CLASH — Gameplay upgrade release

## New gameplay systems

- Round 5 and round 10 are jackpot rounds. Collect pays $200 and the standard steal amount is $300.
- A successful steal against the player who was leading before the round pays the attacker an extra $50 bounty.
- Every player receives a one-use Double Steal power-up at the start of round 3 and a one-use Spy power-up at the start of round 7.
- Double Steal doubles the base steal request and is consumed when used. If several attackers target a player with insufficient cash, the available balance is allocated proportionally to each attack request.
- Spy is a non-cash action. It privately reveals the selected rival's action from the previous completed round and consumes the Spy power-up.
- The last three completed rounds are shown as public rival memory after reveal.

## Multiplayer and presentation

- Room hosts can add AI opponents in the lobby. Bots use a lightweight randomized strategy and submit actions before the round deadline.
- Spectators can join an already-running match in read-only mode and send emoji reactions.
- Invite links use `/?room=ROOMCODE`, pre-filling the join-code field.
- Reconnection banners identify players currently within the 60-second reconnect grace period.
- Round reveals animate player action cards and result events sequentially. The round 10 reveal is displayed for 4.5 seconds before the winner screen.
- Sound effects are synthesized in the browser and can be toggled. Supported devices also receive vibration feedback.
- The final screen shows awards for most successful steals, most blocked incoming attacks, and biggest single-round balance swing.
- Mobile action cards use a two-column layout and larger touch targets.

## Verification performed

- `npm test`: 25 tests passed.
- Server JavaScript syntax checks: passed.
- Frontend JSX syntax transpilation using the available TypeScript compiler: passed.
- CSS parse validation: passed.
- `npm install` timed out in this environment, so `vite` is unavailable and `npm run build` could not complete. A real browser build and multiplayer session still need to be verified after dependencies are installed.
- Live Redis/PostgreSQL connectivity and public deployment have not been tested.

## Deployment safety

Keep one backend instance. Redis room snapshots and the Socket.IO Redis adapter do not yet make authoritative room state safe across multiple backend instances. The existing server lease remains in place to prevent accidental horizontal scaling.
