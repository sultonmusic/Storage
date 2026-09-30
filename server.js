'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

// --- config -----------------------------------------------------------------

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv(path.join(__dirname, '.env'));

const TOKEN = process.env.BOT_TOKEN;
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const ALLOWED = (process.env.ALLOWED_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'videos.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!TOKEN) {
  console.error('BOT_TOKEN topilmadi. .env faylga BOT_TOKEN=... yozing.');
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;
const FILE_API = `https://api.telegram.org/file/bot${TOKEN}`;

// --- storage ----------------------------------------------------------------

fs.mkdirSync(DATA_DIR, { recursive: true });
let videos = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : [];

function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(videos, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

const findVideo = (id) => videos.find((v) => v.id === id);

// --- telegram bot (long polling) -------------------------------------------

async function tg(method, params = {}) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method}: ${json.description}`);
  return json.result;
}

function videoLink(id) {
  return PUBLIC_URL ? `${PUBLIC_URL}/v/${id}` : `/v/${id}`;
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const userId = String(msg.from && msg.from.id);

  if (msg.text && msg.text.startsWith('/start')) {
    return tg('sendMessage', { chat_id: chatId, text: 'Salom! Menga video yuboring — u saytda paydo bo\'ladi.' });
  }

  const media =
    msg.video ||
    msg.animation ||
    msg.video_note ||
    (msg.document && /^video\//.test(msg.document.mime_type || '') ? msg.document : null);
  if (!media) return;

  if (ALLOWED.length && !ALLOWED.includes(userId)) {
    return tg('sendMessage', { chat_id: chatId, text: 'Sizga video yuklashga ruxsat yo\'q.' });
  }

  if (media.file_size && media.file_size > 20 * 1024 * 1024) {
    return tg('sendMessage', {
      chat_id: chatId,
      reply_to_message_id: msg.message_id,
      text: 'Video 20 MB dan katta. Telegram Bot API faqat 20 MB gacha fayllarni yuklab olishga ruxsat beradi.',
    });
  }

  const existing = videos.find((v) => v.file_unique_id === media.file_unique_id);
  const entry = existing || {
    id: crypto.randomBytes(5).toString('hex'),
    file_id: media.file_id,
    file_unique_id: media.file_unique_id,
    title: (msg.caption || media.file_name || '').trim() || `Video ${new Date(msg.date * 1000).toLocaleString('uz-UZ')}`,
    duration: media.duration || 0,
    width: media.width || media.length || 0,
    height: media.height || media.length || 0,
    mime: media.mime_type || 'video/mp4',
    size: media.file_size || 0,
    thumb_file_id: (media.thumbnail || media.thumb || {}).file_id || null,
    date: msg.date * 1000,
    from: msg.from ? msg.from.first_name : '',
  };
  if (!existing) {
    videos.unshift(entry);
    save();
  }

  await tg('sendMessage', {
    chat_id: chatId,
    reply_to_message_id: msg.message_id,
    text: `✅ Saytga qo'shildi:\n${videoLink(entry.id)}`,
  });
}

async function poll() {
  let offset = 0;
  // Webhook o'rnatilgan bo'lsa getUpdates ishlamaydi.
  await tg('deleteWebhook').catch((e) => console.error(e.message));
  const me = await tg('getMe');
  console.log(`Bot ishga tushdi: @${me.username}`);
  for (;;) {
    try {
      const updates = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'channel_post'] });
      for (const u of updates) {
        offset = u.update_id + 1;
        const msg = u.message || u.channel_post;
        if (msg) await handleMessage(msg).catch((e) => console.error('handleMessage:', e.message));
      }
    } catch (e) {
      console.error('poll:', e.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

// --- telegram file proxy (token never reaches the browser) -----------------

const pathCache = new Map(); // file_id -> { path, exp }

async function filePath(fileId) {
  const c = pathCache.get(fileId);
  if (c && c.exp > Date.now()) return c.path;
  const f = await tg('getFile', { file_id: fileId });
  pathCache.set(fileId, { path: f.file_path, exp: Date.now() + 50 * 60 * 1000 });
  return f.file_path;
}

async function proxyFile(req, res, fileId, contentType) {
  const fp = await filePath(fileId);
  const headers = {};
  if (req.headers.range) headers.range = req.headers.range;
  const up = await fetch(`${FILE_API}/${fp}`, { headers });
  if (!up.ok && up.status !== 206) {
    pathCache.delete(fileId);
    res.writeHead(502).end('Telegram fayl xatosi');
    return;
  }
  const out = {
    'content-type': contentType || up.headers.get('content-type') || 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=3600',
  };
  for (const h of ['content-length', 'content-range']) {
    const v = up.headers.get(h);
    if (v) out[h] = v;
  }
  res.writeHead(up.status, out);
  if (req.method === 'HEAD') return res.end();
  Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
}

// --- http server ------------------------------------------------------------

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function publicVideo(v) {
  const { id, title, duration, width, height, size, date, from, thumb_file_id } = v;
  return { id, title, duration, width, height, size, date, from, hasThumb: !!thumb_file_id };
}

function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript' };

function sendStatic(res, file) {
  const p = path.join(PUBLIC_DIR, file);
  if (!p.startsWith(PUBLIC_DIR) || !fs.existsSync(p)) return res.writeHead(404).end('Topilmadi');
  res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
}

function sendWatchPage(req, res, v) {
  const url = `${baseUrl(req)}/v/${v.id}`;
  const meta = [
    `<title>${esc(v.title)}</title>`,
    `<meta property="og:title" content="${esc(v.title)}">`,
    `<meta property="og:type" content="video.other">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:video" content="${esc(`${baseUrl(req)}/stream/${v.id}`)}">`,
    `<meta property="og:video:type" content="${esc(v.mime)}">`,
    v.thumb_file_id ? `<meta property="og:image" content="${esc(`${baseUrl(req)}/thumb/${v.id}`)}">` : '',
  ].join('\n    ');
  const html = fs
    .readFileSync(path.join(PUBLIC_DIR, 'watch.html'), 'utf8')
    .replace('<!--META-->', meta)
    .replace('__VIDEO__', JSON.stringify(publicVideo(v)).replace(/</g, '\\u003c'));
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://x');
    let m;
    if (pathname === '/') return sendStatic(res, 'index.html');
    if (pathname === '/style.css') return sendStatic(res, 'style.css');
    if (pathname === '/app.js') return sendStatic(res, 'app.js');
    if (pathname === '/api/videos') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(videos.map(publicVideo)));
    }
    if ((m = pathname.match(/^\/v\/([a-f0-9]+)$/))) {
      const v = findVideo(m[1]);
      return v ? sendWatchPage(req, res, v) : res.writeHead(404).end('Video topilmadi');
    }
    if ((m = pathname.match(/^\/stream\/([a-f0-9]+)$/))) {
      const v = findVideo(m[1]);
      return v ? await proxyFile(req, res, v.file_id, v.mime) : res.writeHead(404).end();
    }
    if ((m = pathname.match(/^\/thumb\/([a-f0-9]+)$/))) {
      const v = findVideo(m[1]);
      return v && v.thumb_file_id ? await proxyFile(req, res, v.thumb_file_id, 'image/jpeg') : res.writeHead(404).end();
    }
    res.writeHead(404).end('Topilmadi');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500).end('Server xatosi');
    else res.destroy();
  }
});

server.listen(PORT, () => console.log(`Sayt: http://localhost:${PORT}`));
poll().catch((e) => {
  console.error('Bot ishga tushmadi:', e.message);
  process.exit(1);
});
