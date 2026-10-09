# Sentiment V5.2 离线工具集

## 〇、图形界面（`sentiment_gui.py`）

```bash
# 推荐：双击 run_gui.bat（自动选用带 tkinter 的 gui312 venv 解释器）
# 或命令行指定解释器（PATH 上默认的 python 3.13 是精简构建，没有 tkinter，直接跑会报
#   ModuleNotFoundError: No module named 'tkinter'，窗口不会出现）：
C:/Users/Administrator/.workbuddy/binaries/python/envs/gui312/Scripts/python.exe sentiment_gui.py
```

Tkinter 一键平台【V5.2 版】：鼠标选因子 CSV 与输出目录 → **界面直调权重 w1~w5 与四档阈值（开仓/减仓/清仓/过热），无需改源码** → 填风险标记（可选）→ 一键运行全流程（基准绩效 / 网格 / 阈值 / 鲁棒性 / 汇总报告 / 三栏图 / 末日日报 / Excel），日志实时滚动，桌面弹窗提示完成。

- **参数面板**：权重总和 ≠1 弹窗确认防误输；勾选「自定义权重」即按面板权重直接回测（跳过 3876 组网格）；阈值须满足 清仓 < 减仓 < 开仓 < 过热；**风控行可设最大仓位与单笔止损；成本行可设佣金/印花税/滑点与单日仓位变动上限；个股CSV行启用主线自动选股；勾选「滚动样本外验证」输出 rolling_test.csv 并写入报告（可选逐窗重寻优）**；「恢复默认」一键还原 V5 基准
- 需要 `tkinter`（Python 自带；托管精简版 Python 可能没有，用系统版 Python 建的 venv 跑，并装 `openpyxl`）+ `pandas numpy matplotlib openpyxl`
- 运行期间不卡界面（后台线程），重复点击自动忽略

## 一、通达信副图指标

- `tdx/SentimentV5_Lite.txt` —— **个股版**：相对大盘强弱代理，任意个股/板块指数副图可用
- `tdx/SentimentV5_Market.txt` —— **大盘版**：F3 主力信号改用 `ADVANCE-DECLINE` 真实涨跌家数（5日平滑 ADL），**只能挂在指数 K 线副图**（如上证指数 999999）——ADVANCE/DECLINE 是大盘专用函数，个股图下无数据
- `tdx/SentimentV5_Market_Signal.txt` —— **大盘版+信号箭头**：在 Market 基础上叠加 `CROSS` 触发信号（上穿65开仓 / 下穿44减仓 / 下穿24清仓 / 上穿80过热），清仓与过热另加文字标注；图标颜色由 TDX 内置图标编号决定不可自定义

**导入**：通达信 → 功能 → 公式系统 → 公式管理器 → 技术指标 → 其他类型 → 新建，粘贴对应 txt 全部内容，命名同文件名，测试通过后用于副图。

**口径说明（与网页原版 V5 的差异）**：

| 因子 | 原版采集指标 | Lite 替代（K线可提取） |
|---|---|---|
| F1 情绪定位 | 七因子情绪分 | RSI(13) + 5日动量合成 |
| F2 盈亏效应 | 炸板率/连板溢价/大面 | 振幅 + 长上影 + 5日持有回报 |
| F3 广度量能 | 成交额环比/涨跌家数 | 量比(N2) + N2日价格趋势 |
| F4 题材结构 | 题材梯队/存活率 | 相对大盘强度 5 日变化 |
| F5 主线结构 | 板块成交占比/内部涨跌 | 相对强度 10 日离散度（分化度） |

通达信公式引擎**无法获取**炸板率、涨跌家数、题材梯队等盘后统计，Lite 版是数学近似：用于**盘中实时量价情绪观测**，完整打分以网页模型为准。

原稿已修正的语法/逻辑问题：`LIMIT`（TDX 无此函数→`MAX(MIN())`）、`CONST` 误用、`INDEXG`（无此函数→分化度代理）、`MOM/VOL_RATIO` 未去中性锚导致基线漂移（固定漂到 65/62）、分段变色缺 `DRAWNULL` 导致零值污染。

## 二、权重敏感性回测（`backtest/sentiment_backtest.py`）

依赖：Python 3.10+，`pandas`、`numpy`。

### 因子数据格式（CSV）

```
date,f1,f2,f3,f4,f5,close[,regime]
2023-01-03,62.1,55.3,48.0,70.2,66.0,3116.51
```

**手工采集用 Excel 模板**：`SentimentV5_factor_template.xlsx`（由 `make_template.py` 生成）——填 B~F 因子分（0~100 数据校验），G~I 自动算综合分/风险等级/交易信号，J 列填回测标的收盘（**回测必需**）。另存为 CSV 后表头即 `date,f1..f5,close`，直接 `--factors` 喂回测。

- `f1~f5`：当日核心因子分（0~100）。**列名与个数可用 `--factor-cols` 覆盖**（配合 `--weights` 给等长权重）；
  真实历史因子分现已由 `export_from_archive.py` 从网页存档一键导出，无需手工补齐（见下节）
- `close`：回测标的收盘价（主线指数或等权主线篮子）
- `regime`（可选）：`bull/bear/other`；缺省时按标的价格 60 日趋势自动标注

### 从网页存档导出因子（`export_from_archive.py`）

网页版模型每日收盘后把**七因子**情绪分（`s_net/s_pos/s_brd/s_hot/s_zdt/s_zbl/s_amt`）写入
`data/archive.json`。本脚本把这批真实因子分导成回测 CSV，并附带标的收益/净值序列：

```bash
# 七因子（无损，推荐）：导出后直接回测
python export_from_archive.py --archive ../../data/archive.json --out archive_factors.csv
python sentiment_backtest.py --factors archive_factors.csv \
    --factor-cols s_net,s_pos,s_brd,s_hot,s_zdt,s_zbl,s_amt \
    --weights 0.2,0.1,0.2,0.1,0.15,0.1,0.15 --fast --xlsx

# f1~f5 有损映射（仅兼容旧管线/旧报告模板，不推荐）
python export_from_archive.py --legacy5 --out archive_f5.csv
```

- `--index` 标的口径：默认 `等权`（三大指数日收益等权合成），可选 `上证指数/深证成指/创业板指`
- 存档 `indexes` 只有**当日涨跌幅**、无收盘价；回测只需收益序列，故脚本用涨跌幅还原净值（基准 100）
  作 `close`，并额外输出精确 `ret` 列（`asset_ret` 优先取 `ret`，可保全首日收益）
- 因子或指数缺失的交易日**直接跳过、不插值**（不让假数据进回测），跳过明细打印在终端
- ⚠ `--legacy5` 的七→五映射是**语义近似、有损**：`f1=综合分`（与其余因子共线）、`f2=s_net`、
  `f3=mean(s_pos,s_amt)`、`f4=mean(s_hot,s_zdt)`、`f5=mean(s_brd,s_zbl)`。除复用旧模板外请用七因子模式

> **交叉验证**：同一份存档、同一组权重下，Python 侧与网页版 JS 引擎（`src/backtest.js`）的基准绩效
> **逐位一致**（total_ret -0.0355 / annual -0.2477 / max_dd 0.0476 / sharpe -2.038 / win_rate 0.4516），
> 说明两套实现真正等价，而非各算各的。

### 用法

```bash
# 全流程（网格 3876 组 + 阈值 + 鲁棒性 + 场景）
python sentiment_backtest.py --factors factors.csv --out reports

# 一键：全流程 + 净值/因子图 + 末日日报（含失效预警修正）
python sentiment_backtest.py --factors factors.csv --out reports --plot --report \
    --alerts "D大规模量价背离,P_突发黑天鹅"

# 合成数据自检
python sentiment_backtest.py --demo --out reports_demo

# 快速模式（跳过网格，仅基准/阈值/鲁棒性）；--rf 夏普计入无风险利率
python sentiment_backtest.py --factors factors.csv --fast --rf 0.02

# 自定义权重与阈值调参（给出任一 wi 即跳过网格，需 sum=1）；--xlsx 导出回测结果 Excel
python sentiment_backtest.py --factors factors.csv --fast --xlsx \
    --w1 0.3 --w2 0.2 --w3 0.2 --w4 0.2 --w5 0.1 --lo 60 --hi 40 --panic 20 --overheat 85

# 因子列名/个数覆盖（例：网页模型七因子）：--weights 个数须等于 --factor-cols 列数；
# 给了 --weights 默认跳过网格，想同时扫网格就加 --grid（此时 --weights 仅作基准绩效）
python sentiment_backtest.py --factors archive_factors.csv \
    --factor-cols s_net,s_pos,s_brd,s_hot,s_zdt,s_zbl,s_amt \
    --weights 0.2,0.1,0.2,0.1,0.15,0.1,0.15 --grid --pareto --out reports

# 风控约束：最大仓位 0.6 + 单笔止损 -8%（持仓期当日跌幅≤-8% 次日强制清仓）
python sentiment_backtest.py --factors factors.csv --fast --max-pos 0.6 --stop-loss -0.08

# 回撤动态降仓：组合回撤≥15% 仓位上限压至 40%，≥9% 压至 70%（类凯利风控，越亏越降杠杆）
python sentiment_backtest.py --factors factors.csv --fast --dd-trigger -0.15

# 网格绘图：阈值热力图（lo×hi→夏普，看参数高原）+ TopN 参数净值对比
python sentiment_backtest.py --factors factors.csv --fast --heatmap --batch-nav 5

# 多标的等权轮动：CSV 加 asset_id 列即自动启用（date,asset_id,f1..f5,close 或 ret），逐标的回测后日收益等权合成；
# Excel 变四表（组合每日净值含各标的 nav / 交易明细带 asset_id / 每标的绩效 / 汇总指标）
python sentiment_backtest.py --factors multi_asset_factors.csv --fast --xlsx

# 【V5.2】交易成本 + 仓位平滑：买入收 佣金+滑点，卖出收 佣金+印花税+滑点；单日仓位变动 ≤20%
python sentiment_backtest.py --factors factors.csv --fast \
    --comm 0.0003 --stamp 0.0005 --slip 0.0002 --max-pos-chg 0.2

# 【V5.2】主线自动选股：个股CSV（date,code,sector,is_limit_up,rise_pct 或 close）逐日识别主线板块
# （main_score = 涨停家数×涨停密度，取 top N）→ 主线个股 × 当日市场因子 → 标的池（auto_pool.csv），
# 日报输出末日主线板块与个股清单；demo 模式传 --stock-csv demo 用合成个股演示
python sentiment_backtest.py --factors factors.csv --stock-csv stocks.csv --main-topn 1 --fast --report

# 【V5.2】帕累托多目标寻优：网格后输出 夏普↑×回撤↓ 双目标非支配解集（解集内按 Calmar 排序）
python sentiment_backtest.py --factors factors.csv --pareto

# 滚动窗口样本外验证（train 252 / test 63 切段）；--roll-refit 加逐窗重寻优（walk-forward，较慢）
python sentiment_backtest.py --factors factors.csv --fast --roll --train-win 252 --test-win 63
```

**依赖**：`pandas numpy`；`--plot`/GUI 另需 `matplotlib`；`--xlsx`/模板生成另需 `openpyxl`；GUI 需 `tkinter`。

### 可视化与日报

- `--plot`：输出 `nav_factors.png` 三栏——①策略净值 vs 买入持有（阴影=超额收益区）②五因子+综合分时序+四条阈值线（开仓/减仓/清仓/过热）③**持仓日策略收益分布直方图**（盈亏稳定性，均值橙线标注；换仓日口径样本太少且有选择性偏差，弃用）。中文字体自动探测（微软雅黑/黑体）
- `--report`：按 CSV 末日数据生成 `daily_report_<日期>.md`——五因子得分、综合分、V5 五档风险等级与操作建议
- `--alerts`：传入当日辅助模块高风险信号（逗号分隔），每项对综合分扣 12 分生成**修正参考分**（原分不动仅报告参考）；命中 ≥2 项标记"模型失效预警，建议人工干预"——对齐 V5 总架构第六节人工覆盖规则。内置信号表：`P_突发黑天鹅 / P重大政策转向 / O宏观超预期冲击 / B北向大额恐慌流出 / D大规模量价背离 / E大面积高位杀跌`

**列名兼容**：CSV 列名大小写不敏感（`F1`/`f1` 均可）；既支持 `close` 列（自动算日收益，Excel 模板导出即此格式），缺列会明确报错。

### 输出（`--out` 目录）

| 文件 | 内容 |
|---|---|
| `report.md` | 汇总报告：基准绩效、最优权重、最优阈值、鲁棒性、失效场景 |
| `weights_scan.csv` | 全部 3876 组权重绩效（回撤↑→夏普↓→年化↓ 排序） |
| `threshold_scan.csv` | hi∈[20,30] × lo∈[60,70] 阈值扫描 |
| `regime.csv` | 牛/熊/震荡分组信号错误率 |
| `threshold_heatmap.png`（`--heatmap`） | 阈值扫描热力图（lo×hi→夏普，纯 matplotlib 无 seaborn 依赖） |
| `batch_nav_compare.png`（`--batch-nav N`） | TopN 参数组合净值对比（网格取权重 TopN，快速模式取阈值 TopN） |
| `rolling_test.csv`（`--roll`） | 滚动窗口样本外验证：每段区间/寻优参数/绩效；`--roll-refit` 为真 walk-forward（训练窗阈值扫描选参 → 测试窗评估，训练段绝不参与测试） |
| `auto_pool.csv`（`--stock-csv`） | 主线自动选股生成的多标的池：date, asset_id(个股代码), f1~f5(当日市场因子), ret(个股日收益) |
| `pareto_frontier.csv`（`--pareto`） | 网格帕累托前沿：夏普↑×回撤↓ 双目标非支配解集（解集内按 Calmar 排序），回撤厌恶型资金可在此以少量夏普换更小回撤 |
| `Sentiment_Backtest_Result_<日期>.xlsx`（`--xlsx`） | 三表：**每日因子与仓位**（f1~f5/综合分/仓位/策略收益/净值逐日明细）、**交易明细**（每次仓位变动的打分日→T+1 生效日、动作、当日收益、累计净值）、**汇总指标**（权重/阈值/仓位/止损/**成本与平滑**参数 + 年化/回撤/夏普/Calmar/Sortino/最大连亏天数/胜率/盈亏比/空仓占比/开仓次数）；多标的模式变四表 |

### 回测规则（对齐 V5 风险表）

- 收盘打分，T+1 生效：score≥65 持有 / 44~65 减仓至 0.5 / ≤24 清仓 / ≥80 过热只减仓不新建
- 风控约束（可选）：`--max-pos` 仓位上限（满仓=max_pos，减仓=0.5×max_pos）；`--stop-loss`（如 -0.08）持仓期当日收盘跌幅≤止损线则次日强制清仓；`--dd-trigger`（如 -0.15）回撤动态降仓——回撤≥15% 上限压至 40%、≥9% 压至 70%；止损优先于信号
- 【V5.2】交易成本（可选）：`--comm` 佣金双边 / `--stamp` 印花税仅卖出 / `--slip` 单边滑点——按当日仓位变动幅度计，直接从策略日收益中扣除（strat = ret×pos − cost）；成本/平滑口径随网格与阈值扫描同步生效
- 【V5.2】仓位平滑（可选）：`--max-pos-chg`（如 0.2）单日仓位变动相对前日生效仓位最多 ±20%，避免满仓/空仓一夜跳变；**止损立即清仓不受平滑约束**（风控优先）
- 【V5.2】主线自动选股（可选）：`--stock-csv` 个股日线（date,code,sector,is_limit_up,rise_pct 或 close）逐日识别主线板块——main_score = 涨停家数 × 涨停密度（除零防护），取 `--main-topn` 名板块的全部个股为当日标的池，因子按日 merge（同日各标的共用市场情绪因子）；主线每日动态变化，等权合成时缺日自动跳过；个股日期须与因子日期有重叠
- 多标的轮动：CSV 含 `asset_id` 列自动启用（支持 close 或 ret 列两种收益口径），逐标的独立回测（T+1/止损/降仓/成本同规则）后按日等权合成组合净值；滚动/网格/阈值扫描全兼容
- GUI 日志同步持久化到 `输出目录/backtest_log.txt`（带时间戳，跨会话保留）
- 滚动样本外验证：`--roll` 按 test_window 切段评估参数跨期稳定性；`--roll-refit` 每 63 日在训练窗（默认252日）阈值扫描重寻优、紧随测试窗评估——样本外均值显著低于全样本 ⇒ 过拟合，需降参数激进程度
- 优化目标优先级：**最大回撤最小 → 夏普最高 → 年化最高**（防回撤优先于收益）；`--pareto` 另输出夏普×回撤双目标帕累托前沿
- 鲁棒性：±5 分均匀噪声 **200 次重复扰动**看平均衰减（单次噪声无统计意义）；70/30 训练验证分段防过拟合
- 失效场景：单边牛市/熊市/震荡分组统计持仓踩错率；黑天鹅与强政策事件当日人工覆盖模型打分

> Excel 无法承载 3876 组网格与噪声扰动，权重扫描请用本脚本；Excel 仅适合抽查单组权重。
