// Public Genius lyrics + annotations. No API token. Cloudflare may block datacenter IPs.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const CACHE_TTL = 6 * 60 * 60 * 1000;
const cache = new Map();

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\u4e00-\u9fff]+/gi, ' ').replace(/\s+/g, ' ').trim();
}
function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
function htmlToText(html) {
  return decodeEntities(String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function looksBlocked(status, body, headerValue) {
  if (status === 401 || status === 403 || status === 429 || status === 503) return true;
  if (/challenge/i.test(headerValue || '')) return true;
  const head = String(body || '').slice(0, 2500);
  return /make sure you're a human|Just a moment|cf-browser|recaptcha/i.test(head);
}

async function geniusGet(url, accept) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': accept || 'application/json', 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(15000),
  });
  const body = await r.text();
  if (looksBlocked(r.status, body, r.headers.get('cf-mitigated'))) {
    const err = new Error('Genius 目前擋住了這個伺服器（Cloudflare 人機驗證），暫時讀不到歌詞。');
    err.blocked = true;
    throw err;
  }
  if (!r.ok) throw new Error('Genius 回應 ' + r.status);
  return body;
}

function extractContainers(html) {
  const out = [];
  const re = /<div\b[^>]*\bdata-lyrics-container="true"[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    let i = re.lastIndex;
    let depth = 1;
    let buf = '';
    while (i < html.length && depth > 0) {
      const nextOpen = html.toLowerCase().indexOf('<div', i);
      const nextClose = html.toLowerCase().indexOf('</div>', i);
      if (nextClose < 0) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        buf += html.slice(i, nextOpen);
        depth++;
        const gt = html.indexOf('>', nextOpen);
        i = gt < 0 ? html.length : gt + 1;
      } else {
        depth--;
        if (depth === 0) buf += html.slice(i, nextClose);
        else buf += html.slice(i, nextClose + 6);
        i = nextClose + 6;
      }
    }
    out.push(buf);
  }
  return out;
}

function lyricsTextFromHtml(html) {
  const chunks = extractContainers(html);
  const raw = chunks.length ? chunks.join('\n') : '';
  return htmlToText(raw);
}

function annotationText(referent) {
  const ann = (referent.annotations || [])[0];
  if (!ann) return '';
  const body = ann.body || {};
  return htmlToText(body.html || body.plain || '');
}

function buildLines(lyricsText, referents) {
  const lines = String(lyricsText || '').split('\n');
  const notes = (referents || [])
    .map(r => ({ fragment: String(r.fragment || '').trim(), note: annotationText(r) }))
    .filter(n => n.fragment && n.note)
    .sort((a, b) => b.fragment.length - a.fragment.length);
  const used = new Set();
  return lines.map(line => {
    const parts = [{ text: line, note: null }];
    for (const n of notes) {
      if (used.has(n.fragment)) continue;
      for (let i = 0; i < parts.length; i++) {
        if (parts[i].note) continue;
        const idx = parts[i].text.indexOf(n.fragment);
        if (idx < 0) continue;
        const before = parts[i].text.slice(0, idx);
        const after = parts[i].text.slice(idx + n.fragment.length);
        const repl = [];
        if (before) repl.push({ text: before, note: null });
        repl.push({ text: n.fragment, note: n.note });
        if (after) repl.push({ text: after, note: null });
        parts.splice(i, 1, ...repl);
        used.add(n.fragment);
        break;
      }
    }
    return { parts };
  });
}

function scoreSong(song, artist, title) {
  const st = norm(song.title);
  const want = norm(String(title || '').replace(/\(.*?\)/g, ' '));
  let score = 0;
  if (st && want && st === want) score += 60;
  else if (st && want && (st.includes(want) || want.includes(st))) score += 35;
  const art = norm(song.primary_artist && (song.primary_artist.name || song.primary_artist));
  const wa = norm(String(artist || '').split(/,|&/)[0]);
  if (art && wa && (art === wa || art.includes(wa) || wa.includes(art))) score += 40;
  if (/lyrics/i.test(song.url || song.path || '')) score += 5;
  return score;
}

function songList(data) {
  const sections = (data && data.response && data.response.sections) || [];
  const songs = [];
  for (const section of sections) {
    if (section.type !== 'song') continue;
    for (const hit of section.hits || []) if (hit && hit.result) songs.push(hit.result);
  }
  return songs;
}

async function fetchReferents(songId) {
  const all = [];
  for (let page = 1; page <= 6; page++) {
    const body = await geniusGet(`https://genius.com/api/referents?song_id=${songId}&text_format=html&per_page=50&page=${page}`);
    const parsed = JSON.parse(body);
    const list = (parsed.response && parsed.response.referents) || [];
    all.push(...list);
    if (list.length < 50) break;
  }
  return all;
}

async function fetchLyrics({ artist = '', title = '' } = {}) {
  title = String(title || '').trim();
  artist = String(artist || '').trim();
  if (!title) {
    const err = new Error('缺少歌名');
    err.status = 400;
    throw err;
  }
  const key = norm(artist) + '|' + norm(title);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.data;
  const searchBody = await geniusGet('https://genius.com/api/search/multi?q=' + encodeURIComponent([artist, title].filter(Boolean).join(' ')));
  const songs = songList(JSON.parse(searchBody));
  const ranked = songs.map(s => ({ s, score: scoreSong(s, artist, title) })).sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score < 40) {
    const err = new Error('在 Genius 上找不到相符的歌');
    err.status = 404;
    throw err;
  }
  const song = best.s;
  const pageUrl = song.url || ('https://genius.com' + (song.path || ''));
  const pageHtml = await geniusGet(pageUrl, 'text/html');
  const lyricsText = lyricsTextFromHtml(pageHtml);
  const referents = await fetchReferents(song.id);
  let about = '';
  try {
    const songJson = JSON.parse(await geniusGet(`https://genius.com/api/songs/${song.id}?text_format=html`));
    const full = songJson.response && songJson.response.song;
    const desc = full && (full.description || full.description_annotation);
    about = htmlToText((desc && (desc.html || (desc.annotations && desc.annotations[0] && desc.annotations[0].body && desc.annotations[0].body.html))) || '');
  } catch {}
  const data = {
    title: song.title || title,
    artist: (song.primary_artist && song.primary_artist.name) || artist,
    url: pageUrl,
    about,
    lines: buildLines(lyricsText, referents),
    annotationCount: referents.filter(r => annotationText(r)).length,
  };
  if (!lyricsText.trim()) {
    const err = new Error('這首歌在 Genius 上沒有歌詞');
    err.status = 404;
    throw err;
  }
  cache.set(key, { t: Date.now(), data });
  return data;
}

module.exports = { fetchLyrics, buildLines, lyricsTextFromHtml, htmlToText, scoreSong, looksBlocked };
