#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 实验（只读旁路）：满仓区（信号分 65~80）动态降仓回测
// ─────────────────────────────────────────────────────────────────────────────
// 实现方式：不改 src/backtest.js——用引擎原生 maxPosByDay（逐日仓位帽子，V5.3 regime
//   帽子同款机制）构造"信号分区帽子数组"：帽子与信号同日对齐（决策日 i 的分数落在
//   满仓区 → 该决策的目标仓位上限 0.7，T+1 生效），与回撤降仓取 min。
// 对照组：E0=V5.2 基线、V53A=V5.3-A（确认+regime帽），二者必须与 data/backtest.json
//   对账通过（对齐写档取整容差）才输出变体数字。
// 纪律：config.params.train 只读；输出仅 tools/backtest/reports/experiment_zone_cap.md（gitignore 约定不入库）。
//
// 用法：node tools/backtest/experiment_zone_cap.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import config from '../../src/config.js';
import { decodeArchive } from '../../src/lhb_codec.js';
import { classifySeries } from '../../src/regime.js';
import { bandFor } from '../../src/position_policy.js';
import {
  BASE_PARAMS, scoreWith, positions, turnoverCost, metrics,
} from '../../src/backtest.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

// ── 输入重建（与 scripts/backtest.mjs / diagnose_v52.mjs 逐行同款） ──
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

// ── 分区帽子数组（决策日 i 的信号分 → 该日目标仓上限；null=不压制） ──
// 引擎语义（src/backtest.js positions）：cap 先经回撤降仓，再 min(maxPosByDay[i])，
// 满仓分支 target=cap、半仓分支 target=0.5*cap、过热分支 held?cap:0 ——帽子对三档全生效，
// 与"只在满仓区压帽子"的实验意图一致（其他区信号本身不到 cap 上限，压了也无感）。
const zoneArr = (lo, hi, cap) => scores.map((v) => (v >= lo && v < hi ? cap : null));
const mergeCaps = (a, b) => a.map((x, i) => {
  const y = b[i];
  const xs = x != null && Number.isFinite(+x) ? +x : null;
  const ys = y != null && Number.isFinite(+y) ? +y : null;
  if (xs == null) return ys;
  if (ys == null) return xs;
  return Math.min(xs, ys);
});

const CAP_FULL70 = zoneArr(65, 80, 0.7);   // 仅满仓区 [65,80)
const CAP_FULL80 = zoneArr(65, 80, 0.8);   // 仅满仓区，温和档
const CAP_FULL50 = zoneArr(65, 80, 0.5);   // 仅满仓区，激进档
const CAP_GE65 = zoneArr(65, 101, 0.7);    // ≥65 全压（含过热区）——"满仓油门踩轻"原方案
const CAP_GE65_50 = zoneArr(65, 101, 0.5); // ≥65 全压 0.5（敏感性上界）

const VARIANTS = [
  { key: 'E0', label: 'E0 V5.2 基线（无帽子）', p: pV52, ref: 'v52' },
  { key: 'E1', label: 'E1 V5.2+满仓区帽0.7', p: { ...pV52, maxPosByDay: CAP_FULL70 } },
  { key: 'E1b', label: 'E1b V5.2+满仓区帽0.8', p: { ...pV52, maxPosByDay: CAP_FULL80 } },
  { key: 'E3', label: 'E3 V5.2+满仓区帽0.5', p: { ...pV52, maxPosByDay: CAP_FULL50 } },
  { key: 'E2', label: 'E2 V5.2+≥65全帽0.7', p: { ...pV52, maxPosByDay: CAP_GE65 } },
  { key: 'E2b', label: 'E2b V5.2+≥65全帽0.5', p: { ...pV52, maxPosByDay: CAP_GE65_50 } },
  { key: 'V53A', label: 'V5.3-A（确认1+regime帽）', p: { ...pV52, confirmDays: 1, maxPosByDay: regimeCaps }, ref: 'v53' },
  { key: 'E4', label: 'E4 V5.3-A+满仓区帽0.7', p: { ...pV52, confirmDays: 1, maxPosByDay: mergeCaps(regimeCaps, CAP_FULL70) } },
];

// ── 池级回放（镜像 poolBacktest + 成本序列） ──
function poolRun(sc, p) {
  const assets = Object.keys(retsByAsset);
  const strat = new Array(n).fill(0);
  const pos = new Array(n).fill(0);
  const cost = new Array(n).fill(0);
  let opens = 0;
  for (const a of assets) {
    const pa = positions(sc, retsByAsset[a], p);
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

// ── 对账门禁（容差对齐写档取整：1e-4 档 → 6e-5；sharpe 1e-3 档 → 6e-4） ──
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
console.log('[exp] 对账通过：E0↔v52、V53A↔v53 与 data/backtest.json 吻合，变体数字可信\n');

// ── 真实日/零填充日与池基准 ──
const realDay = days.map((d) => ASSETS.some((a) => Number.isFinite(d.indexes?.[a])));
const nReal = realDay.filter(Boolean).length;
const poolRet = Array.from({ length: n }, (_, i) => ASSETS.reduce((a, k) => a + retsByAsset[k][i], 0) / ASSETS.length);
const holdTotal = poolRet.reduce((a, r) => a * (1 + r), 1) - 1;

const ZONES = [
  { key: '清仓区 ≤24', test: (v) => v <= 24 },
  { key: '半仓区 24~65', test: (v) => v > 24 && v < 65 },
  { key: '满仓区 65~80', test: (v) => v >= 65 && v <= 80 },
  { key: '过热区 >80', test: (v) => v > 80 },
];

// 分区归因（仅真实收益日；T+1：昨日分区 × 今日策略收益）
function attribution(run) {
  const acc = ZONES.map(() => ({ sigDays: 0, heldDays: 0, winDays: 0, stratSum: 0, poolSum: 0, cumLog: 0 }));
  for (let i = 1; i < n; i++) {
    if (!realDay[i]) continue;
    const k = ZONES.findIndex((z) => z.test(scores[i - 1]));
    if (k < 0) continue;
    const a = acc[k];
    a.sigDays++;
    a.stratSum += run.strat[i];
    a.poolSum += poolRet[i];
    a.cumLog += Math.log(1 + run.strat[i]);
    if (run.pos[i] > 0) { a.heldDays++; if (run.strat[i] > 0) a.winDays++; }
  }
  return acc;
}
const attrs = { E0: attribution(runs.E0), E1: attribution(runs.E1), E4: attribution(runs.E4) };

// 真实/零填充分解
function split(run) {
  const s = { real: { cum: 0, cost: 0 }, fake: { cum: 0, cost: 0 } };
  for (let i = 0; i < n; i++) {
    const t = realDay[i] ? s.real : s.fake;
    t.cum += Math.log(1 + run.strat[i]);
    t.cost += run.cost[i];
  }
  return s;
}

const pct = (x) => (x * 100).toFixed(2) + '%';
const fmt = (x, d = 3) => x.toFixed(d);

console.log(`═══ 前提提醒：指数收益覆盖 ${nReal}/${n} 天（其余为零填充日）——分区归因只看真实日子表 ═══\n`);

console.log('═══ 变体对照（全样本；换手=Σ|Δ仓位|，成本含佣金/印花/滑点） ═══');
console.log('变体                        总收益    夏普     最大回撤  胜率     空仓率   开仓  换手    成本(bp)  超额vs池   真实日贡献  零填充日贡献');
for (const v of VARIANTS) {
  const r = runs[v.key];
  const sp = split(r);
  let turnover = r.pos[0];
  for (let i = 1; i < n; i++) turnover += Math.abs(r.pos[i] - r.pos[i - 1]);
  const costBp = r.cost.reduce((a, c) => a + c, 0) * 1e4;
  console.log(
    `${v.label.padEnd(28)} ${pct(r.perf.total).padStart(8)}  ${fmt(r.perf.sharpe, 3).padStart(7)}  ${pct(r.perf.maxDd).padStart(8)}  ${pct(r.perf.winRate).padStart(7)}  ${pct(r.perf.emptyRatio).padStart(7)}  ${String(r.perf.opens).padStart(4)}  ${fmt(turnover, 1).padStart(6)}  ${fmt(costBp, 1).padStart(8)}  ${pct(r.perf.total - holdTotal).padStart(9)}  ${fmt(sp.real.cum * 100, 2).padStart(8)}%  ${fmt(sp.fake.cum * 100, 2).padStart(8)}%`,
  );
}

for (const key of ['E0', 'E1', 'E4']) {
  console.log(`\n═══ 分区归因 · ${VARIANTS.find((v) => v.key === key).label}（仅真实收益日，T+1） ═══`);
  console.log('分区          信号日  持仓日  胜率     策略累计   池累计');
  for (let k = 0; k < ZONES.length; k++) {
    const a = attrs[key][k];
    console.log(
      `${ZONES[k].key.padEnd(12)} ${String(a.sigDays).padStart(4)}   ${String(a.heldDays).padStart(4)}   ${pct(a.heldDays ? a.winDays / a.heldDays : 0).padStart(7)}  ${fmt(a.cumLog * 100, 2).padStart(8)}%  ${fmt(a.poolSum * 100, 2).padStart(7)}%`,
    );
  }
}

// ── Markdown 报告 ──
const md = [];
md.push('# 实验报告：满仓区（信号分 65~80）动态降仓');
md.push('');
md.push(`生成：node tools/backtest/experiment_zone_cap.mjs · 样本 ${dates[0]} ~ ${dates[n - 1]}（${n} 交易日，**指数收益仅覆盖 ${nReal} 天**，其余为零填充日）`);
md.push('实现：引擎原生 `maxPosByDay` 逐日帽子（与 V5.3 regime 帽同机制），决策日信号分落在 [65,80) → 该日目标仓上限压至帽值，T+1 生效；**未改任何生产代码**。');
md.push(`对账：E0↔v52、V53A↔v53 与 data/backtest.json 吻合（容差对齐取整精度）。`);
md.push('');
md.push('## 1. 变体对照（全样本）');
md.push('');
md.push('| 变体 | 总收益 | 夏普 | 最大回撤 | 胜率 | 空仓率 | 开仓 | 换手 | 成本(bp) | 超额vs池 | 真实日贡献 | 零填充日贡献 |');
md.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const v of VARIANTS) {
  const r = runs[v.key];
  const sp = split(r);
  let turnover = r.pos[0];
  for (let i = 1; i < n; i++) turnover += Math.abs(r.pos[i] - r.pos[i - 1]);
  md.push(`| ${v.label} | ${pct(r.perf.total)} | ${fmt(r.perf.sharpe, 3)} | ${pct(r.perf.maxDd)} | ${pct(r.perf.winRate)} | ${pct(r.perf.emptyRatio)} | ${r.perf.opens} | ${fmt(turnover, 1)} | ${fmt(r.cost.reduce((a, c) => a + c, 0) * 1e4, 1)} | ${pct(r.perf.total - holdTotal)} | ${fmt(sp.real.cum * 100, 2)}% | ${fmt(sp.fake.cum * 100, 2)}% |`);
}
md.push('');
md.push('## 2. 分区归因（仅真实收益日，T+1 对齐）');
md.push('');
for (const key of ['E0', 'E1', 'E4']) {
  md.push(`### ${VARIANTS.find((v) => v.key === key).label}`);
  md.push('');
  md.push('| 分区 | 信号日 | 持仓日 | 胜率 | 策略累计 | 池累计 |');
  md.push('|---|---|---|---|---|---|');
  for (let k = 0; k < ZONES.length; k++) {
    const a = attrs[key][k];
    md.push(`| ${ZONES[k].key} | ${a.sigDays} | ${a.heldDays} | ${a.heldDays ? pct(a.winDays / a.heldDays) : '-'} | ${fmt(a.cumLog * 100, 2)}% | ${fmt(a.poolSum * 100, 2)}% |`);
  }
  md.push('');
}
md.push('---');
md.push('## 读法警示');
md.push('');
md.push(`1. 真实收益日仅 ${nReal} 天，满仓区真实信号日仅 ${attrs.E0[2].sigDays} 个——本实验所有差异都在"机制敏感性演示"层面，**不足以支撑把任何帽子写进 config**。`);
md.push('2. 全样本总收益里混着零填充日的纯成本效应：降仓会机械地省成本（零填充日无行情可赚、仓位却照付摩擦），这部分"改善"与策略优劣无关。看方向请以"真实日贡献"列为准。');
md.push('3. 与正式 promote 流程的关系：若未来要把分区帽子转正，须按纪律走样本外门禁（scripts/promote_params.mjs），且在指数收益补齐后重估。');

mkdirSync(join(ROOT, 'tools', 'backtest', 'reports'), { recursive: true });
writeFileSync(join(ROOT, 'tools', 'backtest', 'reports', 'experiment_zone_cap.md'), md.join('\n'), 'utf8');
console.log('\n[exp] 报告已写 tools/backtest/reports/experiment_zone_cap.md');
