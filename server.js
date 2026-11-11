// Spotify 30 秒試聽播放器 - 後端（無需任何 Spotify 憑證，零依賴）
const http = require('http');
const fs = require('fs');
const path = require('path');
const { matchYouTube, matchMany } = require('./youtube');

const PORT = process.env.PORT || 8787;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const cache = new Map(); // key -> {t, data}
const TTL = 30 * 60 * 1000;

async function fetchEmbed(type, id) {
  const key = type + ':' + id;
  const c = cache.get(key);
  if (c && Date.now() - c.t < TTL) return c.data;
  const r = await fetch(`https://open.spotify.com/embed/${type}/${id}`, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8' } });
  if (!r.ok) throw new Error(`Spotify 回應 ${r.status}`);
  const html = await r.text();
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('找不到內嵌資料（可能是私人歌單或網址錯誤）');
  const entity = JSON.parse(m[1])?.props?.pageProps?.state?.data?.entity;
  if (!entity) throw new Error('找不到歌單資料（可能是私人歌單或網址錯誤）');
  cache.set(key, { t: Date.now(), data: entity });
  return entity;
}

function pickImage(imgs, size = 300) {
  if (!Array.isArray(imgs) || !imgs.length) return null;
  const s = [...imgs].sort((a, b) => Math.abs((a.maxWidth || a.width || 0) - size) - Math.abs((b.maxWidth || b.width || 0) - size));
  return String(s[0].url).replace(/^https:\/\/image-cdn-[a-z]+\.spotifycdn\.com\//, 'https://i.scdn.co/');
}

// Public embed pages sometimes include a music-video preview. Canvas / Clips files are not in this payload.
function httpUrl(v) {
  return typeof v === 'string' && /^https?:\/\//i.test(v) ? v : null;
}
function pickVideoUrl(entity) {
  const v = entity && entity.videoPreview;
  if (!v) return null;
  if (httpUrl(v)) return v;
  const direct = httpUrl(v.url) || httpUrl(v.uri);
  if (direct) return direct;
  const sources = Array.isArray(v.sources) ? v.sources : [];
  for (const s of sources) {
    const u = httpUrl(s && (s.url || s.uri));
    if (u) return u;
  }
  return null;
}
function pickVideoThumb(entity) {
  const t = entity && entity.videoThumbnailImage;
  if (!t) return null;
  if (httpUrl(t)) return t;
  if (httpUrl(t.url)) return t.url;
  return pickImage(t.sources || t.image || (Array.isArray(t) ? t : null), 300);
}

function parseUrl(input) {
  input = (input || '').trim();
  let m = input.match(/spotify:(playlist|album|track):([A-Za-z0-9]{22})/);
  if (m) return { type: m[1], id: m[2] };
  m = input.match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?(playlist|album|track)\/([A-Za-z0-9]{22})/);
  if (m) return { type: m[1], id: m[2] };
  m = input.match(/^([A-Za-z0-9]{22})$/);
  if (m) return { type: 'playlist', id: m[1] };
  return null;
}

async function getCollection(type, id) {
  const e = await fetchEmbed(type, id);
  const cover = pickImage(e.visualIdentity?.image || e.coverArt?.sources, 300);
  let list;
  if (type === 'track') {
    list = [{ uri: e.uri, title: e.title || e.name, subtitle: (e.artists || []).map(a => a.name).join(', '), duration: e.duration, audioPreview: e.audioPreview }];
  } else list = e.trackList || [];
  const tracks = list.filter(t => (t.uri || '').startsWith('spotify:track:')).map(t => ({
    id: t.uri.split(':')[2],
    title: t.title,
    artist: t.subtitle,
    duration: t.duration,
    preview: t.audioPreview?.url || null,
    cover: type === 'track' ? cover : (type === 'album' ? cover : null),
    video: pickVideoUrl(t),
    videoThumb: pickVideoThumb(t),
  }));
  return { type, id, name: e.name || e.title, owner: e.subtitle, cover, tracks, limited: type !== 'track' && tracks.length >= 100 };
}

async function getTrack(id) {
  const e = await fetchEmbed('track', id);
  return {
    id, title: e.title || e.name, artist: (e.artists || []).map(a => a.name).join(', '),
    duration: e.duration, preview: e.audioPreview?.url || null,
    cover: pickImage(e.visualIdentity?.image, 300),
    video: pickVideoUrl(e),
    videoThumb: pickVideoThumb(e),
  };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', c => {
      n += c.length;
      if (n > limit) { reject(new Error('內容過大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/api/playlist') {
      const p = parseUrl(u.searchParams.get('url'));
      if (!p) return send(res, 400, { error: '請輸入有效的 Spotify 歌單網址，例如 https://open.spotify.com/playlist/...' });
      return send(res, 200, await getCollection(p.type, p.id));
    }
    let m = u.pathname.match(/^\/api\/track\/([A-Za-z0-9]{22})$/);
    if (m) return send(res, 200, await getTrack(m[1]));
    if (u.pathname === '/api/youtube' && req.method === 'GET') {
      const title = u.searchParams.get('title') || '';
      if (!title.trim()) return send(res, 400, { error: '缺少歌名' });
      return send(res, 200, await matchYouTube({
        artist: u.searchParams.get('artist') || '',
        title,
        duration: Number(u.searchParams.get('duration')) || 0,
      }));
    }
    if (u.pathname === '/api/youtube' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const tracks = Array.isArray(body.tracks) ? body.tracks.slice(0, 30) : [];
      if (!tracks.length) return send(res, 400, { error: '缺少歌曲' });
      return send(res, 200, { results: await matchMany(tracks, 3) });
    }
    if (u.pathname === '/api/health') return send(res, 200, { ok: true });
    let f = u.pathname === '/' ? '/index.html' : u.pathname;
    const fp = path.join(__dirname, 'public', path.normalize(f).replace(/^(\.\.[\/\\])+/, ''));
    if (!fp.startsWith(path.join(__dirname, 'public'))) return send(res, 403, { error: 'forbidden' });
    fs.readFile(fp, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
      res.end(buf);
    });
  } catch (err) {
    send(res, 502, { error: err.message || String(err) });
  }
}).listen(PORT, '0.0.0.0', () => console.log(`Spotify 試聽播放器: http://0.0.0.0:${PORT}`));
