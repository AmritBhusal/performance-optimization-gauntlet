# Fix My Site — The Performance Gauntlet

A live, multiplayer web-performance exercise for a standup session. The host
projects the console and opens one broken site at a time; everyone else joins
by QR on their own phone, reads the brief, spends a sprint budget on
optimizations, and watches Core Web Vitals move.

Five scenarios, 12 story points each, 90 seconds each. No "next" button for
players — the host drives the room.

## Running it

```
npm install
npm run dev          # http://localhost:3000
```

- Players: `http://localhost:3000/` (or `#join` to skip the QR screen)
- Host: `http://localhost:3000/#admin` — token `dev` locally

With no `DATABASE_URL` the room is kept in memory, which is fine for a
rehearsal on one machine. `.env` / `.env.local` are loaded if present, so a
`DATABASE_URL` pulled from Vercel rehearses against the real database.

`npm test` re-checks the game balance (below).

## Deploying

Static files plus one function (`api/room.js`), so a plain Vercel import
works. It needs two environment variables:

| Variable | What it is |
|---|---|
| `DATABASE_URL` | Postgres connection string (Neon/Vercel Postgres; `POSTGRES_URL` also works). The table creates itself. |
| `ADMIN_TOKEN` | Host password. **Without it the host console is locked out entirely** — that is deliberate, the page is on a public URL. |

The host opens `/#admin`, pastes the token into the console once (it is kept
in that browser's localStorage) and runs the game.

## How the room works

`api/room.js` holds two kinds of row in Postgres: `state` (the phase machine)
and one `seat:<id>` per player. One row per writer, so two players shipping at
the same moment never clobber each other. Everything expires after six hours,
so an abandoned room is gone by the next meeting.

Every client polls `/api/room` every 1.5s. The round clock is the server's
stamp, so all the phones agree on when time is up. Scores are computed on the
server from the player's picks — the client's own number is never trusted.

Host-only operations (`state`, `reset`) require the `x-admin-token` header.
Joining and shipping are open.

## How scoring works

Each scenario is worth **100 points**, and every one of them is explained on
the result screen:

- **25 points each for LCP, INP and CLS** — awarded in proportion to how much
  of the gap between the broken value and Google's "good" threshold the player
  closed (LCP ≤ 2.5s, INP ≤ 200ms, CLS ≤ 0.10). Overshooting a threshold earns
  nothing extra; green is green.
- **+15 when all three land green** — the page now passes Core Web Vitals.
- **+10 × unspent SP / 12 for efficiency**, paid *only* on a page that passes.
  A fix nobody can afford is not a fix.
- Page weight is displayed because it explains the other three. It is not
  scored, the same way Google does not score it.

Grades read off one band table, used for a single round and for the final
total alike: **S** 90+, **A** 75+, **B** 60+, **C** 40+, **D** below. So an
"A" means the same thing in round 2 as it does at the end.

An optimization that does not address *this* site's problem still works, at
**40% strength**. Reading the brief is the game: buying the expensive-looking
cards on every site scores D–C, while the right 8–10 SP of fixes scores S.
`npm test` brute-forces all 148,134 legal pick combinations per scenario and
asserts both of those stay true.

## Files

```
index.html        every screen: QR, join, lobby, round, result, final, host
styles.css
game.js           scenarios, optimization cards, and all the scoring rules
app.js            polling, rendering, the host console
api/room.js       the room: join / ship / state / reset
api/_lib/store.js key-value rows on Postgres, table included
dev.js            local server that mirrors how Vercel serves this
test-scoring.js   game-balance check
```
