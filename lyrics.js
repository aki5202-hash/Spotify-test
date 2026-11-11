// Plain lyrics from LRCLIB. No API key.
const LRCLIB_UA = 'SpotifyPreviewPlayer/1.0 (lyrics; contact: github.com/aki5202-hash/Spotify-test)';
const CACHE_TTL = 6 * 60 * 60 * 1000;
const cache = new Map();

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanTitle(title) {
  return String(title || '')
    .replace(/\s*[\(\[][^)\]]*\b(?:feat\.?|ft\.?|featuring|remaster(?:ed)?|mono|stereo|version)\b[^)\]]*[\)\]]/gi, ' ')
    .replace(/\s+-\s+.*\bremaster(?:ed)?\b.*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreRow(row, artist, title) {
  const wantTitle = norm(cleanTitle(title));
  const gotTitle = norm(cleanTitle(row.trackName || ''));
  let score = 0;
  if (wantTitle && gotTitle && wantTitle === gotTitle) score += 60;
  else if (wantTitle && gotTitle && (gotTitle.includes(wantTitle) || wantTitle.includes(gotTitle))) score += 34;
  const wantArtist = norm(String(artist || '').split(/,|&/)[0]);
  const gotArtist = norm(row.artistName || '');
  if (wantArtist && gotArtist && (wantArtist === gotArtist || gotArtist.includes(wantArtist) || wantArtist.includes(gotArtist))) score += 40;
  return score;
}

function pickLrc(list, artist, title) {
  const rows = (Array.isArray(list) ? list : []).filter(row => row && row.plainLyrics);
  const ranked = rows.map(row => ({ row, score: scoreRow(row, artist, title) })).sort((a, b) => b.score - a.score);
  const min = artist ? 70 : 55;
  return ranked[0] && ranked[0].score >= min ? ranked[0].row : null;
}

async function lrclibLyrics(artist, title) {
  const headers = { 'User-Agent': LRCLIB_UA, Accept: 'application/json' };
  const track = cleanTitle(title);
  const got = await fetch('https://lrclib.net/api/get?' + new URLSearchParams({ artist_name: artist, track_name: track }), {
    headers,
    signal: AbortSignal.timeout(12000),
  });
  if (got.ok) {
    const data = await got.json();
    if (data && data.plainLyrics) return data;
  }
  const found = await fetch('https://lrclib.net/api/search?q=' + encodeURIComponent([artist, track].filter(Boolean).join(' ')), {
    headers,
    signal: AbortSignal.timeout(12000),
  });
  if (!found.ok) return null;
  return pickLrc(await found.json(), artist, title);
}

async function fetchLyrics({ artist = '', title = '' } = {}) {
  title = String(title || '').trim();
  artist = String(artist || '').trim();
  if (!title) {
    const err = new Error('缺少歌名');
    err.status = 400;
    throw err;
  }
  const key = norm(artist) + '|' + norm(cleanTitle(title));
  const cached = cache.get(key);
  if (cached && Date.now() - cached.t < CACHE_TTL) return cached.data;

  let row = null;
  try { row = await lrclibLyrics(artist, title); } catch { row = null; }
  const text = row && row.plainLyrics ? String(row.plainLyrics) : '';
  if (!text.trim()) {
    const err = new Error('找不到這首歌的歌詞。');
    err.status = 404;
    throw err;
  }
  const data = {
    title: (row && row.trackName) || title,
    artist: (row && row.artistName) || artist,
    lyrics: text.split('\n'),
  };
  cache.set(key, { t: Date.now(), data });
  return data;
}

module.exports = { fetchLyrics, pickLrc, cleanTitle };
