> V6.3 連續五回合請使用新版啟動器；CLI 橋接預設整場上限 500，設定頁可降低前端上限。已知升降會停在當地支撐面，尚未學習未知 Z 軸。

# Gemini 控制虛擬設備

使用同一個 V6.3 虛擬設備、連線流程與取放驗證器，將決策來源切換為 Google Gemini。不會暗中改用離線代理。

V5.2 的 `INVALID_DECISION`、`INVALID_ARGUMENTS`、`INVALID_TOOL_RESPONSE` 會先顯示具體拒絕原因，保留當次進度並請同一模型修正，最多兩次；第三次回覆仍不合法就停止。所有修正均計入模型請求上限，被拒絕的指令不執行。V6.3 另對可重試的 HTTP 429 加入有限次冷卻；其餘 API 錯誤仍直接中止，設備命令不會因此重送。這個處理適用於目前開啟的實驗，不能從舊版 JSON 還原執行。

## 開始操作

V5.3 與 Claude 共用工具契約：`expected` 預期說明可省略，紀錄以 `expectedProvided:false` 明示缺少；工具、`args`、`reason` 與動作範圍仍維持完整驗證。

1. 安裝 Python 3。從 HTML 的原始碼下載功能取得專案並解壓縮。
2. 在 Windows 環境變數中設定 `gemini_api_key`；Windows 的 `GEMINI_API_KEY`、`Gemini_API_Key` 是同一名稱。已設定時不必重新輸入，橋接也會讀取使用者與系統層級的同名變數。
3. 執行 `start-gemini.cmd`。若找不到環境變數，終端機會提示輸入金鑰（隱藏文字，僅留在本次程式記憶體，不存檔）。頁面會從 `http://127.0.0.1:8767/?agent=gemini` 開啟並預選 Gemini。
4. 在設定頁按「取得可用模型」，選擇具備影像輸入及工具呼叫能力的模型，按「套用並從零開始」，再按「開始完整實驗」。清單依 `generateContent` 能力篩選，但清單存在本身不保證支援本實驗所需的全部功能。開啟頁面本身不會啟動付費決策。

不要直接以 `file://` 開啟 HTML 來連接本機金鑰；請使用啟動程式開啟的本機網址。HTML 前端只送虛擬相機影像、可觀測狀態和工具宣告。金鑰保留在 Python 程式記憶體，使用 Google 官方端點的 `x-goog-api-key` 標頭，不寫入 HTML、報告或日誌。

也可在專案資料夾使用：

```powershell
python gemini_bridge.py --check
python gemini_bridge.py --open-browser --max-calls 80
python gemini_bridge.py --open-browser --prompt-key
```

`--check` 只檢查同名金鑰是否存在；存在時查詢模型清單，不呼叫 `generateContent`。變更環境變數後請重新啟動橋接。不要把金鑰貼在錯誤截圖或報告中。

## V6.3 請求間隔與冷卻

設定頁的「模型請求最短間隔」預設 6 秒，可設定 0–120 秒；0 表示停用固定間隔。它控制相鄰請求的開始時間，不是在每次回覆後再固定等待 6 秒，也與畫面播放速度分開。約每分鐘 10 次請求仍可能觸及帳號詞元量、每日額度等限制。

只有可重試的 HTTP 429 會等待後重試，最多 2 次；已知每日配額、費用上限或無可用配額直接停止。等待優先採服務端提示，沒有提示時依序為 30、60 秒。服務端要求單次等待超過 180 秒會停止並保留等待提示，不能以較短等待繞過限制。401／403、網路中斷及回覆逾時不會用這個機制自動重試。

介面會顯示請求間隔、限流冷卻或 AI 回覆等待的狀態與倒數。「本步後暫停」會讓已開始的決策步驟先完成；不會立即取消等待中的請求。重試仍計入前端及橋接原有的總請求上限，500 次上限不會因等待而自動重設。請下載新版原始碼並關閉、重開橋接，才能取得新版的等待提示轉送。

匯出 JSON 的 `modelRuntime` 記錄請求數、限流重試數、累計等待與最近 40 筆診斷。最終模型失敗另有 `modelDiagnostic`；`driverRuntime` 是獨立的本機驅動診斷，不等於 API rate limit。

## 診斷

V6.2 將通訊驅動的啟動與執行回覆等待分成各 5 秒。只有編碼階段尚未送出程式的啟動逾時，才重建工作執行緒重試一次；設備交換不重送。請在「測試與紀錄」查看計數及本次等待階段，完整診斷位於匯出 JSON 的 `driverRuntime`。這項本機恢復不會增加模型 API 呼叫。

| 代碼 | 意義與處理 |
|---|---|
| `MISSING_AUTHORIZED_KEY` | 此電腦找不到 `gemini_api_key`；設定後重新啟動橋接。 |
| `INVALID_API_KEY` | Google 不接受這把金鑰；確認 Google AI Studio 的金鑰。 |
| `PERMISSION_DENIED` | 金鑰限制或 API 權限不允許這項請求。 |
| `QUOTA_EXCEEDED` | 已知每日額度、零配額等不可重試限制；先檢查帳戶配額。 |
| `RATE_LIMITED` | 速率限制的有限次重試已用完，未執行本次工具。 |
| `RATE_LIMIT_WAIT_TOO_LONG` | 服務端要求單次等待超過 180 秒；依診斷中的等待時間稍後再試。 |
| `MODEL_UNAVAILABLE` | 模型不存在或帳戶無法使用；重新取得模型清單。 |
| `INVALID_REQUEST_FORMAT` | Google 不接受請求格式；保留代碼與選定模型供檢查。 |
| `BRIDGE_CALL_BUDGET` | 此次橋接的決策次數已用完；先查看報告再決定是否重開。 |
| `UPSTREAM_UNAVAILABLE` | 網路或上游服務暫時不可用。 |

此版本不指定永久有效的預設模型；可用性以帳戶實際取得的模型清單為準。模型清單成功也不代表工具呼叫與完整取放已完成，三者分別驗證。

## 工程範圍

- 僅綁定 `127.0.0.1:8767`，檢查 Host、Origin、Fetch-Site 與自訂橋接標頭，不開跨來源權限。
- 上游固定為 `https://generativelanguage.googleapis.com/v1beta`，拒絕轉址，不提供任意 URL 代理。
- 限制單次本文 6 MiB、PNG 4 MiB、回應 4 MiB；CLI 橋接預設最多 500 次決策，可設定 1–500 次；介面五回合預設 500 次，單回合預設 80 次。
- 工具僅可使用專案已宣告的觀察、通訊、產生驅動、校正與取放工具。產生的設備控制程式仍經原有沙箱與通訊驗證。
- 保留工具回傳、使用量與所選模型 ID；不輸出模型思考內容。每步以當前可觀測狀態重新建立請求。

## 官方介面參考

- [generateContent REST](https://ai.google.dev/api/generate-content)
- [模型清單與分頁](https://ai.google.dev/api/models)
- [Function calling](https://ai.google.dev/gemini-api/docs/function-calling)

文件核對日期：2026-10-11。API 與端點的 mock 測試不等同真實帳戶測試；真實執行狀態應以 `validation` 中本次實驗報告為準。
