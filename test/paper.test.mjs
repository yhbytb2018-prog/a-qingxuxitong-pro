// 模拟交易引擎测试：锁死 A 股真实交易制度的每一条边界。
// 这些用例的价值不在「跑通」，而在「别人改引擎时不会悄悄破坏制度」——
// 例如把最低佣金 5 元去掉、把整手校验放宽、让涨停也能买进。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LOT, MIN_COMMISSION, COMMISSION_RATE, STAMP_TAX_RATE, TRANSFER_FEE_RATE,
  boardOf, isStName, limitPctOf, isLimitHit, fees, fillPrice,
  applyBuy, applySell, emptyAccount, accountStats,
  validateOrder, submitOrder, cancelOrder, settleDay, paperMetrics,
  exportAccount, importAccount, quotesFromDay, REJECT,
  POS_TIERS, CUT_TIERS, qtyByAssetPct, qtyByHoldPct, DEFAULT_SLIP,
} from '../src/paper.js';
import config from '../src/config.js';

const Q = (code, name, price, changePct = 0) => ({ code, name, price, changePct });
const fresh = (cash = 1000000) => emptyAccount(cash, '2026-09-29');

// ────────────────────── 板段与涨跌停幅度（真实制度） ──────────────────────

test('板段判定：各代码段位映射到正确的涨跌停幅度', () => {
  assert.equal(boardOf('600519').board, 'shb');   assert.equal(boardOf('600519').limitPct, 0.10);
  assert.equal(boardOf('601398').board, 'shb');
  assert.equal(boardOf('603259').board, 'shb');
  assert.equal(boardOf('605588').board, 'shb');
  assert.equal(boardOf('000001').board, 'szb');   assert.equal(boardOf('000001').limitPct, 0.10);
  assert.equal(boardOf('002694').board, 'szb');
  assert.equal(boardOf('003816').board, 'szb');
  assert.equal(boardOf('300750').board, 'gem');   assert.equal(boardOf('300750').limitPct, 0.20);
  assert.equal(boardOf('301030').board, 'gem');
  assert.equal(boardOf('688981').board, 'star');  assert.equal(boardOf('688981').limitPct, 0.20);
  assert.equal(boardOf('920779').board, 'bj');    assert.equal(boardOf('920779').limitPct, 0.30);
  assert.equal(boardOf('830799').board, 'bj');
  assert.equal(boardOf('430047').board, 'bj');
});

test('非股票品种明确不可交易，且给出可读原因（不笼统归为「未知」）', () => {
  const cb = boardOf('123285');   // 润禾转02
  assert.equal(cb.tradable, false);
  assert.match(cb.label, /可转债/);
  const fund = boardOf('510300'); // 沪深300ETF
  assert.equal(fund.tradable, false);
  assert.match(fund.label, /基金/);
  const bb = boardOf('900901');   // 沪B
  assert.equal(bb.tradable, false);
  assert.match(bb.label, /B股/);
});

test('ST 风险警示优先于板段：北交所 ST 也是 ±5% 而非 ±30%', () => {
  assert.equal(isStName('*ST顾地'), true);
  assert.equal(isStName('ST豆神'), true);
  assert.equal(isStName('S*ST前锋'), true);
  assert.equal(isStName('万科A'), false);
  assert.equal(isStName('STAR科技'), false);              // 不是 ST 前缀，不能误伤
  assert.equal(limitPctOf('920023', '*ST田野'), 0.05);    // 北交所 + ST → 5%
  assert.equal(limitPctOf('600519', '贵州茅台'), 0.10);
  assert.equal(limitPctOf('300750', '宁德时代'), 0.20);
});

test('涨跌停触板判定容差 0.5pp：真实涨停价按分取整，涨幅常为 9.97~10.03', () => {
  assert.equal(isLimitHit(10.00, '600519', '贵州茅台'), 'up');
  assert.equal(isLimitHit(9.97, '600519', '贵州茅台'), 'up');   // 分位取整
  assert.equal(isLimitHit(10.03, '600519', '贵州茅台'), 'up');
  assert.equal(isLimitHit(9.30, '600519', '贵州茅台'), null);   // 未触板
  assert.equal(isLimitHit(-10.00, '600519', '贵州茅台'), 'down');
  assert.equal(isLimitHit(-19.96, '300750', '宁德时代'), 'down');
  // 容差边界：20% 板下 19.5% 恰好落在容差边缘，按「≥ 幅度−容差」判定为触板。
  // 取值刻意偏保守（宁可认为买不进，也不放过一个真的涨停）——19.4 才是明确未触板。
  assert.equal(isLimitHit(19.5, '300750', '宁德时代'), 'up');
  assert.equal(isLimitHit(19.4, '300750', '宁德时代'), null);
  assert.equal(isLimitHit(4.97, '920023', '*ST田野'), 'up');    // ST ±5%
  assert.equal(isLimitHit(29.9, '920779', '武汉蓝电'), 'up');   // 北交所 ±30%
  assert.equal(isLimitHit(null, '600519', '贵州茅台'), null);
});

// ────────────────────── 费用（真实计价） ──────────────────────

test('佣金：不足 5 元按 5 元收取——小额交易的隐形成本', () => {
  const small = fees(1000, 'buy');                 // 1000 元 × 万三 = 0.3 元 → 收 5 元
  assert.equal(small.comm, 5);
  const big = fees(100000, 'buy');                 // 100000 × 万三 = 30 元
  assert.equal(big.comm, 30);
  assert.equal(fees(200000, 'buy').comm, Math.round(200000 * COMMISSION_RATE * 100) / 100);
});

test('印花税只在卖出侧收取（2023-08-28 起减半至万五）', () => {
  const buy = fees(100000, 'buy');
  const sell = fees(100000, 'sell');
  assert.equal(buy.stamp, 0);
  assert.equal(sell.stamp, Math.round(100000 * STAMP_TAX_RATE * 100) / 100);
  assert.equal(sell.stamp, 50);
});

test('过户费双边收取（万0.1）', () => {
  assert.equal(fees(100000, 'buy').transfer, Math.round(100000 * TRANSFER_FEE_RATE * 100) / 100);
  assert.equal(fees(100000, 'sell').transfer, Math.round(100000 * TRANSFER_FEE_RATE * 100) / 100);
});

test('卖出总费用 = 佣金 + 过户费 + 印花税（恒等式）', () => {
  const f = fees(87654.32, 'sell');
  assert.equal(f.total, Math.round((f.comm + f.transfer + f.stamp) * 100) / 100);
});

test('滑点：买入抬价、卖出压价，且不超过最小价格变动精度', () => {
  assert.ok(fillPrice(10, 'buy') > 10);
  assert.ok(fillPrice(10, 'sell') < 10);
  assert.equal(fillPrice(100, 'buy'), 100.02);   // 万二 = 0.02 元
  assert.equal(fillPrice(100, 'sell'), 99.98);
  assert.equal(fillPrice(0.01, 'sell'), 0.01);   // 不能压到 0 或负数
});

// ────────────────────── 建仓/平仓记账（加权平均成本） ──────────────────────

test('买入成本含费用：加权平均成本 > 成交价（否则「平价卖出」会被误读为不亏）', () => {
  const p0 = { qty: 0, cost: 0, avgCost: 0 };
  const p1 = applyBuy(p0, { qty: 1000, price: 10, fee: 5.3 });
  assert.equal(p1.qty, 1000);
  assert.equal(p1.cost, 10005.3);
  assert.ok(p1.avgCost > 10);
  assert.equal(p1.avgCost, 10.0053);
});

test('两次买入：加权平均成本正确（不是简单平均价）', () => {
  let p = { qty: 0, cost: 0, avgCost: 0 };
  p = applyBuy(p, { qty: 1000, price: 10, fee: 0 });   // 10000
  p = applyBuy(p, { qty: 3000, price: 20, fee: 0 });   // 60000 → 70000 / 4000
  assert.equal(p.qty, 4000);
  assert.equal(p.cost, 70000);
  assert.equal(p.avgCost, 17.5);
});

test('卖出结转已实现盈亏：净收入 − 对应成本（含买入费用分摊）', () => {
  let p = { qty: 0, cost: 0, avgCost: 0 };
  p = applyBuy(p, { qty: 1000, price: 10, fee: 5.3 });        // 成本 10005.3, avg 10.0053
  // 11000 元卖出：佣金 max(5, 3.3)=5（最低收费生效）+ 过户费 0.11 + 印花税 5.5 = 10.61
  const fee = fees(11000, 'sell').total;
  assert.equal(fee, 10.61);
  const s = applySell(p, { qty: 1000, price: 11, fee });
  assert.equal(s.qty, 0);
  assert.equal(s.avgCost, 0);
  // 成本按「持仓总成本」精确结转 = 10005.3（含买入费用；不能再摊第二次，也不能取整到分）
  assert.equal(s.realized, Math.round((11000 - fee - 10005.3) * 100) / 100);
  assert.equal(s.realized, 984.09);
  assert.equal(s.cost, 0, '清仓后成本必须归零，不能留零头');
});

test('部分卖出：剩余成本按比例结转，均价保持不变', () => {
  let p = applyBuy({ qty: 0, cost: 0, avgCost: 0 }, { qty: 2000, price: 10, fee: 0 });
  const s = applySell(p, { qty: 1000, price: 12, fee: 0 });
  assert.equal(s.qty, 1000);
  assert.equal(s.avgCost, 10);     // 均价不变
  assert.equal(s.cost, 10000);     // 剩一半成本
  assert.equal(s.realized, 2000);  // 1000 × (12 − 10)
});

// ────────────────────── 下单校验（唯一判据来源） ──────────────────────

test('买入必须是 100 股整数倍', () => {
  const a = fresh();
  const v = validateOrder(a, { code: '600519', side: 'buy', qty: 150 }, Q('600519', '贵州茅台', 100));
  assert.equal(v.ok, false);
  assert.equal(v.reason, REJECT.LOT);
  assert.equal(validateOrder(a, { code: '600519', side: 'buy', qty: 200 }, Q('600519', '贵州茅台', 100)).ok, true);
});

test('零股卖出仅限一次性清仓（真实制度：余额不足 100 股须一次全卖）', () => {
  let a = fresh();
  const q = Q('600519', '贵州茅台', 100);
  a = submitOrder(a, { code: '600519', side: 'buy', qty: 1000 }, q, { date: '2026-09-28' }).next;
  a = settleDay(a, '2026-09-29', { '600519': q }).account;   // 09-29 成交，当日不可卖
  assert.equal(a.positions['600519'].avail, 0, '成交当日受 T+1 约束');
  a = settleDay(a, '2026-09-30', { '600519': q }).account;   // 次一交易日解冻
  assert.equal(a.positions['600519'].avail, 1000);

  // 卖 50 股（非整手且不是全部持仓）→ 拒绝
  const bad = validateOrder(a, { code: '600519', side: 'sell', qty: 50 }, q);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, REJECT.ODD_SELL);

  // 卖 1050 股（非整手，但…… 超过持仓 → 数量优先报错）
  const over = validateOrder(a, { code: '600519', side: 'sell', qty: 1050 }, q);
  assert.equal(over.ok, false);
  assert.equal(over.reason, REJECT.OVER_AVAIL);

  // 整手卖出正常
  assert.equal(validateOrder(a, { code: '600519', side: 'sell', qty: 1000 }, q).ok, true);
});

test('零股清仓：持仓 1050 股时允许一次性全卖（余额不足 100 股的真实规则）', () => {
  let a = fresh();
  const q = Q('600519', '贵州茅台', 100);
  a = submitOrder(a, { code: '600519', side: 'buy', qty: 1000 }, q, { date: '2026-09-28' }).next;
  a = settleDay(a, '2026-09-29', { '600519': q }).account;
  a = settleDay(a, '2026-09-30', { '600519': q }).account;
  // 手工构造零股余额（真实场景来自送股/配股）
  a = { ...a, positions: { ...a.positions, '600519': { ...a.positions['600519'], qty: 1050, avail: 1050 } } };
  assert.equal(validateOrder(a, { code: '600519', side: 'sell', qty: 1050 }, q).ok, true, '零股可一次性全卖');
  assert.equal(validateOrder(a, { code: '600519', side: 'sell', qty: 1000 }, q).ok, true, '整手也可');
  assert.equal(validateOrder(a, { code: '600519', side: 'sell', qty: 50 }, q).reason, REJECT.ODD_SELL, '单卖零股不允许');
});

test('校验优先级：已有待成交委托 优先于 其它规则（防止误双击重复挂单）', () => {
  let a = fresh(1000000);
  const q = Q('600519', '贵州茅台', 100);
  a = submitOrder(a, { code: '600519', side: 'buy', qty: 100 }, q, { date: '2026-09-29' }).next;
  // 此时再下 150 股（既违规整手、又重复挂单）→ 应报重复挂单
  assert.equal(validateOrder(a, { code: '600519', side: 'buy', qty: 150 }, q).reason, REJECT.PENDING_SAME);
});

test('无行情不下单：缺失就是缺失，绝不用 0 或昨日价顶替', () => {
  const a = fresh();
  assert.equal(validateOrder(a, { code: '600519', side: 'buy', qty: 100 }, null).reason, REJECT.NO_QUOTE);
  assert.equal(validateOrder(a, { code: '600519', side: 'buy', qty: 100 }, { code: '600519', price: null }).reason, REJECT.NO_QUOTE);
  assert.equal(validateOrder(a, { code: '600519', side: 'buy', qty: 100 }, { code: '600519', price: 0 }).reason, REJECT.NO_QUOTE);
});

test('不可交易品种直接拒绝（可转债/基金/B股）', () => {
  const a = fresh();
  assert.equal(validateOrder(a, { code: '123285', side: 'buy', qty: 100 }, Q('123285', '润禾转02', 120)).reason, REJECT.NOT_TRADABLE);
  assert.equal(validateOrder(a, { code: '510300', side: 'buy', qty: 100 }, Q('510300', '沪深300ETF', 4)).reason, REJECT.NOT_TRADABLE);
});

test('资金不足（含费用）拒绝下单，且金额为按今收价预冻结口径', () => {
  const a = fresh(1000);
  const v = validateOrder(a, { code: '600519', side: 'buy', qty: 100 }, Q('600519', '贵州茅台', 10));
  assert.equal(v.ok, false);
  assert.equal(v.reason, REJECT.NO_CASH);
  assert.match(v.detail, /需冻结/);
});

test('下单冻结资金：可用减少、冻结增加，总额不变（守恒）', () => {
  const a = fresh(100000);
  const r = submitOrder(a, { code: '600519', side: 'buy', qty: 100 }, Q('600519', '贵州茅台', 100), { date: '2026-09-29' });
  const before = a.cash + a.freeze;
  const after = r.next.cash + r.next.freeze;
  assert.equal(Math.round(after * 100), Math.round(before * 100));
  assert.ok(r.next.freeze > 0);
  assert.ok(r.next.cash < a.cash);
});

test('撤单释放全部冻结资金（回到下单前状态）', () => {
  const a = fresh(100000);
  const sub = submitOrder(a, { code: '600519', side: 'buy', qty: 100 }, Q('600519', '贵州茅台', 100), { date: '2026-09-29' });
  const c = cancelOrder(sub.next, sub.order.id);
  assert.equal(c.ok, true);
  assert.equal(Math.round(c.next.cash * 100), Math.round(a.cash * 100));
  assert.equal(c.next.freeze, 0);
  assert.equal(c.next.pending.length, 0);
  assert.equal(c.next.orders.find((o) => o.id === sub.order.id).status, 'cancelled');
});

test('同股重复挂单被拒（防止误双击重复下单）', () => {
  let a = fresh(1000000);
  a = submitOrder(a, { code: '600519', side: 'buy', qty: 100 }, Q('600519', '贵州茅台', 100), { date: '2026-09-29' }).next;
  const dup = validateOrder(a, { code: '600519', side: 'buy', qty: 200 }, Q('600519', '贵州茅台', 100));
  assert.equal(dup.ok, false);
  assert.equal(dup.reason, REJECT.PENDING_SAME);
});

// ────────────────────── 撮合（T+1，防前视偏差） ──────────────────────

test('T+1 撮合：下单当日不成交，次日按真实收盘价成交', () => {
  let a = fresh(1000000);
  a = submitOrder(a, { code: '600519', side: 'buy', qty: 100 }, Q('600519', '贵州茅台', 100), { date: '2026-09-29' }).next;
  assert.equal(a.trades.length, 0, '下单当日不应成交——否则是后视镜作弊');
  assert.equal(a.pending.length, 1);

  const r = settleDay(a, '2026-09-30', { '600519': Q('600519', '贵州茅台', 105) });
  assert.equal(r.fills.length, 1);
  // 成交价是「次日真实收盘价 105」加滑点，而不是下单日的 100 —— 这是防前视的核心断言
  assert.equal(r.fills[0].price, fillPrice(105, 'buy'));
  assert.notEqual(r.fills[0].price, fillPrice(100, 'buy'));
  assert.equal(r.account.pending.length, 0);
  assert.equal(r.account.positions['600519'].qty, 100);
});

test('T+1 锁定：当日成交的股份当日不可卖，次一交易日才解冻', () => {
  let a = fresh(1000000);
  const q1 = Q('600519', '贵州茅台', 100);
  a = submitOrder(a, { code: '600519', side: 'buy', qty: 100 }, q1, { date: '2026-09-29' }).next;
  a = settleDay(a, '2026-09-30', { '600519': q1 }).account;

  const pos = a.positions['600519'];
  assert.equal(pos.qty, 100);
  assert.equal(pos.avail, 0, '当日买入 → 当日可卖必须为 0');

  // 当日卖 → 拒绝
  const v = validateOrder(a, { code: '600519', side: 'sell', qty: 100 }, q1);
  assert.equal(v.ok, false);
  assert.equal(v.reason, REJECT.OVER_AVAIL);

  // 次日解冻
  const r = settleDay(a, '2026-10-08', { '600519': Q('600519', '贵州茅台', 102) });
  assert.equal(r.account.positions['600519'].avail, 100);
  assert.equal(validateOrder(r.account, { code: '600519', side: 'sell', qty: 100 }, Q('600519', '贵州茅台', 102)).ok, true);
});

test('涨停买的委托在次日被撤销（真实体验：一字板买不进）', () => {
  let a = fresh(1000000);
  a = submitOrder(a, { code: '600519', side: 'buy', qty: 100 }, Q('600519', '贵州茅台', 100, 0), { date: '2026-09-29' }).next;
  const before = a.cash + a.freeze;
  const r = settleDay(a, '2026-09-30', { '600519': Q('600519', '贵州茅台', 110, 10.0) });
  assert.equal(r.fills.length, 0);
  assert.equal(r.expired.length, 1);
  assert.match(r.expired[0].reason, /涨停/);
  assert.equal(Math.round((r.account.cash + r.account.freeze) * 100), Math.round(before * 100), '冻结必须全额释放');
  assert.equal(r.account.positions['600519'], undefined);
});

test('跌停卖的委托在次日被撤销', () => {
  let a = fresh(1000000);
  const q = Q('600519', '贵州茅台', 100);
  a = submitOrder(a, { code: '600519', side: 'buy', qty: 100 }, q, { date: '2026-09-28' }).next;
  a = settleDay(a, '2026-09-29', { '600519': q }).account;   // 09-29 成交
  a = settleDay(a, '2026-09-30', { '600519': q }).account;   // 09-30 解冻才可挂卖单
  a = submitOrder(a, { code: '600519', side: 'sell', qty: 100 }, q, { date: '2026-09-30' }).next;
  const r = settleDay(a, '2026-10-08', { '600519': Q('600519', '贵州茅台', 90, -10.0) });
  assert.equal(r.fills.length, 0);
  assert.match(r.expired[0].reason, /跌停/);
  assert.equal(r.account.positions['600519'].qty, 100, '持仓不变');
});

test('次日价格跳空过高导致资金不足 → 委托失效而非透支（风控真实性）', () => {
  const a = fresh(1100);
  const sub = submitOrder(a, { code: '600519', side: 'buy', qty: 100 }, Q('600519', '贵州茅台', 10), { date: '2026-09-29' });
  assert.equal(sub.order.status, 'pending');
  // 次日收 20 元 → 需 2005.3 元，远超冻结的 1005.3
  const r = settleDay(sub.next, '2026-09-30', { '600519': Q('600519', '贵州茅台', 20) });
  assert.equal(r.fills.length, 0);
  assert.equal(r.expired[0].reason, REJECT.NO_CASH);
  assert.ok(r.account.cash + r.account.freeze <= 1100 + 1e-9, '绝不能出现负资金/透支');
});

test('次日无该股行情 → 委托失效并释放冻结（不静默丢弃）', () => {
  const a = fresh(100000);
  const sub = submitOrder(a, { code: '600519', side: 'buy', qty: 100 }, Q('600519', '贵州茅台', 100), { date: '2026-09-29' });
  const r = settleDay(sub.next, '2026-09-30', {});
  assert.equal(r.expired.length, 1);
  assert.equal(r.expired[0].reason, REJECT.NO_QUOTE);
  assert.equal(r.account.freeze, 0);
  assert.equal(Math.round(r.account.cash * 100), 10000000);
});

test('持仓票当日取不到行情：沿用上一价并显式标注 pxStale（不假装有行情）', () => {
  let a = fresh(1000000);
  const q = Q('600519', '贵州茅台', 100);
  a = submitOrder(a, { code: '600519', side: 'buy', qty: 100 }, q, { date: '2026-09-29' }).next;
  a = settleDay(a, '2026-09-30', { '600519': q }).account;
  const r = settleDay(a, '2026-10-08', {});   // 这天没有该股行情
  assert.equal(r.account.positions['600519'].pxStale, true);
  assert.equal(r.account.positions['600519'].last, q.price, '保留上一价，不得归零');
  assert.ok(r.missing.includes('600519'));
});

// ────────────────────── 卖出全链路（含费用与税） ──────────────────────

test('完整买卖一轮：现金变动可逐项核对（买入含费、卖出扣费扣税）', () => {
  let a = fresh(1000000);
  const q1 = Q('600519', '贵州茅台', 100);
  a = submitOrder(a, { code: '600519', side: 'buy', qty: 1000 }, q1, { date: '2026-09-28' }).next;
  a = settleDay(a, '2026-09-29', { '600519': q1 }).account;

  const buyPx = fillPrice(100, 'buy');
  const buyGross = Math.round(buyPx * 1000 * 100) / 100;
  const buyFee = fees(buyGross, 'buy').total;
  const cashAfterBuy = Math.round((1000000 - buyGross - buyFee) * 100) / 100;
  assert.equal(Math.round(a.cash * 100), Math.round(cashAfterBuy * 100));
  assert.equal(Math.round(a.totalFee * 100), Math.round(buyFee * 100));

  // 09-30 先解冻（T+1），才能在 09-30 挂卖单、10-08 成交
  a = settleDay(a, '2026-09-30', { '600519': q1 }).account;
  const q2 = Q('600519', '贵州茅台', 110);
  a = submitOrder(a, { code: '600519', side: 'sell', qty: 1000 }, q2, { date: '2026-09-30' }).next;
  const r = settleDay(a, '2026-10-08', { '600519': q2 }).account;

  const sellPx = fillPrice(110, 'sell');
  const sellGross = Math.round(sellPx * 1000 * 100) / 100;
  const sellFee = fees(sellGross, 'sell').total;
  assert.equal(Math.round(r.cash * 100), Math.round((cashAfterBuy + sellGross - sellFee) * 100));
  assert.equal(Math.round(r.totalFee * 100), Math.round((buyFee + sellFee) * 100));
  // 已实现盈亏 = 卖出净额 − 买入总成本
  assert.equal(Math.round(r.realized * 100), Math.round((sellGross - sellFee - buyGross - buyFee) * 100));
  assert.equal(r.positions['600519'], undefined, '清仓后不应留 0 股记录');
});

test('清仓后账户权益 = 现金，且 = 初始 + 已实现（无持仓时无浮动）', () => {
  let a = fresh(1000000);
  const q1 = Q('600519', '贵州茅台', 100);
  a = submitOrder(a, { code: '600519', side: 'buy', qty: 100 }, q1, { date: '2026-09-28' }).next;
  a = settleDay(a, '2026-09-29', { '600519': q1 }).account;    // 成交
  a = settleDay(a, '2026-09-30', { '600519': q1 }).account;    // 解冻
  a = submitOrder(a, { code: '600519', side: 'sell', qty: 100 }, q1, { date: '2026-09-30' }).next;
  a = settleDay(a, '2026-10-08', { '600519': q1 }).account;    // 卖出成交
  const st = accountStats(a);
  assert.equal(st.posCount, 0);
  assert.equal(Math.round(st.total * 100), Math.round(st.cash * 100));
  assert.equal(Math.round(st.realized * 100), Math.round((st.total - 1000000) * 100));
});

// ────────────────────── 净值 / 绩效 ──────────────────────

test('每日净值按日期去重（重复结算同一日不会写两条）', () => {
  let a = fresh(1000000);
  a = settleDay(a, '2026-09-30', { '600519': Q('600519', '贵州茅台', 100) }).account;
  a = settleDay(a, '2026-09-30', { '600519': Q('600519', '贵州茅台', 101) }).account;
  assert.equal(a.nav.length, 1);
  assert.equal(a.nav[0].equity, 1000000);
});

test('绩效指标与 src/backtest.js 同口径（总收益/回撤/夏普形状）', () => {
  const m = paperMetrics([1, 1.1, 0.99, 1.2]);
  assert.equal(m.days, 4);
  assert.equal(Math.round(m.total * 1e6) / 1e6, 0.2);
  assert.ok(m.maxDd > 0);
  assert.ok(Number.isFinite(m.sharpe));
  assert.equal(paperMetrics([]), null);
});

test('空账户：权益=初始资金，收益 0，不出现 NaN', () => {
  const st = accountStats(fresh(500000));
  assert.equal(st.total, 500000);
  assert.equal(st.ret, 0);
  assert.equal(st.floatPnl, 0);
});

// ────────────────────── 导出 / 导入 ──────────────────────

test('导出再导入：账本完全一致（含待成交委托与净值曲线）', () => {
  let a = fresh(300000);
  a = submitOrder(a, { code: '600519', side: 'buy', qty: 100 }, Q('600519', '贵州茅台', 100), { date: '2026-09-29' }).next;
  a = settleDay(a, '2026-09-30', { '600519': Q('600519', '贵州茅台', 100) }).account;
  const r = importAccount(exportAccount(a));
  assert.equal(r.ok, true);
  assert.deepEqual(r.account.positions, a.positions);
  assert.deepEqual(r.account.trades, a.trades);
  assert.deepEqual(r.account.nav, a.nav);
  assert.equal(Math.round(r.account.cash * 100), Math.round(a.cash * 100));
});

test('导入拒绝来路不明的账本（版本不符 / 字段非法）', () => {
  assert.equal(importAccount('not json').ok, false);
  assert.equal(importAccount('{}').ok, false);
  assert.equal(importAccount(JSON.stringify({ version: 'x', cash: 1, initCash: 1 })).ok, false);
  const bad = importAccount(JSON.stringify({ version: 'paper-v1', cash: 100, initCash: 100, positions: { '600519': { qty: 1.5, avail: 1, avgCost: 10 } } }));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /数量非法/);
  // 可卖 > 持仓 → 非法
  const bad2 = importAccount(JSON.stringify({ version: 'paper-v1', cash: 1, initCash: 1, positions: { '600519': { qty: 100, avail: 200, avgCost: 10 } } }));
  assert.equal(bad2.ok, false);
});

// ────────────────────── 行情适配 ──────────────────────

test('quotesFromDay 只收真实收盘价，缺价一律不进表（缺失≠0）', () => {
  const day = {
    hot: [
      { code: '600519', name: '贵州茅台', close: 1500, change_pct: 1.2 },
      { code: '000001', name: '平安银行', close: null, change_pct: 0.5 },   // 无价
      { code: '000002', name: '万科A', change_pct: 0.5 },                    // 缺 close 字段
    ],
    lhb: [{ code: '600519', name: '贵州茅台', close: 1510, change_pct: 1.9 }],
  };
  const q = quotesFromDay(day);
  assert.equal(Object.keys(q).length, 1);
  assert.equal(q['600519'].price, 1510, '龙虎榜价格优先（交易所口径更权威）');
  assert.equal(q['000001'], undefined);
  assert.equal(q['000002'], undefined);
});

test('quotesFromDay 容忍空数据（不抛错、不造数据）', () => {
  assert.deepEqual(quotesFromDay(null), {});
  assert.deepEqual(quotesFromDay({}), {});
});

// ────────────────────── 不变量（随机游走式回归） ──────────────────────

test('不变量：任意时点 现金+冻结+持仓成本 与 初始资金 的差额 = 已实现 + 浮动 − 累计费用', () => {
  let a = fresh(1000000);
  const steps = [
    ['2026-09-28', { '600519': Q('600519', '贵州茅台', 100), '000001': Q('000001', '平安银行', 12) }],
    ['2026-09-29', { '600519': Q('600519', '贵州茅台', 108), '000001': Q('000001', '平安银行', 11.5) }],
    ['2026-09-30', { '600519': Q('600519', '贵州茅台', 96), '000001': Q('000001', '平安银行', 12.8) }],
  ];
  // 第 1 天：下单（不成交）
  a = submitOrder(a, { code: '600519', side: 'buy', qty: 500 }, steps[0][1]['600519'], { date: steps[0][0] }).next;
  a = submitOrder(a, { code: '000001', side: 'buy', qty: 1000 }, steps[0][1]['000001'], { date: steps[0][0] }).next;
  // 第 2 天：成交 + 卖出茅台挂单
  a = settleDay(a, steps[1][0], steps[1][1]).account;
  a = submitOrder(a, { code: '600519', side: 'sell', qty: 200 }, steps[1][1]['600519'], { date: steps[1][0] }).next;
  // 第 3 天：卖出成交
  a = settleDay(a, steps[2][0], steps[2][1]).account;

  const st = accountStats(a);
  // 现金 + 市值 = 权益
  assert.equal(Math.round(st.total * 100), Math.round((st.cash + st.freeze + st.marketValue) * 100));
  // 权益 − 初始 = 已实现 + 浮动
  assert.equal(
    Math.round((st.total - 1000000) * 100),
    Math.round((st.realized + st.floatPnl) * 100),
  );
  // 成交记录与持仓自洽：净买入股数 = 各票持仓股数
  const netBuy = {};
  for (const t of a.trades) netBuy[t.code] = (netBuy[t.code] || 0) + (t.side === 'buy' ? t.qty : -t.qty);
  for (const [code, p] of Object.entries(a.positions)) {
    assert.equal(p.qty, netBuy[code], `${code} 持仓与成交记录不符`);
  }
  for (const [code, n] of Object.entries(netBuy)) {
    if (n === 0) assert.equal(a.positions[code], undefined, `${code} 已清仓不应留仓`);
  }
  // 累计费用 = 各笔成交费用之和
  const feeSum = a.trades.reduce((x, t) => x + t.fee, 0);
  assert.equal(Math.round(st.totalFee * 100), Math.round(feeSum * 100));
});

test('不变量：成交价的委托漂移被如实记录（T+1 的必然结果）', () => {
  let a = fresh(1000000);
  a = submitOrder(a, { code: '600519', side: 'buy', qty: 100 }, Q('600519', '贵州茅台', 100), { date: '2026-09-29' }).next;
  a = settleDay(a, '2026-09-30', { '600519': Q('600519', '贵州茅台', 130) }).account;
  const t = a.trades[0];
  assert.equal(t.submitPrice, 100);
  assert.equal(t.price, fillPrice(130, 'buy'));
  assert.ok(t.driftPct > 29, '应记录约 +30% 的价格漂移，让用户看到隔夜风险');
});

test('回归：待成交委托在成交后必须从队列移除，否则会天天重复成交', () => {
  let a = fresh(1000000);
  const q = Q('600519', '贵州茅台', 100);
  a = submitOrder(a, { code: '600519', side: 'buy', qty: 1000 }, q, { date: '2026-09-28' }).next;
  const r1 = settleDay(a, '2026-09-29', { '600519': q });
  assert.equal(r1.fills.length, 1);
  assert.equal(r1.account.pending.length, 0, '成交后必须出队');
  // 再连续结算 3 天：绝不能再出现成交
  let cur = r1.account;
  for (const d of ['2026-09-30', '2026-10-08', '2026-10-09']) {
    const r = settleDay(cur, d, { '600519': q });
    assert.equal(r.fills.length, 0, `${d} 不应重复成交`);
    cur = r.account;
  }
  assert.equal(cur.trades.length, 1, '一张委托只能产生一笔成交');
  assert.equal(cur.positions['600519'].qty, 1000, '持仓不应被重复累加');
});

test('回归：T+1 解冻不能被 lastDate 干扰（连续有行情时也必须按成交日判定）', () => {
  let a = fresh(1000000);
  const q = Q('600519', '贵州茅台', 100);
  a = submitOrder(a, { code: '600519', side: 'buy', qty: 1000 }, q, { date: '2026-09-28' }).next;
  a = settleDay(a, '2026-09-29', { '600519': q }).account;
  assert.equal(a.positions['600519'].avail, 0, '成交当日不可卖');
  // 该票连续 5 天都有真实行情 —— lastDate 会天天等于当天，但解冻只看 lastBuyDate
  let cur = a;
  for (const d of ['2026-09-30', '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13']) {
    cur = settleDay(cur, d, { '600519': q }).account;
    assert.equal(cur.positions['600519'].avail, 1000, `${d} 应保持可卖 1000 股`);
    assert.equal(cur.positions['600519'].lastBuyDate, '2026-09-29', '买入成交日不得被后续行情改写');
  }
});

test('回归：成本结转不得因取整而丢失零头（部分卖出后剩余成本 + 结转成本 = 原总成本）', () => {
  const q0 = applyBuy({ qty: 0, cost: 0, avgCost: 0 }, { qty: 3000, price: 7.77, fee: 7.01 });
  assert.equal(q0.avgCost, 7.772336666666666);        // 天然带除不尽的零头
  const s1 = applySell(q0, { qty: 1000, price: 8.5, fee: 5.5 });
  const carried = Math.round((q0.cost - s1.cost) * 100) / 100;
  assert.ok(Math.abs(s1.cost + carried - q0.cost) <= 0.01, '成本守恒（误差 ≤ 1 分）');
  const s2 = applySell({ ...q0, ...s1 }, { qty: s1.qty, price: 9, fee: 5.5 });
  assert.equal(s2.cost, 0, '清仓后成本必须精确归零');
});

// ────────────────────── 仓位档位（建仓按总资产 / 减仓按持仓） ──────────────────────

test('仓位档位：四档比例定义正确且单调递增', () => {
  const keys = POS_TIERS.map((t) => t.key);
  assert.deepEqual(keys, ['light', 'half', 'heavy', 'full']);
  const pcts = POS_TIERS.map((t) => t.pct);
  assert.deepEqual(pcts, [0.10, 0.50, 0.80, 1.00]);
  for (let i = 1; i < pcts.length; i++) assert.ok(pcts[i] > pcts[i - 1], '档位比例必须单调递增');
});

test('仓位档位：买入股数 = 总资产×比例÷价，且为 100 股整数倍', () => {
  const r = qtyByAssetPct(1000000, 0.5, 10);
  assert.equal(r.qty % LOT, 0, '必须是整手');
  assert.ok(r.need <= 1000000 * 0.5 + 1e-6, '含费用后不得超出档位预算');
  assert.ok(r.qty > 0 && r.qty <= 50000, '应在 5 万股量级且不超过裸算上限');
});

test('仓位档位：满仓按总资产（非可用资金）——已有持仓时不会缩水', () => {
  const st = { total: 1000000, cash: 400000 };
  const r = qtyByAssetPct(st.total, 1.0, 10, { cash: st.cash });
  assert.ok(r.capped, '超出可用资金时必须标记 capped');
  assert.ok(r.need <= st.cash, '实际占用不得超过可用资金');
  assert.equal(r.qty % LOT, 0);
});

test('仓位档位：预算不足一手时返回 0（不产生非法委托）', () => {
  const r = qtyByAssetPct(1000, 0.1, 50);
  assert.equal(r.qty, 0);
  assert.equal(r.need, 0);
});

test('仓位档位：价格非法/资产为 0 时安全返回 0（不抛异常）', () => {
  for (const [t, p] of [[1000000, 0], [1000000, -1], [0, 10], [NaN, 10], [1000000, NaN]]) {
    const r = qtyByAssetPct(t, 0.5, p);
    assert.equal(r.qty, 0, `total=${t} price=${p} 应返回 0`);
  }
});

test('仓位档位：比例越界被夹到 [0,1]（不会因传 1.5 买出超额）', () => {
  const a = qtyByAssetPct(1000000, 1.5, 10);
  const b = qtyByAssetPct(1000000, 1.0, 10);
  assert.equal(a.qty, b.qty, '比例 >1 应等同满仓');
  assert.equal(qtyByAssetPct(1000000, -1, 10).qty, 0, '负比例应为 0');
});

test('减仓档位：分母是该票可卖数量，且不超过可卖数', () => {
  assert.equal(qtyByHoldPct(1000, 0.25), 200);
  assert.equal(qtyByHoldPct(1000, 0.50), 500);
  assert.equal(qtyByHoldPct(1000, 0.75), 700);
  assert.equal(qtyByHoldPct(100, 0.50), 100, '不足 2 手时按全部，避免档位恒为 0');
  assert.equal(qtyByHoldPct(50, 0.25), 50, '零股按全部');
  assert.equal(qtyByHoldPct(0, 0.5), 0);
  assert.equal(qtyByHoldPct(-5, 0.5), 0);
});

test('减仓档位：任意档位结果都不超过可卖数量（不得卖超）', () => {
  for (const avail of [100, 250, 333, 1000, 1500, 99999]) {
    for (const t of CUT_TIERS) {
      const q = qtyByHoldPct(avail, t.pct);
      assert.ok(q <= avail, `avail=${avail} pct=${t.pct} 卖出 ${q} 股卖超了`);
      assert.ok(q >= 0);
    }
  }
});

test('回归：按档位建仓后必定通过资金校验（含费用倒推不得被拒）', () => {
  // 契约：qtyByAssetPct 的价格入参必须是**含滑点的成交价**（fillPrice 的输出），
  // 与 validateOrder 内部使用的价格基线一致——否则会算多股数、在临界点被拒。
  const acct = fresh(1000000);
  for (const raw of [3.33, 10, 47.5, 1258.62, 2000]) {
    const px = fillPrice(raw, 'buy', DEFAULT_SLIP);
    for (const t of POS_TIERS) {
      const r = qtyByAssetPct(1000000, t.pct, px, { cash: acct.cash });
      if (!r.qty) continue;
      const v = validateOrder(acct, { code: '600519', side: 'buy', qty: r.qty, slip: DEFAULT_SLIP },
        { code: '600519', price: raw, name: '测试', changePct: 0 });
      assert.ok(v.ok, `raw=${raw} 档位=${t.key} qty=${r.qty} 被拒：${v.reason}`);
    }
  }
});

test('回归：qtyByAssetPct 传裸价（未含滑点）会算多股数并被资金校验拒绝', () => {
  // 锁住这个陷阱：裸价 3.33 算出的股数 > 含滑点 3.34 算出的股数，前者在满仓时会被资金校验拒掉。
  // 结论：UI 必须把 fillPrice(...) 的输出传给本函数（见上一条用例的契约说明）。
  const acct = fresh(1000000);
  const bare = qtyByAssetPct(1000000, 1.0, 3.33, { cash: acct.cash });
  const slipped = qtyByAssetPct(1000000, 1.0, fillPrice(3.33, 'buy', DEFAULT_SLIP), { cash: acct.cash });
  assert.ok(bare.qty > slipped.qty, '裸价会高估股数（这正是必须传含滑点价的原因）');
  const vBare = validateOrder(acct, { code: '600519', side: 'buy', qty: bare.qty, slip: DEFAULT_SLIP },
    { code: '600519', price: 3.33, name: '测试', changePct: 0 });
  const vSlipped = validateOrder(acct, { code: '600519', side: 'buy', qty: slipped.qty, slip: DEFAULT_SLIP },
    { code: '600519', price: 3.33, name: '测试', changePct: 0 });
  assert.equal(vBare.ok, false, '裸价算出的股数应被资金校验拒绝（滑点成本未计入）');
  assert.equal(vSlipped.ok, true, '含滑点价算出的股数应通过校验');
});

// ────────────────────── T+1 门禁（引擎级防前视，最后防线） ──────────────────────
// 背景：UI 的 settleByLive 曾可在同日撮合当日提交的委托（submitDate 被记成存档日，
// 结算日与提交日撞同一天），非交易日也能用上一收盘价「结算」——两处都击穿
// 「次一交易日按真实价撮合」。引擎不信任调用方：submitDate ≥ 结算日一律顺延。

test('★ T+1 门禁：同日结算不成交——委托顺延留队，次日才撮合', () => {
  let a = fresh();
  a = submitOrder(a, { code: '600519', side: 'buy', qty: 100 }, Q('600519', '贵州茅台', 100), { date: '2026-09-30' }).next;
  // 当天就结算（settleByLive 曾经的作弊路径）：必须顺延，不得成交
  const r0 = settleDay(a, '2026-09-30', { '600519': Q('600519', '贵州茅台', 105) });
  assert.equal(r0.fills.length, 0, '同日撮合 = 用已知价成交，必须拦下');
  assert.equal(r0.t1Hold, 1, '顺延计数如实上报');
  assert.equal(r0.account.pending.length, 1, '顺延 ≠ 失效：委托留在队列');
  assert.equal(r0.account.trades.length, 0);
  // 次一交易日：正常撮合
  const r1 = settleDay(r0.account, '2026-10-08', { '600519': Q('600519', '贵州茅台', 105) });
  assert.equal(r1.fills.length, 1);
  assert.equal(r1.account.pending.length, 0);
  assert.equal(r1.fills[0].price, fillPrice(105, 'buy'), '成交价是次日真实价 + 滑点');
});

test('★ T+1 门禁：结算日早于提交日（倒挂）同样顺延——防倒挂撮合', () => {
  // 场景：假期提交的委托（submitDate=10-02），存档补结算循环若误传更早的日期
  let a = fresh();
  a = submitOrder(a, { code: '600519', side: 'buy', qty: 100 }, Q('600519', '贵州茅台', 100), { date: '2026-10-02' }).next;
  const r = settleDay(a, '2026-09-30', { '600519': Q('600519', '贵州茅台', 100) });
  assert.equal(r.fills.length, 0, '倒挂撮合 = 用提交前的已知价成交，必须拦下');
  assert.equal(r.account.pending.length, 1);
});

test('★ T+1 门禁：旧账本（submitDate=null 的导入单）不误伤——只拦有日期的', () => {
  let a = fresh();
  a = submitOrder(a, { code: '600519', side: 'buy', qty: 100 }, Q('600519', '贵州茅台', 100), { date: '2026-09-30' }).next;
  // 手工构造无 submitDate 的委托（导入档的宽松形态），门禁不得过度拦截
  const legacy = { ...a, pending: a.pending.map((p) => { const { submitDate, ...rest } = p; return rest; }) };
  const r = settleDay(legacy, '2026-09-30', { '600519': Q('600519', '贵州茅台', 105) });
  assert.equal(r.t1Hold, 0, '无日期的旧委托不适用门禁');
});

// ────────────────────── 行情适配：day.quotes 实时覆盖层 ──────────────────────
// 背景：paper_ui 的 batchDay() 把腾讯实时价写进 day.quotes，但 quotesFromDay 此前
// 只读 hot/lhb——实时价注入是死代码：不在当日两榜的票批量买入必被 NO_QUOTE 拦截。

test('★ quotesFromDay：day.quotes 覆盖同名键（实时价优先于存档收盘价）', () => {
  const day = {
    trade_date: '2026-10-08',
    hot: [{ code: '600519', name: '贵州茅台', close: 100, change_pct: 1.0 }],
    quotes: { '600519': { code: '600519', name: '贵州茅台', price: 103.5, changePct: 3.5, prevClose: 100, src: 'live' } },
  };
  const m = quotesFromDay(day);
  assert.equal(m['600519'].price, 103.5, '实时价必须覆盖存档收盘价（死代码修复的核心断言）');
  assert.equal(m['600519'].prevClose, 100, 'prevClose 透传给停板判定');
  assert.equal(m['600519'].src, 'live');
});

test('★ quotesFromDay：day.quotes 补两榜之外的新票；无价条目不进表', () => {
  const day = {
    trade_date: '2026-10-08',
    quotes: {
      '300893': { code: '300893', name: '测试A', price: 51.2, changePct: 2, prevClose: 50.2, src: 'live' },
      '000001': { code: '000001', name: '测试B', price: null },   // 无价 → 不进表
    },
  };
  const m = quotesFromDay(day);
  assert.ok(m['300893'], '两榜之外的票由覆盖层补上（此前必被 NO_QUOTE 误拦）');
  assert.ok(!m['000001'], '无价条目绝不进表（缺失显式化）');
});

test('★ quotesFromDay：纯存档日（无 quotes 字段）行为不变', () => {
  const day = { trade_date: '2026-09-30', hot: [{ code: '600519', name: '贵州茅台', close: 100 }], lhb: [{ code: '000001', name: '平安银行', close: 20 }] };
  const m = quotesFromDay(day);
  assert.equal(m['600519'].price, 100);
  assert.equal(m['000001'].price, 20);
  assert.equal(m['600519'].src, 'hot');
});

// ────────────────────── 精确停板价（isLimitHit 的 prevClose 口径） ──────────────────────
// 背景：近似口径 |change_pct| ≥ 幅度−0.5pp 会把 20cm 板涨 19.5%~19.99% **未封板**的
// 收盘误判涨停（买入委托被错误失效）。实时源天然带昨收 → 按真实停板价判。

test('★ 精确停板价：20cm 板涨 19.9% 未封板 → 不是涨停（近似口径会误杀）', () => {
  // 昨收 50.00 → 停板价 = 60.00；现价 59.95（+19.9%）未封板
  assert.equal(isLimitHit(19.9, '300750', '宁德时代', 0.5, 59.95, 50.0), null, '精确口径：未到停板价');
  // 对照：旧近似口径（无 price/prevClose）会误判 up——这是容差的已知代价，测试锁住差异
  assert.equal(isLimitHit(19.9, '300750', '宁德时代'), 'up', '近似口径确实会误杀（这就是要带昨收的原因）');
});

test('★ 精确停板价：触及停板价判 up/down；10% 板 9.9% 未封板不误杀', () => {
  assert.equal(isLimitHit(20.0, '300750', '宁德时代', 0.5, 60.0, 50.0), 'up', '现价=停板价 60.00');
  assert.equal(isLimitHit(-20.0, '300750', '宁德时代', 0.5, 40.0, 50.0), 'down', '现价=跌停价 40.00');
  // 昨收 10.00 → 停板价 11.00；现价 10.99（+9.9%）未封板
  assert.equal(isLimitHit(9.9, '600519', '贵州茅台', 0.5, 10.99, 10.0), null);
  assert.equal(isLimitHit(10.0, '600519', '贵州茅台', 0.5, 11.0, 10.0), 'up');
  // 四舍五入边界：昨收 9.99 → 停板价 = round(9.99×1.1)=10.99，现价 10.99 判 up
  assert.equal(isLimitHit(10.0, '600519', '贵州茅台', 0.5, 10.99, 9.99), 'up');
});

test('★ 精确停板价：settleDay 用实时源（带 prevClose）时按停板价判，未封板可成交', () => {
  let a = fresh();
  a = submitOrder(a, { code: '300750', side: 'buy', qty: 100 }, Q('300750', '宁德时代', 50), { date: '2026-09-30' }).next;
  // 次日 +19.9%（59.95，未封板，昨收 50）→ 必须成交；近似口径会错误失效
  const r = settleDay(a, '2026-10-08', { '300750': { code: '300750', name: '宁德时代', price: 59.95, changePct: 19.9, prevClose: 50.0, src: 'live' } });
  assert.equal(r.fills.length, 1, '未封板的 19.9% 必须可买（20cm 板停板价 60.00）');
  // 对照：真封板（60.00）→ 买入失效
  const r2 = settleDay(a, '2026-10-08', { '300750': { code: '300750', name: '宁德时代', price: 60.0, changePct: 20.0, prevClose: 50.0, src: 'live' } });
  assert.equal(r2.expired.length, 1);
  assert.match(r2.expired[0].reason, /涨停/);
});

// ────────────────────── 导出/导入：事件日志随档迁移 ──────────────────────
// 背景：exportAccount 不含 logs、importAccount 从空账户重建——跨设备迁移丢日志；
// 更严重的变体：UI 的 save() 存完整账本、load() 经 importAccount 重建 → 每次刷新
// 页面事件日志都清零。修复后两条路径都必须保住日志。

test('★ 导出再导入：事件日志完整保留（含龙虎拦截/结算流转）', () => {
  let a = fresh();
  a = submitOrder(a, { code: '600519', side: 'buy', qty: 100 }, Q('600519', '贵州茅台', 100), { date: '2026-09-29' }).next;
  a = settleDay(a, '2026-09-30', { '600519': Q('600519', '贵州茅台', 105) }).account;
  const nLogs = a.logs.length;
  assert.ok(nLogs >= 2, `前置：账本产生了 ${nLogs} 条日志（提交+成交）`);
  const r = importAccount(exportAccount(a));
  assert.equal(r.ok, true);
  assert.equal(r.account.logs.length, nLogs, '日志条数一条不少');
  assert.deepEqual(r.account.logs, a.logs, '日志内容逐条一致');
});

test('★ 导入旧版文件（无 logs 字段）→ 空日志，不报错不伪造', () => {
  let a = fresh();
  a = submitOrder(a, { code: '600519', side: 'buy', qty: 100 }, Q('600519', '贵州茅台', 100), { date: '2026-09-29' }).next;
  const d = JSON.parse(exportAccount(a));
  delete d.logs;
  const r = importAccount(JSON.stringify(d));
  assert.equal(r.ok, true);
  assert.deepEqual(r.account.logs, [], '缺失如实为空');
});

test('★ 导入：日志条目形状过滤——脏条目丢弃，不污染整份账本', () => {
  let a = fresh();
  a = submitOrder(a, { code: '600519', side: 'buy', qty: 100 }, Q('600519', '贵州茅台', 100), { date: '2026-09-29' }).next;
  const d = JSON.parse(exportAccount(a));
  d.logs = [...d.logs, { hack: '不是日志' }, '字符串也不是', null];
  const r = importAccount(JSON.stringify(d));
  assert.equal(r.ok, true);
  assert.ok(r.account.logs.every((x) => x && typeof x.text === 'string'), '只保留形状合法的条目');
});

// ────────────────────── 口径同源守卫：paper_ui 假期表 ↔ config.json ──────────────────────
// paper_ui.js 的 HOLIDAYS 与 config.json 的 manualHolidays 是并列两份（浏览器模块
// 加载约束），靠本守卫锁一致——漏更新一处即红，杜绝 2027 年起把休市日当交易日。
// 注：src/config.js 薄壳化（#142 config.json 单一事实源）后，manualHolidays 不再是
// config.js 源码里的字面量，故本守卫改为读运行时导出对象（与 test/config.test.mjs 同语义）。

test('★ 口径同源：paper_ui.js HOLIDAYS 与 config.manualHolidays 逐日一致', () => {
  const ui = readFileSync(new URL('../paper_ui.js', import.meta.url), 'utf8');
  const hm = ui.match(/const HOLIDAYS = new Set\(\[([^\]]+)\]\)/);
  assert.ok(hm, 'paper_ui.js 缺 HOLIDAYS 定义');
  const uiDates = [...hm[1].matchAll(/'(\d{4}-\d{2}-\d{2})'/g)].map((m) => m[1]);
  const set = new Set(uiDates);
  const cfgDates = config.manualHolidays;
  assert.ok(cfgDates.length >= 9, `config.manualHolidays 应有休市日，实际 ${cfgDates.length}`);
  for (const d of cfgDates) assert.ok(set.has(d), `config 有 ${d} 而 paper_ui.HOLIDAYS 没有——两份口径漂移`);
  for (const d of set) assert.ok(cfgDates.includes(d), `paper_ui.HOLIDAYS 有 ${d} 而 config.manualHolidays 没有——两份口径漂移`);
});
