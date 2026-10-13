# Codex 與 repo 移轉建議

狀態：草擬；尚未建立或推送遠端 repo。

## 建議
現在開始採用正式 Git repo。Codex 負責程式開發、除錯、測試與改版；Claude／Gemini 仍可作實驗中的決策代理，兩者不衝突。HTML 保留為使用者操作介面與版本產物，原始碼以 repo 為準。

## 先保留、再拆分
以現行原始碼建立 V6.1 原型版本標記，不重寫已可用功能。標記為 baseline 不代表五回合已驗收。後續分工：
- ui：分頁操作與顯示。
- simulator：設備物理與影像產生。
- observation：相機標記／物件觀測與可信度。
- drivers：通訊契約、生成模組及隔離執行。
- agents：LLM 決策、記憶、恢復與模型介面。
- controllers：固定基線與待研究控制器。
- evaluation：隔離真值、成功判定與分析。
- experiments：情境、分割、設定與預算。
- tests：短回歸、模擬模型測試、完整系統測試分開。
- _research：狀態、貢獻、協定、宣稱與文獻。

## 管理流程
1. 每個變更綁定 issue、分支與可審閱 diff；先跑相關短測試，較大改版再跑完整驗證。
2. 自動測試預設不呼叫付費 API。真實模型與實體測試分開觸發並記錄預算。
3. 每筆實驗附 commit、模型完整 ID、prompt／driver hash、seed、情境、預算及完整失敗紀錄。
4. 大型原始影像與報告另存資料儲存區，repo 保存不可變 manifest、雜湊及小型代表案例。
5. API key 不進 repo；只保存環境變數名稱與不含祕密的 .env.example。
6. 新工作階段先讀 README、AGENTS.md 與 _research/STATE.md，減少依賴長對話。
7. 程式授權、資料授權與公開時間由作者決定；初期可用私人 repo。
8. 先完成 V6.1 五回合實測，再增加影像、通訊、運動映射故障的分層測試。

## 尚需定案
repo 名稱候選：dof-device-agent。尚未確認名稱、可見性、帳號與公開授權；本輪不建立遠端倉庫。

