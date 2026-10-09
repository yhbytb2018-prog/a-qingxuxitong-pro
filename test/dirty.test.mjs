// #3 异常值/脏数据自动标脏 —— 单测
// 纪律：测试样本由本模块的真函数现生成（或显式最小构造），绝不手抄生产数字。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateDay, validateAll, dirtyArgsOf, sanitizeForFactors, indexChangePct,
  num, median, VALIDATION_RULES, SEVERITY,
} from '../src/dirty.js';

// ── 构造器：最小可用的一天（只含被测字段，其余留空）─────────────────────
function day(patch = {}) {
  return {
    trade_date: patch.trade_date || '2026-09-30',
    hot: patch.hot || [],
    industry: patch.industry || [],
    indexes: patch.indexes || [],
    summary: patch.summary || {},
    emotion: patch.emotion || {},
  };
}

// ── num(): +0 类陷阱加固（本项目第三次踩，必须有测试锁死）────────────────
test('num: null / 空串 / 数组 / 对象 / 布尔 一律 null', () => {
  assert.equal(num(null), null);
  assert.equal(num(undefined), null);
  assert.equal(num(''), null);
  assert.equal(num([]), null, '+[] === 0 陷阱');
  assert.equal(num([5]), null, '+[5] === 5，也不该接受');
  assert.equal(num({}), null, '+{} === NaN');
  assert.equal(num(true), null, '+true === 1，语义不明');
  assert.equal(num(NaN), null);
  assert.equal(num(Infinity), null);
});

test('num: 正常数字与数字字符串通过，含 0/负数', () => {
  assert.equal(num(0), 0, '0 是合法值，不是缺失');
  assert.equal(num('0'), 0);
  assert.equal(num(3.14), 3.14);
  assert.equal(num('-2.5'), -2.5);
  assert.equal(num(-100), -100);
});

// ── ① 范围校验 ───────────────────────────────────────────────────────────
test('★ 真实板块轮动不得误判：2026-08-18 种植业与林业 +9.36%、指数 -0.93% → 不判脏', () => {
  // 实测反证（两轮）：初版「行业动大 + 指数不动 = 源抽风」在此误报；改用 MAD 后
  // MAD=0 退化再次误报；改用 gap 判据后仅剩 WARN。
  // 经查证 8-18 农林牧渔板块真实领涨（粮食/猪肉概念爆发、十余只涨停，2121 涨/3292 跌）
  // ——这是轮动，不是脏数据。本用例锁死：**不得判 dirty（error 级）**。
  //
  // 真实分布（取自 data/archive.json，非手抄）：9.36, 3.51, 2.95, 2.3, 2.07, 1.53, ...
  const industries = [
    { name: '种植业与林业', change_pct: 9.36 },
    { name: '农产品加工', change_pct: 3.51 },
    { name: '养殖业', change_pct: 2.95 },
    { name: '农化制品', change_pct: 2.3 },
    { name: '油气开采及服务', change_pct: 2.07 },
    { name: '燃气', change_pct: 1.53 },
    { name: '其他A', change_pct: 1.5 },
    { name: '其他B', change_pct: 1.21 },
    { name: '其他C', change_pct: 1.04 },
  ];
  for (let i = 0; i < 41; i++) industries.push({ name: '平行业' + i, change_pct: 0.5 });
  for (let i = 0; i < 40; i++) industries.push({ name: '跌行业' + i, change_pct: -0.6 });
  const r = validateDay(day({ industry: industries, indexes: [{ name: '创业板指', change_pct: -0.93 }] }));
  assert.equal(r.status, 'warn', '数值孤立只标记不剔除');
  assert.equal(r.dirtyFields.length, 0, '绝不剔除行业数据 —— 那是把信号当噪声');
});

test('★ 真实板块轮动不得误判：2026-08-20 生物制品 +9.12%、指数 +0.64% → 不判脏', () => {
  // 真实分布：9.12, 5.9, 4.9, 4.14, 3.82, 3.34, 3.12, 3.03, ...（无明显断崖）
  const industries = [
    { name: '生物制品', change_pct: 9.12 },
    { name: '医疗服务', change_pct: 5.9 },
    { name: '贵金属', change_pct: 4.9 },
    { name: '医疗器械', change_pct: 4.14 },
    { name: '化学制药', change_pct: 3.82 },
    { name: '通信设备', change_pct: 3.34 },
  ];
  for (let i = 0; i < 44; i++) industries.push({ name: '行业' + i, change_pct: 1.1 });
  for (let i = 0; i < 40; i++) industries.push({ name: '跌行业' + i, change_pct: -0.3 });
  const r = validateDay(day({ industry: industries, indexes: [{ name: '创业板指', change_pct: 0.64 }] }));
  assert.equal(r.status, 'ok', '逐级递减、无断崖 → 完全干净');
});

test('★ 孤立离群只标 WARN：一个行业 +11% 与其余全体相距 >4 个百分点', () => {
  const industries = [{ name: '异常行业', change_pct: 11.0 }];
  for (let i = 0; i < 60; i++) industries.push({ name: '行业' + i, change_pct: 0.4 });
  for (let i = 0; i < 29; i++) industries.push({ name: '跌行业' + i, change_pct: -0.35 });
  const r = validateDay(day({ industry: industries }));
  assert.equal(r.status, 'warn', '孤立离群标 WARN 不标 ERROR');
  assert.equal(r.dirtyFields.length, 0, 'WARN 不进 dirtyFields（不剔除）');
  assert.ok(r.warnFields.includes('industry[].change_pct'));
  assert.ok(r.issues.some((i) => i.rule === 'OUTLIER_INDUSTRY' && i.severity === SEVERITY.WARN));
});

test('★ 有邻居印证的强板块 → 完全不告警（簇状同向 = 真实行情）', () => {
  // 龙头 9.0 与次强 8.6 相距 0.4 → 有印证，不告警
  const industries = [
    { name: 'A', change_pct: 9.0 }, { name: 'B', change_pct: 8.6 },
    { name: 'C', change_pct: 8.1 }, { name: 'D', change_pct: 7.8 },
  ];
  for (let i = 0; i < 56; i++) industries.push({ name: '行业' + i, change_pct: 0.3 });
  for (let i = 0; i < 30; i++) industries.push({ name: '跌行业' + i, change_pct: -0.4 });
  const r = validateDay(day({ industry: industries }));
  assert.equal(r.status, 'ok', '簇状同向的板块簇是真实行情，连 WARN 都不该有');
  assert.equal(r.issues.length, 0);
});

test('行业硬物理上限仍生效：+18% 判脏（ERROR，剔除数据）；真实极端日 12.23% 不再误判', () => {
  // 阈值修正回归锁：初版 12% 曾把 2026-03-02/03-03 油气开采及服务 +12.23/+12.22%
  // （油服股集体顶板的真实极端行情）判成 ERROR 剔除——第二版上调至 15%。
  const mk = (lead) => {
    const industries = [{ name: 'X', change_pct: lead }];
    for (let i = 0; i < 60; i++) industries.push({ name: 't' + i, change_pct: 0.2 });
    return industries;
  };
  const rDirty = validateDay(day({ industry: mk(18) }));
  assert.equal(rDirty.status, 'dirty');
  assert.ok(rDirty.issues.some((i) => i.rule === 'RANGE_INDUSTRY'));
  // 12.23% 不触发 RANGE_INDUSTRY（0.2% 众邻居 → 离群规则另算，此处只锁范围规则）
  const rReal = validateDay(day({ industry: mk(12.23) }));
  assert.ok(!rReal.issues.some((i) => i.rule === 'RANGE_INDUSTRY'), '真实极端日不再误判脏值');
});

test('行业样本不足 MIN_INDUSTRY_SAMPLE → 不做离群判定（宁可不判也不误报）', () => {
  const r = validateDay(day({ industry: [
    { name: 'A', change_pct: 9.5 }, { name: 'B', change_pct: 0.1 }, { name: 'C', change_pct: -0.2 },
  ] }));
  assert.equal(r.status, 'ok');
});

test('行业涨跌幅缺失 → 不在此层判脏（缺失走 missing 通道，不混淆）', () => {
  const r = validateDay(day({ industry: [{ name: '半导体' }, { name: '煤炭', change_pct: null }] }));
  assert.equal(r.status, 'ok');
});

test('个股涨跌幅超 100% → 判脏（字段错位特征）', () => {
  const r = validateDay(day({ hot: [{ code: 'sz000001', name: '平安银行', change_pct: 155 }] }));
  assert.equal(r.status, 'dirty');
  const iss = r.issues.find((i) => i.rule === 'RANGE_STOCK');
  assert.ok(iss);
  assert.equal(iss.code, 'sz000001');
});

test('个股涨跌幅 +44%（新股/科创常见）→ 不判脏', () => {
  const r = validateDay(day({ hot: [{ code: 'sh688001', name: '华兴源创', change_pct: 44.0 }] }));
  assert.equal(r.status, 'ok');
});

test('成交额越界判脏：低于 500 亿（口径残缺）', () => {
  const r = validateDay(day({ summary: { amount_yi: 120 } }));
  assert.equal(r.status, 'dirty');
  assert.ok(r.issues.some((i) => i.rule === 'RANGE_AMOUNT'));
});

test('成交额越界判脏：高于 4 万亿', () => {
  const r = validateDay(day({ summary: { amount_yi: 55000 } }));
  assert.equal(r.status, 'dirty');
});

test('成交额正常（1.2 万亿 = 12000 亿）→ 不判脏', () => {
  const r = validateDay(day({ summary: { amount_yi: 12000 } }));
  assert.equal(r.status, 'ok');
});

test('情绪分越界 [0,100] 判脏', () => {
  const r = validateDay(day({ emotion: { value: 120 } }));
  assert.equal(r.status, 'dirty');
  assert.ok(r.dirtyFields.includes('emotion.value'));
});

test('情绪分为 0 或 100 是合法边界，不判脏', () => {
  assert.equal(validateDay(day({ emotion: { value: 0 } })).status, 'ok');
  assert.equal(validateDay(day({ emotion: { value: 100 } })).status, 'ok');
});

test('因子分越界判脏（逐因子定位到具体键名）', () => {
  const r = validateDay(day({ emotion: { value: 60, factors: { s_net: 50, s_amt: -5 } } }));
  assert.equal(r.status, 'dirty');
  assert.ok(r.dirtyFields.includes('emotion.factors.s_amt'));
});

// ── ② 单位校验（万/亿搞反）──────────────────────────────────────────────
test('龙虎榜净买 > 300 亿判脏（万/亿单位搞反，用户点名的第②类）', () => {
  const r = validateDay(day({ summary: { lhb_daily_net: 5000 } }));
  assert.equal(r.status, 'dirty');
  const iss = r.issues.find((i) => i.rule === 'UNIT_LHB');
  assert.ok(iss);
  assert.ok(iss.reason.includes('万/亿'));
});

test('龙虎榜净买 -400 亿（负向）同样判脏', () => {
  const r = validateDay(day({ summary: { lhb_daily_net: -400 } }));
  assert.equal(r.status, 'dirty');
});

test('龙虎榜净买 28 亿（历史实测最大值量级）→ 不判脏', () => {
  const r = validateDay(day({ summary: { lhb_daily_net: 28 } }));
  assert.equal(r.status, 'ok');
});

test('全量口径净买与新股净买同样受单位校验', () => {
  const a = validateDay(day({ summary: { lhb_all_net: 999 } }));
  assert.ok(a.dirtyFields.includes('summary.lhb_all_net'));
  const b = validateDay(day({ summary: { lhb_new_net: 800 } }));
  assert.ok(b.dirtyFields.includes('summary.lhb_new_net'));
});

// ── ③ 重复检测（用户点名的第③类）──────────────────────────────────────
test('hot 里同一 code 重复出现 → 判脏', () => {
  const r = validateDay(day({
    hot: [
      { code: 'sz000001', name: '平安银行', change_pct: 10 },
      { code: 'sz000001', name: '平安银行', change_pct: 10 },
    ],
  }));
  assert.equal(r.status, 'dirty');
  const iss = r.issues.find((i) => i.rule === 'DUPLICATE');
  assert.ok(iss);
  assert.ok(iss.reason.includes('sz000001×2'), '原因须含重复明细');
});

test('hot 里 code 各不相同 → 不判脏', () => {
  const r = validateDay(day({
    hot: [
      { code: 'sz000001', name: 'A', change_pct: 10 },
      { code: 'sz000002', name: 'B', change_pct: 9 },
    ],
  }));
  assert.equal(r.status, 'ok');
});

test('hot 里 code 缺失的行不参与重复判定（不误报）', () => {
  const r = validateDay(day({ hot: [{ name: 'A', change_pct: 1 }, { name: 'B', change_pct: 2 }] }));
  assert.equal(r.status, 'ok');
});

// ── ④ 一致性校验 ─────────────────────────────────────────────────────────
test('涨跌家数合计不足 1000 → 判脏（口径残缺）', () => {
  const r = validateDay(day({ summary: { up_count: 300, down_count: 200 } }));
  assert.equal(r.status, 'dirty');
  assert.ok(r.issues.some((i) => i.rule === 'RANGE_BREADTH'));
});

test('涨跌家数出现负值 → 判脏', () => {
  const r = validateDay(day({ summary: { up_count: -5, down_count: 3000 } }));
  assert.equal(r.status, 'dirty');
});

test('涨停数大于上涨家数 → 判脏（逻辑不可能）', () => {
  const r = validateDay(day({ summary: { up_count: 500, down_count: 3000, zt_count: 900 } }));
  assert.equal(r.status, 'dirty');
  assert.ok(r.issues.some((i) => i.rule === 'CONSIST_ZT'));
});

test('涨停+跌停 大于涨跌家数合计 → 判脏', () => {
  const r = validateDay(day({ summary: { up_count: 2000, down_count: 1500, zt_count: 2000, dt_count: 1600 } }));
  assert.equal(r.status, 'dirty');
  assert.ok(r.issues.some((i) => i.rule === 'CONSIST_ZDT'));
});

test('正常涨跌家数与涨跌停 → 不判脏', () => {
  const r = validateDay(day({ summary: { up_count: 1313, down_count: 1894, flat_count: 85, zt_count: 52, dt_count: 12 } }));
  assert.equal(r.status, 'ok');
});

test('封板率越界 [0,100] 判脏', () => {
  const r = validateDay(day({ summary: { seal_pct: 130 } }));
  assert.equal(r.status, 'dirty');
});

test('席位覆盖率越界判脏', () => {
  const r = validateDay(day({ summary: { seats: { cover: 150 } } }));
  assert.equal(r.status, 'dirty');
});

test('★ 席位明细与全量口径比（实测校正）：55 条 vs lhb_stocks 55 → 不误报', () => {
  // 实测 2026-09-28/29/30：detail 键数（55/66/66）与 lhb_stocks（55/66/66）完全一致，
  // 而 lhb_daily_stocks 只有 48/56/56。初版与当日榜比 → 三天全误报。本用例锁死修正。
  const r = validateDay(day({ summary: {
    seats: { cover: 100, detail: Object.fromEntries(Array.from({ length: 55 }, (_, i) => ['c' + i, {}])) },
    lhb_stocks: 55,
    lhb_daily_stocks: 48,
  } }));
  assert.equal(r.status, 'ok', '明细覆盖全量上榜个股是正常行为，不得误报');
  assert.equal(r.warnFields.length, 0);
});

test('席位明细条数多于**全量**上榜个股数 → warn（榜外票混入）', () => {
  const r = validateDay(day({ summary: {
    seats: { cover: 100, detail: { a: 1, b: 2, c: 3, d: 4 } },
    lhb_stocks: 3,
    lhb_daily_stocks: 2,
  } }));
  assert.equal(r.status, 'warn');
  assert.ok(r.warnFields.includes('summary.seats.detail'));
  const iss = r.issues.find((i) => i.rule === 'CONSIST_SEATS');
  assert.ok(iss.reason.includes('全量上榜个股数'), '原因须说明用的是全量口径');
});

test('席位明细少于全量上榜个股数 → 不告警（抓取覆盖不全属正常）', () => {
  const r = validateDay(day({ summary: {
    seats: { cover: 80, detail: { a: 1, b: 2 } },
    lhb_stocks: 10,
    lhb_daily_stocks: 8,
  } }));
  assert.equal(r.status, 'ok');
});

test('缺 lhb_stocks 的老档 → 不产生席位条数 issue（宁可不判不误报）', () => {
  const r = validateDay(day({ summary: {
    seats: { cover: 100, detail: { a: 1, b: 2, c: 3 } },
    lhb_daily_stocks: 2,
  } }));
  assert.equal(r.status, 'ok', '缺全量口径时不得退化成跨口径比较并误报');
});

// ── 缺失显式化：unknown ≠ ok ─────────────────────────────────────────────
test('所有字段都缺失 → 状态 ok（缺失不在此层判定），但绝不是"数据健康"', () => {
  const r = validateDay(day({}));
  assert.equal(r.status, 'ok');
  assert.equal(r.issues.length, 0);
  // 关键区分：ok 只代表"没发现脏"，不代表"数据齐全"。齐全性由 health/freshness 负责。
  assert.equal(r.checked.days, 1);
});

test('非对象输入 → 判脏并给出结构问题', () => {
  const r = validateDay(null);
  assert.equal(r.status, 'dirty');
  assert.equal(r.checked.days, 0);
});

// ── 跨源注入通道（供 #2 复用）────────────────────────────────────────────
test('extraDirty 注入的字段按 ERROR 处理并统一进 issues', () => {
  const r = validateDay(day({}), { extraDirty: [
    { field: 'industry[].change_pct', rule: 'CROSS_SOURCE', reason: '东财 +3.2% vs 同花顺 -2.1%', value: 5.3 },
  ] });
  assert.equal(r.status, 'dirty');
  assert.ok(r.dirtyFields.includes('industry[].change_pct'));
  const iss = r.issues.find((i) => i.rule === 'CROSS_SOURCE');
  assert.ok(iss);
  assert.ok(iss.reason.includes('同花顺'));
});

test('extraDirty 支持字符串简写', () => {
  const r = validateDay(day({}), { extraDirty: ['summary.amount_yi'] });
  assert.equal(r.status, 'dirty');
  assert.ok(r.dirtyFields.includes('summary.amount_yi'));
});

// ── 字段 → 因子入参映射 ──────────────────────────────────────────────────
test('dirtyArgsOf: 把 summary 字段路径翻成 computeSentiment 入参名', () => {
  const vres = validateDay(day({ summary: { amount_yi: 100, lhb_daily_net: 999 } }));
  const args = dirtyArgsOf(vres);
  assert.ok(args.has('amount'), 'amount_yi → amount');
  assert.ok(args.has('netBuy'), 'lhb_daily_net → netBuy');
});

test('dirtyArgsOf: 行业脏 → 同时剔除 industryUp 与 industryTotal', () => {
  const vres = validateDay(day({ industry: [{ name: 'X', change_pct: 25 }] }));
  const args = dirtyArgsOf(vres);
  assert.ok(args.has('industryUp'));
  assert.ok(args.has('industryTotal'));
});

test('dirtyArgsOf: 干净日 → 空集合', () => {
  const args = dirtyArgsOf(validateDay(day({})));
  assert.equal(args.size, 0);
});

// ── sanitizeForFactors：脏值置 null 但不改原档 ───────────────────────────
test('sanitizeForFactors: 脏字段的入参被置 null，干净字段保留', () => {
  const d = day({ summary: {
    lhb_daily_net: 999,      // 脏（单位）
    up_count: 1313, down_count: 1894,  // 干净
    amount_yi: 12000,        // 干净
  } });
  const vres = validateDay(d);
  const { raw, cleaned, dropped } = sanitizeForFactors(d, vres);
  assert.equal(raw.netBuy, 999, 'raw 保留原值');
  assert.equal(cleaned.netBuy, null, 'cleaned 置 null');
  assert.equal(cleaned.upCount, 1313, '干净字段不动');
  assert.equal(cleaned.amount, 12000, '干净字段不动');
  assert.ok(dropped.includes('netBuy'));
  // 原档未被改动 —— 追溯与人工复核依赖这一点
  assert.equal(d.summary.lhb_daily_net, 999, 'day 本体必须保持原值');
});

test('sanitizeForFactors: 干净日 → 入参原样透传，dropped 为空', () => {
  const d = day({ summary: { lhb_daily_net: 5, up_count: 1313, down_count: 1894 } });
  const { cleaned, dropped } = sanitizeForFactors(d, validateDay(d));
  assert.equal(cleaned.netBuy, 5);
  assert.equal(cleaned.upCount, 1313);
  assert.equal(dropped.length, 0);
});

// ── validateAll 汇总 ─────────────────────────────────────────────────────
test('validateAll: 统计 ok/warn/dirty 与字段热度', () => {
  const days = [
    day({ trade_date: '2026-09-28' }),                                            // ok
    day({ trade_date: '2026-09-29', summary: { amount_yi: 10 } }),                 // dirty
    day({ trade_date: '2026-09-30', summary: { amount_yi: 20, lhb_daily_net: 900 } }), // dirty
  ];
  const all = validateAll(days);
  assert.equal(all.total, 3);
  assert.equal(all.dirty, 2);
  assert.equal(all.ok, 1);
  assert.deepEqual(all.dirtyDates, ['2026-09-29', '2026-09-30']);
  const amtField = all.byField.find((f) => f.field === 'summary.amount_yi');
  assert.ok(amtField);
  assert.equal(amtField.days, 2);
  assert.equal(amtField.pct, 66.67);
  assert.ok(all.scope.includes('单源内部校验'));
});

test('validateAll: 空数组不炸，比例给 null 而非 0（缺失显式化）', () => {
  const all = validateAll([]);
  assert.equal(all.total, 0);
  assert.equal(all.cleanRatio, null);
});

test('validateAll: extraDirtyByDate 按日期注入', () => {
  const days = [day({ trade_date: '2026-09-30' })];
  const all = validateAll(days, {
    extraDirtyByDate: { '2026-09-30': [{ field: 'summary.amount_yi', reason: '跨源差异' }] },
  });
  assert.equal(all.dirty, 1);
  assert.equal(all.perDay[0].issues[0].rule, 'CROSS_SOURCE');
});

// ── indexChangePct 取绝对变动最大者 ──────────────────────────────────────
test('indexChangePct: 从对象形态的 indexes 取最大绝对变动', () => {
  const v = indexChangePct({ indexes: { sh: { change_pct: 0.5 }, sz: { change_pct: -1.8 }, cy: { change_pct: 1.2 } } });
  assert.equal(v, -1.8);
});

test('indexChangePct: 数组形态也支持', () => {
  const v = indexChangePct({ indexes: [{ change_pct: 0.3 }, { change_pct: 2.4 }] });
  assert.equal(v, 2.4);
});

test('indexChangePct: 缺失 → null（不猜 0）', () => {
  assert.equal(indexChangePct({}), null);
  assert.equal(indexChangePct({ indexes: [] }), null);
  assert.equal(indexChangePct(null), null);
});

// ── 阈值唯一出处 ─────────────────────────────────────────────────────────
test('VALIDATION_RULES 是冻结口径的唯一出处，键名稳定', () => {
  for (const k of ['INDUSTRY_CHANGE_ABS_MAX', 'LHB_NET_YI_ABS_MAX', 'AMOUNT_YI_MIN', 'AMOUNT_YI_MAX', 'BREADTH_MIN_TOTAL']) {
    assert.equal(typeof VALIDATION_RULES[k], 'number', k + ' 必须是数字阈值');
  }
  assert.ok(VALIDATION_RULES.AMOUNT_YI_MIN < VALIDATION_RULES.AMOUNT_YI_MAX);
});
