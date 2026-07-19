# Sealed — permanent-code, two-person, end-to-end encrypted chat

## Naya kya hai is version mein

- **Koi random code generate nahi hota.** Tum aur tumhara dost khud apna code chunte ho,
  jaise `#love79` ya `#iron25`. Jo bhi sabse pehle us code se aata hai wo "slot 1" ban jata
  hai, doosra "slot 2". Us ke baad koi teesra insaan wahi code use nahi kar sakta — hamesha
  ke liye sirf tum dono ke liye lock ho jata hai.
- **Code kabhi expire nahi hota.** Dono log jab bhi chaho, wapas aake wahi code daal ke
  usi chat mein pahunch sakte ho.
- **Chat history save rehti hai.** Jab bhi koi ek insaan chat chhodta hai (button dabata
  hai, ya tab band kar deta hai / internet chala jata hai), wo poori baatcheet **History**
  tab mein chali jaati hai — delete nahi hoti. Dono log kabhi bhi History dekh sakte hain,
  chahe doosra online ho ya na ho.
- **Live vs History**: jab dono log ek saath online hote hain to "Chat" tab mein live
  baatcheet hoti hai. Jaise hi koi ek leave karta hai, wahi conversation History mein move
  ho jaati hai aur agli baar dono online aane par ek naya, khaali "Chat" tab shuru hota hai.

## Encryption kaise kaam karta hai

Pehle wale version mein dono browsers har session mein naya key-exchange karte the. Ab
zarurat hai ki purani history bhi baad mein padhi ja sake, isliye encryption key seedha
**tumhare code se hi nikali jaati hai** (PBKDF2 se) — server ko ye key kabhi pata nahi
chalti, aur na hi wo network par kahin bhejni padti hai. Jab tak sirf tum dono hi apna
code jaante ho, sirf tum dono hi apni chat padh sakte ho.

**Zaroori baat**: iska matlab hai ki security poori tarah tumhare code ki secrecy par
depend karti hai. `#love79` jaisa easy-to-guess code kisi normal password jitna hi surakshit
hai — kisi bahut confidential cheez ke liye lamba, random-sa code chuno (jaise
`#nx7qLmZ42`), casual chat ke liye chhota memorable code chalega.

## Zaroori: ek free Postgres database chahiye

History permanently save rakhne ke liye ab ek database chahiye (pehle sab kuch server ki
memory mein tha, isliye restart hone par chat gayab ho jaati thi). Render par ye free hai:

1. Render dashboard mein **"New +" → "PostgreSQL"** dabao.
2. Naam kuch bhi do, **Free** plan select karo, **Create Database** dabao.
3. Database ready hone ke baad, **"Internal Database URL"** copy karo.
4. Apni web service (jo chat app chala rahi hai) ke **"Environment"** tab mein jao.
5. Ek naya environment variable add karo:
   - Key: `DATABASE_URL`
   - Value: wahi Internal Database URL jo copy kiya tha
6. Save karo — service khud restart ho jayegi aur database se connect ho jayegi.

Render ka free Postgres 30 din ke baad expire hota hai (agar upgrade na karo), jo hamare
"kam se kam 1 hafta" requirement se kaafi zyada hai.

## Local par chalane ke liye

```bash
npm install
DATABASE_URL=postgres://user:pass@host:5432/dbname npm start
```

## Deploy / update

README ke purane version mein bataya gaya GitHub + Render process wahi rahega — bas is
baar `DATABASE_URL` environment variable add karna mat bhoolna, warna app crash ho jayegi.

## Limitations

- Ye no-login app hai, isliye "same insaan hai ya nahi" pehchanne ke liye browser ki
  local storage use hoti hai. Agar koi apna browser data clear kar de ya bilkul naye
  device se aaye, wo apne hi purane code par "third person" jaisa treat ho sakta hai.
- History storage abhi hamesha ke liye rakhi jaati hai (koi auto-delete nahi) — agar aage
  jaake purani chats khud-ba-khud delete karni ho (jaise 90 din baad), wo add kiya ja
  sakta hai.
  
