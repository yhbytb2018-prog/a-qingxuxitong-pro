// 历史回填机制测试
//
// 纪律：fixture 一律由**真实现**现生成（normalizeRecord / mergeDuplicateRecords），
// 不手抄字段——手抄等于第二套口径，会把「实现写错了但测试仍绿」这种最坏情况放过去。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBackfillDay, isBackfillDay, BACKFILL_FLAG } from '../src/backfill.js';
import { normalizeRecord, duplicateKeys } from '../src/lhb.js';
import { computeSentiment } from '../src/sentiment.js';
import { validateArchive } from '../src/validate.js';
import config from '../src/config.js';

// 东财原始记录的最小形态（字段名与线上一致，取自 RPT_DAILYBILLBOARD_DETAILSNEW）。
// ⚠ 金额字段单位是**元**（normalizeRecord 会 /1e4 转成万元），不是万元——写小两个数量级会让亿级汇总四舍五入成 0。
const rawRec = (code, name, explanation, net, buy, sell, extra = {}) => ({
  SECURITY_CODE: code,
  SECURITY_NAME_ABBR: name,
  EXPLANATION: explanation,
  CLOSE_PRICE: extra.close ?? 10,
  CHANGE_RATE: extra.chg ?? 10,
  BILLBOARD_NET_AMT: net,
  BILLBOARD_BUY_AMT: buy,
  BILLBOARD_SELL_AMT: sell,
  BILLBOARD_DEAL_AMT: extra.deal ?? buy + sell,
  TURNOVERRATE: extra.turn ?? 5,
});

test('回填天：只填 lhb 与 s_net，其余因子必须 missing 且不参与综合分', () => {
  const raw = [
    rawRec('600001', '甲股', '日涨幅达到15%的前5只证券', 1.2e8, 2e8, 0.8e8, { close: 10, turn: 3 }),
    rawRec('600002', '乙股', '日换手率达到30%的前5只证券', -0.5e8, 0.3e8, 0.8e8),
  ];
  const day = buildBackfillDay('2026-01-05', raw);

  assert.equal(day.trade_date, '2026-01-05');
  assert.ok(Array.isArray(day.hot) && day.hot.length === 0, 'hot 必须是空数组（未采集，不伪造）');
  assert.equal(day.summary.ind_count, 0, '未采集的行业数必须是 0 且留痕');
  assert.equal(day.summary.backfilled, true);

  // 六因子必须 missing；只有 s_net 有值
  assert.ok(day.emotion.missing.length === 6, `应恰好 6 个 missing，实得 ${day.emotion.missing.length}`);
  assert.ok(!day.emotion.missing.includes('s_net'), 's_net 不能是 missing');
  assert.ok(day.emotion.s_net >= 0 && day.emotion.s_net <= 100);

  // value 是 s_net 占位，不是六因子缺失下的加权分
  assert.equal(day.emotion.value, day.emotion.s_net, 'value 应为 s_net 占位值');
  const sent = computeSentiment({ netBuy: day.summary.lhb_daily_net, newStockNet: day.summary.lhb_new_net ?? 0 }, config.weights);
  assert.equal(day.emotion.value, sent.factors.s_net20, 's_net 必须与唯一公式实现同源');
});

test('回填天：s_net 与正式链路同源（同样入参必须得到同样因子值）', () => {
  // 构造一个含新股与普通股的混合日，验证剔新股口径在回填路径同样生效
  const raw = [
    rawRec('600001', '普通股', '日涨幅偏离值达到7%的前5只证券', 1.0e8, 1.5e8, 0.5e8),
    rawRec('301999', '新股', '无价格涨跌幅限制的证券', 0.6e8, 0.9e8, 0.3e8, { chg: 300 }),
  ];
  const day = buildBackfillDay('2026-01-06', raw);
  // 证据链必须有：新股净买被识别并单列
  assert.ok(day.summary.lhb_new_net != null, '新股净买必须留痕');
  // s_net 喂的应是剔新股后的净买
  assert.ok(day.emotion.newStock, 'newStock 元信息必须存在');
  assert.equal(day.emotion.newStock.adjusted, true, '有新股净买时 adjusted 应为真');
});

test('回填天：必须通过 validateArchive（否则回填后整个档案写不进盘）', () => {
  const raw = [rawRec('600001', '甲股', '日涨幅达到15%的前5只证券', 1.2e8, 2e8, 0.8e8, { close: 10, turn: 3 })];
  const day = buildBackfillDay('2026-01-05', raw);
  const arc = {
    meta: { generatedAt: '2026-01-05T19:30:00Z' },
    signals: { tradeDate: '2026-01-05', momentum: {} },
    all_days: [day],
  };
  const v = validateArchive(arc);
  assert.equal(v.ok, true, `回填天应通过校验，实得错误：${v.errors.join(' / ')}`);
});

test('回填天：lhb 明细已去重且带 reasons 数组（下游不会双算）', () => {
  // 同票同口径同值两条不同 reason —— 与 2026-08-14 蓝盾光电 300862 同形态
  const raw = [
    rawRec('300862', '蓝盾光电', '日涨幅达到15%的前5只证券', 373823000, 692549000, 318726000),
    rawRec('300862', '蓝盾光电', '日换手率达到30%的前5只证券', 373823000, 692549000, 318726000),
  ];
  const normalized = raw.map(normalizeRecord);
  const day = buildBackfillDay('2026-08-14', raw);
  assert.equal(day.lhb.length, 1, '同值重复必须合并为 1 条');
  assert.equal(day.lhb[0].reasons.length, 2, '两条上榜原因必须并入 reasons 数组');
  assert.deepEqual(duplicateKeys(day.lhb), [], '合并后不得残留重复键');
  // 当日榜净额不得双算（37382.3 万 = 3.738 亿，不是 7.476 亿）
  assert.ok(Math.abs(day.summary.lhb_daily_net - 3.74) < 0.02,
    `净额不得双算，实得 ${day.summary.lhb_daily_net}`);
  assert.equal(day.summary.lhb_raw_count, 2, '原始条数应为 2');
  assert.equal(day.summary.lhb_merged_away, 1);
});

test('回填天：跨口径数值不同则各留一条（不合并）', () => {
  // 603118 形态：区间累计榜与当日榜数值本就不同
  const raw = [
    rawRec('603118', '中际联合', '连续三个交易日内，涨幅偏离值累计达到20%的证券', 228506000, 300000000, 71494000),
    rawRec('603118', '中际联合', '日涨幅偏离值达到7%的前5只证券', 78944000, 120000000, 41056000),
  ];
  const day = buildBackfillDay('2026-08-14', raw);
  assert.equal(day.lhb.length, 2, '跨口径不同值必须各留一条');
  assert.equal(day.summary.lhb_range_count, 1, '区间榜计数应为 1');
  // 当日榜口径只取当日那条
  assert.ok(Math.abs(day.summary.lhb_daily_net - 0.79) < 0.02,
    `当日榜净额应只含当日值，实得 ${day.summary.lhb_daily_net}`);
});

test('回填天判据唯一出处：isBackfillDay 只认 emotion._backfill', () => {
  const day = buildBackfillDay('2026-01-05', [rawRec('600001', '甲股', '日涨幅达到15%的前5只证券', 1e8, 1.5e8, 0.5e8)]);
  assert.equal(isBackfillDay(day), true);
  assert.equal(day.emotion[BACKFILL_FLAG], true);
  // 完整档（无该字段）不得被判为回填
  assert.equal(isBackfillDay({ emotion: { value: 60 } }), false);
  assert.equal(isBackfillDay({}), false);
  assert.equal(isBackfillDay(null), false);
});

test('回填天：空记录不得抛错（非交易日/接口异常时的兜底）', () => {
  const day = buildBackfillDay('2026-01-07', []);
  assert.equal(day.lhb.length, 0);
  assert.equal(isBackfillDay(day), true);
  assert.ok(Number.isFinite(day.emotion.value), 'value 必须仍是有限数（否则整个档案校验会拦下）');
});
