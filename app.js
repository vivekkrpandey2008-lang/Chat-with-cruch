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

// ---------- state ----------
let ws = null;
let role = null;      // 'creator' | 'joiner'
let myCode = null;
let keyPair = null;   // ECDH key pair
let sharedKey = null; // derived AES-GCM key
let peerConnected = false;

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- websocket setup ----------
function connectSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.addEventListener('open', () => {});
  ws.addEventListener('message', (ev) => handleServerMessage(JSON.parse(ev.data)));
  ws.addEventListener('close', () => {
    if (role) {
      appendSystemMessage('Connection server se toot gaya. Page reload karo.');
    }
  });
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ---------- crypto ----------
async function generateKeyPair() {
  keyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey']
  );
}

async function exportMyPublicKey() {
  const raw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  return buf2b64(raw);
}

async function deriveSharedKey(peerPublicKeyB64) {
  const peerKey = await crypto.subtle.importKey(
    'raw',
    b642buf(peerPublicKeyB64),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  sharedKey = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: peerKey },
    keyPair.privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  onEncryptionReady();
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
    case 'created': {
      myCode = msg.code;
      $('code-display').textContent = myCode;
      $('seal-status').textContent = 'Doosre insaan ke join hone ka wait ho raha hai…';
      showScreen('screen-waiting');
      await generateKeyPair();
      break;
    }

    case 'peer-joined': {
      peerConnected = true;
      await sendMyPublicKey();
      enterChat();
      break;
    }

    case 'joined': {
      myCode = msg.code;
      peerConnected = true;
      await generateKeyPair();
      await sendMyPublicKey();
      enterChat();
      break;
    }

    case 'signal': {
      const { kind } = msg.payload;
      if (kind === 'pubkey') {
        await deriveSharedKey(msg.payload.key);
      } else if (kind === 'msg') {
        try {
          const text = await decryptText(msg.payload.iv, msg.payload.ct);
          appendMessage(text, 'peer');
        } catch (e) {
          appendSystemMessage('Ek message decrypt nahi ho paaya.');
        }
      }
      break;
    }

    case 'cancelled': {
      resetToHome('Code cancel kar diya gaya.');
      break;
    }

    case 'expired': {
      resetToHome('Code expire ho gaya (30 min tak koi join nahi hua).');
      break;
    }

    case 'peer-left': {
      appendSystemMessage('Doosra insaan chat chhod chuka hai. Ye chat ab band ho chuki hai.');
      lockChatInput();
      break;
    }

    case 'error': {
      showScreen('screen-home');
      $('home-error').textContent = msg.message;
      $('btn-join').disabled = false;
      break;
    }

    default:
      break;
  }
}

async function sendMyPublicKey() {
  const key = await exportMyPublicKey();
  send({ type: 'signal', payload: { kind: 'pubkey', key } });
}

function onEncryptionReady() {
  $('lock-pill').classList.remove('pending');
  $('lock-text').textContent = 'End-to-end encrypted';
  $('chat-input').disabled = false;
  $('btn-send').disabled = false;
  $('chat-input').focus();
}

// ---------- UI flows ----------
function enterChat() {
  showScreen('screen-chat');
  $('chat-messages').innerHTML = '';
  $('lock-pill').classList.add('pending');
  $('lock-text').textContent = 'Encryption set ho rahi hai…';
  appendSystemMessage('Aap dono ab connected ho. Messages is device se doosre tak encrypted jaate hain.');
}

function lockChatInput() {
  $('chat-input').disabled = true;
  $('btn-send').disabled = true;
}

function resetToHome(message) {
  role = null;
  myCode = null;
  keyPair = null;
  sharedKey = null;
  peerConnected = false;
  $('home-error').textContent = message || '';
  $('input-join-code').value = '';
  $('btn-join').disabled = false;
  showScreen('screen-home');
}

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

// ---------- event wiring ----------
$('btn-create').addEventListener('click', () => {
  role = 'creator';
  $('home-error').textContent = '';
  send({ type: 'create' });
});

$('btn-join').addEventListener('click', () => {
  const code = $('input-join-code').value.trim().toUpperCase();
  if (code.length < 4) {
    $('home-error').textContent = 'Sahi code daalo.';
    return;
  }
  role = 'joiner';
  $('home-error').textContent = '';
  $('btn-join').disabled = true;
  showScreen('screen-connecting');
  $('connecting-status').textContent = 'Code check ho raha hai…';
  send({ type: 'join', code });
});

$('input-join-code').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase();
});
$('input-join-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-join').click();
});

$('btn-copy-code').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(myCode);
    $('btn-copy-code').textContent = 'Copy ho gaya ✓';
    setTimeout(() => ($('btn-copy-code').textContent = 'Copy karo'), 1500);
  } catch (e) {
    /* clipboard may be unavailable; ignore silently */
  }
});

$('btn-cancel-code').addEventListener('click', () => {
  if (myCode) send({ type: 'cancel', code: myCode });
});

$('btn-leave').addEventListener('click', () => {
  send({ type: 'leave' });
  resetToHome('Aapne chat chhod di.');
});

$('chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text || !sharedKey) return;
  const payload = await encryptText(text);
  send({ type: 'signal', payload: { kind: 'msg', ...payload } });
  appendMessage(text, 'me');
  input.value = '';
});

// ---------- boot ----------
connectSocket();
