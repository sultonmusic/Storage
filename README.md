# Telegram Video Storage

Telegram botga video yuborasiz → video saytda chiqadi. Har bir videoning o'z sahifasi bor (`/v/<id>`),
"🔗 Ulashish" tugmasi havolani nusxalaydi, video saytning o'zida ijro etiladi.

## Ishga tushirish

Node.js 18+ kerak, qo'shimcha paket yo'q.

```bash
cp .env.example .env     # BOT_TOKEN ni yozing
npm start                # http://localhost:3000
```

`.env`:

| O'zgaruvchi | Tavsif |
|---|---|
| `BOT_TOKEN` | @BotFather bergan token |
| `PUBLIC_URL` | Sayt manzili (bot javobida to'liq havola berish uchun) |
| `PORT` | Port, standart 3000 |
| `ALLOWED_USER_IDS` | Ixtiyoriy: faqat shu Telegram ID'lardan video qabul qilinadi |

## Qanday ishlaydi

- Bot `getUpdates` (long polling) orqali ishlaydi — webhook yoki domen shart emas.
- Videolar Telegram serverlarida qoladi; saytda faqat `file_id` saqlanadi (`data/videos.json`).
- Sayt videoni Telegram'dan proxy qilib beradi (`/stream/<id>`), shuning uchun token brauzerga chiqmaydi. Oldinga/orqaga surish (Range) ishlaydi.
- **Cheklov:** Telegram Bot API faqat **20 MB** gacha fayllarni yuklab olishga ruxsat beradi.

## Deploy

Doimiy ishlaydigan har qanday Node hosting (VPS, Render, Railway, Fly.io).
`data/` papkasi saqlanib qolishi kerak (persistent disk), aks holda ro'yxat yo'qoladi.

## Bepul variant: Cloudflare Workers (tavsiya)

Karta shart emas, uxlab qolmaydi, ma'lumot KV'da saqlanadi. Kod: `cloudflare/worker.js` (bitta fayl).

1. https://dash.cloudflare.com da ro'yxatdan o'ting.
2. **Storage & Databases → KV → Create** — nomi `videos`.
3. **Workers & Pages → Create → Start with Hello World → Deploy**.
4. **Edit code** — `cloudflare/worker.js` ichidagini to'liq qo'yib, **Deploy**.
5. Worker **Settings → Bindings → Add → KV namespace**: Variable name `DB`, namespace `videos`.
6. **Settings → Variables and Secrets → Add**: Type `Secret`, nomi `BOT_TOKEN`, qiymati bot tokeni.
7. Brauzerda `https://<worker-nomi>.<sizning-nom>.workers.dev/setup` ni bir marta oching — "✅ Tayyor" chiqadi.

Sayt manzili: `https://<worker-nomi>.<sizning-nom>.workers.dev`

> Worker webhook ishlatadi, `server.js` esa polling. Ikkalasini bir vaqtda ishlatmang.
