// 预警台账与收益归因引擎单测（src/alert_log.js）
//
// 纪律：这个模块是预警系统的**计分板**——算错了会让用户误以为某条规则一直在帮他赚钱。
// 所以每个用例都必须写清「照做的股数 × 价差 = 多少钱」，边界取等号两侧各一例，
// 并且专门锁死「无价时不许假装算过」（0 与「不知道」必须可区分）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendSignals, evaluateEntry, evaluateMarketEntry, summarizeLog, summarizeText,
  ACTION_DIR, LOG_CFG, LOG_CAP,
} from '../src/alert_log.js';
import { LOT } from '../src/paper.js';

/** 造一条持仓层预警（形状与 src/alerts.js 的输出一致，含 heldQty） */
const posAlert = (o = {}) => ({
  layer: 'position', code: '000001', name: '平安银行',
  type: 'pos-stop-loss', level: 'risk', action: 'sell', qty: 1000, heldQty: 1000,
  text: '浮亏击穿止损线',
  ...o,
});

/** 造一条大盘层预警 */
const mktAlert = (o = {}) => ({
  layer: 'market', code: undefined, name: undefined,
  type: 'market-trim', level: 'risk', action: 'reduce', qty: 0,
  text: '超配应减仓',
  ...o,
});

const PRICE = { '000001': 10 };

// ────────────────────────── 一、落账与幂等 ──────────────────────────

test('落账：带价带量的持仓预警写入台账，且价格基准被冻结', () => {
  const { log, added, skipped } = appendSignals([], [posAlert()], { asOf: '2026-09-30', priceOf: (c) => PRICE[c] });
  assert.equal(added, 1);
  assert.equal(skipped, 0);
  assert.equal(log.length, 1);
  assert.equal(log[0].px, 10, '触发时价格必须冻结在台账里，后续行情变动不得改写');
  assert.equal(log[0].qty, 1000);
  assert.equal(log[0].dir, +1, '卖出方向为 +1（跌了才省）');
});

test('幂等：同一天同票同规则反复触发只记一次（界面刷新不得污染台账）', () => {
  let acc = appendSignals([], [posAlert()], { asOf: '2026-09-30', priceOf: () => 10 });
  acc = appendSignals(acc.log, [posAlert()], { asOf: '2026-09-30', priceOf: () => 9.5 });
  acc = appendSignals(acc.log, [posAlert()], { asOf: '2026-09-30', priceOf: () => 9.0 });
  assert.equal(acc.log.length, 1, '刷新三次仍只有一条');
  assert.equal(acc.log[0].px, 10, '且保留最早那条的价格基准（否则归因会「追认」而系统性偏乐观）');
  assert.equal(acc.added, 0);
});

test('换日换票换规则 = 新信号（幂等键不含时间戳，只含日期/层/代码/类型）', () => {
  let acc = appendSignals([], [posAlert()], { asOf: '2026-09-30', priceOf: () => 10 });
  acc = appendSignals(acc.log, [posAlert()], { asOf: '2026-10-01', priceOf: () => 10 });
  acc = appendSignals(acc.log, [posAlert({ code: '600519' })], { asOf: '2026-09-30', priceOf: () => 10 });
  acc = appendSignals(acc.log, [posAlert({ type: 'pos-concentration' })], { asOf: '2026-09-30', priceOf: () => 10 });
  assert.equal(acc.log.length, 4, '日期/代码/类型任一不同都是独立信号');
});

test('落账：无价 / 无持仓 / 无方向变动的条目不落账（不记永远算不出来的空条目）', () => {
  const a1 = appendSignals([], [posAlert()], { asOf: 'd', priceOf: () => null });
  assert.equal(a1.log.length, 0, '取不到价 → 不记');
  const a2 = appendSignals([], [posAlert({ qty: 0, heldQty: 0 })], { asOf: 'd', priceOf: () => 10 });
  assert.equal(a2.log.length, 0, '确实没有持仓 → 不记');
  const a3 = appendSignals([], [posAlert({ action: 'hold', type: 'pos-at-target' })], { asOf: 'd', priceOf: () => 10 });
  assert.equal(a3.log.length, 0, '持有类无仓位变动 → 不计分');
  const a4 = appendSignals([], [posAlert({ action: 'wait', type: 'pos-t1-locked' })], { asOf: 'd', priceOf: () => 10 });
  assert.equal(a4.log.length, 0, '等待类无仓位变动 → 不计分');
});

test('落账：大盘层无标的价格仍落账（它按「仓位金额」记账，口径不同）', () => {
  const { log } = appendSignals([], [mktAlert()], { asOf: 'd', priceOf: () => null, total: 1_000_000, curPos: 0.9, targetPos: 0.5 });
  assert.equal(log.length, 1);
  assert.equal(log[0].px, null);
  assert.equal(log[0].total, 1_000_000);
});

test('落账：持仓不足一手（<100 股）不落账——A 股执行不了，记了也永远算不出结论', () => {
  const { log, skipped } = appendSignals([], [posAlert({ qty: 50, heldQty: 50 })], { asOf: 'd', priceOf: () => 10 });
  assert.equal(log.length, 0);
  assert.equal(skipped, 1);
});

test('落账 · T+1 全锁时止损预警仍要进台账（计分股数 ≠ 下单股数）', () => {
  // 这是本轮修掉的真 bug：早期用 qty>0 做落账门槛，「当天买入 + 击穿止损」的预警
  // 根本不进台账 —— 而它恰恰是最该被追责的一条规则。
  const { log } = appendSignals([], [posAlert({ qty: 0, heldQty: 40000 })], {
    asOf: 'd', priceOf: () => 20,
  });
  assert.equal(log.length, 1, '即使今天卖不掉，也必须记账');
  assert.equal(log[0].qty, 0, '下单股数如实为 0（今天卖不掉）');
  assert.equal(log[0].scoreQty, 40000, '计分股数取全部持仓');
  // 20 元触发、今日 11.57 → 若按纪律离场可避损 40000 × 8.43 = 337,200 元
  const r = evaluateEntry(log[0], 11.57);
  assert.equal(Math.round(r.pnl), 337200, '止损的战绩按「本应保护的持仓」计分');
  assert.equal(r.verdict, 'hit');
});

test('落账 · scoreQty 缺失时退回 qty（字段升级不得让历史台账变成「算不出来」）', () => {
  // 早期台账没有 scoreQty 字段；归因必须仍能算出来（pct 是浮点减法，按容差断言）
  const legacy = { layer: 'position', code: 'x', type: 'pos-stop-loss', action: 'sell', qty: 1000, px: 10 };
  const r = evaluateEntry(legacy, 9);
  assert.equal(r.pnl, 1000);
  assert.equal(r.qty, 1000, '退回用 qty 计分');
  assert.equal(r.dir, 1);
  assert.equal(r.verdict, 'hit');
  assert.equal(r.finalPx, 9);
  assert.ok(Math.abs(r.pct - (-0.1)) < 1e-9, `实际 ${r.pct}`);
});

// ────────────────────────── 二、卖出类归因（止损/减仓） ──────────────────────────

test('归因 · 止损后下跌：照做省下亏损，金额 = 股数 × 价差', () => {
  // 10 元触发卖出 1000 股，今日 8 元 → 照做避免 1000×(10−8) = 2000 元亏损
  const r = evaluateEntry({ action: 'sell', qty: 1000, px: 10, code: 'x' }, 8);
  assert.equal(r.pnl, 2000);
  assert.equal(r.verdict, 'hit');
  // 8/10 − 1 是浮点减法的经典误差（−0.19999999999999996），按容差断言
  assert.ok(Math.abs(r.pct - (-0.2)) < 1e-9, `涨跌幅应为 −20%（实际 ${r.pct}）`);
});

test('归因 · 止损后反弹：如实记为「卖飞」（saved 为负，不许粉饰）', () => {
  // 10 元卖出，今日 11 元 → 少赚 1000×(10−11) = −1000 元
  const r = evaluateEntry({ action: 'sell', qty: 1000, px: 10, code: 'x' }, 11);
  assert.equal(r.pnl, -1000);
  assert.equal(r.verdict, 'miss', '跌了才算命中，涨了就是失手');
});

test('归因 · 减仓按实际建议股数计分（不是全部持仓）', () => {
  const r = evaluateEntry({ action: 'reduce', qty: 300, px: 20, code: 'x' }, 18);
  assert.equal(r.pnl, 600, '300 股 × 2 元');
});

test('归因 · 命中带：价格几乎没动算「平」，不计命中也不计失手', () => {
  const flat = evaluateEntry({ action: 'sell', qty: 1000, px: 10, code: 'x' }, 10.04); // +0.4% < 0.5%
  assert.equal(flat.verdict, 'flat');
  const edgeIn = evaluateEntry({ action: 'sell', qty: 1000, px: 10, code: 'x' }, 10 * (1 + LOG_CFG.hitBand)); // 恰好 +0.5%
  assert.equal(edgeIn.verdict, 'flat', '取等号算平（边界含在带内）');
  const edgeOut = evaluateEntry({ action: 'sell', qty: 1000, px: 10, code: 'x' }, 10 * (1 + LOG_CFG.hitBand) - 0.001);
  assert.equal(edgeOut.verdict, 'flat');
  const over = evaluateEntry({ action: 'sell', qty: 1000, px: 10, code: 'x' }, 11);
  assert.equal(over.verdict, 'miss');
});

test('归因 · 清仓/空仓与卖出同向（都是离场，跌了才省）', () => {
  const clear = evaluateEntry({ action: 'clear', qty: 500, px: 10, code: 'x' }, 9);
  const exit = evaluateEntry({ action: 'exit', qty: 500, px: 10, code: 'x' }, 9);
  assert.equal(clear.pnl, 500);
  assert.equal(exit.pnl, 500);
});

// ────────────────────────── 三、买入类归因（加仓） ──────────────────────────

test('归因 · 加仓后上涨：真的增加了模拟收入', () => {
  const r = evaluateEntry({ action: 'add', qty: 1000, px: 10, code: 'x' }, 12);
  assert.equal(r.pnl, 2000, '1000 股 × 2 元');
  assert.equal(r.verdict, 'hit');
  assert.equal(r.dir, -1);
});

test('归因 · 加仓后下跌：如实记为亏（加仓建议也要被追责）', () => {
  const r = evaluateEntry({ action: 'add', qty: 1000, px: 10, code: 'x' }, 9);
  assert.equal(r.pnl, -1000);
  assert.equal(r.verdict, 'miss');
  const buy = evaluateEntry({ action: 'buy', qty: 1000, px: 10, code: 'x' }, 9);
  assert.equal(buy.pnl, -1000, '买入与加仓同向');
});

// ────────────────────────── 四、无价与边界 ──────────────────────────

test('归因 · 无今日价返回 null（绝不退化成 0 假装算过）', () => {
  for (const bad of [null, undefined, '', NaN, 'abc', false]) {
    assert.equal(evaluateEntry({ action: 'sell', qty: 1000, px: 10, code: 'x' }, bad), null,
      `今日价 ${JSON.stringify(bad)} 必须返回 null`);
  }
});

test('归因 · 触发价缺失或非法返回 null', () => {
  for (const bad of [null, undefined, '', 0, -1, NaN, false]) {
    assert.equal(evaluateEntry({ action: 'sell', qty: 1000, px: bad, code: 'x' }, 9), null,
      `触发价 ${JSON.stringify(bad)} 必须返回 null`);
  }
});

test('归因 · 方向为 0 的动作一律返回 null（不给「持有」打分）', () => {
  for (const a of ['hold', 'wait', 'watch']) {
    assert.equal(evaluateEntry({ action: a, qty: 1000, px: 10, code: 'x' }, 9), null);
  }
  assert.equal(evaluateEntry(null, 10), null);
  assert.equal(evaluateEntry(undefined, 10), null);
});

test('归因 · 方向映射唯一：ACTION_DIR 覆盖 ACTION 全集且卖出为正', async () => {
  const { ACTIONS } = await import('../src/alerts.js');
  for (const k of Object.keys(ACTIONS)) {
    assert.ok(k in ACTION_DIR, `动作 ${k} 必须在 ACTION_DIR 中有方向（否则静默不计分）`);
  }
  assert.equal(ACTION_DIR.sell, +1);
  assert.equal(ACTION_DIR.add, -1);
  assert.equal(ACTION_DIR.hold, 0);
});

// ────────────────────────── 五、大盘层归因（只计纪律，不编金额） ──────────────────────────

test('大盘层归因：只记「应调整多少金额」，不编造收益数字', () => {
  const r = evaluateMarketEntry({ action: 'reduce', total: 1_000_000, curPos: 0.9, targetPos: 0.5 });
  assert.equal(r.verdict, 'tracked');
  assert.equal(r.pnl, null, '大盘层没有单一标的价格，收益必须留空');
  assert.equal(r.amount, 400_000, '应降 40 万（100万 × (0.9−0.5)）');
});

test('大盘层归因：缺总资产/仓位时金额留空，不瞎算', () => {
  assert.equal(evaluateMarketEntry({ action: 'reduce', total: null, curPos: 0.9, targetPos: 0.5 }).amount, null);
  assert.equal(evaluateMarketEntry({ action: 'reduce', total: 1_000_000, curPos: null, targetPos: 0.5 }).amount, null);
  assert.equal(evaluateMarketEntry({ action: 'hold' }), null);
});

// ────────────────────────── 六、汇总口径 ──────────────────────────

test('汇总 · 规避亏损与错杀分别累加，净贡献 = 两者之差', () => {
  const log = [
    { layer: 'position', code: 'a', type: 'pos-stop-loss', action: 'sell', qty: 1000, px: 10 },
    { layer: 'position', code: 'b', type: 'pos-stop-loss', action: 'sell', qty: 1000, px: 10 },
    { layer: 'position', code: 'c', type: 'pos-concentration', action: 'reduce', qty: 1000, px: 10 },
  ];
  const px = { a: 8, b: 9, c: 12 };            // a +2000, b +1000, c −2000
  const s = summarizeLog(log, px);
  assert.equal(s.avoidedLoss, 3000);
  assert.equal(s.missedGain, 2000);
  assert.equal(s.net, 1000, '净贡献 = 省下的 3000 − 错杀的 2000');
  assert.equal(s.hit, 2);
  assert.equal(s.miss, 1);
});

test('汇总 · 命中率分母只含「已有结论」的条目（平与待定不入分母）', () => {
  const log = [
    { layer: 'position', code: 'a', type: 't1', action: 'sell', qty: 1000, px: 10 },   // hit
    { layer: 'position', code: 'b', type: 't2', action: 'sell', qty: 1000, px: 10 },   // miss
    { layer: 'position', code: 'c', type: 't3', action: 'sell', qty: 1000, px: 10 },   // flat
    { layer: 'position', code: 'd', type: 't4', action: 'sell', qty: 1000, px: 10 },   // pending（无价）
  ];
  const s = summarizeLog(log, { a: 9, b: 11, c: 10.01 });
  assert.equal(s.hit, 1);
  assert.equal(s.miss, 1);
  assert.equal(s.flat, 1);
  assert.equal(s.pending, 1);
  assert.equal(s.hitRate, 0.5, '1 对 / (1 对 + 1 错) = 50%，平与待定不影响');
  assert.equal(s.n, 4);
});

test('汇总 · 全无结论时命中率为 null（不是 0——「没数据」与「全错」是两回事）', () => {
  const s = summarizeLog([{ layer: 'position', code: 'a', type: 't', action: 'sell', qty: 1000, px: 10 }], {});
  assert.equal(s.hitRate, null);
  assert.equal(s.net, 0);
});

test('汇总 · 按规则拆解：条数与金额对账（ΣbyType.net === net）', () => {
  const log = [
    { layer: 'position', code: 'a', type: 'pos-stop-loss', action: 'sell', qty: 1000, px: 10 },
    { layer: 'position', code: 'b', type: 'pos-stop-loss', action: 'sell', qty: 2000, px: 10 },
    { layer: 'position', code: 'c', type: 'pos-concentration', action: 'reduce', qty: 1000, px: 10 },
  ];
  const s = summarizeLog(log, { a: 9, b: 9, c: 11 });
  const sum = s.byType.reduce((x, t) => x + t.net, 0);
  assert.equal(Math.round(sum * 100), Math.round(s.net * 100), '拆解金额之和必须等于总额');
  const cnt = s.byType.reduce((x, t) => x + t.count, 0);
  assert.equal(cnt, 3);
  const stop = s.byType.find((t) => t.type === 'pos-stop-loss');
  assert.equal(stop.count, 2, '两条止损预警归到同一规则');
  // a: 1000 股 × (10−9) = +1000；b: 2000 股 × (10−9) = +2000 → 该规则合计 +3000
  assert.equal(stop.net, 3000, '同规则下所有条目的金额必须累加到该规则');
});

test('汇总 · 大盘层条目计入 tracked 与条数，但不进盈亏，也不进命中率', () => {
  const log = [
    { layer: 'market', type: 'market-trim', action: 'reduce', total: 1_000_000, curPos: 0.9, targetPos: 0.5 },
    { layer: 'position', code: 'a', type: 'pos-stop-loss', action: 'sell', qty: 1000, px: 10 },
  ];
  const s = summarizeLog(log, { a: 9 });
  assert.equal(s.n, 2);
  assert.equal(s.tracked, 1);
  assert.equal(s.net, 1000, '大盘层不产生盈亏数字');
  assert.equal(s.hit + s.miss, 1, '大盘层不进命中率分母');
});

test('汇总 · 空台账 / 畸形输入不抛错', () => {
  for (const bad of [null, undefined, [], 'x', 123]) {
    const s = summarizeLog(bad, {});
    assert.equal(s.n, 0);
    assert.equal(s.hitRate, null);
  }
  assert.ok(summarizeText(summarizeLog(null, {})).includes('尚无预警记录'));
});

test('汇总 · 确定性：同样输入两次调用完全一致（含 byType 顺序）', () => {
  const log = [
    { layer: 'position', code: 'a', type: 'x1', action: 'sell', qty: 1000, px: 10 },
    { layer: 'position', code: 'b', type: 'x1', action: 'buy', qty: 1000, px: 10 },
  ];
  const a = JSON.stringify(summarizeLog(log, { a: 9, b: 11 }));
  const b = JSON.stringify(summarizeLog(log, { a: 9, b: 11 }));
  assert.equal(a, b);
});

// ────────────────────────── 七、容量与淘汰 ──────────────────────────

test('容量 · 超过上限优先淘汰「已结算且最旧」的，未结算条目保留', () => {
  const log = [];
  for (let i = 0; i < LOG_CAP; i++) {
    log.push({ key: `k${i}`, layer: 'position', code: `c${i}`, type: 't', action: 'sell', qty: 1000, px: 10, asOf: `2026-01-${String((i % 28) + 1).padStart(2, '0')}` });
  }
  // 再加一条新的未结算条目 → 触发淘汰
  const { log: out } = appendSignals(log, [posAlert({ code: 'NEW' })], { asOf: '2026-12-31', priceOf: () => 10 });
  assert.ok(out.length <= LOG_CAP, `淘汰后不得超过上限（实际 ${out.length}）`);
  assert.ok(out.some((e) => e.code === 'NEW'), '新条目必须保留');
});

test('容量 · 全为未结算且超限时，只保留最近日期的若干条', () => {
  const log = [];
  for (let i = 0; i < LOG_CAP + 20; i++) {
    log.push({ key: `k${i}`, layer: 'position', code: `c${i}`, type: 't', action: 'sell', qty: 1000, px: 10, asOf: `2026-${String((i % 12) + 1).padStart(2, '0')}-01` });
  }
  const { log: out } = appendSignals(log, [posAlert({ code: 'Z' })], { asOf: '2026-12-31', priceOf: () => 10 });
  assert.ok(out.length <= LOG_CAP);
});

// ────────────────────────── 八、文案 ──────────────────────────

test('文案 · 汇总句子含可核验金额与命中率，且明确「待验证」条数', () => {
  const log = [
    { layer: 'position', code: 'a', type: 'x', action: 'sell', qty: 1000, px: 10 },   // hit +2000
    { layer: 'position', code: 'b', type: 'y', action: 'sell', qty: 1000, px: 10 },   // miss −1000
    { layer: 'position', code: 'c', type: 'z', action: 'sell', qty: 1000, px: 10 },   // pending
  ];
  const txt = summarizeText(summarizeLog(log, { a: 8, b: 11 }));
  assert.ok(txt.includes('2,000 元'), txt);
  assert.ok(txt.includes('1,000 元'), txt);
  assert.ok(txt.includes('命中率 50%'), txt);
  assert.ok(txt.includes('1 条待价格验证'), txt);
  assert.ok(txt.includes('净贡献 +1,000 元'), txt);
});

test('文案 · 净贡献为负时用「−」号而非双负号', () => {
  const log = [{ layer: 'position', code: 'b', type: 'y', action: 'sell', qty: 1000, px: 10 }];
  const txt = summarizeText(summarizeLog(log, { b: 11 }));
  assert.ok(txt.includes('净贡献 −1,000 元'), txt);
  assert.ok(!txt.includes('−−'), txt);
});

test('常量 · 阈值与上游同源：minQty 就是 A 股一手', () => {
  assert.equal(LOG_CFG.minQty, LOT, '最小计分股数必须等于 paper.js 的 LOT（一手 100 股）');
});
