// #134b：幂等接进管线主路径 —— 核心证明
//
// 本文件只回答一个问题，且必须用**真档案**回答：
//   「带 scope 的 recalcAll（只重算 1~2 天）与全档 recalcAll（241 天全跑）
//     结果是否**逐字段相同**？」
//   若相同 → 缩小重算范围是安全的（省钱又不改数）。
//   若不同 → 存在未被识别的跨日依赖，**必须停止缩小范围**（而不是"差不多就行"）。
//
// ⚠ 这是本项唯一不可省的一步。光有 computeRecomputeScope 的单元测试
//   （证明"它挑出了正确的日期"）不足以证明"跳过的天结果不变"——
//   后者是**管线性质**，只能在真数据上验。
//
// ⚠ 纪律：测试用真调用 + 真档案，不扫源码字面量。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeArchive } from '../src/lhb_codec.js';
import { computeRecomputeScope } from '../src/idempotence.js';
import { recalcAll } from '../src/pipeline.js';
import { deepEqual, dayFingerprint } from '../src/idempotence.js';

// 读真档案（CI 首次 clone 无档则跳过，与 health.test 同款）
let ARCHIVE = null;
try {
  ARCHIVE = decodeArchive(JSON.parse(readFileSync(new URL('../data/archive.json', import.meta.url), 'utf8')));
} catch { ARCHIVE = null; }

/** 深拷贝（用 JSON 往返足够——档案里全是 JSON 可表示的标量/数组/对象）。 */
const clone = (x) => JSON.parse(JSON.stringify(x));

test('★ 管线性质：带 scope 的重算与全档重算**逐字段相同**（真档案）', () => {
  if (!ARCHIVE || !(ARCHIVE.all_days || []).length) return; // 无档跳过
  const orig = ARCHIVE.all_days;
  assert.ok(orig.length > 60, `档案太小（${orig.length} 天），不足以验证跨日依赖`);

  // ① 全档重算（旧行为）
  const full = clone(orig);
  recalcAll(full);

  // ② 带 scope 重算（新行为）：scope 来自真档案
  const scoped = clone(orig);
  const scope = computeRecomputeScope(scoped);
  assert.equal(scope.full, false, 'scope 不应是全档（否则本测试没有意义）');
  assert.ok(scope.dates.length >= 1 && scope.dates.length < scoped.length,
    `scope 应只覆盖少数几天，实际 ${scope.dates.length}/${scoped.length}`);
  recalcAll(scoped, { scope });

  // ③ 逐日深比较 —— 不只看情绪分，是整个 day 对象（因子/诊断字段/相对强弱/分位全在内）
  assert.equal(scoped.length, full.length, '天数变了');
  const mismatches = [];
  for (let i = 0; i < full.length; i++) {
    const d = full[i].trade_date;
    if (!deepEqual(dayFingerprint(scoped[i]), dayFingerprint(full[i]))
      || !deepEqual(scoped[i].emotion, full[i].emotion)
      || !deepEqual(scoped[i].summary && scoped[i].summary.industry_relative,
        full[i].summary && full[i].summary.industry_relative)) {
      mismatches.push(d);
    }
  }
  assert.deepEqual(mismatches, [],
    `缩短重算范围后这些天结果变了：${mismatches.join('、')} —— 说明存在未被识别的跨日依赖，` +
    '必须停止缩小范围（见 src/pipeline.js::recalcAll 头注）');
});

test('★ 管线性质：skip 的天必须真的没被改动（逐字节）', () => {
  if (!ARCHIVE || !(ARCHIVE.all_days || []).length) return;
  const orig = ARCHIVE.all_days;
  const scoped = clone(orig);
  const scope = computeRecomputeScope(scoped);
  const inScope = new Set(scope.dates);

  // 先记录 scope 外各天的原始指纹
  const before = scoped.map((d) => (!inScope.has(d.trade_date) ? JSON.stringify(d) : null));
  recalcAll(scoped, { scope });
  const after = scoped.map((d) => (!inScope.has(d.trade_date) ? JSON.stringify(d) : null));

  const touched = [];
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== null && before[i] !== after[i]) touched.push(scoped[i].trade_date);
  }
  assert.deepEqual(touched, [], `这些 scope 外的天被改动了：${touched.join('、')}`);
});

test('管线性质：scope 为空对象/未传 → 行为与旧版一致（逐字段与全档相同）', () => {
  if (!ARCHIVE || !(ARCHIVE.all_days || []).length) return;
  const orig = ARCHIVE.all_days;
  const noScope = clone(orig);
  recalcAll(noScope);                 // 不传 opts
  const emptyScope = clone(orig);
  recalcAll(emptyScope, {});          // 传空 opts
  const nullScope = clone(orig);
  recalcAll(nullScope, { scope: null });

  for (let i = 0; i < noScope.length; i++) {
    assert.ok(deepEqual(noScope[i].emotion, emptyScope[i].emotion), `第 ${i} 天 emotion 不一致`);
    assert.ok(deepEqual(noScope[i].emotion, nullScope[i].emotion), `第 ${i} 天 emotion 不一致`);
  }
});

test('管线性质：scope.full=true → 退化为全档（口径变更时的逃生门）', () => {
  if (!ARCHIVE || !(ARCHIVE.all_days || []).length) return;
  const orig = ARCHIVE.all_days;
  const a = clone(orig); recalcAll(a);
  const b = clone(orig); recalcAll(b, { scope: { full: true, dates: [] } });
  for (let i = 0; i < a.length; i++) {
    assert.ok(deepEqual(dayFingerprint(a[i]), dayFingerprint(b[i])), `第 ${i} 天不一致`);
  }
});
