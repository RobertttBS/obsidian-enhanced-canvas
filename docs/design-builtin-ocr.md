# 設計紀錄：內建 OCR

狀態：已實作（`406917e`）。本文件記錄決定與理由；程式行為以程式碼與 `docs/agent/architecture.md` 為準。
原型與 WebGPU 實驗（2026-11-16，已驗收）的結論併入第 3 節，原型指南已刪除。

## 1. 目標

讓「Search text in images and PDFs」在系統 OCR 不能用的電腦上也能讀圖片，而且大多數使用者不需要做任何事。

| 使用者 | 之前 | 現在 |
|---|---|---|
| macOS | Vision | 不變，看不到任何新東西 |
| Windows（新安裝或從舊版更新） | Windows OCR | 預設內建 OCR：通知上按一次下載（2026-11-17 改，見決定 5） |
| Linux 桌面版 | 不能建索引 | 用內建 OCR 建索引（按一次下載） |
| 想用 Windows OCR 的人 | — | 設定裡把「OCR engine」切到 Windows OCR |

### 不在範圍內

- 手機（iOS、Android）：維持只搜尋同步過來的索引。曾試做手機讀圖，2026-11-19 放棄，見決定 8。
- macOS 上提供內建 OCR。
- 語言選單（PP-OCRv6 small 一個模型涵蓋 50 多種語言）。
- 手動匯入模型檔（下載被擋時的替代方案）。先做清楚的錯誤訊息，之後再評估。
- 多執行緒 WASM（Obsidian 內 `crossOriginIsolated=false`，做不到）。

## 2. 決定事項

### 決定 1：下載要先問（按一次）

模型約 31 MB，加上 onnxruntime 的 wasm 約 29 MB，共約 60 MB（決定 4）。Obsidian 安裝 plugin 時只會抓 `main.js`、`manifest.json`、`styles.css`，所以模型只能在執行時下載。

採用：需要內建 OCR 時顯示通知，使用者按一次「Download」（在設定裡切到 Built-in 本身就是明確的選擇，直接開始下載）。不採用「直接下載、通知只顯示進度」：計量網路或公司網路上未經同意下載 60 MB，審核與使用者觀感的風險較高。macOS 使用者零操作、零下載。

### 決定 2：資產放本專案的 GitHub release

- 使用者能安裝這個 plugin，就代表連得到 GitHub release。放 Hugging Face 等第三方則多一個可能被公司網路擋掉的網域。
- 檔案由我們控制，不會被第三方改動或下架。單檔上限 2 GB、不計流量。

專用 release，tag `ocr-assets-1`，不附在每個版本的 release 上：

- Obsidian 只看 tag 等於 `manifest.json` 版本號的 release，其他 tag 不影響安裝與更新。
- 模型與 wasm 不隨 plugin 版本變動，不必每次發版重傳 60 MB。
- 建立時取消勾選「Set as latest release」，避免 BRAT 之類的工具把它當成最新版。
- 換模型或換 onnxruntime 版本時開 `ocr-assets-2`，舊的保留，舊版 plugin 才不會壞。

**授權**：可以再散布，條件是附上授權與來源。

| 項目 | 授權 | 依據 |
|---|---|---|
| PaddleOCR 模型（上游） | Apache-2.0 | PaddleOCR repo 的 LICENSE |
| `snowfluke/ppu-paddle-ocr-models`（轉成 `.onnx` 的版本） | Apache-2.0 | Hugging Face 模型卡的 license 標記；說明寫模型來自 PaddleOCR |
| onnxruntime-web（wasm） | MIT | 套件的 `package.json` |
| ppu-paddle-ocr、onnxruntime-web 的 JS（打包進 `main.js`） | MIT | 套件的 `package.json` |

release 說明要列出四個檔的來源、版本與授權，並附 Apache-2.0 的授權文字；打包進 `main.js` 的部分見 `THIRD-PARTY-NOTICES.md`。模型卡沒有另外說明轉換者是否加了額外條件；該 repo 的 LICENSE 檔內容沒有逐字讀過。

### 決定 3：模型存在 IndexedDB

不在 vault 裡，不會被 git、iCloud、Syncthing 同步 60 MB。代價：使用者看不到檔案；清除 Obsidian 資料時會消失，需要重新下載（`ready()` 回 false 時走同一套下載提示）。不採用 plugin 資料夾的 `ocr-wasm/`：每個 vault 各下載一次，且會被檔案同步工具帶著走。

### 決定 4：wasm 跟模型一起從 release 下載（2026-11-17 改；原本打包進 `main.js`）

maintainer 決定：onnxruntime 的 `.wasm`（28.7 MB）放在 `ocr-assets-1`，和模型一起下載、驗 SHA-256、存 IndexedDB，不再內嵌。理由：內嵌讓所有使用者（含手機、macOS、永遠用不到內建 OCR 的人）每次更新都多下載約 9.5 MB，`main.js` 載入時多一個約 9.5 MB 的字串。

- `main.js` 內仍有 onnxruntime 的 JS 膠水碼（在 worker 原始碼裡）。膠水碼和 wasm 必須同版本：`esbuild.config.mjs` 在 build 時算 `node_modules` 裡 wasm 的 SHA-256，`src/OcrAssets.ts` 沒列這個值就讓 build 失敗。換 onnxruntime 版本＝開新的 `ocr-assets-N`。
- 下載的 wasm 只有雜湊符合 plugin 內寫死的值才會存下來、才會執行，所以執行的位元組仍由這一版 plugin 決定，不會被遠端換掉。
- 已經下載過三個模型檔的裝置：`ready()` 發現少一個檔，再顯示一次下載提示，只補抓 wasm（逐檔續傳）。1.0.38 不認得這個檔，不受影響。
- **已接受的風險**：下面的政策可以被解讀成不允許這樣做。README 已寫明下載內容、來源與雜湊檢查；若審核有意見，備案是改回內嵌（本決定的前一版，`git log` 可查）。

以下是原本的分析（保留作為風險依據）。Obsidian 開發者政策：

- **允許但要揭露**：「Network use. Clearly explain which remote services are used and why they're needed.」→ README 寫明。
- **不允許**：「Install or update themselves or their dependencies.」

onnxruntime 的 `.wasm` 是執行檔，執行時下載它可以被解讀為「安裝相依套件」；模型與字典是資料。原本因此把 wasm 以 gzip -9 加 base64 打包進 `main.js`（約 +9.5 MB），只下載三個資料檔。

### 決定 5：引擎選擇存在裝置上

`app.saveLocalStorage('enhanced-canvas-ocr-engine')`，不進 `data.json`：`data.json` 會跟著 vault 同步，但「公司電腦要用內建、家裡的 Mac 用 Vision」是每台裝置各自的事。macOS 一律系統、Linux 一律內建、Windows 依這個鍵；鍵是空的＝預設內建（2026-11-17 改）。新安裝、從只有 Windows OCR 的舊版更新、`removeBuiltin()` 之後都是內建，圖片等使用者按下載；只有使用者自己選 Windows OCR（設定，或 killed 通知的「Keep using」）才會啟動 PowerShell。原本的「還沒選」狀態、`offerChoice()` 二選一通知、舊版使用者一次性轉成 `'system'`（`engineMigrated`）都已移除。已經存了 `'system'` 的裝置不動：分不出是自己選的還是 1.0.38 轉換的。

用內建但資產還沒就緒時，圖片跳過（不記為失敗），PDF 照常，並顯示下載提示。**不退回系統 OCR**：使用者選內建可能正是為了避開 PowerShell。

### 決定 6：系統 OCR 的被擋狀態持久化

之前 `broken` 與 `blockedBy` 只在記憶體，每次重開 Obsidian 只要還有沒讀過的圖就會再啟動一次 PowerShell，在受 EDR 管控的電腦上等於每次都再觸發一次告警。現在寫進 `DEVICE_KEY`，只有 Rebuild 會清掉（`killed` 例外：它來自整台電腦的判定檔，Rebuild 後重新套用，見 `docs/design-ocr-consent-and-crash-guard.md` B）；改用內建 OCR 不清（它描述的是系統 OCR）。通知每次啟動最多一次。

### 決定 7：已讀過的圖不自動重讀

切換引擎後，舊引擎讀失敗的圖片會自動重試，沒讀過的圖本來就會讀；已讀過的不自動重讀（大型 vault 要好幾分鐘，而且索引會同步，整份重寫會牽動所有裝置）。改為一則帶「Read again with …」按鈕的通知，待重讀清單存在裝置端（`DEVICE_KEY` 的 `reread`），不改同步的索引。

### 決定 8：手機不做圖片 OCR（2026-11-19，維護者決定，試做後放棄）

試做過的版本（未 commit）：手機只讀沒有任何裝置共享文字的圖；下載時先問；啟動後自動在背景讀；只用 WASM、偵測上限 960 px、一批一張。另外寫了閃退保護：讀圖前寫一個 marker 檔，同一張圖連續閃退兩次就跳過。

放棄的原因：iPhone 15 Pro 實機上，在手機上貼的一張普通截圖讓 Obsidian 連續閃退兩次。那張圖是 `IMG_5483.png`（1179×2556、16-bit、Display P3、2.9 MB）。閃退保護照設計運作，第二次後跳過了那張圖。同格式的 `IMG_1842.png` 在 spike 中讀成功 3/3。iOS「分析資料」裡沒有 `JetsamEvent`，也沒有 crash 紀錄。

推測（未確認）：WebKit 對 WebContent 程序有自己的記憶體上限，超過時直接結束程序，不寫 jetsam 紀錄。OCR worker、畫面、Sync 共用這份額度。要確認，必須用 Mac Safari 的網頁檢閱器連上 iPhone。

若要重做，可以先試：
- 讀圖前先在 worker 裡把圖縮小。
- 只在 app 閒置時讀。

## 3. 已驗證的事實

### 原型階段（Chromium 與 Obsidian 內，2026-11-16）

- 套件版本：`ppu-paddle-ocr@6.7.1`、`onnxruntime-web@1.31.1`（固定版本，不加 `^`）。換版本前，以下事實都要重新驗證。
- Obsidian 桌面版可以用 Blob URL 啟動 **classic** Worker（不加 `type: 'module'`），載入 wasm 與模型，無 CSP 問題。
- 維護者的電腦（Windows 11、RTX 3080 加 Intel UHD 730）在 Obsidian 內：WASM 每張中位數約 7 秒，WebGPU 約 0.3 秒，三批 111 張全部 `ep=webgpu`。掃描時不卡，搜尋與框線正常。
- 瀏覽器內同一批 19 張圖：WASM（`.ort`）中位數 6.1 秒，WebGPU（`.onnx`）0.64 秒，文字完全相同，框線座標到小數第 3 位相同。WASM 的時間約八成在辨識（rec）。WebGPU 初始化約 1.5 秒（WASM 約 0.3 秒）。
- **只需要一套資產**：WebGPU 版的 onnxruntime 加 `.onnx` 模型，在沒有 GPU 時指定 `['wasm']` 也能跑，文字相同，只慢約 10%（中位數 6.9 秒對 6.1 秒）。

### 陷阱（每一個都會靜默變差，不會報錯）

1. **清掉 `wasmPaths`。** `ppu-paddle-ocr/web` 在 import 時把 `ort.env.wasm.wasmPaths` 設成 jsDelivr。有值時 onnxruntime 每次初始化都從那裡動態 import 膠水碼。`initialize()` 前設成 `undefined`，才會用打包進來的膠水碼加上 `wasmBinary`。
2. **用 `strategy: 'per-box'`。** 預設的 `per-line` 遇到直排邊欄文字會產生涵蓋半張圖的大框，整片文字因信心值過低被丟掉（實測一張圖從 830 字掉到 300 字）。`per-box` 沒有變慢。
3. **WebGPU 只能用 `.onnx`。** `.ort` 模型在 WebGPU 上建不起 session（`Failed to find op_id: com.ms.internal.nhwc:Conv:1`），函式庫靜默退回 WASM。
4. **session 一次建一個。** 函式庫同時建偵測與辨識兩個 session，WebGPU 拒絕第二個（`another WebGPU EP inference session is being created`），那一個靜默退回 WASM。Worker 內把 `InferenceSession.create` 序列化。
5. Windows 上 `requestAdapter()` 的 `powerPreference` 被忽略，無法指定用哪一張顯示卡。

### 手機實測（iPhone 15 Pro、iOS 18.7、Obsidian 1.15.1，2026-11-18）

以暫時的 spike 指令在真機上跑 11 輪，報告寫在 vault 根目錄再由 Sync 帶回。之後的試做與放棄見決定 8。

- Obsidian iOS 的 WKWebView 能跑這套：Blob URL classic Worker、IndexedDB 存 60 MB 資產（下載 6.6 秒）、`navigator.gpu` 存在且 `ep=webgpu` 可用。`hardwareConcurrency=4`、`crossOriginIsolated=false`。
- 辨識品質與 Mac Vision 相當（中文、英文、數字）。
- **預設設定會讓 Obsidian 閃退**（iOS 終止整個 app，報告停在某張圖的 `start`）。條件：同一次啟動中先讀過任何一張圖，再讀大圖（`Untitled 2 4.png`，2166×924）。WASM 預設 8/10 次閃退；大圖排第一張 4/4 成功。WebGPU、縮到 1280 px、每張圖換新 worker、等啟動工作結束、lean 選項（無 arena、`recBatchSize: 1`、偵測 960 px）都閃退過。
- onnxruntime 的 wasm 記憶體是 shared（`{"initial":256,"maximum":65536,"shared":true}`）。預設設定讀大圖時 heap 長到 372 MB。每次長大前暫停不能避免閃退；建立時直接給 400 MB 會讓 onnxruntime 初始化失敗（`no available backend found`）。閃退的真正原因未確認：iOS 的 JS 讀不到整個 app 的記憶體用量。
- **只把偵測上限改成 960 px（`detection.maxSideLength: 960`，其餘預設）、WASM：3/3 次讀完 11 張圖**（B 加上 vault 中最大的 10 張，3.3–12 MB 的 GIF、JPG、PNG），heap 最高 330 MB，每張 1.2–16 秒。同一設定的 WebGPU 在第 2 張（12 MB GIF）閃退。
- 960 px 的代價：多數圖字數為電腦的 90% 以上，小字多的圖會少讀（一張 38%、一張 65%）。
- `ppu-paddle-ocr` 有記憶體內結果快取（`core/image-cache.js`，10 筆，以取樣位元組為鍵）：同一張圖第二次辨識約 18 ms，不會真的跑模型。

### 尚未驗證

- 只有內顯的筆電上 WebGPU 的速度。這是公司電腦最常見的配置。
- Linux 上的行為（WebGPU 在 Linux 的 Electron 可能預設不可用，預期會退回 WASM）。
- Obsidian 關閉「硬體加速」時是否正確退回 WASM。
- 同一台電腦的不同 vault 是否共用同一個 IndexedDB 資料庫（資料庫名稱不含 vault id，預期共用）。

## 4. 資產

| 檔名 | 大小 | SHA-256 |
|---|---|---|
| `det.onnx` | 9,880,512 | `d73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e` |
| `rec.onnx` | 21,159,378 | `5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634` |
| `dict.txt` | 74,948 | `41557512862dfe31970cf22407742b629725461dd84c0d8771bde9c87c2202c8` |
| `ort-wasm-simd-threaded.asyncify.wasm` | 28,747,738 | `ca319e9539cd0f1e291cf56074760121eaf39650f5dbf84b6e52c07f4b2944ec` |

前三個的來源：`https://huggingface.co/snowfluke/ppu-paddle-ocr-models`（`detection/PP-OCRv6_small_det.onnx`、`recognition/PP-OCRv6_small_rec.onnx`、`recognition/ppocrv6_dict.txt`）。wasm 來自 `node_modules/onnxruntime-web/dist/`（`onnxruntime-web@1.31.1`，未修改）。`scripts/fetch-ocr-assets.mjs` 抓下（wasm 是從 `node_modules` 複製）並驗雜湊，維護者手動把四個檔上傳到 `ocr-assets-1`。tag 與雜湊是 `src/OcrAssets.ts` 的常數，不做成設定。

## 5. 風險與備案

| 風險 | 影響 | 備案 |
|---|---|---|
| 審核認定下載 wasm 是「安裝相依套件」 | 上架或更新被擋 | 改回內嵌在 `main.js`（決定 4 的前一版） |
| 內顯上 WebGPU 很慢或不穩 | 公司筆電上體驗差 | 已有 WASM 退路（GPU 連續失敗兩次後本次執行改用 WASM）；必要時加裝置層級的「不使用 GPU」選項 |
| 公司網路擋 GitHub release 的轉址網域 | 下載失敗 | 清楚的錯誤訊息與 Retry；之後做手動匯入 |
| IndexedDB 被清除 | 需要重新下載 | `ready()` 回 false 時走同一套下載提示 |
