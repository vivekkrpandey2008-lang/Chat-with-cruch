# Sealed — permanent-code, two-person, end-to-end encrypted chat

## Ab kaise kaam karta hai (WhatsApp jaisa)

- Tum aur tumhara dost khud apna code chunte ho, jaise `#love79`. Jo pehle aata hai wo
  "slot 1", doosra "slot 2" — sirf ye do log hi is code ko hamesha ke liye use kar sakte
  hain.
- **Koi wait nahi karna padta.** Pehla insaan aake apna naam bhar ke, code bana ke turant
  message bhejna shuru kar sakta hai — chahe doosra abhi tak kabhi aaya hi na ho. Jab doosra
  insaan baad mein wahi code use karega, use saari purani baatcheet turant dikh jayegi.
- **Ek hi continuous chat** — koi "live vs history" ka bantwara nahi. Jab dono online ho to
  live baat hoti hai, jab koi offline ho to bhi tum type kar sakte ho, aur wapas aane par
  wahi se continue hota hai.
- **Apna bheja hua message galat ho gaya?** Us par tap karo — "Delete karna hai?" poochega,
  haan bolne par wo dono taraf se hamesha ke liye hat jayega. Sirf apne bheje hue messages
  delete kar sakte ho.

## Encryption

Encryption key seedha tumhare code se hi nikali jaati hai (PBKDF2). Server ko ye key kabhi
nahi pata chalti. Jab tak sirf tum dono hi code jaante ho, sirf tum dono hi chat padh sakte
ho. Isliye code jitna zyada unique/random hoga, utna zyada surakshit — casual chat ke liye
`#love79` jaisa memorable code theek hai, kuch zyada private ke liye lamba random code
chuno.

## Zaroori: ek free Postgres database chahiye

1. Render dashboard mein **"New +" → "PostgreSQL"** dabao, Free plan choose karo.
2. **"Internal Database URL"** copy karo.
3. Apni web service ke **"Environment"** tab mein `DATABASE_URL` naam se ek variable add
   karo, value wahi URL.
4. Save karo — service khud restart ho jayegi.

## Local par chalane ke liye

```bash
npm install
DATABASE_URL=postgres://user:pass@host:5432/dbname npm start
```

## Limitations

- No-login app hai, isliye "same insaan hai ya nahi" pehchanne ke liye browser ki local
  storage use hoti hai. Browser data clear karne ya naye device se aane par purana code
  "third person" jaisa treat ho sakta hai.
- Delete kiya hua message hamesha ke liye chala jata hai, wapas nahi aata.
- 
