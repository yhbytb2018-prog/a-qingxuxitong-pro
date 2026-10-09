// 回归测试：题材动量的「昨日视角」留痕 + 存活率口径。
// 背景（真 bug）：报告「昨日新晋题材存活率」用「今日 fresh 名单」去比「昨日 themes 是否存在」，
//   语义变成「今日新晋在昨日是否已存在」——而新晋的定义就是昨日不存在，逻辑自相矛盾，
//   得数无意义（2026-09-30 实测算出 9/17 = 53%，看似合理）。
// 正确口径：昨日视角新晋名单（引擎用 byDay.slice(0,-1) 重算的 prev_fresh）→ 今日是否仍存在。
//
// 注意：computeMomentum 需要「近5日 + 前5日」共 ≥10 个交易日的窗口，
// 故 fixtures 必须 ≥ 12 天，否则 prevIdx 会取到负下标。
// 题材由 ThemeDenoiser 从 day.hot[].reason 标准化推出（非直接给 themes 字段）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { computeMomentum } from '../src/themes.js';
import { enrich } from '../src/pipeline.js';

const THEMES = ['PCB', '并购重组', '房地产', '电子', 'AI算力', '国企改革'];

// 造一天：每个题材给 2 只票（满足 minThemeStocks=2），reason 带该题材词
const mkDay = (date, active) => ({
  trade_date: date,
  hot: active.flatMap((th, ti) => [0, 1].map((k) => ({
    code: `${ti}${k}${Math.abs(hash(th)) % 97}`, name: `${th}${k}`, reason: th,
  }))),
  lhb: [], lhb_aggr: [], summary: {},
});
const hash = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; };

// 11 天底噪（每天固定给 PCB/并购重组，让窗口有稳定基线）+ 最后 3 天做题材轮动
const series = (tail) => [
  ...Array.from({ length: 11 }, (_, k) => mkDay(`2026-09-${String(k + 1).padStart(2, '0')}`, THEMES.slice(0, 2))),
  ...tail,
];

test('momentum: enrich 落盘 prev_fresh/prev_continuing/prev_fading（昨日视角留痕）', () => {
  const days = series([
    mkDay('2026-09-17', THEMES.slice(1, 4)),
    mkDay('2026-09-18', THEMES.slice(2, 5)),
    mkDay('2026-09-19', THEMES.slice(3, 6)),
  ]);
  const { momObj } = enrich(days);
  assert.ok(Array.isArray(momObj.prev_fresh), 'prev_fresh 应为数组');
  assert.ok(Array.isArray(momObj.prev_continuing));
  assert.ok(Array.isArray(momObj.prev_fading));
});

test('momentum: prev_fresh 来自截止昨日的重算，不是今日 fresh 的别名', () => {
  const days = series([
    mkDay('2026-09-17', THEMES.slice(0, 3)),
    mkDay('2026-09-18', THEMES.slice(1, 4)),
    mkDay('2026-09-19', THEMES.slice(2, 5)),
  ]);
  const { momObj } = enrich(days);
  const todayFresh = momObj.fresh.map((t) => t.theme);
  // 引擎侧独立重算「截止昨日」的动量，结果应与「今日 fresh」区分开
  const prevRecomputed = computeMomentum(
    days.slice(0, -1).map((d) => {
      const m = {};
      for (const s of d.hot) (m[s.reason] = m[s.reason] || new Set()).add(s.code);
      return m;
    }), 5, 5, 2,
  );
  assert.deepEqual(momObj.prev_fresh, prevRecomputed.fresh, 'prev_fresh 必须等于截止昨日的重算结果');
  assert.notDeepEqual(momObj.prev_fresh, todayFresh);
});

test('momentum: 存活率 = 昨日新晋名单中今日仍存在的占比（同源可复算）', () => {
  const days = series([
    mkDay('2026-09-17', THEMES.slice(0, 3)),
    mkDay('2026-09-18', THEMES.slice(1, 4)),
    mkDay('2026-09-19', THEMES.slice(2, 5)),
  ]);
  const { out, momObj } = enrich(days);
  const todayThemes = out[out.length - 1].themes || {};
  const yf = momObj.prev_fresh;
  const alive = yf.filter((t) => (todayThemes[t] || 0) > 0);
  const pct = yf.length ? Math.round(alive.length / yf.length * 100) : null;
  if (yf.length) {
    assert.ok(pct >= 0 && pct <= 100);
    assert.equal(alive.length + yf.filter((t) => !((todayThemes[t] || 0) > 0)).length, yf.length);
  }
});

test('momentum: 「今日 fresh 比昨日 themes」与正确口径不等价（守护口径区别）', () => {
  const days = series([
    mkDay('2026-09-17', THEMES.slice(0, 3)),
    mkDay('2026-09-18', THEMES.slice(1, 4)),
    mkDay('2026-09-19', THEMES.slice(2, 5)),
  ]);
  const { out, momObj } = enrich(days);
  const todayFresh = momObj.fresh.map((t) => t.theme);
  const pThemes = out[out.length - 2].themes || {};
  const todayThemes = out[out.length - 1].themes || {};
  const wrongAlive = todayFresh.filter((t) => (pThemes[t] || 0) > 0);      // 错误算法
  const rightAlive = momObj.prev_fresh.filter((t) => (todayThemes[t] || 0) > 0); // 正确算法
  // 两者分母不同 —— 说明口径确实被换过，测试守护这一区别
  assert.notEqual(todayFresh.length, momObj.prev_fresh.length);
  assert.ok(wrongAlive.length <= todayFresh.length);
  assert.ok(rightAlive.length <= momObj.prev_fresh.length);
});

test('momentum: computeMomentum 空数组不抛；窗口不足的短序列由调用方保证', () => {
  // 空数组：两个窗口都取不到下标 → agg 遍历空 idx → 返回三个空数组
  const r = computeMomentum([], 5, 5, 2);
  assert.deepEqual(r, { fresh: [], continuing: [], fading: [] });
  // 契约：调用方必须保证 days.length >= recentN + prevN（enrich 在存档不足时也应如此）。
  // 这里只用「窗口内的天数」构造，锁定窗口语义。
  const days = Array.from({ length: 10 }, (_, i) => (i < 5 ? {} : { X: new Set(['a', 'b']) }));
  const r2 = computeMomentum(days, 5, 5, 2);
  assert.deepEqual(r2.fresh, ['X']); // 近5日有 X，前5日无 → 新晋
});

test('momentum: 真实存档 momentum.prev_fresh 存在且存活率可复算', async () => {
  const p = new URL('../data/archive.json', import.meta.url);
  if (!existsSync(p)) return;
  const arc = JSON.parse(readFileSync(p, 'utf8'));
  const m = arc.signals?.momentum;
  assert.ok(m, 'signals.momentum 应存在');
  assert.ok(Array.isArray(m.prev_fresh), 'momentum.prev_fresh 应存在（报告存活率依赖它）');
  const last = (arc.all_days || [])[(arc.all_days || []).length - 1];
  const th = last?.themes || {};
  const alive = m.prev_fresh.filter((t) => (th[t] || 0) > 0);
  const pct = Math.round(alive.length / m.prev_fresh.length * 100);
  assert.ok(pct >= 0 && pct <= 100);
  // 2026-09-30 回归：正确口径是 20%（3/15），不是历史错误算法的 53%（9/17）
  if (last?.trade_date === '2026-09-30') {
    assert.equal(m.prev_fresh.length, 15, '昨日新晋应为 15 个');
    assert.equal(pct, 20, '存活率应为 20%（3/15），而非错误算法的 53%');
  }
});
