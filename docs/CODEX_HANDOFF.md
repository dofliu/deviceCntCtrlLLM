# V6.3 → Codex / Git repo 移交

移交日期：2026-10-12（Asia/Taipei）。版本：V6.3 / 0.6.3。
這是開發版本快照；尚未初始化或推送 Git repo，也沒有新增完整五回合驗收結果。

## 目標與目前能力

目標分成兩部分：接手原本不了解的設備，取得可驗證的控制能力；取得控制能力後執行桌面整理任務。
目前使用虛擬 2R 手臂、已知升降／夾爪介面與單相機標記觀測。
完整流程包含外觀假設、查閱手冊、判斷端點、連線握手、生成通訊驅動、隔離測試、XY 試動校正、取放及影像驗證。
五回合使用同一設備，物件／目標改位，B 高度依序 0 / 0.35 / 0.65 / 0.35 / 0；後續回合重做連線確認，沿用驅動並視誤差重新校正。

## 從這個交付包開始

1. 解壓縮後，以 `virtual-device-v6.3` 為專案根目錄。
2. 直接開啟根目錄的 `unknown-device-v6.3.html` 可操作預設離線模式；這不會呼叫付費模型。
3. 使用 Python 3 執行 `python build.py` 可重建相同版本頁面。日常啟動與建置只使用 Python 標準函式庫。
4. Claude 用 `start-lab.cmd`；Gemini 用 `start-gemini.cmd`。橋接提供本機同源頁面；Claude 預設 port 8766，Gemini 預設 8767。
5. Claude 預設取 `ANTHROPIC_API_KEY`，另可指定 `--key-env ANTHROPIC_API_KEY_Extra`。Gemini 使用 `gemini_api_key`，啟動器允許找不到時隱藏輸入。
6. `.env.example` 只說明變數名稱，橋接沒有自動讀取 `.env` 的功能。不要把真實 key 寫入此包或提交到 repo。
7. UI 選擇代理／可用模型、套用設定後開始。模型清單以帳戶即時可用結果為準，不把舊模型名稱寫死為建議值。

詳細操作見 `README.md`、`docs/claude.md` 與 `docs/gemini.md`。

## 主要程式位置

| 檔案 | 職責 |
|---|---|
| `src/app.js`、`src/index.template.html`、`src/styles.css` | 分頁操作、等待倒數、設定與紀錄 |
| `src/plant.js`、`src/scene3d.js` | 模擬設備與 3D 展示 |
| `src/agent-core.js`、`src/controller.js` | 影像觀測與預寫控制基線 |
| `src/device-link.js`、`src/driver-runtime.js` | 通訊契約、ACK、隔離驅動執行與逾時診斷 |
| `src/onboarding.js`、`src/pick-place.js`、`src/engine.js` | 接手設備、連續任務、預算與狀態管理 |
| `src/claude-provider.js`、`src/gemini-provider.js` | 模型介面、請求間隔、429 冷卻與診斷 |
| `claude_bridge.py`、`gemini_bridge.py` | 本機 API 橋接、呼叫上限、錯誤摘要 |
| `tests/`、`validation/` | 測試程式與既有結果；結果各自有版本／範圍 |
| `_research/` | 貢獻、文獻、實驗草案、宣稱界線及研究狀態 |

共享模型排程器目前定義在 `claude-provider.js` 並由 Gemini 使用；維持目前模板的載入順序。

## V6.3 新增

- 兩次模型請求開始預設至少相隔 6 秒，可調 0–120 秒；AI 回覆已超過間隔時不補等。
- 暫時性 429 最多重試 2 次；優先採服務端等待提示，無提示時 30、60 秒。要求超過 180 秒則停止。
- 每次真正送出的請求都計次；日／月支出／零配額與本機呼叫預算不足不作短期重試。
- 固定等待與冷卻不計入 45 秒 HTTP 請求逾時；UI 分開呈現倒數與等待回覆。
- 暫停是「本步後暫停」，不是立即中止目前請求。取消排程／請求的底層能力與 UI 暫停語意不同。
- 保留 V6.2 的 Worker 啟動／執行逾時拆分，以及只在未送命令前進行的有限啟動恢復。

## 接手後工作順序

1. 先建立 Git 基準提交，保留這份移交版本及未完成驗證標記；不要把標籤解釋成驗收成功。
2. 在新環境執行 `docs/VALIDATION_STATUS.md` 列出的最小聚焦測試，補上最後三個修正的正式結果。
3. 瀏覽器檢查分頁、6 秒等待、429 冷卻、暫停與 JSON 匯出；使用 mock API 先驗證。
4. 再以使用者選定的 Claude 或 Gemini 執行一次完整五回合，保留完整 JSON、實際模型 ID、版本／commit、seed、預算與失敗點。
5. 驗收重點是五回合都有獨立取放與穩定性證據；若失敗，區分影像／控制／驅動／API／預算，不要統一歸為 AI 失敗。
6. 五回合穩定後，再做跨工作站、選擇性重校正與控制程式生成的比較實驗。

## 建立 repo

候選名稱 `dof-device-agent`；建議先私人 repo，公開授權尚未由作者決定。本次沒有建立遠端 repo。
可先在本機（新解壓目錄）執行：

```powershell
git init -b main
git add .
git diff --cached --stat
git diff --cached --check
```

檢查 `git status`，確認不含 API key、生成 HTML、ZIP、大型匯出或本機暫存，再由作者選定 GitHub 帳號／repo／可見性後建立遠端並推送。
既有 `.gitignore` 已排除常見本機與生成檔案；仍須人工核對 staged 清單。
確認 staged 清單後才提交：`git commit -m "chore: import V6.3 development handoff"`。
原始碼是維護來源；HTML 可作為版本發布附件。第三方 Three.js 授權必須隨原始碼保留，見 `vendor/THREE-LICENSE.txt`。

## 給下一個 Codex 工作階段的起始指令

> 接手本目錄的 V6.3 陌生設備控制實驗。先讀 AGENTS.md、README.md、docs/CODEX_HANDOFF.md、docs/VALIDATION_STATUS.md 與 _research/STATE.md。保留現有架構與成功門檻，先核對 Git 狀態並完成基準提交，再補最終聚焦測試與瀏覽器 mock 驗證。不要把既有歷史測試當成本版五回合成功，也不要自行呼叫付費模型或讀出金鑰。列出驗證差異後，接續完成同設備五回合取放與診斷。
