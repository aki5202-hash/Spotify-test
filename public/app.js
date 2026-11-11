// Spotify 30 秒試聽播放器 - 前端
const $ = s => document.querySelector(s);
const audio = $('#audio');
const LS_KEY = 'spp.customPlaylists.v1';
const SILENT = 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQxAADB8AhSmxhIIEVCSiJrDCQBTcu3UrAIwUdkRgQbFAZC1CQEwTJ9mjRvBA4UOLD8nKVOWfh+UlK3z/177OXrfOdKl7pyn3Xf//WreyTRUoAWgBgkOAGbZHBgG1OF6zM82DWbZaUmMBptgQhGjsyYqc9ae9XFz280948NMBWInljyzsNRFLPWdnZGWrddDsjK1unuSrVN9jJsK8KuQtQCtMBjCEtImISdNKJOopIpBFpNSMbIHCSRpRR5iakjTiyzLhchUUBwCgyKiweBv/7UsQbg8isVNoMPMjAAAA0gAAABEVFGmgqK////9bP/6XCykxBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';

const state = {
  source: null,          // 載入的 Spotify 歌單 {id,name,owner,cover,tracks,limited}
  custom: loadCustom(),  // [{id,name,tracks:[]}]
  view: null,            // {kind:'source'} | {kind:'custom', id}
  queue: [], qIndex: -1, queueKey: null,
};

/* ---------- 儲存 ---------- */
function loadCustom() { try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch { return []; } }
function saveCustom() { localStorage.setItem(LS_KEY, JSON.stringify(state.custom)); renderSidebar(); }
const uid = () => Math.random().toString(36).slice(2, 10);
const slim = t => ({ id: t.id, title: t.title, artist: t.artist, duration: t.duration, preview: t.preview, cover: t.cover });

/* ---------- 工具 ---------- */
const fmt = s => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 1800); }
const PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#2a2a34"/><text x="20" y="26" text-anchor="middle" font-size="16" fill="#777">♪</text></svg>`);

// 圖片載入失敗時重試一次，再失敗就顯示預設圖
window.imgErr = img => { if (img.dataset.retry || img.src.startsWith('data:')) { img.onerror = null; img.src = PLACEHOLDER; return; } img.dataset.retry = 1; const u = img.src; setTimeout(() => { img.src = u + (u.includes('?') ? '&' : '?') + 'r=1'; }, 800); };
['#nowCover', '#viewCover'].forEach(s => $(s).addEventListener('error', e => { if (!e.target.src.startsWith('data:')) e.target.src = PLACEHOLDER; }));

/* ---------- 補齊封面（每首歌的 embed 才有封面） ---------- */
const detailsCache = new Map(); // id -> {cover, preview}
const inflight = new Map();
let coverQueue = [], coverActive = 0;
function ensureDetails(track) {
  const c = detailsCache.get(track.id);
  if (c) { applyDetails(track.id, c); return Promise.resolve(track); }
  if (inflight.has(track.id)) return inflight.get(track.id);
  const p = new Promise(resolve => { coverQueue.push({ track, resolve }); pumpCovers(); });
  inflight.set(track.id, p);
  return p;
}
function pumpCovers() {
  while (coverActive < 4 && coverQueue.length) {
    const { track, resolve } = coverQueue.shift();
    coverActive++;
    fetch(`/api/track/${track.id}`).then(r => r.json()).then(d => {
      if (d && !d.error) { detailsCache.set(track.id, d); applyDetails(track.id, d); }
    }).catch(() => {}).finally(() => { coverActive--; inflight.delete(track.id); resolve(track); pumpCovers(); });
  }
}
function applyDetails(id, d) {
  const all = [...(state.source?.tracks || []), ...state.custom.flatMap(p => p.tracks), ...state.queue];
  let changed = false;
  for (const t of all) if (t.id === id) {
    if (d.cover && !t.cover) { t.cover = d.cover; changed = true; }
    if (!t.preview && d.preview) { t.preview = d.preview; changed = true; }
  }
  document.querySelectorAll(`[data-cover="${id}"]`).forEach(img => { if (d.cover) img.src = d.cover; });
  if (d.preview) document.querySelectorAll(`.track[data-id="${id}"]`).forEach(li => li.classList.remove('nopreview'));
  const cur = state.queue[state.qIndex];
  if (cur && cur.id === id && d.cover) $('#nowCover').src = d.cover;
  if (changed && state.custom.some(p => p.tracks.some(t => t.id === id))) localStorage.setItem(LS_KEY, JSON.stringify(state.custom));
}

/* ---------- 載入歌單 ---------- */
async function loadPlaylist(url) {
  const btn = $('#loadBtn');
  // 在使用者點擊的當下先「解鎖」audio，避免瀏覽器擋自動播放（特別是 Safari / iOS）
  try { audio.src = SILENT; audio.play().catch(() => {}); } catch {}
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 載入中…';
  try {
    const r = await fetch('/api/playlist?url=' + encodeURIComponent(url));
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || '載入失敗');
    if (!d.tracks.length) throw new Error('這個歌單沒有可播放的歌曲');
    state.source = d;
    localStorage.setItem('spp.lastUrl', url);
    showView({ kind: 'source' });
    renderSidebar();
    const withPrev = d.tracks.filter(t => t.preview).length;
    toast(`已載入 ${d.tracks.length} 首，${withPrev} 首有試聽`);
    playList(d.tracks, 0, 'source');
  } catch (e) {
    audio.pause();
    toast('❌ ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = '載入並播放';
  }
}

/* ---------- 畫面 ---------- */
function currentViewTracks() {
  if (!state.view) return [];
  if (state.view.kind === 'source') return state.source?.tracks || [];
  return state.custom.find(p => p.id === state.view.id)?.tracks || [];
}
function viewKey() { return state.view?.kind === 'source' ? 'source' : 'custom:' + state.view?.id; }

function showView(view) {
  state.view = view;
  $('#emptyState').classList.add('hidden');
  $('#viewSection').classList.remove('hidden');
  const isCustom = view.kind === 'custom';
  const pl = isCustom ? state.custom.find(p => p.id === view.id) : state.source;
  if (!pl) { state.view = null; $('#viewSection').classList.add('hidden'); $('#emptyState').classList.remove('hidden'); renderSidebar(); return; }
  const tracks = pl.tracks;
  $('#viewType').textContent = isCustom ? '我的歌單' : 'Spotify 歌單';
  $('#viewTitle').textContent = pl.name;
  const n = tracks.length, p = tracks.filter(t => t.preview).length;
  $('#viewSub').textContent = isCustom ? `${n} 首歌曲` : `${pl.owner ? pl.owner + ' · ' : ''}${n} 首歌曲 · ${p} 首有 30 秒試聽`;
  $('#viewCover').src = isCustom ? (tracks.find(t => t.cover)?.cover || PLACEHOLDER) : (pl.cover || PLACEHOLDER);
  $('#renameBtn').classList.toggle('hidden', !isCustom);
  $('#deleteBtn').classList.toggle('hidden', !isCustom);
  const os = $('#openSpotify');
  os.classList.toggle('hidden', isCustom);
  if (!isCustom) os.href = `https://open.spotify.com/${pl.type || 'playlist'}/${pl.id}`;
  const notice = $('#notice');
  if (!isCustom && pl.limited) { notice.textContent = '提示：Spotify 公開嵌入頁面最多只提供前 100 首歌曲，超過的部分無法載入。'; notice.classList.remove('hidden'); }
  else if (isCustom && !n) { notice.textContent = '這個歌單還是空的。到來源歌單按歌曲旁的 ＋ 就能加入。'; notice.classList.remove('hidden'); }
  else notice.classList.add('hidden');
  renderTracks();
  renderSidebar();
}

function renderTracks() {
  const tracks = currentViewTracks();
  const isCustom = state.view?.kind === 'custom';
  const ol = $('#trackList');
  const cur = state.queue[state.qIndex];
  const playingHere = (state.queueKey || '').split(':shuffle')[0] === viewKey();
  ol.innerHTML = tracks.map((t, i) => {
    const isCur = playingHere && cur && cur.id === t.id;
    return `<li class="track ${isCur ? 'current' : ''} ${t.preview ? '' : 'nopreview'} ${audio.paused ? 'paused' : ''}" data-i="${i}" data-id="${t.id}">
      <span class="t-num">${isCur ? '<span class="eq"><i></i><i></i><i></i></span>' : i + 1}</span>
      <span class="t-main"><img class="t-cover" data-cover="${t.id}" src="${esc(t.cover || PLACEHOLDER)}" alt="" loading="lazy" onerror="imgErr(this)" />
        <span class="t-text"><div class="t-title">${esc(t.title)}${t.preview ? '' : '<span class="badge">無試聽</span>'}</div><div class="t-artist">${esc(t.artist)}</div></span></span>
      <span class="t-dur">${fmt((t.duration || 0) / 1000)}</span>
      <span class="t-actions">
        <button class="icon-btn add" title="加入歌單">＋</button>
        ${isCustom ? '<button class="icon-btn remove" title="從此歌單移除">✕</button>' : ''}
      </span>
    </li>`;
  }).join('');
  tracks.forEach(t => { if (!t.cover) ensureDetails(t); });
}

function renderSidebar() {
  const s = state.source;
  const src = $('#sourceItem');
  if (s) {
    src.className = 'side-item' + (state.view?.kind === 'source' ? ' active' : '') + (state.queueKey === 'source' ? ' playing' : '');
    src.innerHTML = `<span class="thumb">${s.cover ? `<img src="${esc(s.cover)}">` : '🎵'}</span><span class="nm">${esc(s.name)}</span><span class="cnt">${s.tracks.length}</span>`;
  }
  $('#customList').innerHTML = state.custom.length ? state.custom.map(p => {
    const c = p.tracks.find(t => t.cover)?.cover;
    const active = state.view?.kind === 'custom' && state.view.id === p.id;
    return `<div class="side-item ${active ? 'active' : ''} ${state.queueKey === 'custom:' + p.id ? 'playing' : ''}" data-pl="${p.id}">
      <span class="thumb">${c ? `<img src="${esc(c)}">` : '♥'}</span><span class="nm">${esc(p.name)}</span><span class="cnt">${p.tracks.length}</span></div>`;
  }).join('') : '<div class="side-item disabled">按 ＋ 建立第一個歌單</div>';
}

/* ---------- 播放 ---------- */
function playList(tracks, startIndex, key) {
  state.queue = tracks.map(t => t); // 同一物件參照，封面補齊會同步
  state.queueKey = key;
  playIndex(startIndex, 1);
}

function playIndex(i, dir = 1) {
  const q = state.queue;
  if (!q.length) return;
  // 跳過沒有試聽的歌
  let tries = 0;
  while (tries < q.length) {
    if (i < 0 || i >= q.length) { stopAtEnd(); return; }
    if (q[i].preview) break;
    i += dir; tries++;
  }
  if (tries >= q.length) { toast('這個歌單沒有可播放的試聽'); return; }
  state.qIndex = i;
  const t = q[i];
  audio.src = t.preview;
  audio.play().catch(err => { if (err.name === "AbortError") return; console.warn(err); updatePlayBtn(); toast('請按 ▶ 開始播放'); });
  updateNow();
  ensureDetails(t);
  // 預先抓下一首的封面
  if (q[i + 1]) ensureDetails(q[i + 1]);
}

function stopAtEnd() {
  audio.pause();
  toast('已播完整個歌單');
  updatePlayBtn();
}

function updateNow() {
  const t = state.queue[state.qIndex];
  $('#nowTitle').textContent = t ? t.title : '—';
  $('#nowArtist').textContent = t ? t.artist : '';
  $('#nowCover').src = t?.cover || PLACEHOLDER;
  $('#nowAddBtn').disabled = !t;
  document.title = t ? `▶ ${t.title} - ${t.artist}` : 'Spotify 試聽播放器';
  if ('mediaSession' in navigator && t) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, artwork: t.cover ? [{ src: t.cover, sizes: '300x300' }] : [] });
  }
  renderTracks(); renderSidebar(); updatePlayBtn();
}
function updatePlayBtn() {
  $('#playBtn').textContent = audio.paused ? '▶' : '⏸';
  document.querySelectorAll('.track').forEach(li => li.classList.toggle('paused', audio.paused));
}
function togglePlay() {
  if (!state.queue.length) {
    const tracks = currentViewTracks();
    if (tracks.length) playList(tracks, 0, viewKey());
    return;
  }
  if (audio.paused) audio.play().catch(() => {}); else audio.pause();
}
const next = () => playIndex(state.qIndex + 1, 1);
const prev = () => { if (audio.currentTime > 3) { audio.currentTime = 0; return; } playIndex(Math.max(0, state.qIndex - 1), -1); };

audio.addEventListener('ended', () => { if (audio.src.startsWith('data:')) return; if ($('#autoNext').checked) next(); else updatePlayBtn(); });
audio.addEventListener('play', updatePlayBtn);
audio.addEventListener('pause', updatePlayBtn);
audio.addEventListener('error', () => { if (!audio.src || audio.src.startsWith('data:')) return; toast('這首試聽載入失敗，跳到下一首'); setTimeout(next, 600); });
audio.addEventListener('timeupdate', () => {
  if (audio.src.startsWith('data:')) return;
  const d = audio.duration || 30;
  $('#curTime').textContent = fmt(audio.currentTime);
  $('#durTime').textContent = fmt(d);
  $('#progressFill').style.width = (audio.currentTime / d * 100) + '%';
});
$('#progress').addEventListener('click', e => {
  const r = e.currentTarget.getBoundingClientRect();
  if (audio.duration) audio.currentTime = (e.clientX - r.left) / r.width * audio.duration;
});
$('#volume').addEventListener('input', e => { audio.volume = +e.target.value; localStorage.setItem('spp.vol', e.target.value); });
audio.volume = +(localStorage.getItem('spp.vol') || 0.8); $('#volume').value = audio.volume;
$('#playBtn').onclick = togglePlay; $('#nextBtn').onclick = next; $('#prevBtn').onclick = prev;
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('nexttrack', next);
  navigator.mediaSession.setActionHandler('previoustrack', prev);
}
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  if (e.code === 'ArrowRight' && e.shiftKey) next();
  if (e.code === 'ArrowLeft' && e.shiftKey) prev();
});

/* ---------- 自訂歌單 ---------- */
function createPlaylist(name) {
  name = (name ?? prompt('新歌單名稱', `我的歌單 ${state.custom.length + 1}`))?.trim();
  if (!name) return null;
  const p = { id: uid(), name, tracks: [] };
  state.custom.push(p); saveCustom();
  return p;
}
function addToPlaylist(pl, track) {
  if (pl.tracks.some(t => t.id === track.id)) { toast(`「${track.title}」已在「${pl.name}」裡`); return; }
  pl.tracks.push(slim(track)); saveCustom();
  toast(`已加入「${pl.name}」`);
  if (state.view?.kind === 'custom' && state.view.id === pl.id) showView(state.view);
}

function openAddMenu(track, anchor) {
  const m = $('#menu');
  m.innerHTML = `<div class="mh">加入「${esc(track.title)}」到…</div>` +
    state.custom.map(p => `<button data-pl="${p.id}">♥ ${esc(p.name)}${p.tracks.some(t => t.id === track.id) ? '<span class="ok">✓</span>' : ''}</button>`).join('') +
    (state.custom.length ? '<hr>' : '') + '<button data-new="1">＋ 新增歌單…</button>';
  m.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  const mw = 230, mh = Math.min(320, m.offsetHeight);
  m.style.left = Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw)) + 'px';
  m.style.top = (r.bottom + mh + 8 > window.innerHeight ? r.top - mh - 6 : r.bottom + 6) + 'px';
  m.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    m.classList.add('hidden');
    if (b.dataset.new) { const p = createPlaylist(); if (p) addToPlaylist(p, track); }
    else addToPlaylist(state.custom.find(p => p.id === b.dataset.pl), track);
  };
}
document.addEventListener('click', e => { if (!e.target.closest('#menu') && !e.target.closest('.add') && !e.target.closest('#nowAddBtn')) $('#menu').classList.add('hidden'); });

$('#trackList').addEventListener('click', e => {
  const li = e.target.closest('.track'); if (!li) return;
  const i = +li.dataset.i;
  const tracks = currentViewTracks();
  const t = tracks[i];
  if (e.target.closest('.add')) { e.stopPropagation(); openAddMenu(t, e.target.closest('.add')); return; }
  if (e.target.closest('.remove')) {
    const pl = state.custom.find(p => p.id === state.view.id);
    pl.tracks.splice(i, 1); saveCustom();
    if (state.queueKey === 'custom:' + pl.id) { state.queue = pl.tracks.slice(); state.qIndex = state.queue.findIndex(x => x.preview === audio.src); }
    toast(`已從「${pl.name}」移除`); showView(state.view); return;
  }
  if (!t.preview) { toast('這首歌沒有 30 秒試聽，可在 Spotify 開啟收聽'); window.open(`https://open.spotify.com/track/${t.id}`, '_blank'); return; }
  playList(tracks, i, viewKey());
});
$('#nowAddBtn').onclick = e => { const t = state.queue[state.qIndex]; if (t) openAddMenu(t, e.currentTarget); };
$('#newPlBtn').onclick = () => { const p = createPlaylist(); if (p) showView({ kind: 'custom', id: p.id }); };
$('#sourceItem').onclick = () => { if (state.source) showView({ kind: 'source' }); };
$('#customList').addEventListener('click', e => { const it = e.target.closest('[data-pl]'); if (it) showView({ kind: 'custom', id: it.dataset.pl }); });
$('#renameBtn').onclick = () => {
  const pl = state.custom.find(p => p.id === state.view.id);
  const n = prompt('重新命名歌單', pl.name)?.trim();
  if (n) { pl.name = n; saveCustom(); showView(state.view); toast('已重新命名'); }
};
$('#deleteBtn').onclick = () => {
  const pl = state.custom.find(p => p.id === state.view.id);
  if (!confirm(`確定要刪除「${pl.name}」嗎？`)) return;
  state.custom = state.custom.filter(p => p.id !== pl.id); saveCustom();
  toast('已刪除歌單');
  if (state.source) showView({ kind: 'source' }); else { state.view = null; $('#viewSection').classList.add('hidden'); $('#emptyState').classList.remove('hidden'); renderSidebar(); }
};
$('#playAllBtn').onclick = () => { const t = currentViewTracks(); if (t.length) playList(t, 0, viewKey()); };
$('#shuffleBtn').onclick = () => {
  const t = currentViewTracks().slice();
  for (let i = t.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [t[i], t[j]] = [t[j], t[i]]; }
  if (t.length) playList(t, 0, viewKey() + ':shuffle');
};

$('#loadForm').addEventListener('submit', e => { e.preventDefault(); const u = $('#urlInput').value.trim(); if (u) loadPlaylist(u); else toast('請先貼上 Spotify 歌單網址'); });
$('#demoBtn').onclick = () => { $('#urlInput').value = 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'; loadPlaylist($('#urlInput').value); };

// 支援 ?url= 參數直接帶入網址
const qp = new URLSearchParams(location.search).get('url');
$('#urlInput').value = qp || localStorage.getItem('spp.lastUrl') || '';
renderSidebar();
// ?url=...&autoload=1 會自動載入（瀏覽器可能需要再按一次 ▶ 才能出聲）
if (qp && new URLSearchParams(location.search).has('autoload')) loadPlaylist(qp);
