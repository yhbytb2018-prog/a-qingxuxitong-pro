// #1 幂等 / 防重复抓 / 无前视分位 —— 回归测试
//
// 本文件锁四件事：
//   ① 分位无前视：任何交易日的 pct_rank 只能用"到该日为止"的数据算出来
//   ② 追加新天后历史分位不漂移（幂等的实证判据）
//   ③ 抓取凭据判定：什么情况下可以跳过重复抓取（且缺失一律倾向"重抓"）
//   ④ 重算范围：默认只重算"会变的那几天"，且理由可解释
//
// ⚠ 测试用**真调用**断言行为，不扫源码字面量。这是项目既有纪律：
//   扫字面量的守卫会在重构时静默失效（保留注释即通过），而真调用不会。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deepEqual, dayFingerprint, digestCompare, needFetch, computeRecomputeScope,
  IDEMPOTENCE_LIMITS, FETCH_POLICY,
} from '../src/idempotence.js';
import { windowedPctRank, recalcRanks, RANK_WINDOW, RANK_MIN } from '../src/sources.js';

// ── ① 分位无前视 ──────────────────────────────────────────────────────────

test('分位：只看到 T 日为止 —— 后面追加数据不得改变前面任何一天', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({
    trade_date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    emotion: { value: (i * 37) % 100, lhb_daily_net: (i * 13) % 50 },
  }));
  const short = mk(40);
  const long = mk(80); // 前 40 天完全相同，只是后面多了 40 天

  recalcRanks(short);
  recalcRanks(long);

  for (let i = 0; i < 40; i++) {
    assert.equal(long[i].emotion.pct_rank, short[i].emotion.pct_rank,
      `第 ${i} 天的 pct_rank 因追加了未来数据而变化（前视偏差残留）`);
    assert.equal(long[i].emotion.net_daily_pct_rank, short[i].emotion.net_daily_pct_rank,
      `第 ${i} 天的 net_daily_pct_rank 因追加了未来数据而变化（前视偏差残留）`);
  }
});

test('分位：样本不足 RANK_MIN 时返回 null，绝不退化成短窗或填 50', () => {
  const days = Array.from({ length: 5 }, (_, i) => ({
    trade_date: `2026-02-0${i + 1}`, emotion: { value: 50 + i, lhb_daily_net: i },
  }));
  recalcRanks(days);
  for (const d of days) {
    assert.equal(d.emotion.pct_rank, null, '样本不足必须显式返回 null（显示"未计算"）');
    assert.equal(d.emotion.net_daily_pct_rank, null);
  }
  // 对照：样本刚够时必须算得出来（否则上面的 null 可能只是"永远算不出"）
  const enough = Array.from({ length: RANK_MIN }, (_, i) => ({
    trade_date: `2026-03-${String(i + 1).padStart(2, '0')}`, emotion: { value: 40 + i, lhb_daily_net: i },
  }));
  recalcRanks(enough);
  assert.notEqual(enough[enough.length - 1].emotion.pct_rank, null, '样本达 RANK_MIN 应当算得出分位');
});

test('分位：首日（无历史可比）在窗口口径下只能是最低位，不再是"中性 52.1"', () => {
  // 这是实测抓出的最刺眼案例：全档秩把"第 1 天"渲染成 52.1 分位（"中位偏上"），
  // 而任何只看历史的窗口下它只能是 0 —— 纯粹的未来信息泄漏。
  const days = Array.from({ length: RANK_MIN }, (_, i) => ({
    trade_date: `2026-04-${String(i + 1).padStart(2, '0')}`, emotion: { value: 90 - i, lhb_daily_net: 10 },
  }));
  recalcRanks(days);
  // 首日样本只有 1 天 < RANK_MIN → null，这是"算不出"，正确；
  // 第 RANK_MIN 天凑齐窗口后，首日在这个窗口里是最大值（因为 value 递减）→ 100。
  assert.equal(days[0].emotion.pct_rank, null);
  const last = days[days.length - 1];
  assert.equal(last.emotion.pct_rank, 0, '窗口中最小值应当得 0，而不是被未来数据抬到中位');
});

test('分位：全部取值相同（零方差）时不得产生 NaN / 除零', () => {
  const days = Array.from({ length: RANK_MIN + 5 }, (_, i) => ({
    trade_date: `2026-05-${String(i + 1).padStart(2, '0')}`, emotion: { value: 60, lhb_daily_net: 5 },
  }));
  recalcRanks(days);
  for (const d of days) {
    const v = d.emotion.pct_rank;
    if (v == null) continue;
    assert.ok(Number.isFinite(v), `分位必须是有限数，得到 ${v}`);
    assert.ok(v >= 0 && v <= 100, `分位必须在 [0,100]，得到 ${v}`);
  }
});

test('分位：窗口确实按 RANK_WINDOW 截断（第 RANK_WINDOW+1 天前的数据不参与）', () => {
  // 构造：最早 1 天是一个极端大值，之后全是小值。
  // 若窗口正确截断，到第 RANK_WINDOW 天之后，那个极端值应已滑出窗口 → 不影响后续分位。
  const N = RANK_WINDOW + 5;
  const vals = [999, ...Array.from({ length: N - 1 }, (_, i) => 10 + (i % 3))];
  const days = vals.map((v, i) => ({
    trade_date: `2026-06-${String(i + 1).padStart(2, '0')}`, emotion: { value: v, lhb_daily_net: v },
  }));
  recalcRanks(days);
  // 末日：窗口是最后 RANK_WINDOW 天，999 早已滑出 → 当日值在窗口内排名不应因它而变
  const lastIdx = N - 1;
  const win = vals.slice(lastIdx - RANK_WINDOW + 1, lastIdx + 1);
  const expect = Math.round((win.filter((x) => x < vals[lastIdx]).length
    / Math.max(win.filter((x) => x <= vals[lastIdx]).length + win.filter((x) => x < vals[lastIdx]).length - 1, 1)) * 0); // 占位
  // 直接验证"999 不在窗口内"这个前提，再验证分位与手工窗口一致
  assert.ok(!win.includes(999), '前提：极端值应已滑出窗口');
  const sorted = [...win].sort((a, b) => a - b);
  const manual = Math.round((sorted.indexOf(vals[lastIdx]) / Math.max(sorted.length - 1, 1)) * 1000) / 10;
  assert.equal(days[lastIdx].emotion.pct_rank, manual, '分位必须与"手工按 RANK_WINDOW 截窗"结果一致');
  void expect;
});

test('分位：缺失值（null/空串/布尔/数组）不进入窗口也不进入分母', () => {
  const days = [];
  for (let i = 0; i < RANK_MIN + 5; i++) {
    // 每 3 天插入一个各类型的"伪值"，它们都不该被当成数字 0
    const bad = [null, '', false, []][i % 4];
    days.push({ trade_date: `2026-07-${String(i + 1).padStart(2, '0')}`, emotion: { value: i % 3 === 0 ? bad : 50 + i, lhb_daily_net: 1 } });
  }
  recalcRanks(days);
  // 伪值日的分位必须是 null（当日值不可用），不能是 0 或任何数字
  for (let i = 0; i < days.length; i++) {
    if (i % 3 !== 0) continue;
    assert.equal(days[i].emotion.pct_rank, null,
      `第 ${i} 天值为伪值（${JSON.stringify(days[i].emotion.value)}），分位必须是 null 而不是被当成 0 算出的数字`);
  }
});

test('分位：windowedPctRank 对越界索引与空数组不抛错', () => {
  assert.equal(windowedPctRank([], 0), null);
  assert.equal(windowedPctRank([1, 2, 3], -1), null);
  assert.equal(windowedPctRank([1, 2, 3], 99), null);
});

test('分位：RANK_WINDOW / RANK_MIN 的取值被显式锁定（改动必须是有意的）', () => {
  assert.equal(RANK_WINDOW, 60, '窗口长度变更会改变全部历史分位，须显式确认');
  assert.equal(RANK_MIN, 20, '最少样本数变更会让更多天从"有分位"变成"未计算"');
  assert.ok(RANK_MIN <= RANK_WINDOW, '最少样本不得超过窗口长度（否则永远算不出）');
});

test('分位：窗口内全为同一值时（无区分度）不返回 NaN', () => {
  const v = windowedPctRank([5, 5, 5], 1, 3, 3);
  assert.ok(v === null || Number.isFinite(v), `得到 ${v}`);
});

// ── ①b 分位窗口的**边界**（#134a：把"边界"从注释变成可执行的守卫）──────────
//
//   为什么单独一组：分位是"当日值在含自身窗口中的位置"，它的正确性完全由
//   **窗口左右两端**决定。左端（起点）错 → 前视/样本不足；右端（含当日）错 →
//   "今天创新高永远显示不出 100"。这两端历史上都出过事，且都**不会抛错**，
//   只会静默给出一个看起来正常的数字。故这里逐端钉死。
test('分位边界·左端：样本数 < MIN 时返回 null，绝不用短窗口凑合或填 50', () => {
  // 恰好 MIN-1 个有效样本 → 必须 null（不能"凑合算"）
  const justUnder = Array.from({ length: RANK_MIN - 1 }, () => 50);
  assert.equal(windowedPctRank(justUnder, justUnder.length - 1, RANK_WINDOW, RANK_MIN), null,
    `${RANK_MIN - 1} 个样本不足 ${RANK_MIN}，必须"未计算"而不是给个数字`);
  // 恰好 MIN 个 → 可算
  const atMin = Array.from({ length: RANK_MIN }, (_, i) => i);
  const v = windowedPctRank(atMin, atMin.length - 1, RANK_WINDOW, RANK_MIN);
  assert.ok(Number.isFinite(v), `恰好 ${RANK_MIN} 个样本应可算，得到 ${v}`);
});

test('分位边界·左端：窗口只截到 i 之前，绝不用 i 之后的数据（无前视）', () => {
  // 构造：i=2 处值 50；i 之后塞入大量极小值。若窗口误含未来，50 的排名会变得极高。
  const vals = [10, 20, 50, 0.001, 0.002, 0.003, 0.004];
  const noFuture = windowedPctRank(vals, 2, RANK_WINDOW, 3);
  // 只用 vals[0..2] = [10,20,50] → 50 是最大 → 100
  assert.equal(noFuture, 100, `只用截至 i 的样本时 50 应为 100 分位，得到 ${noFuture}`);
  // 若把未来（极小值）算进来，50 仍会是最大 → 这里再加一个反例：i 之后塞超大值
  const vals2 = [50, 40, 30, 9999, 9999];
  const r2 = windowedPctRank(vals2, 2, RANK_WINDOW, 3); // 只用 [50,40,30] → 30 最小 → 0
  assert.equal(r2, 0, `i 之后的 9999 不得进入窗口；30 在 [50,40,30] 中最小应为 0，得到 ${r2}`);
});

test('分位边界·右端：含 T 日自身 —— 当日创新高必须能显示 100', () => {
  // 这是"含当日"口径的意义：如果窗口不含当日，创历史新高永远算不出 100。
  const vals = Array.from({ length: RANK_MIN }, (_, i) => 100 + i);
  vals[RANK_MIN - 1] = 9999; // 当日为窗口内最大
  const v = windowedPctRank(vals, RANK_MIN - 1, RANK_WINDOW, RANK_MIN);
  assert.equal(v, 100, `当日是窗口最大值时应为 100（含当日口径），得到 ${v}`);
  // 反向：当日是窗口最小值 → 0
  const vals2 = Array.from({ length: RANK_MIN }, (_, i) => 100 + i);
  vals2[RANK_MIN - 1] = -9999;
  assert.equal(windowedPctRank(vals2, RANK_MIN - 1, RANK_WINDOW, RANK_MIN), 0);
});

test('分位边界·右端：窗口长度恰好等于 WINDOW 时，左边界样本不会被多算一天', () => {
  // 构造 window+1 个样本，i = window（第 window+1 个）。窗口应恰好是 [1..window]，
  //   不含 0 号。用一个极大值放在 0 号：若被误含，结果会不同。
  const W = 10, MINN = 3;
  const vals = [9999, ...Array.from({ length: W }, (_, i) => i + 1)];
  const i = W; // vals[10] = 10
  const r = windowedPctRank(vals, i, W, MINN);
  // 窗口 = vals[1..10] = [1..10] → 10 是最大 → 100（9999 不得进入）
  assert.equal(r, 100, `0 号的 9999 不得进入窗口；10 在 [1..10] 中应为 100，得到 ${r}`);
  // 恰好 W 个样本时，起点应为 i-W+1=1（不是 0）
  const r0 = windowedPctRank(vals, W - 1, W, MINN); // i=9 → 窗口 vals[0..9] 含 9999
  assert.ok(r0 === null || r0 === 100 || Number.isFinite(r0), '边界起点允许含 0 号时不应崩');
});

test('分位边界·平值：取首次出现位置（indexOf 语义），不被"并列中位"口径污染', () => {
  // [10,10,10,20] 取 i=3（末位）→ 窗口 = 全部 4 个，cur=20 → 最大 → 100（正常）。
  //   要测平值口径，需让 cur 是那组平值本身：取 i=2（cur=10），窗口 = [10,10,10]（3 个）。
  //   sorted=[10,10,10] → indexOf(10)=0 → 0/2*100 = 0。
  //   若误用"并列中位"或"≤个数"口径 → 会得到 50 或 100。这里必须锁定 indexOf=0。
  const vals = [10, 10, 10, 20];
  const r = windowedPctRank(vals, 2, RANK_WINDOW, 3); // 窗口 vals[0..2]=[10,10,10]，cur=10
  assert.equal(r, 0, `平值必须取首次出现位置（indexOf=0 → 0 分位），得到 ${r}；` +
    '若得到 50/100 说明平值口径被换成了"并列中位"——那必须单独开一项并重新验证全档');
  // 对照组：cur 是窗口内最大（i=3, cur=20）→ 100，证明探针非恒 0
  assert.equal(windowedPctRank(vals, 3, RANK_WINDOW, 3), 100);
});

test('分位边界·自定义窗口：window/min 显式传入时完全按传入值走（不被全局常量劫持）', () => {
  const vals = [1, 2, 3, 4, 5];
  // window=3 → 只取 vals[2..4] = [3,4,5]，cur=5 → 100
  assert.equal(windowedPctRank(vals, 4, 3, 3), 100);
  // window=3, min=4（不足）→ null
  assert.equal(windowedPctRank(vals, 4, 3, 4), null);
});

test('★ 分位边界·实证：真档案 241 天，逐日分位只由"截至该日"的窗口算得', async () => {
  // 用真档案做**端到端**无前视证明：
  //   ① 全量跑一遍 recalcRanks 得分位 A；
  //   ② 把档案在每一天**截断**（只保留前 k 天）再单独跑该天的分位，得 B；
  //   ③ A 与 B 必须逐日相同 —— 若不同，说明 A 用了第 k 天之后的数据（前视）。
  const { readFileSync } = await import('node:fs');
  const { decodeArchive } = await import('../src/lhb_codec.js');
  const fp = new URL('../data/archive.json', import.meta.url);
  let days;
  try {
    days = (decodeArchive(JSON.parse(readFileSync(fp, 'utf8'))).all_days || [])
      .filter((d) => d && d.emotion && d.trade_date);
  } catch { return; } // CI 首次 clone 无档则跳过（与 health.test 同款）
  if (days.length < RANK_WINDOW + 10) return;

  const full = recalcRanks(days.map((d) => ({
    trade_date: d.trade_date,
    emotion: { value: d.emotion.value, lhb_daily_net: d.emotion.lhb_daily_net },
  })));
  const A = full.map((d) => d.emotion.pct_rank);

  // 抽若干天做截断验证（全量截断是 O(n^2)，抽 12 天足够发现前视）
  const probes = [RANK_MIN, RANK_WINDOW, Math.floor(days.length / 2), days.length - 1]
    .concat(Array.from({ length: 8 }, (_, i) => Math.floor((i + 1) * days.length / 9)))
    .filter((k, i, a) => k >= 0 && k < days.length && a.indexOf(k) === i);

  for (const k of probes) {
    const prefix = days.slice(0, k + 1).map((d) => ({
      trade_date: d.trade_date,
      emotion: { value: d.emotion.value, lhb_daily_net: d.emotion.lhb_daily_net },
    }));
    const B = recalcRanks(prefix);
    assert.equal(B[B.length - 1].emotion.pct_rank, A[k],
      `第 ${k} 天（${days[k].trade_date}）截断重算得分位 ${B[B.length - 1].emotion.pct_rank}，` +
      `全量跑得 ${A[k]} —— 不一致说明全量跑时用到了该日之后的未来数据`);
  }
});

// ── ② 幂等：指纹与逐日比较 ────────────────────────────────────────────────

test('指纹：忽略易变字段（_legacy），但保留数据内容字段', () => {
  const a = { trade_date: '2026-09-30', emotion: { value: 60, _legacy: true }, summary: { amount_yi: 100 } };
  const b = { trade_date: '2026-09-30', emotion: { value: 60, _legacy: false }, summary: { amount_yi: 100 } };
  assert.ok(deepEqual(dayFingerprint(a), dayFingerprint(b)), '_legacy 是推导留痕，不应让指纹变化');
  const c = { ...b, emotion: { value: 61, _legacy: false } };
  assert.ok(!deepEqual(dayFingerprint(a), dayFingerprint(c)), 'value 变化必须让指纹变化');
});

test('deepEqual：键序无关、数值等价、但键集合必须一致', () => {
  assert.ok(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), '键序不同应判等价');
  assert.ok(!deepEqual({ a: 1 }, { a: 1, b: 2 }), '多一个键 = 数据变了，不是等价');
  assert.ok(!deepEqual([1, 2], [1, 2, 3]), '数组长度不同不等价');
  assert.ok(deepEqual([1, 2], [1, 2]), '同长同值等价');
  assert.ok(!deepEqual('1', 1), "字符串 '1' 与数字 1 类型不同，不等价");
  assert.ok(deepEqual(NaN, NaN), 'NaN 与 NaN 在数据语境下都表示"算不出"，视为同值');
  assert.ok(!deepEqual(null, 0), 'null 与 0 不等价（缺失 ≠ 0）');
});

test('digestCompare：样本不足判 insufficient，不宣布幂等', () => {
  const few = Array.from({ length: 3 }, (_, i) => ({ trade_date: `2026-01-0${i + 1}`, emotion: { value: 1 } }));
  const r = digestCompare(few, JSON.parse(JSON.stringify(few)));
  assert.equal(r.status, 'insufficient', '少于 MIN_BASELINE_DAYS 天不得宣布幂等（没检查 ≠ 没问题）');
  assert.equal(r.checkedDays, 3);
});

test('digestCompare：追加新天不算"漂移"，单独列为 added', () => {
  const base = Array.from({ length: 15 }, (_, i) => ({ trade_date: `2026-01-${String(i + 1).padStart(2, '0')}`, emotion: { value: 50 + i } }));
  const withNew = [...JSON.parse(JSON.stringify(base)), { trade_date: '2026-01-16', emotion: { value: 99 } }];
  const r = digestCompare(base, withNew);
  assert.equal(r.status, 'unchanged', '只追加一天不应被判为历史漂移');
  assert.deepEqual(r.added, ['2026-01-16']);
  assert.equal(r.drifted.length, 0);
});

test('digestCompare：历史日取值变化必须被抓住（并给出日期）', () => {
  const base = Array.from({ length: 15 }, (_, i) => ({ trade_date: `2026-01-${String(i + 1).padStart(2, '0')}`, emotion: { value: 50 } }));
  const mut = JSON.parse(JSON.stringify(base));
  mut[7].emotion.value = 51;
  const r = digestCompare(base, mut);
  assert.equal(r.status, 'changed');
  assert.deepEqual(r.drifted, ['2026-01-08'], '必须点名是哪一天漂移了');
});

test('digestCompare：入参不是数组 → unknown，不静默通过', () => {
  assert.equal(digestCompare(null, []).status, 'unknown');
  assert.equal(digestCompare([], 'x').status, 'unknown');
});

test('幂等：同一天重复重算结果恒定（连算两次指纹相同）', () => {
  const days = Array.from({ length: 30 }, (_, i) => ({
    trade_date: `2026-08-${String(i + 1).padStart(2, '0')}`,
    emotion: { value: (i * 29) % 100, lhb_daily_net: (i * 7) % 30 },
  }));
  recalcRanks(days);
  const fp1 = days.map(dayFingerprint);
  recalcRanks(days);
  const fp2 = days.map(dayFingerprint);
  assert.ok(deepEqual(fp1, fp2), '同一输入连算两次必须得到同一结果');
});

// ── ③ 抓取凭据 ────────────────────────────────────────────────────────────

const BJ = (s) => new Date(s + '+08:00');

test('抓取凭据：已定稿且数据齐全 → 可跳过', () => {
  const day = { trade_date: '2026-09-30', summary: { lhb_stocks: 66, seats: { cover: 100 } } };
  const r = needFetch(day, { now: BJ('2026-10-01T10:00:00') });
  assert.equal(r.need, false);
  assert.equal(r.kind, 'skip');
});

test('抓取凭据：未过定稿时刻（当日 21:00 前）→ 必须重抓', () => {
  const day = { trade_date: '2026-09-30', summary: { lhb_stocks: 66, seats: { cover: 100 } } };
  const r = needFetch(day, { now: BJ('2026-09-30T18:00:00') });
  assert.equal(r.need, true, '披露窗口内不得跳过（龙虎榜/席位可能还在增加）');
  assert.match(r.reason, /定稿/);
});

test('抓取凭据：定稿时刻边界 —— 20:59 重抓、21:00 可跳过', () => {
  const day = { trade_date: '2026-09-30', summary: { lhb_stocks: 66, seats: { cover: 100 } } };
  assert.equal(needFetch(day, { now: BJ('2026-09-30T20:59:00') }).need, true, '20:59 未过定稿');
  assert.equal(needFetch(day, { now: BJ('2026-09-30T21:00:00') }).need, false, '21:00 已过定稿');
});

test('抓取凭据：已定稿但龙虎榜为空 → 重抓（有壳无内容不得放行）', () => {
  const day = { trade_date: '2026-09-30', summary: { lhb_stocks: 0, seats: { cover: 100 } } };
  const r = needFetch(day, { now: BJ('2026-10-01T10:00:00') });
  assert.equal(r.need, true, '龙虎榜为 0 说明没抓到，不能因"档案里有这天"就放行');
});

test('抓取凭据：席位覆盖不足 → 重抓', () => {
  const day = { trade_date: '2026-09-30', summary: { lhb_stocks: 66, seats: { cover: 80 } } };
  const r = needFetch(day, { now: BJ('2026-10-01T10:00:00') });
  assert.equal(r.need, true);
  assert.match(r.reason, /席位/);
});

test('抓取凭据：档案里没有这天 → 抓取', () => {
  const r = needFetch(null, { tradeDate: '2026-10-08', now: BJ('2026-10-08T22:00:00') });
  assert.equal(r.need, true);
  assert.equal(r.kind, 'fetch');
});

test('抓取凭据：当前时刻不可用 → 保守重抓（不因判不了就跳过）', () => {
  const day = { trade_date: '2026-09-30', summary: { lhb_stocks: 66, seats: { cover: 100 } } };
  const r = needFetch(day, { now: null });
  assert.equal(r.need, true, '判不出来必须倾向重抓，绝不能默认跳过');
  assert.match(r.reason, /保守/);
});

test('抓取凭据：席位覆盖率的"真值 0%"与"未知"都被视为不足（都需重抓）', () => {
  const zero = { trade_date: '2026-09-30', summary: { lhb_stocks: 66, seats: { cover: 0 } } };
  const unknown = { trade_date: '2026-09-30', summary: { lhb_stocks: 66 } };
  assert.equal(needFetch(zero, { now: BJ('2026-10-01T10:00:00') }).need, true);
  assert.equal(needFetch(unknown, { now: BJ('2026-10-01T10:00:00') }).need, true);
});

test('抓取凭据：定稿小时用北京时间判定，不因宿主时区漂移', () => {
  // 2026-09-30T13:30Z = 北京 21:30 → 已过定稿；若误用 UTC 会判成 13:30 未过。
  const day = { trade_date: '2026-09-30', summary: { lhb_stocks: 66, seats: { cover: 100 } } };
  assert.equal(needFetch(day, { now: new Date('2026-09-30T13:30:00Z') }).need, false,
    '应按北京时间（21:30 已定稿）判定，而非 UTC（13:30 未定稿）');
});

test('抓取策略：定稿小时与席位阈值的取值被锁定', () => {
  assert.equal(FETCH_POLICY.FINALIZED_HOUR, 21);
  assert.equal(FETCH_POLICY.SEAT_COVER_ENOUGH, 100);
});

// ── ④ 重算范围 ────────────────────────────────────────────────────────────

test('重算范围：默认只重算最新一天（上一交易日已齐全时）', () => {
  const days = [
    { trade_date: '2026-09-28', summary: { seats: { cover: 100, detail: { a: { b: [], s: [] } } } } },
    { trade_date: '2026-09-29', summary: { seats: { cover: 100, detail: { a: { b: [], s: [] } } } } },
    { trade_date: '2026-09-30', summary: { seats: { cover: 100, detail: { a: { b: [], s: [] } } } } },
  ];
  const r = computeRecomputeScope(days);
  assert.deepEqual(r.dates, ['2026-09-30']);
  assert.equal(r.full, false);
});

test('重算范围：上一交易日席位缺卖方明细（旧格式）→ 一并纳入', () => {
  const days = [
    { trade_date: '2026-09-28', summary: { seats: { cover: 100, detail: { a: [{ code: 'x' }] } } } }, // 数组 = 旧格式（仅买方）
    { trade_date: '2026-09-30', summary: { seats: { cover: 100, detail: { a: { b: [], s: [] } } } } },
  ];
  const r = computeRecomputeScope(days);
  assert.ok(r.dates.includes('2026-09-28'), '旧格式明细必须重算（历史天否则永远补不上卖方）');
  assert.ok(r.dates.includes('2026-09-30'));
});

test('重算范围：上一交易日按**档案顺序**取，不按自然日（长假场景）', () => {
  // 2026-09-24 之后直接是 09-28（09-25 中秋休市）—— 上一交易日是 09-24，不是 09-27
  const days = [
    { trade_date: '2026-09-24', summary: { seats: { cover: 50, detail: {} } } },
    { trade_date: '2026-09-28', summary: { seats: { cover: 100, detail: { a: { b: [], s: [] } } } } },
  ];
  const r = computeRecomputeScope(days);
  assert.ok(r.dates.includes('2026-09-24'), '应取档案里真正的前一交易日（09-24）');
  assert.ok(!r.dates.includes('2026-09-27'), '不得凭空造出自然日前一天');
});

test('重算范围：force 时全档重算（口径变更不得靠猜）', () => {
  const days = Array.from({ length: 30 }, (_, i) => ({ trade_date: `2026-01-${String(i + 1).padStart(2, '0')}`, summary: {} }));
  const r = computeRecomputeScope(days, { force: true });
  assert.equal(r.full, true);
  assert.equal(r.dates.length, 30);
  assert.match(r.reason, /口径变更/);
});

test('重算范围：空档不报错，返回空列表', () => {
  const r = computeRecomputeScope([]);
  assert.deepEqual(r.dates, []);
  assert.equal(r.full, false);
});

test('重算范围：乱序入参不得影响"最新/上一交易日"的判定', () => {
  const days = [
    { trade_date: '2026-09-30', summary: { seats: { cover: 100, detail: { a: { b: [], s: [] } } } } },
    { trade_date: '2026-09-28', summary: { seats: { cover: 100, detail: { a: { b: [], s: [] } } } } },
    { trade_date: '2026-09-29', summary: { seats: { cover: 100, detail: { a: { b: [], s: [] } } } } },
  ];
  const r = computeRecomputeScope(days);
  assert.deepEqual(r.dates, ['2026-09-30'], '最新日应是 09-30（按日期排序取，不按数组顺序）');
});

test('constants：IDEMPOTENCE_LIMITS 的取值被锁定', () => {
  assert.equal(IDEMPOTENCE_LIMITS.MIN_BASELINE_DAYS, 10);
  assert.ok(IDEMPOTENCE_LIMITS.DIGEST_FIELDS.includes('emotion'));
  assert.ok(IDEMPOTENCE_LIMITS.DIGEST_FIELDS.includes('summary'));
});
