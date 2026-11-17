# Windows OCR 下載同意 (A) + 當機防護 (B)

> 狀態：A 和 B 都已實作（`src/ImageTextSearch.ts`），`tsc` 通過，**尚未**在 Obsidian 裡或有 XDR 的電腦上驗證。實作時的選擇：`killed` 撐過 Rebuild（Rebuild 後重新套用整台裝置的判定）；「從設定重新開」＝設定裡「Search text in images and PDFs」旁的「Try … OCR again」按鈕（只在判定生效時出現）。已做過一輪 review（對照 `src/ImageTextSearch.ts` 和 1.0.37 的程式碼），結論已併入下文；
> 第 6 節是 review 的回答，第 7 節是決定、建議的預設值和實作順序。
> 所有判定都是讀程式碼推論的，沒有在 Obsidian 裡跑過，也沒有在有 XDR 的電腦上驗證過。
>
> **2026-11-17 更新：A 的「還沒決定」狀態已移除。** Windows 預設就是 Built-in（空的 `ENGINE_KEY` ＝ Built-in），不再用 `offerChoice()` 二選一，也不再把舊版使用者轉成 System；圖片等使用者在下載通知上按 Download，要用 Windows OCR 得自己到設定裡選。下文 A 的二選一通知、`readImage` 轉換、「不同意＝Windows OCR」都是歷史紀錄。B 不變。見 `docs/design-builtin-ocr.md` 決定 5。

## 1. 背景

Obsidian plugin「Enhanced Canvas」有一個「搜尋圖片和 PDF 裡的文字」功能。在 Windows 上有兩種 OCR engine：

| Engine | 怎麼跑 | 代價 |
|---|---|---|
| **System**（Windows OCR） | 用 `child_process.spawn` 啟動 `powershell.exe`，呼叫 WinRT OCR | 不必下載；但 PowerShell 是資安軟體 (EDR) 重點監控對象 |
| **Built-in** | PaddleOCR 模型跑在 onnxruntime-web 上（WebGPU，不行就退回 WASM），在 Obsidian 內部執行 | 第一次要從 GitHub release 下載約 31 MB 模型（會驗 SHA-256，存進 IndexedDB）；不會啟動任何外部程式 |

目前的行為：
- Windows 預設用 System。只有使用者在設定裡手動切換，或在「被擋」通知上按按鈕，才會下載 Built-in。
- 偵測 Windows OCR 被擋的邏輯（`blocked`、`stopped`、`constrained`、`missing`、`no-language`）都要**等 PowerShell 回傳之後**才會執行。判定被擋後，會把 `broken` 存進 localStorage，暫停讀圖片（PDF 照常建索引），並顯示「Use built-in OCR」按鈕。
- 已發布的 1.0.37：OCR 要使用者自己開啟；腳本用 `-EncodedCommand` 傳給 PowerShell；只有 System，沒有 Built-in。
- master 上未發布的變更：
  - OCR 改成預設開啟（2b6f1b1）。
  - 腳本改用 stdin 傳給 PowerShell，不再用 `-EncodedCommand`（672200f）。這個改動**還沒在有 XDR 的電腦上測過**。
  - Built-in engine（406917e）。

## 2. 問題

在有 **Cortex XDR** 的電腦上，plugin 一啟動 PowerShell，XDR 就把**整個 Obsidian** 強制關閉。

- 因為整個程序被直接砍掉，「被擋」的判定根本沒機會執行，也沒有任何東西寫進磁碟。
- 掃描是在 `onLayoutReady` 時立刻開始的，所以重開 Obsidian 會馬上又被關。**實際觀察到：重啟後立即被關閉**，形成無限迴圈。
- **這不只是「預設開啟」之後才有的問題**：1.0.37 的使用者只要在有 XDR 的電腦上自己開了 OCR，現在就已經卡在這個迴圈裡。
- 如果 OCR 預設開啟的版本發布出去，有 XDR 的使用者一更新，Obsidian 就打不開了。使用者只能從檔案總管手動刪掉 plugin 才能脫困。
- 每被關一次，很可能就產生一筆報給 IT 的資安告警。

## 3. 需求

1. **A：先問使用者要不要下載。** Windows 上第一次需要對圖片做 OCR 時，用白話詢問使用者能不能下載文字辨識模型（約 31 MB），並讓使用者知道這是「為了能搜尋圖片裡的文字」。
   - 使用者同意：下載 Built-in，這個 vault 在這台裝置上之後都不啟動 PowerShell。
   - 使用者不同意：改用 Windows OCR；失敗時再問一次要不要用 Built-in（已決定，見第 7 節）。
2. **B：Windows OCR 失敗時的防護**，包括 Obsidian 被整個關掉的情況。要保證**整台裝置**最多被關一次（不是每個 vault 各一次），並且讓使用者能改用 Built-in。
3. **發布順序**：
   - B 和 stdin 的改動（672200f）是現有問題的修正，**不必等 A**，可以先發。
   - A 和 B 都完成之前，「預設開啟」不發布。

## 4. 解法

### A. 下載同意

- **需要第三種 engine 狀態「還沒決定」。** 現在的 `engine` getter 把空的 `ENGINE_KEY` 當成 `'system'`（第 218 行），而 `paused`、`ocr()`、`scan()` 都把 engine 當成二選一。「還沒決定」要在 `scan()` 裡擋住圖片，做法和現在 Built-in 檔案還沒下載時的 `missing` 一樣（第 531–538 行）。
- **何時詢問**：Windows 桌面版、OCR 已開啟、有圖片要讀，而且這個 vault 在這台裝置上是「還沒決定」。
  - macOS 用 Vision，不詢問。
  - Linux 本來就只有 Built-in，維持現在的下載提示。
  - 如果這台裝置已經存了 `broken`（System 已知被擋），就不詢問，直接顯示現有的「暫停」通知（上面本來就有 Use built-in 按鈕）。這時「不同意」按鈕沒有意義。
- **用常駐通知，不用 modal。** 掃描是背景工作、常在啟動時跑，這個檔案現有的規則是背景掃描不跳提示（第 591 行）；而且更新後使用者會先看到 release notes 的 modal，兩個 modal 會撞在一起。做法照現有的 `offerDownload`（`new Notice(…, 0)` 加按鈕）。
- **建議文字**（草稿；plugin 的通知都是英文，實際上要用英文）：
  > Enhanced Canvas: choose how to read the text in your images. Both ways run on your computer.
  > [Built-in OCR (recommended, 31 MB download)] [Windows OCR]
  > Built-in OCR is more accurate and reads many languages at once, but is slow without a graphics card. Windows OCR needs no download and reads one language; company security software may block it. Change this later in settings → OCR engine.

  中文對照：選擇怎麼讀取圖片裡的文字，兩種都在你的電腦上執行。〔內建 OCR（推薦，下載 31 MB）〕〔Windows OCR〕內建 OCR 比較準、能同時讀多種語言，但沒有顯示卡時較慢。Windows OCR 不用下載、只讀一種語言，公司的資安軟體可能會擋。之後可以在設定的 OCR engine 更改。
- **使用者還沒回答之前**：不讀圖片，也**不啟動 PowerShell**，PDF 照常建索引。如果使用者關掉通知沒有回答，下次啟動再問一次。
- **不同意**：把 System 存進 `ENGINE_KEY`，開始用 Windows OCR，接下來由 B 保護。
- **同意但下載失敗**（例如離線）：沿用現有的重試機制，**不會**自動退回 PowerShell。
- **從舊版更新的使用者**：
  - **不能用「索引裡有沒有用 System 讀過的圖片」來判斷。** 索引的每一筆是 `{m, l, pw}`，沒有記錄是哪個 engine 讀的；而且索引放在 plugin 資料夾，會同步。Mac 上建的索引會讓有 XDR 的 Windows 電腦看起來像「System 能用」。
  - 改用裝置本機的 `readImage` 旗標（存在 `DEVICE_KEY`，不同步）。1.0.37 就有這個旗標，而且 1.0.37 只有 System，所以「`ENGINE_KEY` 是空的，而且 `readImage` 是 true」代表 Windows OCR 在這台電腦上讀成功過。直接記成 System，不詢問。
  - 這個轉換**只能做一次**（例如用一個「已轉換」的旗標）。原因：`removeBuiltin()` 會把 `ENGINE_KEY` 清成 null（第 818 行），這時 `readImage` 可能是 Built-in 讀出來的 true，再套一次就會悄悄切到 PowerShell。
  - 如果 OCR 開著，但這台裝置還沒讀過任何圖片，就詢問。
- **`removeBuiltin()`**：現在是清掉 `ENGINE_KEY`、通知「Images are read with Windows OCR again」。要決定它之後是回到「還沒決定」（再問一次），還是明確寫入 System（見第 7 節）。
- **選擇的範圍**：`ENGINE_KEY` 是每個 vault、每台裝置各自記錄（localStorage），所以是**每個 vault 各問一次**，不是每台裝置一次。模型的 IndexedDB 名稱是固定的（`enhanced-canvas-ocr-assets`），很可能所有 vault 共用，所以第二個 vault 同意時應該不必再下載（未驗證）。

### B. 當機防護（crash sentinel）

1. **啟動 PowerShell 之前**：用 `fs.writeFileSync` 同步寫一個標記檔到 `os.tmpdir()`，每個 vault 一個檔，檔名用 `app.appId`。
   - 不能用 localStorage：Chromium 是延遲寫入磁碟，程序被直接砍掉時可能還沒存進去。
   - 不能放在 plugin 資料夾：那裡會被同步到其他裝置。
   - 用 `app.appId` 而不是 vault 路徑的雜湊：每個 vault 的 localStorage 本來就是用它區分的，而且 vault 搬位置時路徑雜湊會變。
   - 標記必須每個 vault 各一個：兩個 vault 同時在跑時，共用一個檔會被先結束的那個刪掉。
2. **PowerShell 結束之後，延遲幾秒再刪除標記**（例如 10 秒，數字待定），不管成功或失敗。
   - 不能一結束就刪：只有一張圖的批次大約一秒就跑完，如果 XDR 是在 PowerShell 結束**之後**才砍 Obsidian，標記已經不在了，無限迴圈就回來了。
   - 代價是誤判多一點（使用者剛好在那幾秒內關掉 Obsidian），由第 5 點的詢問處理。
3. **正常關閉時同步刪除標記**：在 Obsidian 的 `quit` workspace event 裡用 `fs.unlinkSync` 刪掉。這個 event 不保證一定會觸發，但能去掉大部分誤判。大 vault 第一次建索引要跑好幾分鐘，使用者中途關掉 Obsidian 是很常見的事。
4. **啟動時如果標記還在**：代表上次 PowerShell 沒有回來，Obsidian 是在執行中被關掉的。處理方式：
   - 新增一種被擋原因 `killed`，設定 `broken` 並存起來。
   - **另外寫一份整台裝置共用的判定**（一個所有 vault 都會在 spawn 前檢查的檔案）。`ENGINE_KEY` 和 `DEVICE_KEY` 都是每個 vault 各自的 localStorage，只存在那裡的話，有三個 vault 的使用者會被關三次、產生三筆告警。這個檔案要放在比 `os.tmpdir()` 耐久的地方（建議位置見第 7 節）。
   - **不再啟動 PowerShell**。
   - 顯示白話通知：「上次使用 Windows 文字辨識時 Obsidian 被關閉，可能是公司的資安軟體造成的」，附兩個按鈕：
     - **[改用內建辨識（下載 31 MB）]**
     - **[繼續用 Windows 辨識]**
   - 如果現在的 engine 已經是 Built-in，標記沒有意義，直接刪掉。
5. **為什麼用詢問，而不是直接斷定**：使用者在 OCR 執行到一半時自己關掉 Obsidian，標記也可能留著。直接斷定會誤判，詢問的話，被誤判的人按一下「繼續」就能回到原本狀態。
6. **`killed` 不能被 Rebuild 清掉。** 現在 `rebuild()` 會無條件清掉 `broken` 和 `blockedBy`（第 490 行），而「暫停」通知還會叫使用者去跑 Rebuild。在 `killed` 的裝置上這會再次啟動 PowerShell。`killed` 要撐過 Rebuild，或者 Rebuild 在這種情況下要先問。
7. **按了「繼續用 Windows 辨識」之後又被關一次**：不再提供「繼續」。維持暫停，通知上只提供 Built-in；要再用 Windows OCR 只能從設定裡重新開。**不自動切到 Built-in**，因為這位使用者已經拒絕過下載。
8. **macOS 也套用標記檔。** `osascript` 同樣是 EDR 會監控的東西，Cortex XDR 也有 Mac 版。做起來沒有額外成本；Mac 沒有 Built-in，所以結果只是暫停讀圖片。
9. **（選配）啟動後延遲**：Obsidian 開啟後過一段時間，才啟動第一次 PowerShell。第 2、4、6 點做了之後，這個的價值不高。要做的話用 10–15 秒，而且只在這台裝置還沒有成功跑過一次之前才延遲。

### 流程總覽

```
Windows 第一次要讀圖片
 └─ A：通知詢問下載（還沒回答 → 不讀圖片、不啟動 PowerShell）
     ├─ 同意 → Built-in（永不啟動 PowerShell）
     └─ 不同意 → System
          └─ 先檢查整台裝置的 killed 判定 → 有就不啟動
          └─ 啟動 PowerShell（先寫標記檔）
               ├─ 正常結束 → 延遲幾秒後刪除標記；回傳的錯誤由現有的被擋偵測處理
               ├─ Obsidian 正常關閉 → quit 時刪除標記
               └─ Obsidian 被關 → 下次啟動看到標記 → B：killed（整台裝置），不再啟動，詢問改用 Built-in
                    └─ 選「繼續」後又被關 → 不再提供「繼續」，只能從設定重開
```

## 5. 已知限制

- 拒絕下載的 XDR 使用者，**還是會被關一次**，並產生一筆告警。這是已接受的代價（見第 7 節）；之後會再問一次要不要用 Built-in。
- EDR 如果只告警、不阻擋，plugin 看到的是一切正常，偵測不到。
- stdin 版本（672200f）能不能過 XDR 還不知道。不論結果如何，B 都需要做。
- 標記檔被系統清理工具刪掉時，只會漏判（回到現狀），不會誤判。
- XDR 如果在 PowerShell 結束後超過延遲時間才砍 Obsidian，標記已經刪掉，偵測不到。
- `quit` event 沒觸發時（例如系統強制關機），正常關閉也會被當成可能被砍，靠詢問補救。

## 6. Review 的回答

1. **A 的觸發時機和文字；modal 還是通知？** 觸發時機沒問題。用常駐通知，不用 modal（理由見 4.A）。文字要有英文版，而且「不同意」那邊要提到 Windows 辨識可能被公司的資安軟體擋住，不然使用者沒辦法判斷兩個選項的差別。
2. **用索引判斷舊版使用者是否可靠？** 不可靠，照原本寫的也做不出來。改用 `readImage`，而且只轉換一次（見 4.A）。
3. **標記檔放 `os.tmpdir()`、檔名用什麼？** 標記檔放 `os.tmpdir()` 可以，檔名用 `app.appId`。整台裝置的 `killed` 判定則要放在更耐久的地方。
4. **選了「繼續」又被關一次？** 不再提供「繼續」，維持暫停，只提供 Built-in，不自動切換（見 4.B 第 7 點）。
5. **啟動延遲值不值得做？** 價值不高。要做的話 10–15 秒，只在這台裝置成功跑過一次之前（見 4.B 第 9 點）。
6. **遺漏的情境？**
   - Rebuild 會重新啟動 PowerShell（4.B 第 6 點）。
   - XDR 在 PowerShell 結束後才砍（4.B 第 2 點）。
   - 多個 vault 各被關一次（4.B 第 4 點）。
   - `removeBuiltin()` 之後的狀態（4.A）。
   - 已經存了 `broken` 的裝置不該再問 A（4.A）。
   - macOS 的 `osascript`（4.B 第 8 點）。
   - 沒問題的：我們自己的逾時和 `disable()` 砍掉 PowerShell 時，`close` 還是會觸發，標記會照常刪除。彈出視窗和主視窗共用同一個 plugin instance，不需要另外處理。

## 7. 決定與待確認

### 已決定

1. **「不同意」＝改用 Windows OCR；失敗時再問一次要不要用 Built-in。**（maintainer 決定）
   - PowerShell 回報錯誤的失敗：現有的被擋偵測和 `noticePaused` 的 Use built-in 按鈕已經會處理，不用新做。
   - Obsidian 整個被關掉的失敗：plugin 自己不會知道，要靠 B 的標記檔在下次啟動時發現。所以這個決定成立的前提是 B 做完，而且 4.B 第 2、4、6 點的漏洞都補起來。
   - 接受的代價：有 XDR 的使用者按了「不同意」會被關一次、產生一筆告警（第 5 節第一項）。通知文字會先提醒 Windows 辨識可能被資安軟體擋住。
   - 沒有採用的做法：「不同意」＝不讀圖片，Windows OCR 要到設定裡自己開。

### 建議的預設值（實作時照這個做，除非 maintainer 另有決定）

2. **整台裝置的 `killed` 判定檔位置**：Windows 放 `%LOCALAPPDATA%\obsidian-enhanced-canvas\`（不同步、不漫遊、不會被暫存清理刪掉），拿不到這個環境變數時退回 `os.tmpdir()`。macOS 放 `~/Library/Application Support/obsidian-enhanced-canvas/`。
   - 注意：標記檔和這個判定檔都寫在 vault 外面。Obsidian 的開發者政策要求 plugin 存取 vault 以外的檔案時要在 README 說明，實作時要一起補上。
3. **`removeBuiltin()` 之後回到「還沒決定」**，下次要讀圖片時再問一次，通知文字跟著改。不悄悄切回 PowerShell。
4. **標記延遲刪除 10 秒**。沒有實測依據，之後在 XDR 電腦上觀察到實際時間再調。
5. **engine 的選擇維持每個 vault 各自記錄**，這次不改成整台裝置共用。每個 vault 會各問一次；模型很可能只需下載一次。

### 實作順序

1. **先做 B**（加上已經在 master 的 stdin 改動），這是 1.0.37 現有問題的修正，可以單獨發布。
2. **再做 A**。
3. A 和 B 都完成後，「預設開啟」（2b6f1b1）才能發布。

## 8. 相關程式位置

- `src/ImageTextSearch.ts`：
  - `engine` getter（第 215–219 行）：空的 `ENGINE_KEY` 目前等於 `'system'`
  - `loadDevice` / `saveDevice`（第 428–443 行）：`readImage`、`broken`、`blockedBy`
  - `onLayoutReady` 時立即掃描（第 343–362 行）
  - `rebuild()` 清掉 `broken`（第 490 行）
  - `scan()` 裡擋住圖片的地方（第 531–538 行）
  - 「背景掃描不跳提示」的規則（第 591 行）
  - 存 `broken`（第 672 行）
  - 被擋通知和 Use built-in 按鈕（`noticePaused`，第 684–709 行）
  - 下載提示（`offerDownload`，第 712–723 行）
  - `setEngine`（第 765 行）、`downloadBuiltin`（第 729 行）、`removeBuiltin`（第 811 行，第 818 行清掉 `ENGINE_KEY`）
  - `spawn` PowerShell（第 896–899 行）
- `src/OcrAssets.ts`：模型下載、SHA-256 驗證、IndexedDB 儲存（資料庫名稱在第 17 行）。
