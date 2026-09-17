// Local dry-run server: node dev.js  ->  http://localhost:3000
//
// Mirrors how Vercel serves this project — static files from the repo
// root, /api/room through the function — so a rehearsal behaves like the
// real deployment. Not used in production.
//
// With no DATABASE_URL it keeps the game in memory, so you can play a full
// game locally with zero setup. Drop a .env next to this file with the
// DATABASE_URL Vercel injects to rehearse against real Prisma Postgres.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

// ---- .env / .env.local, if present -------------------------------------
for (const file of ['.env', '.env.local']) {
  try {
    for (const line of fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    console.log('Loaded ' + file);
  } catch (e) {
    /* not there — fine */
  }
}

if (!process.env.ADMIN_TOKEN) {
  process.env.ADMIN_TOKEN = 'dev';
  console.log('ADMIN_TOKEN not set — using "dev" for this run');
}

// A single long-lived process, so the in-memory store is safe here in a way
// it never is on serverless — the handler refuses it unless asked.
process.env.GAUNTLET_ALLOW_MEMORY = '1';
if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
  console.log('No DATABASE_URL — keeping this game in memory');
} else {
  console.log('Using Postgres from DATABASE_URL');
}

const room = require('./api/room.js');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

    if (url.pathname === '/api/room') {
      req.body = req.method === 'POST' ? await readBody(req) : '';
      req.query = Object.fromEntries(url.searchParams);
      res.status = (code) => {
        res.statusCode = code;
        return res;
      };
      res.json = (payload) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(payload));
      };
      return room(req, res);
    }

    // Vercel reserves api/ for functions — never serve it as static.
    if (url.pathname.startsWith('/api')) {
      res.statusCode = 404;
      return res.end('Not found');
    }

    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT)) {
      res.statusCode = 403;
      return res.end('Forbidden');
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.statusCode = 404;
        return res.end('Not found');
      }
      res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store');
      res.end(buf);
    });
  })
  .listen(PORT, () => {
    console.log('');
    console.log('  Players  http://localhost:' + PORT + '/');
    console.log('  Host     http://localhost:' + PORT + '/#admin   (token: ' + process.env.ADMIN_TOKEN + ')');
    console.log('');
  });
