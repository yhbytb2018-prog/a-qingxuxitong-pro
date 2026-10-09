// 席位/资金属性逐日累积测试（#1）
//
// 重点同样是语义纪律（而非算术）：
//   ① 缺卖侧时净额必须 null，不能"只减一半"得出假净额；
//   ② 无席位数据的天整行 null，不得填 0（0 会被读成"多空抵消"）；
//   ③ 序列默认滤掉空行（体积 + 可读性），但 totalDays 仍要能表达真实覆盖率。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEAT_CLASSES, SEAT_CLASS_LABEL,
  seatRowOf, buildSeatSeries, seatSeriesSummary, seatVerdict,
} from '../src/seats_daily.js';

// 造一天带 seats 的存档
const dayWith = (date, s) => ({ trade_date: date, summary: { seats: s } });
const FULL = {
  inst_buy: 30.72, inst_sell: 24, north_buy: 31.39, north_sell: 29.64,
  hot_buy: 77.56, hot_sell: 69.13, cover: 100, universe_n: 66, buy_top3_pct: 44.5,
};

test('seatRowOf：净额 = 买 − 卖，三类各一', () => {
  const r = seatRowOf(dayWith('2026-09-30', FULL));
  assert.equal(r.ok, true);
  assert.equal(r.instNet, 6.72);
  assert.equal(r.northNet, 1.75);
  assert.equal(r.hotNet, 8.43);
  assert.equal(r.hasSell, true);
});

test('★ seatRowOf：缺卖侧时净额必须 null（不得只减一半得出假净额）', () => {
  // 旧 v1 明细只有买方：此时 inst_sell 等为 undefined，净额不可算
  const r = seatRowOf(dayWith('x', { inst_buy: 10, north_buy: 5, hot_buy: 3, cover: 50 }));
  assert.equal(r.ok, true);
  assert.equal(r.hasSell, false);
  assert.equal(r.instNet, null, '缺卖侧 → 净额 null，不能是 10');
  assert.equal(r.northNet, null);
  assert.equal(r.hotNet, null);
  assert.equal(r.instBuy, 10, '买侧仍应保留（可读）');
  assert.match(r.note, /仅买方/);
});

test('★ seatRowOf：无 seats 的天整行 null 且 ok=false（不得填 0）', () => {
  const r = seatRowOf({ trade_date: '2026-01-05', summary: {} });
  assert.equal(r.ok, false);
  assert.equal(r.date, '2026-01-05');
  // 三项净额必须 null。若填 0，会被读成"三类资金多空抵消"，与"没数据"相反。
  assert.equal(r.instNet, null);
  assert.equal(r.northNet, null);
  assert.equal(r.hotNet, null);
  assert.equal(r.dominant, null);
  assert.ok(r.note);
});

test('seatRowOf：null 输入的净额不得被算成 0（+null 陷阱）', () => {
  const r = seatRowOf(dayWith('x', { inst_buy: null, inst_sell: null, north_buy: null, north_sell: null, hot_buy: null, hot_sell: null, cover: 100 }));
  assert.equal(r.instNet, null);
  assert.equal(r.northNet, null);
  assert.equal(r.hotNet, null);
});

test('seatRowOf：dominant = 三类净额中最大者；全≤0 时为 null', () => {
  const a = seatRowOf(dayWith('x', { inst_buy: 1, inst_sell: 0, north_buy: 5, north_sell: 0, hot_buy: 2, hot_sell: 0, cover: 100 }));
  assert.equal(a.dominant, 'north');
  // 三类都净卖出 → 没有"主导买方"
  const b = seatRowOf(dayWith('y', { inst_buy: 0, inst_sell: 5, north_buy: 1, north_sell: 9, hot_buy: 2, hot_sell: 8, cover: 100 }));
  assert.equal(b.dominant, null);
});

// ────────────────────────── 序列 ──────────────────────────

test('buildSeatSeries：默认只保留有数据的天（空行既无信息又占体积）', () => {
  const days = [
    { trade_date: 'd1', summary: {} },
    dayWith('d2', FULL),
    { trade_date: 'd3', summary: {} },
    dayWith('d4', { ...FULL, inst_buy: 1, inst_sell: 0 }),
  ];
  const s = buildSeatSeries(days);
  assert.equal(s.length, 2, '241 行里 238 行 null 会把轻量档从 14KB 撑到 74KB');
  assert.deepEqual(s.map((r) => r.date), ['d2', 'd4']);
});

test('buildSeatSeries：传 alignDates 时按完整日期轴对齐（含空行）', () => {
  const days = [{ trade_date: 'd1', summary: {} }, dayWith('d2', FULL)];
  const s = buildSeatSeries(days, { alignDates: ['d1', 'd2', 'd3'] });
  assert.equal(s.length, 3);
  assert.equal(s[0].ok, false);
  assert.equal(s[1].ok, true);
  assert.equal(s[2].ok, false);
  assert.equal(s[2].date, 'd3');
});

test('buildSeatSeries：对同一输入幂等（每天 append 与整档重建共用）', () => {
  const days = [dayWith('d1', FULL), dayWith('d2', FULL)];
  assert.deepEqual(buildSeatSeries(days), buildSeatSeries(days));
});

// ────────────────────────── 汇总 ──────────────────────────

test('★ seatSeriesSummary：覆盖率分母用 totalDays（否则会虚报成 100%）', () => {
  const series = buildSeatSeries([dayWith('d1', FULL), dayWith('d2', FULL)]);
  // 不给 totalDays → 覆盖率 null（"未知"），不得默认 1.0
  const noTotal = seatSeriesSummary(series);
  assert.equal(noTotal.coverage, null, '没有分母时应为"未知"，不能假装 100%');
  // 给 totalDays=241 → 2/241
  const withTotal = seatSeriesSummary(series, { totalDays: 241 });
  assert.equal(withTotal.coverage, Math.round(2 / 241 * 100) / 100);
  assert.equal(withTotal.totalDays, 241);
});

test('seatSeriesSummary：空样本时各项为 null 而非 0', () => {
  const sm = seatSeriesSummary([], { totalDays: 241 });
  assert.equal(sm.okRows, 0);
  assert.equal(sm.instNet.n, 0);
  assert.equal(sm.instNet.mean, null);
  assert.equal(sm.instNet.sum, null);
  assert.equal(sm.coverage, 0);
});

test('seatSeriesSummary：均值/求和/末值，且窗口切片生效', () => {
  const series = buildSeatSeries([
    dayWith('d1', { inst_buy: 10, inst_sell: 0, north_buy: 0, north_sell: 0, hot_buy: 0, hot_sell: 0, cover: 100 }),
    dayWith('d2', { inst_buy: 20, inst_sell: 0, north_buy: 0, north_sell: 0, hot_buy: 0, hot_sell: 0, cover: 100 }),
    dayWith('d3', { inst_buy: 30, inst_sell: 0, north_buy: 0, north_sell: 0, hot_buy: 0, hot_sell: 0, cover: 100 }),
  ]);
  const all = seatSeriesSummary(series);
  assert.equal(all.instNet.sum, 60);
  assert.equal(all.instNet.mean, 20);
  assert.equal(all.instNet.last, 30);
  const win = seatSeriesSummary(series, { window: 2 });
  assert.equal(win.instNet.sum, 50);
  assert.equal(win.instNet.mean, 25);
});

test('seatSeriesSummary：主导方按天计数', () => {
  const series = buildSeatSeries([
    dayWith('d1', { inst_buy: 9, inst_sell: 0, north_buy: 1, north_sell: 0, hot_buy: 1, hot_sell: 0, cover: 100 }),
    dayWith('d2', { inst_buy: 1, inst_sell: 0, north_buy: 1, north_sell: 0, hot_buy: 9, hot_sell: 0, cover: 100 }),
  ]);
  const sm = seatSeriesSummary(series);
  assert.equal(sm.dominant.inst, 1);
  assert.equal(sm.dominant.hot, 1);
  assert.equal(sm.dominant.north, 0);
});

// ────────────────────────── 结论 ──────────────────────────

test('seatVerdict：机构净买最大 → 机构主导（趋势属性）', () => {
  const series = buildSeatSeries([dayWith('d1', { inst_buy: 50, inst_sell: 0, north_buy: 1, north_sell: 0, hot_buy: 2, hot_sell: 0, cover: 100 })]);
  const v = seatVerdict(series);
  assert.equal(v.level, 'inst');
  assert.match(v.reason, /机构/);
  assert.match(v.reason, /趋势/);
});

test('seatVerdict：游资净买最大 → 游资主导（情绪属性）', () => {
  const series = buildSeatSeries([dayWith('d1', { inst_buy: 1, inst_sell: 0, north_buy: 1, north_sell: 0, hot_buy: 50, hot_sell: 0, cover: 100 })]);
  const v = seatVerdict(series);
  assert.equal(v.level, 'hot');
  assert.match(v.reason, /游资/);
  assert.match(v.reason, /情绪/);
});

test('seatVerdict：无数据 → unknown（不得默认成某一类）', () => {
  assert.equal(seatVerdict([]).level, 'unknown');
  assert.equal(seatVerdict(buildSeatSeries([{ trade_date: 'd', summary: {} }])).level, 'unknown');
});

test('seatVerdict：三类均净卖出 → "无主导买方"而非硬选一个', () => {
  const series = buildSeatSeries([dayWith('d1', { inst_buy: 0, inst_sell: 5, north_buy: 0, north_sell: 5, hot_buy: 0, hot_sell: 5, cover: 100 })]);
  const v = seatVerdict(series);
  assert.equal(v.level, 'unknown');
  assert.match(v.label, /无主导/);
});

test('常量：三类标签齐备且与 sources.classifySeat 的键一致', () => {
  assert.deepEqual(SEAT_CLASSES, ['inst', 'north', 'hot']);
  for (const k of SEAT_CLASSES) assert.ok(SEAT_CLASS_LABEL[k], k + ' 缺标签');
});

// ────────────────────────── 真实档案端到端 ──────────────────────────

test('真实档案：席位序列与档案一致，且覆盖率如实偏低', async () => {
  const { readFileSync } = await import('node:fs');
  const a = JSON.parse(readFileSync('data/archive.json', 'utf8'));
  const series = buildSeatSeries(a.all_days);
  const sm = seatSeriesSummary(series, { totalDays: a.all_days.length });
  // 席位明细接口只保留最近数日 → 覆盖率必然远低于 1。若这里是 1，
  // 说明有人把"无数据的天"也塞进了序列（就失去了"数据稀缺"这个事实）。
  assert.ok(sm.okRows > 0, '至少应有最近几天的席位数据');
  assert.ok(sm.okRows < a.all_days.length, '席位数据不应覆盖全档');
  assert.ok(sm.coverage < 0.5, `覆盖率应显著偏低，实际 ${sm.coverage}`);
  // 每行都必须带 date，且 ok 行为 true
  for (const r of series) { assert.ok(r.date); assert.equal(r.ok, true); }
});

test('真实档案：确定性（同档两次构建深等）', async () => {
  const { readFileSync } = await import('node:fs');
  const a = JSON.parse(readFileSync('data/archive.json', 'utf8'));
  assert.deepEqual(buildSeatSeries(a.all_days), buildSeatSeries(a.all_days));
});
