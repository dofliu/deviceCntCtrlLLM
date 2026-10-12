# 移交包內容

`unknown-device-v6.3.html`：本次可直接開啟的 V6.3 頁面，包含離線代理與可下載原始碼。

`dof-device-agent-v6.3-handoff.zip` 解壓後的 `virtual-device-v6.3/`：

- 最新 HTML、完整維護原始碼、建置程式、Claude／Gemini 本機橋接與 Windows 啟動器。
- README、AGENTS、Codex 接續與驗證說明、模型操作說明、歷史設計文件。
- `_research/` 全部研究文件：狀態、貢獻、文獻、協定草案、宣稱、決策與 repo 規劃。
- `tests/` 測試程式及代表案例，`validation/` 既有 JSON／文字結果；不表示本次全部重跑。
- `vendor/` 第三方 Three.js 與其授權。
- `archive/` 留存此專案原有的 V5、V5.2、V5.3、V6、V6.1、V6.2 HTML，供比較歷史行為；這些不是本次建置產物。
- `DELIVERY_MANIFEST.json` 記錄套件內每個檔案的 SHA256、檔案數與本次靜態封裝檢查。manifest 本身不列入自己的雜湊。

HTML 裡的「下載原始碼」只包含現行維護來源，不包含 HTML 自身、archive 歷史 HTML 或交付 manifest。要完整移交到 Codex，請使用外層 handoff ZIP。

本包不包含 API 金鑰、Git 內部資料、本機快取、先前介面截圖或另行上傳的完整大型實驗 JSON。歷史測試結果與論文資料應依個別檔案標示的版本解讀；研究文獻清單是先前核實的草稿，本次沒有重新查證所有文獻。

未附早期展示影片及各版完整開發工作區。早期設計文字集中在 `docs/history/`；維護與建立 repo 以根目錄 V6.3 為準。
