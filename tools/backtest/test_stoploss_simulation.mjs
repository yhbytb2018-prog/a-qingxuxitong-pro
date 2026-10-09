#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// P0 止损模拟触发测试：实盘安全底线的沙盘推演（只读旁路，零生产改动）
// ─────────────────────────────────────────────────────────────────────────────
// 问题：代码写了 stopLoss=-8%，但实盘滑点/流动性枯竭/连续跌停下，止损真能触发、
//       真能卖出、真亏得起吗？——用历史极端行情段做满仓沙盘。
//
// 【引擎止损语义先验明（src/backtest.js L104）】
//   stopHit = stopLoss<0 && held && rets[i] <= stopLoss
//   → 是"单日收益 ≤ -8%"的**单日崩盘熔断**，不是"浮亏 -8%"的入场价止损！
//   浮亏侧唯一风控是 ddTrigger=-0.15（组合净值回撤 15% → 压仓至 0.4）。
//   普查（本脚本输出）：全样本 241 日 × 3 指数，单日 ≤ -8% 的天数 = 0，
//   最狠单日 = 创业板 2026-07-28 -7.35% → **样本内止损线从未触发（纯 no-op）**。
//
// 测试矩阵：
//   A. 历史情景段（满仓进入，拼接前置信号日）：
//     SEG1  2026-07-02 用户点名"单日崩盘"（实测上证 -2.03/深成 -3.85/创业板 -5.71%）
//     SEG2  2026-07-28 实测最狠单日（创业板 -7.35%，距止损线仅 0.65pp）
//     SEG3  2026-07-13~17 最惨 5 日连续阴跌（创业板 -10.98%/深成 -9.05%）
//     SEG4  2026-06-22 起 70 日慢刀（E0 最大回撤窗，含 07-17 -7.15%）
//   B. 合成放大情景（历史无 -8% 单日 → 跌幅 ×1.5/×2.0 逼出止损，验执行链路）：
//     SYN15/SYN20 = SEG3 段内 rets 放大 1.5/2.0 倍（非历史，仅为执行机制推演）
//   模式（谁在保护你）：
//     real     = 真实双风控（真实情绪信号 + stopLoss + ddTrigger）——生产口径
//     stopOnly = 屏蔽信号退出（恒满仓信号 + 关 ddTrigger）→ 退出只剩 -8% 熔断
//     naked    = 无风控（恒满仓、stopLoss=0、ddTrigger=0）——量"不止损亏多少"
//   成交压力（只作用于清仓执行日，后处理不改引擎）：
//     base     = 收盘价成交（回测口径，成本 comm+stamp+slip=0.1%）
//     impact   = 清仓日额外 0.5% 冲击成本（跌停板上排队的简化）
//     freeze   = 流动性冻结：清仓执行日若 r≤-5%，卖单顺延次日（最多顺延 2 日），
//                顺延期间继续持有吃跌幅——止损失败的极端形态
//
// 门禁：输入重建后全样本复现 v52 锚点（-1.50%/13.79%），段内数字才可信。
// 输出：控制台 + tools/backtest/reports/test_stoploss_simulation.md
//
// 用法：node tools/backtest/test_stoploss_simulation.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import config from '../../src/config.js';
import { decodeArchive } from '../../src/lhb_codec.js';
import { BASE_PARAMS, scoreWith, positions, turnoverCost, metrics } from '../../src/backtest.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

// ── 输入重建（与 experiment_dual_track.mjs 逐行同款） ──
const arch = decodeArchive(JSON.parse(readFileSync(join(ROOT, 'data', 'archive.json'), 'utf8')));
const days = (arch.all_days || []).filter((d) => d && d.trade_date && !(d.emotion && d.emotion._backfill));
if (days.length < 5) { console.error('[stop] 样本不足'); process.exit(1); }
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

// ── 门禁：全样本复现 v52 锚点 ──
{
  const strat = new Array(n).fill(0);
  const pos = new Array(n).fill(0);
  let opens = 0;
  for (const a of ASSETS) {
    const pa = positions(scores, retsByAsset[a], pV52);
    const ca = turnoverCost(pa, pV52);
    for (let i = 0; i < n; i++) {
      strat[i] += (retsByAsset[a][i] * pa[i] - ca[i]) / ASSETS.length;
      pos[i] += pa[i] / ASSETS.length;
      if (pa[i] > 0 && (i === 0 || pa[i - 1] === 0)) opens++;
    }
  }
  const perf = metrics(strat, pos, opens, 0);
  const ref = JSON.parse(readFileSync(join(ROOT, 'data', 'backtest.json'), 'utf8')).v52;
  const TOL = 6e-5;
  if (Math.abs(perf.total - ref.total) > TOL || Math.abs(perf.maxDd - ref.maxDd) > TOL) {
    console.error(`[stop] 门禁失败：重建锚点漂移（${(perf.total * 100).toFixed(2)}%/${(perf.maxDd * 100).toFixed(2)}%），终止`);
    process.exit(1);
  }
  console.log(`[stop] 门禁通过：全样本复现 v52 锚点 ${(perf.total * 100).toFixed(2)}% / ${(perf.maxDd * 100).toFixed(2)}%，段内数字可信\n`);
}

// ── 普查：止损线历史触发计数 + 单日跌幅分布 ──
const pct = (x) => (x * 100).toFixed(2) + '%';
const fmt = (x, d = 3) => x.toFixed(d);
const survey = [];
for (const a of ASSETS) {
  const rs = retsByAsset[a];
  const cnt = (th) => rs.filter((r) => r <= -th).length;
  const worst = rs.map((r, i) => ({ r, i })).sort((x, y) => x.r - y.r)[0];
  survey.push({ asset: a, n8: cnt(0.08), n5: cnt(0.05), n3: cnt(0.03), worst });
}
console.log('═══ 普查：单日跌幅分布（止损线历史触发计数） ═══');
console.log('指数       ≤-8%  ≤-5%  ≤-3%   最差单日');
for (const s of survey) {
  console.log(`${s.asset.padEnd(10)} ${String(s.n8).padStart(3)}  ${String(s.n5).padStart(3)}  ${String(s.n3).padStart(3)}   ${dates[s.worst.i]} ${pct(s.worst.r)}`);
}
const stopFiredTotal = survey.reduce((a, s) => a + s.n8, 0);
console.log(`\n>>> 止损线（单日 ≤ -8%）历史触发合计：${stopFiredTotal} 次。${stopFiredTotal === 0 ? '样本内纯 no-op——实际风控只有 ddTrigger=-0.15（组合回撤 15% 降仓）+ 情绪信号退出。' : ''}\n`);

// ── 情景段定义（起点若非交易日，取其后首个交易日） ──
const idxFrom = (d) => {
  const i = dates.indexOf(d);
  if (i >= 0) return i;
  for (let j = 0; j < dates.length; j++) if (dates[j] > d) return j;
  return -1;
};
const SEGS = [
  { key: 'SEG1', title: '用户点名单日崩盘 2026-07-02', start: '2026-07-01', len: 10, scale: 1 },
  { key: 'SEG2', title: '实测最狠单日 2026-07-28（创业板 -7.35%）', start: '2026-07-27', len: 10, scale: 1 },
  { key: 'SEG3', title: '最惨 5 日连续阴跌 2026-07-13~17', start: '2026-07-10', len: 12, scale: 1 },
  { key: 'SEG4', title: '70 日慢刀（E0 最大回撤窗 2026-06-22 起）', start: '2026-06-22', len: 70, scale: 1 },
  { key: 'SYN15', title: '合成：SEG3 段内跌幅 ×1.5（逼出止损线，非历史）', start: '2026-07-10', len: 12, scale: 1.5 },
  { key: 'SYN20', title: '合成：SEG3 段内跌幅 ×2.0（熔断级，非历史）', start: '2026-07-10', len: 12, scale: 2.0 },
];

// ── 情景引擎：拼接前置建仓期（6 个满仓信号日，maxPosChg=0.2 爬到 1.0 后进段） ──
// 注意不能只拼 1 天：仓位平滑会把拼接日 target 从 0 压到 0.2（clamp±0.2），
// 前 5 天在爬仓——"满仓进入"必须前置 6 天（0.2/0.4/0.6/0.8/1.0/1.0）。
const PRE = 6;
function episode(seg, mode, pressure) {
  const start = idxFrom(seg.start);
  if (start < 0) { console.error(`[stop] 段起点无效：${seg.start}`); process.exit(1); }
  const end = Math.min(start + seg.len, n);
  const segScores = scores.slice(start, end);
  const perAsset = [];
  for (const a of ASSETS) {
    const segRets = retsByAsset[a].slice(start, end).map((r) => r * seg.scale);
    const sc = Array(PRE).fill(70).concat(segScores);   // 前置期：满仓信号（≥lo=65）
    const rt = Array(PRE).fill(0).concat(segRets);      // 前置期：零收益（只爬仓不计盈亏）
    let p = { ...pV52 };
    if (mode === 'stopOnly') { sc.fill(70); p = { ...p, ddTrigger: 0 }; }
    if (mode === 'naked') { sc.fill(70); p = { ...p, stopLoss: 0, ddTrigger: 0 }; }
    let pos = positions(sc, rt, p);         // T+1：段内第 1 天起满仓
    let frozenDays = 0;
    if (pressure === 'freeze') {            // 流动性冻结：清仓执行日遇 r≤-5% 顺延（≤2 日）
      const frozen = [...pos];
      let pend = 0;
      for (let i = 1; i < frozen.length; i++) {
        if (pend > 0) {
          if (rt[i] <= -0.05 && pend < 2) { frozen[i] = frozen[i - 1]; pend++; frozenDays++; }
          else { frozen[i] = 0; pend = 0; }
          continue;
        }
        if (frozen[i] === 0 && frozen[i - 1] > 0 && rt[i] <= -0.05) {
          frozen[i] = frozen[i - 1]; pend = 1; frozenDays++;
        }
      }
      pos = frozen;
    }
    const cost = turnoverCost(pos, p);
    if (pressure === 'impact') {            // 清仓日额外 0.5% 冲击成本
      for (let i = 1; i < pos.length; i++) {
        if (pos[i] === 0 && pos[i - 1] > 0) cost[i] += pos[i - 1] * 0.005;
      }
    }
    const stopDays = rt.map((r, i) => (r <= -0.08 && i >= PRE ? i : 0)).filter((x) => x > 0);
    const exits = pos.map((x, i) => (i >= PRE && x === 0 && pos[i - 1] > 0 ? i : 0)).filter((x) => x > 0);
    perAsset.push({ asset: a, pos, cost, rets: rt, stopDays, exits, frozenDays });
  }
  // 池合成（等权）
  const L = perAsset[0].pos.length;
  const strat = new Array(L).fill(0);
  const posPool = new Array(L).fill(0);
  for (const pa of perAsset) {
    for (let i = 0; i < L; i++) {
      strat[i] += (pa.rets[i] * pa.pos[i] - pa.cost[i]) / ASSETS.length;
      posPool[i] += pa.pos[i] / ASSETS.length;
    }
  }
  const exitIdx = posPool.findIndex((x, i) => i >= PRE && x === 0); // 全资产清仓日
  const cutIdx = posPool.findIndex((x, i) => i >= PRE && x < posPool[i - 1] - 1e-9); // 首个减仓日
  let cum = 0;
  for (let i = PRE; i < L; i++) cum += Math.log(1 + strat[i]); // 段内起算（不含前置建仓成本）
  let rebound = 0;
  if (exitIdx > 0) for (let i = exitIdx + 1; i < Math.min(exitIdx + 6, L); i++) rebound += strat[i];
  const segDates = Array(PRE).fill('(前置)').concat(dates.slice(start, end));
  return {
    seg, mode, pressure, strat, posPool, perAsset, exitIdx, cutIdx, L, cum, rebound, segDates,
    frozenTotal: perAsset.reduce((a, x) => a + x.frozenDays, 0),
    stopTriggered: perAsset.some((pa) => pa.stopDays.length > 0),
    firedAssets: perAsset.filter((pa) => pa.stopDays.length > 0).map((pa) => `${pa.asset}@${segDates[pa.stopDays[0]]}(${pct(pa.rets[pa.stopDays[0]])})`),
    endPos: posPool[L - 1],
  };
}

// ── 主矩阵：段 × 模式 × 压力 ──
const MODES = [
  { key: 'real', label: '真实双风控' },
  { key: 'stopOnly', label: '纯止损路径' },
  { key: 'naked', label: '无风控对照' },
];
const PRESSURES = [
  { key: 'base', label: '基线(收盘成交)' },
  { key: 'impact', label: '冲击滑点(+0.5%)' },
  { key: 'freeze', label: '流动性冻结(顺延≤2日)' },
];
const results = {};
for (const seg of SEGS) {
  results[seg.key] = {};
  for (const mode of MODES) {
    results[seg.key][mode.key] = {};
    for (const pr of PRESSURES) results[seg.key][mode.key][pr.key] = episode(seg, mode.key, pr.key);
  }
}

console.log('═══ 沙盘矩阵：段 × 模式 × 压力（段内累计 / 首减仓日 / 止损触发） ═══');
for (const seg of SEGS) {
  const r = results[seg.key];
  console.log(`\n[${seg.key}] ${seg.title}（${seg.start} 起 ${seg.len} 日${seg.scale !== 1 ? `，跌幅×${seg.scale}` : ''}）`);
  for (const mode of MODES) {
    for (const pr of PRESSURES) {
      const e = r[mode.key][pr.key];
      const cut = e.cutIdx > 0 ? e.segDates[e.cutIdx] : '未减仓';
      const exit = e.exitIdx > 0 ? e.segDates[e.exitIdx] : '未清仓';
      const fire = e.stopTriggered ? `止损触发[${e.firedAssets.join(' ')}]` : '止损未触发';
      console.log(`  ${mode.label.padEnd(8)} | ${pr.label.padEnd(20)} | 累计 ${fmt(e.cum * 100, 2).padStart(7)}% | 首减仓 ${cut.padEnd(11)} | 清仓 ${exit.padEnd(11)} | ${fire}${e.frozenTotal ? ` | 冻结顺延 ${e.frozenTotal} 腿日` : ''}`);
    }
  }
  const re = r.real.base, nk = r.naked.base, so = r.stopOnly.base;
  console.log(`  >>> 三模式对照(基线)：真实 ${fmt(re.cum * 100, 2)}% vs 纯止损 ${fmt(so.cum * 100, 2)}% vs 无风控 ${fmt(nk.cum * 100, 2)}% | 段末仓位 ${fmt(re.endPos, 2)} | 退出后5日反弹 ${re.exitIdx > 0 ? fmt(re.rebound * 100, 2) + '%' : '—'}`);
}

// ── 逐日解剖（SEG3 真实 + SYN20 纯止损：验执行链路） ──
function dayLines(segKey, modeKey, prKey) {
  const e = results[segKey][modeKey][prKey];
  const lines = [];
  for (let i = PRE; i < e.L; i++) {
    const cells = ASSETS.map((a) => {
      const pa = e.perAsset.find((x) => x.asset === a);
      return pct(pa.rets[i]);
    });
    lines.push({ d: e.segDates[i], cells, pool: fmt(e.posPool[i], 2), strat: fmt(e.strat[i] * 100, 2) + '%' });
  }
  return lines;
}
console.log('\n═══ SEG3 逐日解剖（真实双风控 · 基线） ═══');
for (const l of dayLines('SEG3', 'real', 'base')) console.log(`${l.d}  ${l.cells.map((c) => c.padStart(7)).join(' ')}  | 池仓位 ${l.pool} | 策略 ${l.strat.padStart(7)}`);
console.log('\n═══ SYN20 逐日解剖（纯止损路径 · 基线——跌幅×2 时止损链路全貌） ═══');
for (const l of dayLines('SYN20', 'stopOnly', 'base')) console.log(`${l.d}  ${l.cells.map((c) => c.padStart(7)).join(' ')}  | 池仓位 ${l.pool} | 策略 ${l.strat.padStart(7)}`);
console.log('\n═══ SYN20 逐日解剖（纯止损路径 · 流动性冻结——止损失败形态） ═══');
for (const l of dayLines('SYN20', 'stopOnly', 'freeze')) console.log(`${l.d}  ${l.cells.map((c) => c.padStart(7)).join(' ')}  | 池仓位 ${l.pool} | 策略 ${l.strat.padStart(7)}`);

// ══════════ Markdown 报告 ══════════
const md = [];
md.push('# P0 止损模拟触发测试：极端行情满仓沙盘');
md.push('');
md.push(`生成：node tools/backtest/test_stoploss_simulation.mjs · 样本 ${dates[0]} ~ ${dates[n - 1]}（${n} 交易日）`);
md.push('');
md.push('门禁：全样本复现 v52 锚点 -1.50% / 13.79% ✓（输入重建无误，段内数字可信）。');
md.push('');
md.push('## 零、引擎止损语义验明（测试前置发现）');
md.push('');
md.push('`src/backtest.js` L104：`stopHit = stopLoss<0 && held && rets[i] <= stopLoss`——**stopLoss=-8% 是"单日收益 ≤ -8%"的单日崩盘熔断，不是"浮亏 -8%"的入场价止损**。浮亏侧唯一风控是 `ddTrigger=-0.15`（组合净值回撤 15% → 仓位压至 0.4）。');
md.push('');
md.push('| 指数 | 单日≤-8% | 单日≤-5% | 单日≤-3% | 最差单日 |');
md.push('|---|---|---|---|---|');
for (const s of survey) md.push(`| ${s.asset} | ${s.n8} | ${s.n5} | ${s.n3} | ${dates[s.worst.i]} ${pct(s.worst.r)} |`);
md.push('');
md.push(`**止损线历史触发合计 ${stopFiredTotal} 次——样本内纯 no-op。**样本内的实际保护全部来自：①情绪信号退出（崩盘时分数跌破阈值减仓/清仓）②ddTrigger 回撤降仓。`);
md.push('');

md.push('## 一、沙盘矩阵（段 × 模式 × 成交压力）');
md.push('');
md.push('模式：`real` 真实双风控（生产口径）/ `stopOnly` 恒满仓信号+关 dd（退出只剩 -8% 熔断）/ `naked` 无风控。压力：`base` 收盘成交 / `impact` 清仓日 +0.5% 冲击 / `freeze` 清仓遇 r≤-5% 顺延 ≤2 日。');
md.push('');
for (const seg of SEGS) {
  const r = results[seg.key];
  md.push(`### ${seg.key} ${seg.title}`);
  md.push('');
  md.push('| 模式 | 压力 | 段内累计 | 首减仓 | 全清仓 | 止损触发 | 冻结顺延 |');
  md.push('|---|---|---|---|---|---|---|');
  for (const mode of MODES) {
    for (const pr of PRESSURES) {
      const e = r[mode.key][pr.key];
      md.push(`| ${mode.label} | ${pr.label} | ${fmt(e.cum * 100, 2)}% | ${e.cutIdx > 0 ? e.segDates[e.cutIdx] : '—'} | ${e.exitIdx > 0 ? e.segDates[e.exitIdx] : '—'} | ${e.stopTriggered ? `**是**（${e.firedAssets.join('、')}）` : '否'} | ${e.frozenTotal || '—'} |`);
    }
  }
  const re = r.real.base, nk = r.naked.base, so = r.stopOnly.base;
  md.push('');
  md.push(`三模式对照（基线）：真实 ${fmt(re.cum * 100, 2)}% / 纯止损 ${fmt(so.cum * 100, 2)}% / 无风控 ${fmt(nk.cum * 100, 2)}%；段末仓位 ${fmt(re.endPos, 2)}。`);
  md.push('');
}

md.push('## 二、逐日解剖');
md.push('');
for (const [segKey, modeKey, prKey, title] of [
  ['SEG3', 'real', 'base', 'SEG3 真实双风控 · 基线（最惨 5 日阴跌）'],
  ['SYN20', 'stopOnly', 'base', 'SYN20 纯止损路径 · 基线（跌幅×2，止损链路全貌）'],
  ['SYN20', 'stopOnly', 'freeze', 'SYN20 纯止损路径 · 流动性冻结（止损失败形态）'],
]) {
  md.push(`### ${title}`);
  md.push('');
  md.push(`| 日期 | ${ASSETS.join(' | ')} | 池仓位 | 当日策略 |`);
  md.push(`|---|${ASSETS.map(() => '---').join('|')}|---|---|`);
  for (const l of dayLines(segKey, modeKey, prKey)) md.push(`| ${l.d} | ${l.cells.join(' | ')} | ${l.pool} | ${l.strat} |`);
  md.push('');
}

md.push('---');
md.push('## 总裁决');
md.push('');
md.push('### 用户三问的直接回答');
md.push('');
md.push('**Q1 止损是否触发？**——历史 4 段极端行情全部**未触发**（-8% 单日线 vs 实测最狠 -7.35%，全样本 0/241 日）。只有合成放大情景（跌幅 ×1.5/×2.0）才逼出触发：SYN15 于 07-17（深成 -8.10%/创业板 -10.73%），SYN20 于 07-10（创业板 -8.74%）+07-17（深成 -10.80%）。');
md.push('');
md.push('**Q2 触发时实际亏损多少？**——满仓腿当日吃满跌幅（T+1 结构性无法避免当日损失），段内累计 -15.04%（SYN15 纯止损）/ -17.63%（SYN20 纯止损）。且 **V 型反弹下止损是负贡献**：SYN15 止损 -15.04% vs 死扛 -12.35%，止损多亏 2.69pp——07-17 触发 → 07-20 清仓 → 07-21 深成 +9.62%/创业板 +14.10% 反弹只吃到残余仓位。');
md.push('');
md.push('**Q3 跌停/流动性导致止损失败？**——SYN20 冻结压力下仅发生 1 腿日顺延（07-13 深成 -6.96% 清仓顺延一日，满仓多吃 -5.76%），代价 +2.15pp（真实）/ +2.61pp（纯止损）；冲击滑点 +0.5% 代价 +0.27~0.47pp。**没有"连续卖不出去"的灾难链**：最惨单日 -10.80%（跌停板级别）次日即可成交——三大指数 ETF 流动性不是瓶颈。历史 4 段中 impact/freeze 与 base 完全零差异（段内无清仓冻结事件）。');
md.push('');
md.push('### 结构性结论（五条）');
md.push('');
md.push('1. **stopLoss=-8% 是"熔断保险"不是"止损器"**：判定条件是单日收益 ≤ -8%（非浮亏 -8%），样本内 0 次触发、纯 no-op。它防的是 2015/2020 级单日熔断，本样本（2025-10~2026-09）无此行情。保留（零成本防极端），但不指望它。');
md.push('');
md.push('2. **真正的保护链 = 情绪信号退出 + ddTrigger 回撤降仓**：SEG4 慢刀 70 日，真实双风控 -12.87% vs 无风控 -19.47%——**省 6.60pp**，全部来自信号退出与 dd 压仓（段末仓位 0.38）。这与双轨实验"V5.3 保额来自 recover/neutral 慢跌全程压仓"的结论互证：慢刀行情靠降仓链，不靠止损线。');
md.push('');
md.push('3. **V 型市里止损是负贡献（-2.69pp）**：T+1 吃满当日跌幅 + 次日清仓恰在反弹前夜。三方互证：体检④"样本内 4 段急跌全 V 型"、双轨 T2"尾部帽割在反弹上"、本沙盘 SYN15。样本内市场的正确姿势是"跌后减仓、反弹前夜别清仓"，而非"崩盘日熔断"。');
md.push('');
md.push('4. **连崩市里降仓链 > 止损线**：SYN20（×2 熔断级）真实双风控 -16.73% 全场最优（信号提前压仓，熔断日仓位已低），纯止损 -17.63% 全场最差。连续崩盘时，能提前降仓的机制比事后熔断线更有价值。');
md.push('');
md.push('5. **满仓进入的最坏情形 = 风险预算基准**：历史慢刀 -12.87%、合成连崩 -16.73%/-20.24%（含冻结）。12% 心理止损线在满仓极端情形下**会被击穿**——支持"模拟盘第 1 个月不设心理止损、逼线启动尸检而非清仓"的既定拍板；仓位规划按 -17~-20% 尾部做压力预算。');
md.push('');
md.push('### P0 判定与下一步');
md.push('');
md.push('- **止损机制通过沙盘**：无止损失败灾难链（顺延上限 1 腿日、代价 ≤2.61pp），冲击滑点代价 ≤0.47pp，执行层可用。');
md.push('- **但保护主力不是它**：实盘风险叙事应改为"信号退出 + ddTrigger 降仓为主、-8% 熔断线为尾部保险"。');
md.push('- **按既定优先级推进 P1：回滚脚本**（5 分钟切回 V5.2 基线的能力），随后 P2 告警通道。');
md.push('- 满仓沙盘的"建仓爬坡"教训已固化进脚本：拼接 1 日会被 maxPosChg 压到 0.2（爬仓 5 日），满仓进入须前置 6 日——回测复现类实验的通用陷阱，已注释在引擎函数头。');

mkdirSync(join(ROOT, 'tools', 'backtest', 'reports'), { recursive: true });
writeFileSync(join(ROOT, 'tools', 'backtest', 'reports', 'test_stoploss_simulation.md'), md.join('\n'), 'utf8');
console.log('\n[stop] 报告已写 tools/backtest/reports/test_stoploss_simulation.md（含总裁决五条 + 用户三问直答）');
