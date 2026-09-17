// Key/value rows on Prisma Postgres, reached with plain `pg` over the
// pooled TCP endpoint — no Prisma Client, no schema.prisma, no migrations.
// The table creates itself on first use.
//
// One row per writer, exactly as the Redis hash fields were, so two
// players committing at the same moment never clobber each other:
//   state              the phase machine
//   seat:<playerId>    { name, score, hand[] }
//   play:<round>:<id>  { round, playerId, cardId }
//
// Rows older than SESSION_HOURS are ignored on read, so a game nobody
// reset is simply gone by the next meeting rather than lingering.

const SESSION_HOURS = 6;

const CONNECTION = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';

/** Production must not silently fall back to a per-instance memory store —
 *  on serverless that would mean state vanishing between requests. */
const isConfigured = Boolean(CONNECTION);
const allowMemory = process.env.GAUNTLET_ALLOW_MEMORY === '1';

let impl = null;

function memoryStore() {
  const rows = new Map();
  return {
    async readAll() {
      return [...rows.entries()].map(([key, value]) => ({ key, value }));
    },
    async putMany(entries) {
      for (const [key, value] of entries) rows.set(key, value);
    },
    async deletePrefix(prefix) {
      for (const key of [...rows.keys()]) if (key.startsWith(prefix)) rows.delete(key);
    },
    async deleteAll() {
      rows.clear();
    },
  };
}

function pgStore() {
  const { Pool } = require('pg');
  // One connection per warm function instance; Prisma's pooled endpoint
  // does the real pooling on its side.
  const pool = new Pool({
    connectionString: CONNECTION,
    max: 1,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 8000,
  });

  // pg emits 'error' on the POOL when an idle connection dies — a database
  // restart, a dropped network link, or the provider recycling a pooled
  // connection. With no listener Node treats it as an unhandled 'error'
  // event and kills the process, taking the whole game down with it. Log it
  // and carry on; the next query opens a fresh connection.
  pool.on('error', (err) => {
    console.error('[gauntlet] idle database connection dropped:', err && err.message);
  });

  let ready = null;
  const ensureTable = () => {
    if (!ready) {
      ready = pool.query(
        'CREATE TABLE IF NOT EXISTS game_kv (' +
          'key TEXT PRIMARY KEY, ' +
          'value JSONB NOT NULL, ' +
          'updated_at TIMESTAMPTZ NOT NULL DEFAULT now())',
      );
    }
    return ready;
  };

  const query = async (text, params) => {
    await ensureTable();
    return pool.query(text, params);
  };

  return {
    async readAll() {
      const res = await query(
        "SELECT key, value FROM game_kv WHERE updated_at > now() - ($1 || ' hours')::interval",
        [String(SESSION_HOURS)],
      );
      return res.rows;
    },

    async putMany(entries) {
      if (!entries.length) return;
      // One statement for the whole batch — dealing rewrites every hand at
      // once and should not cost one round trip per player.
      const values = [];
      const params = [];
      entries.forEach(([key, value], i) => {
        values.push('($' + (i * 2 + 1) + ', $' + (i * 2 + 2) + '::jsonb)');
        params.push(key, JSON.stringify(value));
      });
      await query(
        'INSERT INTO game_kv (key, value) VALUES ' +
          values.join(', ') +
          ' ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
        params,
      );
    },

    async deletePrefix(prefix) {
      await query('DELETE FROM game_kv WHERE key LIKE $1', [prefix.replace(/[%_]/g, '\\$&') + '%']);
    },

    async deleteAll() {
      await query('DELETE FROM game_kv');
    },
  };
}

function store() {
  if (!impl) impl = isConfigured ? pgStore() : memoryStore();
  return impl;
}

module.exports = {
  isConfigured,
  allowMemory,
  readAll: () => store().readAll(),
  put: (key, value) => store().putMany([[key, value]]),
  putMany: (entries) => store().putMany(entries),
  deletePrefix: (prefix) => store().deletePrefix(prefix),
  deleteAll: () => store().deleteAll(),
};
