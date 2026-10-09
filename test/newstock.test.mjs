// 新股扰动自动剔除 —— 回归测试
//
// 修复的缺陷（用户报告）：s_net 因子未自动剔除新股扰动，新股大额买入会虚增情绪得分，
// 且旧实现只有人工告警、引擎不修正打分。
//
// 实测依据（2026-09-30，本文件所有数字都可用 data/archive.json 复现）：
//   当日榜净买 +7.74 亿里，力勤资源(001246,「无价格涨跌幅限制的证券」) 一只贡献 +5.04 亿（65%）；
//   s_net = tanh(7.74/5)*50+50 = 95.7（近满分）→ 剔除后 tanh(2.70/5)*50+50 = 74.6；
//   情绪分 68.6 → 64.4（−4.20），并跨过 65 分满仓档位线。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isNewStock, splitNewStockNet, newStockSplitOfDay, isNewStockDisturbed,
  NEW_STOCK_DISTURB_RATIO, RANGE_BOARD_RE, aggregateByCode,
} from '../src/lhb.js';
import { computeSentiment } from '../src/sentiment.js';
import { recalcAll } from '../src/pipeline.js';

// 与 sentiment.js 内部完全一致的 s_net 公式（用于独立复算，避免自证）
const sNetOf = (nb) => Math.tanh(nb / 5) * 50 + 50;

// ── ① 新股判定 ────────────────────────────────────────────────────────────
test('新股判定：诱因含「无价格涨跌幅限制」即命中', () => {
  assert.equal(isNewStock({ reason: '无价格涨跌幅限制的证券' }), true);
  assert.equal(isNewStock({ reason: '日涨幅偏离值达7%' }), false);
  assert.equal(isNewStock({}), false);
  assert.equal(isNewStock(null), false);
});

test('新股判定：看 reasons 全部上榜原因，不只看代表那条', () => {
  // 同票可因多个原因上榜；代表条是普通原因，但另一条是新股 → 仍应判为新股
  assert.equal(isNewStock({
    reason: '日涨幅偏离值达7%',
    reasons: ['日涨幅偏离值达7%', '无价格涨跌幅限制的证券'],
  }), true);
  assert.equal(isNewStock({ reason: '日涨幅偏离值达7%', reasons: ['日涨幅偏离值达7%'] }), false);
});

// ── ② 净买分离 ────────────────────────────────────────────────────────────
test('分离：total − new == exNew，且逐票明细可核验', () => {
  const rows = [
    { code: '001246', name: '力勤资源', net_buy_wan: 50412.7, reason: '无价格涨跌幅限制的证券' },
    { code: '600000', name: '普通股A', net_buy_wan: 20000, reason: '日涨幅偏离值达7%' },
    { code: '300001', name: '普通股B', net_buy_wan: 7000, reason: '日换手率达20%' },
  ];
  const r = splitNewStockNet(rows);
  assert.equal(r.total_yi, 7.74);
  assert.equal(r.new_yi, 5.04);
  assert.equal(r.ex_new_yi, 2.7);
  assert.equal(r.new_count, 1);
  assert.equal(r.total_stocks, 3);
  assert.deepEqual(r.new_stocks, [{ code: '001246', name: '力勤资源', net_yi: 5.04 }]);
  // 恒等式：分离前后必须闭合
  assert.ok(Math.abs(r.total_yi - r.new_yi - r.ex_new_yi) <= 0.011);
});

test('分离：占比分母 ≤0 时返回 null（不产生无意义的比率）', () => {
  const r = splitNewStockNet([
    { code: 'A', name: 'A', net_buy_wan: -10000, reason: '日跌幅偏离值达7%' },
    { code: 'B', name: 'B', net_buy_wan: 3000, reason: '无价格涨跌幅限制的证券' },
  ]);
  assert.equal(r.total_yi, -0.7);
  assert.equal(r.ratio, null);
  assert.equal(r.ex_new_yi, -1.0);   // 新股净买为正 → 剔除后更低；如实返回不做截断
});

test('分离：无新股时不改动数值（避免无谓口径波动）', () => {
  const rows = [{ code: 'A', name: 'A', net_buy_wan: 25000, reason: '日涨幅偏离值达7%' }];
  const r = splitNewStockNet(rows);
  assert.equal(r.new_yi, 0);
  assert.equal(r.ex_new_yi, r.total_yi);
  assert.equal(r.new_count, 0);
});

test('分离：空/畸形输入不崩', () => {
  for (const bad of [undefined, null, [], 'x', 0, {}]) {
    const r = splitNewStockNet(bad);
    assert.equal(r.total_yi, 0);
    assert.equal(r.ex_new_yi, 0);
    assert.equal(r.new_count, 0);
  }
});

// ── ③ 熔断线 ──────────────────────────────────────────────────────────────
test('熔断线：严格大于 25% 才算扰动（边界 0.25 不触发）', () => {
  assert.equal(NEW_STOCK_DISTURB_RATIO, 0.25);
  assert.equal(isNewStockDisturbed(0.25), false);
  assert.equal(isNewStockDisturbed(0.2501), true);
  assert.equal(isNewStockDisturbed(0.65), true);
  assert.equal(isNewStockDisturbed(null), false);
  assert.equal(isNewStockDisturbed(undefined), false);
});

// ── ④ computeSentiment 自动剔除 ───────────────────────────────────────────
test('sentiment：传 newStockNet 即自动从 s_net 里剔除（含 9-30 真实数值）', () => {
  const r = computeSentiment({ netBuy: 7.74, newStockNet: 5.04, newStockRatio: 0.65 });
  assert.ok(Math.abs(r.factors.s_net20 - sNetOf(2.7)) < 0.05,
    `s_net 应为 ${sNetOf(2.7).toFixed(1)}，实际 ${r.factors.s_net20}`);
  assert.equal(r.newStock.netRaw, 7.74);
  assert.equal(r.newStock.netExNew, 2.7);
  assert.equal(r.newStock.newStockNet, 5.04);
  assert.equal(r.newStock.adjusted, true);
  assert.equal(r.newStock.disturbed, true);
});

test('sentiment：不传 newStockNet 时行为与旧版完全一致（向后兼容）', () => {
  const a = computeSentiment({ netBuy: 7.74 });
  assert.ok(Math.abs(a.factors.s_net20 - sNetOf(7.74)) < 0.05);
  assert.equal(a.newStock.adjusted, false);
  assert.equal(a.newStock.newStockNet, 0);
});

test('sentiment：剔除后情绪分单调下降，且不超过含新股时的分', () => {
  const withNew = computeSentiment({ netBuy: 7.74 });
  const withoutNew = computeSentiment({ netBuy: 7.74, newStockNet: 5.04 });
  const drop = withNew.score - withoutNew.score;
  assert.ok(drop > 0, '剔除新股后情绪分必须下降');
  assert.ok(Math.abs(drop - 4.2) < 0.15, `9-30 情绪分降幅应约 4.20，实际 ${drop.toFixed(2)}`);
});

test('sentiment：newStockNet 为 0 / 畸形值时等于不剔除', () => {
  const base = computeSentiment({ netBuy: 5 }).factors.s_net20;
  for (const v of [0, null, undefined, NaN, '']) {
    const r = computeSentiment({ netBuy: 5, newStockNet: v });
    assert.ok(Math.abs(r.factors.s_net20 - base) < 0.05, `newStockNet=${String(v)} 不应改变 s_net`);
  }
});

test('sentiment：净买为 null 时不因新股逻辑产生虚假值', () => {
  const r = computeSentiment({ netBuy: null, newStockNet: 3 });
  assert.equal(r.newStock.netRaw, null);
  assert.equal(r.newStock.netExNew, null);
  assert.equal(r.newStock.adjusted, false);
  assert.ok(r.missing.includes('s_net20'));
});

// ── ⑤ caliberFromDay / newStockSplitOfDay ─────────────────────────────────
test('newStockSplitOfDay：明细存在时直接用它，不二次聚合（避开区间榜顶替的坑）', () => {
  const day = {
    lhb_daily_aggr: [
      { code: '001246', name: '力勤资源', net_buy_wan: 50412.7, reason: '无价格涨跌幅限制的证券' },
      { code: '600000', name: '普通股A', net_buy_wan: 27000, reason: '日涨幅偏离值达7%' },
    ],
    lhb_aggr: [{ code: 'X', name: 'X', net_buy_wan: 999999, reason: '连续3个交易日涨跌幅偏离值累计达20%' }],
    lhb: [{ code: 'Y', name: 'Y', net_buy_wan: 888888, reason: '日涨幅偏离值达7%' }],
  };
  const r = newStockSplitOfDay(day);
  assert.equal(r.total_yi, 7.74);
  assert.equal(r.new_yi, 5.04);
  assert.equal(r.ex_new_yi, 2.7);
});

test('newStockSplitOfDay：明细缺失时回退原始记录，仍按当日榜口径现判', () => {
  const day = {
    lhb: [
      { code: '001246', name: '力勤资源', net_buy_wan: 50412.7, reason: '无价格涨跌幅限制的证券' },
      { code: '600000', name: 'A', net_buy_wan: 20000, reason: '日涨幅偏离值达7%' },
      { code: '688137', name: '近岸蛋白', net_buy_wan: 9999999, reason: '连续3个交易日涨跌幅偏离值累计达20%' },
    ],
  };
  const r = newStockSplitOfDay(day);
  // 区间累计榜必须被排除，不能污染总数
  assert.equal(r.total_yi, 7.04);
  assert.equal(r.new_yi, 5.04);
  assert.ok(!Number.isNaN(r.ex_new_yi));
});

test('newStockSplitOfDay：空 day 不崩', () => {
  for (const bad of [{}, null, undefined, { lhb: [] }]) {
    const r = newStockSplitOfDay(bad);
    assert.equal(r.total_yi, 0);
    assert.equal(r.new_yi, 0);
  }
});

// ── ⑥ recalcAll 端到端 ────────────────────────────────────────────────────
test('recalcAll：有新股的日子自动修正 s_net 与情绪分，并留下证据链', () => {
  const days = [{
    trade_date: '2026-09-30',
    summary: {
      lhb_daily_net: 7.74, lhb_daily_amt: 136.5, ind_count: 90, ind_up: 60,
      up_count: 3000, down_count: 2000, zt_count: 80, dt_count: 20, zb_count: 15,
      amount_yi: 18000, net_pos: 30, net_neg: 26,
    },
    lhb_daily_aggr: [
      { code: '001246', name: '力勤资源', net_buy_wan: 50412.7, reason: '无价格涨跌幅限制的证券' },
      { code: '600000', name: 'A', net_buy_wan: 27000, reason: '日涨幅偏离值达7%' },
    ],
    lhb_aggr: [
      { code: '001246', name: '力勤资源', net_buy_wan: 50412.7, reason: '无价格涨跌幅限制的证券', caliber: 'daily' },
      { code: '600000', name: 'A', net_buy_wan: 27000, reason: '日涨幅偏离值达7%', caliber: 'daily' },
    ],
    lhb: [
      { code: '001246', name: '力勤资源', net_buy_wan: 50412.7, reason: '无价格涨跌幅限制的证券' },
      { code: '600000', name: 'A', net_buy_wan: 27000, reason: '日涨幅偏离值达7%' },
    ],
    emotion: { value: 0 },
  }];
  recalcAll(days);
  const e = days[0].emotion;
  assert.equal(e.newStock.adjusted, true);
  assert.equal(e.newStock.disturbed, true);
  assert.equal(e.newStock.netRaw, 7.74);
  assert.equal(e.newStock.newStockNet, 5.04);
  assert.equal(e.newStock.netExNew, 2.7);
  assert.ok(Math.abs(e.s_net - sNetOf(2.7)) < 0.05, `s_net=${e.s_net}`);
  // summary 证据链
  assert.equal(days[0].summary.lhb_new_net, 5.04);
  assert.equal(days[0].summary.lhb_daily_ex_new_net, 2.7);
  assert.equal(days[0].summary.lhb_new_count, 1);
});

test('recalcAll：无新股的日子不被误改（s_net 仍等于含新股净额算出的值）', () => {
  const days = [{
    trade_date: '2026-08-25',
    summary: {
      lhb_daily_net: 22.86, lhb_daily_amt: 200, ind_count: 90, ind_up: 55,
      up_count: 2800, down_count: 2200, zt_count: 60, dt_count: 10, zb_count: 12,
      amount_yi: 17000, net_pos: 25, net_neg: 20,
    },
    lhb_daily_aggr: [{ code: '600000', name: 'A', net_buy_wan: 228600, reason: '日涨幅偏离值达7%' }],
    lhb_aggr: [{ code: '600000', name: 'A', net_buy_wan: 228600, reason: '日涨幅偏离值达7%', caliber: 'daily' }],
    lhb: [{ code: '600000', name: 'A', net_buy_wan: 228600, reason: '日涨幅偏离值达7%' }],
    emotion: { value: 0 },
  }];
  recalcAll(days);
  const e = days[0].emotion;
  assert.equal(e.newStock.adjusted, false);
  assert.equal(e.newStock.newStockNet, 0);
  assert.ok(Math.abs(e.s_net - sNetOf(22.86)) < 0.05, `s_net=${e.s_net}`);
});

test('recalcAll：连续两天（一天有新股一天没有）互不串口径', () => {
  const mk = (date, rows) => ({
    trade_date: date,
    summary: {
      lhb_daily_net: rows.reduce((a, l) => a + l.net_buy_wan, 0) / 1e4, lhb_daily_amt: 150,
      ind_count: 90, ind_up: 55, up_count: 2800, down_count: 2200,
      zt_count: 60, dt_count: 10, zb_count: 12, amount_yi: 17000, net_pos: 25, net_neg: 20,
    },
    lhb_daily_aggr: rows, lhb_aggr: rows.map((l) => ({ ...l, caliber: 'daily' })), lhb: rows,
    emotion: { value: 0 },
  });
  const days = [
    mk('2026-09-29', [
      { code: 'N1', name: '新股1', net_buy_wan: 42000, reason: '无价格涨跌幅限制的证券' },
      { code: 'A', name: 'A', net_buy_wan: 75400, reason: '日涨幅偏离值达7%' },
    ]),
    mk('2026-09-30', [
      { code: 'A', name: 'A', net_buy_wan: 77400, reason: '日涨幅偏离值达7%' },
    ]),
  ];
  recalcAll(days);
  assert.equal(days[0].emotion.newStock.adjusted, true);
  assert.equal(days[0].emotion.newStock.netExNew, 7.54);
  assert.equal(days[1].emotion.newStock.adjusted, false);
  assert.ok(Math.abs(days[1].emotion.s_net - sNetOf(7.74)) < 0.05);
});

// ── ⑦ 确定性 ──────────────────────────────────────────────────────────────
test('确定性：同样输入重复调用结果完全一致（可跨日比较）', () => {
  const rows = [
    { code: '001246', name: '力勤资源', net_buy_wan: 50412.7, reason: '无价格涨跌幅限制的证券' },
    { code: '600000', name: 'A', net_buy_wan: 27000, reason: '日涨幅偏离值达7%' },
  ];
  const a = splitNewStockNet(rows), b = splitNewStockNet(rows);
  assert.deepEqual(a, b);
  const s1 = computeSentiment({ netBuy: 7.74, newStockNet: 5.04 });
  const s2 = computeSentiment({ netBuy: 7.74, newStockNet: 5.04 });
  assert.deepEqual(s1, s2);
});

// ── ⑧ 负向注入：确认守卫真的能抓到回归 ────────────────────────────────────
test('负向注入：只告警不修正（不传 newStockNet）会被守卫的恒等式识破', () => {
  // 模拟旧行为：算了新股净买但没喂给因子
  const r = computeSentiment({ netBuy: 7.74 });          // 忘了传 newStockNet
  const c = splitNewStockNet([
    { code: '001246', net_buy_wan: 50412.7, reason: '无价格涨跌幅限制的证券' },
    { code: '600000', net_buy_wan: 27000, reason: '日涨幅偏离值达7%' },
  ]);
  // 守卫要抓的正是这个矛盾：summary 有新股净买，但 emotion 说没修正
  assert.ok(c.new_yi > 0, '该日确实有新股净买');
  assert.equal(r.newStock.adjusted, false, '未传参数 → 引擎不知道要修正');
  // 这说明「有新股净买 && !adjusted」是可靠的可检信号（audit 脚本据此报警）
});

test('负向注入：把区间累计榜算进当日榜会导致总数虚高（守卫需能识别）', () => {
  const withRange = [
    { code: '001246', net_buy_wan: 50412.7, reason: '无价格涨跌幅限制的证券' },
    { code: '688137', net_buy_wan: 9999999, reason: '连续3个交易日涨跌幅偏离值累计达20%' },
  ];
  const agg = aggregateByCode(withRange);
  const dailyOnly = agg.filter((l) => !/连续\s*[0-9一二三四五六七八九十]+\s*个交易日|严重异常期间/.test(l.reason));
  assert.equal(dailyOnly.length, 1, '区间榜必须被口径过滤掉');
  assert.ok(RANGE_BOARD_RE.test(withRange[1].reason));
});
