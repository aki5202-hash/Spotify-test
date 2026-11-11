// Credential-free YouTube matching via public search HTML (ytInitialData). No API key.
const fs = require('fs');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const CACHE_TTL = 6 * 60 * 60 * 1000;
const cache = new Map();
const inflight = new Map();
if (process.env.YT_CACHE_FILE) {
  try {
    const saved = JSON.parse(fs.readFileSync(process.env.YT_CACHE_FILE, 'utf8'));
    for (const [k, data] of Object.entries(saved)) cache.set(k, { t: Date.now(), data });
  } catch {}
}

const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'feat', 'ft', 'featuring', 'official', 'video', 'audio', 'lyric', 'lyrics', 'visualizer', 'visualiser', 'music', 'mv', 'hd', '4k', 'with', 'from', 'topic', 'vevo']);

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function tokens(s) {
  return norm(s).split(' ').filter(w => w && !STOP.has(w) && (w.length > 1 || /[\u4e00-\u9fff]/.test(w)));
}
function textOf(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.simpleText) return node.simpleText;
  if (Array.isArray(node.runs)) return node.runs.map(r => r.text || '').join('');
  return '';
}
function parseClock(text) {
  const m = String(text || '').trim().match(/^(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return 0;
  const h = m[1] ? Number(m[1]) : 0;
  return h * 3600 + Number(m[2]) * 60 + Number(m[3]);
}
function stripFeat(title) {
  return String(title || '').replace(/\s*[\(\[][^)\]]*\b(feat\.?|ft\.?|featuring)\b[^)\]]*[\)\]]/ig, ' ').replace(/\s+/g, ' ').trim();
}
function primaryArtists(artist) {
  return String(artist || '').split(/\s*(?:,|&| x |×|\/)\s*/i).map(a => a.trim()).filter(Boolean);
}

function extractInitialData(html) {
  const marker = 'var ytInitialData = ';
  const i = html.indexOf(marker);
  if (i < 0) return null;
  const end = html.indexOf(';</script>', i);
  if (end < 0) return null;
  return JSON.parse(html.slice(i + marker.length, end));
}
function collectVideos(data) {
  const videos = [];
  const seen = new Set();
  (function walk(o, d) {
    if (!o || typeof o !== 'object' || d > 14) return;
    if (o.videoId && o.title && o.lengthText && !seen.has(o.videoId)) {
      seen.add(o.videoId);
      videos.push(o);
    }
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v, d + 1);
  })(data, 0);
  return videos;
}

let nextSlot = 0;
function waitTurn() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + 450;
  return at > now ? new Promise(resolve => setTimeout(resolve, at - now)) : Promise.resolve();
}
async function searchYouTube(query) {
  let lastErr = new Error('找不到 YouTube 搜尋結果');
  for (let attempt = 0; attempt < 4; attempt++) {
    await waitTurn();
    const url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query);
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(15000) });
    if (r.status === 429) {
      lastErr = new Error('YouTube 回應 429');
      await new Promise(resolve => setTimeout(resolve, 1200 * (attempt + 1)));
      continue;
    }
    if (!r.ok) throw new Error('YouTube 回應 ' + r.status);
    const html = await r.text();
    const data = extractInitialData(html);
    if (!data) throw new Error('找不到 YouTube 搜尋結果');
    return collectVideos(data);
  }
  throw lastErr;
}

function classify(title, channel) {
  const t = title.toLowerCase();
  const c = channel.toLowerCase();
  const topic = /\btopic$/.test(c.trim()) || c.includes('- topic');
  if (/official\s+(music\s+)?video|\bofficial\s+mv\b|\(official video\)/.test(t) && !/audio/.test(t)) return 'mv';
  if (/visuali[sz]er/.test(t)) return 'visualizer';
  if (/lyric/.test(t)) return 'lyric';
  if (/official\s+audio|\(audio\)|audio only/.test(t)) return 'audio';
  if (topic) return 'topic';
  if (/official/.test(t) || /vevo/.test(c)) return 'official';
  return 'other';
}

function scoreVideo(v, artist, title, durationMs) {
  const vTitle = textOf(v.title);
  const channel = textOf(v.ownerText);
  const seconds = parseClock(textOf(v.lengthText));
  if (!v.videoId || !vTitle || !seconds) return null;
  const badges = (v.ownerBadges || []).map(b => b.metadataBadgeRenderer || {}).map(b => ({
    style: b.style || '',
    tooltip: b.tooltip || b.accessibilityData?.label || '',
  }));
  const verifiedArtist = badges.some(b => /VERIFIED_ARTIST/.test(b.style) || /official artist/i.test(b.tooltip));
  const verified = verifiedArtist || badges.some(b => /VERIFIED/.test(b.style));
  const kind = classify(vTitle, channel);
  const overlap = (() => {
    const want = tokens(stripFeat(title));
    const have = tokens(vTitle);
    if (!want.length) return 0;
    const set = new Set(have);
    const hit = want.filter(w => set.has(w) || have.some(h => (w.length > 3 && (h.includes(w) || w.includes(h)))));
    return hit.length / want.length;
  })();
  const artists = primaryArtists(artist).map(norm).filter(Boolean);
  const ch = norm(channel);
  const vt = norm(vTitle);
  let artistScore = 0;
  for (const a of artists) {
    const bare = ch.replace(/ topic$/, '').replace(/ vevo$/, '').trim();
    if (bare === a || ch === a) artistScore = Math.max(artistScore, 28);
    else if (a && (ch.includes(a) || (bare && a.includes(bare) && bare.length > 2))) artistScore = Math.max(artistScore, 22);
    else if (a && vt.includes(a)) artistScore = Math.max(artistScore, 10);
  }
  const songSec = Math.round((Number(durationMs) || 0) / 1000);
  const diff = songSec ? Math.abs(seconds - songSec) : 30;
  let durationScore = 0;
  if (diff <= 8) durationScore = 22;
  else if (diff <= 20) durationScore = 16;
  else if (diff <= 40) durationScore = 8;
  else if (diff <= 75) durationScore = 0;
  else if (diff <= 120) durationScore = -18;
  else durationScore = -40;

  let kindScore = 0;
  if (kind === 'mv') kindScore = 24;
  else if (kind === 'official') kindScore = 16;
  else if (kind === 'audio') kindScore = 14;
  else if (kind === 'lyric' || kind === 'visualizer') kindScore = 12;
  else if (kind === 'topic') kindScore = 8;
  if (verifiedArtist) kindScore += 10;
  else if (verified) kindScore += 4;
  if (/vevo/i.test(channel)) kindScore += 8;

  const songNorm = norm(title);
  const negWords = ['cover', 'karaoke', 'nightcore', 'remix', 'sped up', 'slowed', '8d', 'reaction', 'live', 'concert', 'instrumental', 'fan made', 'fanmade'];
  let penalty = 0;
  const blob = (vTitle + ' ' + channel).toLowerCase();
  for (const w of negWords) {
    if (blob.includes(w) && !songNorm.includes(w.replace(/\s+/g, ' '))) penalty += w === 'live' || w === 'remix' ? 18 : 28;
  }
  if (seconds < 60 && songSec > 90) penalty += 40;
  if (overlap < 0.6) penalty += 50;

  let score = Math.round(overlap * 40 + artistScore + durationScore + kindScore - penalty);
  const reject = overlap < 0.6 || score < 42 || (diff > 150 && kind !== 'mv' && kind !== 'audio' && kind !== 'topic');
  return {
    videoId: v.videoId,
    title: vTitle,
    channel,
    duration: seconds,
    score,
    kind,
    reject,
    verified: verifiedArtist || verified,
    url: 'https://www.youtube.com/watch?v=' + v.videoId,
  };
}

async function canEmbed(videoId) {
  const key = 'embed:' + videoId;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.data;
  let ok = true;
  try {
    const url = 'https://www.youtube.com/oembed?url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + videoId) + '&format=json';
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
    if (r.status === 401 || r.status === 403) ok = false;
    else ok = true;
  } catch {
    ok = true;
  }
  cache.set(key, { t: Date.now(), data: ok });
  return ok;
}

function dedupeSort(list) {
  const map = new Map();
  for (const item of list) {
    if (!item) continue;
    const prev = map.get(item.videoId);
    if (!prev || item.score > prev.score) map.set(item.videoId, item);
  }
  return [...map.values()].sort((a, b) => b.score - a.score);
}

async function matchYouTube({ artist = '', title = '', duration = 0 } = {}) {
  title = String(title || '').trim();
  artist = String(artist || '').trim();
  if (!title) return { picked: null, candidates: [], skipped: true, reason: '缺少歌名' };
  const key = [norm(artist), norm(stripFeat(title)), Math.round(Number(duration) / 1000) || 0].join('|');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.data;
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    const q1 = [primaryArtists(artist)[0] || artist, stripFeat(title), 'official video'].filter(Boolean).join(' ');
    let scored = [];
    try {
      const videos = await searchYouTube(q1);
      scored = videos.slice(0, 20).map(v => scoreVideo(v, artist, title, duration));
    } catch (err) {
      // one retry with a shorter query before giving up
      const videos = await searchYouTube([primaryArtists(artist)[0] || artist, stripFeat(title)].filter(Boolean).join(' '));
      scored = videos.slice(0, 20).map(v => scoreVideo(v, artist, title, duration));
      scored._err = err.message;
    }
    let ranked = dedupeSort(scored);
    let picked = ranked.find(v => !v.reject);
    let query = q1;
    if (!picked) {
      const q2 = [primaryArtists(artist)[0] || artist, stripFeat(title)].filter(Boolean).join(' ');
      const videos = await searchYouTube(q2);
      ranked = dedupeSort(ranked.concat(videos.slice(0, 20).map(v => scoreVideo(v, artist, title, duration))));
      picked = ranked.find(v => !v.reject);
      query = q1 + ' || ' + q2;
    }
    const pool = ranked.slice(0, 8);
    await Promise.all(pool.map(async v => { v.embeddable = await canEmbed(v.videoId); }));
    const embeddablePick = pool.find(v => v.embeddable && !v.reject) || pool.find(v => v.embeddable);
    if (embeddablePick) picked = embeddablePick;
    else if (picked && picked.embeddable === false) picked = null;
    const candidates = pool.slice(0, 6).map(({ reject, ...rest }) => ({ ...rest, weak: !!reject || rest.embeddable === false }));
    const data = {
      query,
      picked: picked && picked.embeddable !== false ? (({ reject, ...rest }) => rest)(picked) : null,
      candidates,
      skipped: !(picked && picked.embeddable !== false),
    };
    cache.set(key, { t: Date.now(), data });
    if (process.env.YT_CACHE_FILE) {
      try {
        const obj = {};
        for (const [k, v] of cache) obj[k] = v.data;
        fs.writeFileSync(process.env.YT_CACHE_FILE, JSON.stringify(obj));
      } catch {}
    }
    return data;
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

async function matchMany(tracks, concurrency = 3) {
  const results = new Array(tracks.length);
  let cursor = 0;
  async function worker() {
    while (cursor < tracks.length) {
      const idx = cursor++;
      const t = tracks[idx] || {};
      try {
        results[idx] = { id: t.id || null, ...(await matchYouTube(t)) };
        if (process.env.YT_PROGRESS) fs.appendFileSync(process.env.YT_PROGRESS, `${idx}\t${t.title}\t${results[idx].picked ? results[idx].picked.kind : 'miss'}\n`);
      } catch (err) {
        results[idx] = { id: t.id || null, picked: null, candidates: [], skipped: true, error: err.message || String(err) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tracks.length) }, worker));
  return results;
}

module.exports = { matchYouTube, matchMany, cache };
