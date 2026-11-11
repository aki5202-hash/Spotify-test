// Song introductions from Wikipedia. No API key.
const UA = 'SpotifyPreviewPlayer/1.0 (song intros; contact: github.com/aki5202-hash/Spotify-test)';
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

function coreTitle(wikiTitle) {
  return String(wikiTitle || '')
    .replace(/\s*[\(（][^)）]*(?:song|歌曲|單曲|单曲)[^)）]*[\)）]\s*$/i, '')
    .replace(/[.\s]+$/g, '')
    .trim();
}

function isSongMatch(wikiTitle, songTitle) {
  const w = norm(coreTitle(wikiTitle));
  const s = norm(String(songTitle || '').replace(/[.\s]+$/g, ''));
  return !!(w && s && w === s);
}

function isAlbumPage(wikiTitle) {
  return /專輯|专辑|album|discography|音樂作品列表|作品列表/i.test(wikiTitle || '');
}

async function wikiFetch(url, lang) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      'Accept-Language': lang === 'zh' ? 'zh-TW,zh;q=0.9,en;q=0.3' : 'en',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) return null;
  return r.json();
}

function api(lang, params) {
  const host = lang === 'zh' ? 'zh.wikipedia.org' : 'en.wikipedia.org';
  const q = new URLSearchParams({ format: 'json', utf8: '1', ...params });
  if (lang === 'zh') q.set('variant', 'zh-tw');
  return `https://${host}/w/api.php?${q}`;
}

async function search(lang, query) {
  const data = await wikiFetch(api(lang, {
    action: 'query',
    list: 'search',
    srsearch: query,
    srlimit: '8',
  }), lang);
  return (data && data.query && data.query.search) || [];
}

async function findSong(lang, title, artist) {
  const q = lang === 'zh'
    ? [title, artist, '歌曲'].filter(Boolean).join(' ')
    : [title, artist, 'song'].filter(Boolean).join(' ');
  const hits = await search(lang, q);
  const song = hits.find(h => isSongMatch(h.title, title) && !isAlbumPage(h.title));
  return song ? { lang, title: song.title } : null;
}

async function findArtist(lang, artist) {
  if (!artist) return null;
  const hits = await search(lang, artist);
  const person = hits.find(h => norm(h.title) === norm(artist) && !isAlbumPage(h.title) && !isSongMatch(h.title, artist));
  return person ? { lang, title: person.title } : null;
}

async function loadPage(found, type) {
  const host = found.lang === 'zh' ? 'zh.wikipedia.org' : 'en.wikipedia.org';
  const summary = await wikiFetch(`https://${host}/api/rest_v1/page/summary/${encodeURIComponent(found.title.replace(/ /g, '_'))}`, found.lang);
  const extracted = await wikiFetch(api(found.lang, {
    action: 'query',
    prop: 'extracts',
    exintro: '1',
    explaintext: '1',
    redirects: '1',
    titles: found.title,
  }), found.lang);
  const page = extracted && extracted.query && extracted.query.pages && Object.values(extracted.query.pages)[0];
  const summaryText = (summary && summary.extract) || '';
  const longText = (page && page.extract) || '';
  const extract = longText.length > summaryText.length ? longText : summaryText;
  if (!extract) return null;
  const thumb = summary && summary.thumbnail && summary.thumbnail.source;
  const url = (summary && summary.content_urls && summary.content_urls.desktop && summary.content_urls.desktop.page)
    || `https://${host}/wiki/${encodeURIComponent(found.title.replace(/ /g, '_'))}`;
  return {
    type,
    lang: found.lang,
    title: (summary && summary.title) || (page && page.title) || found.title,
    extract,
    thumbnail: thumb || '',
    url,
  };
}

async function fetchAbout({ artist = '', title = '' } = {}) {
  title = String(title || '').trim();
  artist = String(artist || '').trim();
  if (!title) {
    const err = new Error('缺少歌名');
    err.status = 400;
    throw err;
  }
  const key = norm(artist) + '|' + norm(title);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.t < CACHE_TTL) return cached.data;

  const song = await findSong('zh', title, artist) || await findSong('en', title, artist);
  let data = song ? await loadPage(song, 'song') : null;
  if (!data && artist) {
    const person = await findArtist('zh', artist) || await findArtist('en', artist);
    data = person ? await loadPage(person, 'artist') : null;
  }
  if (!data) {
    const err = new Error('找不到這首歌的介紹。');
    err.status = 404;
    throw err;
  }
  cache.set(key, { t: Date.now(), data });
  return data;
}

module.exports = { fetchAbout, isSongMatch, isAlbumPage, coreTitle };
