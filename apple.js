// Apple Music playlists, albums, and songs. No API key.
// Pages do not include preview files. Those come from the public iTunes Search API (30s m4a).
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const cache = new Map();
const TTL = 30 * 60 * 1000;
const LOOKUP_BATCH = 150;

function fail(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function parseAppleUrl(input) {
  let u;
  try { u = new URL(String(input || '').trim()); } catch { return null; }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  if (host !== 'music.apple.com' && host !== 'embed.music.apple.com' && host !== 'geo.music.apple.com') return null;
  const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  let storefront = 'us';
  let idx = 0;
  if (parts[0] && /^[a-z]{2}$/i.test(parts[0])) {
    storefront = parts[0].toLowerCase();
    idx = 1;
  }
  const kind = (parts[idx] || '').toLowerCase();
  if (kind !== 'playlist' && kind !== 'album' && kind !== 'song') return null;
  const id = parts[parts.length - 1] || '';
  if (kind === 'playlist') {
    if (!/^pl\.[A-Za-z0-9._-]+$/.test(id)) return null;
  } else if (!/^\d+$/.test(id)) return null;
  const songFromQuery = u.searchParams.get('i');
  const songId = kind === 'song' ? id : (songFromQuery && /^\d+$/.test(songFromQuery) ? songFromQuery : null);
  const type = kind === 'playlist' ? 'playlist' : songId ? 'track' : 'album';
  const slug = parts.length > idx + 2 ? parts[idx + 1] : '';
  return { source: 'apple', type, kind, id: songId || id, pageId: id, songId, storefront, slug };
}

function pageUrl(parsed) {
  const slug = parsed.slug ? encodeURIComponent(parsed.slug) + '/' : '';
  const base = `https://music.apple.com/${parsed.storefront}/${parsed.kind}/${slug}${encodeURIComponent(parsed.pageId)}`;
  if (parsed.kind === 'album' && parsed.songId) return `${base}?i=${parsed.songId}`;
  return base;
}

function langFor(storefront) {
  if (storefront === 'tw' || storefront === 'hk' || storefront === 'mo') return 'zh-TW,zh;q=0.9,en;q=0.5';
  if (storefront === 'cn') return 'zh-CN,zh;q=0.9,en;q=0.5';
  if (storefront === 'jp') return 'ja,en;q=0.5';
  return 'en-US,en;q=0.9';
}

async function fetchText(url, storefront) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': langFor(storefront) },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw fail(`Apple Music 回應 ${r.status}`, r.status === 404 ? 404 : 502);
  return r.text();
}

async function fetchJson(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw fail(`iTunes 回應 ${r.status}`, 502);
  return r.json();
}

function scriptById(html, id) {
  const re = new RegExp(`<script\\b[^>]*\\bid=["']?${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?[^>]*>`, 'i');
  const m = re.exec(html);
  if (!m) return null;
  const start = m.index + m[0].length;
  const end = html.indexOf('</script>', start);
  if (end < 0) return null;
  return html.slice(start, end).trim();
}

function artworkUrl(art, size = 300) {
  const url = art && ((art.dictionary && art.dictionary.url) || art.url);
  if (typeof url !== 'string' || !url) return null;
  if (url.includes('{w}')) return url.replaceAll('{w}', String(size)).replaceAll('{h}', String(size)).replaceAll('{f}', 'jpg');
  return url.replace(/\/\d+x\d+(bb|sr|cc)\./, `/${size}x${size}bb.`);
}

function linkTitles(links) {
  return (Array.isArray(links) ? links : []).map(l => l && l.title).filter(Boolean).join(', ');
}

function artistsOf(item) {
  if (!item) return '';
  if (typeof item.artistName === 'string' && item.artistName.trim()) return item.artistName.trim();
  if (typeof item.artists === 'string' && item.artists.trim()) return item.artists.trim();
  if (Array.isArray(item.artists)) {
    const names = item.artists.map(a => (typeof a === 'string' ? a : a && (a.name || a.title))).filter(Boolean);
    if (names.length) return names.join(', ');
  }
  if (item.contentDescriptor && item.contentDescriptor.kind === 'song') return linkTitles(item.subtitleLinks);
  return '';
}

function songIdOf(item) {
  const cd = item && item.contentDescriptor;
  const id = cd && cd.identifiers && cd.identifiers.storeAdamID;
  if (!id || !/^\d+$/.test(String(id))) return null;
  if (cd.kind && cd.kind !== 'song') return null;
  return String(id);
}

function sectionsOf(data) {
  const root = data && Array.isArray(data.data) ? data.data[0] : null;
  const inner = root && root.data;
  return (inner && inner.sections) || [];
}

function songsFromSerialized(data, storefront) {
  const songs = [];
  const seen = new Set();
  let header = null;
  let rawCount = 0;
  for (const sec of sectionsOf(data)) {
    for (const item of sec.items || []) {
      const cd = item.contentDescriptor || {};
      if (!header && item.title && (cd.kind === 'playlist' || cd.kind === 'album')) header = item;
      const id = songIdOf(item);
      if (cd.kind === 'song') rawCount++;
      if (!id || seen.has(id) || !item.title) continue;
      seen.add(id);
      songs.push({
        id,
        title: String(item.title),
        artist: artistsOf(item),
        duration: Number(item.duration) || 0,
        cover: artworkUrl(item.artwork, 300),
        url: cd.url || `https://music.apple.com/${storefront}/song/${id}`,
      });
    }
  }
  return { songs, header, rawCount };
}

function isoDurationMs(v) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(String(v || ''));
  if (!m) return 0;
  return Math.round(((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000);
}

function songsFromLd(html) {
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const songs = [];
  let name = '';
  let url = '';
  let owner = '';
  let cover = null;
  let m;
  while ((m = re.exec(html))) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const list = Array.isArray(data) ? data : [data];
    for (const node of list) {
      if (!node || (node['@type'] !== 'MusicPlaylist' && node['@type'] !== 'MusicAlbum' && node['@type'] !== 'MusicRecording')) continue;
      if (!name && node.name) name = node.name;
      if (!url && node.url) url = node.url;
      if (!cover && node.image) cover = typeof node.image === 'string' ? node.image : (node.image.url || null);
      const author = node.author || node.byArtist;
      if (!owner && author) owner = typeof author === 'string' ? author : (author.name || '');
      let tracks = node.track || node.tracks || [];
      if (tracks && tracks.itemListElement) tracks = tracks.itemListElement.map(e => e.item || e);
      if (!Array.isArray(tracks)) tracks = [tracks];
      if (node['@type'] === 'MusicRecording') tracks = [node];
      for (const t of tracks) {
        if (!t) continue;
        const idMatch = String(t.url || '').match(/\/(\d+)(?:\?.*)?$/);
        const id = idMatch ? idMatch[1] : '';
        if (!id) continue;
        const audio = t.audio || {};
        songs.push({
          id,
          title: t.name || '',
          artist: typeof t.byArtist === 'string' ? t.byArtist : (t.byArtist && t.byArtist.name) || '',
          duration: isoDurationMs(t.duration),
          cover: audio.thumbnailUrl || cover || null,
          url: t.url || '',
        });
      }
    }
  }
  const seen = new Set();
  const unique = songs.filter(s => (seen.has(s.id) ? false : (seen.add(s.id), true)));
  return { songs: unique, name, url, owner, cover };
}

function itunesArt(url) {
  if (!url) return null;
  return String(url).replace(/\/\d+x\d+bb\./, '/300x300bb.');
}

async function lookupSongs(ids, country) {
  const map = new Map();
  const unique = [...new Set(ids.map(String))];
  for (let i = 0; i < unique.length; i += LOOKUP_BATCH) {
    const batch = unique.slice(i, i + LOOKUP_BATCH);
    const url = `https://itunes.apple.com/lookup?id=${batch.join(',')}&country=${encodeURIComponent(country)}&entity=song`;
    let data;
    try { data = await fetchJson(url); } catch { continue; }
    for (const r of data.results || []) {
      const id = r.trackId || r.collectionId;
      if (!id || r.wrapperType === 'collection') continue;
      if (r.kind && r.kind !== 'song') continue;
      map.set(String(id), r);
    }
  }
  return map;
}

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\u4e00-\u9fff]+/gi, ' ').replace(/\s+/g, ' ').trim();
}

async function searchSong(title, artist, country) {
  const term = [title, artist].filter(Boolean).join(' ');
  if (!term) return null;
  const url = `https://itunes.apple.com/search?${new URLSearchParams({ term, entity: 'song', country, limit: '5' })}`;
  let data;
  try { data = await fetchJson(url); } catch { return null; }
  const want = norm(title);
  const songs = (data.results || []).filter(r => r.kind === 'song' && r.previewUrl);
  return songs.find(r => norm(r.trackName) === want) || songs[0] || null;
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function applyLookup(song, hit) {
  if (!hit) return song;
  return {
    ...song,
    title: song.title || hit.trackName || '',
    artist: song.artist || hit.artistName || '',
    duration: song.duration || hit.trackTimeMillis || 0,
    preview: hit.previewUrl || null,
    cover: song.cover || itunesArt(hit.artworkUrl100 || hit.artworkUrl60),
    url: song.url || hit.trackViewUrl || '',
  };
}

async function fillPreviews(songs, country) {
  let looked = await lookupSongs(songs.map(s => s.id), country);
  const missing = () => songs.filter(s => !(looked.get(s.id) && looked.get(s.id).previewUrl));
  if (missing().length > songs.length / 2 && country !== 'us') {
    const extra = await lookupSongs(missing().map(s => s.id), 'us');
    for (const [id, hit] of extra) if (!looked.has(id) || !looked.get(id).previewUrl) looked.set(id, hit);
  }
  const still = missing();
  const searched = new Map();
  if (still.length && still.length <= 40) {
    await mapPool(still, 4, async song => {
      const hit = await searchSong(song.title, song.artist, country);
      if (hit) searched.set(song.id, hit);
    });
  }
  return songs.map(song => applyLookup(song, looked.get(song.id) || searched.get(song.id)));
}

async function getAppleCollection(parsed) {
  const key = `apple:${parsed.storefront}:${parsed.type}:${parsed.id}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.t < TTL) return cached.data;
  const url = pageUrl(parsed);
  const html = await fetchText(url, parsed.storefront);
  let songs = [];
  let name = '';
  let owner = '';
  let cover = null;
  let trackCount = 0;
  let rawCount = 0;
  const raw = scriptById(html, 'serialized-server-data');
  if (raw) {
    let data;
    try { data = JSON.parse(raw); } catch { throw fail('Apple Music 頁面格式已變更', 502); }
    const parsedSongs = songsFromSerialized(data, parsed.storefront);
    songs = parsedSongs.songs;
    rawCount = parsedSongs.rawCount || songs.length;
    const header = parsedSongs.header;
    if (header) {
      name = header.title || '';
      owner = linkTitles(header.subtitleLinks);
      cover = artworkUrl(header.artwork, 600);
      trackCount = Number(header.trackCount) || 0;
    }
    if (!name) {
      const songHeader = sectionsOf(data).flatMap(s => s.items || []).find(item => item && item.title && songIdOf(item));
      if (songHeader) {
        name = songHeader.title;
        owner = artistsOf(songHeader);
        cover = cover || artworkUrl(songHeader.artwork, 600);
      }
    }
  }
  if (!songs.length) {
    const ld = songsFromLd(html);
    songs = ld.songs;
    name = name || ld.name;
    owner = owner || ld.owner;
    cover = cover || ld.cover;
  }
  if (parsed.songId) songs = songs.filter(s => s.id === String(parsed.songId));
  if (!songs.length) throw fail('找不到歌曲（可能是私人歌單或網址錯誤）', 404);
  songs = await fillPreviews(songs, parsed.storefront);
  const canonical = songs.length === 1 && parsed.type === 'track' ? (songs[0].url || url) : url;
  const data = {
    source: 'apple',
    type: parsed.type,
    id: parsed.id,
    storefront: parsed.storefront,
    name: name || (songs[0] && songs[0].title) || 'Apple Music',
    owner: owner || 'Apple Music',
    cover: cover || (songs[0] && songs[0].cover) || null,
    url: canonical,
    tracks: songs.map(s => ({
      id: s.id,
      title: s.title,
      artist: s.artist,
      duration: s.duration || 0,
      preview: s.preview || null,
      cover: s.cover || null,
      video: null,
      videoThumb: null,
      url: s.url || '',
    })),
    limited: parsed.type === 'playlist' && trackCount > rawCount,
  };
  cache.set(key, { t: Date.now(), data });
  return data;
}

module.exports = { parseAppleUrl, getAppleCollection, artworkUrl, songIdOf };
