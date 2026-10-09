// S3-1 即时轨数据源测试：估值公式 / 当日序列 / accountStats 形态对齐 /
// 降级纪律 / 当日高点回撤（max_drawdown_daily 的数据面）。
// 夹具与 test/ai_report.test.mjs 同源同构（DT/SIG/GLOBAL/BT/OPS 六源迷你夹具），
// 保证 generateIntraday 集成断言与其行为一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  intradayEquity, buildLiveAccount, liveAccountStats, dailyDrawdown, riskTierDistance,
  seriesKey, appendSample, deserializeSeries, SERIES_KEY_PREFIX, PORTFOLIO_CODE,
} from '../src/intraday_live.js';
import { accountStats, DD_TIERS } from '../src/paper.js';
import { buildInput, generateIntraday, DD_TIER_EDGES } from '../src/ai_report.js';
import { validateContract } from '../src/contract.js';

const SCHEMA = JSON.parse(readFileSync(new URL('../schemas/ai-report.schema.json', import.meta.url), 'utf8'));

// ── 六源迷你夹具（同 test/ai_report.test.mjs，仅本测试所需最小面）────────
const DT = {
  day: {
    date: '2026-09-30', score: 64.41,
    regime: { key: 'recover', label: '回暖', cap: 0.5 },
    trackA: { targetPos: { '上证指数': 0.7 }, poolPos: 0.5, executed: true },
    trackB: { refPos: { '上证指数': 0.3 }, poolPos: 0.3, executed: false },
    divergence: { posGap: 0.2 },
    dayReturns: { A: 0.00017, B: -0.00013 },
  },
  summary: { trackA: { total: -0.015005, maxDd: 0.137886, sharpe: -0.028276 } },
};
const SIG = {
  meta: { tradeDate: '2026-09-30' },
  signals: { latestEmotion: { value: 64.4 } },
  latest: { pct_rank: 44.1, up_count: 2393, down_count: 2730, indexes: { '上证指数': 0.31 } },
  regime: { turns: [] },
};
const GLOBAL = { meta: { aShareTradeDate: '2026-09-30' }, quotes: [] };
const mkInput = (extra = {}) => buildInput({ dualTrack: DT, signals: SIG, global: GLOBAL, backtest: { meta: {} }, opsAlerts: { count: 0, events: [] }, ...extra });
const GEN_AT = '2026-09-30T02:35:00.000Z';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

// ── 1. 盘中实时估值公式 ────────────────────────────────────────────────
test('估值：equity_prev ×（1 + Σ pos×pct% ÷ N）——等权池与归档轨日收益同构', () => {
  const v = intradayEquity({
    equityPrev: 984995.15,
    posToday: { '上证指数': 0.7, '深证成指': 0.4, '创业板指': 0.4 },
    quotes: { '上证指数': { pct: 1.0 }, '深证成指': { pct: -0.5 }, '创业板指': { pct: 0.25 } },
  });
  // 手算：Σ pos×pct = 0.7×1.0 + 0.4×(−0.5) + 0.4×0.25 = 0.6（百分比）→ dayRet = 0.6%/3 = 0.2%
  near(v.dayRet, 0.002);
  near(v.equity, 984995.15 * 1.002);
});

test('估值：全线平盘（pct 全 0）→ 权益 = 昨收锚；负推进同公式', () => {
  const pos = { '上证指数': 0.7, '深证成指': 0.4 };
  const flat = intradayEquity({ equityPrev: 100, posToday: pos, quotes: { '上证指数': { pct: 0 }, '深证成指': { pct: 0 } } });
  assert.equal(flat.equity, 100);
  assert.equal(flat.dayRet, 0);
  const down = intradayEquity({ equityPrev: 100, posToday: pos, quotes: { '上证指数': { pct: -2 }, '深证成指': { pct: 1 } } });
  near(down.dayRet, (-2 * 0.7 + 1 * 0.4) / 100 / 2); // −1.0%/2 = −0.5%
  near(down.equity, 99.5);
});

test('降级：任一资产缺实时涨幅 / 锚非法 / 空仓位 → null 不冒充', () => {
  const pos = { '上证指数': 0.7, '深证成指': 0.4 };
  assert.equal(intradayEquity({ equityPrev: 100, posToday: pos, quotes: { '上证指数': { pct: 1 } } }), null, '深成缺 pct → 整体不估');
  assert.equal(intradayEquity({ equityPrev: 100, posToday: pos, quotes: { '上证指数': { pct: 'x' }, '深证成指': { pct: 1 } } }), null, 'pct 非法 → null');
  assert.equal(intradayEquity({ equityPrev: null, posToday: pos, quotes: {} }), null, '锚缺失 → null');
  assert.equal(intradayEquity({ equityPrev: -5, posToday: pos, quotes: {} }), null, '锚非正 → null');
  assert.equal(intradayEquity({ equityPrev: 100, posToday: {}, quotes: {} }), null, '空仓位 → null');
  assert.equal(intradayEquity({ equityPrev: 100, posToday: null, quotes: {} }), null, '仓位档缺失 → null');
});

// ── 2. 当日序列（采样 / 跨日重置 / 持久化还原）──────────────────────────
test('序列键：YYYY-MM-DD 格式锁死，非法日期 → null', () => {
  assert.equal(seriesKey('2026-10-08'), SERIES_KEY_PREFIX + '2026-10-08');
  assert.equal(seriesKey('2026-10-8'), null);
  assert.equal(seriesKey(null), null);
});

test('序列追加：同日按序追加；跨日（首点日期变更）→ 重置为单点新序列', () => {
  let s = appendSample([], { date: '2026-10-08', ts: 1, equity: 100 });
  s = appendSample(s, { date: '2026-10-08', ts: 2, equity: 110 });
  s = appendSample(s, { date: '2026-10-08', ts: 3, equity: 105 });
  assert.equal(s.length, 3);
  assert.deepEqual(s.map((x) => x.equity), [100, 110, 105]);
  const next = appendSample(s, { date: '2026-10-09', ts: 4, equity: 106 }); // 跨日
  assert.equal(next.length, 1, '跨日重置');
  assert.equal(next[0].equity, 106);
});

test('序列还原：键匹配 round-trip；键不符/坏档/坏点 → 空或滤除', () => {
  const key = seriesKey('2026-10-08');
  const stored = { key, samples: [{ date: '2026-10-08', ts: 1, equity: 100 }, { date: '2026-10-08', ts: 2, equity: 105 }] };
  assert.equal(deserializeSeries(stored, key).length, 2);
  assert.equal(deserializeSeries(stored, seriesKey('2026-10-09')).length, 0, '键不符 → 重新开始（防跨日串档）');
  assert.equal(deserializeSeries(null, key).length, 0);
  assert.equal(deserializeSeries('垃圾', key).length, 0);
  assert.equal(deserializeSeries({ key, samples: [{ date: '2026-10-08', ts: 1, equity: '坏' }] }, key).length, 0, '坏点滤除');
});

// ── 3. accountStats 形态对齐（S1 预留 live 分路的消费面）────────────────
test('组装：合成持仓法 → accountStats 的 total/peak/drawdown 与手算逐位一致', () => {
  const acct = buildLiveAccount({
    navSeries: [
      { date: '2026-09-29', equity: 985000 },
      { date: '2026-09-30', equity: 984995.15 },
    ],
    equityRealtime: 986965.14,
    tradeDate: '2026-10-08',
    initCash: 1000000,
  });
  assert.ok(acct, '组装成功');
  assert.ok(acct.positions[PORTFOLIO_CODE], '合成持仓在场');
  assert.equal(acct.nav.length, 3, 'nav = 全史 2 点 + 今日实时 1 点');
  assert.equal(acct.nav[acct.nav.length - 1].date, '2026-10-08', 'nav 末点 = 交易日（pnl_daily 前提）');
  const st = accountStats(acct);
  assert.equal(st.total, 986965.14, 'total = 实时权益（cash 0 + 合成持仓市值）');
  assert.equal(st.peak, 1000000, 'peak = max(init, 历史 nav, 实时)——历史未破百万');
  near(st.drawdown, (1000000 - 986965.14) / 1000000, 1e-12, '总回撤实时版');
  assert.equal(liveAccountStats(acct).total, st.total, '便捷快照 = accountStats');
});

test('组装：今日盘中新高进峰值；收盘后重放（navSeries 末点=当日）不重复追加', () => {
  const acct = buildLiveAccount({
    navSeries: [{ date: '2026-10-08', equity: 1010000 }],
    equityRealtime: 1005000,
    tradeDate: '2026-10-08',
    initCash: 1000000,
  });
  assert.equal(acct.nav.length, 1, '末点已是当日 → 不重复追加');
  assert.equal(accountStats(acct).peak, 1010000, '历史高点仍进峰值');
  const high = buildLiveAccount({
    navSeries: [{ date: '2026-10-07', equity: 1000000 }],
    equityRealtime: 1008000, // 今日实时新高
    tradeDate: '2026-10-08',
    initCash: 1000000,
  });
  assert.equal(accountStats(high).peak, 1008000, '盘中新高进峰值（S3-2 即时轨 dd_now 口径基础）');
  assert.equal(accountStats(high).drawdown, 0);
});

test('组装降级：入参非法（锚缺/序列空/日期坏）→ null 不冒充', () => {
  assert.equal(buildLiveAccount({ navSeries: [], equityRealtime: 100, tradeDate: '2026-10-08', initCash: 1e6 }), null);
  assert.equal(buildLiveAccount({ navSeries: [{ date: '2026-10-07', equity: 100 }], equityRealtime: null, tradeDate: '2026-10-08', initCash: 1e6 }), null);
  assert.equal(buildLiveAccount({ navSeries: [{ date: '2026-10-07', equity: 100 }], equityRealtime: 100, tradeDate: '10-08', initCash: 1e6 }), null, 'tradeDate 格式坏 → null');
  assert.equal(buildLiveAccount({ navSeries: [{ date: '2026-10-07', equity: 100 }], equityRealtime: 100, tradeDate: '2026-10-08', initCash: null }), null);
});

// ── 4. generateIntraday 集成：S1 live 分路消费本模块产物（零改动验证）────
// 语义对齐：即时轨报告的 tradeDate = 采样当日（S3-4 页面装配时 input.tradeDate
// 即今天），nav 末点 = 今日实时点、倒数第二点 = 昨收锚（dual_track_latest 全史）。
test('集成：generateIntraday(input.live) 消费组装账本 → nav_realtime / dd_now 即时轨口径', () => {
  const equityRealtime = 986965.14;
  const acct = buildLiveAccount({
    navSeries: [{ date: '2026-09-29', equity: 985000 }], // 昨收锚（全史其余略）
    equityRealtime,
    tradeDate: '2026-09-30', // = input.tradeDate（mkInput 夹具数据日 = 采样当日）
    initCash: 1000000,
  });
  const r = generateIntraday(mkInput({ paperAccount: acct }), { generatedAt: '2026-09-30T02:35:00.000Z' });
  assert.deepEqual(validateContract(r, SCHEMA), [], '契约');
  assert.equal(r.payload.nav_realtime, equityRealtime, 'nav_realtime = 实时权益');
  near(r.payload.drawdown_vs_threshold.dd_now, (1000000 - 986965.14) / 1000000, 1e-12, 'dd_now = 总回撤实时版');
  assert.match(r.payload.drawdown_vs_threshold.basis, /即时轨/, 'basis 双口径切到即时轨');
  near(r.payload.pnl_daily, (986965.14 - 985000) / 985000, 1e-12, 'pnl_daily = 今日实时 vs 昨收锚');
  assert.ok(DD_TIER_EDGES.includes(0.09) && DD_TIERS.length === 3, '风控档位常量在位（第二步距离刷新用）');
});

// ── 4.5 盘中身份日期（2026-10-08 严查修复：推送标昨日 + 示例档被踩）───────
// 回归背景：信封 date 曾取盘后主档 tradeDate（盘中时点恒为昨日）→ 推送文案
// 标「09-30」、文件名落「昨日名」逐日错位覆盖、指纹日期失真、当日快照被
// data_health 误标 stale。四断言锁死：身份日期=快照日、口径日期=主档日
// （语义分离，不混）、快照在场即 fresh、缺席兜底主档不炸。
test('盘中身份日期 = 快照交易日（≠ 主档昨收口径日）；快照在场不误标 stale', () => {
  const intra = { tradeDate: '2026-10-08', phase: 'live', hot: { rows: [] } };
  const r = generateIntraday(mkInput({ intraday: intra }), { generatedAt: GEN_AT });
  assert.equal(r.date, '2026-10-08', '信封 date = 快照交易日（当日）');
  assert.equal(r.payload.date, '2026-09-30', 'payload.date 保持主档口径（盘中盈亏恒昨收口径，推送文案已点破）');
  assert.equal(r.data_health.sources.intraday, 'fresh', '当日快照不得因「≠ 昨日主档」被误标 stale');
  assert.deepEqual(validateContract(r, SCHEMA), [], '契约不因日期改动破');
  const bare = generateIntraday(mkInput(), { generatedAt: GEN_AT });
  assert.equal(bare.date, '2026-09-30', '快照缺席 → 兜底主档日期（防御性不炸）');
  assert.equal(bare.data_health.sources.intraday, 'missing', '快照缺席 → missing 照旧');
});

// ── 5. 当日高点回撤（第二步 max_drawdown_daily 的数据面）────────────────
test('当日回撤：(日内高点 − 当前) ÷ 高点；单点/空/新高 → null 或 0 不冒充', () => {
  near(dailyDrawdown([{ equity: 100 }, { equity: 110 }, { equity: 105 }]), 5 / 110, 1e-12);
  assert.equal(dailyDrawdown([{ equity: 100 }, { equity: 110 }]), 0, '收在高点 → 0');
  assert.equal(dailyDrawdown([{ equity: 100 }]), null, '单点无回撤语义');
  assert.equal(dailyDrawdown([]), null);
  assert.equal(dailyDrawdown(null), null);
  near(dailyDrawdown([{ equity: 100 }, { equity: 90 }, { equity: 95 }, { equity: 91 }]), 9 / 100, 1e-12, '高点 100 当前 91');
});

// ── 6. 风控档距离（快照卡"距风控档"与报告同尺）─────────────────────────
test('riskTierDistance：派生自 DD_TIERS，与 ai_report 的 DD_TIER_EDGES 逐项一致', async () => {
  const { DD_TIER_EDGES } = await import('../src/ai_report.js');
  // 派生边沿一致性：DD_TIERS thresholds（>0 升序）≡ DD_TIER_EDGES
  const { DD_TIERS } = await import('../src/paper.js');
  assert.deepEqual(DD_TIERS.map((t) => t.threshold).filter((t) => t > 0).sort((a, b) => a - b), DD_TIER_EDGES);
  near(riskTierDistance(0.05), 0.04);            // 9% 档前 4pp
  near(riskTierDistance(0.09), 0);              // 恰在档线 → 0
  near(riskTierDistance(0.10), 0.05);            // 15% 档前 5pp
  near(riskTierDistance(0.18), -0.03, 1e-12);    // 越过最深档 → 负（已超线 3pp）
  assert.equal(riskTierDistance(null), null);
  assert.equal(riskTierDistance(-0.01), null);
  // 与报告 distance_pp 同构：同一 drawdown 两口径差恒为 ×100（基准点对齐）
  const dd = 0.07;
  const r = generateIntraday(mkInput({ paperAccount: buildLiveAccount({ navSeries: [{ date: '2026-09-30', equity: 930000 }], equityRealtime: 930000, tradeDate: '2026-09-30', initCash: 1000000 }) }), { generatedAt: GEN_AT });
  near(r.payload.drawdown_vs_threshold.distance_pp, riskTierDistance(0.07) * 100, 1e-9);
});

// ── 7. max_drawdown_daily 注入（S3-1 第二步：取数+赋值一行，零逻辑扩散）──
test('注入：live + opts.drawdownDaily → 真值搬运（source=live）；缺 → null + 披露', () => {
  const mkAcct = () => buildLiveAccount({
    navSeries: [{ date: '2026-09-29', equity: 985000 }],
    equityRealtime: 986965.14,
    tradeDate: '2026-09-30',
    initCash: 1000000,
  });
  const withVal = generateIntraday(mkInput({ paperAccount: mkAcct() }), { generatedAt: GEN_AT, drawdownDaily: 0.03123 });
  assert.equal(withVal.payload.max_drawdown_daily, 0.03123, '逐位搬运桥数据');
  assert.equal(withVal.data_completeness.max_drawdown_daily.source, 'live');
  assert.ok(!withVal.missing_notes.some((n) => n.field === 'max_drawdown_daily'), '真值在 → 不披露缺失');
  const noVal = generateIntraday(mkInput({ paperAccount: mkAcct() }), { generatedAt: GEN_AT });
  assert.equal(noVal.payload.max_drawdown_daily, null, '序列不足两点（桥 null）→ 不冒充');
  assert.equal(noVal.data_completeness.max_drawdown_daily.source, 'missing');
  assert.ok(noVal.missing_notes.some((n) => n.field === 'max_drawdown_daily'), '缺 → missing_notes 披露在场');
});

test('归档轨零变化：无 paperAccount 时传 drawdownDaily 也不注入', () => {
  const r = generateIntraday(mkInput(), { generatedAt: GEN_AT, drawdownDaily: 0.05 });
  assert.equal(r.payload.max_drawdown_daily, null, '归档轨恒 null（live-only 字段纪律）');
  assert.ok(r.missing_notes.some((n) => /max_drawdown_daily/.test(n.field)), 'LIVE_ONLY_NOTE 披露仍在场');
});
