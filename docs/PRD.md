# PRD:dsh-message-edit

DeepSeek Harness 插件——Gemini 式的訊息編輯與 Undo

- 版本:v1(0.1.0)
- 狀態:已與需求方達成共識,待實作
- 目標平台:DSH Web GUI(`@deepseek-ai/dsh` 0.1.0-rc.7),`web` profile
- 文件語言:繁體中文(技術名詞保留英文)

---

## Problem Statement(問題陳述)

在 DSH Web GUI 中,使用者送出訊息後若發現打錯字、表達不清、或想改變對話方向,唯一的補救辦法是再發一則更正訊息。這導致:

1. **畫面雜訊**:錯誤訊息及其引出的整段回應永久留在聊天記錄裡,干擾閱讀。
2. **上下文污染**:模型持續看到錯誤版本,後續回答被誤導;使用者只能反覆解釋「剛才那條不算」。
3. **Token 浪費**:廢棄分支隨對話增長不斷佔用上下文額度。

現有社群插件均不符合需求:

| 插件 | 不足之處 |
|------|----------|
| Anionex/dsh-turn-rewind | 重心是工作區檔案快照還原(Change Ledger),流程重、確認多 |
| LingLambda/dsh-undo | 依賴未發佈的 Harness API(`surface/rewind` 事件、`conversation.chat.user-actions` slot),在 rc.7 上無法運行 |
| XSJUSTC/dsh-rewind | 互動模式是「填入底部輸入框」,非 Gemini 的原處內聯編輯;無獨立 undo |

## Solution(解決方案)

`dsh-message-edit` 為每則**使用者訊息**提供兩個懸停動作,行為對齊 Gemini 網頁版:

- **編輯(鉛筆圖示)**:氣泡原地變成可編輯文字框(預填原文,附「傳送」「取消」鈕,Esc 取消)。按「傳送」那一刻:該訊息**本身及其後所有內容**自畫面與模型上下文隱藏,編輯後的新訊息出現在原位置,模型接續其之前的歷史回應。編輯期間聊天尾部仍留在畫面上供參考;取消則一切如常、不留痕跡。
- **Undo(↺ 圖示)**:立即移除該訊息**本身及其後所有內容**,對話回到該訊息發送前的狀態;不預填任何文字、不觸發模型回應、無確認框。

底層保證:

- Session 日誌維持 **append-only**,原始事件永不刪改;隱藏以區間記錄持久化,**頁面重新整理與 DSH 進程重啟後依然生效**。
- Agent 正在思考/輸出時點擊傳送或 undo,**自動打斷**當前回合,無需先手動停止。
- 被移除的內容不再進入模型上下文,也不再出現於聊天視圖。

## User Stories(使用者故事)

### 編輯

1. As a DSH Web GUI 使用者, I want 每則我送出的訊息懸停時出現鉛筆圖示, so that 我能隨時原地修正打錯字或表達不清的訊息.
2. As a 使用者, I want 點擊鉛筆後氣泡原地變成預填原文的文字框, so that 我能在原始脈絡下小幅度修改而非憑記憶重寫.
3. As a 使用者, I want 文字框旁有「傳送」與「取消」鈕且 Esc 等同取消, so that 我能明確控制送出或放棄.
4. As a 使用者, I want 編輯期間該訊息之後的對話仍顯示在畫面上, so that 我能參考後文決定怎麼改.
5. As a 使用者, I want 按下傳送後舊訊息及其後全部內容消失、新訊息出現在原位置, so that 對話看起來就像我當初就是這樣寫的.
6. As a 使用者, I want 模型只看到編輯訊息之前的歷史加上新訊息, so that 錯誤版本不會誤導後續回答.
7. As a 使用者, I want 取消編輯後不留任何狀態或痕跡, so that 誤觸沒有副作用.
8. As a 使用者, I want 編輯送出的訊息像正常訊息一樣立刻獲得模型回應, so that 流程與平常發送無異.

### Undo

9. As a 使用者, I want 每則我的訊息懸停時出現 ↺ 圖示, so that 我能一鍵收回某次提問及其全部回應.
10. As a 使用者, I want undo 把該訊息本身連同其後所有內容一起移除, so that 對話精確回到該訊息發送前的狀態.
11. As a 使用者, I want undo 後不觸發任何模型回應也不預填文字, so that 它是純粹的刪除,何時繼續由我決定.
12. As a 使用者, I want undo 不彈確認框立即生效, so that 操作零摩擦.
13. As a 使用者, I want 對第一條訊息也能 undo, so that 我能把整個對話清空到初始狀態.

### 執行中幹預

14. As a 使用者, I want agent 回應中點擊傳送或 undo 時自動打斷當前回合, so that 我不必先手動按停止再操作.
15. As a 使用者, I want 打斷後殘留的部分輸出一併進入隱藏範圍, so that 畫面與上下文都不會留下孤立的半截回應.

### 一致性與邊界

16. As a 使用者, I want 排隊中的 steering 訊息同樣可編輯/undo, so that 回合中途插入的訊息也在我掌控之中.
17. As a 使用者, I want 含圖片/附件的訊息仍可 undo, so that 收回操作對所有訊息一致.
18. As a 使用者, I want 已位於隱藏區間內的訊息不再顯示動作鈕, so that 不會發生矛盾的二次回退.
19. As a 使用者, I want 多次編輯/undo 的隱藏區間正確累疊互不干擾, so that 長對話的多輪修正行為可預期.
20. As a 使用者, I want 編輯不會覆蓋我在底部輸入框正在打的草稿, so that 兩種輸入互不干擾.

### 持久性與介面

21. As a 使用者, I want 重新整理頁面後隱藏依然生效, so that 已移除的內容不會復活.
22. As a 使用者, I want DSH 進程重啟後隱藏依然生效, so that 長期使用的會話狀態穩定.
23. As a 使用者, I want 動作鈕僅在懸停時浮現, so that 平時介面乾淨如原生.
24. As a 使用者, I want 依瀏覽器語言顯示中文或英文介面文字, so that 操作提示易於理解.
25. As a 使用者, I want 切換到其他會話再切回來,隱藏狀態仍然正確, so that 多會話並用不出錯.

### 營運與維護

26. As a 插件使用者, I want 用 `dsh plugin --profile web add <目錄>` 即可安裝、`remove` 即可卸載, so that 生命週期管理與其他插件一致.
27. As a 進階使用者, I want append-only 日誌完整保留原始事件與每次 mark/cancel/commit/undo 稽核記錄, so that 出問題時可完整追溯.
28. As a 開發者, I want 核心狀態機為零依賴純函式模組並有單元測試覆蓋, so that 未來修改語意時有回歸防護.
29. As a 開發者, I want 插件零 npm 依賴、零建置步驟, so that 複製到任何機器即可安裝運行.

## Implementation Decisions(實作決策)

以下決策均已在拷問會議中與需求方逐項確認,並對 rc.7 原始碼驗證可行性。

### 語意

- **Undo = 移除 N 本身 + 其後一切**(回到「N 從未發送」);非「保留 N 只刪之後」。
- **Edit = 內聯替換**:尾部於按下「傳送」那一刻才隱藏(Gemini 式);非 dsh-rewind 的「預填底部輸入框」式。
- 由於 N 以後全部隱藏,新訊息自然落在 N 的原位置——「原地替換」由架構免費達成,無需特殊處理。
- 單一版本,無草稿切換箭頭;無復原/redo 入口;undo 無確認框。

### 模組切分(三模組)

1. **核心模組(純邏輯,零依賴零 I/O)**
   - 隱藏區間狀態機:輸入稽核事件序列(mark / cancel / commit-edit / commit-undo)與動作,輸出 `{ pending, ranges }`;負責合法性裁決(目標必須是 user 類訊息、不得落入既有隱藏區間)。
   - 區間過濾謂詞:給定 surface 節點錨定 seq 與 ranges,判定是否隱藏。
   - 事件重放:從日誌事件重建完整狀態(支撐跨重啟持久化)。
2. **主機半(host half)**:呼叫核心模組,接上 DSH 服務。
3. **客戶端半(client half)**:UI 渲染與互動,不含業務規則。

### 主機半

- `inject = ['webServer', 'sessions', 'agents']`;以 exact 路由掛載 HTTP API:
  - `POST …/mark`:編輯意圖。校驗目標 seq 為 user 類訊息且不在既有隱藏區間內(違例分別回 400/409);append 稽核事件;若 agent 執行中則 `cancel({ kind: 'user' }, { keepInbox: true })` 打斷。
  - `POST …/undo`:立即回退。打斷執行中回合;待回合靜止後封印 `[targetSeq, 日誌末尾]`(若使用者立刻再發送,則改由 pre-step 封印,两路兜底)。
  - `GET …/state?sessionId=…`:回報 `{ pending, ranges }`,供客戶端 attach 時重建。
- **Edit 提交時機**:在 `agent/pre-step` 瀑布中,待編輯會話有新輸入訊息進入步驟時,封印 `[targetSeq, 當前日誌末尾]`——新訊息在其後追加,不受影響。此設計自動吸收打斷後的非同步殘留事件。
- **模型側截斷**:patch 該 session 的 `deriveMessages()`,按 ranges 過濾 surface 節點(帶簽名快取)。請求構建等所有讀取方走同一入口,天然一致;插件卸載時解除 patch。
- **稽核與持久化**:每次狀態變更 append 一筆 `hook/invoked` 事件(payload 含 `source: 'message-edit'`、phase、targetSeq、區間)。此類型在 rc.7 為已知保留類型(無原生讀寫方),重載安全;重啟後由核心模組重放重建,ranges 存活、未完成的 pending edit 丟棄(其文字框草稿本就存於前端)。

### 客戶端半

- `inject = ['slots', 'conversation']`。
- 以 priority `-1` 接管 `conversation.chat.node` 的 `user` 與 `steering` 渲染器(slot 系統原生遮蔽機制),行內復原原生氣泡外觀(文字、時間戳、複製鈕),追加鉛筆與 ↺ 懸停動作(rc.7 無 `conversation.chat.user-actions` slot,故採接管式)。
- **編輯模式**:氣泡原地換成 `<textarea>` + 傳送/取消;按傳送 → `POST /mark` → 呼叫 `conversation.send(新文字)` 程式化發送(**不經過 composer 草稿**,故不覆蓋使用者正在打的草稿)→ 關閉文字框。
- **附件訊息**:偵測 content 含非文字區塊即隱藏編輯鈕(v1 決策),undo 鈕照常。
- **UI 隱藏**:對聊天列的 `data-chat-flow-key` 動態發佈 `display:none` 樣式;pending 期間以上限錨點排除「已存在但錨定晚於標記」的節點誤判;attach 時以 `/state` 同步,切換會話即還原。
- i18n:依 `navigator.language` 提供中/英文案。

### 工程形式

- 純 JavaScript ESM + JSDoc,**零 npm 依賴、零建置步驟**;主機半直接被 Node 載入,客戶端半為單檔傳統腳本經外殼凍結模組表取用 `react` 與 UI primitives,HMR 即存即用。
- 打包:`package.json` 宣告 `dsh.bundle.patch`(cordis.patch.yml 插入主機插件列)+ `dsh.client`(platform web,匯出 `./client`);`dsh plugin --profile web add <目錄>` 安裝。
- 從零重寫,僅參考 XSJUSTC/dsh-rewind(MIT)的架構概念,不複用其程式碼。

## Testing Decisions(測試決策)

- **原則**:只測外部可觀察行為,不測實作細節;核心模組因其純函式特性天然可隔離測試。
- **核心模組 — node:test 單元測試**(Node 內建 test runner,零新增依賴):
  - 狀態機轉移:mark → commit-edit、mark → cancel、undo 直接封印、非法順序的拒絕。
  - 合法性裁決:非 user 類目標拒絕、落入既有隱藏區間的目標拒絕。
  - 事件重放:任意稽核事件序列重建出一致的 `{ pending, ranges }`;含「跨重啟丟棄 stale pending」案例。
  - 過濾謂詞:區間邊界(含/不含端點)、多區間累疊。
- **主機半/客戶端半 — 手工驗證清單**(安裝至 `web` profile 實測):編輯、取消、undo、執行中打斷、steering 訊息、附件訊息按鈕遮蔽、重新整理/重啟後隱藏存活、切換會話、模型上下文確實截斷(以簡單事實型問答驗證模型看不到已移除內容)。
- Prior art:本專案無既有測試;node:test 為 Node 20+ 內建,符合零依賴原則。

## Out of Scope(不在範圍)

- **工作區檔案還原**:agent 工具改動過的檔案一律不動(不做 git 快照/diff/還原引擎)。
- **版本歷史**:無 Gemini 式 `< 1/2 >` 草稿版本切換。
- **復原入口**:編輯/undo 生效後不提供任何 UI 層級的還原或 redo。
- **附件訊息的編輯**(v1):僅支援 undo;帶圖片帶入新訊息留待未來。
- **assistant 訊息的操作**:僅使用者訊息(含 steering)可編輯/undo。
- **CLI / headless 介面**:僅 Web GUI;終端介面不提供等效操作。
- **軌跡(trajectory)檢視**:不套用隱藏;審計請直接查看會話 JSONL 日誌。
- **compaction 深度整合**:未特別處理與上下文壓縮的互動(見 Further Notes 風險)。

## Further Notes(補充)

- **靈感來源**:架構概念參考 [XSJUSTC/dsh-rewind](https://github.com/XSJUSTC/dsh-rewind)(MIT)、[Anionex/dsh-turn-rewind](https://github.com/Anionex/dsh-turn-rewind)、[LingLambda/dsh-undo](https://github.com/LingLambda/dsh-undo);程式碼全新撰寫。
- **rc.7 能力邊界**:無 `surface/rewind`/`surface/restore` 持久化事件、無 `conversation.chat.user-actions` slot,故採 `hook/invoked` 稽核事件 + slot priority 遮蔽的替代方案;未來 Harness 若內建相關能力,可遷移。
- **已知限制**:被移除內容僅能從 JSONL 日誌人工稽核,無 UI 入口找回;undo 打斷後至封印前的極短窗口內,理論上可能出現短暫可見的殘留事件(封印時一併吞入)。
- **待實作期間驗證的風險**:`deriveMessages()` patch 與 compaction 的先後關係——若壓縮讀取亦經過同一入口則天然一致,否則需評估隱藏區間先於壓縮生效的策略。
- **未來方向**:附件訊息編輯(圖片帶入)、版本樹、暫時性還原提示條、CLI 支援。
