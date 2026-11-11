// Lyrics from LRCLIB (no key) and annotations from the official Genius API.
// GENIUS_ACCESS_TOKEN is read only to set the Authorization header. It is never logged.
const GENIUS_API = 'https://api.genius.com';
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

function scoreHit(song, artist, title) {
  const wantTitle = norm(cleanTitle(title));
  const gotTitle = norm(cleanTitle(song.title || song.full_title || ''));
  let score = 0;
  if (wantTitle && gotTitle && wantTitle === gotTitle) score += 60;
  else if (wantTitle && gotTitle && (gotTitle.includes(wantTitle) || wantTitle.includes(gotTitle))) score += 34;
  const wantArtist = norm(String(artist || '').split(/,|&|\bfeat\b|\bft\b/i)[0]);
  const gotArtist = norm(song.primary_artist && song.primary_artist.name);
  if (wantArtist && gotArtist && (wantArtist === gotArtist || gotArtist.includes(wantArtist) || wantArtist.includes(gotArtist))) score += 40;
  return score;
}

function pickGeniusHit(hits, artist, title) {
  const songs = (hits || []).map(h => (h && h.type === 'song' ? h.result : h && h.result) || null).filter(Boolean);
  const ranked = songs.map(song => ({ song, score: scoreHit(song, artist, title) })).sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const min = artist ? 70 : 55;
  return best && best.score >= min ? best.song : null;
}

function plainOf(body) {
  if (!body) return '';
  if (typeof body === 'string') return body.trim();
  return String(body.plain || body.html || '').trim();
}

function annotationFrom(referent) {
  const ann = (referent && referent.annotations && referent.annotations[0]) || {};
  const text = plainOf(ann.body);
  const fragment = String((referent && referent.fragment) || '').trim();
  if (!fragment || !text) return null;
  const votes = Number(ann.votes_total != null ? ann.votes_total : referent.votes_total) || 0;
  return { fragment, text, votes };
}

async function geniusFetch(path, token) {
  const r = await fetch(GENIUS_API + path, {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    const err = new Error(r.status === 401 ? 'Genius 權杖被拒絕' : 'Genius 回應 ' + r.status);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

async function geniusBundle(artist, title, token) {
  const q = encodeURIComponent([artist, cleanTitle(title)].filter(Boolean).join(' '));
  const search = await geniusFetch('/search?q=' + q, token);
  const hit = pickGeniusHit((search.response && search.response.hits) || [], artist, title);
  if (!hit) return null;
  const songRes = await geniusFetch('/songs/' + hit.id + '?text_format=plain', token);
  const song = (songRes.response && songRes.response.song) || hit;
  const annotations = [];
  for (let page = 1; page <= 10; page++) {
    const ref = await geniusFetch('/referents?song_id=' + hit.id + '&text_format=plain&per_page=50&page=' + page, token);
    const list = (ref.response && ref.response.referents) || [];
    for (const item of list) {
      const ann = annotationFrom(item);
      if (ann) annotations.push(ann);
    }
    if (list.length < 50) break;
  }
  const description = plainOf(song.description) || String(song.description_preview || '').trim();
  const art = song.song_art_image_thumbnail_url || song.song_art_image_url || song.header_image_thumbnail_url || song.header_image_url || '';
  return {
    title: song.title || hit.title || title,
    artist: (song.primary_artist && song.primary_artist.name) || (hit.primary_artist && hit.primary_artist.name) || artist,
    url: song.url || hit.url || '',
    description,
    art,
    annotations,
  };
}

function pickLrc(list, artist, title) {
  const rows = (Array.isArray(list) ? list : []).filter(row => row && (row.plainLyrics || row.syncedLyrics));
  const ranked = rows.map(row => ({
    row,
    score: scoreHit({ title: row.trackName, primary_artist: { name: row.artistName } }, artist, title),
  })).sort((a, b) => b.score - a.score);
  return ranked[0] && ranked[0].score >= (artist ? 70 : 55) ? ranked[0].row : null;
}

async function lrclibLyrics(artist, title) {
  const headers = { 'User-Agent': LRCLIB_UA, Accept: 'application/json' };
  const track = cleanTitle(title);
  const getUrl = 'https://lrclib.net/api/get?' + new URLSearchParams({ artist_name: artist, track_name: track });
  const got = await fetch(getUrl, { headers, signal: AbortSignal.timeout(12000) });
  if (got.ok) {
    const data = await got.json();
    if (data && data.plainLyrics) return String(data.plainLyrics);
  }
  const searchUrl = 'https://lrclib.net/api/search?q=' + encodeURIComponent([artist, track].filter(Boolean).join(' '));
  const found = await fetch(searchUrl, { headers, signal: AbortSignal.timeout(12000) });
  if (!found.ok) return '';
  const row = pickLrc(await found.json(), artist, title);
  return row ? String(row.plainLyrics || '') : '';
}

function emptySong(title, artist) {
  return { title, artist, url: '', description: '', art: '' };
}

async function fetchLyrics({ artist = '', title = '' } = {}) {
  title = String(title || '').trim();
  artist = String(artist || '').trim();
  if (!title) {
    const err = new Error('缺少歌名');
    err.status = 400;
    throw err;
  }
  const token = process.env.GENIUS_ACCESS_TOKEN || '';
  const key = norm(artist) + '|' + norm(cleanTitle(title)) + '|' + (token ? 'g' : 'l');
  const cached = cache.get(key);
  if (cached && Date.now() - cached.t < CACHE_TTL) return cached.data;

  let lyricsText = '';
  try { lyricsText = await lrclibLyrics(artist, title); } catch { lyricsText = ''; }
  const lyrics = lyricsText ? lyricsText.split('\n') : [];

  let song = emptySong(title, artist);
  let annotations = [];
  let note = '';
  if (!token) {
    note = '註解需要設定 GENIUS_ACCESS_TOKEN。目前只顯示 LRCLIB 歌詞。';
  } else {
    try {
      const bundle = await geniusBundle(artist, title, token);
      if (bundle) {
        song = {
          title: bundle.title,
          artist: bundle.artist,
          url: bundle.url,
          description: bundle.description,
          art: bundle.art,
        };
        annotations = bundle.annotations;
      } else note = 'Genius 上找不到相符的歌，目前只顯示 LRCLIB 歌詞。';
    } catch (err) {
      note = err.status === 401
        ? 'Genius 權杖無法使用，目前只顯示 LRCLIB 歌詞。'
        : 'Genius 註解暫時讀不到，目前只顯示 LRCLIB 歌詞。';
    }
  }
  if (!lyrics.length && !annotations.length) {
    const err = new Error(token ? '找不到這首歌的歌詞或註解' : '找不到這首歌的歌詞。註解需要設定 GENIUS_ACCESS_TOKEN。');
    err.status = 404;
    throw err;
  }
  const data = { song, lyrics, annotations, note };
  cache.set(key, { t: Date.now(), data });
  return data;
}

module.exports = { fetchLyrics, pickGeniusHit, scoreHit, cleanTitle, annotationFrom };
