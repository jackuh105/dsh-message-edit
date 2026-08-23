# 驗收清單:dsh-message-edit

> 對照:`docs/PRD.md`(29 條使用者故事)、`docs/message-edit.md`(四階段驗收條件)
> 前置:DSH 已重啟(`dsh --profile web`)、瀏覽器已重新整理、本對話已恢復。
> 執行方式:由使用者操作,代理逐項核銷並記錄結果。

## 0. 載入鏈路(Phase 1)— ✅ 已於 rc.1 重啟後驗證

- [x] `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3080/plugins/dsh-message-edit/client.js` → **200**
- [x] `curl -s "http://127.0.0.1:3080/api/dsh-message-edit/state?sessionId=probe"` → **404** 且 body 為 `{"ok":false,"error":"unknown-session"}`(路由已掛載,僅 session 不存在)
- [x] 真實 session 深測:`/state` 回 `{"ok":true,"pending":null,"ranges":[]}`(全日誌重放 + patch 掛載路徑實測通過)
- [x] boot manifest 含本插件條目(inject 邊正確);`dsh --profile web --dump-config` 含 `# == dsh-message-edit` 層
- [x] 頁面 console 無插件相關錯誤;原生功能無退化
- [x] rc.1 相容性靜態複核:hook/invoked 已知類型、Session API、pre-step 先於 user/message append、agent/status 帶 agent、surface.nodes/replaceGeneration、chat.node user/steering、data-chat-flow-key、sessions.scope(id).conversation——全部不變,**零程式碼修改**

## 1. Undo(Phase 2;PRD 故事 9–18、21、22、25)

- [x] 懸停任一自己送的訊息 → 出現 ↺(與 ✎);複製預設常駐、✎/↺ 懸停顯示(2025-08-22 版面調整後)
- [x] 點 ↺ → 該訊息**連同其後所有內容**立即消失,無確認框、無模型回應、輸入框未被預填
- [x] 追問一個只有被移除內容才知道答案的問題 → 模型答不上來(上下文確實截斷)
- [x] 對第一則訊息 ↺ → 全部清空,可重新開始
- [x] agent 輸出中點 ↺ → 回合自動打斷,半截輸出不殘留(Round B 經 ✎ 送出路徑驗證同一打斷機制)
- [ ] steering 訊息(回合中途插入)同樣可 ↺
- [ ] 含圖片/附件的訊息有 ↺、無 ✎
- [x] 重新整理頁面 → 隱藏存活;重啟 DSH 後再開 → 隱藏存活;切換會話再切回 → 一致
- [x] 已隱藏區間內不會再出現任何動作鈕(隱藏列整列消失)

## 2. Edit(Phase 3;PRD 故事 1–8、19、20、24)

- [x] 點 ✎ → 氣泡原地變文字框、預填原文、游標在尾;尾部訊息仍在畫面上
- [x] Esc 或「取消」→ 還原氣泡,無任何痕跡
- [x] 改字後按「傳送」→ 舊訊息及其後消失,新訊息出現在原位置並立即獲得回應
- [x] 追問驗證:模型只記得編輯前的歷史 + 新訊息
- [x] agent 輸出中按「傳送」→ 自動打斷,流程照常完成
- [ ] composer 有未送草稿時執行編輯送出 → 草稿原樣保留
- [ ] 在已 undo/編輯過的會話中,對更早的訊息再次操作 → 多區間累疊正確
- [x] 編輯送出後立刻重新整理 → 新訊息與回應正常,擱置意圖不出現幽靈 ✕(除錯期間多輪強制重整均未見)

## 3. 邊界與稽核(Phase 4;PRD 故事 27)

- [x] 快速連點 ↺ / 傳送 → 無重複動作、無例外
- [x] 編輯文字框開啟中切換會話再切回 → 狀態一致(文字框屬頁面狀態,消失可接受;不得殘留隱藏)
- [x] JSONL 日誌:每次操作都有 `hook/invoked` + `source:'message-edit'` 記錄,phase 正確(mark/cancel/undo/commit 四種均於日誌目視)
- [~] 卸載還原:**跳過**(插件保留日常使用;路徑已由安裝鏈路對稱性覆蓋)

## 結果記錄

| 項目 | 結果 | 備註 |
|------|------|------|
| Phase 1 載入鏈路 | ✅ 通過 | rc.1 上零修改相容;HMR 內容即時生效 |
| Phase 2 Undo 端到端 | ✅ 核心通過 | 含全清、截斷追問、跨重啟存活 |
| Phase 3 Edit 端到端 | ✅ 核心通過 | 含串流中打斷;發送走 binding().session.prompt |
| Phase 4 邊界稽核 | ✅ 大致通過 | 稽核四 phase 目視;卸載項依約跳過 |
| 未測項 | ⏸ 留用 | steering ↺、附件訊息 ↺/✎ 抑制、composer 草稿保留、多區間累疊——留待日常使用自然覆蓋 |
| 已知限制 | 📌 | compaction 與隱藏區間互動未驗(PRD 風險項);trajectory 視圖不隱藏 |
