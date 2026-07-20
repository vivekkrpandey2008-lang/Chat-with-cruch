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

// ---------- theme ----------
function applyTheme(name) {
  document.documentElement.setAttribute('data-theme', name);
  localStorage.setItem('sealed_theme', name);
}
(function initTheme() {
  const saved = localStorage.getItem('sealed_theme') || 'sealed';
  applyTheme(saved);
})();

$('btn-theme').addEventListener('click', () => {
  $('theme-menu').classList.toggle('open');
});
document.querySelectorAll('.theme-option').forEach((btn) => {
  btn.addEventListener('click', () => {
    applyTheme(btn.dataset.theme);
    $('theme-menu').classList.remove('open');
  });
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.theme-picker')) $('theme-menu').classList.remove('open');
});

// ---------- state ----------
let ws = null;
let myCode = null;
let mySlot = null;
let myName = '';
let peerName = '';
let sharedKey = null; // AES-GCM key derived from the code itself
let sessionLive = false;
let lastHistoryData = null; // cache so tapping a card doesn't need a re-fetch

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
      myName = msg.myName;
      peerName = msg.peerName || '';
      $('room-code-label').textContent = myCode;
      updatePeerNameTag(msg.peerOnline);
      showScreen('screen-chat');
      switchTab('live');
      $('chat-messages').innerHTML = '';
      updatePeerStatus(msg.peerOnline);
      appendSystemMessage('Tum is chat mein ho. Messages encrypted hain.');
      break;
    }

    case 'peer-status': {
      if (msg.name) peerName = msg.name;
      updatePeerNameTag(msg.online);
      updatePeerStatus(msg.online);
      if (!msg.online) appendSystemMessage('Doosra insaan offline ho gaya.');
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
        appendMessage(text, 'peer', peerName);
      } catch (e) {
        appendSystemMessage('Ek message decrypt nahi ho paaya.');
      }
      break;
    }

    case 'history-data': {
      lastHistoryData = msg;
      renderHistoryList(msg);
      break;
    }

    case 'session-deleted': {
      if (lastHistoryData) {
        lastHistoryData.sessions = lastHistoryData.sessions.filter((s) => s.id !== msg.sessionId);
        if (currentDetailSessionId === msg.sessionId) {
          currentDetailSessionId = null;
          $('history-detail').classList.remove('open');
          $('history-list').classList.remove('hidden');
        }
        renderHistoryList(lastHistoryData);
      }
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

function updatePeerNameTag(online) {
  const tag = $('peer-name-tag');
  if (peerName) {
    tag.textContent = online ? `${peerName} ke saath (online)` : `${peerName} ke saath (offline)`;
  } else {
    tag.textContent = 'Doosre insaan ka wait ho raha hai…';
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
function appendMessage(text, who, senderName) {
  const wrapEl = document.createElement('div');
  wrapEl.style.display = 'flex';
  wrapEl.style.flexDirection = 'column';
  wrapEl.style.alignItems = who === 'me' ? 'flex-end' : 'flex-start';
  wrapEl.style.maxWidth = '78%';
  wrapEl.style.alignSelf = who === 'me' ? 'flex-end' : 'flex-start';

  if (senderName) {
    const label = document.createElement('div');
    label.className = 'msg-name';
    label.textContent = senderName;
    wrapEl.appendChild(label);
  }

  const el = document.createElement('div');
  el.className = `msg ${who}`;
  el.style.maxWidth = '100%';
  el.textContent = text;
  wrapEl.appendChild(el);

  $('chat-messages').appendChild(wrapEl);
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
    $('history-detail').classList.remove('open');
    $('history-list').classList.remove('hidden');
    $('history-list').innerHTML = '<p class="empty-note">History load ho rahi hai…</p>';
    send({ type: 'history' });
  }
}

$('tab-live').addEventListener('click', () => switchTab('live'));
$('tab-history').addEventListener('click', () => switchTab('history'));
$('btn-history-back').addEventListener('click', () => {
  $('history-detail').classList.remove('open');
  $('history-list').classList.remove('hidden');
});

// ---------- UI: WhatsApp-style history list ----------
async function renderHistoryList(data) {
  const { names, sessions } = data;
  const container = $('history-list');
  container.innerHTML = '';

  if (!sessions || sessions.length === 0) {
    container.innerHTML = '<p class="empty-note">Abhi tak koi purani baatcheet save nahi hui.</p>';
    return;
  }

  for (const s of sessions) {
    const lastMsg = s.messages[s.messages.length - 1];
    let preview = '…';
    if (lastMsg) {
      try {
        const text = await decryptText(lastMsg.iv, lastMsg.ct);
        const who = lastMsg.slot === mySlot ? 'Tum: ' : '';
        preview = who + text;
      } catch (e) {
        preview = '[decrypt error]';
      }
    }

    const card = document.createElement('div');
    card.className = 'history-card';
    card.innerHTML = `
      <div class="history-card-open" role="button">
        <div class="history-avatar">💬</div>
        <div class="history-card-body">
          <div class="history-card-top">
            <span class="history-card-date">${new Date(s.startedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>
          </div>
          <div class="history-card-preview"></div>
        </div>
      </div>
      <button class="history-card-delete" aria-label="Delete karo">🗑</button>
    `;
    card.querySelector('.history-card-preview').textContent = preview;
    card.querySelector('.history-card-open').addEventListener('click', () => openHistoryDetail(s, names));
    card.querySelector('.history-card-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      confirmAndDelete(s.id, card);
    });
    container.appendChild(card);
  }
}

let currentDetailSessionId = null;

function confirmAndDelete(sessionId, cardEl) {
  const ok = window.confirm('Ye baatcheet hamesha ke liye delete ho jayegi. Pakka?');
  if (!ok) return;
  send({ type: 'delete-session', sessionId });
}

$('btn-delete-session').addEventListener('click', () => {
  if (!currentDetailSessionId) return;
  const ok = window.confirm('Ye baatcheet hamesha ke liye delete ho jayegi. Pakka?');
  if (!ok) return;
  send({ type: 'delete-session', sessionId: currentDetailSessionId });
});

async function openHistoryDetail(session, names) {
  currentDetailSessionId = session.id;
  const container = $('history-detail-messages');
  container.innerHTML = '';

  for (const m of session.messages) {
    const who = m.slot === mySlot ? 'me' : 'peer';
    const senderName = m.slot === mySlot ? (myName || 'Tum') : (names[m.slot] || 'Doosra insaan');
    let text;
    try {
      text = await decryptText(m.iv, m.ct);
    } catch (e) {
      text = '[decrypt error]';
    }

    const wrapEl = document.createElement('div');
    wrapEl.style.display = 'flex';
    wrapEl.style.flexDirection = 'column';
    wrapEl.style.alignItems = who === 'me' ? 'flex-end' : 'flex-start';
    wrapEl.style.maxWidth = '78%';
    wrapEl.style.alignSelf = who === 'me' ? 'flex-end' : 'flex-start';

    const label = document.createElement('div');
    label.className = 'msg-name';
    label.textContent = senderName;
    wrapEl.appendChild(label);

    const el = document.createElement('div');
    el.className = `msg ${who}`;
    el.style.maxWidth = '100%';
    el.textContent = text;
    wrapEl.appendChild(el);

    container.appendChild(wrapEl);
  }

  $('history-list').classList.add('hidden');
  $('history-detail').classList.add('open');
}

// ---------- event wiring ----------
$('btn-enter').addEventListener('click', async () => {
  const code = normalizeCodeInput($('input-code').value);
  const name = $('input-name').value.trim().slice(0, 30);

  if (!name) {
    $('home-error').textContent = 'Pehle apna naam likho.';
    return;
  }
  if (!/^#[a-z0-9_]{2,20}$/.test(code)) {
    $('home-error').textContent = 'Code # ke saath likho, jaise #love79 (3-20 letters/numbers).';
    return;
  }

  localStorage.setItem('sealed_name', name);
  $('home-error').textContent = '';
  $('btn-enter').disabled = true;
  showScreen('screen-connecting');
  sharedKey = await deriveKeyFromCode(code);
  send({ type: 'enter', code, deviceId, name });
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
  appendMessage(text, 'me', myName);
  input.value = '';
});

function resetToHome() {
  myCode = null;
  mySlot = null;
  peerName = '';
  sharedKey = null;
  sessionLive = false;
  $('input-code').value = '';
  $('btn-enter').disabled = false;
  $('home-error').textContent = '';
  showScreen('screen-home');
}

// ---------- boot ----------
(function restoreName() {
  const saved = localStorage.getItem('sealed_name');
  if (saved) $('input-name').value = saved;
})();

connectSocket();
          
