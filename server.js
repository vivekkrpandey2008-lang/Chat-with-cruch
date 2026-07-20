const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const { Pool } = require('pg');

const app = express();
app.use(express.static(__dirname));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ---------- database ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      code TEXT PRIMARY KEY,
      slot1_device TEXT,
      slot2_device TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS slot1_name TEXT;`);
  await pool.query(`ALTER TABLE rooms ADD COLUMN IF NOT EXISTS slot2_name TEXT;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      started_at TIMESTAMPTZ DEFAULT now(),
      closed_at TIMESTAMPTZ
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      code TEXT NOT NULL,
      session_id TEXT NOT NULL,
      sender_slot INTEGER NOT NULL,
      iv TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_code ON sessions(code);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);`);
  console.log('Database ready.');
}
initDb().catch((e) => console.error('DB init failed:', e.message));

// ---------- helpers ----------
const CODE_RE = /^#[a-z0-9_]{2,24}$/;

function normalizeCode(raw) {
  let c = String(raw || '').trim().toLowerCase();
  if (c && !c.startsWith('#')) c = '#' + c;
  return c;
}

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// In-memory bookkeeping (fast path) - source of truth for data is Postgres.
const liveSockets = new Map();    // code -> { 1: ws|null, 2: ws|null }
const activeSessions = new Map(); // code -> session_id currently live

function registerLive(code, slot, ws) {
  if (!liveSockets.has(code)) liveSockets.set(code, { 1: null, 2: null });
  liveSockets.get(code)[slot] = ws;
}
function unregisterLive(code, slot, ws) {
  const entry = liveSockets.get(code);
  if (entry && entry[slot] === ws) entry[slot] = null;
}
function getPeerSocket(code, slot) {
  const entry = liveSockets.get(code);
  if (!entry) return null;
  return slot === 1 ? entry[2] : entry[1];
}
function bothOnline(code) {
  const entry = liveSockets.get(code);
  return !!(entry && entry[1] && entry[2]);
}

// Claim slot 1 or 2 for this device on this code, saving/updating its display name.
async function claimSlot(code, deviceId, name) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let res = await client.query('SELECT * FROM rooms WHERE code = $1 FOR UPDATE', [code]);

    if (res.rows.length === 0) {
      await client.query(
        'INSERT INTO rooms (code, slot1_device, slot1_name) VALUES ($1, $2, $3)',
        [code, deviceId, name]
      );
      await client.query('COMMIT');
      return { slot: 1 };
    }

    const room = res.rows[0];
    if (room.slot1_device === deviceId) {
      await client.query('UPDATE rooms SET slot1_name = $1 WHERE code = $2', [name, code]);
      await client.query('COMMIT');
      return { slot: 1 };
    }
    if (room.slot2_device === deviceId) {
      await client.query('UPDATE rooms SET slot2_name = $1 WHERE code = $2', [name, code]);
      await client.query('COMMIT');
      return { slot: 2 };
    }
    if (!room.slot1_device) {
      await client.query('UPDATE rooms SET slot1_device = $1, slot1_name = $2 WHERE code = $3', [deviceId, name, code]);
      await client.query('COMMIT');
      return { slot: 1 };
    }
    if (!room.slot2_device) {
      await client.query('UPDATE rooms SET slot2_device = $1, slot2_name = $2 WHERE code = $3', [deviceId, name, code]);
      await client.query('COMMIT');
      return { slot: 2 };
    }

    await client.query('ROLLBACK');
    return { slot: null };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function getRoomNames(code) {
  const res = await pool.query('SELECT slot1_name, slot2_name FROM rooms WHERE code = $1', [code]);
  if (res.rows.length === 0) return { 1: null, 2: null };
  return { 1: res.rows[0].slot1_name, 2: res.rows[0].slot2_name };
}

async function maybeStartSession(code) {
  if (!bothOnline(code)) return;
  if (activeSessions.has(code)) return;

  const existing = await pool.query(
    "SELECT id FROM sessions WHERE code = $1 AND status = 'active' LIMIT 1",
    [code]
  );

  let sessionId;
  if (existing.rows.length > 0) {
    sessionId = existing.rows[0].id;
  } else {
    sessionId = crypto.randomUUID();
    await pool.query('INSERT INTO sessions (id, code) VALUES ($1, $2)', [sessionId, code]);
  }
  activeSessions.set(code, sessionId);

  const entry = liveSockets.get(code);
  send(entry[1], { type: 'session-started' });
  send(entry[2], { type: 'session-started' });
}

async function endSession(code, reason) {
  const sessionId = activeSessions.get(code);
  if (!sessionId) return;
  activeSessions.delete(code);
  await pool.query(
    "UPDATE sessions SET status = 'closed', closed_at = now() WHERE id = $1",
    [sessionId]
  );
  const entry = liveSockets.get(code);
  if (entry) {
    send(entry[1], { type: 'session-closed', reason });
    send(entry[2], { type: 'session-closed', reason });
  }
}

async function fetchHistory(code) {
  const names = await getRoomNames(code);
  const sessions = await pool.query(
    "SELECT id, started_at, closed_at FROM sessions WHERE code = $1 AND status = 'closed' ORDER BY started_at DESC LIMIT 100",
    [code]
  );
  const out = [];
  for (const s of sessions.rows) {
    const msgs = await pool.query(
      'SELECT sender_slot, iv, ciphertext, created_at FROM messages WHERE session_id = $1 ORDER BY created_at ASC',
      [s.id]
    );
    out.push({
      id: s.id,
      startedAt: s.started_at,
      closedAt: s.closed_at,
      messages: msgs.rows.map((m) => ({
        slot: m.sender_slot,
        iv: m.iv,
        ct: m.ciphertext,
        at: m.created_at,
      })),
    });
  }
  return { names, sessions: out };
}

// ---------- websocket protocol ----------
wss.on('connection', (ws) => {
  ws.code = null;
  ws.slot = null;
  ws.deviceId = null;
  ws.name = null;

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }

    if (msg.type === 'enter') {
      const code = normalizeCode(msg.code);
      const deviceId = String(msg.deviceId || '').slice(0, 80);
      const name = String(msg.name || '').trim().slice(0, 30) || 'Anonymous';

      if (!CODE_RE.test(code)) {
        send(ws, { type: 'error', message: 'Code # ke saath likho, jaise #love79 (3-20 letters/numbers).' });
        return;
      }
      if (!deviceId) {
        send(ws, { type: 'error', message: 'Device pehchan nahi ho payi. Page reload karo.' });
        return;
      }

      try {
        const { slot } = await claimSlot(code, deviceId, name);
        if (!slot) {
          send(ws, { type: 'error', message: 'Ye code pehle hi do logo ke beech use ho raha hai.' });
          return;
        }
        ws.code = code;
        ws.slot = slot;
        ws.deviceId = deviceId;
        ws.name = name;
        registerLive(code, slot, ws);

        const names = await getRoomNames(code);
        const peerName = slot === 1 ? names[2] : names[1];

        send(ws, {
          type: 'entered',
          code,
          slot,
          peerOnline: bothOnline(code),
          peerName: peerName || null,
          myName: name,
        });

        const peer = getPeerSocket(code, slot);
        send(peer, { type: 'peer-status', online: true, name });

        await maybeStartSession(code);
      } catch (e) {
        console.error(e);
        send(ws, { type: 'error', message: 'Kuch galat ho gaya, dobara try karo.' });
      }
      return;
    }

    if (!ws.code) return; // must 'enter' before anything else

    if (msg.type === 'message') {
      const sessionId = activeSessions.get(ws.code);
      if (!sessionId) {
        send(ws, { type: 'error', message: 'Dono log abhi online nahi hain, message nahi bhej sakte.' });
        return;
      }
      try {
        await pool.query(
          'INSERT INTO messages (code, session_id, sender_slot, iv, ciphertext) VALUES ($1,$2,$3,$4,$5)',
          [ws.code, sessionId, ws.slot, msg.iv, msg.ct]
        );
      } catch (e) {
        console.error('message save failed', e.message);
      }
      const peer = getPeerSocket(ws.code, ws.slot);
      send(peer, { type: 'chat', slot: ws.slot, iv: msg.iv, ct: msg.ct });
      return;
    }

    if (msg.type === 'leave') {
      await endSession(ws.code, 'left');
      return;
    }

    if (msg.type === 'history') {
      try {
        const data = await fetchHistory(ws.code);
        send(ws, { type: 'history-data', names: data.names, sessions: data.sessions });
      } catch (e) {
        console.error(e);
        send(ws, { type: 'error', message: 'History load nahi ho payi.' });
      }
      return;
    }
  });

  ws.on('close', async () => {
    if (!ws.code) return;
    unregisterLive(ws.code, ws.slot, ws);
    const peer = getPeerSocket(ws.code, ws.slot);
    send(peer, { type: 'peer-status', online: false });
    try {
      await endSession(ws.code, 'disconnected');
    } catch (e) {
      console.error(e);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Sealed chat server running on port ${PORT}`);
});
