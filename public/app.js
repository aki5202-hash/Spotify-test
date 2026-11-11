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
  mode: 'audio',
};
const KIND_LABEL = { mv: '官方 MV', audio: '官方音源', lyric: '歌詞版', visualizer: '視覺化', topic: 'Topic', official: '官方影片', other: '其他', picked: '已選影片' };
let ytPlayer = null;
let ytReady = false;
let ytCreating = false;
let pendingVideo = null;
let ytPoll = 0;

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
function loadCustom() {
  try {
    const list = JSON.parse(lsGet(LS_KEY)) || [];
    for (const p of list) for (const t of p.tracks || []) {
      if (t && t.ytVideoId && !t.ytPick) t.ytPick = { videoId: t.ytVideoId, title: t.title || '', channel: '', kind: 'picked', url: 'https://www.youtube.com/watch?v=' + t.ytVideoId };
    }
    return list;
  } catch { return []; }
}
function saveCustom() {
  if (!lsSet(LS_KEY, JSON.stringify(state.custom)) && !storageWarned) {
    storageWarned = true;
    toast('這個瀏覽器無法保存歌單，這次的變更只留在目前分頁');
  }
  renderSidebar();
}
const uid = () => Math.random().toString(36).slice(2, 10);
function videoIdOf(t) { return (t && ((t.ytPick && t.ytPick.videoId) || t.ytVideoId)) || null; }
const slim = t => ({ id: t.id, title: t.title, artist: t.artist, duration: t.duration, preview: t.preview, cover: t.cover, video: t.video || null, videoThumb: t.videoThumb || null, ytVideoId: videoIdOf(t) });

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
    if (state.mode !== 'youtube') document.documentElement.style.setProperty('--player-h', '160px');
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
    if (state.mode !== 'youtube') document.documentElement.style.setProperty('--player-h', '92px');
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
  if (cur && cur.id === id) { showVisual(cur); publishMediaSession(cur); }
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
  $('#exportBtn').classList.toggle('hidden', !isCustom);
  $('#ytExportBtn').classList.toggle('hidden', !isCustom);
  $('#setDefaultBtn').classList.toggle('hidden', !isCustom);
  if (isCustom) $('#setDefaultBtn').textContent = pl.id === lsGet('spp.defaultPl') ? '目前是預設歌單' : '設為預設歌單';
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
    const dim = state.mode === 'youtube' ? !!t.ytMiss : !t.preview;
    const ytBadge = state.mode === 'youtube' && t.ytMiss ? '<span class="badge">無影片</span>' : '';
    return `<li class="track ${isCur ? 'current' : ''} ${dim ? 'nopreview' : ''} ${audio.paused ? 'paused' : ''}" data-i="${i}" data-id="${t.id}">
      <span class="t-num">${isCur ? '<span class="eq"><i></i><i></i><i></i></span>' : i + 1}</span>
      <span class="t-main"><img class="t-cover" data-cover="${t.id}" src="${esc(t.cover || PLACEHOLDER)}" alt="" loading="lazy" onerror="imgErr(this)" />
        <span class="t-text"><div class="t-title">${esc(t.title)}${state.mode === 'youtube' ? ytBadge : (t.preview ? '' : '<span class="badge">無試聽</span>')}${t.video ? '<span class="badge clip">短片</span>' : ''}</div><div class="t-artist">${esc(t.artist)}</div></span></span>
      <span class="t-dur">${fmt((t.duration || 0) / 1000)}</span>
        <span class="t-actions">
        <button type="button" class="icon-btn about" title="歌曲介紹" aria-label="歌曲介紹">介</button>
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
  const defId = lsGet('spp.defaultPl');
  $('#customList').innerHTML = state.custom.length ? state.custom.map(p => {
    const c = p.tracks.find(t => t.cover)?.cover;
    const active = state.view?.kind === 'custom' && state.view.id === p.id;
    const playing = (state.queueKey || '').split(':shuffle')[0] === 'custom:' + p.id;
    const isDef = p.id === defId;
    return `<div class="side-item ${active ? 'active' : ''} ${playing ? 'playing' : ''}" data-pl="${p.id}">
      <span class="thumb">${c ? `<img src="${esc(c)}" alt="">` : '♥'}</span><span class="nm">${esc(p.name)}</span><span class="cnt">${p.tracks.length}</span>
      <button type="button" class="def-btn ${isDef ? 'on' : ''}" data-def="${p.id}">${isDef ? '預設' : '設預設'}</button></div>`;
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
  try { if (ytPlayer && ytPlayer.pauseVideo) ytPlayer.pauseVideo(); } catch {}
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
    if (q[i] && (state.mode === 'youtube' ? !q[i].ytMiss : q[i].preview)) break;
    i += dir;
    tries++;
  }
  const t = q[i];
  if (tries >= q.length || !t || (state.mode === 'youtube' ? t.ytMiss : !t.preview)) { stopAtEnd(); return; }
  state.qIndex = i;
  if (state.mode === 'youtube') {
    liveToken += 1;
    const token = liveToken;
    audio.dataset.trackId = t.id;
    audio.pause();
    beginYouTube(t, i, token);
    return;
  }
  liveToken += 1;
  const token = liveToken;
  audio.dataset.token = String(token);
  audio.dataset.trackId = t.id;
  // iOS drops the audio session if a preview reaches a natural end while locked.
  // Loop the element so the session stays open, and advance when it jumps back to 0.
  audio.loop = true;
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
  if (state.mode === 'youtube') return;
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
  updateHeart();
  document.title = t ? `▶ ${t.title} - ${t.artist}` : 'Spotify 試聽播放器';
  publishMediaSession(t);
  renderTracks(); renderSidebar(); updatePlayBtn();
}
function nowAlbum() {
  const key = state.queueKey || '';
  if (key.startsWith('custom:')) {
    const pl = state.custom.find(p => p.id === key.split(':')[1]);
    return (pl && pl.name) || '';
  }
  return (state.source && state.source.name) || '';
}
let lockHintTimer = 0;
let lockHintOn = false;
function lockPrevEnabled() {
  return lsGet('spp.lockPrevAdds') !== '0';
}
function artworkFor(t) {
  return t && t.cover ? [96, 128, 192, 256, 384, 512].map(size => ({ src: t.cover, sizes: `${size}x${size}`, type: 'image/jpeg' })) : [];
}
function bindMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const set = (name, fn) => { try { navigator.mediaSession.setActionHandler(name, fn); } catch {} };
  // iOS 17/18 shows ±10s buttons when any seek handler is set. Clear them every time.
  set('seekbackward', null);
  set('seekforward', null);
  set('seekto', null);
  set('play', () => {
    if (state.mode === 'youtube') { try { ytPlayer && ytPlayer.playVideo && ytPlayer.playVideo(); } catch {} return; }
    unlockAudio();
    const p = audio.play();
    if (p) p.then(() => bindMediaSession()).catch(() => {});
  });
  set('pause', () => { if (state.mode === 'youtube') { try { ytPlayer && ytPlayer.pauseVideo && ytPlayer.pauseVideo(); } catch {} } else audio.pause(); });
  set('nexttrack', () => next());
  set('previoustrack', () => mediaPrevious());
}
function publishMediaSession(t, artistOverride) {
  if (!('mediaSession' in navigator)) return;
  try {
    if (!t) { navigator.mediaSession.metadata = null; bindMediaSession(); return; }
    if (lockHintOn && !artistOverride) { bindMediaSession(); return; }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title || '',
      artist: artistOverride || t.artist || '',
      album: nowAlbum(),
      artwork: artworkFor(t),
    });
  } catch {}
  bindMediaSession();
}
function flashLockAdded(name) {
  const t = state.queue[state.qIndex];
  lockHintOn = true;
  publishMediaSession(t, `❤️ 已加入「${name}」`);
  clearTimeout(lockHintTimer);
  lockHintTimer = setTimeout(() => {
    lockHintOn = false;
    publishMediaSession(state.queue[state.qIndex]);
  }, 3000);
}
function updateHeart() {
  const btn = $('#heartBtn');
  if (!btn) return;
  const t = state.queue[state.qIndex];
  btn.disabled = !t;
  const on = !!(t && inDefault(t));
  btn.textContent = on ? '♥' : '♡';
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.title = on ? '從預設歌單移除' : '加入預設歌單';
}
function ytPlaying() {
  if (!ytPlayer || !ytPlayer.getPlayerState || !window.YT) return false;
  const st = ytPlayer.getPlayerState();
  return st === YT.PlayerState.PLAYING || st === YT.PlayerState.BUFFERING;
}
function updatePlayBtn() {
  const paused = state.mode === 'youtube' ? !ytPlaying() : audio.paused;
  $('#playBtn').textContent = paused ? '▶' : '⏸';
  document.querySelectorAll('.track').forEach(li => li.classList.toggle('paused', paused));
  if ('mediaSession' in navigator) {
    try { navigator.mediaSession.playbackState = paused ? 'paused' : 'playing'; } catch {}
  }
}
function togglePlay() {
  if (state.mode === 'youtube') {
    armYouTube();
    if (!state.queue.length) {
      const tracks = currentViewTracks();
      if (tracks.length) playList(tracks, 0, viewKey());
      return;
    }
    if (ytPlaying()) { try { ytPlayer.pauseVideo(); } catch {} }
    else if (ytPlayer && ytPlayer.playVideo && state.queue[state.qIndex] && videoIdOf(state.queue[state.qIndex])) {
      try { ytPlayer.playVideo(); } catch {}
    } else startTrack(Math.max(0, state.qIndex), 1);
    updatePlayBtn();
    return;
  }
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
  if (state.mode === 'youtube' && ytPlayer && ytPlayer.getCurrentTime && ytPlayer.getCurrentTime() > 3) {
    try { ytPlayer.seekTo(0, true); } catch {}
    return;
  }
  if (state.mode !== 'youtube' && audio.currentTime > 3) { markUserSeek(); audio.currentTime = 0; return; }
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
function maybeLoopAdvance() {
  if (state.mode === 'youtube') return false;
  const t = audio.currentTime || 0;
  const id = audio.dataset.trackId || '';
  // iOS loops the preview instead of firing ended while locked. A jump back to the start means the clip finished.
  if (!audio.paused && !userSeek && !ignoreEnded && lastSample.id === id && lastSample.t > 8 && t + 1 < lastSample.t && t < 1.5 && $('#autoNext').checked) {
    lastSample = { t, id };
    onPreviewEnded();
    return true;
  }
  return false;
}
audio.addEventListener('seeked', () => { maybeLoopAdvance(); });
audio.addEventListener('timeupdate', () => {
  if (state.mode === 'youtube') return;
  const src = audio.currentSrc || audio.src || '';
  if (!src || src.startsWith('data:')) return;
  if (maybeLoopAdvance()) return;
  const t = audio.currentTime || 0;
  const id = audio.dataset.trackId || '';
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
  const ratio = (e.clientX - r.left) / r.width;
  if (state.mode === 'youtube' && ytPlayer && ytPlayer.getDuration && ytPlayer.seekTo) {
    const d = ytPlayer.getDuration();
    if (d) ytPlayer.seekTo(Math.max(0, Math.min(d, ratio * d)), true);
    return;
  }
  if (audio.duration) audio.currentTime = ratio * audio.duration;
});
$('#volume').addEventListener('input', e => {
  audio.volume = +e.target.value;
  lsSet('spp.vol', e.target.value);
  try { if (ytPlayer && ytPlayer.setVolume) ytPlayer.setVolume(Math.round((+e.target.value) * 100)); } catch {}
});
audio.volume = +(lsGet('spp.vol') || 0.8); $('#volume').value = audio.volume;
$('#playBtn').onclick = togglePlay; $('#nextBtn').onclick = next; $('#prevBtn').onclick = prev; $('#heartBtn').onclick = heartToggle;
bindMediaSession();
audio.addEventListener('playing', () => {
  bindMediaSession();
  const t = state.queue[state.qIndex];
  if (t && state.mode !== 'youtube') publishMediaSession(t);
});
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'Escape') { closeSheet(); closeShare(); closeYouTubeExport(); closePick(); closeAbout(); closeModal(null); return; }
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
function defaultPlaylist() {
  const id = lsGet('spp.defaultPl');
  return (id && state.custom.find(p => p.id === id)) || null;
}
function ensureDefault() {
  let pl = defaultPlaylist();
  if (pl) return pl;
  pl = state.custom.find(p => p.name === '我的最愛');
  if (!pl) pl = createPlaylist('我的最愛');
  if (pl) { lsSet('spp.defaultPl', pl.id); renderSidebar(); }
  return pl;
}
function inDefault(track) {
  const pl = defaultPlaylist();
  return !!(track && pl && pl.tracks.some(t => t.id === track.id));
}
function setDefaultPlaylist(id) {
  const pl = state.custom.find(p => p.id === id);
  if (!pl) return;
  lsSet('spp.defaultPl', id);
  renderSidebar();
  if (state.view && state.view.kind === 'custom') showView(state.view);
  updateHeart();
  toast(`預設歌單：${pl.name}`);
}
function heartToggle() {
  const t = state.queue[state.qIndex];
  if (!t) return;
  const pl = ensureDefault();
  if (!pl) return;
  const idx = pl.tracks.findIndex(x => x.id === t.id);
  if (idx >= 0) {
    pl.tracks.splice(idx, 1);
    saveCustom();
    if (state.view && state.view.kind === 'custom' && state.view.id === pl.id) showView(state.view);
    toast(`已從「${pl.name}」移除`);
  } else addToPlaylist(pl, t);
  updateHeart();
}
function addCurrentToDefaultSync() {
  const t = state.queue[state.qIndex];
  if (!t) return null;
  const pl = ensureDefault();
  if (!pl) return null;
  if (!pl.tracks.some(x => x.id === t.id)) {
    pl.tracks.push(slim(t));
    saveCustom();
  }
  return pl;
}
function mediaPrevious() {
  if (!lockPrevEnabled()) { prev(); return; }
  if (state.mode === 'youtube') return;
  const pl = addCurrentToDefaultSync();
  if (!pl) return;
  flashLockAdded(pl.name);
  updateHeart();
  if (document.visibilityState === 'visible') toast(`❤️ 已加入「${pl.name}」`);
}
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
  if (e.target.closest('.about')) { e.stopPropagation(); openAbout(t); return; }
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
  if (state.mode === 'youtube') {
    armYouTube();
    if (t.ytMiss) { toast('這首沒有合適的 YouTube 影片'); return; }
    playList(tracks, i, viewKey());
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
$('#customList').addEventListener('click', e => {
  const def = e.target.closest('[data-def]');
  if (def) { setDefaultPlaylist(def.dataset.def); return; }
  const it = e.target.closest('[data-pl]');
  if (it) showView({ kind: 'custom', id: it.dataset.pl });
});
$('#setDefaultBtn').onclick = () => {
  const pl = state.view && state.view.kind === 'custom' && state.custom.find(p => p.id === state.view.id);
  if (pl) setDefaultPlaylist(pl.id);
};
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
  if (lsGet('spp.defaultPl') === pl.id) lsSet('spp.defaultPl', '');
  saveCustom();
  toast('已刪除歌單');
  if (state.source) showView({ kind: 'source' });
  else { state.view = null; $('#viewSection').classList.add('hidden'); $('#emptyState').classList.remove('hidden'); renderSidebar(); }
};
$('#playAllBtn').onclick = () => {
  if (state.mode === 'youtube') armYouTube(); else unlockAudio();
  const t = currentViewTracks();
  if (t.length) playList(t, 0, viewKey());
};
$('#shuffleBtn').onclick = () => {
  if (state.mode === 'youtube') armYouTube(); else unlockAudio();
  const t = currentViewTracks().slice();
  for (let i = t.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [t[i], t[j]] = [t[j], t[i]]; }
  if (t.length) playList(t, 0, viewKey() + ':shuffle');
};

/* ---------- YouTube 模式 ---------- */
function syncPlayerHeight() {
  const h = Math.ceil($('.player').getBoundingClientRect().height);
  if (h > 40) document.documentElement.style.setProperty('--player-h', h + 'px');
}
if (window.ResizeObserver) new ResizeObserver(() => syncPlayerHeight()).observe(document.querySelector('.player'));
function kindLabel(kind) { return KIND_LABEL[kind] || '影片'; }
function matchLine(v) {
  if (!v) return '沒有合適的影片，點這裡看其他結果';
  const bits = [kindLabel(v.kind), v.channel, v.title].filter(Boolean);
  const clock = v.duration ? fmt(v.duration) : '';
  return (clock ? clock + ' · ' : '') + bits.join(' · ');
}
function setMatchLabel(text) { const b = $('#ytPickBtn'); if (b) b.textContent = text; }
function showDock() {
  $('#ytDock').classList.remove('hidden');
  document.body.classList.add('video-mode');
  setTimeout(syncPlayerHeight, 40);
}
function embedSrc(videoId) {
  const q = new URLSearchParams({
    playsinline: '1',
    enablejsapi: '1',
    rel: '0',
    modestbranding: '1',
    origin: location.origin,
  });
  return 'https://www.youtube.com/embed/' + videoId + '?' + q.toString();
}
function armYouTube() {
  showDock();
  const frame = $('#ytEmbed');
  const box = frame && frame.parentElement && frame.parentElement.getBoundingClientRect();
  if (box && box.height < 40) syncPlayerHeight();
}
function ensureAPI() {
  const frame = $('#ytEmbed');
  if (!frame || !frame.dataset.vid || ytPlayer || ytCreating) return;
  if (!(window.YT && YT.Player)) return;
  ytCreating = true;
  ytPlayer = new YT.Player('ytEmbed', {
    events: {
      onReady() {
        ytReady = true;
        ytCreating = false;
        frame.dataset.api = '1';
        try { ytPlayer.setVolume(Math.round(audio.volume * 100)); } catch {}
        syncPlayerHeight();
      },
      onStateChange(e) {
        updatePlayBtn();
        if (e.data === YT.PlayerState.PLAYING) frame.dataset.started = '1';
        if (e.data === YT.PlayerState.ENDED && state.mode === 'youtube' && $('#autoNext').checked) advanceYouTube();
      },
      onError(e) {
        const code = e && e.data;
        console.warn('yt-error', code);
        if (code === 101 || code === 150) handleYTError(code);
      },
    },
  });
}
const prevYTReady = window.onYouTubeIframeAPIReady;
window.onYouTubeIframeAPIReady = function () {
  if (typeof prevYTReady === 'function') prevYTReady();
  ensureAPI();
};
function loadYT(picked, token, opts) {
  if (!picked || !picked.videoId) return;
  const autoplay = !!(opts && opts.autoplay);
  pendingVideo = { videoId: picked.videoId, token, autoplay };
  showDock();
  setMatchLabel(matchLine(picked));
  const frame = $('#ytEmbed');
  const waiting = $('#ytWaiting');
  if (waiting) waiting.classList.add('hidden');
  frame.classList.remove('hidden');
  if (ytReady && ytPlayer && frame.dataset.api === '1' && ytPlayer.loadVideoById) {
    frame.dataset.vid = picked.videoId;
    try {
      if (autoplay) ytPlayer.loadVideoById(picked.videoId);
      else ytPlayer.cueVideoById(picked.videoId);
    } catch {}
    return;
  }
  // Standard embed is visible and tappable before the IFrame API finishes loading.
  if (frame.dataset.vid !== picked.videoId) {
    frame.dataset.vid = picked.videoId;
    frame.src = embedSrc(picked.videoId);
  }
  ensureAPI();
  syncPlayerHeight();
}
let ytErrorBusy = false;
function handleYTError(code) {
  if (state.mode !== 'youtube' || ytErrorBusy) return;
  ytErrorBusy = true;
  setTimeout(() => { ytErrorBusy = false; }, 700);
  const t = state.queue[state.qIndex];
  if (!t) return;
  const bad = new Set(t.ytBad || []);
  const current = (t.ytPick && t.ytPick.videoId) || t.ytVideoId;
  if (current) bad.add(current);
  t.ytBad = [...bad];
  const list = t.ytCandidates || (t.yt && t.yt.candidates) || [];
  const next = list.find(c => c && c.videoId && !bad.has(c.videoId) && c.embeddable !== false && !c.weak)
    || list.find(c => c && c.videoId && !bad.has(c.videoId) && c.embeddable !== false);
  if (next) {
    t.ytPick = { ...next, manual: true };
    t.ytVideoId = next.videoId;
    t.ytMiss = false;
    toast(code === 101 || code === 150 ? '這部影片不允許內嵌，改播候選影片' : '這部影片無法播放，改播候選影片');
    loadYT(t.ytPick, liveToken, { autoplay: true });
    updateNow();
    return;
  }
  t.ytMiss = true;
  toast('這首沒有可內嵌的影片，跳到下一首');
  renderTracks();
  if ($('#autoNext').checked) startTrack(state.qIndex + 1, 1);
}
function applyMatch(track, data) {
  track.yt = data;
  track.ytCandidates = data.candidates || [];
  if (track.ytPick && track.ytPick.manual) return;
  if (data.picked) {
    track.ytPick = data.picked;
    track.ytVideoId = data.picked.videoId;
    track.ytMiss = false;
  } else {
    track.ytMiss = true;
  }
}
async function fetchMatch(track) {
  if (track.yt && (track.yt.picked || track.yt.skipped || track.yt.error)) return track.yt;
  const q = new URLSearchParams({ artist: track.artist || '', title: track.title || '', duration: String(track.duration || 0) });
  const r = await fetch('/api/youtube?' + q);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || '配對失敗');
  applyMatch(track, data);
  return data;
}
function prefetchAround(i) {
  for (const t of [state.queue[i + 1], state.queue[i + 2]]) {
    if (t && !t.yt && !t.ytMiss) fetchMatch(t).catch(() => {});
  }
}
async function beginYouTube(t, i, token) {
  showDock();
  const waiting = $('#ytWaiting');
  if (waiting) { waiting.textContent = '正在尋找 YouTube 影片…'; waiting.classList.remove('hidden'); }
  setMatchLabel('正在尋找 YouTube 影片…');
  updateNow();
  let data = null;
  try { data = await fetchMatch(t); }
  catch (err) {
    if (token !== liveToken) return;
    if (t.ytPick && t.ytPick.videoId) { loadYT(t.ytPick, token); updateNow(); return; }
    t.ytMiss = true;
    toast('YouTube 配對失敗，跳過');
    if ($('#autoNext').checked) startTrack(i + 1, 1);
    return;
  }
  if (token !== liveToken) return;
  const picked = (t.ytPick && t.ytPick.manual && t.ytPick.videoId) ? t.ytPick : (data && data.picked);
  if (!picked) {
    t.ytMiss = true;
    setMatchLabel('沒有合適的影片，點這裡看其他結果');
    renderTracks();
    toast(`「${t.title}」沒有合適的影片，已跳過`);
    if ($('#autoNext').checked) startTrack(i + 1, 1);
    return;
  }
  t.ytPick = t.ytPick && t.ytPick.manual ? t.ytPick : picked;
  t.ytVideoId = t.ytPick.videoId;
  t.ytMiss = false;
  loadYT(t.ytPick, token);
  updateNow();
  prefetchAround(i);
}
function advanceYouTube() {
  const q = state.queue;
  let i = state.qIndex + 1;
  let tries = 0;
  while (i < q.length && tries < q.length && q[i] && q[i].ytMiss) { i++; tries++; }
  if (i >= q.length) { stopAtEnd(); return; }
  const t = q[i];
  const picked = t.ytPick && t.ytPick.videoId ? t.ytPick : (t.yt && t.yt.picked);
  if (picked && picked.videoId) {
    liveToken += 1;
    state.qIndex = i;
    audio.dataset.trackId = t.id;
    loadYT(picked, liveToken, { autoplay: true });
    updateNow();
    prefetchAround(i);
    return;
  }
  startTrack(i, 1);
}
function openPick() {
  const t = state.queue[state.qIndex];
  if (!t) return;
  const list = t.ytCandidates || (t.yt && t.yt.candidates) || [];
  $('#pickTitle').textContent = `選擇「${t.title}」的影片`;
  $('#pickList').innerHTML = list.length ? list.map((c, i) => `<button type="button" data-i="${i}">${esc(matchLine(c))}${c.weak ? '<span class="ok">較不符</span>' : (videoIdOf(t) === c.videoId ? '<span class="ok">播放中</span>' : '<span class="ok">選擇</span>')}</button>`).join('') : '<div class="sheet-empty">沒有其他候選影片</div>';
  $('#pickSheet').classList.remove('hidden');
}
function closePick() { $('#pickSheet').classList.add('hidden'); }
$('#pickBackdrop').onclick = closePick;
$('#pickClose').onclick = closePick;
$('#ytPickBtn').onclick = () => openPick();
$('#pickList').addEventListener('click', e => {
  const b = e.target.closest('button[data-i]');
  if (!b) return;
  const t = state.queue[state.qIndex];
  if (!t) return;
  const list = t.ytCandidates || [];
  const c = list[+b.dataset.i];
  if (!c) return;
  t.ytPick = { ...c, manual: true };
  t.ytVideoId = c.videoId;
  t.ytMiss = false;
  liveToken += 1;
  loadYT(t.ytPick, liveToken, { autoplay: true });
  updateNow();
  closePick();
  if (state.view && state.view.kind === 'custom') saveCustom();
});
function setMode(mode) {
  if (mode === state.mode) {
    if (mode === 'youtube') armYouTube();
    return;
  }
  state.mode = mode;
  lsSet('spp.mode', mode);
  $('#modeAudio').classList.toggle('on', mode !== 'youtube');
  $('#modeVideo').classList.toggle('on', mode === 'youtube');
  if (mode === 'audio') {
    try { if (ytPlayer && ytPlayer.pauseVideo) ytPlayer.pauseVideo(); } catch {}
    $('#ytDock').classList.add('hidden');
    document.body.classList.remove('video-mode');
    if (state.qIndex >= 0 && state.queue[state.qIndex] && state.queue[state.qIndex].preview) startTrack(state.qIndex, 1);
  } else {
    audio.pause();
    armYouTube();
    if (state.queue.length) startTrack(Math.max(0, state.qIndex), 1);
    else if (currentViewTracks().length) playList(currentViewTracks(), 0, viewKey());
  }
  renderTracks();
  bindMediaSession();
  setTimeout(syncPlayerHeight, 60);
}
$('#modeAudio').onclick = () => { unlockAudio(); setMode('audio'); };
$('#modeVideo').onclick = () => { armYouTube(); setMode('youtube'); };
ytPoll = setInterval(() => {
  if (state.mode !== 'youtube' || !ytPlayer || !ytPlayer.getCurrentTime) return;
  const t = ytPlayer.getCurrentTime() || 0;
  const d = ytPlayer.getDuration() || 0;
  if (d > 0) {
    $('#curTime').textContent = fmt(t);
    $('#durTime').textContent = fmt(d);
    $('#progressFill').style.width = Math.min(100, t / d * 100) + '%';
  }
}, 500);

/* ---------- 匯出／匯入 ---------- */
function downloadFile(filename, mime, text) {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}
function safeName(s) { return String(s || 'playlist').replace(/[^\w\u4e00-\u9fff.-]+/g, '_').slice(0, 40) || 'playlist'; }
function exportPayload(playlists) {
  return { app: 'spotify-preview-player', version: 1, exportedAt: new Date().toISOString(), playlists: playlists.map(p => ({ id: p.id, name: p.name, tracks: (p.tracks || []).map(slim) })) };
}
function textList(playlists) {
  return playlists.map(p => {
    const lines = [p.name];
    (p.tracks || []).forEach((t, i) => {
      lines.push(`${i + 1}. ${t.artist || '未知歌手'} - ${t.title}`);
      if (t.id) lines.push('https://open.spotify.com/track/' + t.id);
      const yid = videoIdOf(t);
      if (yid) lines.push('https://www.youtube.com/watch?v=' + yid);
    });
    return lines.join('\n');
  }).join('\n\n');
}
function csvOf(playlists) {
  const rows = [['playlist', 'artist', 'title', 'spotify_url', 'youtube_url', 'duration_ms']];
  for (const p of playlists) for (const t of p.tracks || []) {
    const yid = videoIdOf(t);
    rows.push([p.name, t.artist || '', t.title || '', t.id ? 'https://open.spotify.com/track/' + t.id : '', yid ? 'https://www.youtube.com/watch?v=' + yid : '', t.duration || '']);
  }
  const escCell = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return '\uFEFF' + rows.map(r => r.map(escCell).join(',')).join('\n');
}
async function writeClipboard(text) {
  try { await navigator.clipboard.writeText(text); toast('已複製到剪貼簿'); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('已複製到剪貼簿'); } catch { toast('無法複製'); }
    ta.remove();
  }
}
async function copyOrShare(text, title) {
  if (navigator.share) {
    try { await navigator.share({ title, text }); return; }
    catch (err) { if (err && err.name === 'AbortError') return; }
  }
  await writeClipboard(text);
}
function currentCustom() {
  if (!state.view || state.view.kind !== 'custom') return null;
  return state.custom.find(p => p.id === state.view.id) || null;
}
async function matchPlaylist(pl, onProgress) {
  const pending = pl.tracks.filter(t => !t.yt && !videoIdOf(t));
  for (let i = 0; i < pending.length; i += 12) {
    const slice = pending.slice(i, i + 12);
    const r = await fetch('/api/youtube', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tracks: slice.map(t => ({ id: t.id, artist: t.artist, title: t.title, duration: t.duration })) }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '配對失敗');
    for (const res of data.results || []) {
      const t = pl.tracks.find(x => x.id && x.id === res.id) || slice[data.results.indexOf(res)];
      if (t) applyMatch(t, res);
    }
    if (onProgress) onProgress(Math.min(pl.tracks.length, i + slice.length), pl.tracks.length);
  }
  saveCustom();
}
function closeYouTubeExport() { $('#ytExportSheet').classList.add('hidden'); }
function renderYouTubeExport(pl) {
  const ids = [];
  const links = [];
  let skipped = 0;
  for (const t of pl.tracks) {
    const id = videoIdOf(t);
    if (!id) { skipped++; continue; }
    ids.push(id);
    links.push({ title: `${t.artist || ''} - ${t.title}`.trim(), url: 'https://www.youtube.com/watch?v=' + id });
  }
  const chunks = [];
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
  const note = ids.length
    ? `已配對 ${ids.length} 首${skipped ? `，${skipped} 首沒有合適的影片已略過` : ''}。YouTube 這個網址一次最多約 50 首${chunks.length > 1 ? `，所以分成 ${chunks.length} 段` : ''}。`
    : '這些歌都找不到合適的 YouTube 影片。';
  const chunkBtns = chunks.map((c, i) => {
    const from = i * 50 + 1;
    const to = i * 50 + c.length;
    const href = 'https://www.youtube.com/watch_videos?video_ids=' + c.join(',');
    return `<a class="btn primary" target="_blank" rel="noopener" href="${esc(href)}">開啟 YouTube 歌單${chunks.length > 1 ? ` ${from}–${to}` : ''}（${c.length} 首）</a>`;
  }).join('');
  $('#ytExportBody').innerHTML = `<p class="sheet-note">${esc(note)}</p>${chunkBtns}<textarea class="yt-links" readonly id="ytLinkBox">${esc(links.map(l => l.title + '\n' + l.url).join('\n'))}</textarea><button type="button" id="copyYtLinks" class="btn ghost">複製 YouTube 連結</button>`;
  const copy = $('#copyYtLinks');
  if (copy) copy.onclick = () => writeClipboard($('#ytLinkBox').value);
}
async function openYouTubeExport(pl) {
  if (!pl || !pl.tracks.length) { toast('這個歌單還沒有歌曲'); return; }
  $('#ytExportTitle').textContent = `YouTube · ${pl.name}`;
  $('#ytExportBody').innerHTML = `<p class="sheet-note">正在配對影片… 0/${pl.tracks.length}</p>`;
  $('#ytExportSheet').classList.remove('hidden');
  try {
    await matchPlaylist(pl, (done, total) => {
      const note = $('#ytExportBody .sheet-note');
      if (note) note.textContent = `正在配對影片… ${done}/${total}`;
    });
  } catch (err) {
    $('#ytExportBody').innerHTML = `<p class="sheet-note">${esc(err.message || '配對失敗')}</p>`;
    return;
  }
  renderYouTubeExport(pl);
}
function closeShare() { $('#shareSheet').classList.add('hidden'); }
function openShare() {
  const pl = currentCustom();
  if (!pl) return;
  $('#shareTitle').textContent = `匯出「${pl.name}」`;
  $('#shareActions').innerHTML = [
    ['json-one', '下載這個歌單 JSON'],
    ['json-all', '下載全部歌單 JSON'],
    ['csv', '下載 CSV'],
    ['copy', '複製歌曲清單'],
    ['share', '分享歌曲清單'],
    ['yt', '做成 YouTube 歌單'],
    ['import', '匯入 JSON'],
  ].map(([k, label]) => `<button type="button" data-act="${k}">${label}</button>`).join('');
  $('#shareSheet').classList.remove('hidden');
}
function importData(data) {
  const lists = Array.isArray(data) ? data : (data && data.playlists) ? data.playlists : (data && data.name && data.tracks) ? [data] : null;
  if (!lists) throw new Error('這不是這個播放器的歌單檔');
  let n = 0;
  for (const raw of lists.slice(0, 50)) {
    if (!raw || !Array.isArray(raw.tracks)) continue;
    const tracks = raw.tracks.map(t => {
      if (!t || !t.title) return null;
      const id = String(t.id || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
      const item = { id: id || uid(), title: String(t.title).slice(0, 200), artist: String(t.artist || '').slice(0, 200), duration: Number(t.duration) || 0, preview: t.preview || null, cover: t.cover || null, video: t.video || null, videoThumb: t.videoThumb || null, ytVideoId: t.ytVideoId || null };
      if (item.ytVideoId) item.ytPick = { videoId: item.ytVideoId, title: item.title, channel: '', kind: 'picked', url: 'https://www.youtube.com/watch?v=' + item.ytVideoId };
      return item;
    }).filter(Boolean).slice(0, 500);
    const name = String(raw.name || '匯入的歌單').slice(0, 80);
    const existing = raw.id && state.custom.find(p => p.id === raw.id);
    if (existing) { existing.name = name; existing.tracks = tracks; }
    else state.custom.push({ id: raw.id || uid(), name, tracks });
    n++;
  }
  if (!n) throw new Error('檔案裡沒有歌單');
  saveCustom();
  return n;
}
$('#shareActions').addEventListener('click', async e => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const pl = currentCustom();
  const act = b.dataset.act;
  if (act === 'import') { $('#importFile').click(); return; }
  if (act === 'yt') { closeShare(); if (pl) openYouTubeExport(pl); return; }
  if (!pl && act !== 'json-all') return;
  if (act === 'json-one') downloadFile(safeName(pl.name) + '.json', 'application/json', JSON.stringify(exportPayload([pl]), null, 2));
  if (act === 'json-all') downloadFile('spotify-playlists.json', 'application/json', JSON.stringify(exportPayload(state.custom), null, 2));
  if (act === 'csv') downloadFile(safeName(pl.name) + '.csv', 'text/csv;charset=utf-8', csvOf([pl]));
  if (act === 'copy') writeClipboard(textList([pl]));
  if (act === 'share') copyOrShare(textList([pl]), pl.name);
  if (act !== 'share' && act !== 'copy') toast('已開始下載');
});
$('#shareBackdrop').onclick = closeShare;
$('#shareClose').onclick = closeShare;
$('#ytExportBackdrop').onclick = closeYouTubeExport;
$('#ytExportClose').onclick = closeYouTubeExport;
function closeAbout() { $('#aboutSheet').classList.add('hidden'); }
function renderAbout(d) {
  const thumb = d.thumbnail ? `<img class="about-thumb" alt="" src="${esc(d.thumbnail)}" />` : '';
  const fallback = d.type === 'artist' ? '<p class="about-fallback">找不到這首歌的介紹，以下是歌手介紹</p>' : '';
  const link = d.url ? `<a class="btn ghost" target="_blank" rel="noopener" href="${esc(d.url)}">在維基百科閱讀</a>` : '';
  $('#aboutTitle').textContent = '歌曲介紹';
  $('#aboutBody').innerHTML = `<div class="about-head">${thumb}<div><strong>${esc(d.title || '')}</strong></div></div>${fallback}<p class="about-text">${esc(d.extract || '')}</p>${link}`;
}
async function openAbout(track) {
  track = track || state.queue[state.qIndex];
  if (!track || !track.title) { toast('還沒有歌曲'); return; }
  $('#aboutSheet').classList.remove('hidden');
  $('#aboutTitle').textContent = '歌曲介紹';
  $('#aboutBody').innerHTML = '<p class="sheet-note">正在讀取介紹…</p>';
  try {
    const q = new URLSearchParams({ artist: track.artist || '', title: track.title || '' });
    const r = await fetch('/api/about?' + q);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '找不到這首歌的介紹。');
    renderAbout(d);
  } catch (err) {
    $('#aboutBody').innerHTML = `<p class="sheet-note">${esc(err.message || '找不到這首歌的介紹。')}</p>`;
  }
}
$('#aboutBtn').onclick = () => openAbout();
$('#nowTitle').onclick = () => { if (state.queue[state.qIndex]) openAbout(); };
$('#aboutBackdrop').onclick = closeAbout;
$('#aboutClose').onclick = closeAbout;
$('#lockPrevAdd').checked = lockPrevEnabled();
$('#lockPrevAdd').addEventListener('change', e => {
  lsSet('spp.lockPrevAdds', e.target.checked ? '1' : '0');
  bindMediaSession();
});
$('#exportBtn').onclick = () => openShare();
$('#ytExportBtn').onclick = () => { const pl = currentCustom(); if (pl) openYouTubeExport(pl); };
$('#importBtn').onclick = () => $('#importFile').click();
$('#importFile').addEventListener('change', async () => {
  const file = $('#importFile').files && $('#importFile').files[0];
  $('#importFile').value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const n = importData(data);
    toast(`已匯入 ${n} 個歌單`);
    if (state.custom.length) showView({ kind: 'custom', id: state.custom[state.custom.length - 1].id });
  } catch (err) { toast(err.message || '匯入失敗'); }
});

$('#loadForm').addEventListener('submit', e => { e.preventDefault(); if (state.mode === 'youtube') armYouTube(); else unlockAudio(); const u = $('#urlInput').value.trim(); if (u) loadPlaylist(u); else toast('請先貼上 Spotify 歌單網址'); });
$('#demoBtn').onclick = () => { $('#urlInput').value = 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'; loadPlaylist($('#urlInput').value); };

const qp = new URLSearchParams(location.search).get('url');
$('#urlInput').value = qp || lsGet('spp.lastUrl') || '';
renderSidebar();
if (qp && new URLSearchParams(location.search).has('autoload')) loadPlaylist(qp);
