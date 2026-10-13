# 驗證狀態（V7.0；V6.3 紀錄保留於下方）

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

## V7.0 驗證（2026-10-12，雲端 Linux，Node v22.22.0、Python 3.13.16）

全部離線或無頭瀏覽器；**沒有呼叫真實 Claude／Gemini**，因此沒有模型產生的無範本驅動或控制程式結果。

| 項目 | 紀錄 | 結論 |
|---|---|---|
| 協定設定檔、VLAB-G3、無範本手冊、規格產生器、模型上下文 | `validation/v7-devices-protocols.json` | 通過。錯誤協定、位元組順序錯誤、跳過檢查碼的驅動都被乾跑測試拒絕；讀錯手冊時連線會被拒；無範本手冊的任何欄位都沒有驅動原始碼。 |
| 控制程式沙箱、隔離閘門、啟用閘門、執行中違約 | `validation/v7-controller-module.json` | 通過。參考模組 6/6 組合成設備到達；越界、例外、NaN、永遠 verify、固定映射五種錯誤控制程式都被拒；未通過時 `start_control` 保持關閉且沒有設備動作；執行中輸出越界時不送出該動作。 |
| 離線五回合矩陣（設備 × 範本 × 控制模式） | `validation/v7-offline-matrix.json` | 12/12 組合都完成 5/5 並有取放影像證據。P2 seed 42；G3 seed 42、7。 |
| 無頭 Chromium（真實 iframe 沙箱、CSP、Worker） | `validation/v7-browser-smoke.json` | 3 組單回合（G3 無範本＋控制程式、P2 無範本＋控制程式、G3 範本＋內建）完成，無主控台錯誤、無外部請求。此測試發現並修正一個重複 DOM id 問題。 |
| Claude／Gemini 新工具與上下文 | 擴充後的 `test_claude_provider.cjs`、`test_gemini_provider.cjs` | 模擬 HTTP 通過；不是真實 API。 |

### 真實模型 5/5（使用者本機瀏覽器，2026-10-13）

紀錄：`validation/live-claude-v7-ui-p2-2026-10-13.json`（含模型產生的驅動與控制程式原始碼；完整 28.9 MB 匯出留在 repo 外，記 SHA-256）。

- 條件：`claude-haiku-5-5`、**VLAB-P2**（原定 G3，匯出仍是 P2）、無範本、產生控制程式、seed 42（開發資料）。Windows Chrome 154，`file:`（直接連線）。
- 結果：**5/5 完成**，放置影像誤差 4.10／3.23／4.91／1.39／2.77 px（門檻 12）。模擬器真值獨立核對：5 回合皆 `placed`、未夾持、物件高度等於平台高度，物件與目標距離 1.7–5.5 px。
- 來源：驅動 `claude-generated-no-template`、控制程式 `claude-generated`，皆通過未修改的閘門（驅動 6/6 乾跑、控制程式 6/6 合成設備）。兩者第一次都未通過（驅動未拒絕毀損回覆；控制程式在行程邊界起點未到達），模型依測試回饋修正後通過。
- 用量：86 次模型呼叫（前段 14、控制階段 72）、0 次 429、0 次格式修正；495 次設備動作（XY 455 由產生的控制程式執行）、0 次未確認動作；驅動執行環境 1033 次請求 0 失敗。期間分頁曾切到背景，未造成逾時。
- 界線：任務前提與影像驗證器仍預寫；單一設備家族、單一開發 seed，不是 G3、未見設備或泛化證據。

### 真實模型（使用者本機瀏覽器，2026-10-12）

紀錄：`validation/live-claude-v7-ui-p2-2026-10-12.json`（完整匯出 2.9 MB 留在 repo 外，記 SHA-256）。

- 條件：`claude-haiku-5-5`、**VLAB-P2**（非原定的 G3；UI 預設設備）、無範本、產生控制程式、seed 42（開發資料）。
- 結果：0/5。前段 5 步（觀察、手冊、介面、連線、握手）完成；之後 35 次 `write_driver` 全部 `DRIVER_STARTUP_TIMEOUT`：沙箱 iframe 已就緒，但 Worker 5 秒內沒有回報 ready，模型原始碼從未送入，也沒有編譯或測試。40 次呼叫用完前段上限停止；0 次設備動作、0 次 429。
- 判定：驅動執行環境／瀏覽器問題，不是模型決策失敗；也不構成無範本驅動成功或失敗的證據（模型 35 次都重送同一份原始碼）。
- 雲端重現：同條件離線代理經 `claude_bridge.py`（http）與 `file://` 在無頭 Chromium 皆完成，144 次驅動請求 0 失敗；**未重現**，使用者瀏覽器的成因未知（匯出未記錄瀏覽器版本、分頁可見性等）。

### 執行環境停止與瀏覽器資訊（2026-10-13，離線 Node）

紀錄：`validation/v70-runtime-environment.json`。因上述本機紀錄而新增：
- 前段工具（寫入／測試驅動或控制程式）連續 3 次 `DRIVER_STARTUP_TIMEOUT` 或 `DRIVER_ISOLATION_TIMEOUT` 即停止，`failureCategory: "runtime-environment"`，不再讓模型重送；任一次驅動／控制程式工具成功就歸零。`DRIVER_PROGRAM_ERROR` 等程式錯誤仍由模型修正，維持原本 40 次前段上限。
- 匯出新增 `environment`（userAgent、品牌版本、平台、頁面協定、可見性、焦點、`visibilitychange` 紀錄）；每次環境錯誤的工具結果附 `environmentAtFailure`。
- 測試：3 次逾時停止且 0 動作；2 次逾時後成功可完成 1/1；程式錯誤不被歸為環境錯誤。皆為故障注入，**未在使用者瀏覽器重現或驗證成因**。
- 修改後回歸（雲端 Linux，Node v22.22.0、Python 3.13.16）：V7 協定／控制程式、V6.2 驅動／報告、V6.3 模型報告／請求間隔／放手高度、V6.1 預算、Claude／Gemini provider 與 bridge、V6 suite、V7 離線矩陣、無頭 Chromium 煙霧測試共 21 項皆 exit 0。被測試改寫的舊 `validation/` 檔已還原，未新增這些重跑的紀錄檔。

離線五回合總動作數（內建控制器 vs. 控制程式模組；同設備、同 seed）：

| 設備 | seed | 內建 | 控制程式模組 | XY 動作（內建／模組） |
|---|---|---|---|---|
| VLAB-P2（範本或規格產生器，結果相同） | 42 | 305 | 279 | 265／239 |
| VLAB-G3（範本或規格產生器，結果相同） | 42 | 147 | 152 | 107／112 |
| VLAB-G3（範本或規格產生器，結果相同） | 7 | 150 | 154 | 110／114 |

判讀限制：控制程式模組是預寫的離線參考模組；離線無範本驅動來自規則式規格產生器。上表比較的是流程與基準，不是模型能力。seed 為開發資料；樣本數小，不能當成成功率。

## 2026-10-12 雲端環境重跑（離線）

紀錄：`validation/v63-rerun-2026-10-12-cloud.json`。Linux、Node v22.22.0、Python 3.13.16；未遇到遙測攔截，未開瀏覽器、未呼叫模型。測試腳本會改寫的歷史 `validation/*.json` 已還原，不覆蓋原證據。

- 下方六項最小聚焦測試全部通過；最後三項修正（送出前取消 0 呼叫、剩 1 次額度遇 429 不冷卻、`modelRequests.used` 為 0、1、2）已確認。
- V6.2 驅動、V6.1 標記／預算、V6 機構、平台物理、恢復策略、Claude 橋接與 V6.1 橋接預算測試通過。
- `tests/test_gemini_bridge.py` test_08 原本預期僅含 `retryDelay` 的 429 為 `QUOTA_EXCEEDED`，與 V6.3 刻意改為可重試 `RATE_LIMITED` 的設計（`test_v63_bridge_limits.py` test_05）衝突；只更新測試預期，未改產品程式。
- **`tests/test_v6_suite.cjs` 未通過**：seed 42 五回合完成；seed 1 第 4 回合（低台 0.35）`releaseHeightMatched` 偏差 2.52 px，超過 2.5 px 門檻而停止，完成 3 回合。所有 0.35 回合都有 +1.5～2.5 px 的系統偏差，0 與 0.65 約在 0.4 px 內。成因未定，門檻未修改。
- 仍未執行：瀏覽器 UI／CSP、真實模型五回合。

## 2026-10-12 低台偏差修正（離線）

紀錄：`validation/v63-offline-suite-2026-10-12-fix.json`、`validation/v63-release-probe-regression.json`。

- 成因一（低台放置高度）：夾取時物件吸附到末端，真實的末端－物件偏移等於平台偏移。0.35 時物件底邊落在末端 7.5 px 的圓盤內而被整條遮住，橘色外框中心因此上移 2～3 px；末端、B 與平台標記都沒有偏差。修正後放手高度證據改以可見邊加可見寬度定位，`releaseHeightMatched` 的 2.5 px 門檻未改；錯誤高度仍會被拒絕（新測試涵蓋）。
- 成因二（在第 4 回合通過後才浮現）：seed 1 第 5 回合肘關節卡在 2.85 rad 上限，通道 A +1 試動被裁成 0，不會產生樣本，離線策略一直重送同一個試動，直到 180 次上限。修正後若上一次試動被完全裁掉，就改試反方向。只影響離線規則代理。
- 結果：`test_v6_suite.cjs` seed 42 與 seed 1 都完成五回合，放手高度偏差 ≤ 0.52 px；其餘 18 項離線測試通過，seed 42 動作數與修正前相同。仍無瀏覽器或真實模型結果。

## 新環境待執行的最小聚焦清單

這些是接手後的命令清單，並非本次已執行的結果。需要可用的 Python 3 與支援測試語法／標準模組的 Node.js；此移交尚未建立跨版本相容矩陣。

```powershell
node tests/test_v63_provider_pacing.cjs
python tests/test_v63_bridge_limits.py
node tests/test_v63_model_reporting.cjs
node tests/test_claude_provider.cjs
node tests/test_gemini_provider.cjs
node tests/test_expected_contract.cjs
node tests/test_v63_release_probe_regression.cjs
```

先檢查本機環境是否有額外連線限制；若遭拒，記錄實際理由，不得改名／轉交代理繞過。
後續才進行 V6.2 驅動回歸與 V6 完整離線整合、瀏覽器 mock、真實模型五回合。歷史 UI 測試部分引用舊檔名與 Windows Chrome 絕對路徑，需先調整為新環境與 V6.3，不能直接把它們當現行版本的驗收門檻。
離線聚焦測試不需 npm 套件；歷史瀏覽器測試另需 Python Playwright 與相應瀏覽器，本次不代為安裝。

## 歷史實驗判讀

使用者的 V6.1 紀錄為 4/5 回合成功，第五回合停止於本機驅動編碼逾時；252 次已送出設備動作均有確認，最後提案尚未送出。這不是 API 429 的證據，也不能修改為五回合成功。
該完整 JSON 由作者另行保存，本包只包含既有專案的摘要／代表案例。若研究需要逐步重分析，須把原始報告加入獨立資料儲存區並建立雜湊索引。
