// ③ 策略收益回测：三个具体策略 × 沪深300基准，严格 point-in-time。
// 核心模型（buildTrades/tradeReturns/buildNav/metrics）在 src/strategy_bt.js——
// 与单测共享同一实现（测试锁「信号只读 T 日收盘数据」的时点纪律）。
//
// 策略定义（2026-10-02 拍板）：
//   A 冰点反转：T 日情绪 < 10 → T+1 开盘买沪深300 持有 N 日（N=3/5/10）；
//               持有期内情绪 > 90 → 次日开盘清仓（过热避险）。
//   B 题材动量：T 日 top1 题材（去噪口径覆盖个股数最多）→ T+1 开盘等权买入成员股，持有 N 日。
//   C 梯队风险偏好：T 日 max_lb ≥ 4 且 2 板以上家数 ≥ 8 → T+1 开盘买沪深300 持有 N 日；
//               持有期内 max_lb ≤ 2（梯队断层）→ 次日开盘清仓。
//
// 免责纪律：历史回测 ≠ 未来；可用样本仅 33 个真实交易日（208 个回填天只有 s_net 单因子，
// 被排除——混入会让每个指标都错且错得平滑）。触发次数为 0 的策略如实输出 0，不硬凑。
import dns from 'node:dns';
import { atomicWriteJSON } from '../src/fsutil.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../src/config.js';
import { ThemeDenoiser } from '../src/themes.js';
import { quoteSymbol } from '../src/sources.js';
import { metrics, buildTrades, tradeReturns, buildNav, COSTS, ROUND_COST } from '../src/strategy_bt.js';

dns.setDefaultResultOrder('ipv4first');

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const KDIR = path.join(ROOT, 'data', '.bt_kline');
const OUT = path.join(ROOT, 'data', 'backtest-strategies.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOLDINGS = [3, 5, 10];
const r4 = (v) => (v != null ? Math.round(v * 1e4) / 1e4 : null);

// ── 行情：日K（缓存优先，miss 真抓腾讯 ifzq 前复权）─────────────────────────
// minLen：指数 100（保证历史窗口足够）；个股 20——新股 K 线天然短，一刀切 100 会把
// 题材成员里的次新股整批拒掉（实测 86 只里 4 只被误杀）。
async function getKline(sym, minLen = 20) {
  const cache = path.join(KDIR, sym + '.json');
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, 'utf8'));
  for (let att = 0; att < 3; att++) {
    try {
      const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${sym},day,,,320,qfq`;
      const j = await (await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' } })).json();
      const node = j && j.data && j.data[sym];
      const rows = node && (node.qfqday || node.day);
      if (!Array.isArray(rows) || rows.length < minLen) throw new Error(`K线结构异常/过短(${rows ? rows.length : 0} < ${minLen})`);
      const k = rows.map((r) => ({ date: String(r[0]), open: +r[1], close: +r[2] }))
        .filter((x) => Number.isFinite(x.open) && x.open > 0 && Number.isFinite(x.close) && x.close > 0);
      mkdirSync(KDIR, { recursive: true });
      atomicWriteJSON(cache, JSON.stringify(k));
      return k;
    } catch (e) {
      if (att === 2) throw new Error(`${sym} 日K获取失败: ${e.message}`);
      await sleep(800 * (att + 1));
    }
  }
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
const arc = JSON.parse(readFileSync(path.join(ROOT, 'data', 'archive.json'), 'utf8'));
const allDays = arc.all_days || [];
const realDays = allDays.filter((d) => d.emotion && !d.emotion._backfill && !d.emotion._legacy);
if (realDays.length < 10) { console.error('[bt-strategies] 真实样本不足，跳过'); process.exit(0); }

// 沪深300 日K（基准 + A/C 策略标的）
const HS300 = await getKline('sh000300', 100);
const kIdxMap = new Map(HS300.map((x, i) => [x.date, i]));
const kIdx = realDays.map((d) => (kIdxMap.has(d.trade_date) ? kIdxMap.get(d.trade_date) : null));
kIdx._klineLen = HS300.length;
const missingAnchor = realDays.filter((d, i) => kIdx[i] == null).map((d) => d.trade_date);
if (missingAnchor.length) console.warn(`⚠ ${missingAnchor.length} 个信号日在沪深300日K中无锚点（跳过）: ${missingAnchor.slice(0, 5).join('、')}${missingAnchor.length > 5 ? '…' : ''}`);

// 题材成员（B 策略）：ThemeDenoiser 与生产同一实现（enrich 同源）
const dn = new ThemeDenoiser({ minGlobalStocks: config.minThemeStocksGlobal }).fit(allDays);
const byDay = dn.themesAllDays(allDays);
const realIdxInAll = new Map(realDays.map((d) => [d, allDays.indexOf(d)]));
const topThemeOf = (i) => {
  const topics = realDays[i].topics || [];
  if (!topics.length) return null;
  const top = topics[0]; // 已按 count 降序（生产口径）
  const codes = byDay[realIdxInAll.get(realDays[i])] && byDay[realIdxInAll.get(realDays[i])][top.tag];
  return { tag: top.tag, count: top.count, codes: codes ? [...codes] : [] };
};

// B 策略成员股日K预取（缓存，首次运行需网络）
const neededSyms = new Set();
for (let i = 0; i < realDays.length; i++) {
  const tt = topThemeOf(i);
  if (tt && tt.codes.length) for (const c of tt.codes) { const s = quoteSymbol(c); if (s) neededSyms.add(s); }
}
console.log(`题材动量标的池：${neededSyms.size} 只（top1 题材成员去重）`);
const klineCache = new Map();
for (const sym of neededSyms) {
  try { klineCache.set(sym, await getKline(sym, 20)); }
  catch (e) { console.warn(`  ⚠ ${sym} 日K缺失（成员按缺行情剔除）: ${e.message}`); }
}
klineCache.set('sh000300', HS300);
const klineOf = (sym) => (sym == null ? HS300 : klineCache.get(sym));

// ── 信号（严格 T 日收盘口径；闭包只读 realDays[i] 当日字段）───────────────────
const emotionOf = (i) => realDays[i].emotion.value;
const maxLbOf = (i) => (realDays[i].summary && realDays[i].summary.max_lb) || 0;
const lb2Of = (i) => (realDays[i].summary && realDays[i].summary.lb2_count) || 0;
const entryA = (i) => emotionOf(i) < 10;                    // 冰点
const exitA = (i) => emotionOf(i) > 90;                     // 过热避险
const entryC = (i) => maxLbOf(i) >= 4 && lb2Of(i) >= 8;     // 梯队扩张
const exitC = (i) => maxLbOf(i) <= 2;                       // 梯队断层
const entryB = (i) => { const t = topThemeOf(i); return !!(t && t.codes.length >= 2); };

// ── 三个策略 × 持有期扫描 ────────────────────────────────────────────────────
const k0 = Math.max(1, Math.min(...kIdx.filter((x) => x != null)));
const k1 = HS300.length - 1;
const benchNav = (() => { const nav = []; let cur = 1; for (let t = k0; t <= k1; t++) { cur *= HS300[t].close / HS300[t - 1].close; nav.push(cur); } return nav; })();
const benchRets = [HS300[k1].close / HS300[k0 - 1].close - 1];
const entryCount = (fn) => realDays.reduce((a, _, i) => a + (fn(i) ? 1 : 0), 0);

const strategies = [];
for (const holdN of HOLDINGS) {
  // A 冰点反转
  {
    const trades = buildTrades(realDays, kIdx, entryA, exitA, holdN, null);
    const tr = tradeReturns(trades, klineOf).filter((x) => x.ret != null);
    const nav = buildNav(trades, klineOf, k0, k1);
    strategies.push({
      id: 'A_ice_reversal', label: `冰点反转（<10 买 / >90 避险，持有 ${holdN} 日）`,
      holdN, entry: 'T日 emotion<10 → T+1 开盘买沪深300', exit: `持有 ${holdN} 日收盘卖；期间 emotion>90 → 次日开盘卖`,
      triggered: entryCount(entryA), trades: trades.length,
      ...metrics(nav, tr.map((x) => x.ret)),
      nav: nav.map(r4), // 逐日净值曲线（与顶层 navDates 同锚；r4 精度足够画图）
      tradeList: trades.map((t, j) => ({ signalDay: t.signalDay, entry: HS300[t.entryK].date, exit: HS300[t.exitK].date, ret: tr[j] ? r4(tr[j].ret) : null })),
    });
  }
  // B 题材动量
  {
    const membersOf = (i) => { const tt = topThemeOf(i); return tt ? tt.codes.map((c) => quoteSymbol(c)).filter(Boolean) : null; };
    const trades = buildTrades(realDays, kIdx, entryB, null, holdN, membersOf);
    const tr = tradeReturns(trades, klineOf).filter((x) => x.ret != null);
    const nav = buildNav(trades, klineOf, k0, k1);
    const themeOfDay = (day) => { const i = realDays.findIndex((d) => d.trade_date === day); const tt = i >= 0 ? topThemeOf(i) : null; return tt ? tt.tag : null; };
    strategies.push({
      id: 'B_theme_momentum', label: `题材动量（top1 题材等权，持有 ${holdN} 日）`,
      holdN, entry: 'T日 top1 题材（去噪口径）→ T+1 开盘等权买成员股', exit: `持有 ${holdN} 日收盘卖`,
      triggered: entryCount(entryB), trades: trades.length,
      droppedMembersTotal: tradeReturns(trades, klineOf).reduce((a, x) => a + (x.dropped || 0), 0),
      ...metrics(nav, tr.map((x) => x.ret)),
      nav: nav.map(r4),
      tradeList: trades.map((t, j) => ({ signalDay: t.signalDay, theme: themeOfDay(t.signalDay), entry: HS300[t.entryK].date, exit: HS300[t.exitK].date, members: t.members ? t.members.length : null, ret: tr[j] ? r4(tr[j].ret) : null })),
    });
  }
  // C 梯队风险偏好
  {
    const trades = buildTrades(realDays, kIdx, entryC, exitC, holdN, null);
    const tr = tradeReturns(trades, klineOf).filter((x) => x.ret != null);
    const nav = buildNav(trades, klineOf, k0, k1);
    strategies.push({
      id: 'C_ladder_risk', label: `梯队风险偏好（高度≥4且2板+≥8 买 / 高度≤2 断层卖，持有 ${holdN} 日）`,
      holdN, entry: 'T日 max_lb≥4 且 lb2_count≥8 → T+1 开盘买沪深300', exit: `持有 ${holdN} 日收盘卖；期间 max_lb≤2 → 次日开盘卖`,
      triggered: entryCount(entryC), trades: trades.length,
      ...metrics(nav, tr.map((x) => x.ret)),
      nav: nav.map(r4),
      tradeList: trades.map((t, j) => ({ signalDay: t.signalDay, entry: HS300[t.entryK].date, exit: HS300[t.exitK].date, ret: tr[j] ? r4(tr[j].ret) : null })),
    });
  }
}

// ── 输出 ─────────────────────────────────────────────────────────────────────
const report = {
  meta: {
    generatedAt: new Date().toISOString(),
    engine: 'scripts/backtest_strategies.mjs + src/strategy_bt.js（逐笔交易模型：T日信号 → T+1开盘成交 → N日收盘出场；时点纪律由 test/backtest_strategies.test.mjs 锁定）',
    pointInTime: '信号只读 T 日收盘字段（emotion/max_lb/topics）；成交一律 T+1 开盘价；重叠信号不加仓',
    costs: `与 V5.2 同口径：佣金 ${COSTS.comm}（双边）+ 印花税 ${COSTS.stamp}（卖出）+ 滑点 ${COSTS.slip}，单次往返约 ${(ROUND_COST * 100).toFixed(3)}%`,
    sample: {
      realDays: realDays.length,
      range: [realDays[0].trade_date, realDays[realDays.length - 1].trade_date],
      excludedBackfillDays: allDays.length - realDays.length,
      // 样本注记动态生成（2026-10-02 六因子回填后 208 个历史天已是七因子真分，进入样本；
      // 池字段为 K 线重建口径，见 summary.pools_caliber / data/archive.json meta.note）
      note: allDays.length - realDays.length > 0
        ? '历史回填天只有 s_net 单因子（非综合分），全部排除。'
        : `样本含六因子回填天（K 线重建池口径）。样本期情绪区间 ${Math.min(...realDays.map((d) => d.emotion.value)).toFixed(1)}~${Math.max(...realDays.map((d) => d.emotion.value)).toFixed(1)}。`,
    },
    disclaimer: `历史回测 ≠ 未来收益。样本 ${realDays.length} 个交易日${allDays.length - realDays.length > 0 ? '（回填天已排除）' : '（含六因子回填天，池字段为 K 线重建口径——较 EM 采集口径 s_zbl 平均偏低 ~4.5 分）'}，结果仅用于管线自检与口径演示，不构成投资建议，不当选股依据。`,
  },
  benchmark: { id: 'HS300_buyhold', label: '沪深300 买入持有（同区间）', ...metrics(benchNav, benchRets), nav: benchNav.map(r4) },
  // 净值曲线共用日期锚（strategies[].nav 与 benchmark.nav 的 x 轴，同一 K 线区间）
  navDates: HS300.slice(k0, k1 + 1).map((k) => k.date),
  strategies,
};
atomicWriteJSON(OUT, JSON.stringify(report, null, 2) + '\n');

console.log(`\n[bt-strategies] 样本 ${realDays.length} 个真实交易日（${report.meta.sample.range[0]} ~ ${report.meta.sample.range[1]}），基准区间 K 线 ${k1 - k0 + 1} 日`);
console.log(`基准 沪深300: 总收益 ${report.benchmark.total} · 最大回撤 ${report.benchmark.maxDd} · 夏普 ${report.benchmark.sharpe}`);
for (const s of strategies) {
  console.log(`${s.label}`);
  console.log(`  信号触发 ${s.triggered} 次 / 成交 ${s.trades} 笔 · 总收益 ${s.total} · 年化 ${s.annual} · 回撤 ${s.maxDd} · 夏普 ${s.sharpe} · 胜率 ${s.winRate} · 盈亏比 ${s.plRatio}`);
}
console.log(`\n已写入 ${path.relative(ROOT, OUT)} —— 免责与口径见 meta。`);
