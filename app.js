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
    endCall(false);
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
      if (!msg.online && callState !== 'idle') endCall(false, 'Doosra insaan offline ho gaya.');
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

    case 'call-offer': onCallOffer(msg); break;
    case 'call-answer': onCallAnswer(msg); break;
    case 'call-ice': onCallIce(msg); break;
    case 'call-end': endCall(false, 'Call khatam ho gayi.'); break;
    case 'call-reject': endCall(false, msg.reason === 'busy' ? 'Doosra insaan busy hai.' : 'Call reject ho gayi.'); break;
    case 'call-unavailable': endCall(false, 'Doosra insaan abhi online nahi hai.'); break;

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
// Apne message/image ke neeche dikhne wala delete button
function addDeleteButton(wrapEl, what) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'msg-delete-btn';
  btn.textContent = '🗑 Delete';
  btn.style.cssText = 'background:none;border:none;color:inherit;opacity:.6;font-size:12px;padding:4px 2px;cursor:pointer;';
  btn.addEventListener('click', () => {
    if (!wrapEl.dataset.id) return; // server ack ka wait
    if (window.confirm(`Ye ${what} delete karna hai?`)) {
      send({ type: 'delete-message', id: Number(wrapEl.dataset.id) });
    }
  });
  wrapEl.appendChild(btn);
}

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
  if (who === 'me') addDeleteButton(wrapEl, 'message');

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
  if (who === 'me') addDeleteButton(wrapEl, 'image');

  $('chat-messages').appendChild(wrapEl);
  $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
}

// ---------- voice / video call (WebRTC) ----------
// Audio/video seedha dono phones ke beech jaata hai (DTLS-SRTP encrypted); server sirf signaling karta hai.
// Kuch networks (jaise kuch mobile data) par TURN server chahiye hota hai. Apna TURN ho to yahan daalo.
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // { urls: 'turn:YOUR_TURN_HOST:3478', username: 'USER', credential: 'PASS' },
  ],
};

let callState = 'idle'; // idle | calling | ringing | active
let pc = null;
let localStream = null;
let pendingOffer = null;
let iceQueue = [];
let callIsVideo = false;
let callTimer = null;
let callSecs = 0;

(function injectCallUI() {
  const style = document.createElement('style');
  style.textContent = `
    .call-btn{background:none;border:1px solid rgba(255,255,255,.2);color:inherit;border-radius:10px;padding:4px 9px;font-size:16px;cursor:pointer}
    .topbar-actions{display:flex;gap:6px;align-items:center}
    #call-overlay{position:fixed;inset:0;z-index:1000;background:#0b0b10;display:none;flex-direction:column;align-items:center;justify-content:center;color:#fff}
    #call-overlay.open{display:flex}
    #call-remote{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#0b0b10}
    #call-local{position:absolute;right:14px;top:calc(env(safe-area-inset-top,0px) + 14px);width:96px;height:128px;object-fit:cover;border-radius:12px;border:2px solid rgba(255,255,255,.4);background:#222;z-index:2;transform:scaleX(-1)}
    #call-info{position:relative;z-index:2;text-align:center;text-shadow:0 1px 6px rgba(0,0,0,.7)}
    #call-info .who{font-size:24px;font-weight:600}
    #call-info .st{opacity:.85;margin-top:6px}
    #call-controls{position:absolute;bottom:calc(env(safe-area-inset-bottom,0px) + 36px);left:0;right:0;display:flex;justify-content:center;gap:18px;z-index:3}
    .call-round{width:58px;height:58px;border-radius:50%;border:none;font-size:24px;color:#fff;background:rgba(255,255,255,.18);cursor:pointer}
    .call-round.off{background:#fff;color:#000}
    .call-round.end{background:#e5384b}
    .call-round.ok{background:#22b455}
    #call-incoming{position:fixed;inset:0;z-index:1001;background:rgba(10,10,16,.94);display:none;flex-direction:column;align-items:center;justify-content:center;color:#fff;gap:10px}
    #call-incoming.open{display:flex}
    #call-incoming .who{font-size:26px;font-weight:600}
    #call-incoming .row{display:flex;gap:40px;margin-top:30px}
  `;
  document.head.appendChild(style);

  const overlay = document.createElement('div');
  overlay.id = 'call-overlay';
  overlay.innerHTML = `
    <video id="call-remote" autoplay playsinline></video>
    <video id="call-local" autoplay playsinline muted></video>
    <div id="call-info"><div class="who" id="call-who"></div><div class="st" id="call-status"></div></div>
    <div id="call-controls">
      <button type="button" class="call-round" id="call-mute" title="Mute">🎤</button>
      <button type="button" class="call-round" id="call-cam" title="Camera">📷</button>
      <button type="button" class="call-round end" id="call-hang" title="End">📵</button>
    </div>`;
  document.body.appendChild(overlay);

  const inc = document.createElement('div');
  inc.id = 'call-incoming';
  inc.innerHTML = `
    <div style="font-size:54px">📞</div>
    <div class="who" id="inc-who"></div>
    <div id="inc-kind" style="opacity:.8"></div>
    <div class="row">
      <button type="button" class="call-round end" id="inc-reject" title="Reject">✖</button>
      <button type="button" class="call-round ok" id="inc-accept" title="Accept">✔</button>
    </div>`;
  document.body.appendChild(inc);

  // top bar mein call buttons
  const leave = document.getElementById('btn-leave');
  if (leave) {
    const box = document.createElement('div');
    box.className = 'topbar-actions';
    box.innerHTML = `
      <button type="button" class="call-btn" id="btn-voice" title="Voice call">📞</button>
      <button type="button" class="call-btn" id="btn-video" title="Video call">🎥</button>`;
    leave.parentNode.insertBefore(box, leave);
    box.appendChild(leave);
  }

  document.getElementById('btn-voice').addEventListener('click', () => startCall(false));
  document.getElementById('btn-video').addEventListener('click', () => startCall(true));
  document.getElementById('call-hang').addEventListener('click', () => endCall(true));
  document.getElementById('inc-reject').addEventListener('click', () => {
    send({ type: 'call-reject' });
    pendingOffer = null;
    iceQueue = [];
    callState = 'idle';
    $('call-incoming').classList.remove('open');
  });
  document.getElementById('inc-accept').addEventListener('click', acceptCall);
  document.getElementById('call-mute').addEventListener('click', (e) => toggleTrack('audio', e.currentTarget, '🎤', '🔇'));
  document.getElementById('call-cam').addEventListener('click', (e) => toggleTrack('video', e.currentTarget, '📷', '🚫'));
})();

function toggleTrack(kind, btn, onIcon, offIcon) {
  if (!localStream) return;
  const tracks = kind === 'audio' ? localStream.getAudioTracks() : localStream.getVideoTracks();
  if (!tracks.length) return;
  const enable = !tracks[0].enabled;
  tracks.forEach((t) => (t.enabled = enable));
  btn.textContent = enable ? onIcon : offIcon;
  btn.classList.toggle('off', !enable);
}

function setCallStatus(text) {
  const el = $('call-status');
  if (el) el.textContent = text;
}

function showCallUI() {
  $('call-who').textContent = peerName || 'Doosra insaan';
  $('call-cam').style.display = callIsVideo ? '' : 'none';
  $('call-local').style.display = callIsVideo ? '' : 'none';
  $('call-mute').textContent = '🎤';
  $('call-mute').classList.remove('off');
  $('call-cam').textContent = '📷';
  $('call-cam').classList.remove('off');
  $('call-overlay').classList.add('open');
}

async function getMedia(video) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Is browser mein call support nahi hai (HTTPS chahiye).');
  }
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
    video: video ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } : false,
  });
}

function createPeerConnection() {
  pc = new RTCPeerConnection(RTC_CONFIG);
  pc.onicecandidate = (ev) => {
    if (ev.candidate) send({ type: 'call-ice', candidate: ev.candidate });
  };
  pc.ontrack = (ev) => {
    const remote = $('call-remote');
    if (remote.srcObject !== ev.streams[0]) remote.srcObject = ev.streams[0];
    remote.play().catch(() => {});
  };
  pc.onconnectionstatechange = () => {
    if (!pc) return;
    if (pc.connectionState === 'connected') {
      callState = 'active';
      startCallTimer();
    } else if (pc.connectionState === 'failed') {
      endCall(true, 'Connection nahi ban paya (network). Dobara try karo.');
    } else if (pc.connectionState === 'disconnected') {
      setCallStatus('Connection weak hai…');
    }
  };
}

function startCallTimer() {
  clearInterval(callTimer);
  callSecs = 0;
  callTimer = setInterval(() => {
    callSecs++;
    const m = String(Math.floor(callSecs / 60)).padStart(2, '0');
    const s = String(callSecs % 60).padStart(2, '0');
    setCallStatus(`${m}:${s}`);
  }, 1000);
}

async function startCall(video) {
  if (!myCode) return;
  if (callState !== 'idle') return;
  callIsVideo = video;
  callState = 'calling';
  try {
    localStream = await getMedia(video);
  } catch (err) {
    callState = 'idle';
    alert(err.message && err.message.includes('support') ? err.message : 'Mic/camera ki permission do, phir try karo.');
    return;
  }
  $('call-local').srcObject = localStream;
  showCallUI();
  setCallStatus('Ringing…');
  createPeerConnection();
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: 'call-offer', video, sdp: pc.localDescription });
  } catch (err) {
    console.error(err);
    endCall(true, 'Call shuru nahi ho payi.');
    return;
  }
  // 40 sec mein jawab na aaye to band
  const thisPc = pc;
  setTimeout(() => {
    if (callState === 'calling' && pc === thisPc) endCall(true, 'Koi jawab nahi mila.');
  }, 40000);
}

function onCallOffer(msg) {
  if (callState !== 'idle') {
    send({ type: 'call-reject', reason: 'busy' });
    return;
  }
  callState = 'ringing';
  pendingOffer = msg;
  iceQueue = [];
  callIsVideo = !!msg.video;
  $('inc-who').textContent = peerName || 'Doosra insaan';
  $('inc-kind').textContent = callIsVideo ? 'Video call aa rahi hai…' : 'Voice call aa rahi hai…';
  $('call-incoming').classList.add('open');
  if (navigator.vibrate) navigator.vibrate([300, 150, 300]);
}

async function acceptCall() {
  if (callState !== 'ringing' || !pendingOffer) return;
  $('call-incoming').classList.remove('open');
  try {
    localStream = await getMedia(callIsVideo);
  } catch (err) {
    send({ type: 'call-reject' });
    callState = 'idle';
    pendingOffer = null;
    alert('Mic/camera ki permission do, phir try karo.');
    return;
  }
  $('call-local').srcObject = localStream;
  showCallUI();
  setCallStatus('Connecting…');
  createPeerConnection();
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  try {
    await pc.setRemoteDescription(pendingOffer.sdp);
    pendingOffer = null;
    for (const c of iceQueue) await pc.addIceCandidate(c).catch(() => {});
    iceQueue = [];
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send({ type: 'call-answer', sdp: pc.localDescription });
    callState = 'active';
  } catch (err) {
    console.error(err);
    endCall(true, 'Call connect nahi ho payi.');
  }
}

async function onCallAnswer(msg) {
  if (!pc || callState !== 'calling') return;
  try {
    await pc.setRemoteDescription(msg.sdp);
    for (const c of iceQueue) await pc.addIceCandidate(c).catch(() => {});
    iceQueue = [];
    setCallStatus('Connecting…');
  } catch (err) {
    console.error(err);
    endCall(true, 'Call connect nahi ho payi.');
  }
}

async function onCallIce(msg) {
  if (!msg.candidate) return;
  if (pc && pc.remoteDescription) {
    pc.addIceCandidate(msg.candidate).catch(() => {});
  } else {
    iceQueue.push(msg.candidate); // remote description aane tak ruko
  }
}

function endCall(notifyPeer, note) {
  if (callState === 'idle' && !pc && !localStream) return;
  if (notifyPeer && callState !== 'idle') send({ type: 'call-end' });
  clearInterval(callTimer);
  callTimer = null;
  if (pc) {
    pc.onicecandidate = pc.ontrack = pc.onconnectionstatechange = null;
    pc.close();
    pc = null;
  }
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  const r = $('call-remote');
  const l = $('call-local');
  if (r) r.srcObject = null;
  if (l) l.srcObject = null;
  pendingOffer = null;
  iceQueue = [];
  callState = 'idle';
  $('call-overlay').classList.remove('open');
  $('call-incoming').classList.remove('open');
  if (note && myCode) appendSystemMessage(note);
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
    addDeleteButton(wrapEl, 'image');

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
  endCall(true);
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
        
