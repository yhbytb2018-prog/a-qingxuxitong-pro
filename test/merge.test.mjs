// 回归测试：runLive 合并历史的纯函数 mergeNewDays
// 背景：8853a17 引入 `old is not defined`，使每次重跑当日数据都抛 ReferenceError
//       → 整体回退 → meta.stale 恒为 true、数据永不更新。此测试守护该修复。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeNewDays } from '../src/pipeline.js';

const day = (date, summary = {}) => ({ trade_date: date, summary });

test('回归：当日已存在且新档缺涨跌家数 → 用旧档回填，不抛 ReferenceError', () => {
  const history = [day('2026-09-29', { up_count: 100, down_count: 200, flat_count: 10 })];
  const nd = day('2026-09-29', { up_count: null });
  const r = mergeNewDays(history, [nd]);          // 修复前：ReferenceError: old is not defined
  assert.equal(r.replaced, 1);
  assert.equal(r.breadthFilled, 1);
  assert.equal(nd.summary.up_count, 100);
  assert.equal(nd.summary.down_count, 200);
  assert.equal(nd.summary.flat_count, 10);
  assert.equal(history.length, 1);
});

test('回归：新档缺 up_count 字段（undefined）同样触发回填', () => {
  const history = [day('2026-09-29', { up_count: 3315, down_count: 1821, flat_count: 152 })];
  const nd = day('2026-09-29', { down_count: 999 });
  const r = mergeNewDays(history, [nd]);
  assert.equal(r.breadthFilled, 1);
  assert.equal(nd.summary.up_count, 3315);
  assert.equal(nd.summary.down_count, 1821);      // 旧档整体回填，覆盖新档残缺值
});

test('新档涨跌家数正常 → 采用新值，不回填', () => {
  const history = [day('2026-09-29', { up_count: 100 })];
  const nd = day('2026-09-29', { up_count: 3315, down_count: 1821, flat_count: 152 });
  const r = mergeNewDays(history, [nd]);
  assert.equal(r.breadthFilled, 0);
  assert.equal(r.replaced, 1);
  assert.equal(history[0].summary.up_count, 3315);
});

test('旧档本身无 up_count → 不回填（避免把 undefined 灌进新档）', () => {
  const history = [day('2026-09-29', {})];
  const nd = day('2026-09-29', { up_count: null });
  const r = mergeNewDays(history, [nd]);
  assert.equal(r.breadthFilled, 0);
  assert.equal(nd.summary.up_count, null);
});

test('新交易日 → 追加而非替换', () => {
  const history = [day('2026-09-29', { up_count: 1 })];
  const r = mergeNewDays(history, [day('2026-09-30', { up_count: 2 })]);
  assert.equal(r.appended, 1);
  assert.equal(r.replaced, 0);
  assert.equal(history.length, 2);
  assert.equal(history[1].trade_date, '2026-09-30');
});

test('席位明细：旧档有 detail 且覆盖更高 → 保留旧档（防新批次倒退）', () => {
  const history = [day('2026-09-29', { seats: { detail: true, cover: 100 } })];
  const nd = day('2026-09-29', { seats: { detail: false, cover: 60 } });
  mergeNewDays(history, [nd]);
  assert.deepEqual(history[0].summary.seats, { detail: true, cover: 100 });
});

test('席位明细：新档覆盖更高 → 采用新档', () => {
  const history = [day('2026-09-29', { seats: { detail: true, cover: 60 } })];
  const nd = day('2026-09-29', { seats: { detail: true, cover: 90 } });
  mergeNewDays(history, [nd]);
  assert.equal(history[0].summary.seats.cover, 90);
});

test('两者都缺 → 不因 undefined 崩溃', () => {
  const history = [{ trade_date: '2026-09-29' }];
  const nd = { trade_date: '2026-09-29' };
  const r = mergeNewDays(history, [nd]);
  assert.equal(r.replaced, 1);
  assert.equal(r.breadthFilled, 0);
  assert.deepEqual(history[0], { trade_date: '2026-09-29' });
});
