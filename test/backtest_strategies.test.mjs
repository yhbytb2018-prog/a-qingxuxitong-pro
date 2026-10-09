// ③ 策略回测核心的单测 —— 锁死 point-in-time 时点纪律与收益计算正确性。
//
// 「作弊探针」是本文件的核心手法：给 entryOf/exitOf 传一个**只看入参下标 i**、但被
// 断言「从未收到越界信息」的探针。buildTrades 的契约是「只以 i 调用判定函数」——
// 只要模型不把未来切片递给判定函数，探针就无法感知任何 i 之外的信息，回测的前视
// 偏差在构造上不可能发生。若未来有人改动 buildTrades 把整段 days 传给判定函数，
// 这里的探针结构（闭包捕获独立状态 + 显式下标断言）会让回归立刻显形。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metrics, buildTrades, tradeReturns, buildNav, ROUND_COST } from '../src/strategy_bt.js';

// 合成 K 线：10 日，open=100 平开，close 每日 +1%
const mkK = (n, o0 = 100) => Array.from({ length: n }, (_, t) => ({ date: `2026-01-${String(t + 1).padStart(2, '0')}`, open: o0, close: o0 * Math.pow(1.01, t) }));
// 合成信号日：与 K 线同日期
const mkDays = (n) => Array.from({ length: n }, (_, i) => ({ trade_date: `2026-01-${String(i + 1).padStart(2, '0')}` }));
const mkKIdx = (n, klen) => { const a = Array.from({ length: n }, (_, i) => i); a._klineLen = klen; return a; };

test('bt: 时点纪律 —— entry/exit 判定只以单下标调用（作弊探针无法感知未来）', () => {
  const days = mkDays(10); const kIdx = mkKIdx(10, 10);
  const seen = [];
  const entryOf = (i) => { seen.push(i); return i === 2; }; // 第 3 天入场
  const exitOf = (j) => j >= 4;                              // 第 5 天起触发离场
  const trades = buildTrades(days, kIdx, entryOf, exitOf, 3, null);
  // 信号下标集合必须 ⊆ [0, days.length)——判定函数从未收到任何「切片/未来数组」
  assert.ok(seen.every((i) => Number.isInteger(i) && i >= 0 && i < days.length));
  // i=2 信号 → entryK=3（T+1 开盘）；持有 3 日到期 exitK=5（第 3/4/5 根K线，第 5 收盘卖）
  // 提前离场：j=4 的信号次日 kj+1=5 ≤ exitK=5 → 出场提前到第 5 根K线**开盘**卖
  assert.equal(trades.length, 1);
  assert.equal(trades[0].entryK, 3);
  assert.equal(trades[0].exitK, 5);
  assert.equal(trades[0].exitAtOpen, true);
});

test('bt: 到期出场 —— 无提前离场时第 N 日收盘卖出', () => {
  const days = mkDays(10); const kIdx = mkKIdx(10, 10);
  const trades = buildTrades(days, kIdx, (i) => i === 0, null, 3, null);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].entryK, 1);   // T+1
  assert.equal(trades[0].exitK, 3);    // entryK + 3 - 1
  assert.equal(trades[0].exitAtOpen, false);
});

test('bt: 持仓期重叠信号被忽略（不加仓不滚动）', () => {
  const days = mkDays(10); const kIdx = mkKIdx(10, 14); // K线区间比信号日长（尾部持有期可走完）
  // 每天都触发入场 → 持有 5 日时只有 i=0 和 i=5（entryK=6 > lastExitK=5，不重叠）两笔
  const trades = buildTrades(days, kIdx, () => true, null, 5, null);
  assert.equal(trades.length, 2);
  assert.equal(trades[0].signalDay, days[0].trade_date);
  assert.equal(trades[1].signalDay, days[5].trade_date);
});

test('bt: 持有期未走完的尾部信号不计入（未到期≠盈利）', () => {
  const days = mkDays(8); const kIdx = mkKIdx(8, 10);
  // i=7 → entryK=8, holdN=3 → exitK=10 ≥ klen → 必须被丢弃
  const trades = buildTrades(days, kIdx, (i) => i === 7, null, 3, null);
  assert.equal(trades.length, 0);
});

test('bt: 逐笔收益 —— T+1 开盘买、T+N 收盘卖、扣往返成本', () => {
  const k = mkK(10);
  const trades = [{ signalDay: '2026-01-01', entryK: 1, exitK: 3, exitAtOpen: false, members: null }];
  const tr = tradeReturns(trades, () => k);
  const expect = (k[3].close / k[1].open) * (1 - ROUND_COST) - 1;
  assert.ok(Math.abs(tr[0].ret - expect) < 1e-12);
  assert.ok(tr[0].ret > 0, '合成上涨K线应为正收益');
});

test('bt: 提前离场按次日开盘价成交', () => {
  const k = mkK(10);
  const trades = [{ signalDay: '2026-01-01', entryK: 1, exitK: 4, exitAtOpen: true, members: null }];
  const tr = tradeReturns(trades, () => k);
  const expect = (k[4].open / k[1].open) * (1 - ROUND_COST) - 1;
  assert.ok(Math.abs(tr[0].ret - expect) < 1e-12);
});

test('bt: 等权组合收益 = 成员独立收益均值（缺行情成员剔除）', () => {
  const kA = mkK(10);             // 每日 +1%
  const kB = mkK(10, 50);         // 同斜率
  const trades = [{ signalDay: '2026-01-01', entryK: 1, exitK: 3, exitAtOpen: false, members: ['a', 'b', 'missing'] }];
  const tr = tradeReturns(trades, (sym) => (sym === 'a' ? kA : sym === 'b' ? kB : null));
  assert.equal(tr[0].members, 2);
  assert.equal(tr[0].dropped, 1);
  const expect = ((kA[3].close / kA[1].open) * (1 - ROUND_COST) - 1); // 两成员同斜率 → 均值=单值
  assert.ok(Math.abs(tr[0].ret - expect) < 1e-9);
});

test('bt: 净值曲线 —— 持仓日吃指数收益、空仓日走平', () => {
  const k = mkK(10);
  const trades = [{ signalDay: '2026-01-01', entryK: 2, exitK: 4, exitAtOpen: false, members: null }];
  const nav = buildNav(trades, () => k, 0, 9);
  assert.equal(nav.length, 10);
  // 空仓日 [0,1]：净值恒 1
  assert.equal(nav[0], 1); assert.equal(nav[1], 1);
  // 入场日 2：close/open - 1
  const r2 = k[2].close / k[2].open - 1;
  assert.ok(Math.abs(nav[2] - (1 + r2)) < 1e-12);
  // 持有日 3,4：close/close
  assert.ok(Math.abs(nav[3] - nav[2] * (k[3].close / k[2].close)) < 1e-12);
  assert.ok(Math.abs(nav[4] - nav[3] * (k[4].close / k[3].close)) < 1e-12);
  // 空仓日 [5,9]：与 nav[4] 相等
  for (let t = 5; t <= 9; t++) assert.equal(nav[t], nav[4]);
});

test('bt: metrics —— 合成 +1%/日序列的年化/回撤/胜率', () => {
  const nav = Array.from({ length: 253 }, (_, i) => Math.pow(1.01, i));
  const m = metrics(nav, [0.01, 0.01, -0.005]);
  // metrics 内部 r4 舍入到 1e-4 —— 断言容差用 2e-4
  assert.ok(Math.abs(m.total - (Math.pow(1.01, 252) - 1)) < 2e-4);
  assert.ok(m.maxDd === 0, '单调上涨无回撤');
  assert.ok(Math.abs(m.annual - (Math.pow(1.01, 252) - 1)) < 2e-4);
  assert.ok(Math.abs(m.winRate - 2 / 3) < 2e-4);
  assert.ok(Math.abs(m.plRatio - 2) < 2e-4, '平均盈利 0.01 / 平均亏损 0.005 = 2');
});

test('bt: metrics —— 空序列/单点序列全部输出 null（不编数）', () => {
  const m = metrics([1], [0.02]);
  assert.equal(m.total, null); assert.equal(m.sharpe, null);
  const m0 = metrics([], []);
  assert.equal(m0.total, null);
});
