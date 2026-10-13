# 初步文獻地圖

核實日期：2026-10-12。此為研究定位搜尋，非系統性回顧。
下列「對本案的意義」是我們的推論；沒有直接借用各文獻成功率作排名。

| 文獻 | 出處與連結 | 已核對內容及對本案的意義 |
|---|---|---|
| Yoshimi & Allen, Active, uncalibrated visual servoing (1994) | [Columbia 作者研究頁](https://www.cs.columbia.edu/robotics/projects/visual_control/bill-peginhole.html)；ICRA 1994 | 作者頁說明以小幅移動觀察影像、估計 Image Jacobian；probing 加視覺閉迴圈已有基礎。 |
| Liang et al., Code as Policies: Language Model Programs for Embodied Control (2022 預印本、2023 修訂) | [arXiv:2209.07753](https://arxiv.org/abs/2209.07753) | 核對摘要與版本；LLM 生成呼叫感知／控制 API 的程式，AI 寫控制程式本身不能直接作新貢獻。 |
| Huang et al., VoxPoser: Composable 3D Value Maps for Robotic Manipulation with Language Models (2023) | [arXiv:2307.05973](https://arxiv.org/abs/2307.05973) | 核對摘要；LLM/VLM 建構 3D value maps 並配合規劃產生閉迴圈軌跡。未知任務語意是另一條研究線。 |
| Hu, Lin & Lipson, Teaching robots to build simulations of themselves (2025) | Nature Machine Intelligence；[DOI 10.1038/s42256-025-01006-w](https://doi.org/10.1038/s42256-025-01006-w)；[arXiv:2311.12151](https://arxiv.org/abs/2311.12151) | 核對 arXiv 摘要與正式期刊 DOI；由自身動作影像建立形態／運動自我模型。建立自我模擬也有先例。 |
| Li et al., Controlling diverse robots by inferring Jacobian fields with deep networks (2025) | Nature；[DOI 10.1038/s41586-025-09170-0](https://doi.org/10.1038/s41586-025-09170-0)；[作者全文](https://arxiv.org/html/2407.08722v2) | 核對摘要及全文 introduction/method 段。Neural Jacobian Fields 已實作多種機器人的視覺控制；訓練為 12 部 RGB-D 相機、2–3 小時多視角資料，部署單相機。少量線上試探可作成本維度，但本案簡化 2R 與它的能力不同，不能直接宣稱更優。 |
| Ahn et al., Towards Reliable Code-as-Policies: A Neuro-Symbolic Framework for Embodied Task Planning (2025，預印本) | [arXiv:2510.21302](https://arxiv.org/abs/2510.21302)；[全文](https://arxiv.org/html/2510.21302v1) | 核對全文方法描述；NeSyRo 已結合符號驗證、主動探索與環境驗證，故「生成後先驗證」也不是單獨新貢獻。 |
| Ashley et al., RACAS: Controlling Diverse Robots With a Single Agentic System (2026，預印本) | [arXiv:2603.05621](https://arxiv.org/abs/2603.05621) | 核對摘要與 HTML 出處；多個 LLM/VLM 模組跨不同本體控制，但輸入包含設備描述、可用動作及任務。不能把跨設備代理本身稱首創。 |
| Ganie, Ezzini & Marazi, RAG-Based Auto-Configuration for Industrial Fieldbus Devices (2026，預印本) | [arXiv:2608.08618](https://arxiv.org/abs/2608.08618) | 已核實原始 arXiv 索引摘要，直接全文讀取未成功；只能作待精讀近鄰。摘要描述由設備 PDF 產生多種 fieldbus 配置並驗證，含虛擬 UR5e 案例。不能先宣稱從手冊到設備啟用沒人做。 |
| Li et al., Agentic RSR: Real-to-Sim-to-Real through Scene Reconstruction and Execution-Grounded Robot Policies (2026-10-07，預印本) | [arXiv:2610.10479](https://arxiv.org/abs/2610.10479) | 已核對摘要；在已知機器人模型下連接場景重建、程式策略與真機執行。和後續數位孿生構想接近，尚待全文比較。 |

## 先讀順序
1. Neural Jacobian Fields：釐清我們要減少的先驗與資料成本。
2. RACAS、NeSyRo：比對代理、記憶、驗證與探索機制。
3. Fieldbus Auto-Configuration：比對手冊到通訊配置／driver 的差異。
4. 經典視覺伺服：建立不使用 LLM 的強基線。
5. 自我模擬與 Agentic RSR：規劃後續實體與孿生階段。

## 待補
- 精讀完整相關研究並追蹤引用，特別是 active system identification、change detection 與 selective recalibration。
- 驗證各公開實作能否在共同觀測、訓練與運算預算下比較。
- 查期刊目前收稿範圍及近年同類研究，再由作者選定投稿目標。

