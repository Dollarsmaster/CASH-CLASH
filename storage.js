import crypto from 'node:crypto';

let pool = null;
let ready = false;
let initError = null;

export async function initializeStorage() {
  if (!process.env.DATABASE_URL) return { enabled: false, ready: false };
  try {
    const { Pool } = await import('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
      max: Number(process.env.DB_POOL_SIZE || 5),
      connectionTimeoutMillis: 5000,
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cash_clash_matches (
        id UUID PRIMARY KEY,
        room_code VARCHAR(6) NOT NULL,
        played_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        rounds_completed INTEGER NOT NULL,
        winner JSONB,
        players JSONB NOT NULL,
        results JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cash_clash_matches_played_at_idx
        ON cash_clash_matches (played_at DESC);
    `);
    ready = true;
    return { enabled: true, ready: true };
  } catch (error) {
    initError = error.message;
    console.error('PostgreSQL initialization failed:', error.message);
    return { enabled: true, ready: false, error: error.message };
  }
}

export function storageStatus() {
  return {
    enabled: Boolean(process.env.DATABASE_URL),
    ready,
    error: initError,
  };
}

export async function saveCompletedMatch({ roomCode, roundsCompleted, winner, players, results }) {
  if (!pool || !ready) return { saved: false, reason: 'database-not-ready' };
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO cash_clash_matches
      (id, room_code, rounds_completed, winner, players, results)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb)`,
    [id, roomCode, roundsCompleted, JSON.stringify(winner), JSON.stringify(players), JSON.stringify(results)],
  );
  return { saved: true, id };
}

export async function closeStorage() {
  if (pool) await pool.end();
}
