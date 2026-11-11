const { spawn } = require('child_process');
const base = process.argv[2] || 'http://localhost:8787';
const PL = 'https://open.spotify.com/playlist/37i9dQZF1DX4W3aJJYCDfV?si=kGtOCV5sST-XBHLWM8t15Q&utm_source=copy-link';
const c = spawn('google-chrome', ['--headless=new','--no-sandbox','--disable-gpu','--mute-audio','--hide-scrollbars','--window-size=1440,900','--remote-debugging-port=9334','--user-data-dir=/tmp/e2eprof'+Date.now(),'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  let tabs; for (let i = 0; i < 40; i++) { try { tabs = await (await fetch('http://127.0.0.1:9334/json')).json(); break; } catch { await sleep(300); } }
  const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
  let id = 0; const pend = {}; let dialogText = null;
  ws.onmessage = e => { const m = JSON.parse(e.data);
    if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: true, promptText: dialogText || '' });
    if (pend[m.id]) { pend[m.id](m.result || m.error); delete pend[m.id]; } };
  await new Promise(r => ws.onopen = r);
  const send = (method, params = {}) => new Promise(r => { pend[++id] = r; ws.send(JSON.stringify({ id, method, params })); });
  const ev = async x => (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.value;
  const click = async sel => {
    const r = await ev(`(()=>{const b=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return [b.x+b.width/2,b.y+b.height/2]})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: r[0], y: r[1], button: 'left', clickCount: 1 });
  };
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: base + '/' });
  await sleep(2500);
  await ev(`localStorage.clear(); document.querySelector('#urlInput').value = ${JSON.stringify(PL)}`);
  await click('#loadBtn');               // 真實的使用者點擊
  await sleep(6000);
  const s1 = JSON.parse(await ev(`JSON.stringify({name: state.source&&state.source.name, rows: document.querySelectorAll('.track').length, withPreview: state.source.tracks.filter(t=>t.preview).length, now: $('#nowTitle').textContent, paused: audio.paused, t: audio.currentTime, covers: state.source.tracks.filter(t=>t.cover).length})`));
  console.log('1) 載入後:', s1);
  await ev(`audio.currentTime = audio.duration - 0.5`); await sleep(2500);
  console.log('2) 播完自動下一首:', await ev(`JSON.stringify({qIndex: state.qIndex, now: $('#nowTitle').textContent, paused: audio.paused, t: audio.currentTime})`));
  await click('.track[data-i="2"] .add'); await sleep(300);
  await ev(`document.querySelector('#sheetName').value = '我的最愛'`);
  await click('#sheetCreate button'); await sleep(500);
  await click('.track[data-i="5"] .add'); await sleep(300);
  await click('#sheetList button[data-pl]'); await sleep(500);
  console.log('3) 自訂歌單 localStorage:', await ev(`JSON.stringify(JSON.parse(localStorage.getItem('spp.customPlaylists.v1')).map(p=>({name:p.name, tracks:p.tracks.map(t=>t.title)})))`));
  await click('#customList .side-item'); await sleep(500);
  await click('#playAllBtn'); await sleep(3000);
  console.log('4) 播放自訂歌單:', await ev(`JSON.stringify({view: $('#viewTitle').textContent, queueKey: state.queueKey, now: $('#nowTitle').textContent, paused: audio.paused, t: audio.currentTime})`));
  await click('#renameBtn'); await sleep(300);
  await ev(`document.querySelector('#modalInput').value = '週末歌單'`);
  await click('#modalConfirm'); await sleep(500);
  console.log('5) 重新命名:', await ev(`$('#viewTitle').textContent`));
  // 回到來源歌單截圖
  await click('#sourceItem'); await sleep(2500);
  const s = await send('Page.captureScreenshot', { format: 'png' });
  require('fs').writeFileSync('/workspace/spotify-preview-player/screenshot.png', Buffer.from(s.data, 'base64'));
  await click('#customList .side-item'); await sleep(800);
  const s2 = await send('Page.captureScreenshot', { format: 'png' });
  require('fs').writeFileSync('/workspace/spotify-preview-player/screenshot-custom.png', Buffer.from(s2.data, 'base64'));
  console.log('screenshots saved');
  c.kill(); process.exit(0);
})().catch(e => { console.error(e); c.kill(); process.exit(1); });
