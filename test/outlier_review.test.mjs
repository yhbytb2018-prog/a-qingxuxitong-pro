// 行业离群「销案」机制 —— 单测
// 纪律：样本由本模块真函数现构造（绝不手抄生产数字）；真台账文件另有一条"结构不许坏"守卫。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  reviewKey, validateLedger, buildReviewMap, confirmedSet, mergeEntries, VERDICTS,
} from '../src/outlier_review.js';
import { validateDay, VALIDATION_RULES, SEVERITY } from '../src/dirty.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 构造一天：n 个"有邻居"的行业 + 一个孤立离群（默认 9.36%），触发 OUTLIER_INDUSTRY。 */
function dayWithOutlier({ date = '2026-08-18', outlierPct = 9.36, outlierName = '种植业与林业', others = 20 } = {}) {
  const industry = [{ name: outlierName, change_pct: outlierPct }];
  for (let i = 0; i < others; i++) industry.push({ name: `行业${i}`, change_pct: Math.round((i * 0.15) * 100) / 100 }); // 0~2.85 簇
  return { trade_date: date, hot: [], industry, indexes: [], summary: {}, emotion: {} };
}

const outlierIssues = (vres) => (vres.issues || []).filter((i) => i.rule === 'OUTLIER_INDUSTRY');

test('reviewKey: 同一实现（写入方/消费方共用，漂移即销案静默失效）', () => {
  assert.equal(reviewKey('2026-08-18', '种植业与林业'), '2026-08-18|种植业与林业');
  assert.equal(reviewKey(null, 'x'), reviewKey('', 'x')); // null/空串归一
});

test('validateLedger: 合法台账通过；结构/证据缺失必须红（无证据不得销案）', () => {
  const good = {
    kind: 'industry-outlier-review',
    entries: [{ date: '2026-08-18', industry: '种植业与林业', changePct: 9.36, verdict: VERDICTS.REAL, method: 'cross-source', evidence: { source: '同花顺 881101', recomputed: 9.36 } }],
  };
  assert.deepEqual(validateLedger(good), { ok: true, errors: [] });

  // 销案缺证据 → 必须报错（销案不能是"不想看的告警就关掉"的后门）
  const noEvidence = { kind: 'industry-outlier-review', entries: [{ date: '2026-08-18', industry: 'x', verdict: VERDICTS.REAL, method: 'cross-source' }] };
  assert.ok(validateLedger(noEvidence).errors.some((e) => e.includes('evidence')), '缺 evidence 应报错');

  const noSource = { kind: 'industry-outlier-review', entries: [{ date: '2026-08-18', industry: 'x', verdict: VERDICTS.REAL, method: 'm', evidence: {} }] };
  assert.ok(validateLedger(noSource).errors.some((e) => e.includes('source')), '缺 evidence.source 应报错');

  // data-error 不要求证据（那是"待查"，不是销案）
  const errEntry = { kind: 'industry-outlier-review', entries: [{ date: '2026-08-18', industry: 'x', verdict: VERDICTS.ERROR }] };
  assert.equal(validateLedger(errEntry).ok, true, 'data-error 条目无需证据字段');

  // 非法 verdict / 主键重复
  assert.ok(!validateLedger({ kind: 'industry-outlier-review', entries: [{ date: '2026-08-18', industry: 'x', verdict: 'whatever' }] }).ok);
  const dup = { kind: 'industry-outlier-review', entries: [
    { date: '2026-08-18', industry: 'x', verdict: VERDICTS.ERROR },
    { date: '2026-08-18', industry: 'x', verdict: VERDICTS.ERROR },
  ] };
  assert.ok(validateLedger(dup).errors.some((e) => e.includes('重复')), '主键重复应报错');
});

test('confirmedSet: 只收 confirmed-real（data-error 必须继续报警，不许被销案吞掉）', () => {
  const led = { kind: 'industry-outlier-review', entries: [
    { date: '2026-01-21', industry: '贵金属', verdict: VERDICTS.REAL, method: 'cross-source', evidence: { source: 's' } },
    { date: '2026-01-23', industry: '坏数据行业', verdict: VERDICTS.ERROR },
  ] };
  const set = confirmedSet(led);
  assert.ok(set.has(reviewKey('2026-01-21', '贵金属')));
  assert.ok(!set.has(reviewKey('2026-01-23', '坏数据行业')), 'data-error 不得进入销案集合');
  assert.equal(set.size, 1);
});

test('mergeEntries: 幂等合并 + 排序稳定 + 不丢异键条目', () => {
  const led = { kind: 'industry-outlier-review', version: 1, entries: [
    { date: '2026-02-10', industry: '影视院线', verdict: VERDICTS.REAL, method: 'm', evidence: { source: 's' } },
  ] };
  const merged = mergeEntries(led, [
    { date: '2026-01-21', industry: '贵金属', verdict: VERDICTS.REAL, method: 'm', evidence: { source: 's' } },
    { date: '2026-02-10', industry: '影视院线', verdict: VERDICTS.ERROR }, // 同键 → 新条目覆盖
  ]);
  assert.equal(merged.entries.length, 2);
  assert.deepEqual(merged.entries.map((e) => e.date), ['2026-01-21', '2026-02-10'], '按日期排序');
  assert.equal(merged.entries[1].verdict, VERDICTS.ERROR, '同键以新条目为准');
  assert.equal(led.entries.length, 1, '原台账不被就地改');
});

test('dirty: 注入销案集合后，该离群不再报 warn，转为 suppressedReviews（可审计）', () => {
  const d = dayWithOutlier();
  const base = validateDay(d);
  assert.equal(outlierIssues(base).length, 1, '未注入销案时照报（缺省不销案）');
  assert.equal(base.status, 'warn');
  assert.deepEqual(base.suppressedReviews, []);

  const reviewed = new Set([reviewKey('2026-08-18', '种植业与林业')]);
  const sup = validateDay(d, { reviewedOutliers: reviewed });
  assert.equal(outlierIssues(sup).length, 0, '已销案 → 不再重复报 warn');
  assert.equal(sup.suppressedReviews.length, 1);
  assert.equal(sup.suppressedReviews[0].industry, '种植业与林业');
  assert.equal(sup.suppressedReviews[0].date, '2026-08-18');
  assert.match(sup.suppressedReviews[0].reason, /销案/);
  // 销案不改数值与判定语义：原值仍在档、无 dirty 标记
  assert.deepEqual(sup.dirtyFields, []);
  assert.equal(d.industry[0].change_pct, 9.36, '销案绝不动原值');
});

test('dirty: 销案只对"命中键"生效（同行业别的日期照常报警）', () => {
  const d = dayWithOutlier({ date: '2026-09-30' });
  const reviewed = new Set([reviewKey('2026-08-18', '种植业与林业')]); // 只有 8-18 销案
  const r = validateDay(d, { reviewedOutliers: reviewed });
  assert.equal(outlierIssues(r).length, 1, '别日期的同类离群不受影响');
  assert.equal(r.suppressedReviews.length, 0);
});

test('dirty: 销案集合可为数组（调用方友好），非 Set 非法值不误销案', () => {
  const d = dayWithOutlier();
  const r1 = validateDay(d, { reviewedOutliers: [reviewKey('2026-08-18', '种植业与林业')] });
  assert.equal(outlierIssues(r1).length, 0, '数组形式同样生效');
  const r2 = validateDay(d, { reviewedOutliers: 'not-a-collection' });
  assert.equal(outlierIssues(r2).length, 1, '非法入参退化为不销案（宁报不默）');
});

test('真台账 data/industry_outlier_review.json：结构必须始终合法（坏了销案会静默失效）', () => {
  const ledger = JSON.parse(readFileSync(join(ROOT, 'data', 'industry_outlier_review.json'), 'utf8'));
  const v = validateLedger(ledger);
  assert.deepEqual(v.errors, [], `真台账结构错误：${v.errors.join('；')}`);
  assert.ok(ledger.entries.length > 0, '台账不应为空（否则销案机制形同虚设）');
  // 每条销案都必须写明复核方式与来源（证据纪律）
  for (const e of ledger.entries) {
    if (e.verdict === VERDICTS.REAL) {
      assert.ok(e.evidence && e.evidence.source, `${e.date} ${e.industry} 销案缺来源`);
      assert.ok(Number.isFinite(e.evidence.recomputed), `${e.date} ${e.industry} 销案缺复算值`);
    }
  }
});

test('规则常量对销案机制的自洽性：OUTLIER_INDUSTRY 仍是 WARN（销案不改严重度设计）', () => {
  const d = dayWithOutlier();
  const r = validateDay(d);
  const it = outlierIssues(r)[0];
  assert.equal(it.severity, SEVERITY.WARN, '离群仍为 WARN——销案只停重复告警，不改"只标不剔除"的设计');
  assert.ok(VALIDATION_RULES.MIN_INDUSTRY_SAMPLE >= 2);
});
