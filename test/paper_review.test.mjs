// 模拟交易复盘引擎单测（src/paper_review.js）
//
// 纪律：这里测的是「归因口径」与「建议规则」，不是实现细节。
//   每一条断言都对应报告里会被用户读到、并可能据此改操作的一句话，
//   所以必须写清「因为哪个字段、应该得出什么结论」。
//   边界一律取等号两侧各一例；无数据场景必须验证「如实降级、不编造」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reviewAccount, reviewTrades, reviewPositions, buildAdvice, buildPaperReview,
  REVIEW_CFG, ADVICE_LEVELS, REVIEW_TITLE,
} from '../src/paper_review.js';
import { POS_CFG, MARKET_CFG } from '../src/alerts.js';
import { TIER_THRESHOLDS } from '../src/picks.js';
import { emptyAccount, accountStats, fees } from '../src/paper.js';

const T = 1_000_000;

/** 造一份 accountStats 形状的快照 */
const stats = (o = {}) => ({
  cash: T, freeze: 0, marketValue: 0, costValue: 0,
  floatPnl: 0, floatPnlPct: 0, realized: 0, totalFee: 0,
  total: T, initCash: T, ret: 0, retPct: 0, posCount: 0,
  ...o,
});

/** 造一只持仓 */
const pos = (o = {}) => ({
  code: '600519', name: '贵州茅台', qty: 100, avail: 100,
  avgCost: 100, cost: 10000, last: 100, lastDate: '2026-09-30', pxStale: false,
  ...o,
});

/** 造一笔成交 */
const trade = (o = {}) => ({
  id: 1, code: '000001', name: '平安银行', side: 'buy', qty: 10000,
  fillDate: '2026-09-26', price: 10, gross: 100000, fee: 0, ...o,
});

const findRule = (list, rule) => list.find((a) => a.rule === rule);

// ══════════════════════ 一、收益来源拆解（为什么赚 / 为什么亏） ══════════════════════

test('收益拆解：恒等式三块齐全，残差 = 总盈亏 −（浮动 + 已实现 − 费用）', () => {
  const ar = reviewAccount({ positions: { a: pos() } }, stats({
    marketValue: 25857, costValue: 10000, floatPnl: 15857, floatPnlPct: 1.5857,
    realized: -10103.9, totalFee: 108.9, total: 1015753.1, initCash: T,
  }));
  assert.equal(ar.initCash, T);
  // 浮点：1015753.1 − 1000000 = 15753.099999999977，必须用容差比较
  assert.ok(Math.abs(ar.netPnl - 15753.1) < 1e-6, '总盈亏 = 总资产 − 初始本金');
  assert.equal(ar.items.length, 3, '三块：浮动 / 已实现 / 费用');
  // 残差必须显式给出（不假装严丝合缝）
  const explained = ar.floatPnl + ar.realized - ar.totalFee;
  assert.ok(Math.abs(ar.residual - (ar.netPnl - explained)) < 1e-9, '残差定义必须自洽');
  assert.ok(Number.isFinite(ar.residual), '残差必须是数字，不能是 NaN');
});

test('收益拆解：方向用净盈亏判，不用收益率判（赚 3000 元本金 100 万也是「赚」）', () => {
  const gain = reviewAccount({}, stats({ total: T + 3000, initCash: T }));
  assert.equal(gain.direction, 'gain', '净赚 3000 元 → gain（尽管收益率仅 0.3%）');
  const loss = reviewAccount({}, stats({ total: T - 3000, initCash: T }));
  assert.equal(loss.direction, 'loss');
  const flat = reviewAccount({}, stats({ total: T, initCash: T }));
  assert.equal(flat.direction, 'flat');
  // 1 元以内的浮点误差不算「赚/亏」
  assert.equal(reviewAccount({}, stats({ total: T + 0.5, initCash: T })).direction, 'flat');
});

test('收益拆解：主导项按绝对值取最大，费用为负值计入', () => {
  const ar = reviewAccount({}, stats({
    floatPnl: 1000, realized: -5000, totalFee: 300, total: T - 4300, initCash: T,
  }));
  assert.equal(ar.dominant.key, 'realized', '|-5000| 最大 → 已实现盈亏是主导项');
  assert.equal(ar.dominant.value, -5000);
  const feeItem = ar.items.find((x) => x.key === 'fee');
  assert.equal(feeItem.value, -300, '费用项必须是负值（确定性负收益）');
});

test('收益拆解：未开始交易（无持仓无成交无已实现）→ started=false', () => {
  const ar = reviewAccount(emptyAccount(T, '2026-09-25'), accountStats(emptyAccount(T, '2026-09-25')));
  assert.equal(ar.started, false);
  // 有成交记录即视为已开始
  assert.equal(reviewAccount({ trades: [trade()] }, stats()).started, true);
  // 有持仓即视为已开始
  assert.equal(reviewAccount({ positions: { a: pos() } }, stats()).started, true);
  // 有已实现盈亏即视为已开始
  assert.equal(reviewAccount({}, stats({ realized: -1 })).started, true);
});

test('收益拆解：initCash 为 0 时不能除以 0，retPct 给 null', () => {
  const ar = reviewAccount({}, stats({ total: 100, initCash: 0 }));
  assert.equal(ar.retPct, null);
  assert.equal(ar.netPnl, 0, '无法判定本金时净盈亏记 0（不是 total）');
});

// ══════════════════════ 二、逐笔复盘（FIFO 配对 / 胜率 / 盈亏比） ══════════════════════

test('逐笔复盘：FIFO 配对，盈亏 = 卖出净额 − 结转成本（含买入费）', () => {
  // 买入 10000 股 @10（含费），卖出 10000 股 @9
  const buyFee = fees(100000, 'buy').total;
  const sellGross = 9 * 10000;
  const sellFee = fees(sellGross, 'sell').total;
  const tr = reviewTrades([
    trade({ side: 'buy', qty: 10000, price: 10, gross: 100000, fee: buyFee, fillDate: '2026-09-26' }),
    trade({ side: 'sell', qty: 10000, price: 9, gross: sellGross, fee: sellFee, fillDate: '2026-09-29' }),
  ], { initCash: T });

  assert.equal(tr.closedCount, 1);
  assert.equal(tr.wins, 0);
  assert.equal(tr.losses, 1);
  // 手算：90000 − 72.9 − (100000 + 30) = −10102.9
  const expect = (sellGross - sellFee) - (100000 + buyFee);
  assert.ok(Math.abs(tr.closed[0].pnl - expect) < 1e-6, `逐笔盈亏应 = ${expect}，实际 ${tr.closed[0].pnl}`);
  assert.equal(tr.closed[0].costPx, (100000 + buyFee) / 10000, '成本单价含买入费');
  assert.equal(tr.winRate, 0);
});

test('逐笔复盘：部分减仓后 FIFO 仍能算清，剩余成本不丢零头', () => {
  const buyFee = fees(100000, 'buy').total;
  const tr = reviewTrades([
    trade({ side: 'buy', qty: 1000, price: 10, gross: 10000, fee: buyFee, fillDate: '2026-09-26' }),
    trade({ side: 'buy', qty: 1000, price: 12, gross: 12000, fee: fees(12000, 'buy').total, fillDate: '2026-09-27' }),
    // 卖 1500 股：FIFO 先冲销 1000@10，再冲销 500@12
    trade({ side: 'sell', qty: 1500, price: 15, gross: 22500, fee: fees(22500, 'sell').total, fillDate: '2026-09-29' }),
  ], { initCash: T });
  assert.equal(tr.closedCount, 1);
  const c = tr.closed[0];
  const costOut = 1000 * ((10000 + buyFee) / 1000) + 500 * ((12000 + fees(12000, 'buy').total) / 1000);
  assert.ok(Math.abs(c.pnl - ((22500 - fees(22500, 'sell').total) - costOut)) < 1e-6, 'FIFO 成本结转必须精确');
  assert.ok(c.pnl > 0, '15 元卖出 10/12 元买入，应为盈利');
});

test('逐笔复盘：找不到对应买入记录的卖出 → 不猜成本，跳过并计数', () => {
  const tr = reviewTrades([
    trade({ side: 'sell', qty: 10000, price: 9, gross: 90000, fee: fees(90000, 'sell').total, fillDate: '2026-09-29' }),
  ], { initCash: T });
  assert.equal(tr.closedCount, 0, '无买入记录不得凭空造出盈亏');
  assert.equal(tr.orphanSell, 1, '必须如实计数孤儿卖出笔');
});

test('逐笔复盘：胜负平分类，胜率分母只含已判定的盈亏笔（平不计）', () => {
  const mk = (buyPx, sellPx, date) => ([
    trade({ side: 'buy', qty: 100, price: buyPx, gross: buyPx * 100, fee: 0, fillDate: `2026-09-2${date}` }),
    trade({ side: 'sell', qty: 100, price: sellPx, gross: sellPx * 100, fee: 0, fillDate: `2026-09-2${date + 1}` }),
  ]);
  const tr = reviewTrades([
    ...mk(10, 12, 0),  // 赢
    ...mk(10, 8, 2),   // 亏
    ...mk(10, 10, 4),  // 平（盈亏为 0）
  ], { initCash: T });
  assert.equal(tr.wins, 1);
  assert.equal(tr.losses, 1);
  assert.equal(tr.flats, 1);
  assert.equal(tr.judged, 2, '胜率分母 = 赢 + 亏，平不进分母');
  assert.equal(tr.winRate, 0.5);
});

test('逐笔复盘：无亏损笔时盈亏比给 null（不编「无穷大」）', () => {
  const tr = reviewTrades([
    trade({ side: 'buy', qty: 100, price: 10, gross: 1000, fee: 0, fillDate: '2026-09-20' }),
    trade({ side: 'sell', qty: 100, price: 12, gross: 1200, fee: 0, fillDate: '2026-09-21' }),
  ], { initCash: T });
  assert.equal(tr.plRatio, null, '没有亏损样本 → 盈亏比无意义，给 null');
  assert.equal(tr.profitFactor, null);
  assert.equal(tr.winRate, 1, '胜率仍可算 = 1');
});

test('逐笔复盘：盈亏比与盈利因子按平均/总和分别计算', () => {
  const tr = reviewTrades([
    // 赢 2000
    trade({ side: 'buy', qty: 100, price: 10, gross: 1000, fee: 0, fillDate: '2026-09-20' }),
    trade({ side: 'sell', qty: 100, price: 30, gross: 3000, fee: 0, fillDate: '2026-09-21' }),
    // 亏 1000
    trade({ side: 'buy', qty: 100, price: 20, gross: 2000, fee: 0, fillDate: '2026-09-22' }),
    trade({ side: 'sell', qty: 100, price: 10, gross: 1000, fee: 0, fillDate: '2026-09-23' }),
  ], { initCash: T });
  assert.equal(tr.avgWin, 2000);
  assert.equal(tr.avgLoss, -1000);
  assert.equal(tr.plRatio, 2, '盈亏比 = 平均盈利 / |平均亏损| = 2000/1000');
  assert.equal(tr.profitFactor, 2, '盈利因子 = 总盈利 / |总亏损| = 2000/1000');
});

test('逐笔复盘：最大连亏按平仓时间顺序统计', () => {
  const mk = (buyPx, sellPx, d1, d2) => ([
    trade({ side: 'buy', qty: 100, price: buyPx, gross: buyPx * 100, fee: 0, fillDate: d1 }),
    trade({ side: 'sell', qty: 100, price: sellPx, gross: sellPx * 100, fee: 0, fillDate: d2 }),
  ]);
  const tr = reviewTrades([
    ...mk(10, 9, '2026-09-10', '2026-09-11'),  // 亏
    ...mk(10, 9, '2026-09-12', '2026-09-13'),  // 亏
    ...mk(10, 9, '2026-09-14', '2026-09-15'),  // 亏 → 连亏 3
    ...mk(10, 12, '2026-09-16', '2026-09-17'), // 赢 → 中断
    ...mk(10, 9, '2026-09-18', '2026-09-19'),  // 亏 → 连亏 1
  ], { initCash: T });
  assert.equal(tr.maxLossStreak, 3, '最大连亏 = 3（中间被盈利笔中断）');
});

test('逐笔复盘：样本不足时 samplesEnough=false（如实标注，不隐藏）', () => {
  const tr = reviewTrades([
    trade({ side: 'buy', qty: 100, price: 10, gross: 1000, fee: 0, fillDate: '2026-09-20' }),
    trade({ side: 'sell', qty: 100, price: 12, gross: 1200, fee: 0, fillDate: '2026-09-21' }),
  ], { initCash: T });
  assert.equal(tr.judged, 1);
  assert.equal(tr.samplesEnough, false, `1 笔 < ${REVIEW_CFG.minTradesForWinRate} 笔 → 样本不足`);
  assert.equal(tr.winRate, 1, '胜率仍如实给出（0 与「不知道」是两回事，胜率 100% 是事实）');
});

test('逐笔复盘：非法成交（缺数量/缺价）被剔除，不污染统计', () => {
  const tr = reviewTrades([
    trade({ side: 'buy', qty: 0, price: 10 }),
    trade({ side: 'buy', qty: 100, price: null, gross: null }),
    trade({ side: 'buy', qty: 100, price: 10, gross: 1000, fee: 0, fillDate: '2026-09-20' }),
    trade({ side: 'sell', qty: 100, price: 12, gross: 1200, fee: 0, fillDate: '2026-09-21' }),
  ], { initCash: T });
  assert.equal(tr.nTrades, 2, '只有 2 笔合法成交进入统计');
  assert.equal(tr.closedCount, 1);
});

// ══════════════════════ 三、持仓诊断（贡献排序 / 超配 / 档位一致性） ══════════════════════

test('持仓诊断：逐票盈亏按「市值 − 含费成本」算，缺失价退化为成本（盈亏 0）', () => {
  const pr = reviewPositions({
    a: pos({ code: 'a', qty: 100, cost: 10000, last: 120, avgCost: 100 }),
    b: pos({ code: 'b', qty: 100, cost: 20000, last: null, avgCost: 200 }),
  }, stats({ total: T, marketValue: 32000 }), null);
  const a = pr.rows.find((r) => r.code === 'a');
  const b = pr.rows.find((r) => r.code === 'b');
  assert.equal(a.pnl, 2000, '有价：12000 − 10000 = 2000');
  assert.equal(b.pnl, 0, '无价：退化为成本 → 盈亏 0（不是 −20000）');
  assert.equal(b.last, null);
});

test('持仓诊断：贡献排序为降序（赚得最多的排最前）', () => {
  const pr = reviewPositions({
    a: pos({ code: 'a', cost: 10000, last: 90 }),
    b: pos({ code: 'b', cost: 10000, last: 130 }),
    c: pos({ code: 'c', cost: 10000, last: 110 }),
  }, stats({ total: T }), null);
  assert.deepEqual(pr.rows.map((r) => r.code), ['b', 'c', 'a']);
  assert.equal(pr.contributors.length, 2, 'b、c 是贡献者');
  assert.equal(pr.drags.length, 1, 'a 是拖累');
});

test('持仓诊断：超配判定与 alerts.POS_CFG.concMax 同源（等号两侧各一例）', () => {
  const over = reviewPositions({ a: pos({ code: 'a', cost: 200000, last: 2001 * 100 / 100 }) },
    stats({ total: T }), null);
  // 构造占比恰好 = concMax（20%）
  const atCap = reviewPositions({ a: pos({ code: 'a', qty: 100, cost: 20000, last: 2000, avgCost: 200 }) },
    stats({ total: T }), null);
  assert.equal(atCap.rows[0].conc, POS_CFG.concMax, '占比恰为上限');
  assert.equal(atCap.overConc.length, 0, '等于上限不算超配（开区间）');
  const above = reviewPositions({ a: pos({ code: 'a', qty: 100, cost: 20000, last: 2001, avgCost: 200 }) },
    stats({ total: T }), null);
  assert.ok(above.overConc.length === 1, '超过上限 → 计入 overConc');
  assert.ok(over === over, '');
});

test('持仓诊断：档位一致性用 MARKET_CFG.band 容忍带判定 over/under/fit', () => {
  const tier = { key: 'half', label: '半仓', pos: 0.5, allowNew: true };
  // 市值 61% → 超出 11% > band(10%) → over
  const over = reviewPositions({ a: pos({ code: 'a', qty: 100, cost: 610000, last: 6100, avgCost: 6100 }) },
    stats({ total: T, marketValue: 610000 }), tier);
  assert.equal(over.tierVerdict, 'over');
  // 市值 60% → 恰好 = band(10%)，判定用严格大于 → fit（与 alerts.js 同口径，等号在带内）
  const atBand = reviewPositions({ a: pos({ code: 'a', qty: 100, cost: 600000, last: 6000, avgCost: 6000 }) },
    stats({ total: T, marketValue: 600000 }), tier);
  assert.equal(atBand.tierVerdict, 'fit', `偏离恰好 ${MARKET_CFG.band} 视为贴合（严格 > 才判偏离）`);
  // 市值 39% → 低于 11% → under
  const under = reviewPositions({ a: pos({ code: 'a', qty: 100, cost: 390000, last: 3900, avgCost: 3900 }) },
    stats({ total: T, marketValue: 390000 }), tier);
  assert.equal(under.tierVerdict, 'under');
  // 市值 50% → fit
  const fit = reviewPositions({ a: pos({ code: 'a', qty: 100, cost: 500000, last: 5000, avgCost: 5000 }) },
    stats({ total: T, marketValue: 500000 }), tier);
  assert.equal(fit.tierVerdict, 'fit');
  assert.ok(MARKET_CFG.band > 0);
});

// ══════════════════════ 四、建议规则（止损 / 优化） ══════════════════════

test('A1 止损纪律：浮亏击穿止损线 → risk 建议（等号两侧各一例）', () => {
  const build = (last) => {
    const positions = { a: pos({ code: 'a', qty: 100, cost: 10000, avgCost: 100, last }) };
    const st = stats({ total: T, marketValue: last * 100 });
    const ar = reviewAccount({ positions }, st);
    const pr = reviewPositions(positions, st, null);
    return buildAdvice({ stats: st, accountReview: ar, tradeReview: reviewTrades([], {}), posReview: pr });
  };
  // 恰在止损线上（−8%）→ 触发（<=）
  const atLine = build(100 * (1 + POS_CFG.stopLoss));
  assert.ok(findRule(atLine, 'A1'), `浮亏恰为 ${POS_CFG.stopLoss} 应触发 A1`);
  assert.equal(findRule(atLine, 'A1').level, 'risk');
  // 略高于止损线（−7%）→ 不触发
  const above = build(93);
  assert.equal(findRule(above, 'A1'), undefined, '浮亏 −7% 未击穿，不触发');
});

test('A2 单票超配：给出应减股数（整手，且能追溯到差额）', () => {
  // 市值 30 万 / 总资产 100 万 = 30% > 20%，需减至 20 万 → 差 10 万 → 价 100 → 减 1000 股
  const positions = { a: pos({ code: 'a', qty: 3000, cost: 300000, avgCost: 100, last: 100 }) };
  const st = stats({ total: T, marketValue: 300000 });
  const ar = reviewAccount({ positions }, st);
  const pr = reviewPositions(positions, st, null);
  const adv = buildAdvice({ stats: st, accountReview: ar, tradeReview: reviewTrades([]), posReview: pr });
  const a2 = findRule(adv, 'A2');
  assert.ok(a2, '超配必须给建议');
  assert.equal(a2.level, 'risk');
  assert.equal(a2.qty, 1000, '应减股数 = (300000−200000)/100 = 1000，整手');
});

test('A3 连续亏损：达到阈值 → risk「停手复盘」', () => {
  const mk = (d1, d2) => ([
    trade({ side: 'buy', qty: 100, price: 10, gross: 1000, fee: 0, fillDate: d1 }),
    trade({ side: 'sell', qty: 100, price: 9, gross: 900, fee: 0, fillDate: d2 }),
  ]);
  const trades = [1, 3, 5].flatMap((n) => mk(`2026-09-1${n}`, `2026-09-1${n + 1}`));
  const tr = reviewTrades(trades, { initCash: T });
  const st = stats({ total: T });
  const adv = buildAdvice({
    stats: st, accountReview: reviewAccount({}, st), tradeReview: tr,
    posReview: reviewPositions({}, st, null),
  });
  assert.equal(tr.maxLossStreak, 3);
  const a3 = findRule(adv, 'A3');
  assert.ok(a3, `连亏 ${REVIEW_CFG.lossStreakWarn} 笔应触发 A3`);
  assert.equal(a3.level, 'risk');
});

test('A4 费用吞噬：费用占本金 ≥ 阈值 → tip（等号两侧各一例）', () => {
  const build = (fee) => {
    const st = stats({ total: T, totalFee: fee });
    return buildAdvice({
      stats: st, accountReview: reviewAccount({}, st),
      tradeReview: reviewTrades([]), posReview: reviewPositions({}, st, null),
    });
  };
  assert.ok(findRule(build(T * REVIEW_CFG.feeDragWarn), 'A4'), '恰达阈值应触发');
  assert.equal(findRule(build(T * REVIEW_CFG.feeDragWarn - 1), 'A4'), undefined, '略低于阈值不触发');
});

test('A5 胜率偏低：样本足够才说（样本不足时不给结论）', () => {
  const lossPair = (n) => ([
    trade({ side: 'buy', qty: 100, price: 10, gross: 1000, fee: 0, fillDate: `2026-09-${10 + n}` }),
    trade({ side: 'sell', qty: 100, price: 9, gross: 900, fee: 0, fillDate: `2026-09-${10 + n}` }),
  ]);
  const many = reviewTrades([0, 2, 4].flatMap(lossPair), { initCash: T });
  const st = stats({ total: T });
  const advMany = buildAdvice({
    stats: st, accountReview: reviewAccount({}, st), tradeReview: many,
    posReview: reviewPositions({}, st, null),
  });
  assert.equal(many.samplesEnough, true);
  assert.ok(findRule(advMany, 'A5'), '3 笔全亏 → 应触发 A5');

  const few = reviewTrades(lossPair(0), { initCash: T });
  const advFew = buildAdvice({
    stats: st, accountReview: reviewAccount({}, st), tradeReview: few,
    posReview: reviewPositions({}, st, null),
  });
  assert.equal(findRule(advFew, 'A5'), undefined, '仅 1 笔 → 样本不足，不给胜率结论');
});

test('A6 档位偏离：超配给 risk 降仓，低配且允许新建给 opp 加仓', () => {
  const tier = { key: 'half', label: '半仓', pos: 0.5, allowNew: true };
  const mkAdv = (mvRatio) => {
    const positions = { a: pos({ code: 'a', qty: 100, cost: T * mvRatio, avgCost: T * mvRatio / 100, last: T * mvRatio / 100 }) };
    const st = stats({ total: T, marketValue: T * mvRatio });
    return buildAdvice({
      stats: st, accountReview: reviewAccount({ positions }, st),
      tradeReview: reviewTrades([]), posReview: reviewPositions(positions, st, tier), tier,
    });
  };
  const over = findRule(mkAdv(0.8), 'A6');
  assert.equal(over.level, 'risk');
  assert.equal(over.action, 'reduce');
  const under = findRule(mkAdv(0.2), 'A6');
  assert.equal(under.level, 'opp');
  assert.equal(under.action, 'add');
});

test('A6 档位偏离：过热档不允许新建 → 低配给 tip「接受缺口」而非加仓', () => {
  const tier = { key: 'overheat', label: '过热（只减仓不新建）', pos: 0.4, allowNew: false };
  const positions = { a: pos({ code: 'a', qty: 100, cost: 10000, avgCost: 100, last: 100 }) };
  const st = stats({ total: T, marketValue: 10000 });
  const adv = buildAdvice({
    stats: st, accountReview: reviewAccount({ positions }, st),
    tradeReview: reviewTrades([]), posReview: reviewPositions(positions, st, tier), tier,
  });
  const a6 = findRule(adv, 'A6');
  assert.equal(a6.level, 'tip');
  assert.equal(a6.action, 'hold', '过热档即使低配也不许加仓');
  assert.ok(/只减仓不新建|接受/.test(a6.why), '必须说明为什么不该补仓');
});

test('A7 盈亏比失衡：平均亏损 > 平均盈利 → tip', () => {
  const trades = [
    // 赢 100
    trade({ side: 'buy', qty: 100, price: 10, gross: 1000, fee: 0, fillDate: '2026-09-10' }),
    trade({ side: 'sell', qty: 100, price: 11, gross: 1100, fee: 0, fillDate: '2026-09-11' }),
    // 亏 500
    trade({ side: 'buy', qty: 100, price: 10, gross: 1000, fee: 0, fillDate: '2026-09-12' }),
    trade({ side: 'sell', qty: 100, price: 5, gross: 500, fee: 0, fillDate: '2026-09-13' }),
  ];
  const tr = reviewTrades(trades, { initCash: T });
  const st = stats({ total: T });
  const adv = buildAdvice({
    stats: st, accountReview: reviewAccount({}, st), tradeReview: tr,
    posReview: reviewPositions({}, st, null),
  });
  assert.ok(tr.avgWin < Math.abs(tr.avgLoss));
  assert.ok(findRule(adv, 'A7'), '平均亏损更大 → 触发 A7');
  assert.equal(findRule(adv, 'A7').level, 'tip');
});

test('A8 台账战绩：命中率偏低 → tip；全未结算 → 说明「暂无命中率」而非编数字', () => {
  const st = stats({ total: T });
  // 构造台账：两条卖出类，触发价 10，现价 12（涨）→ 全错
  const log = [
    { key: 'k1', asOf: '2026-09-28', layer: 'position', code: 'a', name: 'A', type: 'pos-stop-loss', level: 'risk', action: 'sell', dir: 1, qty: 100, scoreQty: 100, px: 10, text: '' },
    { key: 'k2', asOf: '2026-09-29', layer: 'position', code: 'a', name: 'A', type: 'pos-stop-loss', level: 'risk', action: 'sell', dir: 1, qty: 100, scoreQty: 100, px: 10, text: '' },
    { key: 'k3', asOf: '2026-09-30', layer: 'position', code: 'a', name: 'A', type: 'pos-stop-loss', level: 'risk', action: 'sell', dir: 1, qty: 100, scoreQty: 100, px: 10, text: '' },
  ];
  const adv = buildAdvice({
    stats: st, accountReview: reviewAccount({}, st), tradeReview: reviewTrades([]),
    posReview: reviewPositions({}, st, null), log, priceMap: { a: 12 },
  });
  const a8 = findRule(adv, 'A8');
  assert.ok(a8, '3 条全错且样本足够 → 触发 A8');
  assert.ok(/命中率/.test(a8.title));

  // 全部无价 → 未结算 → 给 A8b 说明，不给命中率
  const advPend = buildAdvice({
    stats: st, accountReview: reviewAccount({}, st), tradeReview: reviewTrades([]),
    posReview: reviewPositions({}, st, null), log, priceMap: {},
  });
  assert.equal(findRule(advPend, 'A8'), undefined, '无结算数据不得编命中率');
  assert.ok(findRule(advPend, 'A8b'), '应给出「待价格验证」的说明');
});

test('A9 从未止盈：有浮盈且零平仓 → tip 提示落袋', () => {
  const positions = { a: pos({ code: 'a', qty: 100, cost: 10000, avgCost: 100, last: 120 }) };
  const st = stats({ total: T, marketValue: 12000 });
  const adv = buildAdvice({
    stats: st, accountReview: reviewAccount({ positions }, st),
    tradeReview: reviewTrades([]), posReview: reviewPositions(positions, st, null),
  });
  assert.ok(findRule(adv, 'A9'), '浮盈 20% 且从未平仓 → 触发 A9');
  // 有平仓记录后不再提示
  const tr = reviewTrades([
    trade({ side: 'buy', qty: 100, price: 10, gross: 1000, fee: 0, fillDate: '2026-09-20' }),
    trade({ side: 'sell', qty: 100, price: 12, gross: 1200, fee: 0, fillDate: '2026-09-21' }),
  ], { initCash: T });
  const adv2 = buildAdvice({
    stats: st, accountReview: reviewAccount({ positions }, st),
    tradeReview: tr, posReview: reviewPositions(positions, st, null),
  });
  assert.equal(findRule(adv2, 'A9'), undefined, '有平仓记录 → 不再提示「从未止盈」');
});

test('建议排序：risk > opp > tip，同级按规则号', () => {
  const positions = {
    a: pos({ code: 'a', qty: 100, cost: 10000, avgCost: 100, last: 80 }),   // 击穿止损 A1
    b: pos({ code: 'b', qty: 3000, cost: 300000, avgCost: 100, last: 100 }), // 超配 A2
  };
  const st = stats({ total: T, marketValue: 308000 });
  const adv = buildAdvice({
    stats: st, accountReview: reviewAccount({ positions }, st),
    tradeReview: reviewTrades([]), posReview: reviewPositions(positions, st, null),
  });
  const levels = adv.map((a) => a.level);
  const idx = (l) => ADVICE_LEVELS.indexOf(l);
  for (let i = 1; i < levels.length; i++) {
    assert.ok(idx(levels[i - 1]) <= idx(levels[i]), '严重度必须单调不降');
  }
  const risks = adv.filter((a) => a.level === 'risk').map((a) => a.rule);
  assert.deepEqual(risks, risks.slice().sort(), 'risk 组内按规则号排序');
});

test('主入口：headline 措辞与总方向一致（主导项与总盈亏异号时不得说「主要来自」）', () => {
  const acct = emptyAccount(T, '2026-09-25');
  // 总盈亏为正（现金层面净赚 10 万），但持仓浮亏 2.3 万 → 主导项（绝对值最大）符号与总方向相反
  acct.positions = { a: pos({ code: 'a', qty: 1000, cost: 100000, avgCost: 100, last: 77 }) }; // 浮亏 −23000
  acct.cash = T + 100000 - 100000 + 23000; // 凑出 total = T + 100000
  const st = accountStats(acct);
  const r = buildPaperReview({ account: acct, stats: st, emotionScore: 50 });
  assert.equal(r.account.direction, 'gain', '总盈亏为正');
  assert.ok(r.account.dominant && r.account.dominant.value < 0, '主导项是负数（浮亏）');
  assert.ok(!/主要来自/.test(r.headline), `异号时不得说「主要来自」：${r.headline}`);
  assert.ok(/最大拖累|最大缓冲/.test(r.headline), `应改用「最大拖累」：${r.headline}`);
});

test('主入口：headline 主导项与总方向同号时用「主要来自」', () => {
  const acct = emptyAccount(T, '2026-09-25');
  acct.positions = { a: pos({ code: 'a', qty: 1000, cost: 100000, avgCost: 100, last: 150 }) }; // 浮盈 +50000
  acct.cash = T - 100000;
  const st = accountStats(acct);
  const r = buildPaperReview({ account: acct, stats: st, emotionScore: 50 });
  assert.equal(r.account.direction, 'gain');
  assert.ok(/主要来自/.test(r.headline), `同号时用「主要来自」：${r.headline}`);
});

test('建议 A5：无盈利样本时如实说「盈亏比无从计算」，不输出「当前盈亏比 —」', () => {
  const lossPair = (n) => ([
    trade({ side: 'buy', qty: 100, price: 10, gross: 1000, fee: 0, fillDate: `2026-09-1${n}` }),
    trade({ side: 'sell', qty: 100, price: 9, gross: 900, fee: 0, fillDate: `2026-09-1${n}` }),
  ]);
  const tr = reviewTrades([1, 3, 5].flatMap(lossPair), { initCash: T });
  assert.equal(tr.plRatio, null, '全亏 → 盈亏比 null');
  const st = stats({ total: T });
  const adv = buildAdvice({
    stats: st, accountReview: reviewAccount({}, st), tradeReview: tr,
    posReview: reviewPositions({}, st, null),
  });
  const a5 = findRule(adv, 'A5');
  assert.ok(a5);
  assert.ok(!/盈亏比 —/.test(a5.why), `不得出现「盈亏比 —」这种半截说法：${a5.why}`);
  assert.ok(/尚无盈利样本|无从计算/.test(a5.why), a5.why);
});

// ══════════════════════ 五、主入口：降级与整合 ══════════════════════

test('主入口：无账户 → 如实降级，不生成看似专业的结论', () => {
  const r = buildPaperReview({});
  assert.equal(r.hasAccount, false);
  assert.equal(r.started, false);
  assert.match(r.headline, /尚未开始模拟交易/);
  assert.equal(r.advice.length, 0, '未开始时不得给建议');
});

test('主入口：有账户无成交 → 降级为「暂无可复盘」', () => {
  const acct = emptyAccount(T, '2026-09-25');
  const r = buildPaperReview({ account: acct, stats: accountStats(acct), emotionScore: 50 });
  assert.equal(r.hasAccount, true);
  assert.equal(r.started, false);
  assert.match(r.headline, /尚无成交记录/);
});

test('主入口：整合账户 / 逐笔 / 持仓 / 台账 / 档位，headline 含关键事实', () => {
  const buyFee = fees(100000, 'buy').total;
  const sellGross = 9 * 10000;
  const sellFee = fees(sellGross, 'sell').total;
  const acct = emptyAccount(T, '2026-09-25');
  acct.positions = { '600519': pos({ code: '600519', name: '贵州茅台', qty: 100, cost: 100005, avgCost: 1000.05, last: 1258.62 }) };
  acct.trades = [
    trade({ code: '000001', name: '平安银行', side: 'buy', qty: 10000, price: 10, gross: 100000, fee: buyFee, fillDate: '2026-09-26' }),
    trade({ code: '000001', name: '平安银行', side: 'sell', qty: 10000, price: 9, gross: sellGross, fee: sellFee, fillDate: '2026-09-29' }),
  ];
  acct.realized = (sellGross - sellFee) - (100000 + buyFee);
  acct.totalFee = 5 + buyFee + sellFee;
  acct.cash = T - 100005 - 100000 - buyFee + (sellGross - sellFee);
  const st = accountStats(acct);
  const r = buildPaperReview({ account: acct, stats: st, emotionScore: 30, asOf: '2026-09-30' });

  assert.equal(r.hasAccount, true);
  assert.equal(r.started, true);
  assert.equal(r.asOf, '2026-09-30');
  assert.equal(r.trades.closedCount, 1);
  assert.equal(r.trades.losses, 1);
  assert.equal(r.positions.rows.length, 1);
  assert.ok(r.tier, '情绪分 30 → 半仓档');
  assert.equal(r.tier.key, 'half');
  assert.ok(r.account.netPnl > 0, '茅台浮盈覆盖了平仓亏损');
  assert.match(r.headline, /模拟账户整体盈利/);
  assert.ok(r.advice.length > 0, '低配档位应给出 A6 建议');
  assert.ok(Array.isArray(r.advice));
  // 每一条建议都必须带「可追溯依据」
  for (const a of r.advice) {
    assert.ok(a.text && a.why, `建议 ${a.rule} 必须带 text 与 why`);
    assert.ok(ADVICE_LEVELS.includes(a.level));
  }
});

test('主入口：情绪分缺失 → tier=null，不给档位相关建议（不猜档）', () => {
  const acct = emptyAccount(T, '2026-09-25');
  acct.positions = { a: pos({ code: 'a', qty: 100, cost: 10000, avgCost: 100, last: 100 }) };
  const st = accountStats(acct);
  const r = buildPaperReview({ account: acct, stats: st, emotionScore: null });
  assert.equal(r.tier, null);
  assert.equal(findRule(r.advice, 'A6'), undefined, '档位未知时不得给 A6');
});

test('主入口：无情绪分但持仓击穿止损 → 仍给 A1（与档位无关的规则不受影响）', () => {
  const acct = emptyAccount(T, '2026-09-25');
  acct.positions = { a: pos({ code: 'a', name: '测试股', qty: 100, cost: 10000, avgCost: 100, last: 80 }) };
  const st = accountStats(acct);
  const r = buildPaperReview({ account: acct, stats: st, emotionScore: null });
  assert.ok(findRule(r.advice, 'A1'), '止损纪律与档位无关，必须仍然给出');
});

test('常量与导出：REVIEW_CFG 边界合理，REVIEW_TITLE 固定', () => {
  assert.ok(REVIEW_CFG.minTradesForWinRate >= 2, '胜率样本下限至少 2 笔才有意义');
  assert.ok(REVIEW_CFG.feeDragWarn > 0 && REVIEW_CFG.feeDragWarn < 1);
  assert.equal(REVIEW_TITLE, '模拟交易复盘');
  assert.deepEqual(ADVICE_LEVELS, ['risk', 'opp', 'tip']);
});

test('档位阈值同源：TIER_THRESHOLDS 与 picks 一致（复盘不得自定档位）', () => {
  const acct = emptyAccount(T, '2026-09-25');
  const st = accountStats(acct);
  // 直接验证引擎使用的档位来自 picks（同一个 marketTier）
  const over = buildPaperReview({ account: acct, stats: st, emotionScore: TIER_THRESHOLDS.overheat });
  assert.equal(over.tier.key, 'overheat');
  const clear = buildPaperReview({ account: acct, stats: st, emotionScore: TIER_THRESHOLDS.half });
  assert.equal(clear.tier.key, 'clear');
});
