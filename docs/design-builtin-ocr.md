# 設計紀錄：內建 OCR

狀態：已實作（`406917e`）。本文件記錄決定與理由；程式行為以程式碼與 `docs/agent/architecture.md` 為準。
原型與 WebGPU 實驗（2026-11-16，已驗收）的結論併入第 3 節，原型指南已刪除。

## 1. 目標

讓「Search text in images and PDFs」在系統 OCR 不能用的電腦上也能讀圖片，而且大多數使用者不需要做任何事。

| 使用者 | 之前 | 現在 |
|---|---|---|
| macOS | Vision | 不變，看不到任何新東西 |
| Windows，系統 OCR 正常 | Windows OCR | 不變，看不到任何新東西 |
| Windows，系統 OCR 被擋（EDR、AppLocker、沒有語言包） | 圖片讀取暫停 | 通知上按一次改用內建 OCR |
| Linux 桌面版 | 不能建索引 | 用內建 OCR 建索引（按一次下載） |
| 想手動選用的人（Windows） | 無 | 設定裡把「OCR engine」切到內建 |

### 不在範圍內

- 手機（iOS、Android）：維持只搜尋同步過來的索引。
- macOS 上提供內建 OCR。
- 語言選單（PP-OCRv6 small 一個模型涵蓋 50 多種語言）。
- 手動匯入模型檔（下載被擋時的替代方案）。先做清楚的錯誤訊息，之後再評估。
- 多執行緒 WASM（Obsidian 內 `crossOriginIsolated=false`，做不到）。

## 2. 決定事項

### 決定 1：下載要先問（按一次）

模型約 31 MB。Obsidian 安裝 plugin 時只會抓 `main.js`、`manifest.json`、`styles.css`，所以模型只能在執行時下載。

採用：需要內建 OCR 時顯示通知，使用者按一次「Download」（在設定裡切到 Built-in 本身就是明確的選擇，直接開始下載）。不採用「直接下載、通知只顯示進度」：計量網路或公司網路上未經同意下載 31 MB，審核與使用者觀感的風險較高。系統 OCR 正常的 Windows 與 macOS 使用者零操作、零下載。

### 決定 2：資產放本專案的 GitHub release

- 使用者能安裝這個 plugin，就代表連得到 GitHub release。放 Hugging Face 等第三方則多一個可能被公司網路擋掉的網域。
- 檔案由我們控制，不會被第三方改動或下架。單檔上限 2 GB、不計流量。

專用 release，tag `ocr-assets-1`，不附在每個版本的 release 上：

- Obsidian 只看 tag 等於 `manifest.json` 版本號的 release，其他 tag 不影響安裝與更新。
- 模型不隨 plugin 版本變動，不必每次發版重傳 31 MB。
- 建立時取消勾選「Set as latest release」，避免 BRAT 之類的工具把它當成最新版。
- 換模型或換 onnxruntime 版本時開 `ocr-assets-2`，舊的保留，舊版 plugin 才不會壞。

**授權**：可以再散布，條件是附上授權與來源。

| 項目 | 授權 | 依據 |
|---|---|---|
| PaddleOCR 模型（上游） | Apache-2.0 | PaddleOCR repo 的 LICENSE |
| `snowfluke/ppu-paddle-ocr-models`（轉成 `.onnx` 的版本） | Apache-2.0 | Hugging Face 模型卡的 license 標記；說明寫模型來自 PaddleOCR |
| onnxruntime-web（wasm） | MIT | 套件的 `package.json` |
| ppu-paddle-ocr（打包進 `main.js`） | MIT | 套件的 `package.json` |

release 說明要列出三個檔的來源、版本與授權，並附 Apache-2.0 的授權文字；打包進 `main.js` 的部分見 `THIRD-PARTY-NOTICES.md`。模型卡沒有另外說明轉換者是否加了額外條件；該 repo 的 LICENSE 檔內容沒有逐字讀過。

### 決定 3：模型存在 IndexedDB

不在 vault 裡，不會被 git、iCloud、Syncthing 同步 31 MB。代價：使用者看不到檔案；清除 Obsidian 資料時會消失，需要重新下載（`ready()` 回 false 時走同一套下載提示）。不採用 plugin 資料夾的 `ocr-wasm/`：每個 vault 各下載一次，且會被檔案同步工具帶著走。

### 決定 4：wasm 打包進 `main.js`，只下載資料

Obsidian 開發者政策：

- **允許但要揭露**：「Network use. Clearly explain which remote services are used and why they're needed.」→ README 寫明。
- **不允許**：「Install or update themselves or their dependencies.」

onnxruntime 的 `.wasm` 是執行檔，執行時下載它可以被解讀為「安裝相依套件」；模型與字典是資料。所以 wasm 以 gzip -9 加 base64 打包進 `main.js`（約 +9.5 MB），只下載三個資料檔（約 31 MB）。代價是所有使用者（含手機、含永遠用不到內建 OCR 的人）每次更新都多下載約 9.5 MB，`main.js` 載入時也多一個約 9.5 MB 的字串。附帶好處：wasm 與打包進去的 onnxruntime 永遠同版本。若這個代價不可接受，備案是問 Obsidian 團隊能否下載 wasm。

### 決定 5：引擎選擇存在裝置上

`app.saveLocalStorage('enhanced-canvas-ocr-engine')`，不進 `data.json`：`data.json` 會跟著 vault 同步，但「公司電腦要用內建、家裡的 Mac 用 Vision」是每台裝置各自的事。macOS 一律系統、Linux 一律內建、Windows 依這個鍵。

用內建但資產還沒就緒時，圖片跳過（不記為失敗），PDF 照常，並顯示下載提示。**不退回系統 OCR**：使用者選內建可能正是為了避開 PowerShell。

### 決定 6：系統 OCR 的被擋狀態持久化

之前 `broken` 與 `blockedBy` 只在記憶體，每次重開 Obsidian 只要還有沒讀過的圖就會再啟動一次 PowerShell，在受 EDR 管控的電腦上等於每次都再觸發一次告警。現在寫進 `DEVICE_KEY`，只有 Rebuild 會清掉；改用內建 OCR 不清（它描述的是系統 OCR）。通知每次啟動最多一次。

### 決定 7：已讀過的圖不自動重讀

切換引擎後，舊引擎讀失敗的圖片會自動重試，沒讀過的圖本來就會讀；已讀過的不自動重讀（大型 vault 要好幾分鐘，而且索引會同步，整份重寫會牽動所有裝置）。改為一則帶「Read again with …」按鈕的通知，待重讀清單存在裝置端（`DEVICE_KEY` 的 `reread`），不改同步的索引。

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

### 尚未驗證

- 只有內顯的筆電上 WebGPU 的速度。這是公司電腦最常見的配置。
- Linux 上的行為（WebGPU 在 Linux 的 Electron 可能預設不可用，預期會退回 WASM）。
- Obsidian 關閉「硬體加速」時是否正確退回 WASM。
- 同一台電腦的不同 vault 是否共用同一個 IndexedDB 資料庫（資料庫名稱不含 vault id，預期共用）。
- 手機載入約 10 MB 的 `main.js` 對啟動時間的影響。

## 4. 資產

| 檔名 | 大小 | SHA-256 |
|---|---|---|
| `det.onnx` | 9,880,512 | `d73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e` |
| `rec.onnx` | 21,159,378 | `5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634` |
| `dict.txt` | 74,948 | `41557512862dfe31970cf22407742b629725461dd84c0d8771bde9c87c2202c8` |

來源：`https://huggingface.co/snowfluke/ppu-paddle-ocr-models`（`detection/PP-OCRv6_small_det.onnx`、`recognition/PP-OCRv6_small_rec.onnx`、`recognition/ppocrv6_dict.txt`）。`scripts/fetch-ocr-assets.mjs` 抓下並驗雜湊，維護者手動上傳到 `ocr-assets-1`。tag 與雜湊是 `src/OcrAssets.ts` 的常數，不做成設定。

onnxruntime 的 wasm（`ort-wasm-simd-threaded.asyncify.wasm`，28,747,738 位元組，SHA-256 `ca319e9539cd0f1e291cf56074760121eaf39650f5dbf84b6e52c07f4b2944ec`）不下載，build 時驗雜湊後打包在 `main.js` 內（`esbuild.config.mjs` 的 `ocr-wasm-source`）。

## 5. 風險與備案

| 風險 | 影響 | 備案 |
|---|---|---|
| `main.js` 約 10 MB 讓手機啟動變慢或更新變慢 | 所有使用者受影響 | 量過再決定；若不可接受，問 Obsidian 團隊能否改為下載 wasm |
| 內顯上 WebGPU 很慢或不穩 | 公司筆電上體驗差 | 已有 WASM 退路（GPU 連續失敗兩次後本次執行改用 WASM）；必要時加裝置層級的「不使用 GPU」選項 |
| 公司網路擋 GitHub release 的轉址網域 | 下載失敗 | 清楚的錯誤訊息與 Retry；之後做手動匯入 |
| IndexedDB 被清除 | 需要重新下載 | `ready()` 回 false 時走同一套下載提示 |
