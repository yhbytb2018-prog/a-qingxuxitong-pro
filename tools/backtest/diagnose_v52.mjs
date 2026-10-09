#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 诊断脚本（只读旁路）：情绪分区亏损归因 + 平滑/确认参数变体重放
// ─────────────────────────────────────────────────────────────────────────────
// 定位：不跑网格、不写 data/——从 data/archive.json 重建与 scripts/backtest.mjs
//       完全相同的输入（因子/逐资产收益/regime 帽子），用 src/backtest.js 的
//       真实引擎函数做参数变体重放，输出归因表与 A/B/C 对照。
// 校验：重放结果必须与 data/backtest.json 的 v52/v53 吻合（容差 1e-4），
//       吻合才说明变体数字可信——校验失败立即退出，绝不输出未验证的结论。
// 纪律：config.params.train（实验锚点）只读；变体参数只存在于本脚本内存；
//       输出仅 tools/backtest/reports/diagnose_v52.md（诊断产物，gitignore 约定不入库）。
//
// 用法：node tools/backtest/diagnose_v52.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import config from '../../src/config.js';
import { decodeArchive } from '../../src/lhb_codec.js';
import { classifySeries } from '../../src/regime.js';
import { bandFor } from '../../src/position_policy.js';
import {
  BASE_PARAMS, V52_PARAMS, scoreWith, positions, turnoverCost, metrics,
} from '../../src/backtest.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

// ── 输入重建（与 scripts/backtest.mjs 逐行同款，保证口径一致） ──
const arch = decodeArchive(JSON.parse(readFileSync(join(ROOT, 'data', 'archive.json'), 'utf8')));
const days = (arch.all_days || []).filter((d) => d && d.trade_date && !(d.emotion && d.emotion._backfill));
if (days.length < 5) { console.error('[diagnose] 样本不足'); process.exit(1); }

const dates = days.map((d) => d.trade_date);
const factorsByDay = days.map((d) => d.emotion?.factors || {});
const ASSETS = config.backtest.assets;
const retsByAsset = {};
for (const a of ASSETS) {
  retsByAsset[a] = days.map((d) => {
    const v = d.indexes?.[a];
    return Number.isFinite(v) ? v / 100 : 0; // 存档百分比 → 小数
  });
}
const emotionArch = days.map((d) => d.emotion?.value ?? null); // 存档综合分（页面口径）

const TR = config.params.train;
const baseW = { ...TR.weights };
const plainW = {};
for (const [wk, pk] of Object.entries(config.factorKeyMap)) plainW[pk] = baseW[wk];
const pBase = { ...BASE_PARAMS, ...TR.thresholds };
const pV52 = { ...pBase, ...TR.stops, ...TR.costModel };

const scores = scoreWith(factorsByDay, plainW); // 信号 = train 权重重算分（与正式回测同口径）
const drift = emotionArch.reduce((a, v, i) => (v == null ? a : Math.max(a, Math.abs(v - scores[i]))), 0);

// regime 逐日帽子（与 scripts/backtest.mjs 同款：存档综合分 + pct_rank + seal_pct）
const regimeDays = days.map((d) => ({
  trade_date: d.trade_date,
  value: d.emotion ? d.emotion.value : null,
  pct_rank: d.emotion ? d.emotion.pct_rank : null,
  seal_pct: d.summary ? d.summary.seal_pct : null,
}));
const regimeSeries = classifySeries(regimeDays);
const maxPosByDay = regimeSeries.map((s) => {
  const b = bandFor(s.key);
  return b ? b.maxPos : null;
});

// ── 池级回放（镜像 poolBacktest，但额外聚合成本序列供摩擦分解） ──
function poolRun(sc, p) {
  const assets = Object.keys(retsByAsset);
  const n = sc.length;
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

const r4 = (x) => Math.round(x * 1e4) / 1e4;

// ── 变体定义（A=正式 v53 参数；B/C/D 为诊断变体，全部不动 config） ──
const pV53 = { ...pV52, confirmDays: 1, maxPosByDay };
const VARIANTS = [
  { key: 'V5.2', label: 'V5.2 基线（平滑0.2，无确认无帽）', p: pV52, ref: 'v52' },
  { key: 'V5.2ns', label: 'V5.2-去平滑（maxPosChg=0）', p: { ...pV52, maxPosChg: 0 } },
  { key: 'V53A', label: 'V5.3-A（确认1日+帽+平滑0.2）', p: pV53, ref: 'v53' },
  { key: 'V53B', label: 'V5.3-B（确认1日+帽+去平滑）', p: { ...pV53, maxPosChg: 0 } },
  { key: 'V53C', label: 'V5.3-C（确认3日+帽+平滑0.2）', p: { ...pV53, confirmDays: 3 } },
  { key: 'V53D', label: 'V5.3-D（确认1日+帽+平滑0.5）', p: { ...pV53, maxPosChg: 0.5 } },
];

const runs = {};
for (const v of VARIANTS) runs[v.key] = poolRun(scores, v.p);

// ── 重放校验：与 data/backtest.json 对账（不过就退出） ──
// 容差对齐写档取整精度：total/maxDd/winRate/emptyRatio 取整 1e-4 → 容差 6e-5；
// sharpe 取整 1e-3 → 容差 6e-4。
const refJson = JSON.parse(readFileSync(join(ROOT, 'data', 'backtest.json'), 'utf8'));
const TOL = { total: 6e-5, maxDd: 6e-5, winRate: 6e-5, emptyRatio: 6e-5, sharpe: 6e-4 };
const check = (runKey, jsonKey, name) => {
  const a = runs[runKey].perf, b = refJson[jsonKey];
  const bad = Object.keys(TOL).filter((k) => Math.abs(a[k] - b[k]) > TOL[k]);
  if (bad.length) {
    console.error(`[diagnose] 重放校验失败：${name} 字段 ${bad.join(',')} 偏差超容差，变体数字不可信，终止`);
    for (const k of bad) console.error(`  ${k}: 重放 ${a[k]} vs 档案 ${b[k]}`);
    process.exit(1);
  }
  return true;
};
check('V5.2', 'v52', 'V5.2');
check('V53A', 'v53', 'V5.3-A');
console.log('[diagnose] 重放校验通过：V5.2 与 V5.3-A 均与 data/backtest.json 逐位吻合（±1e-4）\n');

// ── 样本画像（原始未取整收益）+ 收益覆盖探针 ──
// ⚠ 核心发现：archive 的 indexes（三指数日涨跌幅）只覆盖近期一段；缺失日被
//   scripts/backtest.mjs 的 `: 0` 回退按 0 收益处理。覆盖率必须显式量化——它
//   决定胜率/夏普/归因表里有多少是"缺失天的算术产物"、多少是真实市场行为。
const n = dates.length;
const poolRet = Array.from({ length: n }, (_, i) => ASSETS.reduce((a, k) => a + retsByAsset[k][i], 0) / ASSETS.length);
const upDays = poolRet.filter((r) => r > 0).length;
const flatDays = poolRet.filter((r) => r === 0).length;
const downDays = poolRet.filter((r) => r < 0).length;
const holdTotal = poolRet.reduce((a, r) => a * (1 + r), 1) - 1;
const sortedPool = [...poolRet].sort((a, b) => a - b);
const q = (p) => sortedPool[Math.min(sortedPool.length - 1, Math.floor(sortedPool.length * p))];

// 收益覆盖：任一资产 indexes 有限值即算覆盖日（真实行情日）
const realDay = days.map((d) => ASSETS.some((a) => Number.isFinite(d.indexes?.[a])));
const nReal = realDay.filter(Boolean).length;
const nFake = n - nReal;
const firstReal = dates[realDay.indexOf(true)];
const lastReal = dates[realDay.lastIndexOf(true)];
const upReal = poolRet.filter((r, i) => realDay[i] && r > 0).length;
const downReal = poolRet.filter((r, i) => realDay[i] && r < 0).length;
let benchTotal = null;
try {
  benchTotal = JSON.parse(readFileSync(join(ROOT, 'data', 'backtest-strategies.json'), 'utf8')).benchmark?.total ?? null;
} catch { /* 基准档缺失时留空，不阻塞诊断 */ }

// ── 情绪分区归因（T+1：第 i-1 日信号分区 × 第 i 日策略收益） ──
// 分区对齐引擎真实行为档位（positions 只用 panic24/lo65/overheat80 三条线）：
//   ≤24 清仓区 / (24,65) 半仓区 / [65,80] 满仓区 / >80 过热区（只减不增）
const ZONES = [
  { key: '清仓区 ≤24', test: (v) => v <= 24 },
  { key: '半仓区 24~65', test: (v) => v > 24 && v < 65 },
  { key: '满仓区 65~80', test: (v) => v >= 65 && v <= 80 },
  { key: '过热区 >80', test: (v) => v > 80 },
];
const zoneOf = (v) => ZONES.find((z) => z.test(v));

function attribution(run, dayFilter = null) {
  const acc = ZONES.map(() => ({
    sigDays: 0, heldDays: 0, winDays: 0, posSum: 0, stratSum: 0, poolSum: 0, cumLog: 0, worst: 0, bigLoss: 0,
  }));
  for (let i = 1; i < n; i++) {
    if (dayFilter && !dayFilter(i)) continue;
    const z = zoneOf(scores[i - 1]);
    if (!z) continue;
    const k = ZONES.indexOf(z);
    const a = acc[k];
    a.sigDays++;
    a.posSum += run.pos[i];
    a.stratSum += run.strat[i];
    a.poolSum += poolRet[i];
    a.cumLog += Math.log(1 + run.strat[i]);
    if (run.pos[i] > 0) { a.heldDays++; if (run.strat[i] > 0) a.winDays++; }
    a.worst = Math.min(a.worst, run.strat[i]);
    if (run.strat[i] < -0.01) a.bigLoss++;
  }
  return acc;
}

const attrV52 = attribution(runs['V5.2']);
const attrV53A = attribution(runs.V53A);
const attrReal = attribution(runs['V5.2'], (i) => realDay[i]); // 仅真实收益日（V5.2）

// 真实日 vs 零填充日分解（V5.2）：零填充日的策略收益 = 纯成本（无行情可赚）
const split = { real: { days: 0, held: 0, win: 0, cumLog: 0, cost: 0 }, fake: { days: 0, held: 0, cumLog: 0, cost: 0 } };
{
  const r = runs['V5.2'];
  for (let i = 0; i < n; i++) {
    const t = realDay[i] ? split.real : split.fake;
    t.days++;
    t.cumLog += Math.log(1 + r.strat[i]);
    t.cost += r.cost[i];
    if (r.pos[i] > 0) { t.held++; if (r.strat[i] > 0) t.win++; }
  }
}

// 十分位细分桶（找"接飞刀"具体分数段；10 分一桶）
const BINS = Array.from({ length: 10 }, (_, b) => ({ lo: b * 10, hi: (b + 1) * 10 }));
const binAcc = BINS.map(() => ({ sig: 0, held: 0, win: 0, cumLog: 0, poolCum: 0 }));
for (let i = 1; i < n; i++) {
  const v = scores[i - 1];
  const b = Math.min(9, Math.max(0, Math.floor(v / 10)));
  const a = binAcc[b];
  a.sig++;
  a.poolCum += Math.log(1 + poolRet[i]);
  a.cumLog += Math.log(1 + runs['V5.2'].strat[i]);
  if (runs['V5.2'].pos[i] > 0) { a.held++; if (runs['V5.2'].strat[i] > 0) a.win++; }
}

// ── 汇总输出 ──
const pct = (x) => (x * 100).toFixed(2) + '%';
const fmt = (x, d = 3) => x.toFixed(d);

console.log('═══ ⚠ 数据覆盖（本报告最重要发现，先读这节） ═══');
console.log(`指数日收益覆盖率：${nReal}/${n} 天（${firstReal} ~ ${lastReal}），其余 ${nFake} 天 indexes 缺失、引擎按 0 收益处理`);
console.log(`覆盖日内：上涨 ${upReal} / 下跌 ${downReal}（覆盖日上涨占比 ${pct(upReal / nReal)}——真实分布并非 6%）`);
console.log(`⇒ 全样本"6% 持仓日胜率" = ${upReal} 个上涨日 ÷ ~240 个持仓日：缺失天灌大分母的算术产物，不是市场行为\n`);

console.log('═══ 样本画像（原始收益，未取整） ═══');
console.log(`交易日 ${n}（${dates[0]} ~ ${dates[n - 1]}，其中有效行情 ${nReal} 天）；权重漂移 max|存档分-重算分| = ${fmt(drift)} 分`);
console.log(`池日收益：上涨 ${upDays} 天 (${pct(upDays / n)}) / 平 ${flatDays}（=缺失填充） / 下跌 ${downDays} (${pct(downDays / n)})`);
console.log(`池日收益分位：p25=${pct(q(0.25))} p50=${pct(q(0.5))} p75=${pct(q(0.75))} 最差=${pct(q(0))} 最好=${pct(q(1))}`);
console.log(`池买入持有总收益：${pct(holdTotal)}（同期沪深300：${benchTotal == null ? '-' : pct(benchTotal)}）`);
console.log(`情绪分范围：[${Math.min(...scores)} , ${Math.max(...scores)}]，≤24 的信号日 ${scores.filter((v) => v <= 24).length} 天\n`);

console.log('═══ V5.2 真实日 vs 零填充日分解（零填充日策略收益 = 纯成本） ═══');
console.log(`真实日：${split.real.days} 天，持仓 ${split.real.held} 天（胜率 ${pct(split.real.held ? split.real.win / split.real.held : 0)}），累计贡献 ${fmt(split.real.cumLog * 100, 2)}%，成本 ${fmt(split.real.cost * 1e4, 1)}bp`);
console.log(`零填充日：${split.fake.days} 天，持仓 ${split.fake.held} 天，累计贡献 ${fmt(split.fake.cumLog * 100, 2)}%，成本 ${fmt(split.fake.cost * 1e4, 1)}bp\n`);

console.log('═══ 情绪分区归因 · V5.2（T+1 对齐：昨日分区 × 今日策略收益） ═══');
console.log('分区          信号日  次日均仓  持仓日  胜率    策略日均   池日均    日均超额   累计贡献    最差日    大亏日(<-1%)');
for (let k = 0; k < ZONES.length; k++) {
  const a = attrV52[k];
  const excess = a.sigDays ? (a.stratSum - a.poolSum) / a.sigDays : 0;
  console.log(
    `${ZONES[k].key.padEnd(12)} ${String(a.sigDays).padStart(4)}   ${fmt(a.sigDays ? a.posSum / a.sigDays : 0, 2).padStart(6)}   ${String(a.heldDays).padStart(4)}   ${pct(a.heldDays ? a.winDays / a.heldDays : 0).padStart(7)}  ${fmt(a.sigDays ? a.stratSum / a.sigDays * 100 : 0, 4).padStart(8)}%  ${fmt(a.sigDays ? a.poolSum / a.sigDays * 100 : 0, 4).padStart(7)}%  ${fmt(excess * 100, 4).padStart(8)}%  ${fmt(a.cumLog * 100, 2).padStart(8)}%  ${fmt(a.worst * 100, 2).padStart(7)}%  ${String(a.bigLoss).padStart(4)}`,
  );
}

console.log('\n═══ 情绪分区归因 · V5.3-A（右侧确认+帽子后的同表对照） ═══');
console.log('分区          信号日  次日均仓  持仓日  胜率    策略日均   池日均    日均超额   累计贡献');
for (let k = 0; k < ZONES.length; k++) {
  const a = attrV53A[k];
  const excess = a.sigDays ? (a.stratSum - a.poolSum) / a.sigDays : 0;
  console.log(
    `${ZONES[k].key.padEnd(12)} ${String(a.sigDays).padStart(4)}   ${fmt(a.sigDays ? a.posSum / a.sigDays : 0, 2).padStart(6)}   ${String(a.heldDays).padStart(4)}   ${pct(a.heldDays ? a.winDays / a.heldDays : 0).padStart(7)}  ${fmt(a.sigDays ? a.stratSum / a.sigDays * 100 : 0, 4).padStart(8)}%  ${fmt(a.sigDays ? a.poolSum / a.sigDays * 100 : 0, 4).padStart(7)}%  ${fmt(excess * 100, 4).padStart(8)}%  ${fmt(a.cumLog * 100, 2).padStart(8)}%`,
  );
}

console.log('\n═══ 情绪分区归因 · V5.2 仅真实收益日（剔除 0 填充天后的真实行为） ═══');
console.log('分区          信号日  次日均仓  持仓日  胜率    策略日均   池日均    累计贡献    最差日');
for (let k = 0; k < ZONES.length; k++) {
  const a = attrReal[k];
  console.log(
    `${ZONES[k].key.padEnd(12)} ${String(a.sigDays).padStart(4)}   ${fmt(a.sigDays ? a.posSum / a.sigDays : 0, 2).padStart(6)}   ${String(a.heldDays).padStart(4)}   ${pct(a.heldDays ? a.winDays / a.heldDays : 0).padStart(7)}  ${fmt(a.sigDays ? a.stratSum / a.sigDays * 100 : 0, 4).padStart(8)}%  ${fmt(a.sigDays ? a.poolSum / a.sigDays * 100 : 0, 4).padStart(7)}%  ${fmt(a.cumLog * 100, 2).padStart(8)}%  ${fmt(a.worst * 100, 2).padStart(7)}%`,
  );
}

console.log('\n═══ 十分位细分（V5.2：昨日信号分桶 × 今日策略收益，找具体"飞刀"分数段） ═══');
console.log('分数段     信号日  持仓日  胜率    策略累计   池累计     超额累计');
for (let b = 0; b < 10; b++) {
  const a = binAcc[b];
  if (!a.sig) { console.log(String(`${BINS[b].lo}~${BINS[b].hi}`).padEnd(10) + '    0      -      -         -          -          -'); continue; }
  console.log(
    `${String(BINS[b].lo)}~${BINS[b].hi}`.padEnd(10) + ` ${String(a.sig).padStart(4)}   ${String(a.held).padStart(4)}   ${pct(a.held ? a.win / a.held : 0).padStart(7)}  ${fmt(a.cumLog * 100, 2).padStart(8)}%  ${fmt(a.poolCum * 100, 2).padStart(8)}%  ${fmt((a.cumLog - a.poolCum) * 100, 2).padStart(8)}%`,
  );
}

console.log('\n═══ 参数变体对照（全部经引擎真实函数重放；换手=Σ|Δ仓位|，成本含佣金/印花/滑点） ═══');
console.log('变体                    总收益    夏普     最大回撤  胜率     空仓率   开仓  换手    总成本(bp)  超额vs池');
for (const v of VARIANTS) {
  const r = runs[v.key];
  let turnover = 0;
  for (let i = 1; i < n; i++) turnover += Math.abs(r.pos[i] - r.pos[i - 1]);
  turnover += r.pos[0];
  const costBp = r.cost.reduce((a, c) => a + c, 0) * 1e4;
  console.log(
    `${v.label.padEnd(26)} ${pct(r.perf.total).padStart(8)}  ${fmt(r.perf.sharpe, 3).padStart(7)}  ${pct(r.perf.maxDd).padStart(8)}  ${pct(r.perf.winRate).padStart(7)}  ${pct(r.perf.emptyRatio).padStart(7)}  ${String(r.perf.opens).padStart(4)}  ${fmt(turnover, 1).padStart(6)}  ${fmt(costBp, 1).padStart(9)}   ${pct(r.perf.total - holdTotal).padStart(8)}`,
  );
}

// ── Markdown 报告 ──
const md = [];
md.push('# V5.2/V5.3 诊断报告：情绪分区归因 + 平滑/确认变体重放');
md.push('');
md.push(`生成：node tools/backtest/diagnose_v52.mjs · 样本 ${dates[0]} ~ ${dates[n - 1]}（${n} 个交易日，剔除回填天）`);
md.push(`重放校验：V5.2 与 V5.3-A 均与 data/backtest.json 逐位吻合（±1e-4）——变体数字与正式回测同引擎同口径。`);
md.push('');
md.push('## 0. ⚠ 数据覆盖（最重要发现，先读这节）');
md.push('');
md.push(`- 指数日收益覆盖率 **${nReal}/${n} 天**（${firstReal} ~ ${lastReal}）；其余 ${nFake} 天 \`indexes\` 缺失，回测引擎（scripts/backtest.mjs 的回退分支）按 **0 收益** 处理。`);
md.push(`- 覆盖日内上涨/下跌 = ${upReal}/${downReal}（上涨占比 ${pct(upReal / nReal)}）——真实市场分布并非"6% 上涨日"。`);
md.push(`- 全样本 V5.2 持仓日胜率 6.25% ≈ ${upReal} 个上涨日 ÷ ~240 个持仓日：**缺失天灌大分母的算术产物**，既不是市场行为也不是策略属性。`);
md.push('');
md.push('V5.2 按日类型分解（零填充日的策略收益 = 纯成本，无行情可赚）：');
md.push('');
md.push('| 日类型 | 天数 | 持仓日 | 胜率 | 累计贡献 | 成本(bp) |');
md.push('|---|---|---|---|---|---|');
md.push(`| 真实收益日 | ${split.real.days} | ${split.real.held} | ${pct(split.real.held ? split.real.win / split.real.held : 0)} | ${fmt(split.real.cumLog * 100, 2)}% | ${fmt(split.real.cost * 1e4, 1)} |`);
md.push(`| 零填充日 | ${split.fake.days} | ${split.fake.held} | -（收益恒 0） | ${fmt(split.fake.cumLog * 100, 2)}% | ${fmt(split.fake.cost * 1e4, 1)} |`);
md.push('');
md.push('## 1. 样本画像（原始未取整收益）');
md.push('');
md.push(`- 池日收益：上涨 ${upDays} 天（${pct(upDays / n)}）/ 平 ${flatDays}（=缺失填充）/ 下跌 ${downDays}（${pct(downDays / n)}）`);
md.push(`- 池日收益分位：p25=${pct(q(0.25))} · p50=${pct(q(0.5))} · p75=${pct(q(0.75))} · 最差=${pct(q(0))} · 最好=${pct(q(1))}`);
md.push(`- 池买入持有总收益：${pct(holdTotal)}（同期沪深300：${benchTotal == null ? '-' : pct(benchTotal)}）`);
md.push(`- 情绪分范围 [${Math.min(...scores)} , ${Math.max(...scores)}]；≤24 清仓区信号日仅 ${scores.filter((v) => v <= 24).length} 天`);
md.push('');
md.push('## 2. 情绪分区归因（V5.2，T+1 对齐）');
md.push('');
md.push('| 分区 | 信号日 | 次日均仓 | 持仓日 | 胜率 | 策略日均 | 池日均 | 日均超额 | 累计贡献 | 最差日 | 大亏日(<-1%) |');
md.push('|---|---|---|---|---|---|---|---|---|---|---|');
for (let k = 0; k < ZONES.length; k++) {
  const a = attrV52[k];
  const excess = a.sigDays ? (a.stratSum - a.poolSum) / a.sigDays : 0;
  md.push(`| ${ZONES[k].key} | ${a.sigDays} | ${fmt(a.sigDays ? a.posSum / a.sigDays : 0, 2)} | ${a.heldDays} | ${pct(a.heldDays ? a.winDays / a.heldDays : 0)} | ${fmt(a.sigDays ? a.stratSum / a.sigDays * 100 : 0, 4)}% | ${fmt(a.sigDays ? a.poolSum / a.sigDays * 100 : 0, 4)}% | ${fmt(excess * 100, 4)}% | ${fmt(a.cumLog * 100, 2)}% | ${fmt(a.worst * 100, 2)}% | ${a.bigLoss} |`);
}
md.push('');
md.push('## 3. 情绪分区归因（V5.3-A 对照）');
md.push('');
md.push('| 分区 | 信号日 | 次日均仓 | 持仓日 | 胜率 | 策略日均 | 池日均 | 日均超额 | 累计贡献 |');
md.push('|---|---|---|---|---|---|---|---|---|');
for (let k = 0; k < ZONES.length; k++) {
  const a = attrV53A[k];
  const excess = a.sigDays ? (a.stratSum - a.poolSum) / a.sigDays : 0;
  md.push(`| ${ZONES[k].key} | ${a.sigDays} | ${fmt(a.sigDays ? a.posSum / a.sigDays : 0, 2)} | ${a.heldDays} | ${pct(a.heldDays ? a.winDays / a.heldDays : 0)} | ${fmt(a.sigDays ? a.stratSum / a.sigDays * 100 : 0, 4)}% | ${fmt(a.sigDays ? a.poolSum / a.sigDays * 100 : 0, 4)}% | ${fmt(excess * 100, 4)}% | ${fmt(a.cumLog * 100, 2)}% |`);
}
md.push('');
md.push('## 3b. 情绪分区归因 · V5.2 仅真实收益日（剔除 0 填充天后的真实行为）');
md.push('');
md.push('| 分区 | 信号日 | 次日均仓 | 持仓日 | 胜率 | 策略日均 | 池日均 | 累计贡献 | 最差日 |');
md.push('|---|---|---|---|---|---|---|---|---|');
for (let k = 0; k < ZONES.length; k++) {
  const a = attrReal[k];
  md.push(`| ${ZONES[k].key} | ${a.sigDays} | ${fmt(a.sigDays ? a.posSum / a.sigDays : 0, 2)} | ${a.heldDays} | ${pct(a.heldDays ? a.winDays / a.heldDays : 0)} | ${fmt(a.sigDays ? a.stratSum / a.sigDays * 100 : 0, 4)}% | ${fmt(a.sigDays ? a.poolSum / a.sigDays * 100 : 0, 4)}% | ${fmt(a.cumLog * 100, 2)}% | ${fmt(a.worst * 100, 2)}% |`);
}
md.push('');
md.push('## 4. 十分位细分（V5.2）');
md.push('');
md.push('| 分数段 | 信号日 | 持仓日 | 胜率 | 策略累计 | 池累计 | 超额累计 |');
md.push('|---|---|---|---|---|---|---|');
for (let b = 0; b < 10; b++) {
  const a = binAcc[b];
  if (!a.sig) { md.push(`| ${BINS[b].lo}~${BINS[b].hi} | 0 | - | - | - | - | - |`); continue; }
  md.push(`| ${BINS[b].lo}~${BINS[b].hi} | ${a.sig} | ${a.held} | ${a.held ? pct(a.win / a.held) : '-'} | ${fmt(a.cumLog * 100, 2)}% | ${fmt(a.poolCum * 100, 2)}% | ${fmt((a.cumLog - a.poolCum) * 100, 2)}% |`);
}
md.push('');
md.push('## 5. 参数变体对照');
md.push('');
md.push('| 变体 | 总收益 | 夏普 | 最大回撤 | 胜率 | 空仓率 | 开仓 | 换手 | 总成本(bp) | 超额vs池 |');
md.push('|---|---|---|---|---|---|---|---|---|---|');
for (const v of VARIANTS) {
  const r = runs[v.key];
  let turnover = 0;
  for (let i = 1; i < n; i++) turnover += Math.abs(r.pos[i] - r.pos[i - 1]);
  turnover += r.pos[0];
  md.push(`| ${v.label} | ${pct(r.perf.total)} | ${fmt(r.perf.sharpe, 3)} | ${pct(r.perf.maxDd)} | ${pct(r.perf.winRate)} | ${pct(r.perf.emptyRatio)} | ${r.perf.opens} | ${fmt(turnover, 1)} | ${fmt(r.cost.reduce((a, c) => a + c, 0) * 1e4, 1)} | ${pct(r.perf.total - holdTotal)} |`);
}
md.push('');
md.push('---');
md.push('口径注：信号=train 权重重算分（与正式回测一致，max 漂移 ' + fmt(drift) + ' 分）；分区线对齐引擎行为档位（24/65/80）；');
md.push('navHold 取整到 1e-4 的历史统计会把小涨日抹平——本报告一律用原始收益重算。');
md.push('');
md.push('## 读法警示（结论可信度）');
md.push('');
md.push('1. 全样本表（第 2/4/5 节）里 ' + Math.round(nFake / n * 100) + '% 的"信号日"落在零填充日上——分区归因、胜率、夏普主要是**数据覆盖缺口的算术产物**。');
md.push('2. 第 3b 节（仅真实收益日）才是真实行为，但只有 ~' + (nReal - 1) + ' 个有效 T+1 对，统计力极弱：只能看方向，不能据此定参数。');
md.push('3. **指数收益回填补齐之前，confirmDays / maxPosChg 的任何调参决定都不具备样本依据**；"去平滑更差"（V5.2-ns / V5.3-B）的方向性结论同样受此限制——尽管它在成本机制上说得通（换手翻倍、成本近乎翻倍）。');

mkdirSync(join(ROOT, 'tools', 'backtest', 'reports'), { recursive: true });
writeFileSync(join(ROOT, 'tools', 'backtest', 'reports', 'diagnose_v52.md'), md.join('\n'), 'utf8');
console.log('\n[diagnose] 报告已写 tools/backtest/reports/diagnose_v52.md');
