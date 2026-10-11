// ---------- tiny helpers ----------
const $ = (id) => document.getElementById(id);

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(id).classList.add('active');
}

function buf2b64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000; // chunk karke convert karo, warna bade data par stack overflow hota hai
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
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

function makeTempId() {
  return (crypto.randomUUID ? crypto.randomUUID() : `tmp-${Date.now()}-${Math.random()}`);
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

const enc = new TextEncoder();
const dec = new TextDecoder();
const deviceId = getDeviceId();

// ---------- websocket ----------
let sendQueue = [];

function connectSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.addEventListener('open', () => {
    const q = sendQueue;
    sendQueue = [];
    q.forEach((o) => ws.send(JSON.stringify(o)));
  });
  ws.addEventListener('message', (ev) => {
    try {
      handleServerMessage(JSON.parse(ev.data));
    } catch (e) {
      console.error('Bad server message', e);
    }
  });
  ws.addEventListener('close', () => {
    if (myCode) {
      appendSystemMessage('Server se connection toot gaya. Page reload karo.');
    } else {
      showScreen('screen-home');
      $('home-error').textContent = 'Server se connect nahi ho paya. Thodi der baad dobara try karo.';
      $('btn-enter').disabled = false;
    }
  });
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  } else if (ws && ws.readyState === WebSocket.CONNECTING) {
    sendQueue.push(obj); // connect hote hi bhej denge
  } else {
    sendQueue.push(obj);
    connectSocket(); // socket band tha, dobara connect karo
  }
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
      $('chat-messages').innerHTML = '';

      for (const m of msg.messages) {
        const who = m.slot === mySlot ? 'me' : 'peer';
        const senderName = m.slot === mySlot ? myName : (peerName || 'Doosra insaan');
        try {
          const text = await decryptText(m.iv, m.ct);
          if (text.startsWith('data:image/')) appendImage(text, who, senderName, m.id);
          else appendMessage(text, who, senderName, m.id);
        } catch (e) {
          appendMessage('[decrypt error]', who, senderName, m.id);
        }
      }
      break;
    }

    case 'peer-status': {
      if (msg.name) peerName = msg.name;
      updatePeerNameTag(msg.online);
      break;
    }

    case 'message-ack': {
      const el = document.querySelector(`[data-tempid="${msg.tempId}"]`);
      if (el) {
        el.dataset.id = msg.id;
        delete el.dataset.tempid;
      }
      break;
    }

    case 'chat': {
      try {
        const text = await decryptText(msg.iv, msg.ct);
        appendMessage(text, 'peer', peerName || 'Doosra insaan', msg.id);
      } catch (e) {
        appendSystemMessage('Ek message decrypt nahi ho paaya.');
      }
      break;
    }

    case 'image-ack': {
      const el = document.querySelector(`[data-tempid="${msg.tempId}"]`);
      if (el) {
        el.dataset.id = msg.id;
        delete el.dataset.tempid;
      }
      break;
    }

    case 'image': {
      try {
        const base64 = await decryptText(msg.iv, msg.ct);
        appendImage(base64, 'peer', peerName || 'Doosra insaan', msg.id);
      } catch (e) {
        appendSystemMessage('Image decrypt nahi ho paaya.');
      }
      break;
    }

    case 'message-deleted': {
      const el = document.querySelector(`[data-id="${msg.id}"]`);
      if (el) el.remove();
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

// ---------- UI: messages ----------
function appendMessage(text, who, senderName, id) {
  const wrapEl = document.createElement('div');
  wrapEl.style.display = 'flex';
  wrapEl.style.flexDirection = 'column';
  wrapEl.style.alignItems = who === 'me' ? 'flex-end' : 'flex-start';
  wrapEl.style.maxWidth = '78%';
  wrapEl.style.alignSelf = who === 'me' ? 'flex-end' : 'flex-start';

  if (id) wrapEl.dataset.id = id;

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
  if (who === 'me') {
    el.style.cursor = 'pointer';
    el.title = 'Delete karne ke liye tap karo';
    el.addEventListener('click', () => {
      if (!wrapEl.dataset.id) return; // not yet acknowledged by server
      const ok = window.confirm('Ye message delete karna hai?');
      if (ok) send({ type: 'delete-message', id: Number(wrapEl.dataset.id) });
    });
  }
  wrapEl.appendChild(el);

  $('chat-messages').appendChild(wrapEl);
  $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
  return wrapEl;
}

function appendSystemMessage(text) {
  const el = document.createElement('div');
  el.className = 'msg system';
  el.textContent = text;
  $('chat-messages').appendChild(el);
  $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
}

function appendImage(base64, who, senderName, id) {
  const wrapEl = document.createElement('div');
  wrapEl.style.display = 'flex';
  wrapEl.style.flexDirection = 'column';
  wrapEl.style.alignItems = who === 'me' ? 'flex-end' : 'flex-start';
  wrapEl.style.maxWidth = '78%';
  wrapEl.style.alignSelf = who === 'me' ? 'flex-end' : 'flex-start';

  if (id) wrapEl.dataset.id = id;

  if (senderName) {
    const label = document.createElement('div');
    label.className = 'msg-name';
    label.textContent = senderName;
    wrapEl.appendChild(label);
  }

  const el = document.createElement('div');
  el.className = `msg image ${who}`;
  const img = document.createElement('img');
  img.src = base64;
  el.appendChild(img);
  if (who === 'me') {
    el.style.cursor = 'pointer';
    el.title = 'Delete karne ke liye tap karo';
    el.addEventListener('click', () => {
      if (!wrapEl.dataset.id) return;
      const ok = window.confirm('Ye image delete karna hai?');
      if (ok) send({ type: 'delete-message', id: Number(wrapEl.dataset.id) });
    });
  }
  wrapEl.appendChild(el);

  $('chat-messages').appendChild(wrapEl);
  $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
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

  // 20 sec mein jawab na aaye to spinner mein mat atko
  clearTimeout(window.__enterTimer);
  window.__enterTimer = setTimeout(() => {
    if (!myCode) {
      showScreen('screen-home');
      $('home-error').textContent = 'Server jawab nahi de raha (DB ya server problem). Site ke aage /health kholkar dekho.';
      $('btn-enter').disabled = false;
    }
  }, 20000);
});

$('input-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-enter').click();
});

$('btn-leave').addEventListener('click', () => {
  resetToHome();
});

$('chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text) return;
  const tempId = makeTempId();
  const payload = await encryptText(text);
  send({ type: 'message', ...payload, tempId });

  const el = appendMessage(text, 'me', myName, null);
  el.dataset.tempid = tempId;

  input.value = '';
});

// Image ko resize + JPEG mein compress karta hai (max 1600px, ~300-600KB)
function compressImage(file, maxDim = 1600, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      const scale = Math.min(1, maxDim / Math.max(width, height));
      width = Math.round(width * scale);
      height = Math.round(height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
    img.src = url;
  });
}

$('btn-image').addEventListener('click', (e) => {
  e.preventDefault();
  $('file-input').click();
});

$('file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  // Koi bhi image allowed (jpg/png/webp), bahut bada ho to 15MB tak
  if (!file.type.startsWith('image/')) {
    alert('Sirf image file allowed hai.');
    e.target.value = '';
    return;
  }
  if (file.size > 15 * 1024 * 1024) {
    alert('Image 15MB se bada nahi hona chahiye.');
    e.target.value = '';
    return;
  }

  try {
    // Read file as base64
    const base64 = await compressImage(file);

    const tempId = makeTempId();
    const payload = await encryptText(base64);
    send({ type: 'image', ...payload, tempId });

    // Show local preview
    const wrapEl = document.createElement('div');
    wrapEl.style.display = 'flex';
    wrapEl.style.flexDirection = 'column';
    wrapEl.style.alignItems = 'flex-end';
    wrapEl.style.maxWidth = '78%';
    wrapEl.style.alignSelf = 'flex-end';
    wrapEl.dataset.tempid = tempId;

    const label = document.createElement('div');
    label.className = 'msg-name';
    label.textContent = myName;
    wrapEl.appendChild(label);

    const el = document.createElement('div');
    el.className = 'msg image me';
    const img = document.createElement('img');
    img.src = base64;
    el.appendChild(img);
    el.style.cursor = 'pointer';
    el.title = 'Delete karne ke liye tap karo';
    el.addEventListener('click', () => {
      if (!wrapEl.dataset.id) return;
      const ok = window.confirm('Ye image delete karna hai?');
      if (ok) send({ type: 'delete-message', id: Number(wrapEl.dataset.id) });
    });
    wrapEl.appendChild(el);

    $('chat-messages').appendChild(wrapEl);
    $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
  } catch (err) {
    console.error('Image error:', err);
    alert('Image bhejne mein error. Dobara try karo.');
  }

  // Reset file input
  e.target.value = '';
});

function resetToHome() {
  myCode = null;
  mySlot = null;
  peerName = '';
  sharedKey = null;
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
        
