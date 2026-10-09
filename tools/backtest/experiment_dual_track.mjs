#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 只读旁路实验：双轨披露（V5.2 主信号 + V5.3 风险参考线）介入规则验证
// ─────────────────────────────────────────────────────────────────────────────
// 背景：终极 PK 裁决 V5.3-A = "定价合理的保险，不是免费午餐"，正确姿势是双轨——
//   V5.2 主信号负责进攻（满仓区 Alpha），V5.3 作为风险参考线，尾部行情临时介入。
//
// 本实验回答一个问题：**介入档位怎么选，保费/保额最优？**
//   PK 已证明 V5.3 的伤害 100% 集中在 40~50 段（recover/neutral 帽 0.5 压掉反弹）
//   且 climax 帽 = 1.0 本来就是 no-op——所以"全量切换"里真正起作用的只有防守档。
//   变体矩阵（按介入档位子集）：
//     E0   = V5.2 原版（不介入，纯主信号）
//     FULL = 全量切换（= V5.3-A，已知 -3.71% / 8.78%）
//     T3   = 尾部三档介入（ice+ebb+shift，帽 ≤0.3）——recover/neutral 不介入
//     T2   = 深尾两档（ice+ebb，帽 0.2）
//     T1   = 仅切换期（shift，帽 0.3）
//
// 锚点门禁（双）：①克隆保真 ②E0↔v52、FULL↔v53 与 data/backtest.json 对账。
// 纪律：config.params.train 只读；未改生产代码；输出仅
//   tools/backtest/reports/experiment_dual_track.md。
//
// 用法：node tools/backtest/experiment_dual_track.mjs
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

// ── 输入重建（与 experiment_v53_showdown.mjs 逐行同款） ──
const arch = decodeArchive(JSON.parse(readFileSync(join(ROOT, 'data', 'archive.json'), 'utf8')));
const days = (arch.all_days || []).filter((d) => d && d.trade_date && !(d.emotion && d.emotion._backfill));
if (days.length < 5) { console.error('[dual] 样本不足'); process.exit(1); }
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
const regimeSeries = classifySeries(regimeDays);
const regimeKeys = regimeSeries.map((s) => s.key);
const capOf = (k) => { const b = bandFor(k); return b ? b.maxPos : null; };
const regimeCaps = regimeKeys.map((k) => capOf(k));           // 全量（climax=1.0/unknown=null 均 no-op）
const capsOnly = (subset) => regimeKeys.map((k) => (subset.has(k) ? capOf(k) : null));

const SUBSETS = [
  { key: 'FULL', label: '全量切换（=V5.3-A）', set: new Set(['ice', 'ebb', 'recover', 'neutral', 'shift', 'climax']) },
  { key: 'T3', label: '尾部三档（ice+ebb+shift，帽≤0.3）', set: new Set(['ice', 'ebb', 'shift']) },
  { key: 'T2', label: '深尾两档（ice+ebb，帽0.2）', set: new Set(['ice', 'ebb']) },
  { key: 'T1', label: '仅切换期（shift，帽0.3）', set: new Set(['shift']) },
];
const pFULL = { ...pV52, maxPosByDay: regimeCaps };

// ── 锚点门禁 ──
for (const [name, pp] of [['v52', pV52], ['v53', pFULL]]) {
  for (const a of ASSETS) {
    const e = positions(scores, retsByAsset[a], pp);
    const c = positionsBoost(scores, retsByAsset[a], pp);
    if (e.length !== c.length || e.some((x, i) => x !== c[i])) {
      console.error(`[dual] 门禁①失败：克隆与引擎不一致（${name} × ${a}），终止`);
      process.exit(1);
    }
  }
}
console.log('[dual] 门禁①通过：克隆与引擎 positions() 逐位相等');

const poolRet = Array.from({ length: n }, (_, i) => ASSETS.reduce((s, k) => s + retsByAsset[k][i], 0) / ASSETS.length);

function poolRun(sc, rts, p) {
  const assets = Object.keys(rts);
  const m = sc.length;
  const strat = new Array(m).fill(0);
  const pos = new Array(m).fill(0);
  const cost = new Array(m).fill(0);
  let opens = 0;
  for (const a of assets) {
    const pa = positionsBoost(sc, rts[a], p);
    const ca = turnoverCost(pa, p);
    for (let i = 0; i < m; i++) {
      strat[i] += (rts[a][i] * pa[i] - ca[i]) / assets.length;
      pos[i] += pa[i] / assets.length;
      cost[i] += ca[i] / assets.length;
      if (pa[i] > 0 && (i === 0 || pa[i - 1] === 0)) opens++;
    }
  }
  return { strat, pos, cost, perf: metrics(strat, pos, opens, 0) };
}
const runOf = (p) => poolRun(scores, retsByAsset, p);
const E0 = runOf(pV52);
const FULL = runOf(pFULL);
const runs = { E0, FULL };
for (const s of SUBSETS.slice(1)) runs[s.key] = runOf({ ...pV52, maxPosByDay: capsOnly(s.set) });

const refJson = JSON.parse(readFileSync(join(ROOT, 'data', 'backtest.json'), 'utf8'));
const TOL = { total: 6e-5, maxDd: 6e-5, winRate: 6e-5, emptyRatio: 6e-5, sharpe: 6e-4 };
for (const [run, ref, label] of [['E0', 'v52', 'V5.2'], ['FULL', 'v53', 'V5.3-A']]) {
  const a = runs[run].perf, b = refJson[ref];
  const bad = Object.keys(TOL).filter((k) => Math.abs(a[k] - b[k]) > TOL[k]);
  if (bad.length) {
    console.error(`[dual] 门禁②失败：${label} 字段 ${bad.join(',')}，终止`);
    process.exit(1);
  }
}
console.log('[dual] 门禁②通过：E0↔v52、FULL↔v53 对账吻合（-1.50%/13.79% 与 -3.71%/8.78%），介入矩阵数字可信\n');

const pct = (x) => (x * 100).toFixed(2) + '%';
const fmt = (x, d = 3) => x.toFixed(d);

// ── 水下/回撤解剖（与 showdown 同款） ──
function underwater(strat) {
  const nav = [];
  let acc = 1;
  for (const s of strat) { acc *= 1 + s; nav.push(acc); }
  let peak = -Infinity, peakIdx = 0, maxDd = 0, ddPeakIdx = 0, ddTroughIdx = 0;
  let under = 0, maxUnder = 0, underStart = 0, wStart = 0, wEnd = 0;
  for (let i = 0; i < nav.length; i++) {
    if (nav[i] >= peak) {
      if (under > 0 && under > maxUnder) { maxUnder = under; wStart = underStart; wEnd = i - 1; }
      peak = nav[i]; peakIdx = i; under = 0;
    } else {
      if (under === 0) underStart = i;
      under++;
      const dd = 1 - nav[i] / nav[peakIdx];
      if (dd > maxDd) { maxDd = dd; ddPeakIdx = peakIdx; ddTroughIdx = i; }
    }
  }
  if (under > maxUnder) { maxUnder = under; wStart = underStart; wEnd = nav.length - 1; }
  return { maxUnder, wStart, wEnd, ddPeakIdx, ddTroughIdx, maxDd };
}
const uws = {};
for (const k of Object.keys(runs)) uws[k] = underwater(runs[k].strat);

// ── 滚动样本外（20/6 窗·固定权重，与 showdown 同构） ──
function rollingFixed(p) {
  const trainWindow = 20, testWindow = 6;
  const segs = [];
  for (let start = 0; start + trainWindow + testWindow <= n; start += testWindow) {
    const trEnd = start + trainWindow, teEnd = trEnd + testWindow;
    const fTe = factorsByDay.slice(trEnd, teEnd);
    const rTe = {};
    for (const a of ASSETS) rTe[a] = retsByAsset[a].slice(trEnd, teEnd);
    const pSeg = { ...p };
    if (p.maxPosByDay) pSeg.maxPosByDay = p.maxPosByDay.slice(trEnd, teEnd);
    const { perf } = poolRun(scoreWith(fTe, plainW), rTe, pSeg);
    segs.push(perf);
  }
  const wf = segs.filter((s) => Number.isFinite(s.sharpe));
  return {
    n: segs.length,
    sharpeMean: wf.length ? wf.reduce((a, s) => a + s.sharpe, 0) / wf.length : 0,
    winSegPct: segs.length ? segs.filter((s) => s.total > 0).length / segs.length : 0,
    ddWorst: segs.length ? Math.max(...segs.map((s) => s.maxDd)) : 0,
  };
}
const rollE0 = rollingFixed(pV52);
const rollT3 = rollingFixed({ ...pV52, maxPosByDay: capsOnly(SUBSETS[1].set) });
const rollT1 = rollingFixed({ ...pV52, maxPosByDay: regimeKeys.map((k) => (k === 'shift' ? 0.3 : null)) });
const rollT1b = rollingFixed({ ...pV52, maxPosByDay: regimeKeys.map((k) => (k === 'shift' ? 0.4 : null)) });

// ── 分区归因（验证 T3 是否消除 40~50 伤害） ──
const ZONES = [
  { key: '24~40', test: (v) => v > 24 && v < 40 },
  { key: '40~50', test: (v) => v >= 40 && v < 50 },
  { key: '50~65', test: (v) => v >= 50 && v < 65 },
  { key: '65~80', test: (v) => v >= 65 && v <= 80 },
  { key: '>80', test: (v) => v > 80 },
];
function zoneAttribution(run) {
  const acc = ZONES.map(() => ({ sigDays: 0, cumLog: 0, poolSum: 0 }));
  for (let i = 1; i < n; i++) {
    const k = ZONES.findIndex((z) => z.test(scores[i - 1]));
    if (k < 0) continue;
    acc[k].sigDays++;
    acc[k].cumLog += Math.log(1 + run.strat[i]);
    acc[k].poolSum += poolRet[i];
  }
  return acc;
}
const zAll = {};
for (const k of Object.keys(runs)) zAll[k] = zoneAttribution(runs[k]);

// ── regime 档位普查：每档天数、帽子值、池收益、E0 策略贡献 ──
const KEYS = ['ice', 'ebb', 'recover', 'neutral', 'climax', 'shift', 'unknown'];
const census = KEYS.map((k) => {
  const idx = regimeKeys.map((x, i) => (x === k ? i : -1)).filter((i) => i >= 0);
  let poolSum = 0, e0Log = 0, e0PosSum = 0;
  for (const i of idx) { poolSum += poolRet[i]; e0Log += Math.log(1 + E0.strat[i]); e0PosSum += E0.pos[i]; }
  return { key: k, days: idx.length, cap: capOf(k) ?? (k === 'unknown' ? null : null), poolSum, e0Log, e0PosAvg: idx.length ? e0PosSum / idx.length : 0 };
});

// ── 介入咬合统计（保险何时真正生效） ──
function biteStats(subset) {
  const caps = capsOnly(subset);
  let capDays = 0, biteDays = 0, cutSum = 0, worst = { i: -1, cut: 0 };
  for (let i = 0; i < n; i++) {
    if (caps[i] == null) continue;
    capDays++;
    const cut = E0.pos[i] - caps[i];
    if (cut > 0.01) { biteDays++; cutSum += cut; if (cut > worst.cut) worst = { i, cut }; }
  }
  return { capDays, biteDays, cutAvg: biteDays ? cutSum / biteDays : 0, worst };
}
const bites = {};
bites.FULL = biteStats(SUBSETS[0].set);
bites.T3 = biteStats(SUBSETS[1].set);
bites.T2 = biteStats(SUBSETS[2].set);
bites.T1 = biteStats(SUBSETS[3].set);

// ══════════ 控制台输出 ══════════
const VAR_LIST = [
  { key: 'E0', label: 'V5.2 原版（不介入）' },
  { key: 'T3', label: 'T3 尾部三档（ice+ebb+shift）' },
  { key: 'T2', label: 'T2 深尾两档（ice+ebb）' },
  { key: 'T1', label: 'T1 仅切换期（shift）' },
  { key: 'FULL', label: '全量切换（=V5.3-A）' },
];
console.log('═══ ① 介入矩阵总表（保费 = E0收益−变体收益；保额 = E0回撤−变体回撤） ═══');
console.log('变体                          总收益    保费      最大回撤  保额     夏普     水下天数');
for (const v of VAR_LIST) {
  const r = runs[v.key];
  console.log(`${v.label.padEnd(30)} ${pct(r.perf.total).padStart(8)}  ${pct(E0.perf.total - r.perf.total).padStart(7)}  ${pct(r.perf.maxDd).padStart(8)}  ${pct(E0.perf.maxDd - r.perf.maxDd).padStart(7)}  ${fmt(r.perf.sharpe).padStart(7)}  ${String(uws[v.key].maxUnder).padStart(5)}`);
}
console.log('\n═══ ② 40~50 段伤害检验（T3 应消除 PK 中 -3.55pp 的伤害） ═══');
for (const v of VAR_LIST) {
  const a = zAll[v.key][1];
  console.log(`${v.label.padEnd(30)} 40~50 累计 ${fmt(a.cumLog * 100, 2).padStart(7)}%  Δvs E0 ${fmt((a.cumLog - zAll.E0[1].cumLog) * 100, 2).padStart(6)}pp`);
}
console.log('\n═══ ③ regime 档位普查（全样本 241 天） ═══');
console.log('档位      天数   帽子    池累计     E0策略累计  E0平均仓位');
for (const c of census) {
  console.log(`${c.key.padEnd(9)} ${String(c.days).padStart(4)}  ${c.cap == null ? '  —  ' : fmt(c.cap, 2).padStart(5)}  ${fmt(c.poolSum * 100, 2).padStart(7)}%  ${fmt(c.e0Log * 100, 2).padStart(7)}%  ${fmt(c.e0PosAvg, 2).padStart(6)}`);
}
console.log('\n═══ ④ 保险咬合统计（帽子生效且确实压到 E0 仓位的日子） ═══');
console.log('变体        帽子天数  咬合天数  平均削减   最狠一日');
for (const [k, b] of Object.entries(bites)) {
  const label = { FULL: '全量', T3: '尾部三档', T2: '深尾两档', T1: '仅切换期' }[k];
  console.log(`${label.padEnd(10)} ${String(b.capDays).padStart(6)}  ${String(b.biteDays).padStart(6)}  ${fmt(b.cutAvg, 3).padStart(7)}  ${b.worst.i >= 0 ? `${dates[b.worst.i]} 削 ${fmt(b.worst.cut, 2)}` : '—'}`);
}
console.log('\n═══ ⑤ 滚动样本外（20/6 窗·固定权重，与终极 PK 同构口径） ═══');
console.log(`V5.2 原版：样本外夏普 ${fmt(rollE0.sharpeMean)} / 段胜率 ${pct(rollE0.winSegPct)} / 最差段回撤 ${pct(rollE0.ddWorst)}`);
console.log(`T3 尾部三档：样本外夏普 ${fmt(rollT3.sharpeMean)} / 段胜率 ${pct(rollT3.winSegPct)} / 最差段回撤 ${pct(rollT3.ddWorst)}`);
console.log(`T1 仅切换期（帽0.3）：样本外夏普 ${fmt(rollT1.sharpeMean)} / 段胜率 ${pct(rollT1.winSegPct)} / 最差段回撤 ${pct(rollT1.ddWorst)}`);
console.log(`T1 仅切换期（帽0.4）：样本外夏普 ${fmt(rollT1b.sharpeMean)} / 段胜率 ${pct(rollT1b.winSegPct)} / 最差段回撤 ${pct(rollT1b.ddWorst)}`);

// ══════════ ⑥ 回撤窗解剖：E0 最大回撤窗内的档位构成 + 各变体窗口表现 ══════════
const ddW = uws.E0;
const winLo = ddW.ddPeakIdx, winHi = ddW.ddTroughIdx;
const winCounts = {};
for (let i = winLo; i <= winHi; i++) winCounts[regimeKeys[i]] = (winCounts[regimeKeys[i]] || 0) + 1;
const winStrat = {};
for (const k of Object.keys(runs)) {
  let s = 0;
  for (let i = winLo; i <= winHi; i++) s += Math.log(1 + runs[k].strat[i]);
  winStrat[k] = s;
}
console.log(`\n═══ ⑥ E0 最大回撤窗解剖（${dates[winLo]} → ${dates[winHi]}，共 ${winHi - winLo + 1} 日） ═══`);
console.log(`窗内档位构成：${KEYS.filter((k) => winCounts[k]).map((k) => `${k}×${winCounts[k]}`).join('  ')}`);
console.log('窗内策略累计（对数）：' + VAR_LIST.map((v) => `${v.key} ${fmt(winStrat[v.key] * 100, 2)}%`).join('  '));

// ══════════ ⑦ T1 敏感性：shift 帽值扰动（路径噪声检验） ══════════
const T1_SENS = [0.2, 0.25, 0.35, 0.4, 0.5, 0.6];
const t1Rows = [];
for (const cv of T1_SENS) {
  const r = runOf({ ...pV52, maxPosByDay: regimeKeys.map((k) => (k === 'shift' ? cv : null)) });
  t1Rows.push({ cv, total: r.perf.total, maxDd: r.perf.maxDd, sharpe: r.perf.sharpe });
}
console.log('\n═══ ⑦ T1（仅切换期介入）帽值扰动：+0.82pp 是否路径噪声 ═══');
console.log('shift帽   总收益    Δvs E0   夏普     最大回撤');
for (const t of t1Rows) {
  console.log(`${fmt(t.cv, 2).padStart(5)}   ${pct(t.total).padStart(8)}  ${fmt((t.total - E0.perf.total) * 100, 2).padStart(6)}pp  ${fmt(t.sharpe).padStart(7)}  ${pct(t.maxDd).padStart(8)}`);
}
console.log(`对照：shift帽0.30（主案） 总收益 ${pct(runs.T1.perf.total)}  Δ ${fmt((runs.T1.perf.total - E0.perf.total) * 100, 2)}pp  夏普 ${fmt(runs.T1.perf.sharpe)}`);

// ══════════ ⑧ T1 增益归因：帽生效日（结构）vs 非生效日（路径级联） ══════════
// 帽生效日 = 前一日 regime=shift（T+1）且 T1 仓位确实低于 E0。
// 若增益主要落在生效日 → 结构性；主要落在非生效日 → eq 路径分叉翻转了
// ddTrigger/stopLoss 分支（M2 式路径级联），按动量尸检纪律判为噪声。
const t1Attr = { onSum: 0, offSum: 0, onDays: 0, offDays: 0 };
for (let i = 1; i < n; i++) {
  const dl = Math.log(1 + runs.T1.strat[i]) - Math.log(1 + E0.strat[i]);
  const active = regimeKeys[i - 1] === 'shift' && runs.T1.pos[i] < E0.pos[i] - 1e-9;
  if (active) { t1Attr.onSum += dl; t1Attr.onDays++; }
  else { t1Attr.offSum += dl; t1Attr.offDays++; }
}
{
  const offTop = [];
  for (let i = 1; i < n; i++) {
    const active = regimeKeys[i - 1] === 'shift' && runs.T1.pos[i] < E0.pos[i] - 1e-9;
    if (!active) offTop.push({ i, dl: Math.log(1 + runs.T1.strat[i]) - Math.log(1 + E0.strat[i]) });
  }
  offTop.sort((a, b) => a.dl - b.dl);
  console.log('\n═══ ⑧ T1 增益归因分解（+0.82pp 从哪来） ═══');
  console.log(`帽生效日：${t1Attr.onDays} 日，合计 ${fmt(t1Attr.onSum * 100, 2)}pp（结构性成分）`);
  console.log(`非生效日：${t1Attr.offDays} 日，合计 ${fmt(t1Attr.offSum * 100, 2)}pp（路径级联成分）`);
  console.log(`非生效日贡献最大的 3 日（级联落点）：${offTop.slice(-3).reverse().map((x) => `${dates[x.i]} ${fmt(x.dl * 100, 2)}pp`).join('  ')}`);
}

// ══════════ Markdown 报告 ══════════
const md = [];
md.push('# 双轨披露介入规则实验：V5.2 主信号 + V5.3 风险参考线');
md.push('');
md.push(`生成：node tools/backtest/experiment_dual_track.mjs · 样本 ${dates[0]} ~ ${dates[n - 1]}（${n} 交易日）`);
md.push('');
md.push('锚点门禁（双）均绿：E0 复现 v52（-1.50%/13.79%）、FULL 复现 v53（-3.71%/8.78%）。');
md.push('');
md.push('## 设计：介入档位矩阵');
md.push('');
md.push('PK 结论：V5.3 的伤害 100% 集中在 40~50 段（recover/neutral 帽 0.5 压掉反弹），climax 帽 = 1.0 本来就是 no-op。因此双轨的介入规则只该覆盖防守档——下表按介入子集展开：');
md.push('');
md.push('| 变体 | 介入档位 | 帽值 |');
md.push('|---|---|---|');
md.push('| E0 | 不介入（纯 V5.2 主信号） | — |');
md.push('| T3 | ice + ebb + shift | 0.2 / 0.2 / 0.3 |');
md.push('| T2 | ice + ebb | 0.2 / 0.2 |');
md.push('| T1 | shift | 0.3 |');
md.push('| FULL | 全部档位（= V5.3-A 全量切换） | 含 recover/neutral 0.5 |');
md.push('');

md.push('## ① 介入矩阵总表（保费/保额定价）');
md.push('');
md.push('| 变体 | 总收益 | 保费 | 最大回撤 | 保额 | 夏普 | 最长水下 |');
md.push('|---|---|---|---|---|---|---|');
for (const v of VAR_LIST) {
  const r = runs[v.key];
  md.push(`| ${v.label} | ${pct(r.perf.total)} | ${pct(E0.perf.total - r.perf.total)} | ${pct(r.perf.maxDd)} | ${pct(E0.perf.maxDd - r.perf.maxDd)} | ${fmt(r.perf.sharpe)} | ${uws[v.key].maxUnder} 日 |`);
}
md.push('');

md.push('## ② 40~50 段伤害检验（双轨的核心承诺）');
md.push('');
md.push('| 变体 | 40~50 段累计 | Δ vs E0 |');
md.push('|---|---|---|');
for (const v of VAR_LIST) {
  const a = zAll[v.key][1];
  md.push(`| ${v.label} | ${fmt(a.cumLog * 100, 2)}% | ${fmt((a.cumLog - zAll.E0[1].cumLog) * 100, 2)}pp |`);
}
md.push('');

md.push('## ③ regime 档位普查（介入规则的实证基础）');
md.push('');
md.push('| 档位 | 天数 | 帽子 | 池累计 | E0 策略累计 | E0 平均仓位 |');
md.push('|---|---|---|---|---|---|');
for (const c of census) {
  md.push(`| ${c.key} | ${c.days} | ${c.cap == null ? '—' : fmt(c.cap, 2)} | ${fmt(c.poolSum * 100, 2)}% | ${fmt(c.e0Log * 100, 2)}% | ${fmt(c.e0PosAvg, 2)} |`);
}
md.push('');

md.push('## ④ 保险咬合统计');
md.push('');
md.push('| 变体 | 帽子天数 | 咬合天数 | 平均削减 | 最狠一日 |');
md.push('|---|---|---|---|---|');
for (const [k, b] of Object.entries(bites)) {
  const label = { FULL: '全量', T3: '尾部三档', T2: '深尾两档', T1: '仅切换期' }[k];
  md.push(`| ${label} | ${b.capDays} | ${b.biteDays} | ${fmt(b.cutAvg, 3)} | ${b.worst.i >= 0 ? `${dates[b.worst.i]} 削 ${fmt(b.worst.cut, 2)}` : '—'} |`);
}
md.push('');

md.push('## ⑤ 滚动样本外（20/6 窗·固定权重·与终极 PK 同构口径）');
md.push('');
md.push('| 变体 | 样本外夏普 | 段胜率 | 最差段回撤 |');
md.push('|---|---|---|---|');
md.push(`| V5.2 原版 | ${fmt(rollE0.sharpeMean)} | ${pct(rollE0.winSegPct)} | ${pct(rollE0.ddWorst)} |`);
md.push(`| T3 尾部三档 | ${fmt(rollT3.sharpeMean)} | ${pct(rollT3.winSegPct)} | ${pct(rollT3.ddWorst)} |`);
md.push(`| T1 仅切换期（帽0.3） | ${fmt(rollT1.sharpeMean)} | ${pct(rollT1.winSegPct)} | ${pct(rollT1.ddWorst)} |`);
md.push(`| T1 仅切换期（帽0.4） | ${fmt(rollT1b.sharpeMean)} | ${pct(rollT1b.winSegPct)} | ${pct(rollT1b.ddWorst)} |`);
md.push('');

md.push('## ⑥ E0 最大回撤窗解剖（保额到底来自哪一档帽子）');
md.push('');
md.push(`E0 最大回撤窗：${dates[winLo]} → ${dates[winHi]}（${winHi - winLo + 1} 日），窗内档位构成：${KEYS.filter((k) => winCounts[k]).map((k) => `${k}×${winCounts[k]}`).join('、')}。`);
md.push('');
md.push('| 变体 | 窗内策略累计（对数） |');
md.push('|---|---|');
for (const v of VAR_LIST) md.push(`| ${v.label} | ${fmt(winStrat[v.key] * 100, 2)}% |`);
md.push('');

md.push('## ⑦ T1（仅切换期介入）帽值扰动与形状扫描');
md.push('');
md.push('| shift 帽值 | 总收益 | Δ vs E0 | 夏普 | 最大回撤 |');
md.push('|---|---|---|---|---|');
for (const t of t1Rows) md.push(`| ${fmt(t.cv, 2)} | ${pct(t.total)} | ${fmt((t.total - E0.perf.total) * 100, 2)}pp | ${fmt(t.sharpe)} | ${pct(t.maxDd)} |`);
md.push('');

md.push('## ⑧ T1 增益归因分解（+0.82pp 从哪来）');
md.push('');
md.push(`- **帽生效日（结构性成分）**：${t1Attr.onDays} 日，合计 **${fmt(t1Attr.onSum * 100, 2)}pp**——切换期（判据矛盾覆盖）次日的真实避险`);
md.push(`- **非生效日（路径级联成分）**：${t1Attr.offDays} 日，合计 ${fmt(t1Attr.offSum * 100, 2)}pp——重建滞后、交易成本与 eq 路径分叉的净拖累`);
md.push('- 结论：净增益 = 结构性正贡献 − 级联拖累，**主成分是结构性的**（与 M2 尸检的纯路径噪声不同性质）；但级联拖累占净增益的近七成，量级对帽值敏感（0.75~2.70pp），不足以直接转正执行。');
md.push('');

md.push('---');
md.push('## 总裁决');
md.push('');
md.push(`1. **尾部介入证伪（用户直觉方案的实测检验）**：T2（ice+ebb）保费 ${pct(E0.perf.total - runs.T2.perf.total)} 只买到保额 ${pct(E0.perf.maxDd - runs.T2.perf.maxDd)}；T3（+shift）保费 ${pct(E0.perf.total - runs.T3.perf.total)} 保额 ${pct(E0.perf.maxDd - runs.T3.perf.maxDd)}——**保费 > 保额，尾部档是不可拆分的亏本保险**。`);
md.push(`2. **V5.3 的 5pp 保额不来自尾部档，来自 recover/neutral 0.5 帽**：回撤窗内 FULL ${fmt(winStrat.FULL * 100, 2)}% vs T3 ${fmt(winStrat.T3 * 100, 2)}% vs E0 ${fmt(winStrat.E0 * 100, 2)}%——慢跌全程压仓才是保额来源；而样本内 4 段急跌全是 V 型（体检④），T+1 下尾部帽只会割在反弹上（T2 窗内 ${fmt(winStrat.T2 * 100, 2)}%，比 E0 还差）。**保额与保费（40~50 段伤害）是同一机制的捆绑包——想要回撤保护就得整份买下 V5.3，没有"只买尾部"的选项。**`);
md.push(`3. **T1（切换期次日帽）是唯一正贡献的介入候选**：结构成分 +${fmt(t1Attr.onSum * 100, 2)}pp（${t1Attr.onDays} 生效日）；帽值 0.2~0.6 全区间符号一致为正（+0.75~+2.70pp，峰值 0.5 处回撤 12.67%）；**样本外夏普 ${fmt(rollT1.sharpeMean)}/${fmt(rollT1b.sharpeMean)} > E0 的 ${fmt(rollE0.sharpeMean)}**（T3 同口径崩至 ${fmt(rollT3.sharpeMean)}）。但仅 18 个生效日、量级帽值敏感、级联拖累近七成——按 M8/M2 尸检纪律，**不直接执行，转影子模式进 P2**。`);
md.push('4. **双轨框架定稿**：披露层立即落地（V5.2 主信号执行 + V5.3-A 参考线披露不执行 + 分歧标记）；介入层唯一候选 = shift 次日帽（影子执行、逐日记账）；尾部介入方案废弃。详见 docs/dual_track_framework.md。');

mkdirSync(join(ROOT, 'tools', 'backtest', 'reports'), { recursive: true });
writeFileSync(join(ROOT, 'tools', 'backtest', 'reports', 'experiment_dual_track.md'), md.join('\n'), 'utf8');
console.log('\n[dual] 报告已写 tools/backtest/reports/experiment_dual_track.md');
