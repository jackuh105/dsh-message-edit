# dsh-message-edit

Gemini 式的訊息編輯與 Undo,適用於 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web GUI。

對話中每則你送出的訊息,懸停時會出現兩個動作(在複製鈕旁):

- **✎ 編輯**:氣泡原地變成可編輯文字框(預填原文,附「傳送 / 取消」,Esc 取消)。按「傳送」那一刻,該訊息**本身及其後所有內容**自聊天畫面與模型上下文隱藏,編輯後的新訊息出現在原位置並獲得回應——對話看起來就像你當初就是這樣寫的。
- **↺ Undo**:立即移除該訊息**本身及其後所有內容**,對話回到該訊息發送前的狀態;不觸發模型回應、不預填文字、無確認框。

底層保證:

- Session 日誌維持 **append-only**,原始事件永不刪改;每次狀態變更附帶一筆可稽核記錄。
- 已封印的隱藏區間**跨頁面重新整理與 DSH 進程重啟**持續生效。
- Agent 正在輸出時操作,自動打斷當前回合,半截輸出一併吞入隱藏範圍。

> **平台相容性**:rc.1/rc.2 的客戶端合約變更(同步 require 與 `external` 邊、inject 守衛、attachment 元件導出移除)詳見 [`docs/compatibility.md`](docs/compatibility.md)。

## 安裝 / 卸載

```sh
# 安裝(路徑指向本專案目錄)
dsh plugin --profile web add /path/to/dsh-message-edit

# 重啟 DSH 並重新整理瀏覽器頁面

# 卸載
dsh plugin --profile web remove dsh-message-edit
# 重啟 DSH。日誌中的稽核記錄無害保留。
```

零 npm 依賴、零建置步驟;複製本目錄到任何機器即可安裝。

## 使用方式

1. 懸停任一你送出的訊息(含回合中途插入的 steering 訊息)。
2. 點 **✎** 原地修改文字,按「傳送」;或點 **↺** 直接收回該訊息及其後一切。
3. 含圖片/附件的訊息僅提供 **↺**(v1 不支援編輯附件訊息)。
4. 編輯送出失敗時,文字框會保留並顯示錯誤,可重試或取消;若編輯意圖擱置超過幾秒(如送出後重新整理頁面),輸入框右側會出現 ✕ 讓你取消該意圖。

## 驗證模型上下文確實截斷

對某訊息 ↺ 之後,問模型一個只有被移除內容才知道答案的問題——它應答不上來。

## 已知限制

- **軌跡(trajectory)檢視不套用隱藏**;審計請直接查看會話 JSONL 日誌。
- **無復原入口**:編輯/undo 生效後,UI 層級不可找回(日誌底層保留原始事件)。
- **附件訊息不可編輯**(僅可 undo);圖片帶入新訊息為未來方向。
- **排隊中(未送達)的訊息**:undo/編輯隱藏其在日誌中的事件,但 agent inbox 中已排隊的副本仍可能於後續回合送達(與社群 dsh-rewind 相同語意)。
- 僅支援 Web GUI;CLI / headless 介面不提供等效操作。

## 稽核

會話 JSONL 日誌中,本插件附加的事件皆為 `hook/invoked` 類型,payload 帶 `source: 'message-edit'`:

```
{ source: 'message-edit', phase: 'mark',   targetSeq, preview }   // 編輯意圖
{ source: 'message-edit', phase: 'cancel', targetSeq }              // 意圖取消
{ source: 'message-edit', phase: 'undo',   targetSeq }              // 回退意圖
{ source: 'message-edit', phase: 'commit', targetSeq, hiddenFrom, hiddenTo } // 區間封印
```

`hiddenFrom`–`hiddenTo` 即對模型與聊天視圖隱藏的事件區間(含端點)。

## 架構

三模組切分(見 `docs/PRD.md` 與 `docs/message-edit.md`):

- `lib/core.js` — 純狀態機:意圖規劃(mark/cancel/undo/commit)、稽核事件折疊、重放重建、區間謂詞;零依賴零 I/O,`node --test "test/**/*.test.js"` 覆蓋。
- `lib/index.js` — 主機半:HTTP API(`/api/dsh-message-edit/{mark,undo,cancel,state}`)、`deriveMessages()` 遮罩、打斷與封印時序(pre-step 瀑布 + agent/status 靜止封印 + 重啟重放對帳)。
- `lib/client.js` — 客戶端半:priority `-1` 接管 `user`/`steering` 聊天節點渲染、內聯編輯器、CSS 隱藏、經 `sessions.scope(id).conversation.send()` 程式化發送(不碰 composer 草稿)。

## 致謝

架構概念參考 [XSJUSTC/dsh-rewind](https://github.com/XSJUSTC/dsh-rewind)(MIT)、[Anionex/dsh-turn-rewind](https://github.com/Anionex/dsh-turn-rewind)、[LingLambda/dsh-undo](https://github.com/LingLambda/dsh-undo);程式碼全新撰寫。

## License

MIT
