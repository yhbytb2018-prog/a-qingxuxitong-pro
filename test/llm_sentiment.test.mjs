// LLM 舆情因子（V5.3 P2 试点）守卫测试：
//   ① ±5 上限截断；② 观望区（44~65）不生效；③ 反向不生效（保守保持原分）；
//   ④ 原分不动——modified 只是参考分，绝不能写回 emotion.value（本模块无写路径，
//     用"输出结构与原分分离"锁）；⑤ 缺失/坏结构/证据日期不符 → null 显式化。
import test from 'node:test';
import assert from 'node:assert/strict';

import { llmSentimentBlock, LLM_ADJ_LIMIT } from '../src/llm_sentiment.js';

const mk = (over = {}) => ({
  asOfDate: '2026-09-30',
  generatedAt: '2026-09-30T15:30:00+08:00',
  model: 'test-model',
  sentiment: 0.6,
  events: [{ type: '业绩预告', target: '某板块', tone: 'positive' }],
  confidence: 0.7,
  reason: '龙头业绩预增带动板块情绪',
  ...over,
});

test('±5 上限：|sentiment|×5 超限截断，小额保留 1 位小数', () => {
  const a = llmSentimentBlock(mk({ sentiment: 0.9 }), { score: 70, tradeDate: '2026-09-30' });
  assert.equal(a.adj, 4.5, '0.9×5=4.5（未超限，保留 1 位小数）');
  const b = llmSentimentBlock(mk({ sentiment: -1 }), { score: 40, tradeDate: '2026-09-30' });
  assert.equal(b.adj, -5, '-1×5=-5（达下限）');
  const c = llmSentimentBlock(mk({ sentiment: 0.33 }), { score: 70, tradeDate: '2026-09-30' });
  assert.equal(c.adj, 1.7, '0.33×5=1.65 → 四舍五入 1.7');
  assert.ok(Math.abs(a.adj) <= 5 && Math.abs(b.adj) <= 5 && Math.abs(c.adj) <= 5, '上限恒成立');
});

test('生效规则：原分 ≥65（持有档）+ 舆情正面 → 同向增强', () => {
  const r = llmSentimentBlock(mk({ sentiment: 0.4 }), { score: 68, tradeDate: '2026-09-30' });
  assert.equal(r.effective, true);
  assert.equal(r.direction, 'bullish');
  assert.equal(r.original, 68);
  assert.equal(r.modified, 70, '68 + 0.4×5=2 → 70');
  assert.match(r.effectNote, /同向增强/);
});

test('生效规则：原分 <44（减仓档）+ 舆情负面 → 同向增强（向下修正）', () => {
  const r = llmSentimentBlock(mk({ sentiment: -0.6 }), { score: 38, tradeDate: '2026-09-30' });
  assert.equal(r.effective, true);
  assert.equal(r.direction, 'bearish');
  assert.equal(r.modified, 35, '38 - 3 → 35');
});

test('生效规则：观望区（44~65）原因子无方向 → 舆情单方面不生效', () => {
  for (const score of [44, 50, 60, 64.9]) {
    const r = llmSentimentBlock(mk({ sentiment: 0.9 }), { score, tradeDate: '2026-09-30' });
    assert.equal(r.effective, false, `score=${score} 观望区不生效`);
    assert.equal(r.modified, null, '不生效 → 无修正分（null 而非等于原分）');
    assert.match(r.effectNote, /观望区/);
  }
});

test('生效规则：方向矛盾（原分偏多 vs 舆情负面）→ 保守保持原分', () => {
  const r = llmSentimentBlock(mk({ sentiment: -0.8 }), { score: 70, tradeDate: '2026-09-30' });
  assert.equal(r.effective, false);
  assert.equal(r.modified, null);
  assert.match(r.effectNote, /方向矛盾/);
  assert.equal(r.original, 70, '原分绝不动');
});

test('LLM 舆情中性（sentiment=0）→ 无修正', () => {
  const r = llmSentimentBlock(mk({ sentiment: 0 }), { score: 70, tradeDate: '2026-09-30' });
  assert.equal(r.effective, false);
  assert.equal(r.adj, 0);
  assert.match(r.effectNote, /中性/);
});

test('缺失显式化：null/坏结构/超界 sentiment → null（不假装中性）', () => {
  assert.equal(llmSentimentBlock(null, { score: 70, tradeDate: '2026-09-30' }), null);
  assert.equal(llmSentimentBlock({}, { score: 70, tradeDate: '2026-09-30' }), null);
  assert.equal(llmSentimentBlock(mk({ sentiment: 1.5 }), { score: 70, tradeDate: '2026-09-30' }), null);
  assert.equal(llmSentimentBlock(mk({ sentiment: 'abc' }), { score: 70, tradeDate: '2026-09-30' }), null);
});

test('证据日期防伪：asOfDate ≠ 目标交易日 → null（昨日证据不冒充今日）', () => {
  const r = llmSentimentBlock(mk({ asOfDate: '2026-09-29' }), { score: 70, tradeDate: '2026-09-30' });
  assert.equal(r, null);
});

test('边界：修正分夹在 [0,100]（原分贴近边界时）', () => {
  const r = llmSentimentBlock(mk({ sentiment: -1 }), { score: 42, tradeDate: '2026-09-30' });
  assert.equal(r.effective, true, '42 < 44 偏空，-1 同向');
  assert.equal(r.modified, 37, '42-5=37');
  // 观望区上沿的极高负分不会出现（观望区不生效），但夹取逻辑仍要健壮
  const hi = llmSentimentBlock(mk({ sentiment: 1 }), { score: 98, tradeDate: '2026-09-30' });
  assert.equal(hi.modified, 100, '98+5 → 夹到 100');
});

test('输出形态：note 声明试点语义，events 裁剪上限 8 条', () => {
  const many = mk({ events: Array.from({ length: 20 }, (_, i) => ({ type: `t${i}` })) });
  const r = llmSentimentBlock(many, { score: 70, tradeDate: '2026-09-30' });
  assert.equal(r.events.length, 8, '事件透传裁剪到 8 条（体积纪律）');
  assert.match(r.note, /不独立生成买卖信号/);
  assert.match(r.note, /原分不动/);
  assert.equal(r.model, 'test-model');
  assert.equal(r.sentimentRaw, 0.6);
});
