# Spec：內建 OCR 正式版

狀態：草稿。決定 1（按一次）與 2.4（wasm 打包進 `main.js`）已確認；決定 2、3 維護者未表示意見，暫依本文件預設。
前置文件：`docs/prototype-wasm-ocr.md`（原型與 WebGPU 實驗，已驗收）。本文件取代該文件第 10 節。

## 1. 目標

讓「Search text in images and PDFs」在系統 OCR 不能用的電腦上也能讀圖片，而且大多數使用者不需要做任何事。

| 使用者 | 現在 | 正式版 |
|---|---|---|
| macOS | Vision | 不變，看不到任何新東西 |
| Windows，系統 OCR 正常 | Windows OCR | 不變，看不到任何新東西 |
| Windows，系統 OCR 被擋（EDR、AppLocker、沒有語言包） | 圖片讀取暫停 | 改用內建 OCR（見決定 1） |
| Linux 桌面版 | 不能建索引 | 用內建 OCR 建索引（見決定 1） |
| 想手動選用的人（Windows） | 無 | 設定裡把「OCR engine」切到內建 |

### 不在範圍內

- 手機（iOS、Android）：維持只搜尋同步過來的索引。
- macOS 上提供內建 OCR。
- 語言選單（PP-OCRv6 small 一個模型涵蓋 50 多種語言）。
- 手動匯入模型檔（下載被擋時的替代方案）。先做清楚的錯誤訊息，之後再評估。
- 多執行緒 WASM（Obsidian 內 `crossOriginIsolated=false`，做不到）。

## 2. 決定事項

### 決定 1：下載要不要先問（已確認：A，按一次）

內建 OCR 需要下載約 31 MB。Obsidian 安裝 plugin 時只會抓 `main.js`、`manifest.json`、`styles.css`，所以模型不可能隨安裝一起到位，只能在執行時下載。

| 選項 | 行為 | 優點 | 缺點 |
|---|---|---|---|
| A（本文件預設） | 需要內建 OCR 時顯示通知，使用者按一次「Download」 | 不會在使用者不知情時連網抓 31 MB；符合 README 現在「nothing is downloaded」的承諾精神 | 被擋的人和 Linux 使用者要按一次 |
| B | 需要時直接開始下載，通知只顯示進度，設定裡可關閉 | 真正零操作 | 計量網路或公司網路上未經同意下載 31 MB；審核與使用者觀感的風險較高 |

兩個選項下，系統 OCR 正常的 Windows 與 macOS 使用者都是零操作、零下載。差別只在需要內建 OCR 的少數人要不要按一次。

實作上兩者只差「通知上有沒有按鈕」，本文件以 A 撰寫，B 的差異在 6.2 標明。


### 決定 2：資產放哪裡

建議放在本專案的 GitHub release，理由：

- 使用者能安裝這個 plugin，就代表這台電腦連得到 GitHub release。放 Hugging Face 等第三方則多一個可能被公司網路擋掉的網域。
- 檔案由我們控制，不會被第三方改動或下架。
- 單檔上限 2 GB、不計流量，31 MB 沒有問題。

做法：開一個專用的 release，tag 為 `ocr-assets-1`，不要附在每個版本的 release 上。

- Obsidian 只看 tag 等於 `manifest.json` 版本號的 release，其他 tag 不影響安裝與更新。
- 模型不隨 plugin 版本變動，不必每次發版重傳 31 MB。
- 建立時取消勾選「Set as latest release」，避免 BRAT 之類的工具把它當成最新版。
- 換模型或換 onnxruntime 版本時開 `ocr-assets-2`，舊的保留，舊版 plugin 才不會壞。

**授權（已查）**：可以再散布，條件是附上授權與來源。

| 項目 | 授權 | 依據 |
|---|---|---|
| PaddleOCR 模型（上游） | Apache-2.0 | PaddleOCR repo 的 LICENSE |
| `snowfluke/ppu-paddle-ocr-models`（轉成 `.onnx` 的版本） | Apache-2.0 | Hugging Face 模型卡的 license 標記；說明寫模型來自 PaddleOCR |
| onnxruntime-web（wasm） | MIT | 套件的 `package.json` |
| ppu-paddle-ocr（打包進 `main.js`） | MIT | 套件的 `package.json` |

Apache-2.0 要求隨檔附上授權全文與原有的著作權聲明。release 說明要列出三個檔的來源、版本與授權，並附 Apache-2.0 的授權文字；打包進 `main.js` 的 onnxruntime 與 ppu-paddle-ocr（MIT）在 README 註明。模型卡沒有另外說明轉換者是否加了額外條件；該 repo 的 LICENSE 檔內容沒有逐字讀過。

### 決定 3：模型存在使用者電腦的哪裡

| 選項 | 優點 | 缺點 |
|---|---|---|
| IndexedDB（本文件預設） | 不在 vault 裡，不會被 git、iCloud、Syncthing 同步 31 MB；同一台電腦的所有 vault 共用一份（待實作者確認，見 5.3） | 使用者看不到檔案；清除 Obsidian 資料時會消失，需要重新下載 |
| plugin 資料夾的 `ocr-wasm/` | 看得到、可手動放檔 | 每個 vault 各下載一次；會被檔案同步工具帶著走 |

### 2.4 Obsidian 開發者政策（已確認：乙，wasm 打包進 `main.js`）

政策頁（Community directory → Developer policies）與這個功能有關的兩條：

- **允許但要揭露**：「Network use. Clearly explain which remote services are used and why they're needed.」→ README 寫明即可，見第 7 節。
- **不允許**：「Install or update themselves or their dependencies.」

第二條是風險所在。四個下載檔裡，模型與字典是資料；但 `ort-wasm-simd-threaded.asyncify.wasm` 是 onnxruntime 的執行檔，可以被解讀為「在執行時安裝相依套件」。政策沒有定義 dependency 的範圍，也沒有提到 wasm 或模型，所以無法從文字判定。目錄裡有其他 plugin 在執行時下載 runtime 或模型，但我沒有逐一查證它們的做法，也不代表新的自動審查會放行。

三條路：

| 做法 | 下載內容 | `main.js` | 政策風險 |
|---|---|---|---|
| 甲：四個檔都下載 | 約 60 MB | 約 +0.2 MB | wasm 那一條有疑慮 |
| 乙（採用）：wasm 以 gzip 加 base64 打包進 `main.js`，只下載模型與字典 | 約 31 MB | 約 +9.5 MB（gzip 後 7.1 MB，base64 再多三分之一） | 低：下載的只有資料 |
| 丙：先問 Obsidian 團隊再決定 | | | |

維護者選擇乙。代價是所有使用者（含手機、含永遠用不到內建 OCR 的人）每次更新都多下載約 9.5 MB，`main.js` 載入時也多一個約 9.5 MB 的字串。好處除了政策風險低之外：wasm 與打包進去的 onnxruntime 永遠同版本，不會有對不上的問題；需要下載的量也少一半。

「約 9.5 MB」是用 `gzip -9` 量 wasm 得到 7,103,195 位元組再換算 base64 的估計，實際的 `main.js` 大小由實作者回報。手機載入這麼大的 `main.js` 對啟動時間的影響沒有量過，見第 8 節驗收 17。

## 3. 已驗證的事實

以下都在原型階段量過，實作者不需要重新驗證。

- Obsidian 桌面版可以用 Blob URL 啟動 classic Worker，載入 wasm 與模型，無 CSP 問題。
- 維護者的電腦（Windows 11、RTX 3080 加 Intel UHD 730）在 Obsidian 內：WASM 每張中位數約 7 秒，WebGPU 約 0.3 秒，三批 111 張全部 `ep=webgpu`。掃描時不卡，搜尋與框線正常。
- 同一批 19 張圖，WASM 與 WebGPU 辨識出的文字完全相同。
- **只需要一套資產**：WebGPU 版的 onnxruntime 加 `.onnx` 模型，在沒有 GPU 時指定 `['wasm']` 也能跑，文字相同，速度比原型的純 WASM 版慢約 10%（中位數 6.9 秒對 6.1 秒）。所以正式版不需要 `.ort` 模型和第二份 Worker。
- 三個陷阱（原型文件第 11 節）：`.ort` 模型在 WebGPU 上會靜默退回 WASM；兩個 session 要一次建一個；Windows 上無法指定顯示卡。

### 尚未驗證

- 只有內顯的筆電上 WebGPU 的速度。這是公司電腦最常見的配置。
- Linux 上的行為（WebGPU 在 Linux 的 Electron 可能預設不可用，預期會退回 WASM）。
- `requestUrl` 下載 GitHub release 資產（會經過一次 302 轉址）。
- Obsidian 關閉「硬體加速」時是否正確退回 WASM。

## 4. 資產

| 檔名 | 大小 | SHA-256 |
|---|---|---|
| `det.onnx` | 9,880,512 | `d73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e` |
| `rec.onnx` | 21,159,378 | `5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634` |
| `dict.txt` | 74,948 | `41557512862dfe31970cf22407742b629725461dd84c0d8771bde9c87c2202c8` |

合計約 31.1 MB，需要下載的就是這三個檔。

onnxruntime 的 wasm（`ort-wasm-simd-threaded.asyncify.wasm`，28,747,738 位元組，SHA-256 `ca319e9539cd0f1e291cf56074760121eaf39650f5dbf84b6e52c07f4b2944ec`）不下載，打包在 `main.js` 內，見 5.5。

下載網址：`https://github.com/<owner>/<repo>/releases/download/ocr-assets-1/<檔名>`。tag 與雜湊寫成 `src/` 內的常數，不做成設定。

`scripts/fetch-ocr-assets.mjs` 改為「準備上傳用的資料夾」：只產出上表三個檔並驗雜湊。上傳 release 由維護者手動做，實作者不要上傳。

## 5. 架構

### 5.1 檔案變動

| 檔案 | 變動 |
|---|---|
| `src/WasmOcr.ts` → `src/BuiltinOcr.ts` | 改名（它現在主要跑 WebGPU）。移除兩個 localStorage 開關與 `toggle*()`。資產改由 `OcrAssets` 提供 |
| `src/OcrAssets.ts`（新增） | 資產的下載、驗證、儲存、讀取 |
| `src/ocr-worker.js` | 保留。`init` 訊息的 `gpu` 改為「要不要嘗試 WebGPU」 |
| `src/ocr-worker-source.d.ts`、`esbuild.config.mjs` | 只留一個 Worker 虛擬模組 `ocr-worker-source`，alias 固定為 `onnxruntime-web/webgpu`；新增虛擬模組 `ocr-wasm-source`（見 5.5） |
| `src/ImageTextSearch.ts` | 引擎選擇、被擋狀態持久化、通知、移除兩個 Dev 指令 |
| `main.ts` | 設定畫面加「OCR engine」，更新功能說明文字 |
| `README.md` | 連網下載的說明、Linux 支援、授權 |
| `docs/agent/architecture.md` | 同步更新；移除「Prototype」與「WebGPU experiment」的敘述 |

`CLAUDE.md` 的既有規則全部適用：`child_process` 只能在 `ocrImagesNative()` 內 `require`；`BuiltinOcr.ts` 與 `OcrAssets.ts` 不得使用 Node 模組（手機也會載入）；對 `ImageTextSearch.ts` 只能 `import type`。

### 5.2 引擎選擇

狀態存在這台裝置（`app.saveLocalStorage`），不進 `data.json`。原因：`data.json` 會跟著 vault 同步，但「公司電腦要用內建、家裡的 Mac 用 Vision」是每台裝置各自的事。

新的裝置鍵 `enhanced-canvas-ocr-engine`，值為 `'system'`、`'builtin'` 或未設定。

每一批圖片要用哪個引擎，依序判斷：

1. macOS → 系統。
2. Linux → 內建。
3. Windows：鍵值為 `'builtin'` → 內建；否則 → 系統。

用內建但資產還沒就緒時：這一批圖片跳過（與現在 `broken` 時相同，回傳 `undefined`，不記為失敗），並觸發 6.2 的下載提示。**不要**退回系統 OCR：使用者選內建可能正是為了避開 PowerShell。

`ImageTextSearch.canIndex` 改為「桌面版」（含 Linux）。

### 5.3 `OcrAssets`

```ts
class OcrAssets {
    ready(): Promise<boolean>;                       // 三個檔都在且雜湊已驗過
    load(): Promise<ArrayBuffer[] | null>;           // 依 det、rec、dict 順序；缺檔回 null
    download(onProgress: (done: number, total: number) => void): Promise<'ok' | 'network' | 'hash' | 'storage'>;
    clear(): Promise<void>;
}
```

- **儲存**：IndexedDB，資料庫名稱 `enhanced-canvas-ocr-assets`（不含 vault id），一個 object store，key 為 `<tag>/<檔名>`，value 為 `ArrayBuffer`。實作者要確認同一台電腦的不同 vault 是否讀得到同一個資料庫，並回報結果。
- **下載**：用 Obsidian 的 `requestUrl`（`fetch` 會被 CORS 擋）。一次一個檔，`onProgress` 以位元組回報（每完成一個檔更新一次即可，`requestUrl` 沒有串流進度）。
- **驗證**：用 `crypto.subtle.digest('SHA-256', ...)`。雜湊不符的檔不得寫入，回傳 `'hash'`。
- **續傳**：以檔為單位。已存在且驗過的檔不重抓。
- **雜湊只在寫入時驗一次**，讀取時不重驗（31 MB 每次啟動都算一次太慢）。
- 同一時間只允許一個 `download()`，重複呼叫回傳同一個 Promise。
- `clear()` 也要刪掉舊 tag 的資料。

### 5.4 `BuiltinOcr`

沿用 `WasmOcr` 現有的 `read(files, alive)` 契約、逾時、`dispose()` 與每批一行的 `console.info`。變動：

- `start()` 從 `OcrAssets.load()` 取模型與字典，wasm 用 5.5 的方式從 `main.js` 內解出。
- `gpu` 參數：預設 `true`。Worker 內若沒有 `navigator.gpu`，直接用 `['wasm']`，不要讓函式庫去試再退回。
- **GPU 執行期失敗的處理**：GPU 模式下 Worker 連續兩次失敗或逾時（現有的「restarting the worker」路徑），這次 Obsidian 執行期間改用 `gpu: false` 重啟，並印一行警告。不持久化，下次啟動再試 GPU。
- log 前綴改為 `Enhanced Canvas OCR (built-in):`，保留行尾的 `ep=`。
- **批次大小**：`ep=wasm` 時 50 張要約 6 分鐘才存一次進度。內建引擎在 WASM 模式下每批改為 10 張；WebGPU 模式維持 50。

### 5.5 打包在 `main.js` 內的 wasm

- `esbuild.config.mjs` 新增虛擬模組 `ocr-wasm-source`：讀 `node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm`，先核對 SHA-256（不符就讓 build 失敗），用 `zlib.gzipSync`（level 9）壓縮後轉 base64，以 `loader: "text"` 匯出字串。`src/ocr-worker-source.d.ts` 補上型別宣告。
- 只有 `BuiltinOcr.ts` 匯入它。解出的方式：base64 → 位元組 → `new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()`。只在啟動 Worker 時做，不要在模組載入時做（手機也會載入這個模組）。
- 解出的 `ArrayBuffer` 會被 transfer 給 Worker，所以每次啟動 Worker 都要重新解一次，不要快取已 transfer 的 buffer。
- dev 模式（`npm run dev`）同樣要能用；watch 時不需要監看 `node_modules` 內的 wasm。

### 5.6 被擋狀態持久化（可獨立先做）

現況：`broken` 與 `blockedBy` 只在記憶體，`saveDevice()` 沒有存。每次重開 Obsidian，只要還有沒讀過的圖就會再啟動一次 PowerShell，在受 EDR 管控的電腦上等於每次都再觸發一次告警。這是從程式碼讀出來的，沒有在被擋的機器上實測。

- 把 `broken`、`blockedBy` 寫進 `DEVICE_KEY` 的物件，`loadDevice()` 讀回。
- 只有 `rebuild()` 會清掉（現有行為）。
- 讀回 `broken` 時不要重複跳通知：每次 Obsidian 啟動最多提示一次。

這一項與內建 OCR 無關，建議拆成第一個 commit，單獨驗收。

## 6. 使用者介面

所有字串為英文（設定畫面是英文）。以下是建議措辭，實作者可微調但意思不能變。

### 6.1 設定

在「Search text in images and PDFs」開關下方，只在 Windows 桌面版顯示：

- 名稱：`OCR engine`
- 選項：`System (Windows OCR)`、`Built-in`
- 說明：`Built-in runs inside Obsidian and reads many languages at once. It needs a one-time download of about 31 MB, and uses your graphics card when available. On a work computer with endpoint protection (EDR), choose Built-in: the system engine starts PowerShell, which such tools may block or report. This choice is stored on this device only.`

切換後：

- 切到 `Built-in` 且資產未就緒 → 立即開始下載（使用者剛做了明確的選擇，不需要再問一次），以通知顯示進度。
- 舊引擎讀失敗的圖片（`failed` 裡的圖片，不含 PDF）清掉，讓新引擎重試。沒讀過的圖本來就會自動讀。
- 已讀過的圖不自動重讀（大型 vault 要好幾分鐘，而且索引會同步，整份重寫會牽動所有裝置）。若索引裡有圖片，顯示一則帶按鈕的通知：`N images already read keep the text from the previous engine. [Read again with <engine>]`。按下後只重讀圖片、不動 PDF；舊文字在被取代前仍可搜尋。待重讀清單存在裝置端（`DEVICE_KEY` 的 `reread`），不改同步的索引，重開 Obsidian 會接續。再切一次引擎會換掉前一則通知。

Linux 桌面版不顯示選項，功能說明改為說明使用內建 OCR 與下載大小。

現有功能說明文字（`main.ts` 約 1583 行）要更新：不能再只說「system's built-in OCR」。

### 6.2 系統 OCR 被擋時（Windows）

現有通知：`...text recognition in images isn't working, so reading images is paused. <BLOCK_HINT> Then run "Rebuild...".`

改為在同一則通知加一個按鈕 `Use built-in OCR (31 MB download)`：

- `no-language`：保留「安裝語言包」的說明，同時提供按鈕。兩條路都列出。
- 其他原因（`constrained`、`blocked`、`stopped`、`missing`）：說明原因後直接推薦按鈕。

按下按鈕：鍵值設為 `'builtin'` → 下載 → 完成後自動繼續掃描未讀的圖（不需要 Rebuild，也不清掉 `broken`：它描述的是系統 OCR）。之後這台裝置不再啟動 PowerShell。

每次 Obsidian 啟動最多顯示一次。用通知，不要跳 modal。

Linux 第一次啟用功能時顯示類似通知：`Reading images needs a one-time download of about 31 MB.` 加按鈕 `Download`。PDF 不需要下載，照常建索引。

**若決定 1 選 B**：上述兩處不顯示按鈕，直接開始下載，通知文字改為說明正在下載與大小。其餘相同。

### 6.3 下載中與失敗

- 進度：一則常駐通知，`Downloading built-in OCR: 12 / 31 MB`，完成後關閉並顯示 `Built-in OCR is ready. Reading images…`。
- 失敗訊息要能分辨原因：
  - `'network'`：`Couldn't download built-in OCR. Check your connection, or your network may block github.com.` 加按鈕 `Retry`。
  - `'hash'`：`The downloaded file didn't match. It may have been altered or cut off.` 加按鈕 `Retry`。
  - `'storage'`：`Couldn't save the files (storage may be full).`
- 失敗後不自動重試，等使用者按 `Retry` 或下次啟動。

### 6.4 指令

新增一個指令 `Remove downloaded built-in OCR files`（呼叫 `OcrAssets.clear()`，並把引擎鍵設回未設定）。讓使用者能拿回 31 MB。

移除兩個 `Dev:` 指令與兩個原型用的 localStorage 鍵（`enhanced-canvas-ocr-wasm`、`enhanced-canvas-ocr-webgpu`）。

## 7. README

- 第 54 行現在寫「nothing is downloaded and nothing leaves your computer」。改為：辨識仍然全部在本機進行、圖片不會離開電腦；只有在使用內建 OCR 時，會從本專案的 GitHub release 下載一次約 31 MB 的模型檔。
- 支援表加上 Linux 與「Windows（內建）」。
- 加一節說明內建 OCR：何時會用到、下載什麼、存在哪裡、如何移除。
- 加上模型與 onnxruntime 的來源與授權。

## 8. 實作順序與驗收

建議分四個 commit，每個都要 `npx tsc --noEmit` 無錯誤。

### 階段 1：被擋狀態持久化（5.6）

1. 模擬被擋（例如暫時把 `powershell.exe` 的路徑改成不存在的名稱）後重載 plugin：不再啟動新的 process，通知只出現一次。
2. 執行 Rebuild 後會重試。

### 階段 2：`OcrAssets` 與單一 Worker

3. `main.js` 只含一份 Worker 與一份壓縮過的 wasm（production 大小回報給維護者，預期約 10 MB）。解出的 wasm 為 28,747,738 位元組。
4. 資產從 IndexedDB 載入後，內建 OCR 的辨識結果與原型相同（同一張圖，文字與框線一致）。
5. 把其中一個檔的雜湊常數改錯：`download()` 回傳 `'hash'`，IndexedDB 裡沒有那個檔。
6. 下載到一半中斷後重來：已完成的檔不重抓。
7. 全程除了 `github.com` 與其轉址網域外沒有其他連外請求；下載的只有三個資料檔，沒有任何可執行碼。

### 階段 3：引擎選擇與介面

8. Windows、系統 OCR 正常、未動設定：行為與現在完全相同，沒有下載。
9. Windows、設定切到 Built-in：開始下載、顯示進度、完成後用內建引擎讀新圖。log 行尾為 `ep=webgpu`（有 GPU 時）。
10. Windows、系統 OCR 被擋：通知出現按鈕；按下後下載並自動繼續；重開 Obsidian 後不再啟動 PowerShell。
11. 引擎為內建但資產未就緒：圖片被跳過而不是記為失敗，PDF 照常。
12. 關閉 Obsidian 的硬體加速：log 行尾為 `ep=wasm`，仍能辨識，每批 10 張。
13. 引擎選擇不出現在 `data.json`。
14. 掃描期間停用功能或執行 Rebuild：Worker 終止，沒有懸著的 Promise（原型已驗過，確認沒退步）。

### 階段 4：清理與文件

15. 兩個 `Dev:` 指令、兩個原型鍵、`.ort` 相關程式碼都已移除。
16. `README.md`、`docs/agent/architecture.md` 已更新；`CLAUDE.md` 與 `AGENTS.md` 仍然完全相同。
17. 手機載入 plugin 不報錯（沒有 top-level 的 Node 模組 import），並回報 `main.js` 變大後啟動有沒有明顯變慢。

### 由維護者做的事

- **在階段 2 驗收之前**建立 `ocr-assets-1` release：下載功能要有真的網址才能測。

- 確認決定 2、3（未表示意見則依預設）。
- 建立 `ocr-assets-1` release 並上傳三個檔。
- 在只有內顯的電腦與 Linux 上各跑一次，回報 log。

## 9. 風險與備案

| 風險 | 影響 | 備案 |
|---|---|---|
| `main.js` 約 10 MB 讓手機啟動變慢或更新變慢 | 所有使用者受影響 | 量過再決定；若不可接受，回到 2.4 的丙（問 Obsidian 團隊能否下載 wasm） |
| 內顯上 WebGPU 很慢或不穩 | 公司筆電上體驗差 | 已有 WASM 退路；必要時加裝置層級的「不使用 GPU」選項 |
| 公司網路擋 GitHub release 的轉址網域 | 下載失敗 | 清楚的錯誤訊息；之後做手動匯入 |
| IndexedDB 被清除 | 需要重新下載 | `ready()` 回 false 時走同一套下載提示 |

## 10. 實作者須回報

- 每個階段的驗收項目逐條結果，沒做到或沒驗到的要明說。
- production `main.js` 的大小。
- IndexedDB 是否跨 vault 共用。
- `requestUrl` 下載 release 資產是否成功、有沒有遇到轉址或大小限制的問題。
- 任何偏離本文件的地方與理由。
