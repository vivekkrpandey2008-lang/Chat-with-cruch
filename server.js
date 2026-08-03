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
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      code TEXT NOT NULL,
      sender_slot INTEGER NOT NULL,
      iv TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  // Older deployments had a session_id column - drop it, we no longer use sessions.
  await pool.query(`ALTER TABLE messages DROP COLUMN IF EXISTS session_id;`);
  await pool.query(`DROP TABLE IF EXISTS sessions;`);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_code ON messages(code);`);
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

// In-memory bookkeeping of who is currently connected for each code.
const liveSockets = new Map(); // code -> { 1: ws|null, 2: ws|null }

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
function isPeerOnline(code, slot) {
  const entry = liveSockets.get(code);
  if (!entry) return false;
  return slot === 1 ? !!entry[2] : !!entry[1];
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

async function fetchMessages(code) {
  const res = await pool.query(
    'SELECT id, sender_slot, iv, ciphertext, created_at FROM messages WHERE code = $1 ORDER BY created_at ASC LIMIT 1000',
    [code]
  );
  return res.rows.map((m) => ({
    id: m.id,
    slot: m.sender_slot,
    iv: m.iv,
    ct: m.ciphertext,
    at: m.created_at,
  }));
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
        const messages = await fetchMessages(code);

        send(ws, {
          type: 'entered',
          code,
          slot,
          peerOnline: isPeerOnline(code, slot),
          peerName: peerName || null,
          myName: name,
          messages,
        });

        const peer = getPeerSocket(code, slot);
        send(peer, { type: 'peer-status', online: true, name });
      } catch (e) {
        console.error(e);
        send(ws, { type: 'error', message: 'Kuch galat ho gaya, dobara try karo.' });
      }
      return;
    }

    if (!ws.code) return; // must 'enter' before anything else

    if (msg.type === 'message') {
      try {
        const ins = await pool.query(
          'INSERT INTO messages (code, sender_slot, iv, ciphertext) VALUES ($1,$2,$3,$4) RETURNING id',
          [ws.code, ws.slot, msg.iv, msg.ct]
        );
        const id = ins.rows[0].id;

        send(ws, { type: 'message-ack', tempId: msg.tempId, id });

        const peer = getPeerSocket(ws.code, ws.slot);
        send(peer, { type: 'chat', id, slot: ws.slot, iv: msg.iv, ct: msg.ct });
      } catch (e) {
        console.error('message save failed', e.message);
        send(ws, { type: 'error', message: 'Message save nahi ho paya.' });
      }
      return;
    }

    if (msg.type === 'image') {
      try {
        const ins = await pool.query(
          'INSERT INTO messages (code, sender_slot, iv, ciphertext) VALUES ($1,$2,$3,$4) RETURNING id',
          [ws.code, ws.slot, msg.iv, msg.ct]
        );
        const id = ins.rows[0].id;

        send(ws, { type: 'image-ack', tempId: msg.tempId, id });

        const peer = getPeerSocket(ws.code, ws.slot);
        send(peer, { type: 'image', id, slot: ws.slot, iv: msg.iv, ct: msg.ct });
      } catch (e) {
        console.error('image save failed', e.message);
        send(ws, { type: 'error', message: 'Image save nahi ho paya.' });
      }
      return;
    }

    if (msg.type === 'delete-message') {
      const id = Number(msg.id);
      if (!id) return;
      try {
        const del = await pool.query(
          'DELETE FROM messages WHERE id = $1 AND code = $2 AND sender_slot = $3 RETURNING id',
          [id, ws.code, ws.slot]
        );
        if (del.rows.length > 0) {
          send(ws, { type: 'message-deleted', id });
          const peer = getPeerSocket(ws.code, ws.slot);
          send(peer, { type: 'message-deleted', id });
        }
      } catch (e) {
        console.error('delete-message failed', e.message);
      }
      return;
    }
  });

  ws.on('close', () => {
    if (!ws.code) return;
    unregisterLive(ws.code, ws.slot, ws);
    const peer = getPeerSocket(ws.code, ws.slot);
    send(peer, { type: 'peer-status', online: false });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Sealed chat server running on port ${PORT}`);
});
      
