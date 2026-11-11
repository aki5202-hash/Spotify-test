# 🎧 Spotify 30 秒試聽播放器

貼上 Spotify 歌單網址 → 自動載入每首歌的 30 秒試聽並連續播放 → 隨時把喜歡的歌加入自己的歌單。

## 功能
- 貼上 `https://open.spotify.com/playlist/...`（含 `?si=...` 參數也可以；也支援專輯 `album/` 與單曲 `track/` 網址）
- 按「載入並播放」立即開始播放，一首播完自動下一首（可關閉「自動下一首」）
- 播放 / 暫停 / 上一首 / 下一首、進度條拖曳、音量、隨機播放；空白鍵播放/暫停、Shift+←/→ 切歌
- 歌曲列表顯示封面、歌名、歌手、長度，正在播放的歌會標示
- 「我的歌單」：新增、重新命名、刪除歌單；任何歌曲（列表或播放列上的 ＋）都能加入；可從歌單移除歌曲；自訂歌單一樣能播放
- 自訂歌單存在瀏覽器的 localStorage（同一個瀏覽器、同一個網址下會保留）
- 網址可帶參數：`/?url=<歌單網址>&autoload=1` 會自動載入

## 運作原理（不需要任何 Spotify 帳號或 API 金鑰）
Spotify Web API 自 2024/11 起對新應用不再提供 `preview_url`，而且需要憑證。
本專案改用 Spotify 公開的嵌入頁面：
1. 後端抓 `https://open.spotify.com/embed/playlist/<id>`，解析頁面中的 `__NEXT_DATA__` JSON，
   取得歌單名稱、封面與每首歌的 `audioPreview.url`（`https://p.scdn.co/mp3-preview/...`，30 秒 MP3）。
2. 每首歌的封面再由 `https://open.spotify.com/embed/track/<id>` 取得（前端以 4 個並行請求慢慢補齊，伺服器端快取 30 分鐘）。
3. 前端用 `<audio>` 直接播放 p.scdn.co 的 MP3。

## 執行
需要 Node.js 18 以上（無任何 npm 依賴）。
```bash
cd spotify-preview-player
node server.js            # 預設 http://localhost:8787
PORT=3000 node server.js  # 自訂埠號
```
打開瀏覽器到 http://localhost:8787 ，貼上歌單網址按「載入並播放」。

### API
- `GET /api/playlist?url=<Spotify 網址或 ID>` → `{ name, owner, cover, tracks:[{id,title,artist,duration,preview,cover,video,videoThumb}], limited }`
- `GET /api/track/<trackId>` → `{ id, title, artist, duration, preview, cover, video, videoThumb }`
- `video` 只會在公開嵌入頁的 `videoPreview` 有網址時出現（不使用登入憑證）。Canvas / Clips 的 `canvaz.scdn.co` 影片不在這個公開資料裡。
- `GET /api/youtube?artist=&title=&duration=` → 比對公開 YouTube 搜尋結果後的 `{ picked, candidates, skipped }`（伺服器會快取，不使用 API 金鑰）
- `POST /api/youtube` body `{ tracks:[{id,artist,title,duration}] }`（一次最多 30 首）→ `{ results:[...] }`

播放列可在「試聽」與「YouTube」之間切換。YouTube 模式會放上標準的 `youtube.com/embed` 播放器（`playsinline=1`），第一首由使用者點播放器上的播放鍵；之後用同一個播放器在影片結束時自動換下一首。配對時會用 oEmbed 確認影片允許內嵌。

鎖屏控制只註冊上一首／下一首（不註冊 10 秒快轉）。「鎖屏上一首 = 加入預設歌單」預設關閉。自訂歌單可匯出 JSON / CSV / 文字清單，並用「在 YouTube 開啟」把已配對的影片組成 `watch_videos` 歌單（每段最多 50 首）。

### 端到端測試（選用，需要 Google Chrome）
```bash
node server.js &
node tests/e2e.js http://localhost:8787
```

## 限制
- **每個歌單最多 100 首**：Spotify 嵌入頁只回傳前 100 首，超過的部分無法載入（畫面會提示）。
- 只支援**公開**歌單；私人歌單無法讀取。
- 少數歌曲可能沒有試聽（依地區/版權），會標示「無試聽」並在自動播放時跳過；點擊可到 Spotify 開啟。
- 這是解析 Spotify 非官方的嵌入頁面，若 Spotify 改版可能需要更新解析程式（`server.js`）。
- 瀏覽器會擋「沒有使用者操作的自動播放」，所以播放是在按下「載入並播放」時開始；若被擋請按 ▶。
