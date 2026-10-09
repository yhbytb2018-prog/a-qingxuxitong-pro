// 数据血统表守卫：factor_lineage.json 与代码口径的一致性锁定。
//
// 为什么需要这个测试：血统表是「描述性文档」，最大风险是**代码改了、表没跟**——
// 那一刻它就从「台账」退化成「谎言」。守卫点：
//   ① 七因子齐全且 id 与 config.weights 的键**集合相等**（多/少/改名都会炸）；
//   ② 表中权重数值与 config.weights 逐项相等（改权重不改表 = 台账失真）；
//   ③ 权重和为 1（情绪分是加权和，权重和≠1 则分数量纲漂移）；
//   ④ 每个因子五要素齐全：formula/numerator/denominator/timeAlignment/missingPolicy；
//   ⑤ 缺失策略必须显式声明「中性50标记」——禁止静默口径入表；
//   ⑥ 时间对齐必须含防前视声明（「T−1」「之前」「不含当日」任一关键词，
//      因为 s_amt 分母与 pct_rank 窗口都是防前视命门）；
//   ⑦ 派生指标必须覆盖 pct_rank / net_daily_pct_rank（唯一分位口径出处）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../src/config.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const doc = JSON.parse(readFileSync(path.join(ROOT, 'factor_lineage.json'), 'utf8'));

const W = config.weights;
const weightKeys = Object.keys(W);

test('lineage: 七因子 id 与 config.weights 键集合相等', () => {
  const ids = doc.factors.map((f) => f.id);
  assert.deepEqual([...ids].sort(), [...weightKeys].sort());
});

test('lineage: 表中权重与 config.weights 逐项相等', () => {
  for (const f of doc.factors) {
    assert.equal(f.weight, W[f.id], `${f.id} 权重不一致：表 ${f.weight} vs config ${W[f.id]}`);
  }
});

test('lineage: 权重和为 1（加权和量纲约束）', () => {
  const sum = weightKeys.reduce((a, k) => a + W[k], 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `权重和 ${sum} ≠ 1`);
});

test('lineage: 每因子五要素齐全（公式/分子/分母/时间对齐/缺失策略）', () => {
  for (const f of doc.factors) {
    for (const key of ['formula', 'timeAlignment', 'missingPolicy']) {
      assert.ok(typeof f[key] === 'string' && f[key].length > 5, `${f.id}.${key} 缺失`);
    }
    assert.ok(f.numerator && typeof f.numerator.chain === 'string' && f.numerator.chain.length > 10, `${f.id}.numerator.chain 缺失`);
    assert.ok(f.denominator && typeof f.denominator.chain === 'string' && f.denominator.chain.length > 5, `${f.id}.denominator.chain 缺失`);
    assert.ok(typeof f.circuitBreaker === 'string', `${f.id}.circuitBreaker 缺失（无熔断也须显式写「无」）`);
    assert.ok(Array.isArray(f.evidenceFields) && f.evidenceFields.length > 0, `${f.id}.evidenceFields 缺失`);
  }
});

test('lineage: 缺失策略必须显式声明中性50标记（禁静默口径）', () => {
  for (const f of doc.factors) {
    assert.ok(/中性\s*50|中性50/.test(f.missingPolicy), `${f.id} 缺失策略未声明中性50标记`);
  }
});

test('lineage: 时间对齐必须含防前视声明', () => {
  const NO_LOOKAHEAD = /T−1|T-1|之前|不含当日|防前视|无前视|无跨日依赖/;
  for (const f of doc.factors) {
    assert.ok(NO_LOOKAHEAD.test(f.timeAlignment), `${f.id}.timeAlignment 无防前视声明`);
  }
});

test('lineage: 派生指标覆盖两个分位口径（唯一出处声明）', () => {
  const ids = doc.derivedIndicators.map((d) => d.id);
  assert.ok(ids.includes('pct_rank'), '缺 pct_rank');
  assert.ok(ids.includes('net_daily_pct_rank'), '缺 net_daily_pct_rank');
  for (const d of doc.derivedIndicators) {
    assert.ok(/RANK_MIN|20/.test(d.formula + d.timeAlignment), `${d.id} 未声明 RANK_MIN 样本下限`);
    assert.ok(/不含当日|含当日|之前/.test(d.timeAlignment), `${d.id} 无窗口对齐声明`);
  }
});

test('lineage: formulaVersion 与 config 一致', () => {
  assert.equal(doc.meta.formulaVersion, config.formulaVersion);
});
