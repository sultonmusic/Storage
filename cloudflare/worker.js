// Telegram Video Storage — Cloudflare Worker versiyasi.
// Kerak: KV binding nomi `DB`, secret `BOT_TOKEN`. Keyin /setup sahifasini bir marta oching.

const MAX_SIZE = 20 * 1024 * 1024; // Bot API getFile limiti

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function tg(env, method, params = {}) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method}: ${json.description}`);
  return json.result;
}

const getList = async (env) => (await env.DB.get('list', 'json')) || [];
const getVideo = (env, id) => env.DB.get(`v:${id}`, 'json');

function publicVideo(v) {
  const { id, title, duration, size, date, thumb_file_id } = v;
  return { id, title, duration, size, date, hasThumb: !!thumb_file_id };
}

// --- bot ---------------------------------------------------------------------

async function handleMessage(env, origin, msg) {
  const chatId = msg.chat.id;
  const userId = String(msg.from && msg.from.id);
  const allowed = (env.ALLOWED_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const reply = (text) => tg(env, 'sendMessage', { chat_id: chatId, reply_to_message_id: msg.message_id, text });

  if (msg.text && msg.text.startsWith('/start')) {
    return reply(`Salom! Menga video yuboring — u saytda paydo bo'ladi.\n${origin}`);
  }

  const media =
    msg.video ||
    msg.animation ||
    msg.video_note ||
    (msg.document && /^video\//.test(msg.document.mime_type || '') ? msg.document : null);
  if (!media) return;

  if (allowed.length && !allowed.includes(userId)) return reply("Sizga video yuklashga ruxsat yo'q.");
  if (media.file_size > MAX_SIZE) {
    return reply('Video 20 MB dan katta. Telegram Bot API faqat 20 MB gacha fayllarni berishga ruxsat beradi.');
  }

  let id = await env.DB.get(`u:${media.file_unique_id}`);
  if (!id) {
    id = [...crypto.getRandomValues(new Uint8Array(5))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const v = {
      id,
      file_id: media.file_id,
      title: (msg.caption || media.file_name || '').trim() || `Video ${new Date(msg.date * 1000).toISOString().slice(0, 10)}`,
      duration: media.duration || 0,
      mime: media.mime_type || 'video/mp4',
      size: media.file_size || 0,
      thumb_file_id: (media.thumbnail || media.thumb || {}).file_id || null,
      date: msg.date * 1000,
    };
    await env.DB.put(`v:${id}`, JSON.stringify(v));
    await env.DB.put(`u:${media.file_unique_id}`, id);
    const list = await getList(env);
    list.unshift(publicVideo(v));
    await env.DB.put('list', JSON.stringify(list));
  }
  return reply(`✅ Saytga qo'shildi:\n${origin}/v/${id}`);
}

// --- telegram file proxy (token brauzerga chiqmaydi) --------------------------

const pathCache = new Map();

async function proxyFile(env, request, fileId, contentType) {
  let c = pathCache.get(fileId);
  if (!c || c.exp < Date.now()) {
    const f = await tg(env, 'getFile', { file_id: fileId });
    c = { path: f.file_path, exp: Date.now() + 50 * 60 * 1000 };
    pathCache.set(fileId, c);
  }
  const headers = {};
  const range = request.headers.get('range');
  if (range) headers.range = range;
  const up = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${c.path}`, { headers });
  if (!up.ok) {
    pathCache.delete(fileId);
    return new Response('Telegram fayl xatosi', { status: 502 });
  }
  const out = new Headers({
    'content-type': contentType || up.headers.get('content-type') || 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=3600',
  });
  for (const h of ['content-length', 'content-range']) if (up.headers.get(h)) out.set(h, up.headers.get(h));
  return new Response(request.method === 'HEAD' ? null : up.body, { status: up.status, headers: out });
}

// --- html --------------------------------------------------------------------

const CSS = `:root{--bg:#f6f7f9;--card:#fff;--text:#16181d;--muted:#6b7280;--accent:#229ed9;--border:#e5e7eb}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#1a1d23;--text:#e8eaed;--muted:#9aa0a6;--border:#2a2e36}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{padding:14px 16px;border-bottom:1px solid var(--border);background:var(--card);position:sticky;top:0;z-index:5}
.logo{color:var(--text);text-decoration:none;font-weight:700;font-size:18px}
main{max-width:1200px;margin:0 auto;padding:16px}.hint,.empty{color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden;display:flex;flex-direction:column}
.thumb{position:relative;display:flex;align-items:center;justify-content:center;aspect-ratio:16/9;background:#000}
.thumb img{width:100%;height:100%;object-fit:cover}.play{color:#fff;font-size:36px;opacity:.8}
.dur{position:absolute;right:6px;bottom:6px;background:rgba(0,0,0,.75);color:#fff;font-size:12px;padding:1px 6px;border-radius:4px}
.body{padding:10px 12px 12px;display:flex;flex-direction:column;gap:8px;flex:1}
.title{color:var(--text);text-decoration:none;font-weight:600;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:auto}.meta{color:var(--muted);font-size:13px}
.btn{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:9px 14px;font:inherit;font-weight:600;cursor:pointer;white-space:nowrap}
.btn.small{padding:6px 10px;font-size:13px}.watch{max-width:960px}
.watch video{width:100%;max-height:75vh;background:#000;border-radius:12px;display:block}
.watch h1{font-size:20px;margin:14px 0 8px;overflow-wrap:anywhere}
.toast{position:fixed;left:50%;bottom:24px;transform:translate(-50%,20px);background:#16181d;color:#fff;padding:10px 16px;border-radius:8px;opacity:0;transition:.2s;pointer-events:none}
.toast.show{opacity:1;transform:translate(-50%,0)}`;

const JS = `function fmtDur(s){s=Math.round(s||0);return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')}
function fmtSize(b){return b?(b/1048576).toFixed(1)+' MB':''}
function fmtDate(t){return new Date(t).toLocaleDateString('uz-UZ',{day:'numeric',month:'short',year:'numeric'})}
function toast(x){const t=document.getElementById('toast');t.textContent=x;t.classList.add('show');clearTimeout(t._h);t._h=setTimeout(()=>t.classList.remove('show'),2000)}
async function copyLink(id){const url=location.origin+'/v/'+id;try{await navigator.clipboard.writeText(url)}catch(e){const a=document.createElement('textarea');a.value=url;a.style.position='fixed';a.style.opacity='0';document.body.appendChild(a);a.select();document.execCommand('copy');a.remove()}toast('Havola nusxalandi ✓')}
function el(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
async function renderList(){const grid=document.getElementById('grid');const vs=await fetch('/api/videos').then(r=>r.json());document.getElementById('empty').hidden=vs.length>0;
for(const v of vs){const card=el('div','card');const a=el('a','thumb');a.href='/v/'+v.id;
if(v.hasThumb){const i=el('img');i.src='/thumb/'+v.id;i.loading='lazy';i.alt='';a.append(i)}else a.append(el('span','play','▶'));
if(v.duration)a.append(el('span','dur',fmtDur(v.duration)));const b=el('div','body');const t=el('a','title',v.title);t.href='/v/'+v.id;
const r=el('div','row');r.append(el('span','meta',fmtDate(v.date)));const btn=el('button','btn small','🔗 Ulashish');btn.onclick=()=>copyLink(v.id);r.append(btn);
b.append(t,r);card.append(a,b);grid.append(card)}}
function renderWatch(v){const p=document.getElementById('player');p.src='/stream/'+v.id;if(v.hasThumb)p.poster='/thumb/'+v.id;
document.getElementById('title').textContent=v.title;document.getElementById('meta').textContent=[fmtDate(v.date),v.duration&&fmtDur(v.duration),fmtSize(v.size)].filter(Boolean).join(' · ');
document.getElementById('share').onclick=()=>copyLink(v.id)}`;

function page(head, body, script) {
  return new Response(
    `<!doctype html><html lang="uz"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${head}<style>${CSS}</style></head>
<body><header><a href="/" class="logo">▶ Video Storage</a></header>${body}<div id="toast" class="toast"></div><script>${JS}</script><script>${script}</script></body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}

const indexPage = () =>
  page(
    '<title>Video Storage</title>',
    `<main><p class="hint">Telegram botga video yuboring — u shu yerda paydo bo'ladi.</p><div id="grid" class="grid"></div><p id="empty" class="empty" hidden>Hozircha video yo'q.</p></main>`,
    'renderList()'
  );

function watchPage(origin, v) {
  const head = [
    `<title>${esc(v.title)}</title>`,
    `<meta property="og:title" content="${esc(v.title)}">`,
    `<meta property="og:type" content="video.other">`,
    `<meta property="og:url" content="${origin}/v/${v.id}">`,
    `<meta property="og:video" content="${origin}/stream/${v.id}">`,
    `<meta property="og:video:type" content="${esc(v.mime)}">`,
    v.thumb_file_id ? `<meta property="og:image" content="${origin}/thumb/${v.id}">` : '',
  ].join('');
  return page(
    head,
    `<main class="watch"><video id="player" controls playsinline preload="metadata"></video><div class="info"><h1 id="title"></h1><div class="row"><span id="meta" class="meta"></span><button id="share" class="btn">🔗 Ulashish</button></div></div></main>`,
    `renderWatch(${JSON.stringify(publicVideo(v)).replace(/</g, '\\u003c')})`
  );
}

// --- router ------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = url.origin;
    const p = url.pathname;
    let m;

    if (!env.BOT_TOKEN || !env.DB) {
      return new Response('Sozlanmagan: BOT_TOKEN secret va DB (KV) binding qo\'shing.', { status: 500 });
    }

    try {
      if (p === '/webhook' && request.method === 'POST') {
        const secret = (await sha256(env.BOT_TOKEN)).slice(0, 32);
        if (request.headers.get('x-telegram-bot-api-secret-token') !== secret) return new Response('forbidden', { status: 403 });
        const update = await request.json();
        const msg = update.message || update.channel_post;
        if (msg) ctx.waitUntil(handleMessage(env, origin, msg).catch((e) => console.error(e.message)));
        return new Response('ok');
      }
      if (p === '/setup') {
        const secret = (await sha256(env.BOT_TOKEN)).slice(0, 32);
        await tg(env, 'setWebhook', {
          url: `${origin}/webhook`,
          secret_token: secret,
          allowed_updates: ['message', 'channel_post'],
        });
        const me = await tg(env, 'getMe');
        return new Response(`✅ Tayyor! @${me.username} endi ${origin} ga ulangan.\nBotga video yuboring.`, {
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      }
      if (p === '/') return indexPage();
      if (p === '/api/videos') return Response.json(await getList(env));
      if ((m = p.match(/^\/v\/([a-f0-9]+)$/))) {
        const v = await getVideo(env, m[1]);
        return v ? watchPage(origin, v) : new Response('Video topilmadi', { status: 404 });
      }
      if ((m = p.match(/^\/stream\/([a-f0-9]+)$/))) {
        const v = await getVideo(env, m[1]);
        return v ? await proxyFile(env, request, v.file_id, v.mime) : new Response('Topilmadi', { status: 404 });
      }
      if ((m = p.match(/^\/thumb\/([a-f0-9]+)$/))) {
        const v = await getVideo(env, m[1]);
        return v && v.thumb_file_id ? await proxyFile(env, request, v.thumb_file_id, 'image/jpeg') : new Response('Topilmadi', { status: 404 });
      }
      return new Response('Topilmadi', { status: 404 });
    } catch (e) {
      return new Response('Xato: ' + e.message, { status: 500 });
    }
  },
};
