# 平台相容性備忘:DSH 版本合約變更

本插件以「陰影宿主行為」方式運作,對客戶端合約敏感。以下為實測踩到的版本差異與對應策略,供日後升級排查。

## 0.1.1-rc.2

### ui-attachment 移除 React 元件導出

`@deepseek-ai/dsh-client-ui-attachment` 不再於套件值上導出元件(`ImageGallery` 等),僅剩 `exports.apply/inject`;圖片展示改由 `conversation.message.images` 槽位(session scope)承擔。

**症狀**:對 `UiAttachment.ImageGallery` 的存取得 `undefined` → 含圖訊息渲染時拋 React #130(element type undefined)→ 條目被錯誤邊界棄位 → **該會話所有 ✎↺ 按鈕消失**(純文字會話不受影響,故呈現「時好時壞」)。

**修法**:不依賴 attachment 套件值;使用宿主經 ownerProps 遞進的 `props.renderMessageImages({ images, align })`(即 ChatView 的同一渲染器)。外部依賴僅剩 `react` 與 `ui-primitives`。

**診斷技巧**:槽位錯誤邊界只回報 slot 名與 minified 錯誤。兩件工具可在一次重現內定位:`window.__dmeRenders` 渲染計數器(證明己方條目有無被選上)、包住 `createElement` 的型別哨兵(stack 直接指向呼叫行號)。

## 0.1.1-rc.1

### 同步 require 與送達順序

客戶端 `require` 為同步;`dsh.client.inject` 僅供服務等待,**不約束腳本送達**;`dsh.client.external` 邊才約束(依賴腳本須先到,圖譜按此拓撲排序)。缺邊時同步 require 拋 `missed the module table`,並**阻塞整個 GUI 啟動**。

**修法**:宣告 `dsh.client.external`(react、ui-primitives、ui-attachment);工廠內 try/catch + 降級 shim 保底,確保永不阻塞啟動。

### 其他契約點

- `@deepseek-ai/dsh-client-ui-slots` 套件移除,slots 服務併入 `dsh-client-runtime`(種子詞仍可用)。
- cordis 內容代理守衛:自插件 fiber 對**作用域 ctx** 存取未注入屬性拋 `cannot get property "X" without inject`(如 `.conversation`)。跨會話發送應走 `sessions.binding(id).session.prompt([{type:'text',text}], 'queue')`——`conversation.send` 的內部同一呼叫,且為官方認可的同步路徑。
- keyed 槽選舉:同 key 取首個符合條目(`entriesOfSlot` 按 cell 優先序);動態 runner 對非 chain 註冊強制覆寫 priority(全域遞減配置,低者勝)。
- UI 狀態需在首次 fetch 前提供凍結空快照:`useSyncExternalStore` 的 getSnapshot 回傳 undefined 會使元件崩潰並觸發棄位。

## 排查流程備忘

1. 先分「沒被選上」還是「選上了但崩潰」:渲染計數器 + `.dme-bubble` 數量 + `[data-slot-error]` 錨點。
2. 型別哨兵包 `createElement`:undefined 型別的 stack 直指行號,一次重現定案。
3. 升級後先用純文字新會話驗基線,再用含圖/舊格式會話掃邊角——**新舊會話差異往往掩蓋真因**。
