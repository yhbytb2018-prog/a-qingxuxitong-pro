// 老龙头识别单测（2026-10-08）：identifyOldDragons 五条件逐项（缺一即排除）+
// 边界（absence 恰 10/9、fund 恰等均值、lbc/zbc 缺省）+ 空输入 + deriveDragonPool
// 首次波峰/波内刷新/第二波不覆盖的派生语义。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  identifyOldDragons, deriveDragonPool, OLD_DRAGON_RULES,
} from '../src/old_dragon.js';

/** 造涨停池条目：默认硬板首板 */
const st = (over = {}) => ({
  c: '600001', m: 1, n: 'X', p: 10000, zdp: 10, amount: 1e8,
  ltsz: 1e9, tshare: 1e9, hs: 1, lbc: 1, fbt: 92500, lbt: 92500,
  fund: 1e8, zbc: 0, hybk: '电池', zttj: { days: 1, ct: 1 }, ...over,
});

/** 基准池：4 只票，fund = 1/2/3/4 亿 → 均值 2.5 亿 */
const basePool = () => [
  st({ c: '600001', n: '甲', fund: 1e8 }),
  st({ c: '600002', n: '乙', fund: 2e8 }),
  st({ c: '600003', n: '丙', fund: 3e8 }),
  st({ c: '600004', n: '丁', fund: 4e8 }),
];
/** 基准龙头池：600003/600004 是老龙头 */
const baseDragons = () => [
  { code: '600003', name: '丙', peak_date: '20260801', peak_height: 7 },
  { code: '600004', name: '丁', peak_date: '20260901', peak_height: 5 },
];
/** 基准 absence：600004 冷却 15 日（600003 仅 9 日，600005 无记录） */
const baseAbsence = { '600004': 15, '600003': 9 };

test('识别：全条件满足 → 单候选，字段逐位断言', () => {
  const r = identifyOldDragons(basePool(), baseDragons(), baseAbsence, '20260930');
  assert.equal(r.date, '20260930');
  assert.equal(r.old_dragons.length, 1); // 只有 600004：fund 4亿 > 均值2.5亿 且冷却15日
  const d = r.old_dragons[0];
  assert.equal(d.code, '600004');
  assert.equal(d.name, '丁');
  assert.equal(d.first_wave_height, 5);
  assert.equal(d.days_since_peak, 15);
  assert.equal(d.today_board, 1);
  assert.equal(d.fund, 4e8);
  assert.equal(d.hard_board, true);
});

test('识别：多候选 → 全部输出且不影响彼此均值口径', () => {
  // 600004(4亿) 与 600003(3亿) 都过均值 2.5 亿，都给足冷却
  const r = identifyOldDragons(basePool(), baseDragons(), { '600003': 12, '600004': 15 }, '20260930');
  assert.deepEqual(r.old_dragons.map((x) => x.code), ['600003', '600004']);
  assert.deepEqual(r.old_dragons.map((x) => x.first_wave_height), [7, 5]);
});

test('条件①：不在龙头池 → 排除（今日 fund 最高也不行）', () => {
  const pool = [st({ c: '999999', n: '新贵', fund: 9e8 }), ...basePool()];
  const r = identifyOldDragons(pool, baseDragons(), baseAbsence, '20260930');
  // 均值抬到 3.8 亿：600004(4亿) 仍过且冷却 15 日 → 唯一候选；999999 fund 最高但非龙头被①排除
  assert.deepEqual(r.old_dragons.map((x) => x.code), ['600004']);
  const r2 = identifyOldDragons(pool, baseDragons(), { ...baseAbsence, '999999': 20, '600004': 15 }, '20260930');
  assert.deepEqual(r2.old_dragons.map((x) => x.code), ['600004']); // 非龙头 999999 仍被条件①排除
});

test('条件②：冷却不足排除，恰 10 日通过（边界）', () => {
  const abs = { '600004': 9 };
  assert.equal(identifyOldDragons(basePool(), baseDragons(), abs).old_dragons.length, 0);
  assert.equal(identifyOldDragons(basePool(), baseDragons(), { '600004': 10 }).old_dragons.length, 1);
  assert.equal(OLD_DRAGON_RULES.min_absence_days, 10); // 锁阈值
});

test('条件②：absence 无记录（数据不足）→ 保守排除', () => {
  const r = identifyOldDragons(basePool(), baseDragons(), {}, '20260930');
  assert.equal(r.old_dragons.length, 0);
});

test('条件③：lbc==2（非首板反抽）→ 排除；lbc 缺省按 1 → 通过', () => {
  const pool = [st({ c: '600004', n: '丁', fund: 4e8, lbc: 2 }), ...basePool().slice(0, 3)];
  assert.equal(identifyOldDragons(pool, baseDragons(), baseAbsence).old_dragons.length, 0);
  const pool2 = [st({ c: '600004', n: '丁', fund: 4e8, lbc: undefined }), ...basePool().slice(0, 3)];
  const r2 = identifyOldDragons(pool2, baseDragons(), baseAbsence);
  assert.equal(r2.old_dragons.length, 1);
  assert.equal(r2.old_dragons[0].today_board, 1);
});

test('条件④：zbc>0（炸过）→ 排除；zbc 缺省按 0 → 通过', () => {
  const pool = [st({ c: '600004', n: '丁', fund: 4e8, zbc: 1 }), ...basePool().slice(0, 3)];
  assert.equal(identifyOldDragons(pool, baseDragons(), baseAbsence).old_dragons.length, 0);
  const pool2 = [st({ c: '600004', n: '丁', fund: 4e8, zbc: undefined }), ...basePool().slice(0, 3)];
  assert.equal(identifyOldDragons(pool2, baseDragons(), baseAbsence).old_dragons.length, 1);
});

test('条件⑤：fund 恰等于均值 → 排除（严格>）；低于均值 → 排除', () => {
  // 均值 2.5 亿：600003(3亿) 通过、600002(2亿) 排除；再造恰等 2.5 亿的龙头票
  const dragons = [...baseDragons(), { code: '600005', name: '戊', peak_date: '20260801', peak_height: 6 }];
  const abs = { '600003': 12, '600004': 15, '600005': 20, '600002': 20 };
  const pool = [...basePool(), st({ c: '600005', n: '戊', fund: 2.5e8 })];
  const r = identifyOldDragons(pool, dragons, abs, '20260930');
  assert.deepEqual(r.old_dragons.map((x) => x.code), ['600003', '600004']); // 600005 恰等均值被排除
});

test('条件⑤：fund 缺失条目不参与均值且自身被排除', () => {
  // 600004 fund 缺失；剩余 1/2/3 亿 → 均值 2 亿
  const pool = [
    st({ c: '600001', fund: 1e8 }),
    st({ c: '600002', fund: 2e8 }),
    st({ c: '600003', fund: 3e8 }),
    st({ c: '600004', fund: undefined }),
  ];
  const r = identifyOldDragons(pool, baseDragons(), baseAbsence, '20260930');
  // 均值 2 亿：600003(3亿) 通过且冷却 9 日不足 → 无；600004 缺 fund 排除
  assert.equal(r.old_dragons.length, 0);
  const r2 = identifyOldDragons(pool, baseDragons(), { '600003': 15, '600004': 15 }, '20260930');
  assert.deepEqual(r2.old_dragons.map((x) => x.code), ['600003']);
});

test('空输入：空池 / 空龙头池 / 非法输入 → 空结果', () => {
  const empty = { date: '20260930', old_dragons: [] };
  assert.deepEqual(identifyOldDragons([], baseDragons(), baseAbsence, '20260930'), empty);
  assert.deepEqual(identifyOldDragons(basePool(), [], baseAbsence, '20260930'), empty);
  assert.deepEqual(identifyOldDragons(null, baseDragons(), baseAbsence), { date: null, old_dragons: [] });
  assert.deepEqual(identifyOldDragons(basePool(), null, baseAbsence), { date: null, old_dragons: [] });
  assert.deepEqual(identifyOldDragons(basePool(), baseDragons(), undefined), { date: null, old_dragons: [] });
});

test('全池无有效 fund → 条件⑤不可判，无候选', () => {
  const pool = [st({ c: '600004', fund: null }), st({ c: '600003', fund: undefined })];
  assert.equal(identifyOldDragons(pool, baseDragons(), baseAbsence).old_dragons.length, 0);
});

test('派生：首次 lbc≥5 入池，波内刷新最大高度', () => {
  const history = [
    { date: '20260801', pool: [st({ c: '600003', n: '丙', lbc: 5 })] },
    { date: '20260802', pool: [st({ c: '600003', n: '丙', lbc: 6 })] },
    { date: '20260803', pool: [st({ c: '600003', n: '丙', lbc: 7 })] }, // 波内峰值 7
  ];
  const dp = deriveDragonPool(history);
  assert.equal(dp.length, 1);
  assert.deepEqual(dp[0], { code: '600003', name: '丙', peak_date: '20260801', peak_height: 7 });
});

test('派生：离场封波，第二波更高也不覆盖第一波（首次语义）', () => {
  const history = [
    { date: '20260801', pool: [st({ c: '600003', n: '丙', lbc: 5 })] },
    { date: '20260802', pool: [st({ c: '600003', n: '丙', lbc: 6 })] },
    { date: '20260805', pool: [] },                                     // 离场 → 第一波封板
    { date: '20260901', pool: [st({ c: '600003', n: '丙', lbc: 8 })] },  // 第二波 8 板
    { date: '20260902', pool: [st({ c: '600003', n: '丙', lbc: 9 })] },
  ];
  const dp = deriveDragonPool(history);
  assert.equal(dp.length, 1);
  assert.equal(dp[0].peak_date, '20260801');
  assert.equal(dp[0].peak_height, 6); // 第二波不覆盖
});

test('派生：lbc 1-4 全程不入池；多龙头独立记录', () => {
  const history = [
    { date: '20260801', pool: [st({ c: 'A1', lbc: 4 }), st({ c: 'B2', lbc: 5 })] },
    { date: '20260802', pool: [st({ c: 'A1', lbc: 1 })] }, // 反抽也不建记录
  ];
  const dp = deriveDragonPool(history);
  assert.deepEqual(dp.map((x) => x.code), ['B2']);
  assert.equal(dp[0].peak_height, 5);
});

test('派生：截断 history 即「截至某日」快照（无未来泄漏）', () => {
  const history = [
    { date: '20260801', pool: [st({ c: '600003', lbc: 5 })] },
    { date: '20260802', pool: [st({ c: '600003', lbc: 6 })] },
    { date: '20260803', pool: [st({ c: '600003', lbc: 7 })] },
  ];
  assert.equal(deriveDragonPool(history.slice(0, 2))[0].peak_height, 6); // 截至 08-02 只见 6 板
  assert.equal(deriveDragonPool(history.slice(0, 1))[0].peak_height, 5);
  assert.equal(deriveDragonPool(history)[0].peak_height, 7);
});
