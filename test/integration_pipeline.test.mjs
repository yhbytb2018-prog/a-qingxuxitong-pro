// ① 真集成测：全管道对固定快照端到端跑 + 全档逐日 schema 校验 + golden archive 漂移检测。
//
// 与单元测的根本区别：这里不 mock、不切片——把 known-good 快照（test/fixtures/golden_input.json，
// 241 个交易日的真实历史）喂给**生产同一条管道**（enrich + recalcAll 全档，src/pipeline.js 唯一出处），
// 断言三件事：
//   ① 输出结构：天数/排序/字段完整性；
//   ② 关键值：每个真实天的 emotion 数值、七因子、去噪后题材数 —— 与 golden_summary.json 逐位相等；
//   ③ 漂移检测：任何让历史值漂移的改动（公式/权重/去噪/分位口径）都直接红。
//
// golden 纪律：改口径是合法操作，但必须显式跑 `node scripts/make_golden.mjs` 刷新并在
// commit message 说明漂移来源。**golden 文件缺失时本测试红**（不是跳过——静默跳过等于
// 漂移检测名存实亡）。
//
// 另附：对**当前真实档案** data/archive.json 的每一天跑严格 schema 校验（不止最新日）——
// 这样每天管道写档后 CI 自动全档体检，坏一天就能当天发现。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enrich, recalcAll } from '../src/pipeline.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIX_INPUT = path.join(ROOT, 'test', 'fixtures', 'golden_input.json');
const FIX_GOLDEN = path.join(ROOT, 'test', 'fixtures', 'golden_summary.json');
const REAL_ARCHIVE = path.join(ROOT, 'data', 'archive.json');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── 严格逐日 schema：每天都要过（真实天与回填天口径不同，分开校验）──────────────
//   返回错误字符串数组；空 = 该天合格。任何一条不过 = 存档里有坏天，当天就该发现。
export function daySchemaErrors(d, i) {
  const errs = [];
  const tag = `all_days[${i}](${d.trade_date || '?'})`;
  if (!d.trade_date || !DATE_RE.test(d.trade_date)) errs.push(`${tag} trade_date 非法`);
  if (typeof d.emotion !== 'object' || d.emotion === null) { errs.push(`${tag} 缺 emotion`); return errs; }
  const e = d.emotion;
  const isBackfill = !!e._backfill;
  const isLegacy = !!e._legacy;
  if (!isBackfill && !isLegacy) {
    if (typeof e.value !== 'number' || !Number.isFinite(e.value)) errs.push(`${tag} emotion.value 非数值`);
    else if (e.value < 0 || e.value > 100) errs.push(`${tag} emotion.value 越界 ${e.value}`);
    for (const k of ['s_net', 's_pos', 's_brd', 's_hot', 's_zdt', 's_zbl', 's_amt']) {
      const v = e[k];
      if (v != null && (typeof v !== 'number' || v < 0 || v > 100)) errs.push(`${tag} 因子 ${k} 越界 ${v}`);
    }
    if (!Array.isArray(e.missing)) errs.push(`${tag} emotion.missing 非数组`);
    if (typeof e.imputedRatio !== 'number' || e.imputedRatio < 0 || e.imputedRatio > 1) errs.push(`${tag} imputedRatio 越界 ${e.imputedRatio}`);
  } else {
    // 回填/legacy 天：情绪值仍须是合法数，但允许只占位（s_net 单因子）
    if (e.value != null && (typeof e.value !== 'number' || e.value < 0 || e.value > 100)) {
      errs.push(`${tag} 回填天 value 越界 ${e.value}`);
    }
  }
  // 分位：null（窗口不足）或 [0,100] —— 不允许其他类型
  for (const k of ['pct_rank', 'net_daily_pct_rank']) {
    const v = e[k];
    if (v != null && (typeof v !== 'number' || v < 0 || v > 100)) errs.push(`${tag} ${k} 非法值 ${v}`);
  }
  if (!Array.isArray(d.hot)) errs.push(`${tag} hot 非数组`);
  else {
    d.hot.slice(0, 200).forEach((h, j) => {
      if (!h || typeof h.code !== 'string' || !/^\d{6}$/.test(h.code)) errs.push(`${tag} hot[${j}] code 非法`);
      else if (h.name != null && typeof h.name !== 'string') errs.push(`${tag} hot[${j}] name 类型错`);
    });
  }
  if (d.topics != null && !Array.isArray(d.topics)) errs.push(`${tag} topics 非数组`);
  if (d.topics) d.topics.forEach((t, j) => {
    if (!t || typeof t.tag !== 'string' || t.tag.length === 0) errs.push(`${tag} topics[${j}] tag 非法`);
    if (!Number.isInteger(t.count) || t.count < 1) errs.push(`${tag} topics[${j}] count 非法 ${t.count}`);
  });
  if (d.summary != null && typeof d.summary !== 'object') errs.push(`${tag} summary 类型错`);
  if (typeof d.trade_date === 'string' && DATE_RE.test(d.trade_date)) {
    if (i > 0 && d.trade_date <= arguments[2]) errs.push(`${tag} 日期非严格递增`);
  }
  return errs;
}

// ── ① 固定快照端到端 + golden 漂移 ────────────────────────────────────────────
// 先跑管道（一次），多个 test 共享同一份产物，避免 4.6MB fixture 解析 N 遍。
const goldenInput = JSON.parse(readFileSync(FIX_INPUT, 'utf8'));
const golden = JSON.parse(readFileSync(FIX_GOLDEN, 'utf8'));
const days = JSON.parse(JSON.stringify(goldenInput.all_days)); // 深拷贝：不得污染 fixture
const { out, momObj } = enrich(days);
recalcAll(out); // 全档（生产 runOffline 同路径）
const realOut = out.filter((d) => d.emotion && !d.emotion._backfill);

test('集成①: golden fixture 存在（缺失=红，不静默跳过）', () => {
  assert.ok(existsSync(FIX_INPUT), 'test/fixtures/golden_input.json 缺失 —— 跑 node scripts/make_golden.mjs 生成');
  assert.ok(existsSync(FIX_GOLDEN), 'test/fixtures/golden_summary.json 缺失 —— 跑 node scripts/make_golden.mjs 生成');
  assert.ok(Array.isArray(goldenInput.all_days) && goldenInput.all_days.length === 241, 'fixture 天数异常');
});

test('集成②: 管道输出结构（天数/真实回填拆分/日期严格递增）', () => {
  assert.equal(out.length, golden.structure.archiveDays, '总天数漂移');
  assert.equal(realOut.length, golden.structure.realDays, '真实天数漂移');
  assert.equal(out.length - realOut.length, golden.structure.backfillDays, '回填天数漂移');
  assert.equal(out[0].trade_date, golden.structure.firstDay);
  assert.equal(out[out.length - 1].trade_date, golden.structure.lastDay);
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i].trade_date > out[i - 1].trade_date, `日期非严格递增 @${i}: ${out[i - 1].trade_date} >= ${out[i].trade_date}`);
  }
});

test('集成③: 关键值逐位相等 —— 每个真实天的情绪分/七因子/题材数（golden 漂移检测）', () => {
  assert.equal(realOut.length, golden.realDaysSeries.length, '真实天数与 golden 序列长度不一致');
  for (let i = 0; i < realOut.length; i++) {
    const got = realOut[i], exp = golden.realDaysSeries[i];
    assert.equal(got.trade_date, exp.date, `第${i}个真实天日期漂移: ${got.trade_date} != ${exp.date}`);
    assert.equal(got.emotion.value, exp.value, `${exp.date} 情绪分漂移: ${got.emotion.value} != ${exp.value}`);
    assert.equal((got.topics || []).length, exp.topics, `${exp.date} 题材数漂移: ${(got.topics || []).length} != ${exp.topics}`);
    for (const k of ['s_net', 's_pos', 's_brd', 's_hot', 's_zdt', 's_zbl', 's_amt']) {
      assert.equal(got.emotion[k], exp[k], `${exp.date} 因子 ${k} 漂移: ${got.emotion[k]} != ${exp[k]}`);
    }
    assert.equal((got.emotion.missing || []).length, exp.missing, `${exp.date} 缺失因子数漂移`);
  }
});

test('集成④: 最新日分位（防前视窗口口径锁定）', () => {
  const last = out[out.length - 1];
  assert.equal(last.emotion.value, golden.latest.value);
  assert.equal(last.emotion.pct_rank, golden.latest.pct_rank, '最新日 pct_rank 漂移（防前视窗口口径变了？）');
  assert.equal(last.emotion.net_daily_pct_rank, golden.latest.net_daily_pct_rank);
});

test('集成⑤: 题材动量分类计数（去噪 + 双窗口口径锁定）', () => {
  assert.equal(momObj.fresh.length, golden.momentum.fresh, 'fresh 计数漂移（题材去噪口径变了？）');
  assert.equal(momObj.fading.length, golden.momentum.fading, 'fading 计数漂移');
  assert.equal(momObj.continuing.length, golden.momentum.continuing, 'continuing 计数漂移');
});

test('集成⑥: 全档 241 天逐日严格 schema（fixture 端到端产物）', () => {
  const errs = [];
  for (let i = 0; i < out.length; i++) {
    for (const e of daySchemaErrors(out[i], i, i > 0 ? out[i - 1].trade_date : null)) errs.push(e);
  }
  assert.deepEqual(errs, [], `schema 校验失败 ${errs.length} 条:\n` + errs.slice(0, 20).join('\n'));
});

// ── ② 对当前真实档案全档逐日体检（每天写档后 CI 自动跑，坏天当天发现）──────────
test('集成⑦: 真实 data/archive.json 全档逐日 schema 校验（不止最新日）', (t) => {
  if (!existsSync(REAL_ARCHIVE)) {
    t.skip('真实档案不存在（新环境）');
    return;
  }
  const arc = JSON.parse(readFileSync(REAL_ARCHIVE, 'utf8'));
  assert.ok(Array.isArray(arc.all_days) && arc.all_days.length >= 200, '真实档案天数异常');
  const errs = [];
  for (let i = 0; i < arc.all_days.length; i++) {
    for (const e of daySchemaErrors(arc.all_days[i], i, i > 0 ? arc.all_days[i - 1].trade_date : null)) errs.push(e);
  }
  assert.deepEqual(errs, [], `真实档案 schema 失败 ${errs.length} 条:\n` + errs.slice(0, 20).join('\n'));
});

// ⑦ 里的 skip 写法修正：node:test 里用 t.skip()
test('集成⑦b: 真实档案签名（天数与最新日，跨快照烟雾一致性）', { skip: !existsSync(REAL_ARCHIVE) }, (t) => {
  const arc = JSON.parse(readFileSync(REAL_ARCHIVE, 'utf8'));
  t.assert.ok(arc.all_days.length >= fixtureDays(goldenInput), '真实档案天数不应少于 fixture 快照');
});
function fixtureDays(fix) { return fix.all_days.length; }
