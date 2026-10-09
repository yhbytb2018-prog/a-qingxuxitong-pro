// 回测引擎测试：跨语言一致性（与 Python 工具夹具逐位比对）+ 语义断言 + 帕累托正确性
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  BASE_PARAMS, V52_PARAMS, positions, turnoverCost, metrics, runBacktest, poolBacktest,
  paretoFrontier, weightGrid, scoreWith, gridSearch, sortByRank,
} from '../src/backtest.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/parity_v52.json', import.meta.url), 'utf8'));

// 夹具参数键（Python 命名）→ 引擎参数键
const toParams = (p) => ({
  hi: p.hi, lo: p.lo, panic: p.panic, overheat: p.overheat,
  maxPos: p.max_pos ?? 1.0, stopLoss: p.stop_loss ?? 0,
  ddTrigger: p.dd_trigger ?? 0, maxPosChg: p.max_pos_chg ?? 0,
  comm: p.comm ?? 0, stamp: p.stamp ?? 0, slip: p.slip ?? 0,
  confirmDays: p.confirm_days ?? 0,           // V5.3 右侧二次确认（默认 0 = 旧行为）
  maxPosByDay: p.max_pos_by_day ?? null,      // V5.3 regime 逐日帽子（默认 null = 不用）
  takeProfit: p.take_profit ?? null,          // V5.3 止盈（默认 null = 旧行为；ladder 嵌套数组直传）
});

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol,
  `${msg}: JS=${a} PY=${b} 差=${Math.abs(a - b)} > ${tol}`);

const ints = ['trades', 'long_days', 'max_consec_loss'];

test('跨语言一致性：仓位/成本/策略收益/绩效 与 Python 夹具逐位一致', () => {
  for (const [name, c] of Object.entries(fx.single)) {
    const p = toParams(c.params);
    const r = runBacktest(fx.scores, fx.rets, p);
    r.pos.forEach((v, i) => close(v, c.positions[i], 1e-9, `${name}.positions[${i}]`));
    r.pos.forEach((_, i) => {
      const cost = turnoverCost(r.pos, p)[i];
      close(cost, c.cost[i], 1e-12, `${name}.cost[${i}]`);
      close(r.strat[i], c.strat[i], 1e-12, `${name}.strat[${i}]`);
    });
    const map = {
      total: 'total_ret', annual: 'annual', maxDd: 'max_dd', sharpe: 'sharpe',
      winRate: 'win_rate', profitRatio: 'profit_ratio', heldDays: 'long_days',
      emptyRatio: 'empty_ratio', opens: 'trades', calmar: 'calmar',
      sortino: 'sortino', maxConsecLoss: 'max_consec_loss',
    };
    for (const [js, py] of Object.entries(map)) {
      if (ints.includes(py)) assert.equal(r.perf[js], c.metrics[py], `${name}.${py}`);
      else close(r.perf[js], c.metrics[py], 1e-3, `${name}.${py}`);
    }
  }
});

test('跨语言一致性：多标的等权合成与 Python 夹具一致', () => {
  for (const [name, c] of Object.entries(fx.pool)) {
    const p = toParams(c.params);
    const { pos, strat, perf } = poolBacktest(fx.scores, fx.assets, p);
    pos.forEach((v, i) => close(v, c.pos[i], 1e-9, `pool.${name}.pos[${i}]`));
    strat.forEach((v, i) => close(v, c.strat[i], 1e-12, `pool.${name}.strat[${i}]`));
    close(perf.total, c.metrics.total_ret, 1e-3, `pool.${name}.total`);
    close(perf.maxDd, c.metrics.max_dd, 1e-3, `pool.${name}.maxDd`);
    assert.equal(perf.opens, c.metrics.trades, `pool.${name}.trades`);
  }
});

test('语义：T+1 生效——首日仓位恒为 0（信号只影响次日）', () => {
  const pos = positions([70, 70, 70], [0.01, 0.01, 0.01], BASE_PARAMS);
  assert.equal(pos[0], 0, '首日不建仓（T+1）');
  assert.equal(pos[1], 1, '首日强信号应在次日生效为满仓');
  assert.equal(pos.length, 3);
});

test('语义：过热区(≥overheat)只减仓不新建——空仓者保持空仓', () => {
  const pos = positions([85, 85, 85, 85], [0.01, 0.01, 0.01, 0.01], BASE_PARAMS);
  assert.deepEqual(pos, [0, 0, 0, 0]);
  // 已持仓者不新建但也未被清仓：先正常持有，再进入过热区
  const mixed = positions([70, 70, 85, 85, 85], [0.01, 0.01, 0.01, 0.01, 0.01], BASE_PARAMS);
  assert.equal(mixed[1], 1, '正常区满仓');
  assert.equal(mixed[2], 1, '过热区保持既有仓位（不清仓）');
});

test('语义：止损优先于仓位平滑（清仓跳变不受上限约束）', () => {
  const rets = [0, 0.001, 0.001, 0.001, 0.001, 0.001, -0.09, 0.001, 0.001];
  const scores = [70, 70, 70, 70, 70, 70, 70, 70, 70];
  const pos = positions(scores, rets, { ...BASE_PARAMS, maxPosChg: 0.2, stopLoss: -0.08 });
  assert.equal(pos[6], 1, '第6日前已渐近满仓');
  assert.equal(pos[7], 0, '第6日暴跌 9% → 次日强制清仓');
  assert.ok(Math.abs(pos[7] - pos[6]) > 0.2, '清仓跳变超过平滑上限 → 证明止损绕过平滑');
});

test('语义：仓位平滑把单日变动压在上限内（止损除外）', () => {
  const rets = new Array(12).fill(0.001);
  const scores = new Array(12).fill(70);
  const pos = positions(scores, rets, { ...BASE_PARAMS, maxPosChg: 0.2 });
  for (let i = 1; i < pos.length; i++) {
    assert.ok(Math.abs(pos[i] - pos[i - 1]) <= 0.2 + 1e-12, `第${i}日跳变超限`);
  }
  assert.equal(pos[pos.length - 1], 1, '持续强信号应最终到满仓');
});

test('语义：交易成本买卖不对称（卖出含印花税）', () => {
  const pos = [0.5, 1.0, 1.0, 0.0];
  const cost = turnoverCost(pos, { comm: 0.0003, stamp: 0.0005, slip: 0.0002 });
  close(cost[0], 0.5 * 0.0005, 1e-15, '首日建仓=买入口径');
  close(cost[1], 0.5 * 0.0005, 1e-15, '加仓=买入口径');
  assert.equal(cost[2], 0, '持仓不动无成本');
  close(cost[3], 1.0 * 0.001, 1e-15, '清仓=卖出口径(含印花税)');
});

test('帕累托：与 O(n²) 暴力法解集内容一致', () => {
  const rnd = (seed) => { let s = seed; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; };
  const r = rnd(7);
  const rows = Array.from({ length: 300 }, () => ({
    sharpe: r() * 4 - 2, maxDd: 0.05 + r() * 0.35, calmar: r() * 2 - 1,
  }));
  const fast = paretoFrontier(rows);
  const arr = rows.map((x) => [x.sharpe, x.maxDd]);
  const brute = rows.filter((_, i) => !arr.some(([s, d], j) => s > arr[i][0] + 1e-12 && d < arr[i][1] - 1e-12));
  const key = (x) => `${x.sharpe.toFixed(9)}|${x.maxDd.toFixed(9)}`;
  assert.deepEqual([...new Set(fast.map(key))].sort(), [...new Set(brute.map(key))].sort());
});

test('权重网格：和为 1，且全 1.0 步长时归一化等于基准权重', () => {
  const base = { a: 0.2, b: 0.3, c: 0.5 };
  const grid = weightGrid(base, [0.8, 1.0, 1.2]);
  assert.equal(grid.length, 27);
  for (const w of grid) close(Object.values(w).reduce((x, y) => x + y, 0), 1, 1e-12, '权重和');
  const one = weightGrid(base, [1.0])[0];
  for (const k of Object.keys(base)) close(one[k], base[k], 1e-12, `基准权重 ${k}`);
});

test('打分键校验：权重键与因子键完全错配时报错（防静默全 0 分）', () => {
  const factors = [{ s_net: 80, s_pos: 60 }];
  assert.throws(() => scoreWith(factors, { s_net20: 0.5, s_pos10: 0.5 }), /不匹配/);
  assert.deepEqual(scoreWith(factors, { s_net: 0.5, s_pos: 0.5 }), [70]);
});

test('网格寻优：结果非退化（回归：曾因权重键错配导致全部结果为 0）', () => {
  const days = 40;
  const factors = Array.from({ length: days }, (_, i) => ({
    s_net: 40 + (i * 7) % 55, s_pos: 35 + (i * 11) % 60, s_brd: 45 + (i * 3) % 50,
  }));
  const rets = { X: Array.from({ length: days }, (_, i) => Math.sin(i) * 0.01) };
  const base = { s_net: 0.4, s_pos: 0.3, s_brd: 0.3 };
  const scan = gridSearch(factors, rets, base, BASE_PARAMS, [0.8, 1.0, 1.2]);
  const uniq = new Set(scan.map((r) => `${r.sharpe}|${r.maxDd}`));
  assert.ok(uniq.size > 1, `网格结果应有多个不同结果，实际 ${uniq.size}`);
  assert.ok(scan.every((r) => Number.isFinite(r.sharpe)), '夏普应有限');
  assert.equal(sortByRank(scan)[0].maxDd, Math.min(...scan.map((r) => r.maxDd)), '排序首位应为最小回撤');
});

test('绩效指标：年化与最大回撤在构造序列上取预期值', () => {
  const strat = [0.01, -0.02, 0.03, -0.01];
  const pos = [1, 1, 1, 1];
  const m = metrics(strat, pos, 1);
  close(m.nav.at(-1), 1.01 * 0.98 * 1.03 * 0.99, 1e-12, '净值终值');
  close(m.maxDd, 1 - (1.01 * 0.98) / 1.01, 1e-12, '最大回撤');
  assert.equal(m.opens, 1);
  assert.equal(m.heldDays, 4);
  assert.equal(m.maxConsecLoss, 1);
});

test('默认参数：V5.2 增强口径只应在成本/风控维度区别于基准', () => {
  assert.equal(BASE_PARAMS.comm, 0);
  assert.equal(BASE_PARAMS.stopLoss, 0);
  assert.ok(V52_PARAMS.comm > 0 && V52_PARAMS.stopLoss < 0 && V52_PARAMS.maxPosChg > 0);
  assert.equal(BASE_PARAMS.hi, 44);
  assert.equal(BASE_PARAMS.lo, 65);
});

test('阈值表 ↔ positions 行为一致：研判报告的仓位档位文案必须对应引擎实际仓位', () => {
  const p = { ...BASE_PARAMS };
  // 取「次日仓位」：喂两天同分序列，取 pos[1]（T+1 生效后），rets=null 以屏蔽回撤降仓
  const at = (s) => positions([s, s], null, p)[1];
  assert.equal(at(p.overheat), 0, '≥overheat：空仓不新建（过热只减不新建）');
  assert.equal(at(p.overheat + 5), 0, '远超过热同样不新建');
  assert.equal(at(p.lo), 1, '=lo：满仓');
  assert.equal(at(p.lo - 1), 0.5, '略低于 lo：半仓');
  assert.equal(at(p.panic + 1), 0.5, '略高于 panic：半仓（hi 不参与判档，24~65 同属半仓）');
  assert.equal(at(p.panic), 0, '≤panic：清仓');
  assert.equal(at(p.panic - 1), 0, '低于 panic：清仓');
  // 已持有的过热场景：保留仓位而非清仓——这是「只减仓不新建」的关键语义
  assert.equal(positions([p.lo, p.overheat], null, p)[1], 1, '持有中遇过热：保留仓位而非清仓');
});

// ── V5.3 新语义：右侧二次确认 + regime 逐日帽子（默认关闭时与旧版逐位一致）──

test('V5.3 confirmDays=0：默认行为锚——持仓中半仓档保持 0.5，不因确认计数清仓', () => {
  // ⚠ 行为锚（非同义反复对照）：第一版实现漏 held 条件，持仓中 pending 恒 0 →
  //   半仓持有被误清仓，且 confirmDays=0 时也触发——跨语言夹具两侧同错测不出
  //   （夹具由同版 Python 生成），必须用独立行为断言锁死。
  const scores = [70, 45, 45, 45, 30, 66];   // 开仓→半仓档持有→回落仍半仓→回升全仓
  const rets = scores.map(() => 0.005);
  for (const cd of [0, 1, 3]) {
    // 用无平滑/无止损的 BASE 口径：直接看确认逻辑本身（平滑会把 0.5 钳到别的值）
    const pos = positions(scores, rets, { ...BASE_PARAMS, confirmDays: cd });
    assert.equal(pos[2], 0.5, `confirmDays=${cd}：持仓中半仓档保持半仓（不被确认逻辑清仓）`);
  }
  // confirmDays=0（默认）：空仓首日半仓信号次日即进场（与 V5.2 行为一致；
  // 用无平滑 BASE 口径——平滑会把 0.5 钳到 0.2，那是平滑语义不是确认语义）
  const p0 = positions([20, 30, 31], [0.001, 0.001, 0.001], BASE_PARAMS);
  assert.equal(p0[2], 0.5, '默认（confirmDays=0）首日信号次日进场——旧行为');
});

test('V5.3 confirmDays=1：半仓档开仓需连续 2 日信号（右侧二次确认，杜绝接飞刀）', () => {
  const p = { ...BASE_PARAMS };
  const rets = [0.001, 0.001, 0.001, 0.001, 0.001];
  // 单日脉冲（V 型单点回升）→ 不开仓：反转未确认
  assert.deepEqual(
    positions([20, 30, 20, 20, 20], rets, { ...p, confirmDays: 1 }).slice(1),
    [0, 0, 0, 0], '单日回升脉冲不进场（右侧确认拦截）');
  // 连续 2 日回升 → 第 2 日确认，T+1 后进场半仓
  const pos = positions([20, 30, 31, 20, 20], rets, { ...p, confirmDays: 1 });
  assert.equal(pos[2], 0, '第 1 日信号只记账');
  assert.equal(pos[3], 0.5, '第 2 日仍成立 → 次日半仓进场');
  // confirmDays=0（旧行为）：第 1 日即进场——对照证明确认语义真实生效
  const pos0 = positions([20, 30, 31, 20, 20], rets, p);
  assert.equal(pos0[2], 0.5, '旧行为第 1 日信号次日即进场');
  assert.notDeepEqual(pos, pos0, '确认开启与关闭必须产生差异（防探针瞎）');
});

test('V5.3 confirmDays：强信号（v≥lo）与止损/过热/清仓路径不受确认约束', () => {
  const p = { ...BASE_PARAMS };
  const rets = [0.001, 0.001, 0.001, 0.001];
  // v≥lo 是趋势强信号（右侧本身），不排队确认
  assert.equal(positions([20, 70, 70, 70], rets, { ...p, confirmDays: 1 })[2], 1, '强信号直接满仓');
  // 已持仓的过热/清仓照旧（确认只管开仓）
  assert.equal(positions([70, 85, 20, 20], rets, { ...p, confirmDays: 3 })[2], 1, '持仓过热保留');
  assert.equal(positions([70, 20, 20, 20], rets, { ...p, confirmDays: 3 })[2], 0, '清仓不受确认影响');
});

test('V5.3 maxPosByDay：regime 帽子逐日压制 cap（与回撤降仓取更紧）', () => {
  const p = { ...BASE_PARAMS };
  const scores = [70, 70, 70, 70];
  const rets = [0.001, 0.001, 0.001, 0.001];
  const cap0 = positions(scores, rets, { ...p, maxPosByDay: [1.0, 0.3, 1.0, 1.0] });
  // T+1：pos[1]=day0 帽子(1.0) → 1；pos[2]=day1 帽子(0.3) → 0.3
  assert.equal(cap0[1], 1, '帽子 1.0 日不压制');
  assert.equal(cap0[2], 0.3, '切换期帽子 0.3 压制满仓信号');
  // 缺失日（null/非有限数）不压制——引擎不假装有帽子
  const sparse = positions(scores, rets, { ...p, maxPosByDay: [null, 0.3, undefined, NaN] });
  assert.equal(sparse[1], 1, '帽子缺失日不压制（缺失显式化在调用方）');
  assert.equal(sparse[2], 0.3);
  assert.equal(sparse[3], 1, 'NaN/undefined 同样不压制');
  // 与回撤降仓取更紧：dd cap 0.4 与帽子 0.3 → 0.3
  const tight = positions(scores, [0.001, 0.001, -0.2, 0.001], { ...p, ddTrigger: -0.15, maxPosByDay: [1, 1, 0.3, 1] });
  assert.ok(tight[3] <= 0.3, '帽子与降仓取更紧者');
});

test('V5.3 夹具 v53 组：右侧确认 + regime 帽子的跨语言逐位一致（parity 锁）', () => {
  const c = fx.single.v53;
  assert.ok(c.params.confirm_days === 1, '夹具必须携带 v53 新参数');
  const p = toParams(c.params);
  const r = runBacktest(fx.scores, fx.rets, p);
  r.pos.forEach((v, i) => close(v, c.positions[i], 1e-9, `v53.positions[${i}]`));
  r.pos.forEach((_, i) => close(r.strat[i], c.strat[i], 1e-12, `v53.strat[${i}]`));
  close(r.perf.sharpe, c.metrics.sharpe, 1e-3, 'v53.sharpe');
  assert.equal(r.perf.opens, c.metrics.trades, 'v53.trades');
});

// ── V5.3 止盈（takeProfit）：分批/移动，默认 null 时与旧版逐位一致 ──────────

test('V5.3 takeProfit=null：默认行为锚——与不带参数的调用逐位一致', () => {
  // 行为锚（held-bug 教训的固化）：跨语言夹具测不出"两侧同错"，默认路径不变
  // 必须用独立断言锁死。止盈是状态机扩展（腿路径/档位），错一个重置时机就会
  // 污染全部旧口径。
  const scores = [70, 45, 30, 66, 72, 50, 26, 68, 71, 44];
  const rets = [0.01, -0.02, 0.03, 0.015, -0.01, 0.02, -0.03, 0.01, 0.005, -0.02];
  for (const base of [BASE_PARAMS, V52_PARAMS]) {
    const a = positions(scores, rets, base);
    const b = positions(scores, rets, { ...base, takeProfit: null });
    const c = positions(scores, rets, { ...base, takeProfit: { mode: 'none' } });
    assert.deepEqual(b, a, 'takeProfit 显式 null 必须与缺省逐位一致');
    assert.deepEqual(c, a, 'mode=none（关闭）必须旁路全部止盈逻辑');
  }
});

test('V5.3 分批止盈：+8% 减半 → +15% 清仓 → 信号仍在则重开（腿状态重置）', () => {
  const p = { ...BASE_PARAMS, takeProfit: { mode: 'partial', ladder: [[1.08, 0.5], [1.15, 0]] } };
  const scores = Array(20).fill(70);            // 持续强信号：隔离止盈语义
  const rets = [...Array(16).fill(0.01), ...Array(4).fill(0.005)];
  const pos = positions(scores, rets, p);
  // T+1 链：day0 决定满仓 → pos[1..8]=1；1.01^8≈1.0829 于 day8 结算触发第一档
  // → day9 起半仓；1.01^15≈1.1610 于 day15 触发第二档 → day16 清仓；
  // day16 空仓日腿重置 + 信号仍在 → day17 重开满仓（新腿、tier 归零）
  assert.equal(pos[8], 1, '触发前满仓');
  assert.equal(pos[9], 0.5, '+8% 第一档：次日减半');
  assert.equal(pos[15], 0.5, '持有半仓直到第二档');
  assert.equal(pos[16], 0, '+15% 第二档：次日清仓');
  assert.equal(pos[17], 1, '清仓后信号仍满足 → 重开新腿（tier 重置，非 0.5）');
  assert.equal(pos[19], 1, '新腿满仓');
});

test('V5.3 分批止盈：档位只升不降（回踩后再涨不重复触发低档）', () => {
  const p = { ...BASE_PARAMS, takeProfit: { mode: 'partial', ladder: [[1.05, 0.5]] } };
  const scores = Array(12).fill(70);
  // 涨 6%（触发第一档）→ 回踩到 +3%（仍持仓半仓）→ 再涨回 +5%：不得再触发/不得恢复满仓
  const rets = [0.01, 0.01, 0.01, 0.01, 0.01, 0.01, -0.03, 0.02, 0.01, 0.01, 0.01, 0.01];
  const pos = positions(scores, rets, p);
  const afterRetrace = pos.slice(8, 12);
  assert.ok(afterRetrace.every((v) => v === 0.5), '回踩后保持半仓（档位不回退、不重复触发）');
});

test('V5.3 移动止盈：浮盈激活后回撤 ≥trail 离场；未激活/回撤不足不触发（防误杀）', () => {
  const p = { ...BASE_PARAMS, takeProfit: { mode: 'trailing', trail: 0.3, activate: 1.05 } };
  const scores = Array(20).fill(70);
  // 腿从 day1 起累积（day0 只决定、day1 生效——rets[0] 不进腿）：
  // day1~3 各 +3% → 1.0927（≥activate 激活）；day4 -4% → 回撤 4% 不触发；
  // day5 -20% → 回撤 23.2% 不触发；day6 -20% → 回撤 38.6% ≥ 30% 触发 → day7 离场；
  // day7 空仓重置 + 信号在 → day8 重开新腿
  const rets = [...Array(4).fill(0.03), -0.04, -0.2, -0.2, ...Array(13).fill(0.01)];
  const pos = positions(scores, rets, p);
  assert.equal(pos[6], 1, '回撤 23.2%：不足 30% 继续持有');
  assert.equal(pos[7], 0, '回撤 38.6% ≥ 30%：次日清仓');
  assert.equal(pos[8], 1, '离场后信号仍满足 → 重开（新腿重新跟踪）');
  assert.equal(pos[19], 1, '新腿保持');
});

test('V5.3 移动止盈：浮亏阶段不触发（激活线之下归止损管，不越权）', () => {
  const p = { ...BASE_PARAMS, takeProfit: { mode: 'trailing', trail: 0.3, activate: 1.05 } };
  const scores = Array(8).fill(70);
  // 先 -8%（浮亏，峰值 1.0 从未到 activate）→ 再 -20%（相对峰值回撤巨大但未激活）
  const rets = [-0.08, -0.2, -0.2, 0.001, 0.001, 0.001, 0.001, 0.001];
  const pos = positions(scores, rets, p);
  assert.ok(pos.slice(1, 6).every((v) => v === 1), '浮亏阶段移动止盈不触发（无止损参数时保持仓位）');
});

test('V5.3 移动止盈：离场不受仓位平滑约束（风控优先，与止损同级）', () => {
  const p = {
    ...BASE_PARAMS, maxPosChg: 0.2,
    takeProfit: { mode: 'trailing', trail: 0.3, activate: 1.05 },
  };
  const scores = Array(12).fill(70);
  const rets = [...Array(4).fill(0.03), -0.04, -0.2, -0.2, ...Array(5).fill(0.01)];
  const pos = positions(scores, rets, p);
  assert.equal(pos[7], 0, '回撤触发的清仓必须一日到位（不被 ±0.2 平滑拖住）');
});

test('V5.3 夹具 tp 段：分批/移动止盈的跨语言逐位一致（parity 锁）', () => {
  assert.ok(fx.tp && fx.tp.partial && fx.tp.trail, '夹具必须含 tp 段');
  for (const name of ['partial', 'trail']) {
    const c = fx.tp[name];
    const p = toParams(c.params);
    const r = runBacktest(c.scores, c.rets, p);
    r.pos.forEach((v, i) => close(v, c.positions[i], 1e-9, `tp.${name}.positions[${i}]`));
    r.pos.forEach((_, i) => close(r.strat[i], c.strat[i], 1e-12, `tp.${name}.strat[${i}]`));
    assert.equal(r.perf.opens, c.metrics.trades, `tp.${name}.trades`);
  }
  // 夹具触发性守卫：路径必须真的触发过止盈（防"两侧同错且都不触发"的瞎夹具）
  const pp = fx.tp.partial.positions;
  assert.ok(pp.includes(0.5) && pp.includes(0), 'partial 夹具必须含减半与清仓形态');
  assert.ok(pp[pp.length - 1] === 1, 'partial 夹具必须锁定重开新腿形态');
});
