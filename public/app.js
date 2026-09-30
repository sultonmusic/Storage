function fmtDur(s) {
  s = Math.round(s || 0);
  const m = Math.floor(s / 60), sec = String(s % 60).padStart(2, '0');
  return m + ':' + sec;
}
function fmtSize(b) {
  return b ? (b / 1048576).toFixed(1) + ' MB' : '';
}
function fmtDate(t) {
  return new Date(t).toLocaleDateString('uz-UZ', { day: 'numeric', month: 'short', year: 'numeric' });
}
function toast(text) {
  const t = document.getElementById('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2000);
}
async function copyLink(id) {
  const url = location.origin + '/v/' + id;
  try {
    await navigator.clipboard.writeText(url);
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = url;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Havola nusxalandi ✓');
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

async function renderList() {
  const grid = document.getElementById('grid');
  const videos = await fetch('/api/videos').then((r) => r.json());
  document.getElementById('empty').hidden = videos.length > 0;
  grid.replaceChildren();
  for (const v of videos) {
    const card = el('div', 'card');
    const link = el('a', 'thumb');
    link.href = '/v/' + v.id;
    if (v.hasThumb) {
      const img = el('img');
      img.src = '/thumb/' + v.id;
      img.loading = 'lazy';
      img.alt = '';
      link.append(img);
    } else {
      link.append(el('span', 'play', '▶'));
    }
    if (v.duration) link.append(el('span', 'dur', fmtDur(v.duration)));
    const body = el('div', 'body');
    const title = el('a', 'title', v.title);
    title.href = '/v/' + v.id;
    const row = el('div', 'row');
    row.append(el('span', 'meta', fmtDate(v.date)));
    const btn = el('button', 'btn small', '🔗 Ulashish');
    btn.onclick = () => copyLink(v.id);
    row.append(btn);
    body.append(title, row);
    card.append(link, body);
    grid.append(card);
  }
}

function renderWatch(v) {
  const p = document.getElementById('player');
  p.src = '/stream/' + v.id;
  if (v.hasThumb) p.poster = '/thumb/' + v.id;
  document.getElementById('title').textContent = v.title;
  document.getElementById('meta').textContent =
    [fmtDate(v.date), v.duration && fmtDur(v.duration), fmtSize(v.size)].filter(Boolean).join(' · ');
  document.getElementById('share').onclick = () => copyLink(v.id);
}
