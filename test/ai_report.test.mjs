// AI 报告核心测试（S1）：null 纪律 / 数字搬运 / data_completeness（决议 5）/
// 双轨合并（决议 1）/ trigger 枚举（决议 3）/ 周报胜率口径（决议 4）/
// 契约校验（schemas/ai-report.schema.json）/ 真实档冒烟（不写死数字，CI 数据更新不红）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

import {
  buildInput, generatePreMarket, generateIntraday, generatePostMarket, generateWeekly,
  mergeReports, buildDataCompleteness, TRIGGER_ENUM, DD_TIER_EDGES, SCHEMA_VERSION,
  mapPhase, buildScripts, buildCandidatePool, buildSimulationStock, emptyFundamentals,
  makeBinding, mergeBindings, loadBindings, saveBindings, exportSimulation, BINDINGS_KEY,
  PHASE_LABELS, SIM_SCRIPT_CONSTS, STARTUP_PCT_RANK_MAX,
} from '../src/ai_report.js';
import { validateContract } from '../src/contract.js';

const SCHEMA = JSON.parse(readFileSync(new URL('../schemas/ai-report.schema.json', import.meta.url), 'utf8'));

// ── 迷你夹具（形态对齐真实档，数字便于手工验算）─────────────────────────
const DT = {
  day: {
    date: '2026-09-30', score: 64.41,
    regime: { key: 'recover', label: '回暖', cap: 0.5 },
    trackA: { targetPos: { '上证指数': 0.7 }, poolPos: 0.5, executed: true },
    trackB: { refPos: { '上证指数': 0.3 }, poolPos: 0.3, executed: false },
    divergence: { posGap: 0.2 },
    dayReturns: { A: 0.00017, B: -0.00013 },
  },
  summary: {
    trackA: { total: -0.015005, maxDd: 0.137886, sharpe: -0.028276 },
    trackB: { total: -0.03483, maxDd: 0.087774 },
    trackC: { '0.5': { total: 0.012027, episodes: 18 } },
    divergence: { daysGt02: 226 },
  },
  sample: { days: 241 },
};
const DAYS = [
  { date: '2026-09-28', score: 32.11, regime: { key: 'ice' }, dayReturns: { A: -0.01049 } },
  { date: '2026-09-29', score: 75.93, regime: { key: 'recover' }, dayReturns: { A: 0.000503 } },
  { date: '2026-09-30', score: 64.41, regime: { key: 'recover' }, dayReturns: { A: 0.00017 } },
];
const SIG = {
  meta: { tradeDate: '2026-09-30' },
  signals: { latestEmotion: { value: 64.4 } },
  latest: { pct_rank: 44.1, up_count: 2393, down_count: 2730, flat_count: 167, amount_yi: 14380.2, zt_count: 52, dt_count: 9, indexes: { '上证指数': 0.31 }, factors: { s_amt: 44 } },
  regime: { turns: [
    { date: '2026-09-28', from: '退潮', to: '冰点' },
    { date: '2026-09-29', from: '冰点', to: '回暖' },
  ] },
  dailyReport: { sections: [{ id: 'regime', position: { range: '30%~50%' } }] },
  breadth: { snapshot: { verdict: { label: '宽度收窄', detail: '站上20日线仅 30.1%' } } },
  pain: { verdict: { label: '多空拉锯', reason: '翻绿 49%' }, advance: { maxLb: 6, failRate: 0.4, detail: [
    { code: '600825', lb: 6, chg: 9.99, kept: true },
    { code: '000678', lb: 3, chg: 9.98, kept: true },
  ] }, perf: { avg: 1.3 } },
  seats: { verdict: { label: '游资主导' } },
};
const GLOBAL = { meta: { aShareTradeDate: '2026-09-30' }, quotes: [
  { key: 'a50', name: '富时中国A50期货', ok: true, state: 'ok', chgPct: 0.0915 },
  { key: 'sox', name: '费城半导体指数', ok: false, state: 'preopen', chgPct: null },
] };
const BT = { meta: { tradeDate: '2026-09-30' }, v52: { total: -0.015005 } };
const OPS = { updatedAt: '2026-10-01T20:28:01.779Z', count: 0, events: [] };

const mkInput = (extra = {}) => buildInput({ dualTrack: DT, dualTrackDays: DAYS, signals: SIG, global: GLOBAL, backtest: BT, opsAlerts: OPS, ...extra });
const GEN_AT = '2026-09-30T10:35:00.000Z';

// 即时轨账本（形态对齐 src/paper.js emptyAccount；nav 两日 → pnl_daily 可算）
const ACCT = {
  initCash: 100000, cash: 100017, freeze: 0, positions: {}, orders: [
    { code: '600825', status: 'filled', settleDate: '2026-09-30', estPrice: 10.0, qty: 500 },
  ], trades: [
    { code: '600825', date: '2026-09-30', px: 10.002, gross: 5001, fee: 5.0, name: 'x' },
  ], pending: [], logs: [], realized: 0, totalFee: 5,
  nav: [
    { date: '2026-09-29', equity: 100000 },
    { date: '2026-09-30', equity: 100017 },
  ],
};

const mustPass = (r, label) => {
  const errs = validateContract(r, SCHEMA);
  assert.deepEqual(errs, [], `${label} 契约违例: ${JSON.stringify(errs)}`);
};

// ── 1. 盘后报告：结构 / 搬运 / null 纪律 ───────────────────────────────
test('盘后报告：信封字段齐 + 数字只搬运 + 结构性 null 不补 0', () => {
  const r = generatePostMarket(mkInput(), { generatedAt: GEN_AT });
  mustPass(r, 'post_market');
  assert.equal(r.schema_version, SCHEMA_VERSION);
  assert.equal(r.report_type, 'post_market');
  assert.equal(r.generated_by, 'ci');
  assert.equal(r.urgent, false);
  assert.equal(r.payload.pnl_daily, DT.day.dayReturns.A, 'pnl_daily 必须逐位搬运 dayReturns.A');
  assert.equal(r.payload.pnl_cumulative, DT.summary.trackA.total);
  assert.equal(r.payload.close_drawdown, DT.summary.trackA.maxDd);
  assert.equal(r.payload.trend_switch_hits, 0, '09-30 当日无切换');
  assert.equal(r.payload.grid_triggers, null, '结构性缺失恒 null');
  assert.equal(r.payload.counter_trend_losses, null);
  assert.equal(r.payload.cost_ratio, null, '归档轨无成交明细 → null 非 0');
  assert.equal(r.payload.slippage_source, 'assumed_constant');
  assert.equal(r.payload.slippage_avg, 0.0002, '假设常量 = src/paper.js DEFAULT_SLIP');
  assert.equal(r.payload.backtest_deviation.delta, 0);
  assert.equal(r.payload.regime.position_range, '30%~50%');
  assert.equal(r.payload.overseas[0].chgPct, 0.000915); // global chgPct 百分数 0.0915 → 报告小数（÷100，S3-5 修复）
  assert.equal(r.payload.overseas[1].chgPct, null, '盘前无数据 = null 绝不写 0');
  assert.equal(r.status, 'degraded', '归档轨 live-only 字段 null → degraded（与 09-30 示例一致）');
  const noteFields = r.missing_notes.map((n) => n.field).join(';');
  assert.match(noteFields, /grid_triggers/, '常驻缺失披露必须在场');
  assert.match(noteFields, /max_drawdown_daily/, '归档轨 live-only 披露必须在场');
});

// ── 1.5 MA20 降级标志（2026-10-08 推送前校验 ①）─────────────────────
// 判据唯一出处：signals.latest.factors.s_amt == null → 量能因子中性 50（当日
// 成交额缺或历史 <10 日），报告 payload 携带 ma20_degraded 供推送红警行消费；
// bool 恒有值不进 deriveStatus（status 语义保持，本组第一测仍 degraded 由
// live-only 字段驱动而非本标志）。
test('MA20 降级标志：s_amt 有值 false / s_amt null true（四类报告信封统一携带）', () => {
  const ok = generatePostMarket(mkInput(), { generatedAt: GEN_AT });
  assert.equal(ok.payload.ma20_degraded, false, 'SIG 夹具 s_amt=44 → 正常版');
  const degradedInput = mkInput({ signals: { ...SIG, latest: { ...SIG.latest, factors: { s_amt: null } } } });
  const degraded = generatePostMarket(degradedInput, { generatedAt: GEN_AT });
  assert.equal(degraded.payload.ma20_degraded, true, 's_amt null → 降级版标志');
  const pre = generatePreMarket(degradedInput, { generatedAt: GEN_AT });
  assert.equal(pre.payload.ma20_degraded, true, '盘前报告同样携带（推送四类全覆盖）');
});

// ── 2. data_completeness（决议 5）──────────────────────────────────────
test('data_completeness：null→missing / 假设常量→assumed / 实测→measured', () => {
  const r = generatePostMarket(mkInput(), { generatedAt: GEN_AT });
  const dc = r.data_completeness;
  assert.deepEqual(dc.grid_triggers, { source: 'missing', confidence: 'missing' });
  assert.deepEqual(dc.cost_ratio, { source: 'missing', confidence: 'missing' }, 'null 值强制 missing');
  assert.deepEqual(dc.slippage_avg, { source: 'assumed', confidence: 'assumed' });
  assert.deepEqual(dc.pnl_daily, { source: 'archived', confidence: 'measured' });
  assert.deepEqual(dc.close_drawdown, { source: 'archived', confidence: 'measured' });
  // 独立直调：overrides 生效
  const dc2 = buildDataCompleteness({ pnl_daily: 0.1, cost_ratio: null }, { pnl_daily: 'live' });
  assert.deepEqual(dc2.pnl_daily, { source: 'live', confidence: 'measured' });
  assert.deepEqual(dc2.cost_ratio, { source: 'missing', confidence: 'missing' });
});

// ── 3. 盘前报告 ───────────────────────────────────────────────────────
test('盘前报告：prev_nav 派生 / 隔夜敞口 / ATR 系结构性 null', () => {
  const r = generatePreMarket(mkInput(), { generatedAt: GEN_AT });
  mustPass(r, 'pre_market');
  assert.ok(Math.abs(r.payload.prev_nav - (1 + DT.summary.trackA.total) / (1 + DT.day.dayReturns.A)) < 1e-12, 'prev_nav=(1+cum)/(1+dayRet) 派生可逆');
  assert.deepEqual(r.payload.overnight_exposure, {
    a50_chgPct: 0.000915, posGap: 0.2,                 // global 百分数 0.0915 → 报告小数（÷100）
    us_close: { dji: null, spx: null, ixic: null },     // fixture 无美股资产 → null（不冒充）
    cn_overnight: { hxc: null, fxi: null },
    cnh_chgPct: null,
  });
  assert.equal(r.payload.positions.poolPos, 0.5);
  for (const k of ['key_levels', 'events_today', 'atr', 'suggested_step']) assert.equal(r.payload[k], null, `${k} 恒 null`);
  assert.equal(r.data_completeness.atr.source, 'missing');
});

// ── 3b. 盘前推送增强（S3-5）：隔夜外围全景逐位对齐 + 降级判定 ──────────────
test('盘前报告：外围收盘全景（dji/spx/ixic/hxc/fxi/cnh）逐位搬运 + ok:false 降级 null', () => {
  const GLOBAL_FULL = { meta: { aShareTradeDate: '2026-09-30' }, quotes: [
    { key: 'a50', name: '富时中国A50期货', ok: true, state: 'ok', chgPct: 0.0915 },
    { key: 'sox', name: '费城半导体指数', ok: false, state: 'preopen', chgPct: null },
    { key: 'dji', name: '道琼斯', ok: true, state: 'ok', chgPct: 0.4942 },
    { key: 'spx', name: '标普500', ok: true, state: 'ok', chgPct: 0.5786 },
    { key: 'ixic', name: '纳斯达克', ok: true, state: 'ok', chgPct: 0.4458 },
    { key: 'hxc', name: '纳斯达克中国金龙指数', ok: true, state: 'ok', chgPct: 0.3142 },
    { key: 'fxi', name: '富时中国ETF（FXI）', ok: true, state: 'ok', chgPct: -0.2363 },
    { key: 'cnh', name: '美元/离岸人民币', ok: false, state: 'unknown', chgPct: 0.5 }, // ok:false → null（有值也不采）
  ] };
  const r = generatePreMarket(mkInput({ global: GLOBAL_FULL }), { generatedAt: GEN_AT });
  mustPass(r, 'pre_market');
  const oe = r.payload.overnight_exposure;
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} ≈ ${b}`);
  near(oe.us_close.dji, 0.004942); near(oe.us_close.spx, 0.005786); near(oe.us_close.ixic, 0.004458);
  near(oe.cn_overnight.hxc, 0.003142); near(oe.cn_overnight.fxi, -0.002363);
  assert.equal(oe.cnh_chgPct, null, 'ok:false → null（buildOverseas 同款判定，不冒充）');
  near(oe.a50_chgPct, 0.000915);
});

// ── 4. 盘中 + trigger 枚举（决议 3）───────────────────────────────────
test('盘中报告：urgent 四类枚举锁死 / 回撤距离披露 / 越界 throw', () => {
  const r = generateIntraday(mkInput(), { generatedAt: GEN_AT, trigger: 'event:circuit_breaker' });
  mustPass(r, 'intraday');
  assert.equal(r.urgent, true);
  assert.equal(r.payload.nav_realtime, null, '归档轨无合成源诚实置 null');
  assert.equal(r.payload.drawdown_vs_threshold.dd_now, DT.summary.trackA.maxDd);
  assert.deepEqual(r.payload.drawdown_vs_threshold.tier_edges, DD_TIER_EDGES);
  assert.ok(r.payload.drawdown_vs_threshold.distance_pp > 0);
  assert.throws(() => generateIntraday(mkInput(), { trigger: 'event:xxx' }), /非法 trigger/);
  assert.throws(() => generateIntraday(mkInput(), { trigger: 'event:grid_hit' }), /决议 3/, '剧本之外的事件类型不在四类白名单');
});

// ── 5. 周报：胜率口径（决议 4）+ 复利 + 切换计数 ───────────────────────
test('周报：win_rate 剧本口径缺席为 null / week_return 复利 / 周内切换 2 次', () => {
  const r = generateWeekly(mkInput(), { generatedAt: GEN_AT, weekStart: '2026-09-28' });
  mustPass(r, 'weekly');
  const expect = (1 - 0.01049) * (1 + 0.000503) * (1 + 0.00017) - 1;
  assert.ok(Math.abs(r.payload.week_return - expect) < 1e-12, '复利口径');
  assert.ok(Math.abs(r.payload.max_drawdown_week - 0.01049) < 1e-9, '周内单边回撤 = 最大日跌幅');
  assert.equal(r.payload.trend_switch_hits, 2);
  assert.equal(r.payload.win_rate, null, '剧本绑定缺席 → null 不降级');
  assert.match(r.payload.win_rate_note, /剧本命中次数/);
  assert.ok(Math.abs(r.payload.profit_trade_ratio - 2 / 3) < 1e-12, '辅助指标 = 日线盈利占比 2/3');
  assert.match(r.payload.trend_switch_effect.shadow_note, /trackC/);
  assert.equal(r.payload.param_suggestions[0].topic, 'posGap 阈值');
});

// ── 6. 即时轨（决议 1：一等公民）──────────────────────────────────────
test('即时轨：账本覆盖 pnl_daily/cost_ratio/slippage 实测，来源标 live', () => {
  const input = mkInput({ paperAccount: ACCT });
  assert.equal(input.live, true);
  assert.equal(input.sources.paper_account, 'live');
  const r = generatePostMarket(input, { generatedAt: GEN_AT, generatedBy: 'browser' });
  mustPass(r, 'post_market(live)');
  assert.equal(r.generated_by, 'browser');
  assert.ok(Math.abs(r.payload.pnl_daily - 0.00017) < 1e-9, 'nav 两日 equity 变化率');
  assert.ok(Math.abs(r.payload.cost_ratio - 5 / 5001) < 1e-9, 'fee/gross 当日成交口径');
  assert.equal(r.payload.fee_total, 5);
  assert.equal(r.payload.net_pnl, 17);
  assert.equal(r.payload.slippage_source, 'measured');
  assert.ok(Math.abs(r.payload.slippage_avg - 0.0002) < 1e-9, 'estPrice 10 → px 10.002 = 万二实测');
  assert.deepEqual(r.data_completeness.pnl_daily, { source: 'live', confidence: 'measured' });
  assert.equal(r.payload.circuit_breaker.dd_tier, 0, '回撤 0 → 0 档');
  assert.equal(r.payload.nav_realtime, 100017, '即时轨 nav_realtime = accountStats.total');
});

// ── 7. 双轨合并（决议 1：generated_at 去重 + null 回填）────────────────
test('mergeReports：新者为基座 / null 回填标来源 / 同刻 browser 优先', () => {
  const archived = generatePostMarket(mkInput(), { generatedAt: '2026-09-30T10:35:00.000Z' }); // ci
  const live = generatePostMarket(mkInput({ paperAccount: ACCT }), { generatedAt: '2026-09-30T10:36:00.000Z', generatedBy: 'browser' });
  const m = mergeReports(live, archived);
  mustPass(m, 'merged');
  assert.equal(m.generated_by, 'browser', '较新者基座');
  assert.ok(m.merged_from.includes('ci'));
  assert.deepEqual(m.backfilled_fields, ['max_drawdown_daily', 'slippage_total', 'counter_trend_loss_ratio'].filter((k) => archived.payload[k] != null && live.payload[k] == null));
  // 归档轨 payload 里非 null 而即时轨 null 的字段被回填（如 market_context 双轨同值则不回填）
  // 反向：旧=新（同 generated_at）→ browser 优先
  const a2 = generatePostMarket(mkInput(), { generatedAt: '2026-09-30T10:35:00.000Z' });
  const l2 = generatePostMarket(mkInput({ paperAccount: ACCT }), { generatedAt: '2026-09-30T10:35:00.000Z', generatedBy: 'browser' });
  assert.equal(mergeReports(a2, l2).generated_by, 'browser');
  // null 互不覆盖：即时轨基座 null（max_drawdown_daily 双轨均 null）保持 null
  assert.equal(m.payload.max_drawdown_daily, null);
  assert.equal(mergeReports(null, archived).generated_by, 'ci');
  assert.equal(mergeReports(live, null).generated_by, 'browser');
});

// ── 8. 真实档冒烟（读仓库 data/，不写死数字——CI 数据更新不红）──────────
test('真实档冒烟：四源真实 JSON → 盘后报告契约通过 + 搬运断言', { skip: !existsSync(new URL('../data/paper/dual_track_latest.json', import.meta.url)) }, () => {
  const read = (p) => JSON.parse(readFileSync(new URL(`../data/${p}`, import.meta.url), 'utf8'));
  const input = buildInput({
    dualTrack: read('paper/dual_track_latest.json'),
    dualTrackDays: read('paper/dual_track.json').days,
    signals: read('signals-latest.json'),
    global: read('global.json'),
    backtest: read('backtest.json'),
    opsAlerts: read('ops-alerts-latest.json'),
  });
  const r = generatePostMarket(input, { generatedAt: GEN_AT });
  mustPass(r, 'real-data post_market');
  // 搬运断言：报告值 === 源档值（唯一事实源纪律，不写死具体数字）
  assert.equal(r.payload.pnl_daily, input.dualTrack.day.dayReturns.A);
  assert.equal(r.payload.pnl_cumulative, input.dualTrack.summary.trackA.total);
  assert.equal(r.payload.close_drawdown, input.dualTrack.summary.trackA.maxDd);
  assert.equal(typeof r.date, 'string');
  const weekly = generateWeekly(input, { generatedAt: GEN_AT, weekStart: input.tradeDate });
  mustPass(weekly, 'real-data weekly(单日)');
  assert.equal(weekly.payload.nav_series.length, 1);
});

// ═══════════ S1.5：模拟选股层（决议 7/8）═══════════════════════════════

// ── 9. mapPhase 五期映射（决议 7；2026-10-06 拍板：phase 英文枚举 + phase_label 中文）──
test('mapPhase：recover 细分 / 直映射 / shift·unknown 外透不硬塞 + 四字段自洽', () => {
  // recover 细分（阈值 STARTUP_PCT_RANK_MAX=30：指令"<50"与示例"44.1=发酵"矛盾，按已拍板 v1.1 判据，常量一行可改）
  assert.deepEqual(mapPhase('recover', { pct_rank: 25, dir: 'up' }), { phase: 'startup', phase_label: '启动期', regime_raw: 'recover' });
  assert.deepEqual(mapPhase('recover', { pct_rank: 44.1, dir: 'up' }), { phase: 'fermentation', phase_label: '发酵期', regime_raw: 'recover' }, '09-30 实况：44.1·up → 发酵期（与设计示例一致）');
  assert.deepEqual(mapPhase('recover', { pct_rank: 75, dir: 'up' }), { phase: 'fermentation', phase_label: '发酵期', regime_raw: 'recover' });
  assert.deepEqual(mapPhase('recover', { pct_rank: 20, dir: 'down' }), { phase: 'fermentation', phase_label: '发酵期', regime_raw: 'recover' }, '方向非 up → 发酵');
  // 直映射（英文枚举键 + 中文标签）
  assert.deepEqual(mapPhase('climax'), { phase: 'climax', phase_label: '高潮期', regime_raw: 'climax' });
  assert.deepEqual(mapPhase('ebb'), { phase: 'decline', phase_label: '退潮期', regime_raw: 'ebb' });
  assert.deepEqual(mapPhase('ice'), { phase: 'freezing', phase_label: '冰点期', regime_raw: 'ice' });
  // 外透不硬塞（phase=原 key、phase_label=null：无五期标签可给，追溯链保留）
  assert.deepEqual(mapPhase('shift'), { phase: 'shift', phase_label: null, regime_raw: 'shift' });
  assert.deepEqual(mapPhase('unknown'), { phase: 'unknown', phase_label: null, regime_raw: 'unknown' });
  assert.deepEqual(mapPhase(null), { phase: 'unknown', phase_label: null, regime_raw: 'unknown' });
  // 四字段一致性不变式：phase∈PHASE_ENUM ⇔ phase_label===PHASE_LABELS[phase]；regime_raw 恒为入参原值
  for (const rg of ['recover', 'climax', 'ebb', 'ice', 'shift', 'unknown', null, 'whatever']) {
    for (const sub of [{ pct_rank: 25, dir: 'up' }, { pct_rank: 44.1, dir: 'up' }, {}, null]) {
      const { phase, phase_label, regime_raw } = mapPhase(rg, sub);
      const inEnum = Object.values(PHASE_LABELS).includes(phase) || Object.keys(PHASE_LABELS).includes(phase);
      if (phase in PHASE_LABELS) assert.equal(phase_label, PHASE_LABELS[phase], `映射内 ${phase} 标签必须同步`);
      else assert.equal(phase_label, null, `映射外 ${phase} 标签必须为 null`);
      assert.equal(regime_raw, rg ?? 'unknown', 'regime_raw 恒等于入参原值（翻译层不丢信息）');
      assert.ok(inEnum || phase === regime_raw, 'phase 要么是五期枚举要么等于透出的原 key');
    }
  }
});

// ── 10. buildScripts 三剧本模板 ───────────────────────────────────────
test('buildScripts：A/B/C 齐全，阈值全部来自常量，B 条件位止损为 null 不造数', () => {
  const cap = 0.5;
  const scripts = buildScripts({ code: '600825' }, { regimeCap: cap });
  assert.equal(scripts.length, 3);
  const [a, b, c] = scripts;
  assert.deepEqual(scripts.map((s) => s.name), ['A', 'B', 'C']);
  for (const s of scripts) {
    assert.equal(s.script_source, 'template', '模板产物恒标 template（非信号）');
    assert.ok(s.trigger_condition.length > 0 && s.invalid_condition.length > 0);
  }
  assert.equal(a.position_ratio, cap, 'A 仓位 = regime cap');
  assert.equal(a.stop_loss, SIM_SCRIPT_CONSTS.hard_stop_loss, 'A 止损 = HARD_STOP_LOSS(-0.08) 系统常量');
  assert.equal(a.take_profit, 0.16, 'A 止盈 = 2×|止损|');
  assert.equal(b.position_ratio, cap * SIM_SCRIPT_CONSTS.b_position_factor, 'B = cap×0.5 半仓试探');
  assert.equal(b.stop_loss, null, 'B 止损为破5日线条件位 → null 不造数');
  assert.equal(b.take_profit, null, 'B 止盈指令未给数值 → null');
  assert.equal(c.position_ratio, cap * SIM_SCRIPT_CONSTS.c_position_factor, 'C = cap×0.2 轻仓');
  assert.equal(c.stop_loss, SIM_SCRIPT_CONSTS.script_c_stop_loss, 'C 止损 -5%（指令指定的模板参数）');
});

// ── 11. buildCandidatePool 候选池（决议 8）────────────────────────────
test('buildCandidatePool：连板降序 5-10 只、selection_reason 必填、基本面 null 占位', () => {
  const signals = {
    pain: {
      advance: {
        failRate: 0.4,
        detail: [
          { code: '600825', lb: 6, chg: 9.99, kept: true },
          { code: '000678', lb: 3, chg: 9.98, kept: true },
          { code: '603949', lb: 4, chg: -9.98, kept: false },
          { code: '002912', lb: 2, chg: -8.65, kept: false },
          { code: '600032', lb: 2, chg: -5.75, kept: false },
        ],
      },
    },
    seats: { verdict: { label: '游资/其他主导' } },
  };
  const nameMap = { '600825': { name: '新华传媒', appearances: 8 }, '000678': { name: '襄阳轴承', appearances: 5 } };
  const pool = buildCandidatePool(signals, { nameMap, regimeCap: 0.5 });
  assert.ok(pool.length >= SIM_SCRIPT_CONSTS.pool_min || pool.length === signals.pain.advance.detail.length, '5-10 只（源不足时如实给实际数）');
  assert.deepEqual(pool.map((p) => p.code), ['600825', '603949', '000678', '002912', '600032'], '按连板数降序');
  for (const p of pool) {
    assert.ok(typeof p.selection_reason === 'string' && p.selection_reason.length > 0, 'selection_reason 必填');
    assert.deepEqual(Object.keys(p.fundamentals), Object.keys(emptyFundamentals()), '基本面八字段键常驻');
    for (const v of Object.values(p.fundamentals)) assert.equal(v, null, '基本面字段全 null 占位');
    assert.equal(p.themes, null, '题材标签无数据源 → null');
    assert.ok(p.scripts.length === 3);
    assert.ok(p.risks.length > 0, '风险提示必带（系统可验证项）');
  }
  assert.equal(pool[0].name, '新华传媒', 'nameMap 注入名称');
  assert.match(pool[0].selection_reason, /6 连板/);
  assert.match(pool[0].selection_reason, /晋级成功/);
  assert.match(pool[1].selection_reason, /晋级失败/, '失败也如实进理由（复盘归因用）');
  assert.match(pool[0].fund_flow_note, /游资/, '席位级真实数据作旁注');
  // 空源 → 空池（不造数）
  assert.deepEqual(buildCandidatePool({ pain: {} }), []);
});

// ── 12. buildSimulationStock 组装 + 注入信封后契约 ─────────────────────
test('buildSimulationStock：09-30 夹具 → 发酵期/neutral/候选池齐 + 信封契约通过', () => {
  const input = mkInput();
  const sim = buildSimulationStock(input, {});
  assert.equal(sim.sentiment_cycle.phase, 'fermentation', 'recover 44.1 up → 发酵期（英文枚举，契约稳定键）');
  assert.equal(sim.sentiment_cycle.phase_label, '发酵期', '中文标签由 phase_label 承载');
  assert.equal(sim.sentiment_cycle.regime_raw, 'recover', '七态原始值保留（决议 7 追溯链）');
  assert.match(sim.sentiment_cycle.phase_source, /recover/, 'phase_source 记映射依据');
  assert.equal(sim.sentiment_cycle.limit_up_count, 52);
  assert.equal(sim.sentiment_cycle.highest_chain, 6);
  assert.equal(sim.position_suggestion, 'neutral', 'cap 0.5 → neutral');
  assert.equal(sim.candidate_pool.length, 2, '夹具 advance.detail 2 只');
  assert.equal(sim.simulation_positions, null, '归档轨无账本 → null');
  assert.equal(sim.review, null, '复盘 S3 录入前 → null 不造数');
  const r = generatePostMarket(input, { generatedAt: GEN_AT, simulationStock: sim });
  mustPass(r, 'post_market + simulation_stock');
  assert.equal(r.payload.simulation_stock.sentiment_cycle.phase, 'fermentation');
  assert.equal(r.payload.simulation_stock.sentiment_cycle.phase_label, '发酵期');
  // 未注入 → null（信封字段仍必须在场）
  const bare = generateIntraday(mkInput(), { generatedAt: GEN_AT });
  assert.equal(bare.payload.simulation_stock, null);
  mustPass(bare, 'intraday 无 sim 段');
});

// ── 12b. 绑定联查（写入由 S3 UI 触发，本模块只读注入；script_name 填持仓跟踪）──
test('buildSimulationStock 绑定联查：bindings 注入填 script_name，缺席/不匹配 → null', () => {
  const acctWithPos = { ...ACCT, positions: { '600825': { code: '600825', name: '新华传媒', avgCost: 10, last: 10.5, qty: 500, days: 2 } } };
  const input = mkInput({ paperAccount: acctWithPos });
  const bindings = [
    makeBinding({ date: '2026-09-30', code: '600825', script_name: 'A' }),
    makeBinding({ date: '2026-09-29', code: '600825', script_name: 'B' }), // 非当日 → 不匹配
  ];
  const sim = buildSimulationStock(input, { bindings });
  assert.equal(sim.simulation_positions.length, 1);
  const pos = sim.simulation_positions[0];
  assert.equal(pos.code, '600825');
  assert.equal(pos.name, '新华传媒');
  assert.ok(Math.abs(pos.unrealized_pnl - 250) < 1e-9, '(10.5-10)×500=250');
  assert.equal(pos.script_name, 'A', '当日 code 匹配的绑定填入 script_name');
  assert.equal(pos.stop_loss_triggered, null, '触发回放 S3 接线前 null 不造数');
  // 无绑定注入 → null；绑定日期不匹配 → null
  assert.equal(buildSimulationStock(input, {}).simulation_positions[0].script_name, null);
  assert.equal(buildSimulationStock(input, { bindings: [makeBinding({ date: '2026-09-28', code: '600825', script_name: 'C' })] }).simulation_positions[0].script_name, null);
  const r = generatePostMarket(input, { generatedAt: GEN_AT, simulationStock: sim });
  mustPass(r, 'post_market + sim(绑定联查)');
  assert.equal(r.payload.simulation_stock.simulation_positions[0].script_name, 'A');
});

// ── 13. 绑定记录（决议 6：人工输入 + 系统记录，独立 key）───────────────
test('绑定记录：makeBinding 三要素 / mergeBindings 幂等 / storage 注入读写 / 导出合并', () => {
  const b1 = makeBinding({ date: '2026-09-30', code: '600825', script_name: 'A', boundAt: GEN_AT });
  assert.equal(b1.code, '600825');
  assert.throws(() => makeBinding({ date: '2026-09-30', code: '600825' }), /三要素/, '缺 script_name 必须红');
  const list = mergeBindings(null, b1);
  assert.equal(list.length, 1);
  const dup = mergeBindings(list, makeBinding({ date: '2026-09-30', code: '600825', script_name: 'A' }));
  assert.equal(dup.length, 1, '同 date+code+script 幂等不重复');
  const list2 = mergeBindings(dup, makeBinding({ date: '2026-09-30', code: '600825', script_name: 'B' }));
  assert.equal(list2.length, 2);
  // storage 注入（模拟 localStorage）
  const store = new Map();
  const storageLike = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  saveBindings(storageLike, list2);
  assert.ok(store.has(BINDINGS_KEY), `独立 key ${BINDINGS_KEY}（不动现有账本 key）`);
  assert.deepEqual(loadBindings(storageLike), list2);
  storageLike.setItem(BINDINGS_KEY, '{bad json');
  assert.deepEqual(loadBindings(storageLike), [], '坏 JSON → 空表不 throw');
  // 导出复用 exportAccount（账户 + 绑定合并一份）
  const exported = JSON.parse(exportSimulation(ACCT, list2));
  assert.ok(exported.account && exported.account.version, 'account 段来自 exportAccount');
  assert.equal(exported.bindings.length, 2);
  assert.ok(exported.exported_at);
});

// ── 14. 真实档模拟选股冒烟（09-30 真实连板池）─────────────────────────
test('真实档冒烟：buildSimulationStock 过契约 + 真实断言（不写死池内容）', { skip: !existsSync(new URL('../data/paper/dual_track_latest.json', import.meta.url)) }, () => {
  const read = (p) => JSON.parse(readFileSync(new URL(`../data/${p}`, import.meta.url), 'utf8'));
  const input = buildInput({
    dualTrack: read('paper/dual_track_latest.json'),
    signals: read('signals-latest.json'),
    global: read('global.json'),
    opsAlerts: read('ops-alerts-latest.json'),
  });
  const nameMap = read('paper_universe.json').symbols;
  const sim = buildSimulationStock(input, { nameMap });
  const r = generatePostMarket(input, { generatedAt: GEN_AT, simulationStock: sim });
  mustPass(r, 'real sim post_market');
  const sc = sim.sentiment_cycle;
  assert.equal(sc.regime_raw, input.dualTrack.day.regime.key, 'regime_raw 搬运七态原值');
  assert.equal(sc.limit_up_count, read('signals-latest.json').latest.zt_count, '涨停数搬运');
  assert.ok(sim.candidate_pool.length >= 1 && sim.candidate_pool.length <= SIM_SCRIPT_CONSTS.pool_max);
  for (const p of sim.candidate_pool) {
    assert.match(p.selection_reason, /连板/, '入选理由必含连板事实');
    if (nameMap[p.code]?.name) assert.equal(p.name, nameMap[p.code].name, '名称来自 paper_universe 映射');
  }
});
