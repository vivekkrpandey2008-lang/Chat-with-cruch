// ---------- tiny helpers ----------
const $ = (id) => document.getElementById(id);

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(id).classList.add('active');
}

function buf2b64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function b642buf(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr.buffer;
}

function getDeviceId() {
  let id = localStorage.getItem('sealed_device_id');
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : `dev-${Date.now()}-${Math.random()}`);
    localStorage.setItem('sealed_device_id', id);
  }
  return id;
}

function normalizeCodeInput(raw) {
  let c = raw.trim().toLowerCase();
  if (c && !c.startsWith('#')) c = '#' + c;
  return c;
}

// ---------- state ----------
let ws = null;
let myCode = null;
let mySlot = null;
let sharedKey = null; // AES-GCM key derived from the code itself
let sessionLive = false;

const enc = new TextEncoder();
const dec = new TextDecoder();
const deviceId = getDeviceId();

// ---------- websocket ----------
function connectSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.addEventListener('message', (ev) => handleServerMessage(JSON.parse(ev.data)));
  ws.addEventListener('close', () => {
    if (myCode) appendSystemMessage('Server se connection toot gaya. Page reload karo.');
  });
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ---------- crypto: key derived straight from the shared code (no network exchange) ----------
async function deriveKeyFromCode(code) {
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('sealed-chat-v1'), iterations: 250000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptText(text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sharedKey, enc.encode(text));
  return { iv: buf2b64(iv), ct: buf2b64(ct) };
}

async function decryptText(ivB64, ctB64) {
  const iv = new Uint8Array(b642buf(ivB64));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, sharedKey, b642buf(ctB64));
  return dec.decode(pt);
}

// ---------- server message handling ----------
async function handleServerMessage(msg) {
  switch (msg.type) {
    case 'entered': {
      myCode = msg.code;
      mySlot = msg.slot;
      $('room-code-label').textContent = myCode;
      showScreen('screen-chat');
      switchTab('live');
      $('chat-messages').innerHTML = '';
      updatePeerStatus(msg.peerOnline);
      appendSystemMessage('Tum is chat mein ho. Messages encrypted hain.');
      break;
    }

    case 'peer-status': {
      updatePeerStatus(msg.online);
      if (!msg.online) {
        appendSystemMessage('Doosra insaan offline ho gaya.');
      }
      break;
    }

    case 'session-started': {
      sessionLive = true;
      $('chat-input').disabled = false;
      $('btn-send').disabled = false;
      $('peer-status').textContent = 'Dono online ho — chat live hai.';
      break;
    }

    case 'session-closed': {
      sessionLive = false;
      lockChatInput();
      appendSystemMessage('Ye baatcheet ab History mein save ho gayi hai.');
      $('peer-status').textContent = 'Doosre insaan ke online aane ka wait ho raha hai…';
      break;
    }

    case 'chat': {
      try {
        const text = await decryptText(msg.iv, msg.ct);
        appendMessage(text, 'peer');
      } catch (e) {
        appendSystemMessage('Ek message decrypt nahi ho paaya.');
      }
      break;
    }

    case 'history-data': {
      renderHistory(msg.sessions);
      break;
    }

    case 'error': {
      if (myCode) {
        appendSystemMessage(msg.message);
      } else {
        showScreen('screen-home');
        $('home-error').textContent = msg.message;
        $('btn-enter').disabled = false;
      }
      break;
    }

    default:
      break;
  }
}

function updatePeerStatus(online) {
  if (!sessionLive) {
    $('peer-status').textContent = online
      ? 'Doosra insaan online hai, chat shuru ho rahi hai…'
      : 'Doosre insaan ke online aane ka wait ho raha hai…';
  }
}

function lockChatInput() {
  $('chat-input').disabled = true;
  $('btn-send').disabled = true;
}

// ---------- UI: messages ----------
function appendMessage(text, who) {
  const el = document.createElement('div');
  el.className = `msg ${who}`;
  el.textContent = text;
  $('chat-messages').appendChild(el);
  $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
}

function appendSystemMessage(text) {
  const el = document.createElement('div');
  el.className = 'msg system';
  el.textContent = text;
  $('chat-messages').appendChild(el);
  $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
}

// ---------- UI: tabs ----------
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
  $(`tab-${name}`).classList.add('active');
  $(`panel-${name}`).classList.add('active');
  if (name === 'history') {
    $('history-list').innerHTML = '<p class="empty-note">History load ho rahi hai…</p>';
    send({ type: 'history' });
  }
}

$('tab-live').addEventListener('click', () => switchTab('live'));
$('tab-history').addEventListener('click', () => switchTab('history'));

// ---------- UI: history rendering ----------
async function renderHistory(sessions) {
  const container = $('history-list');
  container.innerHTML = '';

  if (!sessions || sessions.length === 0) {
    container.innerHTML = '<p class="empty-note">Abhi tak koi purani baatcheet save nahi hui.</p>';
    return;
  }

  for (const s of sessions) {
    const block = document.createElement('div');
    block.className = 'history-session';

    const dateLabel = document.createElement('div');
    dateLabel.className = 'history-date';
    dateLabel.textContent = new Date(s.startedAt).toLocaleString('en-IN');
    block.appendChild(dateLabel);

    for (const m of s.messages) {
      const el = document.createElement('div');
      el.className = `msg ${m.slot === mySlot ? 'me' : 'peer'}`;
      try {
        el.textContent = await decryptText(m.iv, m.ct);
      } catch (e) {
        el.textContent = '[decrypt error]';
      }
      block.appendChild(el);
    }

    container.appendChild(block);
  }
}

// ---------- event wiring ----------
$('btn-enter').addEventListener('click', async () => {
  const code = normalizeCodeInput($('input-code').value);
  if (!/^#[a-z0-9_]{2,20}$/.test(code)) {
    $('home-error').textContent = 'Code # ke saath likho, jaise #love79 (3-20 letters/numbers).';
    return;
  }
  $('home-error').textContent = '';
  $('btn-enter').disabled = true;
  showScreen('screen-connecting');
  sharedKey = await deriveKeyFromCode(code);
  send({ type: 'enter', code, deviceId });
});

$('input-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-enter').click();
});

$('btn-leave').addEventListener('click', () => {
  send({ type: 'leave' });
  resetToHome();
});

$('chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text || !sessionLive) return;
  const payload = await encryptText(text);
  send({ type: 'message', ...payload });
  appendMessage(text, 'me');
  input.value = '';
});

function resetToHome() {
  myCode = null;
  mySlot = null;
  sharedKey = null;
  sessionLive = false;
  $('input-code').value = '';
  $('btn-enter').disabled = false;
  $('home-error').textContent = '';
  showScreen('screen-home');
}

// ---------- boot ----------
connectSocket();
