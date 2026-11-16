# 原型實作指南：內建 WASM OCR（PaddleOCR）

狀態：待實作。這份文件是給實作者的規格，也是驗收依據。
日期：2026-11-16。相關設計：`docs/design-ocr-index-per-device.md`。

## 1. 目標

在 plugin 裡加一條**隱藏開關**控制的圖片 OCR 路徑：用 PaddleOCR（PP-OCRv6 small）在 Web Worker 內以 WASM 辨識，結果寫進現有的 index。

這個原型只回答三個問題：

1. Obsidian 桌面版內，能不能用 Blob URL 建 Worker、載入 wasm 與模型並完成辨識。
2. 辨識結果能不能直接沿用現有的 index、搜尋 modal 與圖片框線，不改任何下游程式。
3. 在 Obsidian 內實際的每張耗時、`crossOriginIsolated` 的值、UI 是否卡頓。

### 不在範圍內（不要做）

- 設定畫面、指令、通知按鈕、下載 UI、語言選單。這些屬於正式版，目標流程寫在第 10 節，供理解用途，**原型不實作**。
- 執行時從網路下載任何東西。模型與 wasm 由開發用腳本事先放進 plugin 資料夾。
- IndexedDB 儲存、手機、Linux。`ImageTextSearch.canIndex` 不改。
- 多執行緒 WASM、WebGPU。固定單執行緒。
- 更動 PDF 流程、index 格式、`BATCH`、`broken` / `blockedBy` / `silentRuns` 的判斷邏輯。
- 重構 `ImageTextSearch.ts` 既有程式。只加第 5.4 節列出的幾行。

### 開關關閉時的要求

沒有設定開關時，行為必須與現在**完全相同**：不建立 Worker、不讀 `ocr-wasm/`、不多任何 log。

## 2. 已驗證的事實（不需要重新驗證）

以下在 Chromium（Claude 內建瀏覽器，非 Obsidian）實測通過，2026-11-16：

| 項目 | 結果 |
|---|---|
| 套件版本 | `ppu-paddle-ocr@6.7.1`、`onnxruntime-web@1.31.1` |
| Worker 打包 | esbuild `format: iife`、`platform: browser`、`target: es2020`、`alias: onnxruntime-web → onnxruntime-web/wasm`。未壓縮 250 KB，壓縮後 136 KB，沒有警告 |
| Worker 建立 | **classic** Worker，來源是 Blob URL（`new Worker(blobUrl)`，不加 `type: 'module'`） |
| wasm 載入 | `ort.env.wasm.wasmBinary = ArrayBuffer`，只需要 `ort-wasm-simd-threaded.wasm`（14.8 MB）一個檔 |
| 模型載入 | `model: { detection, recognition, charactersDictionary }` 三個都傳 `ArrayBuffer` |
| 初始化時間 | 約 0.3 秒（位元組已在記憶體內） |
| 辨識時間 | 單執行緒中位數約 3.8 秒／張（42 張 vault 圖片） |
| 回傳格式 | `recognize(bytes, { flatten: true })` → `{ text, results, confidence }`；`results[i] = { text, box: { x, y, width, height }, confidence }`，`box` 是原圖像素座標、原點在左上 |

### 兩個必須照做的陷阱

1. **一定要清掉 `wasmPaths`。** `ppu-paddle-ocr/web` 在 import 時就把 `ort.env.wasm.wasmPaths` 設成 jsDelivr 的網址。只要 `wasmPaths` 有值，onnxruntime 就會從那個網址動態 import `ort-wasm-simd-threaded.mjs`，等於每次初始化都連外。在 `initialize()` 之前執行 `ort.env.wasm.wasmPaths = undefined`，它才會用打包進來的膠水碼加上 `wasmBinary`，完全不連網。
2. **一定要用 `strategy: 'per-box'`。** 函式庫預設的 `per-line` 會把同一高度的框合併；遇到直排邊欄文字時，偵測器會產生一個涵蓋半張圖的大框，整片文字被併進去後因信心值過低而被丟掉。實測一張圖從 830 字掉到 300 字。`per-box` 沒有變慢。

## 3. 資產檔案

放在 `<plugin dir>/ocr-wasm/`（`<plugin dir>` = `this.plugin.manifest.dir`，是 vault 相對路徑）：

| 檔名 | 來源 | 大小（bytes） | SHA-256 |
|---|---|---|---|
| `ort-wasm-simd-threaded.wasm` | `node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm` | 14,848,852 | `4b884c203b0fa48d057be3332c65513ff85aa3c5bddd6946acc0fab7ecda001d` |
| `det.ort` | `https://huggingface.co/snowfluke/ppu-paddle-ocr-models/resolve/main/detection/ort/PP-OCRv6_small_det.ort` | 9,982,352 | `c21be8d8268f0f45e2693b1d52432a290a56d008f6c1ff28b4baa7c35bab250e` |
| `rec.ort` | `https://huggingface.co/snowfluke/ppu-paddle-ocr-models/resolve/main/recognition/ort/PP-OCRv6_small_rec.ort` | 21,290,816 | `40bccd9fa3ae2d14d724bf9d020c8f0edfc801489477b92f7449162a538366df` |
| `dict.txt` | `https://huggingface.co/snowfluke/ppu-paddle-ocr-models/resolve/main/recognition/ppocrv6_dict.txt` | 74,948 | `41557512862dfe31970cf22407742b629725461dd84c0d8771bde9c87c2202c8` |

wasm 檔必須和打包進 Worker 的 `onnxruntime-web` 版本一致，所以從 `node_modules` 複製，不要從 CDN 抓。

## 4. 變更清單

| 檔案 | 動作 |
|---|---|
| `package.json` | `devDependencies` 加 `"ppu-paddle-ocr": "6.7.1"`、`"onnxruntime-web": "1.31.1"`（**固定版本，不加 `^`**） |
| `esbuild.config.mjs` | 加一個 esbuild plugin，把 Worker 打包成字串注入 `main.js`（5.1） |
| `src/ocr-worker.js` | 新增。Worker 原始碼，**純 JavaScript**（5.2） |
| `src/ocr-worker-source.d.ts` | 新增。虛擬模組的型別宣告（5.1） |
| `src/WasmOcr.ts` | 新增。主執行緒端的包裝（5.3） |
| `src/ImageTextSearch.ts` | 只加 5.4 列出的幾處 |
| `scripts/fetch-ocr-assets.mjs` | 新增。開發用腳本，準備第 3 節的四個檔案（5.5） |
| `docs/agent/architecture.md` | `ImageTextSearch.ts` 那一段補上原型說明（5.6） |

## 5. 各檔案規格

### 5.1 `esbuild.config.mjs`：把 Worker 打成字串

Obsidian plugin 只發佈 `main.js`，所以 Worker 的程式碼要以字串形式放在 `main.js` 裡。做法是一個虛擬模組 `ocr-worker-source`，它的預設匯出就是 Worker 打包後的文字。

```js
import path from "node:path";

const ocrWorkerSource = {
	name: "ocr-worker-source",
	setup(build) {
		build.onResolve({ filter: /^ocr-worker-source$/ }, () => ({ path: "ocr-worker-source", namespace: "ocr-worker" }));
		build.onLoad({ filter: /.*/, namespace: "ocr-worker" }, async () => {
			const result = await esbuild.build({
				entryPoints: ["src/ocr-worker.js"],
				bundle: true,
				write: false,
				format: "iife",
				platform: "browser",
				target: "es2020",
				minify: prod,
				alias: { "onnxruntime-web": "onnxruntime-web/wasm" },
				logLevel: "warning",
			});
			return { contents: result.outputFiles[0].text, loader: "text", watchFiles: [path.resolve("src/ocr-worker.js")] };
		});
	},
};
```

然後在現有的 `esbuild.context({...})` 加上 `plugins: [ocrWorkerSource]`。其餘設定不動。

要點：

- Worker 的打包**不能**套用主設定的 `external`、`format: "cjs"`、`target: "es2018"`。它是獨立的瀏覽器 bundle。
- `alias` 那一行讓 `ppu-paddle-ocr` 內部的 `import "onnxruntime-web"` 改用只含 WASM 後端的版本。少了它會打包進 WebGPU 版，需要的 wasm 檔也不同。
- `watchFiles` 讓 `npm run dev` 在 Worker 原始碼改動時重新打包。

`src/ocr-worker-source.d.ts`：

```ts
declare module 'ocr-worker-source' {
    const source: string;
    export default source;
}
```

### 5.2 `src/ocr-worker.js`：Worker

**必須是 `.js`，不是 `.ts`。** `tsconfig.json` 是 `moduleResolution: "node"` + TypeScript 4.7，解析不了 `ppu-paddle-ocr/web` 這種 `exports` 子路徑，而 `npx tsc --noEmit` 是這個 repo 唯一的正確性檢查。`.js` 檔不在 `include`（`**/*.ts`）內，也沒有任何 `.ts` 檔 import 它，所以 tsc 完全不會碰到這兩個套件的型別。不要為了讓它變成 `.ts` 而去改 `tsconfig.json`。

以下內容已實測可用，除了訊息格式外請照抄：

```js
import * as ort from 'onnxruntime-web';
import { PaddleOcrService } from 'ppu-paddle-ocr/web';

let service = null;

self.onmessage = async ({ data }) => {
    if (data.type === 'init') {
        try {
            ort.env.wasm.wasmBinary = data.wasm;
            ort.env.wasm.numThreads = 1;
            // ppu-paddle-ocr/web points this at jsDelivr on import; while it is set, onnxruntime imports its
            // glue module from there on every start. Cleared, it uses the bundled glue + wasmBinary: no network.
            ort.env.wasm.wasmPaths = undefined;
            service = new PaddleOcrService({
                model: { detection: data.det, recognition: data.rec, charactersDictionary: data.dict },
                // per-line (the default) merges boxes on one row: a tall box around vertical margin text swallows
                // the whole region, and the merged crop is then dropped for low confidence.
                recognition: { strategy: 'per-box' },
                session: { executionProviders: ['wasm'] },
            });
            await service.initialize();
            self.postMessage({ type: 'ready', isolated: self.crossOriginIsolated, threads: ort.env.wasm.numThreads });
        } catch (e) {
            self.postMessage({ type: 'init-error', error: String((e && e.stack) || e) });
        }
        return;
    }
    if (data.type === 'ocr') {
        const t = performance.now();
        try {
            // Decoded once here only for the size: boxes come back in pixels and the index stores fractions.
            const bitmap = await createImageBitmap(new Blob([data.bytes]));
            const size = [bitmap.width, bitmap.height];
            bitmap.close();
            const r = await service.recognize(data.bytes, { flatten: true });
            self.postMessage({ type: 'result', id: data.id, size, items: r.results.map((i) => ({ text: i.text, box: i.box })), ms: performance.now() - t });
        } catch (e) {
            self.postMessage({ type: 'ocr-error', id: data.id, error: String((e && e.stack) || e) });
        }
    }
};
```

訊息協定：

| 方向 | 訊息 | 說明 |
|---|---|---|
| 主 → Worker | `{ type: 'init', wasm, det, rec, dict }` | 四個都是 `ArrayBuffer`，用 transfer list 傳送 |
| Worker → 主 | `{ type: 'ready', isolated, threads }` | 初始化成功 |
| Worker → 主 | `{ type: 'init-error', error }` | 初始化失敗 |
| 主 → Worker | `{ type: 'ocr', id, bytes }` | `bytes` 是圖片檔案內容，用 transfer list 傳送；`id` 是遞增整數 |
| Worker → 主 | `{ type: 'result', id, size: [w, h], items, ms }` | 沒有文字時 `items` 是空陣列 |
| Worker → 主 | `{ type: 'ocr-error', id, error }` | 這張圖失敗（通常是無法解碼） |

### 5.3 `src/WasmOcr.ts`：主執行緒端

```ts
import type { TFile } from 'obsidian';
import type EnhancedCanvas from '../main';
import type { OcrLine } from './ImageTextSearch';

export class WasmOcr {
    constructor(plugin: EnhancedCanvas);
    /** 開關是否打開（讀 localStorage，每次呼叫都重新讀）。 */
    get on(): boolean;
    /** 四個資產檔是否都存在。 */
    available(): Promise<boolean>;
    /** 與 ImageTextSearch.ocrImages() 相同的回傳契約，見下。 */
    read(files: TFile[], alive: () => boolean): Promise<(OcrLine[] | null)[] | null>;
    /** 終止 Worker 並讓進行中的 read() 結束。之後再呼叫 read() 會重新建立 Worker。 */
    dispose(): void;
}
```

**型別 import 必須是 `import type`。** `ImageTextSearch.ts` 會 import `WasmOcr`，反向只能是型別，否則形成執行期循環相依。

行為規格：

1. **開關**：`this.plugin.app.loadLocalStorage('enhanced-canvas-ocr-wasm') === true`。存在本機、不進 `data.json`，所以不會同步到其他裝置。使用者在開發者主控台執行 `app.saveLocalStorage('enhanced-canvas-ocr-wasm', true)` 打開，傳 `null` 關閉。驗收後另外加了開發用指令「Dev: toggle built-in OCR (prototype)」做同一件事（`WasmOcr.toggle()`），並用通知顯示目前狀態與資產是否齊全；它隨原型一起移除。
2. **資產路徑**：`` `${this.plugin.manifest.dir}/ocr-wasm/<檔名>` ``，用 `this.plugin.app.vault.adapter.exists()` 與 `adapter.readBinary()` 讀。
3. **Worker 建立**（第一次 `read()` 時才建立，之後重複使用）：
   - `import workerSource from 'ocr-worker-source'`。
   - `const url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }))`，`new Worker(url)`，建立後立刻 `URL.revokeObjectURL(url)`。
   - 讀四個資產檔，送 `init`（transfer）。等到 `ready` 或 `init-error`。初始化逾時 60 秒。
   - 用 `worker.onmessage` / `worker.onerror`，不要用 `document.addEventListener`。
4. **`read(files, alive)`**：
   - Worker 無法建立或初始化失敗 → `console.error` 後回傳 `null`（整批失敗），並把 Worker 丟掉，下次再試。
   - 逐張處理，**一次一張**（不要平行）。每張之前檢查 `alive()`；為 `false` 就立刻回傳 `null`。
   - 每張用 `this.plugin.app.vault.readBinary(file)` 讀檔，transfer 給 Worker。
   - `result` → 轉成 `OcrLine[]`（見第 5 點）。`items` 是空陣列時結果是 `[]`，**不是** `null`（`null` 代表讀不到，會被記進 `failed`）。
   - `ocr-error` → 這一張是 `null`，`console.warn` 檔案路徑與錯誤，繼續下一張。
   - 單張逾時 90 秒 → 這一張是 `null`，`dispose()` 掉 Worker（它可能卡住），下一張會重新建立。
   - 全部完成後回傳與 `files` 等長、順序相同的陣列。
5. **轉換成 `OcrLine`**（`[text, x, y, w, h]`，數值是相對於圖片的比例，原點左上）：
   - `text` 先 `.trim()`，結果是空字串就跳過這個項目。和 Windows 路徑相同的 `CJK_GAP` 取代**不在這裡做**，而是在 `ImageTextSearch.ocrImages()` 的分流裡對回傳值套用：`WasmOcr.ts` 對 `ImageTextSearch.ts` 只能 `import type`，拿不到這個 regex 的值。（這份指南原本要求在這裡套用並 export `CJK_GAP`，與 `import type` 的限制互相矛盾；實作採用現在的寫法，驗收時已確認。）
   - `x = box.x / w`、`y = box.y / h`、`寬 = box.width / w`、`高 = box.height / h`，其中 `[w, h] = size`。
   - 夾在 0–1 之間：`x`、`y` 夾到 `[0, 1]`，寬高夾到不超出右、下邊界。
   - 順序維持 Worker 回傳的順序。
6. **量測 log**：每次 `read()` 結束時輸出一行 `console.info`，這是驗收要看的數據：

   ```
   Enhanced Canvas OCR (wasm): 50 images, 42 read, 187.3 s total, median 3791 ms, max 14563 ms, init 312 ms, crossOriginIsolated=false, threads=1
   ```

   `init` 只在這次 `read()` 有建立 Worker 時是實際毫秒數，其餘寫 `0`。
7. **`dispose()`**：`worker.terminate()`、清掉參照、讓所有等待中的 Promise 以失敗結束（不能有永遠不 resolve 的 Promise）。可重複呼叫。

### 5.4 `src/ImageTextSearch.ts`：只改這幾處

1. `CJK_GAP` 不需要 export（見 5.3 第 5 點），改在第 3 點的分流裡使用。
2. 類別加一個欄位：`private wasm = new WasmOcr(this.plugin);`（建構本身不做任何事、不讀檔、不建 Worker）。
   注意欄位初始化順序：`plugin` 是建構子參數屬性，TypeScript 會先指派它再跑欄位初始化；若 tsc 抱怨，改在建構子內指派。
3. `ocrImages()` 最前面加分流。開關打開且資產齊全才走 WASM；否則走原本的路徑，一行都不變：

   ```ts
   private async ocrImages(files: TFile[]): Promise<(OcrLine[] | null)[] | null> {
       if (this.wasm.on) {
           if (await this.wasm.available()) {
               const gen = this.gen;
               const read = await this.wasm.read(files, () => gen === this.gen);
               read?.forEach((l) => l?.forEach((x) => (x[0] = x[0].replace(CJK_GAP, ''))));
               return read;
           }
           console.warn('Enhanced Canvas OCR (wasm): switched on, but ocr-wasm/ is incomplete; using the system OCR.');
       }
       return this.ocrImagesNative(files);
   }
   ```

   原本的 `ocrImages` 函式本體改名為 `ocrImagesNative`，內容不動。
4. `disable()` 與 `rebuild()` 裡，`this.proc?.kill();` 旁邊各加一行 `this.wasm.dispose();`。

呼叫端 `ocr()` 的重試與 `broken` 邏輯不要改。WASM 路徑回傳 `null`（整批失敗）時，它會照現有規則逐張重試，連續失敗 3 次後暫停並顯示現有的通知，這是可接受的行為。

**不要**在檔案頂端 import `child_process` 或任何 Node 模組（現有註解已說明：手機載入會壞）。`WasmOcr.ts` 也一樣，只能用 `obsidian` 的 API 與瀏覽器 API。

### 5.5 `scripts/fetch-ocr-assets.mjs`

用法：`node scripts/fetch-ocr-assets.mjs <目標資料夾>`，目標是某個 vault 的 `.obsidian/plugins/enhanced-canvas/ocr-wasm`。

- 建立目標資料夾。
- 從 `node_modules/onnxruntime-web/dist/` 複製 wasm 檔。
- 用 Node 內建的 `fetch` 下載三個模型檔。
- 對四個檔案都計算 SHA-256，與第 3 節的值比對；不符就印出錯誤並以非 0 結束（不要留下不符的檔案）。
- 已存在且雜湊正確的檔案跳過。
- 只用 Node 內建模組。不加新的相依套件。

### 5.6 文件

`docs/agent/architecture.md` 的 `ImageTextSearch.ts` 段落補上（簡短即可）：

- `WasmOcr.ts` 的存在、它由 localStorage 開關 `enhanced-canvas-ocr-wasm` 控制、屬於原型。
- Worker 原始碼在 `src/ocr-worker.js`，由 `esbuild.config.mjs` 的 `ocr-worker-source` plugin 打成字串；它是 `.js` 的原因。
- 兩個陷阱（清掉 `wasmPaths`、`per-box`）。
- 資產在 `<plugin dir>/ocr-wasm/`，由 `scripts/fetch-ocr-assets.mjs` 準備。

`CLAUDE.md` 裡的敘述若沒有因此變得不正確就不要動；若有動，`AGENTS.md` 必須同步成一模一樣。

## 6. 驗收標準

實作完成後，驗收者會逐項檢查：

**靜態檢查**

1. `npx tsc --noEmit` 沒有錯誤。
2. `npm run dev` 能產出 `main.js`，esbuild 沒有警告。（不要執行 `npm run build`，驗收者會自行確認 production 設定能打包。）
3. `git diff` 只包含第 4 節列出的檔案，外加 `package-lock.json`（它被 `.gitignore` 忽略，不會出現）。
4. `tsconfig.json`、`manifest.json`、`styles.css`、`src/settings.ts`、`main.ts` 沒有變更。
5. `src/ImageTextSearch.ts` 的 diff 只有 5.4 的四處；`ocrImagesNative` 的本體與原本的 `ocrImages` 逐字相同。
6. `WasmOcr.ts` 對 `ImageTextSearch` 只有 `import type`。
7. Worker 內 `wasmPaths = undefined` 在 `initialize()` 之前，且 `strategy` 是 `'per-box'`。
8. 沒有任何執行期的網路請求程式碼（`fetch(`、`requestUrl(`、`XMLHttpRequest`）出現在 `WasmOcr.ts` 與 `ocr-worker.js`。
9. 沒有 `Math.random()`；沒有新增 DOM 事件監聽；沒有手寫的 prototype patch。

**行為（由程式碼推斷）**

10. 開關關閉時不會建立 Worker、不會讀 `ocr-wasm/`。
11. 開關打開但資產不齊時，走原本的系統 OCR，並有一行 `console.warn`。
12. 沒有文字的圖回傳 `[]`；解碼失敗的圖回傳 `null`；兩者沒有混淆。
13. `disable()` 或 `rebuild()` 之後，進行中的 `read()` 會結束（不會留下永遠等待的 Promise），Worker 被終止。
14. 單張逾時後 Worker 會被重建，後續圖片能繼續處理。
15. `OcrLine` 的座標是 0–1 的比例、原點左上。

**在 Obsidian 內（由使用者操作，實作者不需要也無法執行）**

16. 用腳本準備資產、打開開關、重新載入 plugin、執行「Rebuild image and PDF text index」。
17. 主控台出現 5.3 第 6 點的量測 log，沒有 CSP 或 Worker 相關的錯誤。
18. 搜尋 modal 找得到圖片文字，點開後圖片上的框線位置正確。
19. 掃描期間 Obsidian 操作不卡頓。

## 7. 實作者須回報

完成時請列出：

- 每個變更檔案的一句話摘要。
- `npx tsc --noEmit` 與 `npm run dev` 的實際輸出（成功或錯誤訊息原文）。
- `main.js` 在加入前後的大小。
- 任何偏離這份指南的地方，以及原因。
- 沒有做、或沒有把握的部分。**不要**把無法在 Obsidian 內驗證的行為寫成「已驗證」。

## 8. 遇到問題時

- **不要自行繞過。** 如果第 2 節的做法在打包階段就失敗（例如 esbuild 解析不了某個 import），回報錯誤原文並停下，不要改用 CDN、不要改成 module Worker、不要改 `tsconfig.json`。
- Obsidian 內的 CSP、Worker 或 wasm 載入失敗，正是這個原型要找出的答案。實作者無法觀察到這些，交給驗收階段處理。
- 套件版本不要升級。第 2 節的事實只對表中的版本成立。

## 9. 已知限制（原型階段接受）

- `BATCH` 是 50，WASM 路徑下一批約 3 分鐘才更新一次進度通知並存檔。
- `main.js` 會增加約 136 KB（production），所有平台都會載入這段字串，包含不會用到它的手機。正式設計時再決定是否改為隨模型一起下載。
- `ocr-wasm/` 約 46 MB，放在 plugin 資料夾。用 git 或 iCloud 同步 vault 的話會被一起同步，測試期間請自行排除。
- HEIC 無法由 Chromium 解碼，會進 `failed`。
- 簡繁混淆（例如「倍數」被辨識成「倍数」）沒有處理。

## 10. 正式版的使用者流程（背景說明，原型不實作）

> 這一節已由 `docs/spec-builtin-ocr.md` 取代，保留作為討論紀錄。

這一節說明原型驗證通過後要做成什麼樣子，讓實作者知道 `WasmOcr` 之後會怎麼被使用。**這一節的任何項目都不在原型範圍內。**

### 10.1 定位

內建 OCR 不是靜默取代系統 OCR，也不只是 fallback，依平台而定：

| 平台 | 預設 | 內建 OCR 的角色 |
|---|---|---|
| macOS | Vision | 不提供。Vision 又快又準 |
| Windows | Windows OCR | 被擋住時的 fallback；也可由使用者手動選用（較準確，但首次掃描慢、需下載） |
| Linux | 無 | 唯一可用的圖片 OCR |

不直接當 Windows 預設的原因：要下載約 46 MB（預設行為不該未經同意連網抓檔），且首次掃描慢很多（1,170 張圖估計約 80 分鐘，Windows OCR 是幾分鐘）。

### 10.2 使用者不需要一開始就選

多數使用者不知道自己的電腦會不會被擋，也無從判斷哪個引擎比較好。所以預設什麼都不用做，只有被擋住時才出現選項。三種情況：

**情況 1：大多數人（Windows OCR 正常、macOS）**

什麼都不用做。啟用功能後照現有方式在背景掃描，看不到任何與內建 OCR 有關的東西。

**情況 2：系統 OCR 被擋住的人（例如 Cortex XDR、AppLocker、沒有 OCR 語言包）**

1. plugin 照常先試系統 OCR，由現有的偵測邏輯（`blockedBy`：`no-language`、`constrained`、`blocked`、`stopped`、`missing`）判定被擋。
2. 現在的行為是顯示 `BLOCK_HINT` 通知後暫停。正式版在同一則通知加一個按鈕：「改用內建 OCR（需下載約 46 MB）」。
   - `no-language` 使用者自己裝語言包就能修好，而且系統 OCR 比較快，所以通知要同時列出「安裝語言包」與「改用內建 OCR」兩條路。
   - 其他原因使用者修不了，直接推薦內建 OCR。
3. 按下按鈕 → 顯示下載進度 → 完成後自動繼續掃描。
4. 這個選擇記在這台裝置上（localStorage，不進 `data.json`），之後**不再嘗試 PowerShell**。

用通知加按鈕，不要主動跳 modal：掃描是啟動後在背景跑的，使用者沒做任何事就跳視窗很突兀。每台裝置只提示一次。

**情況 3：想要更準的人**

到設定把「OCR 引擎」從「系統」切到「內建」，同樣觸發下載；切換後由使用者自己執行 Rebuild。已經用系統 OCR 讀過的圖不會自動重掃。

### 10.3 設定旁的提示文字（已決定要加）

在啟用「Search text in images and PDFs」的設定旁加一行說明，讓知情的人能在第一次嘗試之前就避開 PowerShell：

> 公司電腦若有端點防護（EDR），建議直接選內建 OCR。

理由：受 XDR/EDR 管控的電腦，plugin 第一次啟動 PowerShell 時就可能在公司的資安後台留下告警。「先試再 fallback」避不掉這一次，只有事先選內建才能避開。

這行文字要等「OCR 引擎」選項存在後才能加：現在加會指向一個不存在的選項。實際的英文措辭在實作設定畫面時決定（設定畫面是英文）。

### 10.4 連帶要修的現有問題

`broken` 與 `blockedBy`（系統 OCR 被擋的狀態）目前只存在記憶體，`saveDevice()` 沒有保存它們。推斷的結果是：每次重開 Obsidian，只要還有沒讀過的圖，就會再啟動一次 PowerShell、再觸發一次告警。這是從程式碼讀出來的，沒有在被擋的機器上實測。

正式版應把「這台裝置的系統 OCR 被擋」寫進裝置狀態（`DEVICE_KEY`），直到使用者執行 Rebuild 才重試。這一項與內建 OCR 無關，可以獨立先做。

### 10.5 其他已討論、未定案的項目

- **語言**：PP-OCRv6 small 一個模型涵蓋 50 多種語言（含英文、繁體、簡體），第一版不需要語言選單。
- **模型儲存位置**：傾向 IndexedDB 而不是 plugin 資料夾，避免被 git / iCloud 一起同步。
- **下載來源**：傾向放在本專案的 GitHub release，固定版本並驗 SHA-256；README 要寫明會連網下載。
- **下載被公司網路擋住時**：要有明確的失敗訊息；之後可考慮「手動匯入模型檔」。
- **Worker 程式碼的位置**：原型放在 `main.js` 內（約 136 KB）；正式版可能改為隨模型一起下載，讓不使用的人不必載入。

## 11. WebGPU 實驗（原型完成後追加）

原型驗收通過後，在 Obsidian 內量到每張圖中位數約 7 秒（單執行緒 WASM，`crossOriginIsolated=false` 所以不能多執行緒）。因此追加 WebGPU 實驗。

### 瀏覽器內的量測（RTX 3080 的桌機，19 張樣本圖，第一張不計）

| | 每張中位數 | 18 張合計 |
|---|---|---|
| WASM（`.ort`） | 6.1 秒 | 101 秒 |
| WebGPU（`.onnx`） | 0.64 秒 | 12 秒 |

- 兩邊辨識出的文字完全相同；用真的 `WasmOcr` 類別跑 6 張，文字與框線座標（取到小數第 3 位）也相同。
- WASM 的時間約八成花在辨識（rec），不是偵測（det）；WebGPU 對兩者都有效。
- WebGPU 初始化約 1.5 秒（WASM 約 0.3 秒）。

### 實作

- 開關：localStorage `enhanced-canvas-ocr-webgpu`，指令「Dev: toggle WebGPU for built-in OCR (prototype)」。要內建 OCR 的開關也打開才有作用；切換後下一次 Rebuild 才生效。
- 資產（同樣放 `ocr-wasm/`，由 `scripts/fetch-ocr-assets.mjs` 準備）：`ort-wasm-simd-threaded.asyncify.wasm`（28.7 MB）、`det.onnx`（9.9 MB）、`rec.onnx`（21.2 MB）、`dict.txt`。缺任何一個就用 WASM。
- Worker 是同一份 `src/ocr-worker.js`，另外用 `onnxruntime-web/webgpu` 打包一份（虛擬模組 `ocr-worker-webgpu-source`）。production 的 `main.js` 因此從約 224 KB 變成約 406 KB。
- 每批的 log 行尾會印 `ep=wasm` 或 `ep=webgpu`；有 session 退回 WASM 時會寫出幾個，並另外印警告。

### 三個陷阱

1. `.ort` 模型在 WebGPU 上建不起 session（`Failed to find op_id: com.ms.internal.nhwc:Conv:1`），函式庫會靜默退回 WASM。WebGPU 一定要用 `.onnx`。
2. 函式庫同時建立偵測與辨識兩個 session，WebGPU 會拒絕第二個（`another WebGPU EP inference session is being created`），那一個也會靜默退回 WASM。Worker 內把 `InferenceSession.create` 改成一次一個。
3. Windows 上 `requestAdapter()` 的 `powerPreference` 目前被忽略，無法指定用哪一張顯示卡。

### 尚未驗證

- Obsidian（Electron）內是否拿得到 WebGPU，速度是否與瀏覽器相近。
- 內顯筆電上的速度。上面的數字只代表有獨立顯示卡的桌機。
- 掃描期間 Obsidian 畫面是否變卡。
