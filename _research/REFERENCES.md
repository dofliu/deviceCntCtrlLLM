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


## 2026-10-17 追加（摘要層級核實；待精讀全文）

核實方式：arXiv 摘要頁或會議頁面。下列「與本案的差異」是我們依摘要的推論，精讀全文前不得在稿件中當作對方的完整描述。

| 文獻 | 出處與連結 | 已核對內容及與本案的差異 |
|---|---|---|
| Englhardt et al., Exploring and Characterizing Large Language Models For Embedded System Development and Debugging (2023) | [arXiv:2307.03817](https://arxiv.org/abs/2307.03817)（v2 2023-11-22；另有 CHI EA 2024 版本待核實） | 以硬體在環框架驗證 LLM 寫的嵌入式程式（GPT-3.5、GPT-4、PaLM 2，N=450）；GPT-4 在 50 次中 66% 寫出可用 I2C 介面。硬體與感測器已知，沒有未知運動映射或保留設備評估。 |
| Fakih et al., LLM4PLC: Harnessing Large Language Models for Verifiable Programming of PLCs in Industrial Control Systems (2024) | [arXiv:2401.05443](https://arxiv.org/abs/2401.05443v1)；[ICSE-SEIP 2024](https://conf.researchr.org/details/icse-2024/icse-2024-software-engineering-in-practice/32/LLM4PLC-Harnessing-Large-Language-Models-for-Verifiable-Programming-of-PLCs-in-Indus) | 以文法檢查、編譯器、SMV 模型檢查器包住 LLM 產生 PLC 程式；生成成功率 47%→72%（arXiv v1 摘要）。「生成後經外部驗證」與我們的主機端閘門同類；但目標是已知控制規格，不是陌生設備。 |
| Vemprala et al., ChatGPT for Robotics: Design Principles and Model Abilities (2023) | [arXiv:2306.17582](https://arxiv.org/abs/2306.17582v1)；Microsoft MSR-TR-2023-8 | 以提示原則與高階函式庫讓 ChatGPT 控制多種機器人與模擬器。假設已有函式庫（已知 API），不處理線路協定與未知映射。 |
| Tripathi, Akbarian Bafghi & Raissi, Test-Driven Agentic Framework for Reliable Robot Controller (2026，預印本) | [arXiv:2603.00455](https://arxiv.org/abs/2603.00455) | 依結構化測試套件反覆修正 LLM 產生的導航控制程式（2D、Webots）。以測試驅動修正與我們的隔離閘門相近；摘要未提保留設備或未見本體。 |
| Flerlage, Wittkopp, Acker & Kao, Adaptive Code Generation for Controlling Robots (2026，ISoLA 2026) | [arXiv:2610.09588](https://arxiv.org/abs/2610.09588v1) | LLM 產生限制於正式函式庫的程式，VLM 提供語意基準，含執行期監控與重新規劃。摘要未說明機器人是否未知、是否寫低階控制。 |
| Shastri et al., LLM-Driven Auto Configuration for Transient IoT Device Collaboration (CollabIoT, 2025) | [arXiv:2507.03064](https://arxiv.org/abs/2507.03064)；[作者 PDF](https://lass.cs.umass.edu/papers/pdf/sec25-llm_autoconfig.pdf) | LLM 把使用者意圖轉為陌生環境中設備的存取控制政策。屬「陌生設備自動配置」，但處理的是權限政策，不是驅動或閉迴路控制。 |

搜尋紀錄（2026-10-17，非系統性）：「LLM 依 datasheet 產生驅動並評估」「LLM 代理接手未知 Modbus 設備」「LLM 控制未知機器人並由相機學運動映射」三組搜尋都沒有找到同時涵蓋未知線路協定、未知運動學與保留設備評估的研究；這只代表本次搜尋沒找到，投稿前須做系統性檢索，不得據此寫「first」。
