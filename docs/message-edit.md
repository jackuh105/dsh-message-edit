# Plan:dsh-message-edit

> Source PRD:`docs/PRD.md`(v1,已與需求方達成共識)

## Architectural decisions(持久架構決策)

所有階段共用,階段內不得偏離;若實作中發現必須偏離,先回報再改。

- **套件與安裝**:套件名 `dsh-message-edit`;`package.json` 宣告 `dsh.bundle.patch`(cordis.patch.yml 插入主機插件列)與 `dsh.client { platform: 'web' }`(匯出 `./client`);以 `dsh plugin --profile web add <專案目錄>` 安裝,`remove` 卸載。純 ESM JavaScript + JSDoc,零 npm 依賴、零建置步驟。
- **HTTP 路由**(主機半以 exact 方式掛載):
  - `POST /api/dsh-message-edit/mark` — 編輯意圖(body:`{ sessionId, seq, preview }`)
  - `POST /api/dsh-message-edit/undo` — 立即回退(body:`{ sessionId, seq }`)
  - `GET /api/dsh-message-edit/state?sessionId=…` — 狀態查詢
- **稽核事件線格式**:每次狀態變更 append 一筆 `hook/invoked` 事件,payload `{ source: 'message-edit', phase: 'mark' | 'cancel' | 'commit' | 'undo', targetSeq?, hiddenFrom?, hiddenTo?, preview? }`;日誌 append-only,永不刪改原始事件。
- **狀態形狀**(主機與客戶端共用語意):`{ pending: { targetSeq, markSeq } | null, ranges: [{ start, end }] }`;已封印 ranges 跨頁面重整與進程重啟存活(事件重放重建),未完成的 pending 於重放時丟棄。
- **模組邊界**:核心模組(隱藏區間狀態機 + 區間過濾謂詞 + 事件重放;純函式、零依賴、零 I/O)← 主機半(inject:`webServer, sessions,agents`;呼叫核心)← 客戶端半(inject:`slots, conversation`;僅 UI,不含業務規則)。
- **模型側截斷**:patch 該 session 的 `deriveMessages()`,按 ranges 過濾 surface 節點(帶簽名快取);插件卸載時解除 patch。
- **UI 掛點**:以 priority `-1` 遮蔽接管 `conversation.chat.node` 的 `user` 與 `steering` 渲染器,行內復原原生氣泡外觀並追加動作鈕;聊天列隱藏以 `data-chat-flow-key` + 動態 `display:none` 樣式實現。
- **發送路徑**:編輯送出呼叫 `conversation.send(新文字)`,完全不經過 composer 草稿。
- **打斷方式**:agent 執行中時 `cancel({ kind: 'user' }, { keepInbox: true })`。
- **Host 校驗**:目標 seq 必須是 user 類訊息(否則 400)、不得位於既有隱藏區間內(否則 409)、session 必須存在(否則 404)。
- **測試**:核心模組以 Node 內建 `node:test` 做單元測試;主機半/客戶端半以手工驗證清單覆蓋。

---

## Phase 1:骨架與安裝鏈路(tracer bullet)

**User stories**:26(以 `dsh plugin` 安裝/卸載)、29(零依賴零建置形式的實證)

### What to build

打通「打包 → 主機載入 → 客戶端 bundle 服務 → HMR → 卸載」的完整管線,不含任何業務行為:

- 建立套件骨架:package.json(bundle + client 宣告)、cordis.patch.yml(插入主機插件列)、主機半進入點(inject 三服務,掛載 `/state` 路由回傳空狀態 `{ pending: null, ranges: [] }`)、客戶端半進入點(經模組載入器註冊,掛載階段僅在 console 留下載入標記,不改變任何原生 UI)。
- 安裝進 `web` profile 並重啟,驗證:`--dump-config` 出現本插件層;頁面正常啟動且 console 顯示載入標記;`GET /state` 回 200;改動客戶端檔案觸發 HMR 重載;`remove` + 重啟後完全還原。

### Acceptance criteria

- [ ] `dsh --profile web --dump-config` 輸出含本插件的層標記
- [ ] Web GUI 正常啟動,console 出現插件載入標記,原生功能無任何退化
- [ ] `GET /api/dsh-message-edit/state?sessionId=<有效id>` 回 `{ ok: true, pending: null, ranges: [] }`
- [ ] 修改客戶端檔案後重新整理頁面,新標記生效(HMR 鏈路通)
- [ ] `dsh plugin --profile web remove` + 重啟後,GUI 恢復無插件狀態

---

## Phase 2:Undo 端到端

**User stories**:9、10、11、12、13(undo 語意與零摩擦)、14、15(自動打斷與殘留吸收)、16、17(steering 與附件訊息可 undo)、18(隱藏區間內不出現動作鈕)、21、22(重整/重啟存活)、25(切換會話狀態正確)

### What to build

交付第一個完整可示範行為:「一鍵收回任何使用者訊息及其後的一切,模型與畫面同步失憶,且持久」。

- 核心模組:undo 語意的狀態機(目標校驗、`[targetSeq, 日誌末尾]` 封印、多區間累疊)、區間過濾謂詞、稽核事件重放;node:test 覆蓋轉移、拒絕、重放、邊界。
- 主機半:`/undo` 路由(校驗 → 打斷執行中回合 → 封印時序:回合靜止後封印,若使用者立刻再發送則由 pre-step 兜底封印);`/state` 回報真實狀態;`deriveMessages()` patch 上線(含卸載解除)。
- 客戶端半:`user`/`steering` 列的 ↺ 懸停動作鈕(含附件訊息;位於隱藏區間內的列不渲染任何動作鈕);點擊即生效、無確認框;`data-chat-flow-key` CSS 隱藏;attach 時以 `/state` 同步;切換會話還原。
- 中英文案隨此階段的 UI 一併引入。

### Acceptance criteria

- [ ] 對任意使用者訊息(含 steering、含附件訊息)點 ↺:該訊息本身及其後所有內容自畫面消失,無確認框
- [ ] undo 後立即詢問模型僅存歷史相關事實,回答證明被移除內容不在上下文中
- [ ] agent 輸出中點 ↺:當前回合被打斷,半截輸出不殘留於畫面或上下文
- [ ] undo 後不觸發任何模型回應、不預填輸入框;直接輸入新訊息可正常續聊
- [ ] 對第一條訊息 undo → 對話清空,可重新開始
- [ ] 重新整理頁面、重啟 DSH 進程、切換會話再切回:隱藏狀態一致
- [ ] 已隱藏區間內的訊息列不出現任何動作鈕;多次 undo 的區間正確累疊
- [ ] 核心模組 node:test 全綠(undo 路徑:轉移/拒絕/重放/邊界)

---

## Phase 3:Edit 端到端

**User stories**:1–8(內聯編輯全流程)、19(多輪修正累疊)、20(不干擾 composer 草稿)、24(中英文介面)

### What to build

交付 Gemini 式原處改寫:「氣泡原地變文字框,送出那一刻舊分支整段隱藏,新訊息出現在原位置並獲得回應」。

- 核心模組:mark / cancel / commit-edit 轉移、合法性裁決(目標必須 user 類、不得在既有隱藏區間內)、重放時丟棄跨重啟的 stale pending;node:test 補齊 edit 路徑。
- 主機半:`/mark` 路由(校驗 → append 稽核 → 打斷執行中回合);edit 提交掛進 `agent/pre-step` 瀑布——待編輯會話的新輸入訊息進入步驟時封印 `[targetSeq, 當前日誌末尾]`,新訊息在其後追加。
- 客戶端半:懸停鉛筆鈕(附件訊息隱藏編輯鈕、僅留 undo);點擊後氣泡原地換成預填原文的 `<textarea>` + 傳送/取消鈕,Esc=取消;編輯期間聊天尾部保持可見;取消不留痕跡;傳送 = `POST /mark` → `conversation.send(新文字)` → 關閉文字框;全程不讀寫 composer 草稿。

### Acceptance criteria

- [ ] 點鉛筆 → 氣泡原地變預填文字框,尾部訊息仍在畫面上;Esc 或「取消」關閉且無任何狀態殘留
- [ ] 修改後按「傳送」:舊訊息及其後全部消失,新訊息出現在原位置並立即獲得模型回應
- [ ] 送出後詢問模型,回答證明只看得到編輯前的歷史 + 新訊息
- [ ] agent 輸出中按「傳送」:回合自動打斷,流程照常完成
- [ ] 含圖片/附件的訊息只顯示 undo 鈕,不顯示鉛筆
- [ ] 編輯送出時,composer 既有草稿原樣保留
- [ ] 在已 undo/已編輯過的對話中再次編輯更早的訊息,多區間累疊行為正確
- [ ] 重新整理後未送出的編輯文字框消失(pending 丟棄),已封印編輯不受影響
- [ ] 核心模組 node:test 全綠(edit 路徑:mark/cancel/commit、stale pending 丟棄)

---

## Phase 4:驗收、邊界強化與文件

**User stories**:27(稽核可追溯)及全部 29 條故事的最終驗收

### What to build

- 邊界掃描與強化:快速連點動作鈕的防護;pending 編輯中切換會話/觸發 undo 的狀態一致性;`/state` 對無效 session 的錯誤回應;主機端對重放異常日誌的容錯。
- 執行完整手工驗收清單,逐條對照 PRD 的 29 條使用者故事,記錄結果。
- README:功能簡介、安裝/卸載、使用方式(含截圖位)、已知限制(軌跡檢視不隱藏、無復原入口、附件編輯未支援)、稽核說明(JSONL 日誌位置與 `source: 'message-edit'` 事件格式)、靈感來源致謝。

### Acceptance criteria

- [ ] 連點/切換會話/pending 交叉操作均無不一致狀態或未捕捉例外
- [ ] 手工驗收清單全數通過,29 條使用者故事逐條核銷
- [ ] JSONL 日誌中可依 `source: 'message-edit'` 完整追溯每次 mark/cancel/commit/undo
- [ ] README 完整涵蓋安裝、使用、限制、稽核、致謝;專案可交付
