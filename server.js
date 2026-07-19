const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// code -> { creator, joiner, joined, createdAt }
const rooms = new Map();

// Codes older than this with nobody joined are swept away automatically.
const MAX_WAIT_MS = 30 * 60 * 1000; // 30 minutes

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion

function generateCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    }
  } while (rooms.has(code));
  return code;
}

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function destroyRoom(code) {
  rooms.delete(code);
}

// Periodic sweep of stale, never-joined rooms.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (!room.joined && now - room.createdAt > MAX_WAIT_MS) {
      send(room.creator, { type: 'expired', code, reason: 'timeout' });
      destroyRoom(code);
    }
  }
}, 60 * 1000);

wss.on('connection', (ws) => {
  ws.id = crypto.randomUUID();
  ws.roomCode = null;
  ws.role = null; // 'creator' | 'joiner'

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }

    switch (msg.type) {
      // Creator asks for a brand new one-time code.
      case 'create': {
        if (ws.roomCode) return; // already owns/holds a room on this connection
        const code = generateCode();
        rooms.set(code, {
          creator: ws,
          joiner: null,
          joined: false,
          createdAt: Date.now(),
        });
        ws.roomCode = code;
        ws.role = 'creator';
        send(ws, { type: 'created', code });
        break;
      }

      // Second person tries to redeem a code.
      case 'join': {
        const code = String(msg.code || '').toUpperCase().trim();
        const room = rooms.get(code);

        if (!room) {
          send(ws, { type: 'error', message: 'Ye code invalid hai ya expire ho chuka hai.' });
          return;
        }
        if (room.joined) {
          send(ws, { type: 'error', message: 'Ye code pehle hi use ho chuka hai.' });
          return;
        }
        if (room.creator === ws) {
          send(ws, { type: 'error', message: 'Aap apna khud ka code use nahi kar sakte.' });
          return;
        }

        room.joiner = ws;
        room.joined = true; // locked forever - no third person can ever use this code
        ws.roomCode = code;
        ws.role = 'joiner';

        send(ws, { type: 'joined', code });
        send(room.creator, { type: 'peer-joined', code });
        break;
      }

      // Only the creator, and only before anyone has joined, can kill a code.
      case 'cancel': {
        const code = String(msg.code || '');
        const room = rooms.get(code);
        if (room && room.creator === ws && !room.joined) {
          destroyRoom(code);
          send(ws, { type: 'cancelled', code });
        }
        break;
      }

      // Blind relay: server never inspects/keeps the payload. Used both for
      // public-key exchange and for encrypted chat messages.
      case 'signal': {
        const room = rooms.get(ws.roomCode);
        if (!room || !room.joined) return;
        const peer = ws.role === 'creator' ? room.joiner : room.creator;
        send(peer, { type: 'signal', payload: msg.payload });
        break;
      }

      case 'leave': {
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        const peer = ws.role === 'creator' ? room.joiner : room.creator;
        send(peer, { type: 'peer-left' });
        destroyRoom(ws.roomCode);
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    if (!ws.roomCode) return;
    const room = rooms.get(ws.roomCode);
    if (!room) return;

    if (!room.joined && room.creator === ws) {
      // Creator vanished before anyone joined - kill the unused code.
      destroyRoom(ws.roomCode);
    } else if (room.joined) {
      const peer = ws.role === 'creator' ? room.joiner : room.creator;
      send(peer, { type: 'peer-left' });
      destroyRoom(ws.roomCode);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Private chat server running on http://localhost:${PORT}`);
});
