// 涨停池情绪周期单测（2026-10-08）：computeEmotionMetrics 六指标逐位、classifyEmotion
// 六状态与优先级、computeEmotionScore 区间与示例日手算闭环、空池 no_data、边界值
// （恰等阈值一律归「非触发侧」，与规格的严格不等号一致）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeEmotionMetrics, classifyEmotion, computeEmotionScore, computeEmotion, EMOTION_RULES,
} from '../src/emotion_cycle.js';

/** 造涨停池条目：默认硬板首板电池股，over 覆盖任意字段 */
const st = (over = {}) => ({
  c: '000001', m: 0, n: 'X', p: 10000, zdp: 10, amount: 1e8,
  ltsz: 1e9, tshare: 1e9, hs: 1, lbc: 1, fbt: 92500, lbt: 92500,
  fund: 1e8, zbc: 0, hybk: '电池', zttj: { days: 1, ct: 1 }, ...over,
});

/** 造 n 只股票的池：lbc/zbc/hybk 可用函数按索引定制 */
const mkPool = (n, f = () => ({})) => Array.from({ length: n }, (_, i) => st(f(i)));

test('指标计算：混合池六指标 + theme_top 逐位断言', () => {
  const pool = [
    st({ c: '1', lbc: 3, zbc: 0, hybk: '电池' }),
    st({ c: '2', lbc: 2, zbc: 1, hybk: '电池' }),
    st({ c: '3', lbc: 1, zbc: 2, hybk: '出版' }),
    st({ c: '4', lbc: 1, zbc: 0, hybk: null }),
    st({ c: '5', lbc: 1, zbc: 0, hybk: undefined }),
  ];
  const m = computeEmotionMetrics(pool);
  assert.equal(m.limit_up_count, 5);
  assert.equal(m.continuous_count, 2);        // lbc 3,2
  assert.equal(m.max_board, 3);
  assert.equal(m.broken_rate, 0.4);           // 2/5
  assert.equal(m.hard_board_rate, 0.6);       // 3/5
  assert.ok(Math.abs(m.broken_rate + m.hard_board_rate - 1) < 1e-9);
  assert.equal(m.theme_concentration, 0.4);  // 电池 2/5
  assert.equal(m.theme_top, '电池');         // 缺失 hybk 条目计入分母不计数
});

test('指标计算：全缺失 hybk → theme_concentration/top 为 null，其余正常', () => {
  const m = computeEmotionMetrics(mkPool(10, (i) => ({ lbc: i < 3 ? 2 : 1, hybk: null })));
  assert.equal(m.limit_up_count, 10);
  assert.equal(m.continuous_count, 3);
  assert.equal(m.theme_concentration, null);
  assert.equal(m.theme_top, null);
});

test('指标计算：lbc/zbc 非法值按保守缺省（1/0）处理', () => {
  const m = computeEmotionMetrics([st({ lbc: 'x', zbc: NaN }), st({ lbc: 2.7, zbc: 1.2 })]);
  assert.equal(m.continuous_count, 1);  // 'x'→1；2.7→trunc 2
  assert.equal(m.max_board, 2);
  assert.equal(m.broken_rate, 0.5);     // NaN→0 不炸；1.2→1 炸
});

test('状态判定：冰点（涨停<30 且炸板率>40%）', () => {
  const m = computeEmotionMetrics(mkPool(25, () => ({ zbc: 1 })));
  assert.equal(m.limit_up_count, 25);
  assert.equal(m.broken_rate, 1);
  assert.equal(classifyEmotion(m), '冰点');
});

test('状态判定：高潮（涨停>100 且封板强度>70%）', () => {
  const m = computeEmotionMetrics(mkPool(101, () => ({}))); // 全硬板
  assert.equal(classifyEmotion(m), '高潮');
});

test('状态判定：主升（涨停>60 且连板>15 且集中度>0.3）', () => {
  const pool = mkPool(65, (i) => ({ lbc: i < 16 ? 2 : 1, hybk: i < 21 ? '电池' : null }));
  const m = computeEmotionMetrics(pool);
  assert.equal(m.continuous_count, 16);
  assert.equal(m.theme_concentration, Math.round((21 / 65) * 10000) / 10000); // r4(21/65)=0.3231
  assert.ok(m.theme_concentration > 0.3);
  assert.equal(classifyEmotion(m), '主升');
});

test('状态判定：复苏（涨停升且炸板率降，需 prev）', () => {
  const prev = computeEmotionMetrics(mkPool(40, () => ({ zbc: 1 })));  // 炸板率 1.0
  const cur = computeEmotionMetrics(mkPool(50, () => ({ zbc: 0 })));   // 炸板率 0
  assert.equal(classifyEmotion(cur, prev), '复苏');
});

test('状态判定：退潮（炸板率>40% 且最高板降，需 prev）', () => {
  const prev = computeEmotionMetrics(mkPool(50, (i) => ({ lbc: i < 10 ? 5 : 1, zbc: 0 })));
  const cur = computeEmotionMetrics(mkPool(50, (i) => ({ lbc: i < 10 ? 2 : 1, zbc: 1 })));
  assert.equal(cur.broken_rate, 1);
  assert.ok(cur.max_board < prev.max_board);
  assert.equal(classifyEmotion(cur, prev), '退潮');
});

test('状态判定：普通日 → 震荡兜底', () => {
  const m = computeEmotionMetrics(mkPool(45, () => ({ lbc: 2, hybk: '分散' })));
  assert.equal(classifyEmotion(m), '震荡');
});

test('优先级：冰点+复苏同真 → 冰点（前日炸板更高、今日仍>40%）', () => {
  const prev = computeEmotionMetrics(mkPool(20, () => ({ zbc: 1 })));       // 涨停20 炸板1.0
  const cur = computeEmotionMetrics(mkPool(25, (i) => ({ zbc: i < 12 ? 1 : 0 }))); // 25家 炸板0.48
  assert.ok(cur.limit_up_count > prev.limit_up_count);
  assert.ok(cur.broken_rate < prev.broken_rate);
  assert.equal(classifyEmotion(cur, prev), '冰点');
});

test('优先级：主升+退潮同真 → 退潮（涨停多但炸板也多、高度降）', () => {
  const prev = computeEmotionMetrics(mkPool(70, (i) => ({ lbc: i < 20 ? 8 : 1, zbc: 0 })));
  const cur = mkPool(65, (i) => ({ lbc: i < 16 ? 2 : 1, zbc: i < 30 ? 1 : 0, hybk: i < 21 ? '电池' : null }));
  const m = computeEmotionMetrics(cur);
  assert.equal(m.limit_up_count, 65);
  assert.ok(m.broken_rate > 0.4);      // 30/65 ≈ 0.46
  assert.ok(m.max_board < prev.max_board);
  assert.equal(classifyEmotion(m, prev), '退潮');
});

test('优先级：高潮 vs 主升同真 → 高潮', () => {
  const pool = mkPool(110, (i) => ({ lbc: i < 20 ? 2 : 1, hybk: i < 40 ? '电池' : null }));
  const m = computeEmotionMetrics(pool);
  assert.equal(classifyEmotion(m), '高潮');
});

test('边界值：恰等阈值一律不触发（严格不等号）', () => {
  // 冰点：涨停恰 30（不触发，需 <30）；炸板率恰 0.40（不触发，需 >0.40）
  const a = computeEmotionMetrics(mkPool(30, (i) => ({ zbc: i < 12 ? 1 : 0 })));
  assert.equal(a.limit_up_count, 30);
  assert.equal(a.broken_rate, 0.4);
  assert.equal(classifyEmotion(a), '震荡');
  // 高潮：涨停恰 100 / 封板强度恰 0.70 → 均不触发
  const b = computeEmotionMetrics(mkPool(100, (i) => ({ zbc: i < 30 ? 1 : 0 })));
  assert.equal(b.hard_board_rate, 0.7);
  assert.equal(classifyEmotion(b), '震荡');
  // 主升：涨停恰 60 / 连板恰 15 / 集中度恰 0.30 → 不触发
  const pool = mkPool(60, (i) => ({ lbc: i < 15 ? 2 : 1, hybk: i < 18 ? '电池' : null }));
  const c = computeEmotionMetrics(pool);
  assert.equal(c.continuous_count, 15);
  assert.equal(c.theme_concentration, 0.3);
  assert.equal(classifyEmotion(c), '震荡');
});

test('环比：prev 缺失 → 复苏/退潮不触发', () => {
  const prev = computeEmotionMetrics(mkPool(20, () => ({ lbc: 5, zbc: 1 })));
  const cur = computeEmotionMetrics(mkPool(25, () => ({ lbc: 2, zbc: 0 })));
  assert.equal(classifyEmotion(cur), '震荡');           // 无 prev
  assert.equal(classifyEmotion(cur, null), '震荡');
  assert.notEqual(classifyEmotion(cur, prev), '震荡');  // 有 prev 才有环比状态
});

test('score：示例日手算闭环（52/18/0.15/5/0.35/0.72 → 69）', () => {
  // 20×0.52 + 20×0.9 + 20×(1-0.3) + 15×0.625 + 15×0.7 + 10×0.72 = 69.475 → 69
  const m = computeEmotionMetrics(
    mkPool(52, (i) => ({ lbc: i < 18 ? 2 : 1, zbc: i < 8 ? 1 : 0, hybk: i < 19 ? '电池' : null })),
  );
  assert.equal(m.limit_up_count, 52);
  assert.equal(m.continuous_count, 18);
  assert.equal(m.broken_rate, 0.1538); // r4(8/52)
  assert.equal(m.max_board, 2);
  assert.equal(m.theme_concentration, Math.round((19 / 52) * 10000) / 10000); // r4(19/52)
  // 直接用规格示例数值走 computeEmotionScore（绕开池构造的取整差）
  const fake = { limit_up_count: 52, continuous_count: 18, broken_rate: 0.15, max_board: 5, theme_concentration: 0.35, hard_board_rate: 0.72 };
  assert.equal(computeEmotionScore(fake), 69);
});

test('score：区间 [0,100]，缺失指标按 0.5 中性折算', () => {
  const full = { limit_up_count: 300, continuous_count: 50, broken_rate: 0, max_board: 20, theme_concentration: 1, hard_board_rate: 1 };
  assert.equal(computeEmotionScore(full), 100);
  const zero = { limit_up_count: 0, continuous_count: 0, broken_rate: 1, max_board: 0, theme_concentration: 0, hard_board_rate: 0 };
  assert.equal(computeEmotionScore(zero), 0);
  // 近似轨：theme_concentration null → 该项 15×0.5
  const approx = { limit_up_count: 50, continuous_count: 10, broken_rate: 0.2, max_board: 4, theme_concentration: null, hard_board_rate: 0.8 };
  const expect = 20 * 0.5 + 20 * 0.5 + 20 * (1 - 0.4) + 15 * 0.5 + 15 * 0.5 + 10 * 0.8;
  assert.equal(computeEmotionScore(approx), Math.round(expect));
});

test('主入口 computeEmotion：组合输出 + no_data + date 透传', () => {
  const out = computeEmotion(mkPool(101, () => ({})), null, '20260930');
  assert.equal(out.date, '20260930');
  assert.equal(out.emotion, '高潮');
  assert.ok(Number.isInteger(out.score));
  assert.equal(Object.keys(out.metrics).length, 7);
  // 空/非数组 → no_data
  assert.deepEqual(computeEmotion([]), { date: null, emotion: 'no_data', score: null, metrics: null });
  assert.equal(computeEmotion(null).emotion, 'no_data');
  assert.equal(computeEmotion('x').emotion, 'no_data');
});

test('规则常量形态（防误改）', () => {
  assert.equal(EMOTION_RULES.freeze.limit_up_count_max, 30);
  assert.equal(EMOTION_RULES.freeze.broken_rate_min, 0.40);
  assert.equal(EMOTION_RULES.climax.limit_up_count_min, 100);
  assert.equal(EMOTION_RULES.climax.hard_board_rate_min, 0.70);
  assert.equal(EMOTION_RULES.surge.limit_up_count_min, 60);
  assert.equal(EMOTION_RULES.surge.continuous_count_min, 15);
  assert.equal(EMOTION_RULES.surge.theme_concentration_min, 0.30);
  assert.equal(EMOTION_RULES.ebb.broken_rate_min, 0.40);
});
