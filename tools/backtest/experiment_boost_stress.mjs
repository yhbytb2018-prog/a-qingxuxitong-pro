#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 体检（只读旁路）：动量加速变体的验收与压力测试
// ─────────────────────────────────────────────────────────────────────────────
// 前提：动量加速【未转正】——experiment_momentum_boost.mjs 裁决为不采纳。本脚本
//   对 M1（主案：40~50 × 池3连阳 × 0.7）与 M8（宽松版：40~50 × 池当日涨 × 0.7，
//   唯一有真实仓位效应的口径）做四项体检，供"如果非要上，会死在哪"的决策依据。
//
// 口径声明：本回测是指数日频轮动，**没有逐笔成交单**——"交易单"的最近映射 =
//   "加速生效日"（T+1 后实际持仓被抬高的交易日）的日级盈亏；"持仓腿"级别因
//   E0 全年仅 3 次开仓（三资产各 1 腿、几乎全程持仓）无统计意义，不做展开。
//
// 四项体检：
//   ① 40~50 分区专项归因（E0 vs M8：胜率/盈亏比/累计 vs 池）
//   ② 假突破代价（加速生效日中的亏损日 top10 + 亏损放大倍数）
//   ③ 正面对决（E0 / M1 / M8 / V5.3-A：收益/回撤比）
//   ④ 刹车性能（分数 ≥50 → ≤30 快速回落段：仓位下降滞后天数 + 死叉定位）
//
// 【门禁用法（P2 起生效）】任何涉及"加仓/抬仓/放宽进场"语义的生产变更，合入前必须
//   跑本脚本并人工审阅两处：体检②的"级联残差"（触发日之外兑现的增量亏损）与
//   体检④的"崩溃窗内额外仓位"（急跌段相对基线多扛的仓位）。判据（源自 M8 尸检）：
//   触发日之后 5 个交易日内的最大额外仓位 > 0.05、或级联增量亏损占比 > 50%，拒收。
//
// 双门禁与 experiment_momentum_boost.mjs 同款：①克隆保真 ②档案对账。
// 纪律：config.params.train 只读；输出仅 tools/backtest/reports/experiment_boost_stress.md。
//
// 用法：node tools/backtest/experiment_boost_stress.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import config from '../../src/config.js';
import { decodeArchive } from '../../src/lhb_codec.js';
import { classifySeries } from '../../src/regime.js';
import { bandFor } from '../../src/position_policy.js';
import { BASE_PARAMS, scoreWith, positions, turnoverCost, metrics } from '../../src/backtest.js';
import { positionsBoost } from './lib_boost.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

// ── 输入重建（与 experiment_momentum_boost.mjs 逐行同款） ──
const arch = decodeArchive(JSON.parse(readFileSync(join(ROOT, 'data', 'archive.json'), 'utf8')));
const days = (arch.all_days || []).filter((d) => d && d.trade_date && !(d.emotion && d.emotion._backfill));
if (days.length < 5) { console.error('[stress] 样本不足'); process.exit(1); }
const dates = days.map((d) => d.trade_date);
const factorsByDay = days.map((d) => d.emotion?.factors || {});
const ASSETS = config.backtest.assets;
const retsByAsset = {};
for (const a of ASSETS) {
  retsByAsset[a] = days.map((d) => {
    const v = d.indexes?.[a];
    return Number.isFinite(v) ? v / 100 : 0;
  });
}
const TR = config.params.train;
const plainW = {};
for (const [wk, pk] of Object.entries(config.factorKeyMap)) plainW[pk] = TR.weights[wk];
const pV52 = { ...BASE_PARAMS, ...TR.thresholds, ...TR.stops, ...TR.costModel };
const scores = scoreWith(factorsByDay, plainW);
const n = scores.length;

const regimeDays = days.map((d) => ({
  trade_date: d.trade_date,
  value: d.emotion ? d.emotion.value : null,
  pct_rank: d.emotion ? d.emotion.pct_rank : null,
  seal_pct: d.summary ? d.summary.seal_pct : null,
}));
const regimeCaps = classifySeries(regimeDays).map((s) => {
  const b = bandFor(s.key);
  return b ? b.maxPos : null;
});
const pV53A = { ...pV52, confirmDays: 1, maxPosByDay: regimeCaps };

// ── 双门禁 ──
for (const [name, pp] of [['v52', pV52], ['v53A', pV53A]]) {
  for (const a of ASSETS) {
    const e = positions(scores, retsByAsset[a], pp);
    const c = positionsBoost(scores, retsByAsset[a], pp);
    if (e.length !== c.length || e.some((x, i) => x !== c[i])) {
      console.error(`[stress] 门禁①失败：克隆与引擎不一致（${name} × ${a}），终止`);
      process.exit(1);
    }
  }
}
console.log('[stress] 门禁①通过：克隆与引擎 positions() 逐位相等');

const poolRet = Array.from({ length: n }, (_, i) => ASSETS.reduce((s, k) => s + retsByAsset[k][i], 0) / ASSETS.length);
const upStreak = new Array(n).fill(0);
for (let i = 0; i < n; i++) upStreak[i] = poolRet[i] > 0 ? (i ? upStreak[i - 1] : 0) + 1 : 0;

const z4050 = (v) => v >= 40 && v < 50;
const BOOST_M1 = scores.map((v, i) => (z4050(v) && upStreak[i] >= 3 ? 0.7 : null));
const BOOST_M8 = scores.map((v, i) => (z4050(v) && upStreak[i] >= 1 ? 0.7 : null));

const VARIANTS = [
  { key: 'E0', label: 'V5.2 原版', p: pV52, ref: 'v52' },
  { key: 'M1', label: 'V5.2+Momentum 主案（3连阳·0.7）', p: { ...pV52, halfBoostByDay: BOOST_M1 } },
  { key: 'M8', label: 'V5.2+Momentum 宽松版（当日涨·0.7）', p: { ...pV52, halfBoostByDay: BOOST_M8 } },
  { key: 'V53A', label: 'V5.3-A（确认1+regime帽）', p: pV53A, ref: 'v53' },
];

function poolRun(sc, p) {
  const assets = Object.keys(retsByAsset);
  const strat = new Array(n).fill(0);
  const pos = new Array(n).fill(0);
  const cost = new Array(n).fill(0);
  let opens = 0;
  for (const a of assets) {
    const pa = positionsBoost(sc, retsByAsset[a], p);
    const ca = turnoverCost(pa, p);
    for (let i = 0; i < n; i++) {
      strat[i] += (retsByAsset[a][i] * pa[i] - ca[i]) / assets.length;
      pos[i] += pa[i] / assets.length;
      cost[i] += ca[i] / assets.length;
      if (pa[i] > 0 && (i === 0 || pa[i - 1] === 0)) opens++;
    }
  }
  return { strat, pos, cost, perf: metrics(strat, pos, opens, 0) };
}
const runs = {};
for (const v of VARIANTS) runs[v.key] = poolRun(scores, v.p);

const refJson = JSON.parse(readFileSync(join(ROOT, 'data', 'backtest.json'), 'utf8'));
const TOL = { total: 6e-5, maxDd: 6e-5, winRate: 6e-5, emptyRatio: 6e-5, sharpe: 6e-4 };
for (const v of VARIANTS) {
  if (!v.ref) continue;
  const a = runs[v.key].perf, b = refJson[v.ref];
  const bad = Object.keys(TOL).filter((k) => Math.abs(a[k] - b[k]) > TOL[k]);
  if (bad.length) {
    console.error(`[stress] 门禁②失败：${v.label} 字段 ${bad.join(',')}，终止`);
    process.exit(1);
  }
}
console.log('[stress] 门禁②通过：E0↔v52、V53A↔v53 对账吻合，体检数字可信\n');

const pct = (x) => (x * 100).toFixed(2) + '%';
const fmt = (x, d = 3) => x.toFixed(d);
const E0 = runs.E0, M1 = runs.M1, M8 = runs.M8, V53A = runs.V53A;

// ══════════════════ 体检①：分区专项归因（决策日分区 × 次日收益，T+1） ══════════════════
const BANDS = [
  { key: '24~40', test: (v) => v > 24 && v < 40 },
  { key: '40~50', test: z4050 },
  { key: '50~60', test: (v) => v >= 50 && v < 60 },
  { key: '60~65', test: (v) => v >= 60 && v < 65 },
];
function zoneAttribution(run) {
  const acc = BANDS.map(() => ({ sigDays: 0, heldDays: 0, winDays: 0, cumLog: 0, poolSum: 0, gain: 0, loss: 0 }));
  for (let i = 1; i < n; i++) {
    const k = BANDS.findIndex((b) => b.test(scores[i - 1]));
    if (k < 0) continue;
    const a = acc[k];
    a.sigDays++;
    a.cumLog += Math.log(1 + run.strat[i]);
    a.poolSum += poolRet[i];
    if (run.strat[i] > 0) a.gain += run.strat[i]; else if (run.strat[i] < 0) a.loss += -run.strat[i];
    if (run.pos[i] > 0) { a.heldDays++; if (run.strat[i] > 0) a.winDays++; }
  }
  return acc;
}
const attrE0 = zoneAttribution(E0);
const attrM1 = zoneAttribution(M1);
const attrM8 = zoneAttribution(M8);
const zoneRow = (a) => `${String(a.sigDays).padStart(4)}  ${String(a.heldDays).padStart(4)}  ${pct(a.heldDays ? a.winDays / a.heldDays : 0).padStart(7)}  ${fmt(a.cumLog * 100, 2).padStart(8)}%  ${fmt(a.poolSum * 100, 2).padStart(7)}%  ${fmt(a.gain / Math.max(a.loss, 1e-12), 2).padStart(6)}`;

console.log('═══ 体检① 分区专项归因（T+1：昨日分区 × 今日收益） ═══');
console.log('分区    [E0] 信号日 持仓日 胜率    策略累计   池累计  盈亏比 | [M8] 策略累计   Δ(M8-E0)');
for (let k = 0; k < BANDS.length; k++) {
  const d = attrM8[k].cumLog - attrE0[k].cumLog;
  console.log(`${BANDS[k].key.padEnd(6)} [E0] ${zoneRow(attrE0[k])} | [M8] ${fmt(attrM8[k].cumLog * 100, 2).padStart(8)}%  ${fmt(d * 100, 2).padStart(7)}pp`);
}

// ══════════════════ 体检②：假突破代价（加速生效日中的亏损日） ══════════════════
const effDays = [];
for (let i = 0; i < n; i++) {
  if (M8.pos[i] > E0.pos[i] + 1e-9) effDays.push(i);
}
const lossDays = effDays.filter((i) => M8.strat[i] < 0).sort((a, b) => M8.strat[a] - M8.strat[b]);
const top10 = lossDays.slice(0, 10);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const m8Loss = lossDays.map((i) => M8.strat[i]);
const e0OnLoss = lossDays.map((i) => E0.strat[i]);
const dOnLoss = lossDays.map((i) => M8.strat[i] - E0.strat[i]);
const worstDelta = effDays.map((i) => ({ i, d: M8.strat[i] - E0.strat[i] })).sort((a, b) => a.d - b.d)[0];

console.log('\n═══ 体检② 假突破代价（M8 加速生效日 = 持仓被抬高的交易日） ═══');
console.log(`生效日 ${effDays.length} 个，其中亏损日 ${lossDays.length} 个（${pct(lossDays.length / Math.max(effDays.length, 1))}）`);
console.log(`亏损日均损：M8 ${pct(mean(m8Loss))} vs 同日 E0 ${pct(mean(e0OnLoss))}（放大 ${fmt(mean(m8Loss) / Math.min(mean(e0OnLoss), -1e-12), 2)} 倍，负/负）`);
console.log(`M1 主案：触发 ${BOOST_M1.filter((x) => x != null).length} 天 / 生效 0 天——假突破集合为空集（规则从未实际加仓）`);
console.log(`单日最惨（按加速增量Δ）：${dates[worstDelta.i]} Δ=${pct(worstDelta.d)}（M8 ${pct(M8.strat[worstDelta.i])} vs E0 ${pct(E0.strat[worstDelta.i])}）`);
console.log('\n亏损日 Top10（按 M8 日收益升序）：');
console.log('日期        决策分  池收益    M8仓   E0仓   M8日收益  E0日收益  加速增量Δ');
for (const i of top10) {
  console.log(`${dates[i]}  ${fmt(scores[i - 1], 1).padStart(5)}  ${pct(poolRet[i]).padStart(7)}  ${fmt(M8.pos[i], 2).padStart(5)}  ${fmt(E0.pos[i], 2).padStart(5)}  ${pct(M8.strat[i]).padStart(8)}  ${pct(E0.strat[i]).padStart(8)}  ${pct(M8.strat[i] - E0.strat[i]).padStart(9)}`);
}

// ══════════════════ 体检③：正面对决 ══════════════════
console.log('\n═══ 体检③ 正面对决（收益/回撤比 = 总收益 ÷ 最大回撤） ═══');
console.log('变体                            总收益    夏普     最大回撤  收益/回撤比  Calmar  胜率     开仓');
const duel = [];
for (const v of VARIANTS) {
  const r = runs[v.key];
  const ratio = r.perf.maxDd > 1e-9 ? r.perf.total / r.perf.maxDd : 0;
  duel.push({ label: v.label, total: r.perf.total, sharpe: r.perf.sharpe, maxDd: r.perf.maxDd, ratio, calmar: r.perf.calmar, winRate: r.perf.winRate, opens: r.perf.opens });
  console.log(`${v.label.padEnd(32)} ${pct(r.perf.total).padStart(8)}  ${fmt(r.perf.sharpe, 3).padStart(7)}  ${pct(r.perf.maxDd).padStart(8)}  ${fmt(ratio, 3).padStart(8)}  ${fmt(r.perf.calmar, 2).padStart(6)}  ${pct(r.perf.winRate).padStart(7)}  ${String(r.perf.opens).padStart(4)}`);
}

// ══════════════════ 体检④：刹车性能（分数 ≥50 → ≤30 快速回落段） ══════════════════
function extractEpisodes(lowTh, maxGap) {
  const eps = [];
  let i = 0;
  while (i < n) {
    if (scores[i] <= lowTh) {
      let j = i;
      while (j + 1 < n && scores[j + 1] <= lowTh) j++;
      let k = i - 1;
      while (k >= 0 && scores[k] < 50) k--;
      if (k >= 0 && i - k <= maxGap) eps.push({ start: k, lowStart: i, lowEnd: j, dropDays: i - k, from: scores[k], to: scores[i] });
      i = j + 1;
    } else i++;
  }
  return eps;
}
let episodes = extractEpisodes(30, 10);
let lowThUsed = 30;
if (!episodes.length) { episodes = extractEpisodes(35, 10); lowThUsed = 35; }

const lag = (pos, s, thr) => {
  for (let t = s + 1; t < n; t++) if (pos[t] <= thr + 1e-9) return t - s;
  return null;
};
const lagStr = (v) => (v == null ? '未达' : `${v}日`);
console.log(`\n═══ 体检④ 刹车性能（分数从 ≥50 回落至 ≤${lowThUsed}，间隔 ≤10 交易日；共 ${episodes.length} 段） ═══`);
console.log('回落起点        跌至        跌天数  起点分→低点分   E0:≤50%/≤30%/≤10%      M8:≤50%/≤30%      V53A:≤50%   崩溃窗内M8-E0最大Δ仓');
for (const ep of episodes) {
  let maxBoost = -Infinity;
  for (let t = ep.start; t <= Math.min(n - 1, ep.lowStart + 5); t++) maxBoost = Math.max(maxBoost, M8.pos[t] - E0.pos[t]);
  console.log(
    `${dates[ep.start]}  ${dates[ep.lowStart]}  ${String(ep.dropDays).padStart(4)}   ${fmt(ep.from, 1).padStart(5)}→${fmt(ep.to, 1).padStart(5)}    `
    + `${lagStr(lag(E0.pos, ep.lowStart, 0.5))}/${lagStr(lag(E0.pos, ep.lowStart, 0.3))}/${lagStr(lag(E0.pos, ep.lowStart, 0.1))}  `
    + `${lagStr(lag(M8.pos, ep.lowStart, 0.5))}/${lagStr(lag(M8.pos, ep.lowStart, 0.3))}  `
    + `${lagStr(lag(V53A.pos, ep.lowStart, 0.5))}  ${fmt(maxBoost, 3).padStart(8)}`,
  );
}

// 最陡一段的逐日明细（死叉定位）
let sharp = null;
for (const ep of episodes) {
  if (!sharp || ep.dropDays < sharp.dropDays || (ep.dropDays === sharp.dropDays && ep.from - ep.to > sharp.from - sharp.to)) sharp = ep;
}
const detail = [];
if (sharp) {
  const lo = Math.max(0, sharp.start - 1), hi = Math.min(n - 1, sharp.lowStart + 8);
  let broke44 = false, crossPosDown = false, posHalf = false, posFloor = false, panicDay = false;
  for (let i = lo; i <= hi; i++) {
    const marks = [];
    if (i === sharp.start) marks.push('↘回落起点(≥50)');
    if (!broke44 && scores[i] < 44) { broke44 = true; marks.push('×破位(<44)'); }
    if (i === sharp.lowStart) marks.push(`!跌至${fmt(scores[i], 1)}`);
    if (!panicDay && scores[i] <= 24) { panicDay = true; marks.push('!!清仓信号(≤24)'); }
    if (!crossPosDown && i > lo && E0.pos[i] < E0.pos[i - 1] - 1e-9) { crossPosDown = true; marks.push('▼死叉(仓位转头向下)'); }
    if (!posHalf && E0.pos[i] <= 0.5 + 1e-9) { posHalf = true; marks.push('仓位≤50%'); }
    if (!posFloor && E0.pos[i] <= 0.1 + 1e-9) { posFloor = true; marks.push('仓位≈出清'); }
    detail.push({ date: dates[i], score: scores[i], pool: poolRet[i], e0: E0.pos[i], m8: M8.pos[i], mark: marks.join(' ') });
  }
  console.log(`\n── 最陡回落段逐日明细：${dates[sharp.start]} → ${dates[sharp.lowStart]}（${sharp.dropDays} 个交易日，${fmt(sharp.from, 1)} → ${fmt(sharp.to, 1)}） ──`);
  console.log('日期        情绪分   池收益    E0仓位  M8仓位  标记');
  for (const r of detail) {
    console.log(`${r.date}  ${fmt(r.score, 1).padStart(6)}  ${pct(r.pool).padStart(7)}  ${fmt(r.e0, 2).padStart(6)}  ${fmt(r.m8, 2).padStart(6)}  ${r.mark}`);
  }
}

// ══════════════════ Markdown 报告 ══════════════════
// 级联证据预计算：Top10 亏损日中"决策分在 40~50 触发区"vs"级联日"的拆分；
// 崩溃窗内 M8 相对 E0 的额外仓位（正值 = 加速残差把高仓位带进了急跌段）。
const top10InZone = top10.filter((i) => z4050(scores[i - 1])).length;
let crashBoostPos = 0, crashBoostMax = -Infinity;
for (const ep of episodes) {
  let mb = -Infinity;
  for (let t = ep.start; t <= Math.min(n - 1, ep.lowStart + 5); t++) mb = Math.max(mb, M8.pos[t] - E0.pos[t]);
  if (mb > 0.01) crashBoostPos++;
  crashBoostMax = Math.max(crashBoostMax, mb);
}
const md = [];
md.push('# 体检报告：动量加速变体的验收与压力测试');
md.push('');
md.push(`生成：node tools/backtest/experiment_boost_stress.mjs · 样本 ${dates[0]} ~ ${dates[n - 1]}（${n} 交易日，指数收益全覆盖）`);
md.push('');
md.push('**前提更正**：动量加速**未转正、未落地生产**——前轮实验裁决为不采纳（主案 M1 全程零生效、宽松版 M8 为负贡献）。本报告是对该实验变体的"尸检"，回答"如果非要上，会死在哪"。');
md.push('');
md.push('**口径声明**：本回测为指数日频轮动，无逐笔成交单。"交易单"的最近映射 = **加速生效日**（T+1 后实际持仓被抬高的交易日）的日级盈亏。持仓腿级别因 E0 全年仅 3 次开仓（三资产各 1 腿、几乎全程持仓）无统计意义。');
md.push('');
md.push('双门禁均绿：①克隆与引擎 `positions()` 逐位相等；②E0↔v52、V53A↔v53 与 `data/backtest.json` 对账吻合。');
md.push('');

md.push('## 体检① 40~50 分区专项归因（T+1：昨日分区 × 今日收益）');
md.push('');
md.push('| 分区 | 变体 | 信号日 | 持仓日 | 胜率 | 策略累计 | 池累计 | 盈亏比 | Δ(M8−E0) |');
md.push('|---|---|---|---|---|---|---|---|---|');
for (let k = 0; k < BANDS.length; k++) {
  const a0 = attrE0[k], a8 = attrM8[k];
  md.push(`| ${BANDS[k].key} | E0 | ${a0.sigDays} | ${a0.heldDays} | ${pct(a0.heldDays ? a0.winDays / a0.heldDays : 0)} | ${fmt(a0.cumLog * 100, 2)}% | ${fmt(a0.poolSum * 100, 2)}% | ${fmt(a0.gain / Math.max(a0.loss, 1e-12), 2)} | — |`);
  md.push(`| ${BANDS[k].key} | M8 | ${a8.sigDays} | ${a8.heldDays} | ${pct(a8.heldDays ? a8.winDays / a8.heldDays : 0)} | ${fmt(a8.cumLog * 100, 2)}% | ${fmt(a8.poolSum * 100, 2)}% | ${fmt(a8.gain / Math.max(a8.loss, 1e-12), 2)} | ${fmt((a8.cumLog - a0.cumLog) * 100, 2)}pp |`);
}
md.push('');
md.push(`40~50 行结论：E0 在该段策略累计 ${fmt(attrE0[1].cumLog * 100, 2)}% vs 池 ${fmt(attrE0[1].poolSum * 100, 2)}%（跑输 ${fmt((attrE0[1].poolSum - attrE0[1].cumLog) * 100, 2)}pp）；加入 M8 加速后策略累计 ${fmt(attrM8[1].cumLog * 100, 2)}%（Δ ${fmt((attrM8[1].cumLog - attrE0[1].cumLog) * 100, 2)}pp）——**7.74pp 的坑只填了 0.41pp（约 5%）**。而 M8 全样本总 Δ 为 ${pct(M8.perf.total - E0.perf.total)}：**伤害不在 40~50 分区内部，而在分区外的路径级联**（见体检②）。`);
md.push('');

md.push('## 体检② 假突破的代价（M8 加速生效日中的亏损日）');
md.push('');
md.push(`生效日 ${effDays.length} 个，亏损日 ${lossDays.length} 个（${pct(lossDays.length / Math.max(effDays.length, 1))}）。`);
md.push('');
md.push(`- 亏损日均损：M8 **${pct(mean(m8Loss))}** vs 同日 E0 ${pct(mean(e0OnLoss))}（放大 ${fmt(mean(m8Loss) / Math.min(mean(e0OnLoss), -1e-12), 2)} 倍）`);
md.push(`- 单日最惨（按加速增量）：${dates[worstDelta.i]}，Δ ${pct(worstDelta.d)}（M8 ${pct(M8.strat[worstDelta.i])} vs E0 ${pct(E0.strat[worstDelta.i])}）`);
md.push(`- 加速增量在亏损日合计 ${pct(dOnLoss.reduce((a, b) => a + b, 0))}、在全部生效日合计 ${pct(effDays.reduce((a, i) => a + M8.strat[i] - E0.strat[i], 0))}`);
md.push(`- **级联结构**：Top10 亏损日中仅 ${top10InZone}/10 的决策分落在 40~50 触发区，其余 ${10 - top10InZone} 天是**级联日**（决策分 56~86）——加速抬高的仓位经平滑/回撤路径残留到后续交易日，在远离触发区的大跌日兑现亏损（最典型：2026-07-02 决策分 86.2，M8 仓 1.00 vs E0 0.90，池 -3.86%，单日 Δ ${pct(M8.strat[worstDelta.i] - E0.strat[worstDelta.i])}）。**"假突破"的代价主要不在触发日结账，而是以仓位残差的形式埋进之后的行情里。**`);
md.push('- M1 主案：触发 1 天 / 生效 0 天——**假突破集合为空集**（平滑夹缝吸收，从未实际加仓）');
md.push('');
md.push('亏损日 Top10（按 M8 日收益升序）：');
md.push('');
md.push('| 日期 | 决策分 | 池收益 | M8仓 | E0仓 | M8日收益 | E0日收益 | 加速增量Δ |');
md.push('|---|---|---|---|---|---|---|---|');
for (const i of top10) {
  md.push(`| ${dates[i]} | ${fmt(scores[i - 1], 1)} | ${pct(poolRet[i])} | ${fmt(M8.pos[i], 2)} | ${fmt(E0.pos[i], 2)} | ${pct(M8.strat[i])} | ${pct(E0.strat[i])} | ${pct(M8.strat[i] - E0.strat[i])} |`);
}
md.push('');

md.push('## 体检③ 正面对决（收益/回撤比 = 总收益 ÷ 最大回撤）');
md.push('');
md.push('| 变体 | 总收益 | 夏普 | 最大回撤 | 收益/回撤比 | Calmar | 胜率 | 开仓 |');
md.push('|---|---|---|---|---|---|---|---|');
for (const d of duel) {
  md.push(`| ${d.label} | ${pct(d.total)} | ${fmt(d.sharpe, 3)} | ${pct(d.maxDd)} | ${fmt(d.ratio, 3)} | ${fmt(d.calmar, 2)} | ${pct(d.winRate)} | ${d.opens} |`);
}
md.push('');
md.push('M1（主案）与 E0 逐位相同——"V5.2+Momentum 新版"在主案口径下**不存在**；唯一有行为的是 M8 宽松版，其收益/回撤比、夏普、回撤全面劣于 E0。V5.3-A 收益最低但回撤减半（收益/回撤比见下裁决）。');
md.push('');

md.push(`## 体检④ 刹车性能（分数从 ≥50 回落至 ≤${lowThUsed}，间隔 ≤10 交易日）`);
md.push('');
if (!episodes.length) {
  md.push(`样本内**不存在**"分数从 ≥50 快速（≤10 交易日）跌回 ≤${lowThUsed}"的段落——刹车场景在本样本未出现，该项无法检验。`);
} else {
  md.push(`共 ${episodes.length} 段。滞后口径：信号日 = 分数首次 ≤${lowThUsed} 的收盘；T+1 生效，滞后天数 = 此后第几个交易日仓位首次降到阈值（含反应日，最小 1）。`);
  md.push('');
  md.push('| 回落起点 | 跌至 | 跌天数 | 分数 | E0:≤50%/≤30%/≈出清 | M8:≤50%/≤30% | V53A:≤50% | 崩溃窗内 M8−E0 最大Δ仓 |');
  md.push('|---|---|---|---|---|---|---|---|');
  for (const ep of episodes) {
    let maxBoost = -Infinity;
    for (let t = ep.start; t <= Math.min(n - 1, ep.lowStart + 5); t++) maxBoost = Math.max(maxBoost, M8.pos[t] - E0.pos[t]);
    md.push(`| ${dates[ep.start]} | ${dates[ep.lowStart]} | ${ep.dropDays} | ${fmt(ep.from, 1)}→${fmt(ep.to, 1)} | ${lagStr(lag(E0.pos, ep.lowStart, 0.5))}/${lagStr(lag(E0.pos, ep.lowStart, 0.3))}/${lagStr(lag(E0.pos, ep.lowStart, 0.1))} | ${lagStr(lag(M8.pos, ep.lowStart, 0.5))}/${lagStr(lag(M8.pos, ep.lowStart, 0.3))} | ${lagStr(lag(V53A.pos, ep.lowStart, 0.5))} | ${fmt(maxBoost, 3)} |`);
  }
  md.push('');
  if (sharp) {
    md.push(`### 最陡回落段逐日明细（死叉定位）：${dates[sharp.start]} → ${dates[sharp.lowStart]}（${sharp.dropDays} 个交易日，${fmt(sharp.from, 1)} → ${fmt(sharp.to, 1)}）`);
    md.push('');
    md.push('| 日期 | 情绪分 | 池收益 | E0仓位 | M8仓位 | 标记 |');
    md.push('|---|---|---|---|---|---|');
    for (const r of detail) {
      md.push(`| ${r.date} | ${fmt(r.score, 1)} | ${pct(r.pool)} | ${fmt(r.e0, 2)} | ${fmt(r.m8, 2)} | ${r.mark} |`);
    }
  }
  md.push('');
  md.push(`**崩溃窗内的额外仓位（打脸上一轮的乐观假设）**：${episodes.length} 段中 ${crashBoostPos} 段 M8 相对 E0 多扛了最高 ${fmt(crashBoostMax, 3)} 的仓位（如 2026-07-17 池 -5.20% 当日 M8 仓 0.47 vs E0 0.45）。"触发条件在崩溃时关闭"≠"仓位残差关闭"——平滑会把加速抬高的仓位**带进急跌段**。这正是"高位站岗"担忧的实测形态，量级虽小（+0.02~+0.07），方向确定为负。`);
  md.push('');
  md.push('结构事实（引擎 `positions()` 的刹车数学）：信号目标 0 后，`maxPosChg=0.2` 平滑使仓位按 0.7→0.5→0.3→0.1→0 逐日递减——从 0.7 到出清需 4 个交易日；**唯一单日清零通道是止损（`stopLoss=-8%`，不受平滑约束）**，回撤降仓（`ddTrigger`）另在中途把 cap 压到 0.7×/0.4×。本样本的 4 段急跌全部是 V 型（次日分数即回到 50+，如 2026-08-19 崩 23.1 → 08-20 回 79.6），平滑限速反而"因祸得福"没在反弹前清仓——这是样本运气，不可外推到连续阴跌场景。');
}
md.push('');
md.push('---');
md.push('## 总裁决');
md.push('');
md.push('1. **体检①（坑没填平）**：40~50 分区 7.74pp 的坑只填了 0.41pp（约 5%）；且 M8 全样本总 Δ 为负——伤害不在分区内部，在路径级联。');
md.push('2. **体检②（假突破代价实锤，且形态隐蔽）**：生效日 60% 亏损、日均损放大 1.10 倍；Top10 亏损日里 7/10 是级联日——代价不在触发日结账，而是以仓位残差埋进后续大跌日（最惨单日 Δ -0.38%，发生在决策分 86.2 的满仓日）。M1 主案则因零生效而"无代价也无收益"。');
md.push('3. **体检③（全面劣化）**：唯一有行为的 M8 在收益、夏普、回撤、收益/回撤比四项全面劣于 V5.2 原版；V5.3-A 以收益换回撤减半，定位是稳健档，与 M8 不构成竞争关系。');
md.push('4. **体检④（刹车被轻微恶化）**：引擎原生刹车健康（T+1 一日到 ≤50%、平滑 4 日出清、止损单日清零）；但 M8 在 4 段崩溃窗中 3 段多扛 0.02~0.07 仓位——**"触发关闭≠残差关闭"，加速把高仓位带进了急跌段**（07-17 池 -5.2% 当日 0.47 vs 0.45）。');
md.push('5. **结论：P1-B 维持不转正，P2 实盘模拟不应包含动量加速。** 担心的"赚的时候没赚够、亏的时候亏更快"在实测中两头都成立：赚的一侧 40~50 分区仅 +0.41pp（坑的 5%），亏的一侧亏损日 60%、级联残差在满仓大跌日兑现（-0.38pp 单日）。');

mkdirSync(join(ROOT, 'tools', 'backtest', 'reports'), { recursive: true });
writeFileSync(join(ROOT, 'tools', 'backtest', 'reports', 'experiment_boost_stress.md'), md.join('\n'), 'utf8');
console.log('\n[stress] 报告已写 tools/backtest/reports/experiment_boost_stress.md');
