# 設計決策：圖片與 PDF 文字 index 改為每台裝置自己建立

狀態：第 1 步已實作（PDF 改用 pdf.js：`1e62a31`；Windows 圖片 OCR：`5bfd901`、`bcd935b`、`9a628a1`。Windows OCR 2026-11-15 在 Windows 11 以腳本驗證，尚未在 Obsidian 內完整驗證）。第 2 步未決定。基準 commit：`bbe6964`（64-shard，只考慮單台 Mac 寫入）。
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
| Linux | 不支援 | pdf.js（第 1 步之後） |
| iPad、iPhone、Android | 不支援（無法執行外部程式；tesseract.js 需要下載語言資料，不採用） | pdf.js（第 1 步之後） |

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

## 5. 第 2 步：同步與儲存位置（未決定）

討論過的方向，未定案：
- 完整 index 存在本機，同步工具碰不到，例如 IndexedDB，以 `app.appId` 區分 vault。這樣就不需要 64-shard：PDF 不進 git，只剩圖片 index（約 2 MB）。
- 能讀圖片的裝置把圖片 entry 輸出成 `<deviceId>.json`，放在共享資料夾，給 mobile 讀。每個檔案只有一台裝置寫入。同一個 path 出現多次時，保留 mtime 最新的一筆。
- 共享資料夾做成設定。Obsidian Sync 使用者必須設為 vault 內的一般資料夾，並開啟 `Sync all other types`。

未決定事項：
- 共享資料夾設定的預設值。
- `deviceId` 存在 localStorage。換裝置或清除資料後會產生新的 id，舊的 `<deviceId>.json` 會留在資料夾。是否清理、怎麼清理。

## 6. 實測數據（2026-11 使用者 vault）

| 項目 | 數值 |
|---|---|
| PDF | 303 個，98.3 MB |
| 圖片 | 1,170 張，2.0 MB |
| 最大單一 entry | 32.8 MB（14,777 頁的 PDF） |
| 64 個 shard 中最大的 shard | 34.1 MB |
