> V6.3 連續五回合請使用新版啟動器；CLI 橋接預設整場上限 500，設定頁可降低前端上限。已知升降會停在當地支撐面，尚未學習未知 Z 軸。

# Claude 連接與取放實驗

Claude 模式使用 Anthropic Messages API。每次決策包含一張原始相機 PNG，以及目前允許代理知道的文件、通訊回覆、影像量測與先前動作結果。Claude 選擇工具；主程式檢查工具及參數後才執行。每次回覆須恰好包含一個有效的 `tool_use`。純文字、平行工具、越界參數或截斷回覆都不會執行，也不會悄悄改用離線策略。

## 本機橋接啟動

建議使用 Python 橋接，讓 API 金鑰留在本機程序：

1. 解壓縮 HTML 內提供的原始碼 ZIP。
2. 執行 `python build.py` 建立 `unknown-device-v6.3.html`，或將已下載的 HTML 放在 `claude_bridge.py` 同一個資料夾。
3. 確認電腦已設定本次授權的 **`ANTHROPIC_API_KEY`**。
4. 在該資料夾執行 `python claude_bridge.py`。
5. 用 Chrome 或 Edge 開啟 **http://127.0.0.1:8766/**。
6. 在介面選擇 Claude、本機橋接，讀取帳戶可用模型清單，再開始實驗。

Windows 可直接雙擊原始碼套件內的 `start-lab.cmd`；它會先依目前原始碼重新建立 HTML，成功後才啟動本機橋接並開啟瀏覽器，避免更新原始碼後仍開到舊介面。手動啟動也可使用 `python claude_bridge.py --open-browser`。

橋接預設只讀 `ANTHROPIC_API_KEY`：先讀程序環境變數，Windows 再讀同名的使用者與系統環境變數。若要使用先前已授權的另一個名稱，必須明確指定：

```text
python claude_bridge.py --key-env ANTHROPIC_API_KEY_Extra
```

`--key-env` 只接受這兩個已授權名稱，不搜尋金鑰檔案，也不自動切換金鑰。畫面上的橋接狀態只回傳名稱、是否存在與呼叫次數，不回傳金鑰內容。

瀏覽器不能直接讀取 Windows 環境變數。橋接模式必須由上述本機網址開啟，不能從 `file://` 呼叫本機金鑰。橋接僅監聽 `127.0.0.1`，檢查 Host、Origin、Fetch-Site 及自訂請求標頭，不開放跨來源；只提供實驗 HTML、狀態、模型清單與 Messages 路徑，沒有任意網址代理功能。

也可使用瀏覽器直接連線，在介面輸入自己的 Claude API 金鑰。金鑰只保存在目前頁面的記憶體，不寫入報告、下載檔、原始碼或瀏覽器儲存。重新整理後需重新輸入。

## 命令列批次實驗（不開網頁）

詳見 README 同名段落；摘要如下。

`run_experiments.py`（Python 標準函式庫）逐組呼叫 `tests/live_claude_v7.cjs`（Node），每組啟動本機橋接、跑完五回合、關閉橋接。需要 Python 3、Node.js，並先執行 `python build.py`。

```text
# 先離線確認流程（不呼叫 API、不花費）
python run_experiments.py --offline --devices P2,G3 --seeds 2026

# 真實 Claude：兩種設備 × 三個 seed，整批最多 600 次模型呼叫
python run_experiments.py --devices P2,G3 --seeds 2026,3140,8675 --model claude-haiku-5-5 --total-max-calls 600
```

- 預設條件與瀏覽器實驗相同：無範本、產生控制程式、5 回合、請求間隔 6 秒。可用 `--manual-template on`、`--controller-mode builtin`、`--repeat n`、`--max-calls-per-run n` 調整。
- 預算：每組有單組上限（預設 150），整批另有總上限；每次真正送出的請求都計入，用量不明時以單組上限扣除；剩餘額度不足 `--min-calls-to-start`（預設 60）就不再開始新的一組。真實模式開始前會要求輸入 `yes` 確認（`--yes` 可略過）。
- 金鑰：只由橋接讀取 `ANTHROPIC_API_KEY`（或 `--key-env ANTHROPIC_API_KEY_Extra`）；找不到時整批停止，沒有送出任何請求。
- 輸出：`artifacts/live-runs/batch-<時間>/`（不進 repo）內有每組 `*.summary.json`（數十 KB，含自產程式、步長、效率倍率、模擬器真值核對、git commit）、`*.full.json.gz`（完整紀錄壓縮檔），以及 `batch-summary.json`／`batch-summary.csv` 總表。分享時壓縮 summary 與 batch 檔即可。
- **與瀏覽器版的差異**：影像以軟體畫布繪製（無瀏覽器抗鋸齒），產生的程式在 Node vm 沙箱而非 iframe／Worker 執行。成功門檻、測試關卡與模型流程相同，但結果須與瀏覽器實驗分開記錄。

## 決策與動作的區分

V5.3 將 `expected`（預期結果說明）設為選填。省略時回傳 `expected:""` 與 `expectedProvided:false`，介面明確標示模型沒有提供這段說明；不代填模型預測。工具名稱、`args`、`reason` 與動作參數驗證維持不變。有提供 `expected` 時仍須是非空白、長度合法的字串。這項調整修正使用者 V5.2 實測中連續省略 `expected` 而停止的原因，不能據此宣稱已通過真正模型的完整取放。

前段工具處理外觀假設、介面清單、手冊、連線、握手、驅動程式編寫與測試。通過驅動測試後才進入取放控制。驅動程式會在隔離工作執行緒編譯、測試，並用於後續動作封包；畫面上的程式碼不是裝飾。

Claude 只取得影像與已觀測證據。介面的三維顯示與評估紀錄可使用模擬器真值，但不把隱藏的桿長、馬達方向、運動增益、關節座標或碰撞真值送給代理。物件位置與取放結果應由畫面觀察及已收到的通訊回覆判斷。

介面保留簡短的決策依據與預期結果，不要求或匯出模型內部思考。工具輸入有白名單及範圍檢查。V5.2 遇到 `INVALID_DECISION`、`INVALID_ARGUMENTS` 或 `INVALID_TOOL_RESPONSE` 時，拒絕該次回覆並顯示具體原因；保留連線、驅動與校正狀態，把錯誤回饋給 Claude，最多請它修正兩次。每次修正都計入請求上限，連續三次回覆不合法便停止。V6.3 另對可重試的 HTTP 429 加入有限次冷卻；其他 API 錯誤及設備執行狀態不明仍直接停止，不自動重送設備命令。

匯出紀錄會保留經過篩選的拒絕原因與修正次數，不保存完整被拒絕的回覆或任意文字。舊版 JSON 不能匯入接續執行；更新後須重新開始一次，之後才能在當次實驗內保留進度修正。

## 模型與用量

模型名稱取自當下帳戶 `/v1/models` 回覆；模型需支援影像與工具。系統不自動改換模型。`tool_choice` 預設為 `auto`，關閉平行工具；回覆端仍要求恰好一個有效工具。

前端五回合預設最多 500 次模型決策，單回合預設 80 次；橋接預設另有整場 500 次 Messages 上限，包含失敗的請求，模型清單查詢不計入。每次已送出的請求最多等待 45 秒；送出前的固定間隔及 429 冷卻分開計時。中止後不執行遲到的決策，但不代表供應商端尚未開始計費。可用 CLI 降低橋接上限，例如：

```text
python claude_bridge.py --max-calls 120
```

V6.2 另將通訊驅動的啟動與執行回覆等待分成各 5 秒；這與模型 API 的 45 秒上限不同。只有編碼階段尚未送出程式的啟動逾時，才重建工作執行緒重試一次。驅動不會因這項恢復而重送設備交換；解碼失敗時保留已收到的設備 ACK。完整診斷見匯出 JSON 的 `driverRuntime`。

## V6.3 請求間隔與冷卻

設定頁的「模型請求最短間隔」預設 6 秒，可設定 0–120 秒；0 表示停用固定間隔。它控制相鄰請求的開始時間，不是在每次回覆後再固定等待 6 秒，也與畫面播放速度分開。約每分鐘 10 次請求仍可能觸及帳號詞元量、每日額度等限制。

只有可重試的 HTTP 429 會等待後重試，最多 2 次；已知每日配額、費用上限或無可用配額直接停止。等待優先採服務端提示，沒有提示時依序為 30、60 秒。服務端要求單次等待超過 180 秒會停止並保留等待提示，不能以較短等待繞過限制。401／403、網路中斷及回覆逾時不會用這個機制自動重試。

介面會顯示請求間隔、限流冷卻或 AI 回覆等待的狀態與倒數。「本步後暫停」會讓已開始的決策步驟先完成；不會立即取消等待中的請求。重試仍計入前端及橋接原有的總請求上限，500 次上限不會因等待而自動重設。請下載新版原始碼並關閉、重開橋接，才能取得新版的等待提示轉送。

匯出 JSON 的 `modelRuntime` 記錄請求數、限流重試數、累計等待與最近 40 筆診斷。最終模型失敗另有 `modelDiagnostic`；`driverRuntime` 是獨立的本機驅動診斷，不等於 API rate limit。

## 驗證方式

```text
node tests/test_claude_provider.cjs
python tests/test_claude_bridge.py
```

上述兩組為模擬 API 測試，使用明確的假金鑰，驗證介面契約、錯誤處理、工具限制與金鑰隔離；不代表真實模型已完成取放。真實 API 與完整取放的驗證結果應以專案 `validation` 中另行保存的實測紀錄為準。一次成功不代表實體設備或陌生設備皆可成功。

2026-10-11：已確認 `ANTHROPIC_API_KEY` 存在於 Windows 系統環境，模型清單回覆 HTTP 200。使用者允許額外 Visual Studio 遙測連線後，再次以實際 V5 介面代跑 `claude-haiku-5-5`，已完成設備觀察、介面查詢、手冊查詢、連線與握手。保留 5 次模型決策、10 筆事件，動作數為 0，尚未進入驅動產生及取放。

這次仍被執行環境自動審查中止：審查承認已授權連線，但要求另外明確授權可能傳出的執行紀錄與環境資料；未提供實際遙測內容可供核對。本應用程式沒有加入此遙測路徑。沒有繞過審查重跑，也不把中斷列為模型控制失敗或取放成功。最新部分紀錄是 `validation/live-claude-authorized-progress.json`；狀態與先前中斷歷史見 `validation/claude-live-status.json`。未完成請求的計費狀態不明，已收到的決策數不等於總請求數。

## 官方介面依據

- 模型清單：https://platform.claude.com/docs/en/api/models/list
- 工具定義：https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools
- 平行工具：https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use
- 圖片輸入：https://platform.claude.com/docs/en/build-with-claude/vision
- Messages API：https://platform.claude.com/docs/en/api/messages/create
