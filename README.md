# Sealed — one-time-code, two-person, end-to-end encrypted chat

## Ye kaise kaam karta hai

- **Code generate**: Koi bhi "Naya chat shuru karo" dabata hai, server ek unique 6-character
  code deta hai aur room ko "waiting" state me rakhta hai.
- **One-time use**: Jaise hi doosra insaan us code se join karta hai, server room ko turant
  `joined = true` mark kar deta hai. Us ke baad koi teesra wahi code use nahi kar sakta,
  chahe use pata bhi ho.
- **Sirf creator cancel kar sakta hai**: Server har room ke saath creator ki websocket
  connection ka reference rakhta hai. Cancel request tabhi kaam karti hai jab wahi
  connection request bheje aur abhi tak koi doosra join na hua ho.
- **Auto-expiry**: Agar 30 minute tak koi join nahi karta, code khud expire ho jata hai
  (yeh limit `MAX_WAIT_MS` me `server.js` mein change kar sakte ho).
- **End-to-end encryption**: Server sirf ek "relay" hai — wo sirf public keys aur encrypted
  bytes aage bhejta hai. Dono browsers apna-apna ECDH (P-256) key-pair banate hain, public
  keys exchange karte hain, aur shared AES-256-GCM key derive karte hain. Har message us
  shared key se encrypt hota hai. Server, ya beech mein koi bhi, plaintext kabhi nahi dekh
  sakta — sirf dono browser hi decrypt kar sakte hain.

## Local par chalane ke liye

```bash
npm install
npm start
```

Fir browser me `http://localhost:3000` kholo. Ek tab me code generate karo, doosre tab
(ya doosre device) me wo code daal ke join karo.

## Deploy kaise karo

Ye ek plain Node.js + Express + `ws` app hai, isiliye kisi bhi Node hosting par chal
jayega — Render, Railway, Fly.io, ek apna VPS, jo bhi. Bas:

1. Is folder ko upload/push karo.
2. Build command: `npm install`
3. Start command: `npm start`
4. HTTPS ke peeche host karo (zyadatar platforms default me karte hain) — isse browser
   `wss://` (secure WebSocket) use karega.

## Limitations / aage kya improve kar sakte ho

- Rooms sirf server ki memory me hain — server restart hone par sab codes/chats khatam ho
  jayenge (koi database nahi, jaan-boojh kar rakha hai simplicity ke liye).
- Agar koi apna browser tab band kar de, doosre insaan ko "chat chhod di" dikhega aur wo
  room turant close ho jayega — session resume nahi hota abhi.
- Multiple server instances (load balancer ke peeche) ke liye rooms ko Redis jaisi shared
  store me rakhna padega, kyunki abhi state ek hi process ki memory me hai.
