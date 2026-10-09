// 主线识别动态阈值单测（2026-10-07）：computeDynamicThreshold 纯函数 + selectMainLine
// 阈值过滤行为。覆盖六个规格场景：充足/不足样本、全零历史、零标准差、单日突增、
// 连续无主线（阈值自适应下调），另锁配置读取与降级口径。
// 第二步（同日）追加：总阀门三纯函数（assessMarketState / assessSentimentState /
// applyMainLineGating）的六个规格场景。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDynamicThreshold, selectMainLine,
  assessMarketState, assessSentimentState, applyMainLineGating,
  computeATR, assignPositionWeights,
} from '../src/backtest.js';
import config from '../src/config.js';

const CFG = config.mainLine;
const FIXED = CFG.fixedFallback;

/** 造 n 条历史样本：up_count 基线 base，density 基线 dBase（各加微抖动防退化为零 std 时误判） */
const mk = (n, base = 8, dBase = 0.2) => Array.from({ length: n }, (_, i) => ({
  date: `2026-07-${String(i + 1).padStart(2, '0')}`,
  theme_up_count: base,
  theme_density: dBase,
}));

test('配置：mainLine 块存在且形态正确（config.json 是唯一事实源，不硬编码）', () => {
  assert.ok(CFG && typeof CFG === 'object');
  assert.equal(CFG.lookback_days, 60);
  assert.equal(CFG.sigma_multiplier, 0.5); // 2026-10-07 拍板：σ 对比回测（scripts/compare_sigma.mjs，60 日）显示 10 个不一致日全部为 σ0.5 触发 / σ1 漏报，σ1 于 9 月仅 1 天触发，门槛过苛
  assert.equal(CFG.min_sample_days, 20);
  assert.ok(Number.isFinite(FIXED.up_count_threshold) && Number.isFinite(FIXED.density_threshold));
});

test('① 数据充足（≥60 条）→ 正常计算动态阈值（均值 + 1σ）', () => {
  // 60 条 theme_up_count 全为 8、theme_density 全为 0.2：std=0 → 阈值=均值
  const t = computeDynamicThreshold(mk(60), CFG);
  assert.equal(t.mode, 'dynamic');
  assert.equal(t.samples, 60);
  assert.equal(t.up_count_threshold, 8);
  assert.ok(Math.abs(t.density_threshold - 0.2) < 1e-12);
  assert.equal(t.window.up_mean, 8);
  assert.equal(t.window.up_std, 0);
});

test('② 数据不足（<20 条）→ 降级固定阈值，mode=fallback 如实标注', () => {
  const t = computeDynamicThreshold(mk(19, 50, 0.9), CFG);
  assert.equal(t.mode, 'fallback');
  assert.equal(t.samples, 19);
  assert.equal(t.up_count_threshold, FIXED.up_count_threshold);
  assert.equal(t.density_threshold, FIXED.density_threshold);
});

test('③ 历史数据全为零 → 阈值不为负（clamp ≥0）', () => {
  const t = computeDynamicThreshold(mk(30, 0, 0), CFG);
  assert.equal(t.mode, 'dynamic');
  assert.equal(t.up_count_threshold, 0);
  assert.equal(t.density_threshold, 0);
});

test('④ 标准差为零 → 阈值等于均值', () => {
  // 全部样本同值：std=0，阈值 = 均值 + 1×0 = 均值
  const t = computeDynamicThreshold(mk(25, 12, 0.3), CFG);
  assert.equal(t.up_count_threshold, 12);
  assert.ok(Math.abs(t.density_threshold - 0.3) < 1e-12);
});

test('④b 单日数据突增 → 次日阈值上调（突增样本进窗口抬升均值与 σ）', () => {
  const calm = mk(59, 8, 0.2);
  const before = computeDynamicThreshold(calm, CFG);
  const after = computeDynamicThreshold([...calm, { date: 'x', theme_up_count: 30, theme_density: 0.6 }], CFG);
  assert.ok(after.up_count_threshold > before.up_count_threshold,
    `阈值应上调：${before.up_count_threshold} → ${after.up_count_threshold}`);
  assert.ok(after.density_threshold > before.density_threshold);
});

test('⑤ 连续多日无主线（数据持续走低）→ 阈值逐步下调', () => {
  // 强市窗口（up 20）→ 换窗期（20 强 + 40 弱）→ 弱市窗口（up 5）：
  // 阈值随分布整体下移而逐级下修，弱市主线可被重新识别。
  // （注意换窗期不能用 50/50 两簇：mean+std 数学上恰等于高簇值，测不出下调）
  const hot = mk(60, 20, 0.5);
  const t1 = computeDynamicThreshold(hot, CFG);
  const cooling = [...hot.slice(0, 20), ...mk(40, 5, 0.1)];
  const t2 = computeDynamicThreshold(cooling, CFG);
  const cold = mk(60, 5, 0.1);
  const t3 = computeDynamicThreshold(cold, CFG);
  assert.ok(t2.up_count_threshold < t1.up_count_threshold,
    `换窗期阈值应下移：${t1.up_count_threshold} → ${t2.up_count_threshold}`);
  assert.ok(t3.up_count_threshold < t2.up_count_threshold,
    `冷市阈值应继续下调：${t2.up_count_threshold} → ${t3.up_count_threshold}`);
  assert.ok(t3.density_threshold < t2.density_threshold && t2.density_threshold < t1.density_threshold,
    `密集度阈值同向下调：${t1.density_threshold} → ${t2.density_threshold} → ${t3.density_threshold}`);
});

test('selectMainLine：无阈值参数 → 保持历史行为（排序取 topN，不滤）', () => {
  const day = { trade_date: '2026-10-08', themes: { 弱题材: 1, 强题材: 9 }, hot: [], industry: [] };
  const r = selectMainLine(day, 2);
  assert.equal(r.mains.length, 2);
  assert.equal(r.mains[0].theme, '强题材');
  assert.equal(r.threshold, undefined);
});

test('selectMainLine：阈值过滤——达标入选、不达标剔除、全不达标 → 空主线（不冒充）', () => {
  const day = { trade_date: '2026-10-08', themes: { A: 10, B: 3, C: 2 }, hot: [], industry: [] };
  // total=15：A density=0.667、B=0.2、C=0.133。阈值 { up: 5, density: 0.15 } → 只剩 A
  const th = { up_count_threshold: 5, density_threshold: 0.15 };
  const r = selectMainLine(day, 2, th);
  assert.deepEqual(r.mains.map((m) => m.theme), ['A']);
  assert.deepEqual(r.threshold, th);
  // 阈值抬到无人可达 → mains 空（今日无主线）
  const none = selectMainLine(day, 2, { up_count_threshold: 99, density_threshold: 0.99 });
  assert.equal(none.mains.length, 0);
});

test('接入形态：computeDynamicThreshold 产物可直接喂 selectMainLine（字段闭环）', () => {
  const th = computeDynamicThreshold(mk(60, 8, 0.2), CFG);
  const day = { trade_date: '2026-10-08', themes: { 强题材: 9, 弱题材: 3 }, hot: [], industry: [] };
  const r = selectMainLine(day, 2, th);
  assert.equal(r.mains.map((m) => m.theme).join(), '强题材'); // 9 ≥ 8 且 density 0.75 ≥ 0.2
});

// ─────────────────── 总阀门（第二步）：三纯函数的规格场景 ───────────────────

// 市场状态基础判定矩阵（供下面场景复用）：近10日成交额均值 = 100
const VOL10 = Array.from({ length: 10 }, () => 100);
const MK = (volume, price, ma) => ({ volume, index_price: price, index_ma: ma });

test('总阀门·市场状态：量能×指数双弱 → weak；仅其一 → normal；均强 → strong', () => {
  assert.equal(assessMarketState(MK(70, 2900, 3000), VOL10, CFG), 'weak');    // 70 < 100×0.8 且点位 < 均线
  assert.equal(assessMarketState(MK(70, 3100, 3000), VOL10, CFG), 'normal');  // 仅量能弱
  assert.equal(assessMarketState(MK(120, 3100, 3000), VOL10, CFG), 'strong'); // 均不弱
});

test('总阀门·市场状态：index_below_ma=false → 指数条件不参与，量能弱单独即 weak', () => {
  const cfgOff = { ...CFG, market_weak_index_below_ma: false };
  assert.equal(assessMarketState(MK(70, 2900, 3000), VOL10, cfgOff), 'weak');
  assert.equal(assessMarketState(MK(120, 2900, 3000), VOL10, cfgOff), 'strong');
});

test('总阀门·情绪状态：跌 ≤ -5 → retreating；涨 > 3 → rising；其余 stable（边界逐位）', () => {
  const yMain = { theme: '旧题材', stocks: [{ code: '600000', name: '龙头', changePct: 6 }] };
  assert.equal(assessSentimentState(yMain, { changePct: -5 }, CFG), 'retreating');   // 恰 -5 ≤ -5
  assert.equal(assessSentimentState(yMain, { changePct: -4.99 }, CFG), 'stable');
  assert.equal(assessSentimentState(yMain, { changePct: 3.01 }, CFG), 'rising');
  assert.equal(assessSentimentState(yMain, { changePct: 3 }, CFG), 'stable');       // 恰 3 不算 rising
});

test('总阀门·场景①：市场强势 + 情绪上升 → 阈值不变，输出正常（maxOutput=null 沿用 topN）', () => {
  const th = computeDynamicThreshold(mk(60, 8, 0.2), CFG);
  const g = applyMainLineGating(th, { market_state: 'strong', sentiment_state: 'rising' }, CFG);
  assert.deepEqual(
    { up: g.threshold.up_count_threshold, dn: g.threshold.density_threshold },
    { up: th.up_count_threshold, dn: th.density_threshold });
  assert.equal(g.maxOutput, null);
});

test('总阀门·场景②：市场弱势 → up 阈值 +2，max_output 压到 1', () => {
  const th = computeDynamicThreshold(mk(60, 8, 0.2), CFG);
  const g = applyMainLineGating(th, { market_state: 'weak', sentiment_state: 'stable' }, CFG);
  assert.equal(g.threshold.up_count_threshold, th.up_count_threshold + CFG.weak_mode_threshold_boost);
  assert.equal(g.threshold.density_threshold, th.density_threshold); // density 不动
  assert.equal(g.maxOutput, CFG.weak_mode_max_output);
});

test('总阀门·场景③：老龙头退潮 → density 阈值 +0.05，up 阈值与输出上限不动', () => {
  const th = computeDynamicThreshold(mk(60, 8, 0.2), CFG);
  const g = applyMainLineGating(th, { market_state: 'normal', sentiment_state: 'retreating' }, CFG);
  assert.ok(Math.abs(g.threshold.density_threshold - (th.density_threshold + CFG.dragon_retreat_density_boost)) < 1e-12);
  assert.equal(g.threshold.up_count_threshold, th.up_count_threshold);
  assert.equal(g.maxOutput, null);
});

test('总阀门·场景④：市场弱势 + 老龙头退潮 → 双重收紧（up +2 且 density +0.05）', () => {
  const th = computeDynamicThreshold(mk(60, 8, 0.2), CFG);
  const g = applyMainLineGating(th, { market_state: 'weak', sentiment_state: 'retreating' }, CFG);
  assert.equal(g.threshold.up_count_threshold, th.up_count_threshold + CFG.weak_mode_threshold_boost);
  assert.ok(Math.abs(g.threshold.density_threshold - (th.density_threshold + CFG.dragon_retreat_density_boost)) < 1e-12);
  assert.equal(g.maxOutput, CFG.weak_mode_max_output);
});

test('总阀门·场景⑤：无昨日主线数据 → 情绪默认 stable，不报错', () => {
  assert.equal(assessSentimentState(null, { changePct: -9 }, CFG), 'stable');
  assert.equal(assessSentimentState({ theme: 'x', stocks: [] }, { changePct: -9 }, CFG), 'stable');
  // 有主线龙头但今日无行情 → 同样 stable
  assert.equal(assessSentimentState({ stocks: [{ code: '600000' }] }, null, CFG), 'stable');
});

test('总阀门·场景⑥：历史成交额不足 10 日 → 市场状态默认 normal，不报错', () => {
  assert.equal(assessMarketState(MK(70, 2900, 3000), [100, 90, 80], CFG), 'normal');
  assert.equal(assessMarketState(MK(70, 2900, 3000), [], CFG), 'normal');
  assert.equal(assessMarketState(null, null, CFG), 'normal'); // 极端：全空入参也不炸
});

test('总阀门·边界：density 调节 clamp ≤1（占比语义）；gating 不改原对象（纯函数）', () => {
  const th = { up_count_threshold: 5, density_threshold: 0.98, mode: 'dynamic' };
  const g = applyMainLineGating(th, { market_state: 'normal', sentiment_state: 'retreating' }, CFG);
  assert.equal(g.threshold.density_threshold, 1); // 0.98 + 0.05 → clamp 1
  assert.equal(th.density_threshold, 0.98);        // 原对象不动
  assert.equal(g.threshold.mode, 'dynamic');       // 附加字段保留（前端披露用）
});

// ─────────────────── 仓位管理（第三步）：ATR 与建议权重 ───────────────────

// 构造 n 根 K 线使每根 TR = tr、收盘恒为 last（首根为基期不产 TR）。
// n=3、period=2 时 ATR = (TR1+TR2)/2 = tr，atr_pct = tr/last×100，可逐位手算核对。
const mkK = (tr, last = 100, n = 3) => {
  const o = { highs: [], lows: [], closes: [] };
  const h = last + tr / 2, l = last - tr / 2;
  for (let i = 0; i < n; i++) { o.highs.push(h); o.lows.push(l); o.closes.push(last); }
  return o;
};

test('仓位管理·computeATR：Wilder 平滑手算闭环（period=2，5 根 K 线）', () => {
  // TR1=4, TR2=5, TR3=3, TR4=4（逐根手算：max(高-低,|高-昨收|,|低-昨收|)）
  // ATR₀=(4+5)/2=4.5 → ATR₁=(4.5+3)/2=3.75 → ATR₂=(3.75+4)/2=3.875
  const H = [12, 13, 15, 14, 16], L = [8, 9, 10, 11, 12], C = [10, 11, 14, 13, 15];
  assert.equal(computeATR(H, L, C, 2), 3.875);
  // 恰 period+1 根（无平滑步）：ATR = 前 P 个 TR 简单均值
  assert.equal(computeATR(H.slice(0, 3), L.slice(0, 3), C.slice(0, 3), 2), 4.5);
});

test('仓位管理·computeATR：数据不足 / 长度不一致 / 含 NaN → null，不报错', () => {
  const k = mkK(4, 100, 3);
  assert.equal(computeATR(k.highs.slice(0, 2), k.lows.slice(0, 2), k.closes.slice(0, 2), 2), null); // 2 根 < period+1
  assert.equal(computeATR(k.highs, k.lows, k.closes.slice(0, 2), 2), null); // 长度不一致
  assert.equal(computeATR([...k.highs, NaN], [...k.lows, 96], [...k.closes, 100], 2), null);
  assert.equal(computeATR(null, null, null, 10), null);
});

test('仓位管理·场景①：正常数据 → ATR/分档/权重逐位匹配（low/mid/high 三档）', () => {
  const hist = {
    A: mkK(2, 100),   // atr_pct=2 ≤3 → low → 15
    B: mkK(4, 100),   // 3<4≤8 → mid → 10
    C: mkK(10, 100),  // 10>8 → high → 5
  };
  const out = assignPositionWeights(
    [{ code: 'A' }, { code: 'B' }, { code: 'C' }], hist, { ...CFG, atr_period: 2 });
  assert.deepEqual(
    out.map((s) => [s.atr_pct, s.volatility_bucket, s.suggested_weight]),
    [[2, 'low', 15], [4, 'mid', 10], [10, 'high', 5]]);
  assert.equal(out[0].atr_10d, 2); // ATR 原值 = TR（3 根 period=2：均值化）
});

test('仓位管理·场景②：数据不足 → atr 为 null，分档 unknown，权重取 mid 默认', () => {
  const out = assignPositionWeights([{ code: 'X' }], { X: mkK(2, 100, 2) }, CFG); // 2 根 < 11
  assert.equal(out[0].atr_10d, null);
  assert.equal(out[0].atr_pct, null);
  assert.equal(out[0].volatility_bucket, 'unknown');
  assert.equal(out[0].suggested_weight, CFG.weight_mid_vol);
});

test('仓位管理·场景③边界值：atr_pct 恰等于阈值 → 归入对应档位（≤low 为 low；=high 为 mid）', () => {
  const hist = { P: mkK(3, 100), Q: mkK(8, 100) }; // 恰 3%、恰 8%
  const out = assignPositionWeights([{ code: 'P' }, { code: 'Q' }], hist, { ...CFG, atr_period: 2 });
  assert.equal(out[0].volatility_bucket, 'low');  // 3 ≤ 3 → low
  assert.equal(out[0].suggested_weight, CFG.weight_low_vol);
  assert.equal(out[1].volatility_bucket, 'mid');  // 8 不 > 8 → mid
  assert.equal(out[1].suggested_weight, CFG.weight_mid_vol);
});

test('仓位管理·场景④：空股票数组 → 返回空数组，不报错', () => {
  assert.deepEqual(assignPositionWeights([], {}, CFG), []);
  assert.deepEqual(assignPositionWeights(null, null, CFG), []); // 极端入参
});

test('仓位管理·场景⑤：某股票历史数据缺失 → 该项 atr 为 null，不影响其他股票', () => {
  const out = assignPositionWeights(
    [{ code: 'OK' }, { code: 'MISSING' }], { OK: mkK(10, 100) }, { ...CFG, atr_period: 2 });
  assert.equal(out[0].volatility_bucket, 'high');
  assert.equal(out[1].atr_10d, null);
  assert.equal(out[1].volatility_bucket, 'unknown');
  assert.equal(out[1].suggested_weight, CFG.weight_mid_vol);
});

test('仓位管理·场景⑥：权重配置项缺失 → 默认 15/10/5，不报错', () => {
  const hist = { A: mkK(2, 100, 11), B: mkK(4, 100, 11), C: mkK(10, 100, 11) }; // 11 根走默认周期 10
  const out = assignPositionWeights(
    [{ code: 'A' }, { code: 'B' }, { code: 'C' }], hist, {});
  assert.deepEqual(out.map((s) => s.suggested_weight), [15, 10, 5]);
});

test('仓位管理·纯度：深拷贝不改原数组；选股排序逻辑零改动（原字段原样保留）', () => {
  const stocks = [{ code: 'A', name: '甲', changePct: 9.9 }, { code: 'B', name: '乙', changePct: 5 }];
  const out = assignPositionWeights(stocks, { A: mkK(4, 100) }, CFG);
  assert.ok(!('atr_10d' in stocks[0]));        // 原对象未被追加字段
  assert.notEqual(out[0], stocks[0]);           // 返回的是深拷贝
  assert.equal(out[0].name, '甲');              // 原字段保留（排序依据不动）
  assert.equal(out[0].changePct, 9.9);
});
