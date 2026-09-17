// The whole room, held in Postgres as key/value rows (see _lib/store.js):
//   state           the phase machine
//   seat:<id>       { name, score, rounds, joinedAt, session }
//
// GET  /api/room                     -> { now, state, players }
// POST /api/room  { op: 'join' | 'ship' | 'state' | 'reset', ... }
//
// The host ops are token-gated: the page sits on a public URL, and without
// that check anyone with the link could skip scenarios or wipe the game.
// Join and ship stay open — both are harmless, and gating them would mean
// accounts.
//
// Scores are computed here from the player's picks, never taken from the
// client, so the leaderboard means something.

const crypto = require('crypto');
const G = require('../game.js');
const store = require('./_lib/store.js');

const MAX_PLAYERS = 40;
const MAX_NAME = 24;
const STATE_KEY = 'state';
const SEAT = 'seat:';
const ADMIN_OPS = new Set(['state', 'reset']);
// A ship that left the device just as the clock hit zero still counts.
const GRACE_MS = 5000;

function newId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function freshState() {
  return { phase: 'lobby', index: 0, startedAt: null, ended: false, session: newId() };
}

function isAdmin(supplied) {
  const expected = process.env.ADMIN_TOKEN;
  // No token configured means the host console is locked out, never wide open.
  if (!expected) return false;
  if (typeof supplied !== 'string' || !supplied.length) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw
    .split('')
    .filter((ch) => { const c = ch.charCodeAt(0); return c >= 32 && c !== 127; })
    .join('')
    .trim()
    .slice(0, MAX_NAME);
  return name.length ? name : null;
}

async function readRoom() {
  const rows = await store.readAll();
  let state = null;
  const players = [];
  for (const row of rows) {
    if (row.key === STATE_KEY) state = row.value;
    else if (row.key.startsWith(SEAT)) {
      players.push(Object.assign({ id: row.key.slice(SEAT.length), score: 0, rounds: {} }, row.value));
    }
  }
  players.sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
  // Before the host's first action there is no stored state. Synthesize one
  // WITHOUT a session id — freshState() mints a new one on every call, and a
  // session that changes every request reads to a player as a constant reset.
  if (!state) state = Object.assign(freshState(), { session: null });
  return { state: state, players: players };
}

function totalScore(rounds) {
  return Object.keys(rounds).reduce((sum, k) => sum + (rounds[k].score || 0), 0);
}

async function handle(method, body, admin) {
  if (method !== 'POST') return await readRoom();

  const op = body.op;
  if (ADMIN_OPS.has(op) && !admin) {
    const err = new Error('Host token required');
    err.status = 403;
    throw err;
  }

  if (op === 'join') {
    const name = cleanName(body.name);
    if (!name) throw new Error('A name is required to join');
    const room = await readRoom();

    // Same device coming back (refresh, locked screen) keeps its seat. So
    // does the same name from a new device — a room where everyone can see
    // each other does not need stronger identity than that, and the
    // alternative is a player locked out of their own score.
    const seat = (body.playerId && room.players.find((p) => p.id === body.playerId))
      || room.players.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (seat) {
      if (seat.name !== name) await store.put(SEAT + seat.id, Object.assign({}, seat, { name: name }));
      return { playerId: seat.id, name: name };
    }

    if (room.players.length >= MAX_PLAYERS) throw new Error('This room is full');
    const id = newId();
    await store.put(SEAT + id, {
      name: name,
      score: 0,
      rounds: {},
      joinedAt: Date.now(),
      session: room.state.session || newId(),
    });
    return { playerId: id, name: name };
  }

  if (op === 'ship') {
    const room = await readRoom();
    const player = room.players.find((p) => p.id === body.playerId);
    if (!player) throw new Error('You are not in this room any more — rejoin');

    const state = room.state;
    const index = Number(body.index);
    if (state.phase !== 'round' || index !== state.index) throw new Error('That round is not open');
    if (player.rounds[String(index)]) return { ok: true, already: true };
    // The clock closing is what ends a round, but the ship that was already
    // on its way when it closed still counts — that is what GRACE_MS buys.
    const deadline = state.ended
      ? (state.endedAt || 0) + GRACE_MS
      : (state.startedAt || 0) + G.ROUND_SECONDS * 1000 + GRACE_MS;
    if (Date.now() > deadline) throw new Error('Time is up for this round');

    const scenario = G.SCENARIOS[index];
    const picks = Array.isArray(body.round && body.round.picks) ? body.round.picks.filter((id) => G.byId[id]) : [];
    if (G.cost(picks) > G.BUDGET) throw new Error('That costs more than the sprint budget');

    // Scored here from the picks — the client's own number is never trusted.
    const r = G.scoreRound(scenario, picks);
    const rounds = Object.assign({}, player.rounds);
    rounds[String(index)] = {
      picks: r.picks, score: r.score, spent: r.spent, grade: r.grade,
      pass: r.pass, green: r.green, onTarget: r.onTarget,
    };
    const seat = Object.assign({}, player, { rounds: rounds, score: totalScore(rounds) });
    delete seat.id; // the id is the row key, not a field
    await store.put(SEAT + player.id, seat);
    return await readRoom();
  }

  if (op === 'state') {
    const room = await readRoom();
    const state = Object.assign(room.state, body.patch || {}, { session: room.state.session || newId() });
    // Both clocks are stamped here so every device measures one clock.
    if (state.startedAt === 'now') state.startedAt = Date.now();
    state.endedAt = state.ended ? state.endedAt || Date.now() : null;
    await store.put(STATE_KEY, state);
    return { state: state, players: room.players };
  }

  if (op === 'reset') {
    await store.deleteAll();
    const state = freshState();
    await store.put(STATE_KEY, state);
    return { state: state, players: [] };
  }

  throw new Error('Unknown op: ' + op);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (!store.isConfigured && !store.allowMemory) {
    res.status(503).json({
      error: 'No database connected. Add Postgres under Storage in the Vercel project so DATABASE_URL is set, then redeploy.',
    });
    return;
  }

  try {
    let body = {};
    if (req.method === 'POST') {
      body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    }
    const admin = isAdmin(req.headers && req.headers['x-admin-token']);
    const out = await handle(req.method, body, admin);
    res.status(200).json(Object.assign({ now: Date.now() }, out));
  } catch (e) {
    // Connection failures surface as "AggregateError" with no message, which
    // tells the host nothing. Name the likely cause instead.
    const raw = String((e && e.message) || e);
    const dbDown = e && (e.name === 'AggregateError'
      || ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET'].includes(e.code));
    if (dbDown) console.error('[gauntlet] database unreachable');
    res.status(e && e.status ? e.status : dbDown ? 503 : 400).json({
      error: dbDown ? 'Cannot reach the database right now — retrying shortly' : raw,
    });
  }
};
