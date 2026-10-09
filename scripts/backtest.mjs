// 生成 data/backtest.json：把 V5.2 回测（交易成本/仓位平滑/止损/动态降仓/多标的轮动/
// 权重网格+帕累托/滚动样本外/主线自动选股）预计算为静态 JSON，供前端零构建渲染。
// 用法：node scripts/backtest.mjs [--archive data/archive.json] [--out data/backtest.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { atomicWriteJSON } from '../src/fsutil.js';
import config from '../src/config.js';
import { decodeArchive } from '../src/lhb_codec.js';
import { classifySeries } from '../src/regime.js';
import { bandFor } from '../src/position_policy.js';
import {
  BASE_PARAMS, V52_PARAMS, DEFAULT_TH,
  scoreWith, poolBacktest, paretoFrontier, rollingTest, selectMainLine, computeDynamicThreshold,
  assessMarketState, assessSentimentState, applyMainLineGating,
  assignPositionWeights, sortByRank,
} from '../src/backtest.js';
import { parallelGridSearch, parallelRollingTest, defaultWorkers } from '../src/grid_parallel.js';

const args = process.argv.slice(2);
const argOf = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const ARCHIVE = argOf('--archive', 'data/archive.json');
const OUT = argOf('--out', 'data/backtest.json');

const arch = decodeArchive(JSON.parse(readFileSync(ARCHIVE, 'utf8')));
// ⚠ 必须剔除历史回填天（emotion._backfill）：
//   回填天只有 lhb 与 s_net，其 emotion.value 是 **s_net 单因子占位值、不是综合分**。
//   回测把 value 当信号用，若混入回填天，208 天的「假情绪分」会直接污染
//   收益率/夏普/最大回撤/权重网格/帕累托前沿——每一个数字都会错，而且错得不容易看出来
//   （曲线照样平滑、照样有形状）。
//   回填天存在的意义是为 **分位** 提供基线，不是为回测提供样本。
const days = (arch.all_days || []).filter((d) => d && d.trade_date && !(d.emotion && d.emotion._backfill));
if (days.length < 5) {
  console.error(`[backtest] 样本不足（${days.length} 个交易日），跳过生成`);
  process.exit(0);
}

// 回测样本构成留痕：让使用者一眼看出「回测用的是哪一段、排除了多少回填天」
const BACKFILL_EXCLUDED = (arch.all_days || []).filter((d) => d && d.emotion && d.emotion._backfill).length;
// K线重建天（pools_caliber=kline-rebuild）：按真值交叉验证视作有效样本（2026-10-05 拍板），
// 计入回测样本；sampleNote 披露其数量供审计对账（audit B13 断言与档案一致）。
const KLINE_REBUILD_DAYS = (arch.all_days || []).filter((d) => d && d.summary && d.summary.pools_caliber === 'kline-rebuild').length;

// 过拟合防线（2026-10-02 拍板）：实验锚点一律取 params.train（live 冻结，改动唯一通道
// = scripts/promote_params.mjs 样本外门禁）。train 与 live 的差异即「待验证实验参数」，
// 寻优/网格/walk-forward 全部在 train 上做，生产口径（live）不参与扰动扫描。
const TR = config.params.train;
const { assets: ASSETS, gridSteps } = config.backtest; // 标的池/扫描精度非调参对象，留在 backtest 块

// ── 收益覆盖守卫（2026-10-05 诊断事故修复）─────────────────────────────────────
// 事故：archive 的 indexes 只覆盖 33/241 天，其余 208 天被本脚本的 `: 0` 回退按
//   **0 收益日**处理——V5.2 的胜率/夏普/归因全部失真，且当时全部门禁放行（数据
//   缺失是门禁盲区）。缺失必须显式失败，不允许静默填 0 后产出"看似正常"的档。
// 门禁：覆盖率 = 三指数任一有值的天数 / 回测样本天数；低于下限直接 exit 1。
//   下限默认 0.8，可用 BACKTEST_MIN_COVERAGE 环境变量显式放行（如新档案初期
//   数据天然稀缺——放行是运维决策，必须显式留痕，不能是默认行为）。
const COVERED_DAYS = days.filter((d) => ASSETS.some((a) => Number.isFinite(d.indexes?.[a]))).length;
const INDEX_COVERAGE = days.length ? COVERED_DAYS / days.length : 0;
const MIN_COVER = parseFloat(process.env.BACKTEST_MIN_COVERAGE || '0.8');
if (days.length >= 30 && INDEX_COVERAGE < MIN_COVER) {
  console.error(`[backtest] ✗ 指数收益覆盖率 ${COVERED_DAYS}/${days.length}（${(INDEX_COVERAGE * 100).toFixed(1)}%）低于下限 ${(MIN_COVER * 100).toFixed(0)}%：`);
  console.error('    缺失日将被按 0 收益回退——胜率/夏普/归因会系统性失真（详见 2026-10-05 诊断事故）。拒绝生成。');
  console.error('    补救：node scripts/backfill_indexes.mjs（历史缺口回填）；确属预期可用 BACKTEST_MIN_COVERAGE=x 显式放行。');
  process.exit(1);
}
if (INDEX_COVERAGE < 1) {
  console.warn(`[backtest] ⚠ 指数收益覆盖 ${COVERED_DAYS}/${days.length}（${(INDEX_COVERAGE * 100).toFixed(1)}%）——${days.length - COVERED_DAYS} 天按 0 收益回退，指标偏低估市场成分，meta.indexCoverage 已披露`);
}
const TH = TR.thresholds;
const COSTS = TR.costModel;
const { maxPos, stopLoss, ddTrigger, maxPosChg } = TR.stops;
const rolling = TR.lookback.rolling;
const baseW = { ...TR.weights };               // s_net20 / s_pos10 / ...（含档位后缀）
const plainW = {};                             // s_net / s_pos / ...（存档因子键）
for (const [wk, pk] of Object.entries(config.factorKeyMap)) plainW[pk] = baseW[wk];

const pBase = { ...BASE_PARAMS, ...TH };
const pV52 = { ...pBase, maxPos, stopLoss, ddTrigger, maxPosChg, ...COSTS };

// ── 输入序列 ──
const dates = days.map((d) => d.trade_date);
const factorsByDay = days.map((d) => d.emotion?.factors || {});
const retsByAsset = {};
for (const a of ASSETS) {
  retsByAsset[a] = days.map((d) => {
    const v = d.indexes?.[a];
    return Number.isFinite(v) ? v / 100 : 0;   // 存档为百分比 → 小数收益
  });
}
const emotion = days.map((d) => d.emotion?.value ?? null);
const scoredBase = scoreWith(factorsByDay, plainW);
// 自检：用存档情绪分反推权重口径是否一致（不一致说明 config 权重或因子键变了）
const recomputeDrift = emotion.reduce((a, v, i) => (v == null ? a : Math.max(a, Math.abs(v - scoredBase[i]))), 0);

// ── 基准口径 vs V5.2 增强口径 ──
const base = poolBacktest(scoredBase, retsByAsset, pBase);
const v52 = poolBacktest(scoredBase, retsByAsset, pV52);
const navHold = (() => {
  const nav = [];
  let acc = 1;
  for (let i = 0; i < dates.length; i++) {
    const r = ASSETS.reduce((a, k) => a + retsByAsset[k][i], 0) / ASSETS.length;
    acc *= 1 + r;
    nav.push(Math.round(acc * 1e4) / 1e4);
  }
  return nav;
})();

// ── 权重网格 + 帕累托（信号 = 七因子按候选权重重算，非固定情绪分） ──
// 注意：网格权重与因子同为无后缀键（s_net…），与 plainW 同口径
// 网格走 worker 池（src/grid_parallel.js）：与串行 gridSearch 逐位一致（等价性测试锁定），
// 78,125 组从串行数十秒缩到按核数缩减；GRID_WORKERS=1 可退回串行。
const GRID_WORKERS = defaultWorkers();
const scan = await parallelGridSearch(factorsByDay, retsByAsset, plainW, pV52, gridSteps, { workers: GRID_WORKERS });
const pareto = paretoFrontier(scan);
const strip = (r) => ({
  w: Object.fromEntries(Object.entries(r.w).map(([k, v]) => [k, Math.round(v * 1e4) / 1e4])),
  sharpe: Math.round(r.sharpe * 1000) / 1000,
  maxDd: Math.round(r.maxDd * 1e4) / 1e4,
  calmar: Math.round(r.calmar * 1000) / 1000,
  annual: Math.round(r.annual * 1e4) / 1e4,
  total: Math.round(r.total * 1e4) / 1e4,
  winRate: Math.round(r.winRate * 1e4) / 1e4,
  // 盈亏比/索提诺（引擎 src/backtest.js 已算且有 Python 一致性夹具锁定，此前写档漏带——2026-10-02 补）
  profitRatio: Number.isFinite(r.profitRatio) ? Math.round(r.profitRatio * 1000) / 1000 : 999,
  sortino: Math.round(r.sortino * 1000) / 1000,
  emptyRatio: Math.round(r.emptyRatio * 1e4) / 1e4,
});
const best = sortByRank(scan)[0];
// 目标去重：权重微变常落在同一阈值档位平台上 → (夏普,回撤) 完全相同，表格只需一个代表。
// 前沿计数 count 为完整非支配解数；gridRows 为「非支配优先 + 其余按夏普降序」的可读结果表，
// 每行标 np=true/false，即使前沿退化为单点也能一眼看出（本样本两目标同向）。
const pairKey = (r) => `${r.sharpe.toFixed(6)}|${r.maxDd.toFixed(6)}`;
const npKeys = new Set(pareto.map(pairKey));
const uniqMap = new Map();
for (const r of scan) if (!uniqMap.has(pairKey(r))) uniqMap.set(pairKey(r), r);
const uniqRows = [...uniqMap.values()];
const gridRows = [...uniqRows]
  .sort((a, b) => (npKeys.has(pairKey(b)) - npKeys.has(pairKey(a))) || (b.sharpe - a.sharpe))
  .slice(0, 15)
  .map((r) => ({ ...strip(r), np: npKeys.has(pairKey(r)) }));

// ── 滚动样本外（固定权重 vs 逐窗重寻优 walk-forward） ──
const rollBase = rollingTest(factorsByDay, retsByAsset, plainW, pV52, { ...rolling, refit: false });
// refit 每段都要跑一轮全网格——与上面的 scan 共用 worker 池语义（并行版与串行逐位一致）
const rollRefit = await parallelRollingTest(factorsByDay, retsByAsset, plainW, pV52,
  { ...rolling, refit: true, steps: gridSteps }, { workers: GRID_WORKERS });
const segOut = (s) => ({
  testStart: dates[s.testStart], testEnd: dates[s.testEnd - 1],
  trainDays: rolling.trainWindow, testDays: rolling.testWindow,
  total: Math.round(s.total * 1e4) / 1e4, sharpe: Math.round(s.sharpe * 1000) / 1000,
  maxDd: Math.round(s.maxDd * 1e4) / 1e4,
  w: Object.fromEntries(Object.entries(s.w).map(([k, v]) => [k, Math.round(v * 1e4) / 1e4])),
});
// walk-forward 是否真的逐窗换了权重（同权重=退化为固定窗口，需在页面显式说明）
const refitChanged = rollRefit.segments.filter((s, i) => {
  const b = rollBase.segments[i];
  return b && Object.keys(s.w).some((k) => Math.abs(s.w[k] - b.w[k]) > 1e-9);
}).length;

const latest = days[days.length - 1];
// ── 主线识别：滚动窗口动态阈值（2026-10-07）────────────────────────────────
// 废除"无条件取 topN"：题材须达「过去 lookback_days 个交易日最强题材分布的 均值 +
// sigma_multiplier×标准差」才算当日主线。历史样本**不含当日**（用过去分布定今日门槛，
// 防当日突增自我抬高门槛把当日主线自己滤掉）；样本不足 min_sample_days 时
// computeDynamicThreshold 内部降级 fixedFallback（config.mainLine，见 config.json _note）。
// 样本口径与 selectMainLine 的强度分同式：up_count = 当日题材榜第一名的涨停家数，
// density = 该涨停数 ÷ 当日全题材涨停数。
const mlHistory = days.slice(0, -1).map((d) => {
  const entries = Object.entries(d.themes || {}).filter(([, c]) => Number.isFinite(+c));
  const tot = entries.reduce((a, [, c]) => a + (+c), 0) || 1;
  const maxCnt = entries.length ? Math.max(...entries.map(([, c]) => +c)) : 0;
  return { date: d.trade_date, theme_up_count: maxCnt, theme_density: maxCnt / tot };
});
const mlThreshold = computeDynamicThreshold(mlHistory, config.mainLine);
// ── 总阀门（2026-10-07 第二步）：市场/情绪双状态调节主线门槛与输出上限 ──
// ① 市场状态：量能 = summary.amount_yi（两市成交额，亿元）；「指数在均线下方」因
//    archive 无指数点位序列，以「近10日上证累计涨跌 < 0」为趋势代理（index_price=
//    累计涨跌、index_ma=0），口径限制在 config.json::mainLine._note 如实披露。
//    防御：历史不足 10 日或数值缺失 → assessMarketState 内部默认 'normal'。
const GATE_IDX = '上证指数';
const gateWin = days.slice(-11, -1); // 昨日及以前共 10 日（不含当日）
const volHist = gateWin.map((d) => +d.summary?.amount_yi);
const cumIdx = gateWin.reduce((a, d) => a + (+(d.indexes?.[GATE_IDX]) || 0), 0);
const marketState = assessMarketState(
  { volume: +latest.summary?.amount_yi, index_price: cumIdx, index_ma: 0 },
  volHist, config.mainLine);
// ② 情绪状态：昨日主线（旧口径排序第一，无阈值——「昨日龙头是谁」是事实不是门槛）
//    的最强成分股 = 老龙头；看它今日涨跌。无昨日 / 今日 hot 榜找不到该股 → 'stable'。
const yday = days[days.length - 2];
let sentimentState = 'stable';
if (yday) {
  const yMain = selectMainLine(yday, 1).mains[0] || null;
  const yLeader = yMain?.stocks?.[0] || null;
  const yQuote = yLeader ? (latest.hot || []).find((h) => String(h.code) === String(yLeader.code)) : null;
  sentimentState = assessSentimentState(yMain, yQuote ? { changePct: yQuote.change_pct } : null, config.mainLine);
}
// ③ 调节：weak → up 阈值上调 + 输出上限压缩；retreating → density 阈值上调。
//    selectMainLine 本身不动（纯排序逻辑），只喂调节后的阈值与 topN。
const gated = applyMainLineGating(mlThreshold, { market_state: marketState, sentiment_state: sentimentState }, config.mainLine);
const mainLineTopN = gated.maxOutput != null ? Math.min(2, gated.maxOutput) : 2;
const mainLine = selectMainLine(latest, mainLineTopN, gated.threshold);
mainLine.gating = {
  market_state: marketState, sentiment_state: sentimentState,
  max_output: mainLineTopN,
  base_up_count_threshold: mlThreshold.up_count_threshold,
  base_density_threshold: mlThreshold.density_threshold,
};
// ── 仓位管理（2026-10-07 第三步）：ATR 波动分档 → 建议仓位权重 ──
// 口径限制（如实披露）：archive 无个股日内高低价，唯一可得序列 = 每日热点榜快照的
// close。故对「最新日起连续 atr_period+1 日在榜」的标的，用 close 序列构造
// highs=lows=closes 的退化 K 线——TR 退化为 |Δclose|，ATR 即「收盘价真实波幅」的
// Wilder 平滑（方向性与真 ATR 一致，量级略低估）。断档/在榜不足 period+1 日 →
// 该标的 atr 为 null（unknown 档，权重取 mid 默认）。采集管线补齐个股 K 线后，
// 只需替换下面的 atrHistory 构造，分档与权重逻辑零改动。
const ATR_PERIOD = Number.isInteger(+config.mainLine.atr_period) && +config.mainLine.atr_period >= 1
  ? +config.mainLine.atr_period : 10;
const atrHistory = {};
for (const mn of mainLine.mains) {
  for (const st of mn.stocks || []) {
    if (!st?.code || atrHistory[st.code]) continue;
    const closes = [];
    for (let i = days.length - 1; i >= 0 && closes.length < ATR_PERIOD + 1; i--) {
      const hit = (days[i].hot || []).find((h) => String(h.code) === String(st.code));
      if (!hit || !Number.isFinite(+hit.close)) break; // 断档即止（连续口径）
      closes.unshift(+hit.close);
    }
    if (closes.length >= ATR_PERIOD + 1) {
      atrHistory[st.code] = { highs: closes, lows: closes, closes };
    }
  }
}
for (const mn of mainLine.mains) {
  mn.stocks = assignPositionWeights(mn.stocks, atrHistory, config.mainLine);
}
const nGrid = scan.length; // 网格行数 = weightGrid 组合数（免再生成一遍 78k 对象只为计数）

// ── V5.3 动态仓位对照（P1-2：市场状态 → 仓位区间，情绪打分仍是信号主路径） ──
// regime 逐日档位用**存档综合分**（emotion.value + pct_rank，与页面同口径）——
// 回测信号是 train 权重重算分，但市场状态的判定对象是市场本身，用存档综合分才对齐
// 前端 regime 面板。宽度判据（buildRegimeBlock 的 shift 触发源之一）在此不传：
// 逐日宽度序列不在 archive.json，坚持"缺=不假装"，shift 只由高潮末段/无触发，
// 宽度背离贡献位缺失在 note 披露（样本语义偏保守方向——少触发切换期=帽子偏高）。
const regimeDays = days.map((d) => ({
  trade_date: d.trade_date,
  value: d.emotion ? d.emotion.value : null,
  pct_rank: d.emotion ? d.emotion.pct_rank : null,
  seal_pct: d.summary ? d.summary.seal_pct : null,
}));
const regimeSeries = classifySeries(regimeDays);
const regimeCounts = {};
regimeSeries.forEach((s) => { regimeCounts[s.key] = (regimeCounts[s.key] || 0) + 1; });
// 帽子数组：档位区间上限（position_policy 唯一出处）；unknown → null（引擎不压制，
// 缺失显式化——不拿保守 0.2 假装有意见，天数在 note 对账）
const maxPosByDay = regimeSeries.map((s) => {
  const b = bandFor(s.key);
  return b ? b.maxPos : null;
});
const pV53 = { ...pV52, confirmDays: 1, maxPosByDay };
const v53 = poolBacktest(scoredBase, retsByAsset, pV53);

// ── V5.3 止盈对照（P1-1：分批/移动两种模式可切换，在 v53 信号+帽子基础上叠加） ──
// 参数即夹具口径（test/fixtures/parity_v52.json 的 tp 段同款），跨语言逐位锁定：
//   · partial：+8% 减半、+15% 清仓（档位只升不降，腿结束重置）
//   · trailing：浮盈 ≥5% 激活后，自峰值回撤 ≥30% 离场（浮亏阶段不越权、归止损管）
const pV53tpP = { ...pV53, takeProfit: { mode: 'partial', ladder: [[1.08, 0.5], [1.15, 0]] } };
const pV53tpT = { ...pV53, takeProfit: { mode: 'trailing', trail: 0.3, activate: 1.05 } };
const v53tpP = poolBacktest(scoredBase, retsByAsset, pV53tpP);
const v53tpT = poolBacktest(scoredBase, retsByAsset, pV53tpT);

const payload = {
  meta: {
    // 取存档的数据生成时间，而非本次运行时间：archive 未变时 backtest.json 不因时间戳而变，
    // 避免 Actions 每次运行都产生无意义的 chore 提交（噪音会掩盖真实变化）。
    generatedAt: arch.meta?.generatedAt || new Date().toISOString(),
    formulaVersion: 'v5.2-pro',
    tradeDate: arch.meta?.tradeDate || dates[dates.length - 1],
    days: dates.length,
    assets: ASSETS,
    signal: '七因子加权情绪分（权重取 src/config.js weights，与页面 emotion.value 同口径）',
    costNote: `佣金 ${COSTS.comm}（双边）· 印花税 ${COSTS.stamp}（卖出）· 滑点 ${COSTS.slip}；按仓位变动幅度计提`,
    caveat: `样本仅 ${dates.length} 个交易日，年化/夏普等指标的统计意义有限，仅用于管线自检与参数对比，不构成投资建议。`
      + (BACKFILL_EXCLUDED ? ` 已排除 ${BACKFILL_EXCLUDED} 个历史回填天（只有 s_net、无六因子，不可用于回测）。` : ''),
    // 回测样本口径留痕：档案总天数 ≠ 回测样本数，两者必须能对上账
    sampleNote: {
      archiveDays: (arch.all_days || []).length,
      backtestDays: dates.length,
      excludedBackfillDays: BACKFILL_EXCLUDED,
      klineRebuildDays: KLINE_REBUILD_DAYS,
    },
    weightDrift: Math.round(recomputeDrift * 1e4) / 1e4,
    // 收益覆盖（守卫配套披露）：缺失日按 0 收益回退会系统性扭曲胜率/夏普/归因，
    // 覆盖率必须进档（契约：schemas/backtest.schema.json meta.indexCoverage）。
    indexCoverage: {
      coveredDays: COVERED_DAYS,
      totalDays: days.length,
      ratio: Math.round(INDEX_COVERAGE * 1e4) / 1e4,
    },
  },
  params: {
    thresholds: TH, base: pBase, v52: pV52, weights: plainW, gridSteps, scanned: nGrid, rolling,
  },
  series: {
    dates,
    emotion: emotion.map((v) => (v == null ? null : Math.round(v * 10) / 10)),
    navBase: base.perf.nav.map((v) => Math.round(v * 1e4) / 1e4),
    navV52: v52.perf.nav.map((v) => Math.round(v * 1e4) / 1e4),
    navV53: v53.perf.nav.map((v) => Math.round(v * 1e4) / 1e4),
    navHold,
    posV52: v52.pos.map((v) => Math.round(v * 100) / 100),
    posV53: v53.pos.map((v) => Math.round(v * 100) / 100),
  },
  base: { ...strip({ w: plainW, ...base.perf }), nav: undefined },
  v52: { ...strip({ w: plainW, ...v52.perf }), nav: undefined },
  // V5.3 动态仓位口径：右侧二次确认（confirmDays=1，半仓档开仓需连续 2 日信号）
  // + regime 逐日帽子（position_policy 区间上限）。与 v52 同信号同成本，差异即
  // "市场状态控仓 + 右侧进场"的净贡献。前端渲染下一批接入，本段先供审计。
  v53: {
    ...strip({ w: plainW, ...v53.perf }), nav: undefined,
    params: { confirmDays: 1, maxPosByDaySource: 'src/position_policy.js（regime 档位区间上限）' },
    regimeCounts,
    unknownDays: regimeCounts.unknown || 0,
    note: '逐日宽度序列不在 archive（shift 的背离触发源缺失），本段 shift 仅由高潮末段触发，'
      + '语义偏保守（少触发切换期=帽子偏高）；unknown 日帽子为 null 不压制（天数见 unknownDays）。'
      + 'regime 判定用存档综合分（与前端面板同口径），非 train 权重重算分。',
  },
  // V5.3 止盈口径（P1-1）：在 v53（确认+帽子）基础上叠加，两模式并列供切换对比。
  // 与 v53 同信号同成本同帽子，差异即止盈机制的净贡献（腿生命周期：累计涨幅/峰值回撤）。
  // triggeredDays = 与 v53 仓位序列的差异数（止盈实际介入的天数）——零触发时如实
  // 归零并披露原因，不假装有贡献（本样本实测：指数腿峰值 +1.6%，远低于 5% 激活线）。
  v53tpPartial: {
    ...strip({ w: plainW, ...v53tpP.perf }), nav: undefined,
    params: { mode: 'partial', ladder: [[1.08, 0.5], [1.15, 0]], semantics: '持仓腿累计涨幅 +8% 压半仓、+15% 清仓；档位只升不降，清仓后信号仍满足则按普通规则重开' },
    triggeredDays: v53tpP.pos.filter((v, i) => Math.abs(v - v53.pos[i]) > 1e-12).length,
    note: '止盈的用武之地在个股语义（腿波动大、8%/回撤 30% 可达）；指数池回测里腿峰值'
      + '通常 <5%——与单笔止损同款边界：机制已实现并跨语言锁定，但本样本零触发属常态而非失效。',
  },
  v53tpTrail: {
    ...strip({ w: plainW, ...v53tpT.perf }), nav: undefined,
    params: { mode: 'trailing', trail: 0.3, activate: 1.05, semantics: '浮盈 ≥5% 激活后，自持仓峰值回撤 ≥30% 次日离场（浮亏阶段不越权、归止损管）；离场不受仓位平滑约束' },
    triggeredDays: v53tpT.pos.filter((v, i) => Math.abs(v - v53.pos[i]) > 1e-12).length,
    note: '同 v53tpPartial.note：零触发=指数腿无足够浮盈可保护，机制中性（无害）且已由夹具锁定语义。',
  },
  best: strip(best),
  pareto: {
    count: pareto.length, uniqueCount: uniqRows.length, scanned: scan.length,
    note: pareto.length <= 1
      ? `本样本内两目标同向：最小回撤组合同时是最高夏普组合，非支配解集退化为 ${pareto.length} 个（样本 ${dates.length} 日，参数分辨力有限）`
      : `扫描 ${scan.length} 组、去重后 ${uniqRows.length} 个不同结果，非支配解 ${pareto.length} 个`,
    rows: gridRows,
  },
  rolling: {
    refitChangedSegments: refitChanged,
    base: { sharpeMean: Math.round(rollBase.sharpeMean * 1000) / 1000, ddWorst: Math.round(rollBase.ddWorst * 1e4) / 1e4, winSegPct: Math.round(rollBase.winSegPct * 1e4) / 1e4, segments: rollBase.segments.map(segOut) },
    refit: { sharpeMean: Math.round(rollRefit.sharpeMean * 1000) / 1000, ddWorst: Math.round(rollRefit.ddWorst * 1e4) / 1e4, winSegPct: Math.round(rollRefit.winSegPct * 1e4) / 1e4, segments: rollRefit.segments.map(segOut) },
  },
  mainLine,
};

atomicWriteJSON(OUT, JSON.stringify(payload, null, 1));
console.log(`[backtest] ${dates.length} 个交易日 · 标的 ${ASSETS.join('/')}`);
console.log(`[backtest] 基准年化 ${(base.perf.annual * 100).toFixed(2)}% 回撤 ${(base.perf.maxDd * 100).toFixed(2)}% 夏普 ${base.perf.sharpe}`);
console.log(`[backtest] V5.2 年化 ${(v52.perf.annual * 100).toFixed(2)}% 回撤 ${(v52.perf.maxDd * 100).toFixed(2)}% 夏普 ${v52.perf.sharpe}`);
console.log(`[backtest] V5.3 年化 ${(v53.perf.annual * 100).toFixed(2)}% 回撤 ${(v53.perf.maxDd * 100).toFixed(2)}% 夏普 ${v53.perf.sharpe}（regime 帽子 ${JSON.stringify(regimeCounts)}）`);
console.log(`[backtest] V5.3+止盈分批 年化 ${(v53tpP.perf.annual * 100).toFixed(2)}% 回撤 ${(v53tpP.perf.maxDd * 100).toFixed(2)}% 夏普 ${v53tpP.perf.sharpe}；+移动 年化 ${(v53tpT.perf.annual * 100).toFixed(2)}% 回撤 ${(v53tpT.perf.maxDd * 100).toFixed(2)}% 夏普 ${v53tpT.perf.sharpe}`);
console.log(`[backtest] 网格 ${nGrid} 组（worker×${GRID_WORKERS}） → 帕累托非支配 ${pareto.length} 组（去重 ${uniqRows.length}）；滚动 ${rollBase.segments.length} 段，其中重寻优换了权重的段 ${refitChanged}/${rollRefit.segments.length}`);
console.log(`[backtest] 主线：${mainLine.mains.map((m) => `${m.theme}(${m.themeCount})`).join('、')} · 权重口径偏差 ${payload.meta.weightDrift}`);
console.log(`[backtest] 写出 ${OUT}`);
