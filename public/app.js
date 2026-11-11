// Spotify 30 秒試聽播放器 - 前端
const $ = s => document.querySelector(s);
const audio = $('#audio');
const videoEl = $('#nowVideo');
const LS_KEY = 'spp.customPlaylists.v1';
const SILENT = 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQxAADB8AhSmxhIIEVCSiJrDCQBTcu3UrAIwUdkRgQbFAZC1CQEwTJ9mjRvBA4UOLD8nKVOWfh+UlK3z/177OXrfOdKl7pyn3Xf//WreyTRUoAWgBgkOAGbZHBgG1OF6zM82DWbZaUmMBptgQhGjsyYqc9ae9XFz280948NMBWInljyzsNRFLPWdnZGWrddDsjK1unuSrVN9jJsK8KuQtQCtMBjCEtImISdNKJOopIpBFpNSMbIHCSRpRR5iakjTiyzLhchUUBwCgyKiweBv/7UsQbg8isVNoMPMjAAAA0gAAABEVFGmgqK////9bP/6XCykxBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';

audio.loop = false;
videoEl.muted = true;
videoEl.loop = true;
videoEl.playsInline = true;

const state = {
  source: null,          // 載入的 Spotify 歌單 {id,name,owner,cover,tracks,limited}
  custom: loadCustom(),  // [{id,name,tracks:[]}]
  view: null,            // {kind:'source'} | {kind:'custom', id}
  queue: [], qIndex: -1, queueKey: null,
};

let liveToken = 0;
let ignoreEnded = false;
let ignoreTimer = 0;
let userSeek = false;
let userSeekTimer = 0;
let lastSample = { t: 0, id: '' };
let storageWarned = false;
let sheetTrack = null;
let modalResolver = null;

/* ---------- 儲存 ---------- */
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } }
function loadCustom() { try { return JSON.parse(lsGet(LS_KEY)) || []; } catch { return []; } }
function saveCustom() {
  if (!lsSet(LS_KEY, JSON.stringify(state.custom)) && !storageWarned) {
    storageWarned = true;
    toast('這個瀏覽器無法保存歌單，這次的變更只留在目前分頁');
  }
  renderSidebar();
}
const uid = () => Math.random().toString(36).slice(2, 10);
const slim = t => ({ id: t.id, title: t.title, artist: t.artist, duration: t.duration, preview: t.preview, cover: t.cover, video: t.video || null, videoThumb: t.videoThumb || null });

/* ---------- 工具 ---------- */
const fmt = s => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 1800); }
const PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#2a2a34"/><text x="20" y="26" text-anchor="middle" font-size="16" fill="#777">♪</text></svg>`);

window.imgErr = img => { if (img.dataset.retry || img.src.startsWith('data:')) { img.onerror = null; img.src = PLACEHOLDER; return; } img.dataset.retry = 1; const u = img.src; setTimeout(() => { img.src = u + (u.includes('?') ? '&' : '?') + 'r=1'; }, 800); };
['#nowCover', '#viewCover'].forEach(s => $(s).addEventListener('error', e => { if (!e.target.src.startsWith('data:')) e.target.src = PLACEHOLDER; }));

function markUserSeek() {
  userSeek = true;
  clearTimeout(userSeekTimer);
  userSeekTimer = setTimeout(() => { userSeek = false; }, 800);
}

// 第一次使用者點擊時用同一個 <audio> 解鎖，之後換歌不能再建新的元素
function unlockAudio() {
  audio.loop = false;
  if (audio.dataset.unlocked === '1') return;
  const src = audio.getAttribute('src') || '';
  if (!src) audio.src = SILENT;
  const p = audio.play();
  if (p) p.then(() => { audio.dataset.unlocked = '1'; }).catch(() => {});
  else audio.dataset.unlocked = '1';
}

/* ---------- 畫面：封面或短片 ---------- */
function showVisual(track) {
  const url = track && track.video;
  if (url) {
    if (videoEl.dataset.src !== url) {
      videoEl.dataset.src = url;
      videoEl.src = url;
      videoEl.muted = true;
      videoEl.loop = true;
      const p = videoEl.play();
      if (p) p.catch(() => {});
    }
    videoEl.classList.remove('hidden');
    $('#nowCover').classList.add('hidden');
    document.documentElement.style.setProperty('--player-h', '160px');
  } else {
    if (videoEl.dataset.src) {
      videoEl.pause();
      videoEl.removeAttribute('src');
      videoEl.load();
      videoEl.dataset.src = '';
    }
    videoEl.classList.add('hidden');
    $('#nowCover').classList.remove('hidden');
    $('#nowCover').src = (track && (track.cover || track.videoThumb)) || PLACEHOLDER;
    document.documentElement.style.setProperty('--player-h', '92px');
  }
}
videoEl.addEventListener('error', () => {
  const t = state.queue[state.qIndex];
  if (t) t.video = null;
  showVisual(t);
});

/* ---------- 補齊封面與公開短片 ---------- */
const detailsCache = new Map();
const inflight = new Map();
let coverQueue = [], coverActive = 0;
function ensureDetails(track) {
  if (!track) return Promise.resolve(track);
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
    if (d.video && !t.video) { t.video = d.video; changed = true; }
    if (d.videoThumb && !t.videoThumb) { t.videoThumb = d.videoThumb; changed = true; }
  }
  document.querySelectorAll(`[data-cover="${id}"]`).forEach(img => { if (d.cover) img.src = d.cover; });
  if (d.preview) document.querySelectorAll(`.track[data-id="${id}"]`).forEach(li => li.classList.remove('nopreview'));
  if (d.video) document.querySelectorAll(`.track[data-id="${id}"] .t-title`).forEach(title => {
    if (!title.querySelector('.badge.clip')) title.insertAdjacentHTML('beforeend', '<span class="badge clip">短片</span>');
  });
  const cur = state.queue[state.qIndex];
  if (cur && cur.id === id) showVisual(cur);
  if (changed && state.custom.some(p => p.tracks.some(t => t.id === id))) lsSet(LS_KEY, JSON.stringify(state.custom));
}

/* ---------- 載入歌單 ---------- */
async function loadPlaylist(url) {
  const btn = $('#loadBtn');
  unlockAudio();
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 載入中…';
  try {
    const r = await fetch('/api/playlist?url=' + encodeURIComponent(url));
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || '載入失敗');
    if (!d.tracks.length) throw new Error('這個歌單沒有可播放的歌曲');
    state.source = d;
    lsSet('spp.lastUrl', url);
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
        <span class="t-text"><div class="t-title">${esc(t.title)}${t.preview ? '' : '<span class="badge">無試聽</span>'}${t.video ? '<span class="badge clip">短片</span>' : ''}</div><div class="t-artist">${esc(t.artist)}</div></span></span>
      <span class="t-dur">${fmt((t.duration || 0) / 1000)}</span>
      <span class="t-actions">
        <button type="button" class="icon-btn add" title="加入歌單" aria-label="加入歌單">＋</button>
        ${isCustom ? '<button type="button" class="icon-btn remove" title="從此歌單移除" aria-label="移除">✕</button>' : ''}
      </span>
    </li>`;
  }).join('');
  tracks.forEach(t => { if (!detailsCache.has(t.id)) ensureDetails(t); });
}

function renderSidebar() {
  const s = state.source;
  const src = $('#sourceItem');
  if (s) {
    src.className = 'side-item' + (state.view?.kind === 'source' ? ' active' : '') + (state.queueKey === 'source' ? ' playing' : '');
    src.innerHTML = `<span class="thumb">${s.cover ? `<img src="${esc(s.cover)}" alt="">` : '🎵'}</span><span class="nm">${esc(s.name)}</span><span class="cnt">${s.tracks.length}</span>`;
  }
  $('#customList').innerHTML = state.custom.length ? state.custom.map(p => {
    const c = p.tracks.find(t => t.cover)?.cover;
    const active = state.view?.kind === 'custom' && state.view.id === p.id;
    const playing = (state.queueKey || '').split(':shuffle')[0] === 'custom:' + p.id;
    return `<div class="side-item ${active ? 'active' : ''} ${playing ? 'playing' : ''}" data-pl="${p.id}">
      <span class="thumb">${c ? `<img src="${esc(c)}" alt="">` : '♥'}</span><span class="nm">${esc(p.name)}</span><span class="cnt">${p.tracks.length}</span></div>`;
  }).join('') : '<div class="side-item disabled">按 ＋ 建立第一個歌單</div>';
}

/* ---------- 播放（永遠重用同一個已解鎖的 audio） ---------- */
function playList(tracks, startIndex, key) {
  state.queue = tracks.map(t => t);
  state.queueKey = key;
  startTrack(startIndex, 1);
}

function stopAtEnd() {
  ignoreEnded = true;
  clearTimeout(ignoreTimer);
  audio.pause();
  toast('已播完整個歌單');
  updatePlayBtn();
  ignoreTimer = setTimeout(() => { ignoreEnded = false; }, 400);
}

function startTrack(i, dir) {
  const q = state.queue;
  if (!q.length) return;
  dir = dir === -1 ? -1 : 1;
  let tries = 0;
  while (tries < q.length) {
    if (i >= q.length) { stopAtEnd(); return; }
    if (i < 0) { i = 0; dir = 1; }
    if (q[i] && q[i].preview) break;
    i += dir;
    tries++;
  }
  if (tries >= q.length || !q[i] || !q[i].preview) { stopAtEnd(); return; }
  const t = q[i];
  state.qIndex = i;
  liveToken += 1;
  const token = liveToken;
  audio.dataset.token = String(token);
  audio.dataset.trackId = t.id;
  audio.loop = false;
  ignoreEnded = true;
  clearTimeout(ignoreTimer);
  ignoreTimer = setTimeout(() => { if (liveToken === token) ignoreEnded = false; }, 350);
  lastSample = { t: 0, id: t.id };
  // 在 ended 的同一個呼叫堆疊裡換 src 並 play()，手機才不會重播同一首
  audio.src = t.preview;
  const pending = audio.play();
  if (pending) pending.then(() => { audio.dataset.unlocked = '1'; }).catch(err => {
    if (!err || err.name === 'AbortError' || liveToken !== token) return;
    updatePlayBtn();
    toast('請按 ▶ 開始播放');
  });
  updateNow();
  ensureDetails(t);
  const nxt = q[i + dir];
  if (nxt) ensureDetails(nxt);
}

function advance(dir) {
  if (!state.queue.length) return;
  startTrack(state.qIndex + (dir === -1 ? -1 : 1), dir === -1 ? -1 : 1);
}

function onPreviewEnded() {
  const src = audio.currentSrc || audio.src || '';
  if (!src || src.startsWith('data:')) return;
  if (ignoreEnded) return;
  if (audio.dataset.token !== String(liveToken)) return;
  if (!$('#autoNext').checked) { updatePlayBtn(); return; }
  const cur = state.queue[state.qIndex];
  if (cur && audio.dataset.trackId && audio.dataset.trackId !== cur.id) return;
  advance(1);
}

function updateNow() {
  const t = state.queue[state.qIndex];
  $('#nowTitle').textContent = t ? t.title : '—';
  $('#nowArtist').textContent = t ? t.artist : '';
  showVisual(t);
  $('#nowAddBtn').disabled = !t;
  document.title = t ? `▶ ${t.title} - ${t.artist}` : 'Spotify 試聽播放器';
  if ('mediaSession' in navigator && t) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, artwork: t.cover ? [{ src: t.cover, sizes: '300x300' }] : [] });
    } catch {}
  }
  renderTracks(); renderSidebar(); updatePlayBtn();
}
function updatePlayBtn() {
  $('#playBtn').textContent = audio.paused ? '▶' : '⏸';
  document.querySelectorAll('.track').forEach(li => li.classList.toggle('paused', audio.paused));
}
function togglePlay() {
  unlockAudio();
  if (!state.queue.length) {
    const tracks = currentViewTracks();
    if (tracks.length) playList(tracks, 0, viewKey());
    return;
  }
  if (audio.paused) {
    const p = audio.play();
    if (p) p.catch(() => toast('請按 ▶ 開始播放'));
  } else audio.pause();
}
const next = () => advance(1);
const prev = () => {
  if (audio.currentTime > 3) { markUserSeek(); audio.currentTime = 0; return; }
  advance(-1);
};

audio.addEventListener('ended', onPreviewEnded);
audio.addEventListener('play', updatePlayBtn);
audio.addEventListener('pause', updatePlayBtn);
audio.addEventListener('error', () => {
  const err = audio.error;
  if (!err || err.code === 1) return;
  const src = audio.src || '';
  if (!src || src.startsWith('data:')) return;
  const token = audio.dataset.token;
  if (token !== String(liveToken)) return;
  toast('這首試聽載入失敗，跳到下一首');
  if ($('#autoNext').checked) setTimeout(() => { if (audio.dataset.token === token) advance(1); }, 250);
});
audio.addEventListener('timeupdate', () => {
  const src = audio.currentSrc || audio.src || '';
  if (!src || src.startsWith('data:')) return;
  const t = audio.currentTime || 0;
  const id = audio.dataset.trackId || '';
  // 手機若沒送出 ended、反而把同一首跳回開頭，就當成播完並換下一首
  if (!audio.paused && !userSeek && !ignoreEnded && lastSample.id === id && lastSample.t > 8 && t < 1.2 && $('#autoNext').checked) {
    lastSample = { t, id };
    onPreviewEnded();
    return;
  }
  lastSample = { t, id };
  const d = (isFinite(audio.duration) && audio.duration > 0) ? audio.duration : 30;
  $('#curTime').textContent = fmt(t);
  $('#durTime').textContent = fmt(d);
  $('#progressFill').style.width = Math.min(100, t / d * 100) + '%';
});
$('#progress').addEventListener('pointerdown', markUserSeek);
$('#progress').addEventListener('click', e => {
  markUserSeek();
  const r = e.currentTarget.getBoundingClientRect();
  if (audio.duration) audio.currentTime = (e.clientX - r.left) / r.width * audio.duration;
});
$('#volume').addEventListener('input', e => { audio.volume = +e.target.value; lsSet('spp.vol', e.target.value); });
audio.volume = +(lsGet('spp.vol') || 0.8); $('#volume').value = audio.volume;
$('#playBtn').onclick = togglePlay; $('#nextBtn').onclick = next; $('#prevBtn').onclick = prev;
if ('mediaSession' in navigator) {
  try {
    navigator.mediaSession.setActionHandler('nexttrack', next);
    navigator.mediaSession.setActionHandler('previoustrack', prev);
  } catch {}
}
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'Escape') { closeSheet(); closeModal(null); return; }
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  if (e.code === 'ArrowRight' && e.shiftKey) next();
  if (e.code === 'ArrowLeft' && e.shiftKey) prev();
});

/* ---------- 頁內對話框（不用 prompt / confirm） ---------- */
function closeModal(value) {
  $('#modal').classList.add('hidden');
  const resolve = modalResolver;
  modalResolver = null;
  if (resolve) resolve(value);
}
function openModal({ title, text, input, value, confirmText, danger }) {
  return new Promise(resolve => {
    if (modalResolver) closeModal(null);
    modalResolver = resolve;
    $('#modalTitle').textContent = title || '';
    $('#modalText').textContent = text || '';
    $('#modalText').classList.toggle('hidden', !text);
    $('#modalInput').classList.toggle('hidden', !input);
    $('#modalInput').value = value || '';
    $('#modalConfirm').textContent = confirmText || '確定';
    $('#modalConfirm').classList.toggle('danger', !!danger);
    $('#modal').classList.remove('hidden');
  });
}
$('#modalForm').addEventListener('submit', e => {
  e.preventDefault();
  const useInput = !$('#modalInput').classList.contains('hidden');
  closeModal(useInput ? $('#modalInput').value.trim() : true);
});
$('#modalCancel').onclick = () => closeModal(null);
$('#modalBackdrop').onclick = () => closeModal(null);

/* ---------- 自訂歌單 ---------- */
function createPlaylist(name) {
  name = (name || '').trim();
  if (!name) return null;
  const p = { id: uid(), name, tracks: [] };
  state.custom.push(p);
  saveCustom();
  return p;
}
function addToPlaylist(pl, track) {
  if (!pl || !track) return;
  if (pl.tracks.some(t => t.id === track.id)) { toast(`「${track.title}」已在「${pl.name}」裡`); return; }
  pl.tracks.push(slim(track));
  saveCustom();
  toast(`已加入「${pl.name}」`);
  if (state.view?.kind === 'custom' && state.view.id === pl.id) showView(state.view);
}

function closeSheet() {
  $('#sheet').classList.add('hidden');
  sheetTrack = null;
}
function renderSheetList() {
  const track = sheetTrack;
  $('#sheetList').innerHTML = state.custom.length
    ? state.custom.map(p => `<button type="button" data-pl="${p.id}">${esc(p.name)}<span class="ok">${track && p.tracks.some(t => t.id === track.id) ? '已加入' : '＋'}</span></button>`).join('')
    : '<div class="sheet-empty">還沒有自訂歌單，在下方建立一個。</div>';
}
function openSheet(track) {
  if (!track) return;
  sheetTrack = track;
  $('#sheetTitle').textContent = `加入「${track.title}」`;
  $('#sheetName').value = `我的歌單 ${state.custom.length + 1}`;
  renderSheetList();
  $('#sheet').classList.remove('hidden');
}
$('#sheetBackdrop').onclick = closeSheet;
$('#sheetClose').onclick = closeSheet;
$('#sheetList').addEventListener('click', e => {
  const b = e.target.closest('button[data-pl]');
  if (!b || !sheetTrack) return;
  addToPlaylist(state.custom.find(p => p.id === b.dataset.pl), sheetTrack);
  closeSheet();
});
$('#sheetCreate').addEventListener('submit', e => {
  e.preventDefault();
  const track = sheetTrack;
  const name = $('#sheetName').value.trim() || `我的歌單 ${state.custom.length + 1}`;
  const p = createPlaylist(name);
  if (p && track) addToPlaylist(p, track);
  closeSheet();
});

$('#trackList').addEventListener('click', e => {
  const li = e.target.closest('.track'); if (!li) return;
  const i = +li.dataset.i;
  const tracks = currentViewTracks();
  const t = tracks[i];
  if (!t) return;
  if (e.target.closest('.add')) { e.stopPropagation(); openSheet(t); return; }
  if (e.target.closest('.remove')) {
    const pl = state.custom.find(p => p.id === state.view.id);
    if (!pl) return;
    pl.tracks.splice(i, 1);
    saveCustom();
    if ((state.queueKey || '').split(':shuffle')[0] === 'custom:' + pl.id) {
      state.queue = pl.tracks.slice();
      state.qIndex = state.queue.findIndex(x => x.id === audio.dataset.trackId);
    }
    toast(`已從「${pl.name}」移除`);
    showView(state.view);
    return;
  }
  if (!t.preview) { toast('這首歌沒有 30 秒試聽，可在 Spotify 開啟收聽'); window.open(`https://open.spotify.com/track/${t.id}`, '_blank'); return; }
  unlockAudio();
  playList(tracks, i, viewKey());
});
$('#nowAddBtn').onclick = () => { const t = state.queue[state.qIndex]; if (t) openSheet(t); };
$('#newPlBtn').onclick = async () => {
  const name = await openModal({ title: '新歌單', input: true, value: `我的歌單 ${state.custom.length + 1}`, confirmText: '建立' });
  if (!name) return;
  const p = createPlaylist(name);
  if (p) showView({ kind: 'custom', id: p.id });
};
$('#sourceItem').onclick = () => { if (state.source) showView({ kind: 'source' }); };
$('#customList').addEventListener('click', e => { const it = e.target.closest('[data-pl]'); if (it) showView({ kind: 'custom', id: it.dataset.pl }); });
$('#renameBtn').onclick = async () => {
  const pl = state.custom.find(p => p.id === state.view.id);
  if (!pl) return;
  const n = await openModal({ title: '重新命名', input: true, value: pl.name, confirmText: '儲存' });
  if (!n) return;
  pl.name = n;
  saveCustom();
  showView(state.view);
  toast('已重新命名');
};
$('#deleteBtn').onclick = async () => {
  const pl = state.custom.find(p => p.id === state.view.id);
  if (!pl) return;
  const ok = await openModal({ title: '刪除歌單', text: `確定要刪除「${pl.name}」嗎？`, confirmText: '刪除', danger: true });
  if (!ok) return;
  state.custom = state.custom.filter(p => p.id !== pl.id);
  saveCustom();
  toast('已刪除歌單');
  if (state.source) showView({ kind: 'source' });
  else { state.view = null; $('#viewSection').classList.add('hidden'); $('#emptyState').classList.remove('hidden'); renderSidebar(); }
};
$('#playAllBtn').onclick = () => { unlockAudio(); const t = currentViewTracks(); if (t.length) playList(t, 0, viewKey()); };
$('#shuffleBtn').onclick = () => {
  unlockAudio();
  const t = currentViewTracks().slice();
  for (let i = t.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [t[i], t[j]] = [t[j], t[i]]; }
  if (t.length) playList(t, 0, viewKey() + ':shuffle');
};

$('#loadForm').addEventListener('submit', e => { e.preventDefault(); unlockAudio(); const u = $('#urlInput').value.trim(); if (u) loadPlaylist(u); else toast('請先貼上 Spotify 歌單網址'); });
$('#demoBtn').onclick = () => { $('#urlInput').value = 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'; loadPlaylist($('#urlInput').value); };

const qp = new URLSearchParams(location.search).get('url');
$('#urlInput').value = qp || lsGet('spp.lastUrl') || '';
renderSidebar();
if (qp && new URLSearchParams(location.search).has('autoload')) loadPlaylist(qp);
