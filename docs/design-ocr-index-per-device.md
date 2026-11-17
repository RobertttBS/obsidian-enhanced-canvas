# 設計決策：圖片與 PDF 文字 index 改為每台裝置自己建立

狀態：第 1 步已實作（PDF 改用 pdf.js：`1e62a31`；Windows 圖片 OCR：`5bfd901`、`bcd935b`、`9a628a1`。Windows OCR 2026-11-15 在 Windows 11 以腳本驗證，尚未在 Obsidian 內完整驗證）。第 2 步方向已決定（2026-11-17，見第 5 節），未實作。基準 commit：`bbe6964`（64-shard，只考慮單台 Mac 寫入）。
決策日期：2026-11-15。

## 1. 起因

- Obsidian Sync 不同步 plugin 資料夾裡的 `ocr-index/`（使用者實測）。
  - Obsidian Sync 在 plugin 資料夾只同步 `main.js`、`manifest.json`、`styles.css`、`data.json`。官方說明頁沒有列出這份清單（未確認），但與實測一致。
  - Obsidian Sync 不同步 `.` 開頭的資料夾，`.obsidian` 除外。
  - Obsidian Sync 單檔上限：Standard 5 MB，Plus 200 MB。最大 shard 34.1 MB。
- 現有設計只有 git、iCloud、Syncthing 這類同步工具能把 index 送到其他裝置。

## 2. 決策

1. **每台裝置自己建 index。** 目標是每個平台盡量能自己搜尋，同步只做補充。
2. **分步進行。** 第 1 步只處理 macOS 和 Windows 的本機 index。同步與儲存位置留到第 2 步。
3. **捨棄多台 Mac 合併寫入。** `bbe6964` 之後未 commit 的 `pending` + save 時讀檔合併已捨棄。每個 index 檔案只會有一台裝置寫入，所以不需要合併。
4. **不放進 `data.json`。** 原因：
   - `saveData()` 每次都重寫整個檔案，每次改設定都要重寫約 100 MB。
   - 每台裝置啟動時，`loadData()` 都會 parse 整個檔案。
   - Obsidian Sync 的 5 MB 上限與 GitHub 的 100 MiB 上限都會超過。
   - 多台裝置寫入時，後寫的會覆蓋先寫的設定與 index。

## 3. 各平台支援範圍（目標）

| 平台 | 圖片 | PDF |
|---|---|---|
| macOS | Vision，透過 `osascript`（現有） | pdf.js（`loadPdfJs()`，`obsidian` API） |
| Windows | `Windows.Media.Ocr`，透過 PowerShell；必須安裝該語言的 OCR 語言包 | pdf.js（`loadPdfJs()`，`obsidian` API） |
| Linux | 內建 OCR（PaddleOCR，見 `docs/design-builtin-ocr.md`） | pdf.js（第 1 步之後） |
| iPad、iPhone、Android | 不讀（無法執行外部程式；tesseract.js 需要下載語言資料，不採用）；搜尋電腦同步過來的結果（5.2） | pdf.js，每台裝置自己讀（5.6） |

pdf.js 中文抽字已在 Obsidian 內驗證（見第 4 節）；Windows OCR 只以腳本驗證。仍待實測：
- Windows OCR 的中文辨識品質。
- pdf.js 讀大型 PDF（14,777 頁、32.8 MB 文字）的時間與記憶體。

## 4. 第 1 步：macOS 與 Windows 的本機 index

範圍：
- Windows 桌面版可以讀圖片（`Windows.Media.Ocr`）和 PDF（pdf.js），並且寫入 index。
- `canIndex` 從「僅 macOS 桌面版」改為「macOS 或 Windows 桌面版」。
- 儲存格式維持 `bbe6964`：`<plugin dir>/ocr-index/00.json`…`3f.json`。
- 設定名稱與 README 中的「macOS」字樣隨之更新。

第 1 步的已知限制（留到第 2 步）：
- Mac 與 Windows 都寫入同一個透過 git 同步的 `ocr-index/` 時，後寫的會覆蓋先寫的 shard。被覆蓋的 entry 會在下次掃描時重新讀取，不會遺失使用者資料。
- 其他平台仍然只能搜尋同步過來的 index。

第 1 步實作前要決定：
- 已決定（2026-11-15）：macOS 的 PDF 也改用 pdf.js（`readPdf()`），PDFKit 程式碼已刪除。實測結果見 4.1、4.2。
  - 已驗證：在 Obsidian 內（`Robert_OB`，唯讀）用 `cMapUrl: '/lib/pdfjs/cmaps/'` 讀 826 頁的中文 PDF，抽出 577,091 字（其中中文 199,944 字），與 Node 結果相同。不傳 `cMapUrl` 時，中文只剩 3,300 字。
  - 未驗證：plugin reload 後的完整掃描流程；最大 PDF 在 Obsidian 內的記憶體用量。
- Windows 圖片 OCR（2026-11-15 實作；腳本已驗證，見下方，Obsidian 內未完整驗證）：
  - `powershell.exe -Command -` 執行 `WIN_OCR_SCRIPT`，腳本從 stdin 送入（2026-11-16 由 `-EncodedCommand` 改過來：編碼過的命令列是防毒/EDR 最先標記的特徵；stdin 版已在 Windows 上以獨立腳本驗證過中文 OCR、路徑含 `'` / `$` / 中文、CLM 結束碼 3、執行期錯誤結束碼 1，尚未在 Obsidian 內重新載入驗證）。解析期錯誤（含 AMSI 擋下腳本）在 `-Command -` 下結束碼是 0、只有 stderr，所以「沒有輸出但有 stderr」也視為失敗。stdin 會像互動輸入一樣逐句執行，所以整份腳本包在一個 `try` 裡成為單一語句，結尾要有空行。必須用 Windows PowerShell 5.1，PowerShell 7 不能載入 WinRT 型別。
  - 路徑以 JSON 嵌在腳本裡（`winOcrScript`；stdin 已被腳本佔用），非 ASCII 字元先轉成 `\uXXXX`，`'` 寫成 `''`。輸出格式與 macOS 相同。
  - 語言：依使用者在設定中的語言順序（`GlobalizationPreferences.Languages`），用第一個有 OCR 的中日韓語言；沒有才用第一個已安裝的中日韓 OCR 語言（系統列舉順序）；再沒有才用 `TryCreateFromUserProfileLanguages()`。`IsLanguageSupported` 接受 `zh-TW`、`zh-Hant` 對到已安裝的 `zh-Hant-TW`（2026-11-15 驗證；本機只有一個語言，多語言排序未實測）。一個引擎只認一種語言；中文引擎也認得英文，英文引擎會默默漏掉所有中文。
  - 無法執行的原因會寫進通知（`BLOCK_HINT`），並直接設定 `broken`，單張圖片也會觸發：exit 2 = 沒有 OCR 語言包；exit 3 = Constrained Language Mode（企業 AppLocker/WDAC）；無法啟動（ENOENT）= 找不到 PowerShell；其他啟動錯誤、stderr 出現 AMSI 訊息 = 防毒或安全政策封鎖；逐張重試而暫停時，若每次都是非 0 結束、stderr 空白、且不是我們自己 kill 的（EDR 無聲終止），或跨次掃描連續 3 次這樣結束（`silentRuns`，涵蓋每次只有一張圖的情況）= 被中途停止，提示同樣指向防毒/EDR。PowerShell 用完整路徑啟動。260 字元以上的圖片路徑會轉成 `\\?\`（UNC 為 `\\?\UNC\`）再交給 PowerShell：PS 5.1 在沒開 LongPathsEnabled 時讀不到長路徑（2026-11-15 驗證：365 字元路徑原樣 `null`，加前綴後成功）。
  - 「整批失敗 = OCR 壞掉」只計算 png/jpg/gif/tiff/bmp。HEIC、WebP 需要 Microsoft Store 的 codec，整批失敗不代表 OCR 壞掉，失敗通知會提示安裝 codec。
  - 2026-11-15 在 Windows 11（zh-Hant-TW）驗證：50 張一批 50/50 成功；webp、gif、中文路徑成功；Constrained Language Mode 回傳 exit 3；損壞的 HEIC 只讓該張回傳 null。
  - 圖片超過 `OcrEngine.MaxImageDimension` 時先等比縮小。
  - Windows OCR 在中日文字元之間插入空白。存入前用 `CJK_GAP` 移除。
  - Windows 實測項目：中文辨識品質；EXIF 旋轉的照片框線位置；HEIC、WebP 沒有 codec 時進入 `failed`；50 張一批的時間。

### 4.1 PDFKit 與 pdf.js 實測（2026-11-15）

環境：M 系列 Mac，Node v26。PDFKit 用 plugin 現有的 JXA `pdf()`（`osascript`）。pdf.js 用 `pdfjs-dist@5.3.31`，因為 Obsidian 內建的 5.3.34 不在 npm 上。pdf.js 以 `hasEOL` 分行，其餘處理與 PDFKit 版相同（`trim`、丟空行）。測試檔不是使用者 vault 的 PDF。

| PDF | 頁數 | PDFKit 時間 / RSS | pdf.js 時間 / RSS | 文字結果 |
|---|---|---|---|---|
| Xcode Acknowledgments | 231 | 0.58 s / 141 MB | 0.51 s / 164 MB | 去空白後 230/231 頁相同，字元數完全相同 |
| Photomator Acknowledgements | 64 | 0.22 s / 63 MB | 0.26 s / 138 MB | 字元重疊 99.9% |
| Keynote License（多語言） | 310 | 1.63 s / 284 MB | 1.67 s / 268 MB | 英文頁 pdf.js 把連字 `ﬀ` 還原成 `ff`；阿拉伯文頁 PDFKit 把一行拆成單字碎片，pdf.js 保留整行 |
| 自產中文 PDF（`cupsfilter`） | 3,000 | 6.78 s / 920 MB | 7.18 s / 539 MB | 見下方 |

結論：
- 速度：兩者相同，誤差在 10% 內。
- 英文：結果相同。pdf.js 對連字和阿拉伯文的結果較好。
- 中文：pdf.js 把部分漢字輸出成部首字元，例如 `大` 輸出成 `⼤`（U+2F24），用一般漢字搜尋會找不到。
  - `String.prototype.normalize('NFKC')` 修正康熙部首區（U+2F00–U+2FDF）。
  - NFKC 不修正 CJK 部首補充區（U+2E80–U+2EFF）。這份 PDF 中剩下 `⻄`（U+2EC4）和 `⺠`（U+2EA0）。
  - 原因未確認。推測是這份 PDF 沒有 ToUnicode，pdf.js 從字型 cmap 反查時選到部首字元。一般由 Word 或 LaTeX 產生的 PDF 通常有 ToUnicode，可能不受影響。
- 記憶體：PDFKit 在獨立的 `osascript` process 執行；pdf.js 在 Obsidian 內執行（`loadPdfJs()` 使用 worker）。大型 PDF 的記憶體會算在 Obsidian 身上。

### 4.2 使用者 vault 實測（2026-11-15，唯讀）

範圍：`Robert_OB` 的 302 份 PDF（其中 21 份含中文），條件與 4.1 相同。

| 項目 | PDFKit | pdf.js |
|---|---|---|
| 302 份總時間 | 127.2 s | 108.8 s |
| 最大 PDF（87 MB，14,777 頁） | 39.7 s / RSS 1.66 GB | 14.7 s / RSS 1.18 GB（加 CMap 後 0.90 GB） |
| 第二大頁數（5,158 頁） | 12.2 s / 1.81 GB | 4.5 s / 0.51 GB |
| 失敗 | 0 | 0 |
| index 大小 | 101.3 MB | 100.5 MB |

文字結果：
- 部首字元：302 份都沒有出現。4.1 的問題只出現在自產的 PDF。
- 去空白、NFKC 後，296/302 份的字元重疊 ≥ 99%。
- **必須提供 CMap。** 沒有傳 `cMapUrl` 時，2 份 LaTeX 產生的中文 PDF 掉了大部分中文字，重疊只有 0.63 和 0.70。傳入 `cMapUrl` + `cMapPacked: true` 之後，重疊變成 1.000 和 0.997。Obsidian 的 PDF 檢視器使用 `cMapUrl: "/lib/pdfjs/cmaps/"`（從 `obsidian.asar` 字串得知）。plugin 自己呼叫 `getDocument` 時，必須傳入同樣的設定。這個路徑在 Obsidian 內可用，已驗證（見第 4 節）。
- 數學符號：TeX 數學字型沒有 ToUnicode 時，pdf.js 把 `−`、`·`、`×` 輸出成控制字元（U+0000–U+001F），PDFKit 輸出正確符號。影響範圍：搜尋這些符號時找不到。存入 index 前應該移除控制字元。
- 掃描版 PDF（例如 855 頁的《深入理解 Linux 內核》）兩者都抽不出文字，符合現有行為。
- 連字（`ﬀ`）與阿拉伯文，pdf.js 較好（見 4.1）。

結論：pdf.js 可以取代 PDFKit。實作條件：
1. 傳入 `cMapUrl`、`cMapPacked: true`。
2. 存入 index 前移除控制字元，`\t` 改成空白。`NFKC` 不在存入時做：搜尋時 `normalizeText()`（`src/utils.ts`）會對 index 文字做 `normalize('NFKC')`。
3. 記憶體用量算在 Obsidian 身上。最大 PDF 約 0.9 GB（Node 測得，Obsidian 內未驗證）。

## 5. 第 2 步：同步與儲存位置

狀態：方向已決定（2026-11-17），未實作。取代先前「共享資料夾做成設定」的方案。

### 5.1 Obsidian Sync 在 `.obsidian` 內同步什麼（使用者實測，2026-11-17）

| 位置 | 是否同步 |
|---|---|
| `.obsidian/xxx.json`（設定資料夾第一層的檔案） | 會 |
| `.obsidian/ocr-index/xxx.json`（設定資料夾內自建的子資料夾） | 不會 |
| `.obsidian/plugins/<id>/ocr-index/…`（目前位置） | 不會，plugin 資料夾只同步 `main.js`、`manifest.json`、`styles.css`、`data.json` |

實測（2026-11-17，Windows 桌面版 → iPhone，Obsidian Sync，暫時性測試 plugin `ec-sync-probe`）：
- `.obsidian` 第一層的 `.json` 會同步到 iPhone，內容逐位元組相同（以雜湊比對）。
- iOS 上 `adapter.list(configDir)` 列得出這些檔案，`exists`、`read`、`stat` 都能用。
- 第一層的 `.txt` 不會同步。設計只用 `.json`。
- 5.08 MB 與 7.81 MB 的 `.json` 也同步了。測試帳號的方案不是 Standard，所以 5 MB 上限沒有實測到；設計仍以 Standard 的 5 MB 為準，每個檔案 4 MB 為上限（5.4）。
- Sync 保留 mtime，精確到毫秒：10 張圖片與設定資料夾的 `.json` 都相同。5.4 的選擇規則 2 在其他裝置上也能用。

不測，由設計處理：
- 控制第一層檔案的 Sync 選項：不處理。使用者自己的 Sync 設定不在 plugin 的範圍內。
- 衝突處理（Sync 怎麼合併同一個 JSON）：設計讓每個檔案只有一台裝置寫入，不會發生衝突（5.5）。另外，讀檔時檢查內容的 `device` 與檔名中的 id 相同、JSON 解析得出來，不符合就沿用上次讀到的內容（5.4）。
- 版本歷史是否計入配額：無法用程式測。基底加增量讓每次上傳在 200 KB 以內（5.4），影響很小。
- Android：未測。
- 官方說明頁沒有列出這些規則，Obsidian 改版時可能改變。

### 5.2 決策

1. **圖片與 PDF 分開處理。**
   - 圖片需要 OCR，手機做不到，所以由電腦讀，再同步給其他裝置。
   - PDF 用 pdf.js，在 Obsidian 內就能讀，包括手機（`readPdf()` 只用 `vault.readBinary` 與 `loadPdfJs`）。所以**每台裝置自己讀 PDF，PDF index 不同步**。
2. **共享圖片檔放在設定資料夾第一層**，每台裝置兩個（5.4）：基底 `${configDir}/enhanced-canvas-ocr.<deviceId>.json` 與增量 `enhanced-canvas-ocr.<deviceId>.new.json`。
   - 只有該裝置寫入，所以不會互相覆蓋，也不會碰到 Sync 對 JSON 的衝突處理。
   - 路徑用 `app.vault.configDir`，不寫死 `.obsidian`。
3. **本機 index 移出 vault**，存進 IndexedDB，以 `app.appId` 區分 vault。內容是這台裝置自己讀到的圖片與 PDF。
   - 原因：手機開始寫 PDF index 後，如果寫在 plugin 資料夾，iCloud、Syncthing、git 使用者的手機和電腦會寫同一批 shard，互相覆蓋（第 4 節的已知限制會擴大到手機）。
   - 不再需要 64-shard 和 `shardOf`。改為一個 path 一筆，存檔只寫有變動的 path。
   - git 使用者的 repo 不會再有約 100 MB 的 index。
4. **不採用的方案：**
   - 整個 index 拆成約 30 個 4 MB 的檔案放在 `.obsidian` 第一層：設定資料夾會塞滿檔案；佔用約 100 MB 的 Sync 空間，加上每次改動的版本歷史；最大的 PDF entry（32.8 MB）要按頁切開。
   - 共享資料夾做成設定：Obsidian Sync 使用者要自己設成 vault 內的資料夾，並開啟 `Sync all other types`，太麻煩。圖片 index 也會出現在檔案總管裡。

### 5.3 各裝置的資料流

| | 本機 index（IndexedDB） | 寫入的共享檔 | 讀取的共享檔 |
|---|---|---|---|
| macOS、Windows、Linux 桌面版 | 自己讀的圖片與 PDF | 自己的圖片 entry | 其他裝置的 |
| iPad、iPhone、Android | 自己讀的 PDF | 無 | 全部 |

搜尋時看到的 = 本機 index + 其他裝置共享檔中的圖片 entry，依 5.4 合併。

### 5.4 共享檔格式與合併規則

```json
{ "v": 1, "device": "<deviceId>", "name": "Robert's MacBook", "writtenAt": 1763337600000, "entries": { "<path>": { "m": 0, "l": [] } } }
```
- `entries` 只放圖片 entry，格式與 `OcrEntry` 相同。不放 `pw`（只有 PDF 會有）。
- `name`：給清理指令顯示用，也用來發現 `deviceId` 被複製（5.5）。取自 `os.hostname()`，取不到就用平台名稱。
- **基底加增量**。原因：Sync 以整檔為單位上傳並保留舊版本，每加一張圖就重寫 2 MB 的檔案，上傳量與版本歷史都太大。
  - 基底 `enhanced-canvas-ocr.<deviceId>.json`：格式如上，很少重寫。
  - 增量 `enhanced-canvas-ocr.<deviceId>.new.json`：格式相同，另有 `"removed": ["<path>"]`。內容是上次合併之後新增、修改的 entry，以及刪除（含改名前）的 path。
  - 讀取：先讀基底，刪掉 `removed` 中的 path，再蓋上增量的 `entries`。
  - 合併：增量超過 200 KB 時，先寫新的基底，再把增量寫成空的。順序不能反：讀的裝置如果拿到新基底加舊增量，套用後結果仍然正確；反過來會少掉 entry。
  - entry 的 `writtenAt` 用它所在檔案的 `writtenAt`。
- **大小上限**：每個檔案 4 MB，以 UTF-8 位元組計算（`new TextEncoder().encode(s).length`）。`s.length` 是 UTF-16 字元數，中文在 UTF-8 是 3 bytes，會低估到三分之一。
  - 基底超過 4 MB 時拆檔：`enhanced-canvas-ocr.<deviceId>.json`、`enhanced-canvas-ocr.<deviceId>.1.json`…。依 path 排序後切段，同一個 path 只會在一個檔案裡。目前圖片 index 約 2 MB，所以預期只會有一個檔。
  - 插入一個 path 會讓後面每一段的邊界移動，所有分段都要重寫。這只在合併時發生，可以接受。
- 同一個 path 有多筆時，依序選：
  1. 本機 index 的 entry，且 `m` 等於本機檔案 mtime。
  2. 共享檔中 `m` 等於本機檔案 mtime 的 entry；有多筆就選 `writtenAt` 最新的。
  3. 都不符合時，選 `writtenAt` 最新的那筆（Sync 不保留 mtime 時，至少還有結果）。
- 讀檔失敗（Sync 寫到一半、JSON 損毀），或內容的 `device` 與檔名中的 id 不同：保留上次讀到的內容，與現有 `load()` 的處理相同。
- 已知限制：在手機上改名或刪除圖片後，要等電腦收到這個變動並更新共享檔，手機的搜尋結果才會跟上。在那之前，改名的圖片搜不到，刪除的圖片仍會出現在結果裡。

### 5.5 `deviceId` 與清理

- `deviceId`：`randomId()`（`utils.ts`），用 `app.saveLocalStorage` 存，所以是「每個 vault、每台裝置」各一個。
- 清除 localStorage 或換電腦後會產生新 id，舊檔案會留著。
- **id 被複製**：macOS 系統移轉、磁碟複製、VM 複製會連 localStorage 一起帶走，兩台電腦就會寫同一個檔案，互相覆蓋。
  - 處理：啟動後第一次寫入前讀自己的基底檔，檔案裡的 `name` 與目前的 `os.hostname()` 不同就產生新 id，舊檔案留給另一台。
  - 限制：兩台電腦的 hostname 相同時發現不了。
- 不自動刪除其他裝置的檔案：自動刪除可能誤刪一台只是很久沒開的電腦的資料。
- 提供指令「Remove image text from other devices…」：列出每個共享檔的 `name`、`writtenAt`、entry 數，由使用者勾選刪除。自己的檔案不列出。
- plugin 被移除時，共享檔會留在 `.obsidian`。README 要寫明檔名，讓使用者可以手動刪除。

### 5.6 手機讀 PDF

- `canIndex` 拆成兩個：`canReadImages`（桌面版）與 `canReadPdfs`（所有平台）。手機也有「Rebuild」與「Unlock password-protected PDFs」指令。
- **大小上限**：`readBinary` 把整個檔案讀進記憶體，pdf.js 又會再用掉不少。電腦上 87 MB 的 PDF 約用 0.9 GB。
  - 手機上超過上限的 PDF 跳過不讀，記在 device-local 狀態（與 `failed` 同類）。
  - 搜尋視窗顯示「N 份 PDF 太大，這台裝置沒有讀」。
  - 上限的預設值要在實機上測出來。
- **掃描排程**：
  - 第一次掃描很長（電腦上 303 份約 110 秒，手機更慢），而且 app 切到背景會暫停。
  - 每批存檔，現有的 `PDF_BATCH` 已是如此，所以中斷後從下一份接著讀。
  - layout ready 後延遲幾秒再開始，不搶開啟 vault 的時間。
- **解鎖的 PDF**：本機 index 不同步，所以每台裝置都要各自解鎖一次。密碼仍然不保存。
- **Linux** 與目前相同：圖片用內建 OCR，PDF 用 pdf.js。

### 5.7 遷移

- 啟用時，如果 plugin 資料夾有舊的 `ocr-index/` shard（或更舊的 `ocr-index.json`）而 IndexedDB 是空的，就把 shard 匯入 IndexedDB。
  - 桌面版：全部匯入。
  - 手機：只匯入 PDF entry，而且 `m` 要等於本機檔案 mtime，省掉第一次重讀。圖片改從共享檔讀。
- 舊的 `ocr-index/` 這一版不刪：仍在用舊版的其他裝置還要讀它。下一個大版本再刪除，或提供指令。
- 匯入成功後，本機不再寫入 `ocr-index/`。

### 5.8 實作步驟

依序做，每一步都可以單獨發佈。

**步驟 A：共享圖片檔（手機可以搜尋圖片）**

0. ~~實測 5.1 的未確認事項~~：已完成（iPhone，2026-11-17）。Android 尚未測。
1. 新增 `deviceId`（localStorage key `enhanced-canvas-ocr-id`）。
2. 新增 `remote: Map<deviceId, { m: number; writtenAt: number; entries: OcrIndex }>`，與自己的 `index` 分開存。
   - 新增 `entryOf(path)`，依 5.4 選一筆。
   - 目前直接讀 `this.index` 的地方（`ImageTextSearch.ts` 約 20 處；`CanvasFind.ts` 經由 `textOf()`）中，屬於「搜尋與顯示」的都改用 `entryOf`。`lockedPdfs`、`scan` 的 `stale` 仍然只看自己的 index。
3. 讀取：`loadShared()` 用 `adapter.list(configDir)` 加上前綴過濾，略過自己的 id。對每個檔案 `stat`，mtime 沒變就跳過。
   - 啟用時呼叫一次，`refresh()` 時再呼叫（所有裝置都呼叫，不再限於 `!canIndex`）。
   - 每台裝置先讀基底，再套用增量（5.4）。
   - 手機上一個共享檔都沒讀到時，搜尋視窗顯示一行說明：圖片文字要由電腦讀取，並透過同步傳到這台裝置。
4. 寫入：`saveShared()` 只在桌面版執行，在 `scan()` 結束、或 rename/delete 之後執行，debounce 至少 30 秒。
   - 只輸出自己 index 中的圖片 entry。
   - 平常只寫增量檔；增量超過 200 KB 時合併進基底（5.4，先寫基底，再清空增量）。
   - 啟動後第一次：讀自己的基底與增量，檢查 `name`（5.5），並以讀到的內容作為「上次寫入的內容」。
   - 跳過寫入要同時符合兩個條件：序列化結果與上次寫入的相同，而且 `adapter.stat()` 顯示檔案存在、mtime 等於自己上次寫入後的值。只比對內容的話，檔案被其他裝置的清理指令刪掉後，這台裝置永遠不會再寫回來。
   - 寫入要排在 `saving` 佇列裡，與現有的 `save()` 規則一樣：寫入不能重疊。
5. 4 MB（UTF-8 位元組）拆檔，以及檔案數變少時刪除多出的 `.1.json`…。
6. 清理指令（5.5）。
7. 文字：設定說明（`main.ts` 約第 1613 行，以及 `ImageTextSearch.ts` 約第 1396 行的警告）、README（檔名）、`releaseNotesData.ts`（how-to：手機怎麼搜尋圖片文字）。
8. 這一步仍然保留 `ocr-index/` 的讀寫。git、iCloud 使用者的手機在步驟 B 之前都不受影響。

**步驟 B：本機 index 移到 IndexedDB**
1. DB 名稱 `enhanced-canvas-ocr-<appId>`，object store `entries`，key = path，value = `OcrEntry`。
2. `load()` 改成一次讀出全部。`save()` 改成寫入 dirty 的 path（dirty 從 shard 編號改成 path）。刪除 `SHARDS`、`shardOf`、`loadedAt`、`migrateLegacy`。
3. 遷移（5.7）。
4. IndexedDB 開不了（隱私模式、配額）時：退回只存在記憶體並在 console 警告。下次啟動重新讀取。
5. 關閉「Search text in images and PDFs」設定時刪除這個 DB。Obsidian 沒有 plugin 解除安裝的事件，不刪的話約 100 MB 會留在使用者看不到的地方。
6. 更新 README「Files outside the vault」一節，包含 DB 名稱與上一項的刪除方式。

**步驟 C：手機讀 PDF**
1. 先實機驗證，iOS 與 Android 都要。iPhone 部分結果（2026-11-17）：7 份 PDF（1–83 MB，最大一份 14,777 頁）全部讀完，app 沒有被關掉，頁數與字數和桌面版完全相同；83 MB 那份花 23 秒（桌面版 47 秒）。iOS 量不到 heap 用量。cMap 已驗證：掃描 299 份 40 MB 以下的 PDF 前 15 頁，需要 cMap 的有 2 份（`LeetCode 101 - A Grinding Guide.pdf`，以及第 4 節那份 826 頁的 `《野火-uCOS-III内核实现与应用开发实战指南——基于STM32》.pdf`）；iPhone 與桌面版加 cMap 後的中文字數完全相同（5,059 與 3,274，不加時是 0 與 56）。Android 尚未驗證。

   - `loadPdfJs()` 可用，`cMapUrl: '/lib/pdfjs/cmaps/'` 讀得到 cMap（用第 4 節那份 826 頁的中文 PDF 比對字數）。
   - 不同大小的 PDF 讀取時間與是否被系統關掉，用來決定大小上限。
   - `load()` 把整個本機 index（約 100 MB 的 PDF 文字）讀進記憶體後，app 是否被系統關掉。會的話，手機要改成搜尋時才從 IndexedDB 讀文字。
2. 拆分 `canIndex`（5.6），讓手機在 `enable()` 註冊指令與 vault 事件，但只處理 PDF。
3. 大小上限與「太大未讀」的顯示。
4. 掃描排程（延遲開始、每批存檔）。
5. 文字：設定說明、README 的平台表、release notes。

### 5.9 驗證清單（Obsidian 內）

- 步驟 A：
  - Mac 讀圖後，手機（Obsidian Sync）能搜到圖片。
  - 手機一個共享檔都沒有時，搜尋視窗顯示說明。
  - 兩台電腦都在讀圖時，各自的檔案都保留，沒有互相覆蓋。
  - 刪除、改名圖片後，其他裝置的結果跟著更新。
  - 加一張圖只改寫增量檔；增量超過 200 KB 後合併進基底，其他裝置的結果不變。
  - 清理指令刪掉的檔案，其他裝置也會消失。被刪的那台裝置如果還在用，下次寫入時會把檔案寫回來。
  - 把 localStorage 的 `deviceId` 複製到另一台電腦，那台會換成新 id。
- 步驟 B：從舊版升級後不需要重讀；IndexedDB 被清除後會自動重建。
- 步驟 C：iOS、Android 都能搜到中文 PDF；大型 PDF 不會讓 app 被關掉；切到背景再回來可以接著掃描。

### 5.10 未決定事項

- 手機 PDF 大小上限的預設值，以及要不要做成設定（等步驟 C.1 的實測）。
- 舊 `ocr-index/` 什麼時候刪除、由誰刪除（自動或指令）。
- 使用不同設定資料夾的手機（例如 `.obsidian-mobile`）讀不到共享檔。目前只在 README 說明限制，不處理。

## 6. 實測數據（2026-11 使用者 vault）

| 項目 | 數值 |
|---|---|
| PDF | 303 個，98.3 MB |
| 圖片 | 1,170 張，2.0 MB |
| 最大單一 entry | 32.8 MB（14,777 頁的 PDF） |
| 64 個 shard 中最大的 shard | 34.1 MB |
