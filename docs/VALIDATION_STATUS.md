# V6.3 驗證狀態

更新：2026-10-12。狀態：開發移交，最終回歸未確認。這次交付只重新做靜態封裝，不執行遭拒的測試、不呼叫模型 API，也沒有新的五回合實驗。

| 項目 | 已有證據 | 可支持的結論 |
|---|---|---|
| 模型排程與 429 | `validation/v63-provider-pacing.json` | 較早修訂的 10 組 × 2 provider 通過；最終修訂 `passed: null` |
| 橋接錯誤與額度分類 | `validation/v63-bridge-limits.json` | 12 項記憶體測試通過；不含真實 API |
| 模型診斷與報告 | `validation/v63-model-reporting.json` | 2 組純 Node 檢查通過 |
| V6.2 驅動等待／報告 | `validation/v62-driver-runtime.json`、`validation/v62-runtime-reporting.json` | 歷史聚焦結果；本次沒有重跑 |
| 瀏覽器 UI、CSP、完整五回合、真實模型 | 尚無 V6.3 新結果 | 不得宣稱通過 |

最後三項修正已存入程式與測試，但最終測試結果沒有取得：

1. 實際送出前立即取消：0 fetch、0 呼叫。
2. 只剩 1 次額度且收到 429：直接停止，不進入無用冷卻。
3. 重試送給模型的 `modelRequests.used` 依序更新為 0、1、2。

上一環境的自動審核拒絕測試結果讀取，理由為可能向 Visual Studio 遙測端點傳送內容不明的資料。這是執行環境的審核事件，不能推論本專案含有該遙測；沒有繞道重跑。
之後靜態建置工具一度無回應。本次只完成靜態打包及內容一致性檢查，結果見完整移交 ZIP 中的 `DELIVERY_MANIFEST.json`，不取代程式行為驗證。HTML 內嵌的原始碼 ZIP 不含此交付清單。

## 新環境待執行的最小聚焦清單

這些是接手後的命令清單，並非本次已執行的結果。需要可用的 Python 3 與支援測試語法／標準模組的 Node.js；此移交尚未建立跨版本相容矩陣。

```powershell
node tests/test_v63_provider_pacing.cjs
python tests/test_v63_bridge_limits.py
node tests/test_v63_model_reporting.cjs
node tests/test_claude_provider.cjs
node tests/test_gemini_provider.cjs
node tests/test_expected_contract.cjs
```

先檢查本機環境是否有額外連線限制；若遭拒，記錄實際理由，不得改名／轉交代理繞過。
後續才進行 V6.2 驅動回歸與 V6 完整離線整合、瀏覽器 mock、真實模型五回合。歷史 UI 測試部分引用舊檔名與 Windows Chrome 絕對路徑，需先調整為新環境與 V6.3，不能直接把它們當現行版本的驗收門檻。
離線聚焦測試不需 npm 套件；歷史瀏覽器測試另需 Python Playwright 與相應瀏覽器，本次不代為安裝。

## 歷史實驗判讀

使用者的 V6.1 紀錄為 4/5 回合成功，第五回合停止於本機驅動編碼逾時；252 次已送出設備動作均有確認，最後提案尚未送出。這不是 API 429 的證據，也不能修改為五回合成功。
該完整 JSON 由作者另行保存，本包只包含既有專案的摘要／代表案例。若研究需要逐步重分析，須把原始報告加入獨立資料儲存區並建立雜湊索引。
