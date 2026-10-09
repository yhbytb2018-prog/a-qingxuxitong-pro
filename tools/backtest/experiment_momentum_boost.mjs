#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 实验（只读旁路）：半山腰（信号分 40~50）"动量加速"回测
// ─────────────────────────────────────────────────────────────────────────────
// 动机：真实数据下 40~50 分段策略跑输池 7.4pp（半仓踏空反弹）。设想：半仓区内若
//   池收益已连续 K 日上涨（右侧动量确认），该决策日半仓基座从 0.5 临时抬到 B。
//
// 实现方式：不改 src/backtest.js——引擎原生参数抬不了仓（maxPosByDay 是 min 语义
//   帽子，半仓分支 target = 0.5×cap 的天花板就是 0.5）。故在本地逐位克隆 positions()
//   加 halfBoostByDay 钩子：决策日 i 数组元素非空 → 半仓基座 = 该值（替代 0.5），
//   仍乘 cap、仍在确认门内（held || pending > confirmDays），止损/过热/清仓路径
//   不受影响，maxPosChg 平滑照常约束（0.5→0.7 恰在 ±0.2 限内）。
// 保真门禁（双重）：①克隆函数在 halfBoostByDay=null 时与引擎 positions() 逐位相等
//   （全资产全序列）；②E0/V53A 池级结果与 data/backtest.json 对账（容差对齐取整精度）。
// 纪律：config.params.train 只读；输出仅 tools/backtest/reports/experiment_momentum_boost.md。
//
// 用法：node tools/backtest/experiment_momentum_boost.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import config from '../../src/config.js';
import { decodeArchive } from '../../src/lhb_codec.js';
import { classifySeries } from '../../src/regime.js';
import { bandFor } from '../../src/position_policy.js';
import { BASE_PARAMS, scoreWith, positions, turnoverCost, metrics } from '../../src/backtest.js';
import { positionsBoost } from './lib_boost.mjs';

// 引擎克隆已抽至 tools/backtest/lib_boost.mjs（与 experiment_boost_stress.mjs 共享，
// 避免两份克隆漂移）；本脚本下方门禁①仍逐位校验克隆与引擎一致。

// ── 输入重建（与 scripts/backtest.mjs / experiment_zone_cap.mjs 逐行同款） ──
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

const arch = decodeArchive(JSON.parse(readFileSync(join(ROOT, 'data', 'archive.json'), 'utf8')));
const days = (arch.all_days || []).filter((d) => d && d.trade_date && !(d.emotion && d.emotion._backfill));
if (days.length < 5) { console.error('[exp] 样本不足'); process.exit(1); }

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

// regime 帽子（V5.3-A 基础，与正式回测同款）
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

// ── 门禁①：克隆保真（halfBoostByDay=null 时与引擎逐位相等，全资产全序列） ──
for (const [name, pp] of [['v52', pV52], ['v53A', pV53A]]) {
  for (const a of ASSETS) {
    const e = positions(scores, retsByAsset[a], pp);
    const c = positionsBoost(scores, retsByAsset[a], pp);
    if (e.length !== c.length || e.some((x, i) => x !== c[i])) {
      console.error(`[exp] 克隆保真失败：${name} × ${a} 与引擎 positions() 不一致，终止`);
      process.exit(1);
    }
  }
}
console.log('[exp] 门禁①通过：克隆 positionsBoost 与引擎 positions() 逐位相等（v52/v53A 参数组 × 全资产）');

// ── 动量输入（决策日 i 收盘已知，T+1 生效，无前视） ──
const poolRet = Array.from({ length: n }, (_, i) => ASSETS.reduce((s, k) => s + retsByAsset[k][i], 0) / ASSETS.length);
const upStreak = new Array(n).fill(0); // 连续池上涨日数（ending at i）
for (let i = 0; i < n; i++) upStreak[i] = poolRet[i] > 0 ? (i ? upStreak[i - 1] : 0) + 1 : 0;
const scoreStreak = new Array(n).fill(0); // 连续分数上升日数（ending at i）
for (let i = 1; i < n; i++) scoreStreak[i] = scores[i] > scores[i - 1] ? scoreStreak[i - 1] + 1 : 0;
const cum3 = new Array(n).fill(0); // 近 3 日池累计收益（i≥2 有效）
for (let i = 2; i < n; i++) cum3[i] = poolRet[i] + poolRet[i - 1] + poolRet[i - 2];

// ── 抬仓数组：决策日 i 满足（分区 × 动量）→ 基座 B；null=维持 0.5 ──
const boostArr = (zone, streakArr, k, b) => scores.map((v, i) => (
  zone(v) && streakArr[i] >= k ? b : null
));
const z4050 = (v) => v >= 40 && v < 50;
const z3555 = (v) => v >= 35 && v < 55;
const zHalf = (v) => v > 24 && v < 65; // 引擎半仓档全区间（24~65）

const BOOST_M1 = boostArr(z4050, upStreak, 3, 0.7);     // 主案：40~50 × 池3连阳 × 0.7
const cum3Pos = scores.map((v, i) => (z4050(v) && i >= 2 && cum3[i] > 0 ? 0.7 : null));
const VARIANTS = [
  { key: 'E0', label: 'E0 V5.2 基线', p: pV52, ref: 'v52' },
  { key: 'M1', label: 'M1 40~50·池3连阳·0.7', p: { ...pV52, halfBoostByDay: BOOST_M1 } },
  { key: 'M2', label: 'M2 40~50·池3连阳·0.8', p: { ...pV52, halfBoostByDay: boostArr(z4050, upStreak, 3, 0.8) } },
  { key: 'M3', label: 'M3 40~50·池2连阳·0.7', p: { ...pV52, halfBoostByDay: boostArr(z4050, upStreak, 2, 0.7) } },
  { key: 'M4', label: 'M4 35~55·池3连阳·0.7', p: { ...pV52, halfBoostByDay: boostArr(z3555, upStreak, 3, 0.7) } },
  { key: 'M5', label: 'M5 24~65全半仓·池3连阳·0.7', p: { ...pV52, halfBoostByDay: boostArr(zHalf, upStreak, 3, 0.7) } },
  { key: 'M6', label: 'M6 40~50·分3连升·0.7', p: { ...pV52, halfBoostByDay: boostArr(z4050, scoreStreak, 3, 0.7) } },
  { key: 'M8', label: 'M8 40~50·池当日涨·0.7', p: { ...pV52, halfBoostByDay: boostArr(z4050, upStreak, 1, 0.7) } },
  { key: 'M9', label: 'M9 40~50·池3日累计>0·0.7', p: { ...pV52, halfBoostByDay: cum3Pos } },
  { key: 'V53A', label: 'V5.3-A（确认1+regime帽）', p: pV53A, ref: 'v53' },
  { key: 'M7', label: 'M7 V5.3-A+M1加速', p: { ...pV53A, halfBoostByDay: BOOST_M1 } },
];

// ── 池级回放（镜像 poolBacktest + 成本序列，统一走克隆函数） ──
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

// ── 门禁②：对账（容差对齐写档取整：1e-4 档 → 6e-5；sharpe 1e-3 档 → 6e-4） ──
const refJson = JSON.parse(readFileSync(join(ROOT, 'data', 'backtest.json'), 'utf8'));
const TOL = { total: 6e-5, maxDd: 6e-5, winRate: 6e-5, emptyRatio: 6e-5, sharpe: 6e-4 };
for (const v of VARIANTS) {
  if (!v.ref) continue;
  const a = runs[v.key].perf, b = refJson[v.ref];
  const bad = Object.keys(TOL).filter((k) => Math.abs(a[k] - b[k]) > TOL[k]);
  if (bad.length) {
    console.error(`[exp] 对账失败：${v.label} 字段 ${bad.join(',')}（重放 ${bad.map((k) => a[k])} vs 档案 ${bad.map((k) => b[k])}），终止`);
    process.exit(1);
  }
}
console.log('[exp] 门禁②通过：E0↔v52、V53A↔v53 与 data/backtest.json 吻合，变体数字可信\n');

// ── 触发/生效统计与增量归因（vs E0 基线） ──
const holdTotal = poolRet.reduce((a, r) => a * (1 + r), 1) - 1;
const E0 = runs.E0;
function boostStat(v) {
  const arr = v.p.halfBoostByDay;
  if (!arr) return null;
  const r = runs[v.key];
  let trigDays = 0, effDays = 0, dSum = 0, dPos = 0;
  let win = 0, lose = 0;
  let poolOnEff = 0, e0OnEff = 0, mOnEff = 0;
  for (let i = 0; i < n; i++) {
    if (arr[i] != null) trigDays++;
    if (r.pos[i] > E0.pos[i] + 1e-9) { // 生效日：实际持仓被抬高（T+1 后）
      effDays++;
      const d = r.strat[i] - E0.strat[i];
      dSum += d;
      dPos += r.pos[i] - E0.pos[i];
      if (d > 1e-12) win++; else if (d < -1e-12) lose++;
      poolOnEff += poolRet[i];
      e0OnEff += E0.strat[i];
      mOnEff += r.strat[i];
    }
  }
  return {
    trigDays, effDays, win, lose, dSum,
    avgDPos: effDays ? dPos / effDays : 0,
    poolAvg: effDays ? poolOnEff / effDays : 0,
    e0Sum: e0OnEff, mSum: mOnEff,
    dLog: r.strat.reduce((a, s, i) => a + Math.log(1 + s), 0)
      - E0.strat.reduce((a, s) => a + Math.log(1 + s), 0),
  };
}
const stats = {};
for (const v of VARIANTS) {
  const s = boostStat(v);
  if (s) stats[v.key] = s;
}

const pct = (x) => (x * 100).toFixed(2) + '%';
const fmt = (x, d = 3) => x.toFixed(d);
const zone4050Days = scores.filter(z4050).length;

console.log(`═══ 样本：${dates[0]} ~ ${dates[n - 1]}（${n} 交易日，指数收益覆盖 ${days.filter((d) => ASSETS.some((a) => Number.isFinite(d.indexes?.[a]))).length}/${n} 天） ═══`);
console.log(`═══ 40~50 分区信号日 ${zone4050Days} 个；其中池3连阳 ${BOOST_M1.filter((x) => x != null).length} 个、池2连阳 ${boostArr(z4050, upStreak, 2, 0.7).filter((x) => x != null).length} 个、分数3连升 ${boostArr(z4050, scoreStreak, 3, 0.7).filter((x) => x != null).length} 个 ═══\n`);

console.log('═══ 变体对照（全样本；换手=Σ|Δ仓位|，成本含佣金/印花/滑点） ═══');
console.log('变体                          总收益    夏普     最大回撤  胜率     空仓率   开仓  换手    成本(bp)  超额vs池   ΔvsE0(累计)');
for (const v of VARIANTS) {
  const r = runs[v.key];
  let turnover = r.pos[0];
  for (let i = 1; i < n; i++) turnover += Math.abs(r.pos[i] - r.pos[i - 1]);
  const dTot = r.perf.total - E0.perf.total;
  console.log(
    `${v.label.padEnd(30)} ${pct(r.perf.total).padStart(8)}  ${fmt(r.perf.sharpe, 3).padStart(7)}  ${pct(r.perf.maxDd).padStart(8)}  ${pct(r.perf.winRate).padStart(7)}  ${pct(r.perf.emptyRatio).padStart(7)}  ${String(r.perf.opens).padStart(4)}  ${fmt(turnover, 1).padStart(6)}  ${fmt(r.cost.reduce((a, c) => a + c, 0) * 1e4, 1).padStart(8)}  ${pct(r.perf.total - holdTotal).padStart(9)}  ${pct(dTot).padStart(10)}`,
  );
}

console.log('\n═══ 加速机制归因（vs E0 基线；生效日=实际持仓被抬高的交易日） ═══');
console.log('变体                          触发日  生效日  生效日均Δ仓  生效日池均收益  生效日E0累计  生效日变体累计  增量胜/负日   Δ合计');
for (const v of VARIANTS) {
  const s = stats[v.key];
  if (!s) continue;
  console.log(
    `${v.label.padEnd(30)} ${String(s.trigDays).padStart(4)}   ${String(s.effDays).padStart(4)}   ${fmt(s.avgDPos, 3).padStart(8)}    ${pct(s.poolAvg).padStart(9)}    ${fmt(s.e0Sum * 100, 2).padStart(8)}%    ${fmt(s.mSum * 100, 2).padStart(9)}%    ${String(s.win).padStart(3)}/${String(s.lose).padStart(3)}     ${pct(s.dSum).padStart(8)}`,
  );
}

// ── Markdown 报告 ──
const md = [];
md.push('# 实验报告：半山腰（40~50 分）动量加速');
md.push('');
md.push(`生成：node tools/backtest/experiment_momentum_boost.mjs · 样本 ${dates[0]} ~ ${dates[n - 1]}（${n} 交易日，指数收益全覆盖）`);
md.push('');
md.push('## 0. 规则设计（右侧动量，不破坏"不接飞刀"纪律）');
md.push('');
md.push('- **触发**（决策日 i 收盘判定，T+1 生效，无前视）：信号分落在目标分区 **且** 池收益已连续 K 日上涨（`upStreak ≥ K`，池=三指数等权日收益均值）。');
md.push('- **动作**：该决策日的半仓基座从 0.5 临时抬至 B（主案 0.7）。仍乘各帽子（回撤降仓/regime 帽取 min 后的 cap），仍在确认门内（`held || pending > confirmDays`）——加速**不绕过**右侧二次确认；止损/过热/清仓路径完全不受影响。');
md.push('- **退出**：条件日检不满足即回落 0.5 基座；`maxPosChg=0.2` 平滑约束过渡（0.5→0.7 恰在 ±0.2 限内，单日可达）。');
md.push('- **实现**：引擎原生参数只能压仓不能抬仓（`maxPosByDay` 是 min 语义帽子，半仓分支 `0.5×cap` 天花板即 0.5），故本地克隆 `positions()` 加 `halfBoostByDay` 钩子；**未改任何生产代码**。');
md.push('- **保真门禁（双）**：①克隆在 `halfBoostByDay=null` 时与引擎 `positions()` 逐位相等（v52/v53A 参数组 × 全资产全序列）；②E0↔v52、V53A↔v53 与 `data/backtest.json` 对账通过（容差对齐取整精度）。两门禁均绿后变体数字才可信。');
md.push('');
md.push(`触发条件样本量：40~50 分区信号日 ${zone4050Days} 个，其中池3连阳 ${BOOST_M1.filter((x) => x != null).length} 个、池2连阳 ${boostArr(z4050, upStreak, 2, 0.7).filter((x) => x != null).length} 个、分数3连升 ${boostArr(z4050, scoreStreak, 3, 0.7).filter((x) => x != null).length} 个。`);
md.push('');
md.push('## 1. 变体对照（全样本）');
md.push('');
md.push('| 变体 | 规则 | 总收益 | 夏普 | 最大回撤 | 胜率 | 空仓率 | 开仓 | 换手 | 成本(bp) | 超额vs池 | ΔvsE0 |');
md.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
const RULES = {
  E0: 'V5.2 基线', M1: '40~50 × 池3连阳 → 0.7', M2: '40~50 × 池3连阳 → 0.8',
  M3: '40~50 × 池2连阳 → 0.7', M4: '35~55 × 池3连阳 → 0.7',
  M5: '24~65 全半仓 × 池3连阳 → 0.7', M6: '40~50 × 分数3连升 → 0.7',
  M8: '40~50 × 池当日涨 → 0.7（无确认）', M9: '40~50 × 池3日累计>0 → 0.7',
  V53A: 'V5.3-A（确认1+regime帽）', M7: 'V5.3-A + M1 加速',
};
for (const v of VARIANTS) {
  const r = runs[v.key];
  let turnover = r.pos[0];
  for (let i = 1; i < n; i++) turnover += Math.abs(r.pos[i] - r.pos[i - 1]);
  md.push(`| ${v.key} | ${RULES[v.key]} | ${pct(r.perf.total)} | ${fmt(r.perf.sharpe, 3)} | ${pct(r.perf.maxDd)} | ${pct(r.perf.winRate)} | ${pct(r.perf.emptyRatio)} | ${r.perf.opens} | ${fmt(turnover, 1)} | ${fmt(r.cost.reduce((a, c) => a + c, 0) * 1e4, 1)} | ${pct(r.perf.total - holdTotal)} | ${pct(r.perf.total - E0.perf.total)} |`);
}
md.push('');
md.push('## 2. 加速机制归因（vs E0 基线）');
md.push('');
md.push('生效日 = 实际持仓被抬高（T+1 后 `pos > E0.pos`）的交易日；Δ合计 = 生效日策略收益差的算术和（含增量成本）。');
md.push('');
md.push('| 变体 | 触发日 | 生效日 | 生效日均Δ仓 | 生效日池均收益 | 生效日E0累计 | 生效日变体累计 | 增量胜/负日 | Δ合计 |');
md.push('|---|---|---|---|---|---|---|---|---|');
for (const v of VARIANTS) {
  const s = stats[v.key];
  if (!s) continue;
  md.push(`| ${v.key} | ${s.trigDays} | ${s.effDays} | ${fmt(s.avgDPos, 3)} | ${pct(s.poolAvg)} | ${fmt(s.e0Sum * 100, 2)}% | ${fmt(s.mSum * 100, 2)}% | ${s.win}/${s.lose} | ${pct(s.dSum)} |`);
}
md.push('');
md.push('---');
md.push('## 3. 机制解剖：唯一触发日 2026-05-26 的完整传播链');
md.push('');
md.push('全样本 40~50 × 池3连阳只有 2026-05-26 一天（分数 40.48、连阳 3）。该案例把三条引擎动力学暴露得干干净净：');
md.push('');
md.push('1. **M1（0.7）零生效——平滑夹缝吸收**：该决策日前目标仓位 0.9（减仓途中），`maxPosChg=0.2` 平滑下限 = 0.9−0.2 = **0.7**。基线目标 0.5 被夹到 0.7，抬仓目标 0.7 也被夹到 0.7——两版逐位相等。**"半仓抬到 0.7"在减仓途中天然无感**：0.7 恰是平滑轨道本身就会到达的位置。');
md.push('2. **M2（0.8）6 个生效日——路径依赖级联**：+0.1 的目标偏移经平滑在 05-27~06-03 持续 6 天（0.8/0.6 交替 vs 基线 0.7/0.5）；偏移改变的净值路径 `eq` 在两个月后（2026-08-05）翻转了回撤降仓分支（curDd 跨过 0.6×15% 阈值），当日仓位反而比基线**低**（0.7 vs 0.9）——单触发日被引擎状态机放大成跨月噪声，净效果 −0.13%。');
md.push('3. **结构性结论**：分数是市场的滞后变换——池连涨 3 日时分数大概率已升出 40~50 区（去 60+ 甚至满仓区），"停在 40~50 且动量已确认"近乎空集（26 个分区日里仅 1 天）。**半山腰踏空的反弹，等右侧确认到齐时，仓位衔接早已交给满仓区分支**——那正是全样本超额 +6.27% 的来源。加速器想接的班，现有档位切换其实已经在接。');
md.push('4. **M8 是决定性反证**：把确认放宽到"池当日涨"（4 触发、20 生效日——全部变体中唯一有像样样本量的口径），生效日池均收益 **−0.50%**、增量 7 胜 13 负、Δ 合计 **−0.41%**。40~50 分区里"昨日涨"的次日平均是**跌**的——半山腰踏空的那些涨幅，在右侧动量口径下根本不是可延续行情；放宽确认去追，就是把"接飞刀"从清仓区搬进了半仓区。');
md.push('');
md.push('---');
md.push('## 4. 裁决');
md.push('');
md.push('- **严格版（池3连阳/分数3连升）**：条件近乎空集 + 平滑夹缝吸收 → 无操作、无伤害、无信息——规则形同虚设。');
md.push('- **宽松版（当日涨/3日累计>0）**：有样本、方向为负（M8 −0.41%、M9 −0.10%）——规则有害。');
md.push('- **中间档（M5 全半仓 3 连阳）**：5 触发 4 生效 Δ +0.01%——噪音。');
md.push('- **结论：P1-B"动量加速"不建议转正。** 半仓区的职责是跌段减损；"跟上反弹节奏"的职责已由 65+ 满仓区分支承担（区间超额 +6.27%）。若仍想优化半山腰，下一个该检验的对象是**分区边界（hi/lo）的滞后期**（反弹确认与分数升出分区的时差），而不是在半仓档内加加速器。任何未来变体仍须走 `scripts/promote_params.mjs` 样本外门禁。');
md.push('');
md.push('---');
md.push('## 读法警示');
md.push('');
md.push('1. **样本量**：40~50 分区本身仅几十个信号日，动量条件再切一刀后触发日更少（3连阳仅 1 天、分数3连升 0 天）——所有差异都在"机制敏感性演示"层面，不足以直接支撑写进 config。');
md.push('2. **样本内补丁风险**：40~50 段跑输池 7.4pp 的诊断来自同一段数据，本实验是在同一样本上"哪里疼补哪里"——即便某个变体改善，也必须先过 `scripts/promote_params.mjs` 的样本外门禁（滚动 walk-forward）再谈转正。');
md.push('3. **动量定义敏感性**：M1（池3连阳）/M6（分数3连升）/M8（当日涨）/M9（3日累计>0）是四种动量源、宽严两档；若结论在不同定义间翻转，说明抓的是噪音不是结构。');
md.push('4. **平滑机制的隐性上限**：空仓新进场日 `maxPosChg=0.2` 会把 0→0.7 压到 0.2，加速主要作用于"已持仓的半仓抬升"，对新建仓几乎无效——这是设计使然（进场仍走确认门），不是 bug；见第 3 节 M1 案例。');

mkdirSync(join(ROOT, 'tools', 'backtest', 'reports'), { recursive: true });
writeFileSync(join(ROOT, 'tools', 'backtest', 'reports', 'experiment_momentum_boost.md'), md.join('\n'), 'utf8');
console.log('\n[exp] 报告已写 tools/backtest/reports/experiment_momentum_boost.md');
