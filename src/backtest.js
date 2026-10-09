// V5.2 回测引擎（Node ESM，纯函数、零依赖）
// 语义与 tools/backtest/sentiment_backtest.py 严格对齐，并由 test/backtest.test.mjs 的
// 跨语言一致性用例守护（夹具 test/fixtures/parity_v52.json 由 Python 侧生成）。
// 关键规格：T+1 生效 / 四档阈值 / 过热只减仓不新建 / 止损优先于仓位平滑 /
//           回撤动态降仓 / 交易成本按仓位变动幅度计提。
// 本文件供 scripts/backtest.mjs（服务端预生成 data/backtest.json）与单测使用；
// 浏览器端只渲染预生成结果，因此前端无需打包构建。

export const ANN = 252; // 年化系数

// 默认阈值：与 src/config.js 五档风险分界一致（≥80 过热 / ≥65 持有 / 44~65 减仓 / ≤24 清仓）
export const DEFAULT_TH = { panic: 24, hi: 44, lo: 65, overheat: 80 };

// 基准参数：V5 原始口径（满仓、无风控、无成本、不平滑）
export const BASE_PARAMS = {
  panic: DEFAULT_TH.panic, hi: DEFAULT_TH.hi, lo: DEFAULT_TH.lo, overheat: DEFAULT_TH.overheat,
  maxPos: 1.0, stopLoss: 0, ddTrigger: 0, maxPosChg: 0,
  comm: 0, stamp: 0, slip: 0,
};

// V5.2 增强参数：交易成本 + 仓位平滑 + 单笔止损 + 回撤动态降仓（A股实际口径）
export const V52_PARAMS = {
  ...BASE_PARAMS,
  maxPos: 1.0, stopLoss: -0.08, ddTrigger: -0.15, maxPosChg: 0.2,
  comm: 0.0003, stamp: 0.0005, slip: 0.0002,
};

const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

// ────────────────────────── 仓位（收盘打分 → 次日仓位） ──────────────────────────
// V5.3 新增三个可选参数（默认关闭，confirmDays=0 / maxPosByDay=null / takeProfit=null
// 时与旧版逐位一致，Python parity 夹具锁的是默认行为；新语义由夹具的 v53 参数组锁定）：
//   · confirmDays（右侧二次确认）：从空仓进入**半仓档**（panic<v<lo 的左侧回升区）
//     需要连续 confirmDays+1 日信号成立——第一日只记账不开仓，杜绝"接飞刀"。
//     只作用于半仓档开仓：v≥lo 是趋势强信号（右侧本身），止损/过热/清仓路径不受影响。
//   · maxPosByDay（regime 逐日仓位帽子）：市场状态（src/position_policy.js 的区间
//     上限）逐日压制 cap——与回撤降仓取更紧者（min）；情绪打分仍是信号主路径，
//     帽子只做仓位上限（"信号归信号、帽子归帽子"）。
//   · takeProfit（止盈，V5.3 P1）：两种模式可切换——
//     partial（分批止盈）：持仓腿累计涨幅 legCum≥ladder[k][0] → cap 压至
//       ladder[k][1]×maxPos（档位只升不降；[1.08,0.5] 即 +8% 减半、[1.15,0] 再清仓）。
//     trailing（移动止盈）：legCum 自峰值回撤 ≥trail 且峰值已到 activate（浮盈激活线，
//       浮亏阶段是止损的职责、不越权）→ 次日清仓，不受仓位平滑约束（风控优先）。
//     腿状态（legCum/legPeak/tpTier）在 prevTarget===0 的空仓日重置——止盈清仓后
//     信号仍满足则按普通开仓规则重进（止盈不锁死再入场），重进是新腿从 1 计。
export function positions(scores, rets, p = BASE_PARAMS) {
  const {
    hi = DEFAULT_TH.hi, lo = DEFAULT_TH.lo,
    panic = DEFAULT_TH.panic, overheat = DEFAULT_TH.overheat,
    maxPos = 1.0, stopLoss = 0, ddTrigger = 0, maxPosChg = 0,
    confirmDays = 0, maxPosByDay = null, takeProfit = null,
  } = p;
  const tpLadder = takeProfit && takeProfit.mode === 'partial' && Array.isArray(takeProfit.ladder)
    ? takeProfit.ladder : null;
  const tpTrail = takeProfit && takeProfit.mode === 'trailing'
    ? { trail: takeProfit.trail ?? 0.3, activate: takeProfit.activate ?? 1.05 } : null;
  const tpOn = !!(tpLadder || tpTrail); // mode 非法/none → 全部新逻辑旁路（零行为差异）
  const n = scores.length;
  const raw = new Array(n).fill(0);
  let held = false;
  let eq = 1, peak = 1, prevTarget = 0;
  let pending = 0; // 空仓期连续满足 v>panic 的天数（右侧二次确认的计数器）
  let legCum = 1; // 持仓腿累计价格路径（开仓生效日起 ∏(1+r)）
  let legPeak = 1; // 持仓期峰值（移动止盈基准）
  let tpTier = 0; // 分批止盈已触发档数（只升不降；0=未触发）
  for (let i = 0; i < n; i++) {
    const v = scores[i];
    if (rets) { // 当日收盘：先结算昨日目标仓位在当日的盈亏（无前视）
      eq *= 1 + prevTarget * rets[i];
      peak = Math.max(peak, eq);
    }
    // 空仓日（昨日决定空仓）→ 持仓腿结束，腿状态重置：
    // 重置必须在止盈判定/cap 压制**之前**——否则旧腿档位会压制当日的新开仓决定
    if (tpOn && prevTarget === 0) { legCum = 1; legPeak = 1; tpTier = 0; }
    // 持仓腿价格路径累积（今日是持仓日才计——T+1 口径与 eq 结算一致）
    if (tpOn && rets && prevTarget > 0) {
      legCum *= 1 + rets[i];
      legPeak = Math.max(legPeak, legCum);
    }
    let cap = maxPos;
    if (ddTrigger < 0 && rets) { // 回撤动态降仓（类凯利）
      const curDd = 1 - eq / peak;
      if (curDd >= -ddTrigger) cap = 0.4 * maxPos;
      else if (curDd >= 0.6 * -ddTrigger) cap = 0.7 * maxPos;
    }
    // regime 逐日帽子：与回撤降仓取更紧者（缺失日不压制——缺失显式化在调用方，
    // 引擎层拿不到帽子数据时不假装有帽子）。⚠ null 必须先判再转数值：
    // +null === 0 会把"缺帽子"静默当"帽子 0"（dirty.js::num 同款陷阱，实测踩过）。
    if (maxPosByDay != null && i < maxPosByDay.length
        && maxPosByDay[i] != null && Number.isFinite(+maxPosByDay[i])) {
      cap = Math.min(cap, Math.max(0, +maxPosByDay[i]));
    }
    // 分批止盈档位升级（只升不降，while 防单日跳档：涨逾两档阈值时连升）
    if (tpLadder && held) {
      while (tpTier < tpLadder.length && legCum >= tpLadder[tpTier][0]) tpTier++;
    }
    // 分批止盈档位压制：已触发档的系数×maxPos 与各帽子取更紧（dd/regime 同 min 语义）
    if (tpLadder && tpTier > 0) cap = Math.min(cap, tpLadder[tpTier - 1][1] * maxPos);
    // 移动止盈：浮盈激活后才跟踪回撤（浮亏阶段归止损管，不越权）
    let trailHit = false;
    if (tpTrail && held && legPeak >= tpTrail.activate) {
      if (1 - legCum / legPeak >= tpTrail.trail) trailHit = true;
    }
    const stopHit = stopLoss < 0 && held && rets && rets[i] <= stopLoss;
    // 右侧二次确认计数：空仓期 v>panic 连续天数（含强信号日，但强信号日不走半仓档
    // 不消费计数）；一旦 v<=panic 归零重数（反转中断则重新确认）
    if (v > panic && !held) pending++;
    else pending = 0;
    let target;
    if (stopHit || trailHit) target = 0;          // 止损/移动止盈：风控优先于信号
    else if (v >= overheat) target = held ? cap : 0; // 过热只减仓不新建
    else if (v >= lo) target = cap;
    // ⚠ 确认只拦"空仓进场"（held 或已连续确认才给半仓）：持仓中的半仓减仓**不受**确认
    //   约束。第一版漏了 held 条件——持仓中 pending 恒 0，把"半仓持有"误清仓，
    //   confirmDays=0 时也触发（base/v52 全序列漂移）。跨语言夹具两侧同错测不出
    //   （夹具由同版 Python 生成），此类"默认行为不变"约束必须配行为锚单测。
    else if (v > panic) target = (held || pending > confirmDays) ? 0.5 * cap : 0;
    else target = 0;
    if (maxPosChg > 0 && !stopHit && !trailHit) { // 仓位平滑：止损/移动止盈不受约束
      target = clamp(target, prevTarget - maxPosChg, prevTarget + maxPosChg);
    }
    held = target > 0;
    raw[i] = target;
    prevTarget = target;
  }
  return raw.map((_, i) => (i === 0 ? 0 : raw[i - 1])); // T+1 生效
}

// ────────────────────────── 交易成本 ──────────────────────────
export function turnoverCost(pos, p = BASE_PARAMS) {
  const { comm = 0, stamp = 0, slip = 0 } = p;
  const n = pos.length;
  const cost = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const chg = i === 0 ? pos[0] : pos[i] - pos[i - 1];
    if (chg > 0) cost[i] = chg * (comm + slip);                    // 买入：佣金+滑点
    else if (chg < 0) cost[i] = -chg * (comm + stamp + slip);      // 卖出：佣金+印花税+滑点
  }
  return cost;
}

// ────────────────────────── 绩效指标 ──────────────────────────
export function metrics(strat, pos, opens, rf = 0) {
  const n = strat.length;
  const nav = [];
  let acc = 1;
  for (const s of strat) { acc *= 1 + s; nav.push(acc); }
  const total = nav[n - 1] - 1;
  const annual = n > 0 && total > -1 ? (1 + total) ** (ANN / n) - 1 : -1;
  let runPeak = -Infinity, maxDd = 0;
  for (const v of nav) { runPeak = Math.max(runPeak, v); maxDd = Math.max(maxDd, 1 - v / runPeak); }
  const mean = strat.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(strat.reduce((a, b) => a + (b - mean) ** 2, 0) / n); // ddof=0
  const excessMean = mean - rf / ANN;                                        // 夏普计入无风险利率
  const sharpe = sd > 1e-12 ? (excessMean / sd) * Math.sqrt(ANN) : 0;
  let heldN = 0, heldWin = 0, gain = 0, loss = 0, negN = 0, negSq = 0;
  for (let i = 0; i < n; i++) {
    const s = strat[i];
    if (pos[i] > 0) { heldN++; if (s > 0) heldWin++; }
    if (s > 0) gain += s; else if (s < 0) { loss += -s; negN++; }
  }
  const negMean = negN ? -loss / negN : 0;
  for (const s of strat) if (s < 0) negSq += (s - negMean) ** 2;
  const negSd = negN ? Math.sqrt(negSq / negN) : 0;
  const winRate = heldN ? heldWin / heldN : 0;
  const profitRatio = loss > 1e-12 ? gain / loss : Infinity;
  const calmar = maxDd > 1e-9 ? annual / maxDd : 999;
  const sortino = negN > 1 && negSd > 1e-12 ? (excessMean / negSd) * Math.sqrt(ANN) : 999;
  let mcl = 0, run = 0; // 最大连续亏损天数（游程计数）
  for (const s of strat) { run = s < 0 ? run + 1 : 0; mcl = Math.max(mcl, run); }
  const emptyRatio = pos.filter((x) => x === 0).length / n;
  return {
    total, annual, maxDd, sharpe, winRate,
    profitRatio: Number.isFinite(profitRatio) ? profitRatio : 999,
    heldDays: heldN, emptyRatio, opens, calmar, sortino, maxConsecLoss: mcl, nav,
  };
}

// 优化优先级：回撤最小 → 夏普最高 → 年化最高（与 Python rank_key 一致）
export const rankKey = (m) => [m.maxDd, -m.sharpe, -m.annual];

export function sortByRank(rows) {
  return [...rows].sort((a, b) => {
    const ka = rankKey(a), kb = rankKey(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return 0;
  });
}

// ────────────────────────── 单标的 / 多标的回测 ──────────────────────────
export function runBacktest(scores, rets, p = BASE_PARAMS, rf = 0) {
  const pos = positions(scores, rets, p);
  const cost = turnoverCost(pos, p);
  const strat = rets.map((r, i) => r * pos[i] - cost[i]);
  let opens = 0;
  for (let i = 0; i < pos.length; i++) if (pos[i] > 0 && (i === 0 || pos[i - 1] === 0)) opens++;
  return { pos, strat, perf: metrics(strat, pos, opens, rf) };
}

// 多标的等权轮动：逐标的按同规则回测 → 日收益等权合成（对齐 Python pool_strat）
export function poolBacktest(scores, retsByAsset, p = BASE_PARAMS, rf = 0) {
  const assets = Object.keys(retsByAsset);
  const n = scores.length;
  const strat = new Array(n).fill(0);
  const pos = new Array(n).fill(0);
  let opens = 0;
  for (const a of assets) {
    const r = runBacktest(scores, retsByAsset[a], p, rf);
    for (let i = 0; i < n; i++) { strat[i] += r.strat[i] / assets.length; pos[i] += r.pos[i] / assets.length; }
    opens += r.perf.opens;
  }
  return { strat, pos, perf: metrics(strat, pos, opens, rf) };
}

// ────────────────────────── 网格寻优 + 帕累托双目标 ──────────────────────────
// 权重网格：以基准权重为锚做倍数扰动后归一化（七因子权重和为 1）
export function weightGrid(baseWeights, steps = [0.8, 1.0, 1.2]) {
  const keys = Object.keys(baseWeights);
  let acc = [{}];
  for (const k of keys) {
    const next = [];
    for (const combo of acc) for (const s of steps) next.push({ ...combo, [k]: baseWeights[k] * s });
    acc = next;
  }
  return acc.map((c) => {
    const sum = Object.values(c).reduce((a, b) => a + b, 0);
    const out = {};
    for (const k of keys) out[k] = c[k] / sum;
    return out;
  });
}

// 七因子加权打分（与 pipeline 的 emotion.value 同口径：factor 已是 0~100，权重和为 1）
// 权重键必须能命中因子键——config.weights 带档位后缀（s_net20），存档因子键无后缀（s_net），
// 调用方需先经 config.factorKeyMap 转换；一个都命中则直接报错，避免静默全 0 分。
export function scoreWith(factorsByDay, w) {
  const wKeys = Object.keys(w);
  const fKeys = factorsByDay[0] ? Object.keys(factorsByDay[0]) : [];
  const hit = wKeys.filter((k) => fKeys.includes(k));
  if (fKeys.length && !hit.length) {
    throw new Error(`scoreWith: 权重键与因子键不匹配（权重键 ${wKeys.join(',')} / 因子键 ${fKeys.join(',')}）`);
  }
  const use = hit.length ? hit : wKeys;
  return factorsByDay.map((f) => {
    let s = 0;
    for (const k of use) s += (f[k] ?? 0) * w[k];
    return s;
  });
}

export function gridSearch(factorsByDay, retsByAsset, baseWeights, p = BASE_PARAMS, steps) {
  const rows = [];
  for (const w of weightGrid(baseWeights, steps)) {
    const scores = scoreWith(factorsByDay, w);
    const { perf } = poolBacktest(scores, retsByAsset, p);
    rows.push({ w, ...perf, nav: undefined });
  }
  return sortByRank(rows);
}

// 双目标帕累托非支配解集：最大化夏普、最小化最大回撤（严格支配判定）
export function paretoFrontier(rows, obj1 = 'sharpe', obj2 = 'maxDd') {
  const d = rows.map((r, i) => ({ i, v1: r[obj1], v2: r[obj2], r }));
  d.sort((a, b) => (a.v2 - b.v2) || (b.v1 - a.v1));
  const eff = new Set();
  let runMax1 = -Infinity, i = 0;
  while (i < d.length) {
    let j = i, groupMax1 = -Infinity;
    while (j < d.length && d[j].v2 === d[i].v2) { // 同一 obj2 组内互不支配
      if (d[j].v1 > runMax1) eff.add(d[j].i);
      groupMax1 = Math.max(groupMax1, d[j].v1);
      j++;
    }
    runMax1 = Math.max(runMax1, groupMax1);
    i = j;
  }
  return rows.filter((_, idx) => eff.has(idx)).sort((a, b) => b.calmar - a.calmar);
}

// ────────────────────────── 滚动样本外（walk-forward） ──────────────────────────
// refit=false：固定权重按 test 窗切段评估；refit=true：每段用训练窗重寻优权重再评估测试窗
export function rollingTest(factorsByDay, retsByAsset, baseWeights, p = BASE_PARAMS,
                            { trainWindow = 20, testWindow = 6, refit = false, steps } = {}) {
  const n = factorsByDay.length;
  const segs = [];
  for (let start = 0; start + trainWindow + testWindow <= n; start += testWindow) {
    const trEnd = start + trainWindow, teEnd = trEnd + testWindow;
    const fTr = factorsByDay.slice(start, trEnd), fTe = factorsByDay.slice(trEnd, teEnd);
    const rTr = {}, rTe = {};
    for (const a of Object.keys(retsByAsset)) {
      rTr[a] = retsByAsset[a].slice(start, trEnd);
      rTe[a] = retsByAsset[a].slice(trEnd, teEnd);
    }
    let w = baseWeights;
    if (refit) {
      const best = sortByRank(weightGrid(baseWeights, steps).map((cand) => {
        const { perf } = poolBacktest(scoreWith(fTr, cand), rTr, p);
        return { w: cand, ...perf, nav: undefined };
      }))[0];
      w = best.w;
    }
    const { perf } = poolBacktest(scoreWith(fTe, w), rTe, p);
    segs.push({ trainStart: start, testStart: trEnd, testEnd: teEnd, w, ...perf });
  }
  const withFinite = segs.filter((s) => Number.isFinite(s.sharpe));
  const sharpeMean = withFinite.length
    ? withFinite.reduce((a, s) => a + s.sharpe, 0) / withFinite.length : 0;
  const ddWorst = segs.length ? Math.max(...segs.map((s) => s.maxDd)) : 0;
  const winSegPct = segs.length ? segs.filter((s) => s.total > 0).length / segs.length : 0;
  return { segments: segs, sharpeMean, ddWorst, winSegPct };
}

// ────────────────────────── 主线自动选股（当日） ──────────────────────────
// 口径：题材榜按涨停家数取主线 → 用热点榜该题材成分股作标的清单（与页面 scoreMainStructure 同源）；
// 强度分 = 主线涨停家数 × 题材密集度（该题材涨停数 ÷ 全题材涨停数），形态对齐 Python find_main_line
// （涨停家数 × 涨停密度），数据源不同故绝对量级不可直接比较。

/**
 * 主线识别动态阈值（2026-10-07）：滚动窗口 = 「过去 N 个交易日最强题材」的分布，
 * 当日门槛 = 均值 + sigma_multiplier × 标准差。冷市分布低 → 门槛自适应下移（弱市也能
 * 识别出相对强的主线）；热市分布高 → 门槛上移（题材烂大街的交易日不滥竽充数）。
 * 纯函数（不碰缓存/降级/采样器），输入输出完全显式，可独立单测。
 *
 * @param {{date: string, theme_up_count: number, theme_density: number}[]} historyData
 *   历史样本（升序，尾端最新；调用方负责剔除当日——用过去分布定今日门槛）。
 *   theme_up_count = 当日题材榜第一名的涨停家数；theme_density = 其涨停数 ÷ 当日全题材涨停数
 *   （与 selectMainLine 的 density 同式）。
 * @param {{lookback_days: number, sigma_multiplier: number, min_sample_days: number,
 *          fixedFallback?: {up_count_threshold: number, density_threshold: number}}} config
 * @returns {{up_count_threshold: number, density_threshold: number, mode: 'dynamic'|'fallback',
 *            samples: number, window?: {up_mean: number, up_std: number, dn_mean: number, dn_std: number}}}
 *   有效样本 < min_sample_days → 降级返回 fixedFallback（mode='fallback'，前端如实披露）。
 */
export function computeDynamicThreshold(historyData, config) {
  const fb = (config && config.fixedFallback) || { up_count_threshold: 6, density_threshold: 0.1 };
  const lookback = Math.max(1, +config?.lookback_days || 60);
  const sigma = +config?.sigma_multiplier;
  const sigmaMul = Number.isFinite(sigma) && sigma >= 0 ? sigma : 1.0;
  const minSample = Math.max(1, +config?.min_sample_days || 20);

  const arr = Array.isArray(historyData) ? historyData : [];
  const win = arr.slice(-lookback).filter((d) => d
    && Number.isFinite(+d.theme_up_count) && Number.isFinite(+d.theme_density));

  if (win.length < minSample) {
    return {
      up_count_threshold: Math.max(0, +fb.up_count_threshold || 0),
      density_threshold: Math.min(1, Math.max(0, +fb.density_threshold || 0)),
      mode: 'fallback', samples: win.length,
    };
  }

  const stat = (pick) => {
    const xs = win.map(pick);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    // 总体标准差（÷N）：单样本时 std=0（阈值退化为均值），避免样本 std（÷N-1）的 N=1 NaN
    const std = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
    return { mean, std };
  };
  const up = stat((d) => +d.theme_up_count);
  const dn = stat((d) => +d.theme_density);
  // clamp ≥ 0：全零历史 → 阈值 0（不为负）；density 另 clamp ≤ 1（占比语义）
  return {
    up_count_threshold: Math.max(0, up.mean + sigmaMul * up.std),
    density_threshold: Math.min(1, Math.max(0, dn.mean + sigmaMul * dn.std)),
    mode: 'dynamic', samples: win.length,
    window: {
      up_mean: up.mean, up_std: up.std, dn_mean: dn.mean, dn_std: dn.std,
    },
  };
}

/**
 * 总阀门①：市场状态评估（纯函数，2026-10-07 第二步）。
 * 量能弱势 = 今日成交额 < 过去10日均值 × market_weak_volume_ratio；
 * 指数弱势 = 指数点位 < 均线（接入层负责把真实数据换算成这两个数值——archive 无点位
 * 序列，生产接入以「近10日累计涨跌 < 0」为趋势代理，见 scripts/backtest.mjs）。
 * 两者皆弱 → 'weak'；仅其一 → 'normal'；均不弱 → 'strong'。
 * market_weak_index_below_ma=false → 指数条件不参与，量能弱势单独即判 weak。
 * 防御：历史成交额不足 10 条或数值非法 → 'normal'（不猜、不报错）。
 *
 * @param {{volume?: number, index_price?: number, index_ma?: number}} todayMarketData
 * @param {number[]} historyMarketData 过去10日成交额
 * @param {{market_weak_volume_ratio?: number, market_weak_index_below_ma?: boolean}} config
 * @returns {'strong' | 'normal' | 'weak'}
 */
export function assessMarketState(todayMarketData, historyMarketData, config) {
  const ratio = +config?.market_weak_volume_ratio > 0 ? +config.market_weak_volume_ratio : 0.8;
  const useIndex = config?.market_weak_index_below_ma !== false; // 缺省 true：指数条件参与
  const hist = Array.isArray(historyMarketData)
    ? historyMarketData.filter((v) => Number.isFinite(+v)) : [];
  const todayVol = +todayMarketData?.volume;
  // 历史不足 10 条 → 默认 normal（规格：不报错、不猜）
  if (hist.length < 10 || !Number.isFinite(todayVol)) return 'normal';
  const avg10 = hist.reduce((a, b) => a + b, 0) / hist.length;
  const volWeak = todayVol < avg10 * ratio;
  const idxWeak = Number.isFinite(+todayMarketData.index_price)
    && Number.isFinite(+todayMarketData.index_ma)
    && +todayMarketData.index_price < +todayMarketData.index_ma;
  if (!useIndex) return volWeak ? 'weak' : 'strong'; // 指数条件关闭 → 退化单条件判定
  if (volWeak && idxWeak) return 'weak';
  if (volWeak || idxWeak) return 'normal';
  return 'strong';
}

/**
 * 总阀门②：情绪状态评估（纯函数）。看昨日老主线龙头今日表现：
 * 跌幅 ≤ sentiment_old_dragon_drop → 'retreating'（老龙头退潮）；
 * 涨幅 > sentiment_rise_pct → 'rising'；其余 → 'stable'。
 * 防御：无昨日主线 / 龙头无成分股 / 今日找不到该龙头行情 → 'stable'（规格：不报错）。
 *
 * @param {{stocks?: {code?: string, name?: string, changePct?: number}[]}?} yesterdayMainLine
 *   昨日主线对象（selectMainLine 输出的单条 main；龙头 = stocks[0]，接入层已按涨幅降序）。
 * @param {{changePct?: number}?} todayStockData 今日该龙头行情（changePct 单位 %）。
 * @param {{sentiment_old_dragon_drop?: number, sentiment_rise_pct?: number}} config
 * @returns {'rising' | 'stable' | 'retreating'}
 */
export function assessSentimentState(yesterdayMainLine, todayStockData, config) {
  const leader = yesterdayMainLine?.stocks?.[0];
  const chg = +todayStockData?.changePct;
  if (!leader || !Number.isFinite(chg)) return 'stable'; // 无数据不猜（规格默认）
  const drop = Number.isFinite(+config?.sentiment_old_dragon_drop)
    ? +config.sentiment_old_dragon_drop : -5;
  const rise = Number.isFinite(+config?.sentiment_rise_pct) ? +config.sentiment_rise_pct : 3;
  if (chg <= drop) return 'retreating';
  if (chg > rise) return 'rising';
  return 'stable';
}

/**
 * 总阀门③：双状态 → 阈值/输出上限调节（纯函数，不碰调用方对象）。
 * market_state==='weak' → up_count 阈值 + weak_mode_threshold_boost，输出上限压到 weak_mode_max_output；
 * sentiment_state==='retreating' → density 阈值 + dragon_retreat_density_boost（clamp ≤1，占比语义）。
 * 其余状态不动阈值。strong/rising/stable → 原样返回（maxOutput=null 表示不限制，沿用调用方 topN）。
 *
 * @param {{up_count_threshold: number, density_threshold: number}} threshold computeDynamicThreshold 产物
 * @param {{market_state: string, sentiment_state: string}} states
 * @param {{weak_mode_threshold_boost?: number, weak_mode_max_output?: number,
 *          dragon_retreat_density_boost?: number}} config
 * @returns {{threshold: object, maxOutput: number | null}}
 */
export function applyMainLineGating(threshold, states, config) {
  const up0 = +threshold?.up_count_threshold;
  const dn0 = +threshold?.density_threshold;
  let up = Number.isFinite(up0) ? up0 : 0;
  let dn = Number.isFinite(dn0) ? dn0 : 0;
  let maxOutput = null;
  if (states?.market_state === 'weak') {
    const boost = +config?.weak_mode_threshold_boost > 0 ? +config.weak_mode_threshold_boost : 2;
    up += boost;
    const cap = Number.isInteger(+config?.weak_mode_max_output) && +config.weak_mode_max_output >= 1
      ? +config.weak_mode_max_output : 1;
    maxOutput = cap;
  }
  if (states?.sentiment_state === 'retreating') {
    const db = +config?.dragon_retreat_density_boost > 0 ? +config.dragon_retreat_density_boost : 0.05;
    dn = Math.min(1, dn + db);
  }
  return { threshold: { ...threshold, up_count_threshold: up, density_threshold: dn }, maxOutput };
}

/**
 * 仓位管理①：ATR（Wilder 平滑法，纯函数，2026-10-07 第三步）。
 * TR_i = max(高-低, |高-昨收|, |低-昨收|)；ATR₀ = 前 period 个 TR 简单均值，
 * 之后 ATR = (前ATR × (period-1) + TR) / period（Wilder 递推）。
 * 数据不足 period+1 条（或数组长度不一致/含非有限数）→ null（规格：不猜）。
 * 生产接入以热点榜收盘序列构造（archive 无日内高低价，见 scripts/backtest.mjs
 * 的口径披露），函数本身只认数值。
 *
 * @param {number[]} highs 最高价数组（按时间升序，最新在最后）
 * @param {number[]} lows 最低价数组
 * @param {number[]} closes 收盘价数组
 * @param {number} period ATR 周期
 * @returns {number | null}
 */
export function computeATR(highs, lows, closes, period) {
  const P = Math.trunc(+period);
  if (!Array.isArray(highs) || !Array.isArray(lows) || !Array.isArray(closes)
    || !Number.isFinite(P) || P < 1
    || closes.length !== highs.length || closes.length !== lows.length
    || closes.length < P + 1) return null;
  if (highs.some((v) => !Number.isFinite(+v)) || lows.some((v) => !Number.isFinite(+v))
    || closes.some((v) => !Number.isFinite(+v))) return null;
  const tr = (i) => Math.max(
    +highs[i] - +lows[i],
    Math.abs(+highs[i] - +closes[i - 1]),
    Math.abs(+lows[i] - +closes[i - 1]),
  );
  let atr = 0;
  for (let i = 1; i <= P; i++) atr += tr(i);
  atr /= P; // 初始 ATR：前 P 个 TR 简单均值
  for (let i = P + 1; i < closes.length; i++) atr = (atr * (P - 1) + tr(i)) / P; // Wilder 平滑
  return atr;
}

/**
 * 仓位管理②：按 ATR 波动分档给每只标的建议仓位权重（纯函数）。
 * 输出原数组深拷贝（structuredClone），每项追加：
 *   atr_10d：ATR 值（数据不足为 null；字段名沿用规格，周期实际由 config.atr_period 决定）
 *   atr_pct：ATR / 最新收盘 × 100（百分比；不足为 null）
 *   volatility_bucket：'low'（atr_pct ≤ atr_low_threshold）| 'mid'（中间）
 *                     | 'high'（> atr_high_threshold）| 'unknown'（ATR 为 null）
 *   suggested_weight：对应权重百分比；unknown 取 mid 默认值（规格：不足数据给中性仓位）
 * 防御：historyData 缺该 code / 该股票历史不足 → atr 为 null，不影响其他股票；
 *       权重配置缺失 → 默认 15/10/5，不报错。
 *
 * @param {{code?: string}[]} stocks 选股结果数组
 * @param {Object<string, {highs?: number[], lows?: number[], closes?: number[]}>} historyData 按 code 索引的历史日线
 * @param {{atr_period?: number, atr_low_threshold?: number, atr_high_threshold?: number,
 *          weight_low_vol?: number, weight_mid_vol?: number, weight_high_vol?: number}} config
 * @returns {object[]} 深拷贝并追加字段后的新数组
 */
export function assignPositionWeights(stocks, historyData, config) {
  const arr = Array.isArray(stocks) ? stocks : [];
  if (!arr.length) return [];
  const num = (v, dft) => (Number.isFinite(+v) ? +v : dft);
  const period = Math.max(1, Math.trunc(num(config?.atr_period, 10)));
  const lowT = num(config?.atr_low_threshold, 3);
  const highT = num(config?.atr_high_threshold, 8);
  const wLow = num(config?.weight_low_vol, 15);
  const wMid = num(config?.weight_mid_vol, 10);
  const wHigh = num(config?.weight_high_vol, 5);
  const out = structuredClone(arr);
  for (const s of out) {
    const h = s && historyData ? historyData[s.code] : null;
    const closes = Array.isArray(h?.closes) ? h.closes : [];
    const atr = h ? computeATR(h.highs, h.lows, h.closes, period) : null;
    const last = closes.length ? +closes[closes.length - 1] : NaN;
    const atrPct = atr != null && Number.isFinite(last) && last > 0 ? (atr / last) * 100 : null;
    let bucket = 'unknown';
    let weight = wMid; // unknown → mid 默认（规格）
    if (atrPct != null) {
      if (atrPct <= lowT) { bucket = 'low'; weight = wLow; }
      else if (atrPct > highT) { bucket = 'high'; weight = wHigh; }
      else { bucket = 'mid'; weight = wMid; }
    }
    s.atr_10d = atr;
    s.atr_pct = atrPct == null ? null : Math.round(atrPct * 100) / 100;
    s.volatility_bucket = bucket;
    s.suggested_weight = weight;
  }
  return out;
}

/**
 * 当日主线。topN 取题材榜前 N；threshold（computeDynamicThreshold 产物）存在时
 * 先过滤（涨停家数 ≥ up_count_threshold 且密集度 ≥ density_threshold）再取前 N，
 * 全部不达标 → mains 为空（"今日无主线"，由调用方如实披露，不冒充）。
 * threshold 缺省（null/undefined）→ 保持历史行为（仅排序取 topN），兼容既有调用与测试。
 */
export function selectMainLine(day, topN = 1, threshold = null) {
  const themes = day.themes || {};
  const hot = day.hot || [];
  const industry = day.industry || [];
  const total = Object.values(themes).reduce((a, b) => a + b, 0) || 1;
  let ranked = Object.entries(themes).sort((a, b) => b[1] - a[1]);
  if (threshold) {
    ranked = ranked.filter(([name, cnt]) =>
      cnt >= threshold.up_count_threshold && (cnt / total) >= threshold.density_threshold);
  }
  ranked = ranked.slice(0, Math.max(topN, 1));
  const mains = ranked.map(([name, cnt]) => {
    const stocks = hot
      .filter((h) => String(h.reason || '').includes(name))
      .map((h) => ({ code: h.code, name: h.name, changePct: h.change_pct, reason: h.reason }))
      .sort((a, b) => (b.changePct || 0) - (a.changePct || 0));
    const density = cnt / total;
    return {
      theme: name, themeCount: cnt, density: Math.round(density * 1e4) / 1e4,
      mainScore: Math.round(cnt * density * 100) / 100,
      stocks: stocks.slice(0, 10), stockCount: stocks.length,
    };
  });
  const topIndustries = [...industry].sort((a, b) => (b.change_pct || 0) - (a.change_pct || 0)).slice(0, 5);
  return { tradeDate: day.trade_date, mains, topIndustries, ...(threshold ? { threshold } : {}) };
}
