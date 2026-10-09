// V5.2-pro 交易引擎规则测试（龙虎过滤 / 账户风控 / 批量委托 / 日志 / 止损 / 结构化输出）
//
// 这些用例的价值不在「跑通」，而在**锁死用户给定的业务规则阈值**——
// 别人改引擎时，若把 20% 单日上限、−8% 止损、4% 净买率准入、70%/40% 降仓档位
// 悄悄改掉，这些测试必须报错。规则是用户定的，代码不得自行发挥。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterOne, filterBatch, featuresOf, themeStrengthOf, BUCKET, REJECT_LHB, SKIPPED_RULES,
  MAX_SHARE_OF_MARKET, MAX_TOP3_CONC, MAX_TOP3_CONC_STRICT, ADMIT, LHBFILTER_VERSION,
  isNetOutflow, netOutflowText, LHB_NET_OUTFLOW_PENALTY, FLAG_LHB,
} from '../src/lhbfilter.js';
import {
  accountStats, riskGuard, ddTier, MAX_DAILY_POSITION_CHANGE, DD_TIERS, HARD_STOP_LOSS,
  RISK_REJECT, emptyAccount, submitOrder, settleDay, scanStopLoss, batchSubmit, batchSell,
  appendLog, readLogs, logsToReport, orderDetail, orderDetails, quotesFromDay, MAX_LOGS,
} from '../src/paper.js';

// ────────────────────── 测试数据构造（不依赖真实存档，可离线跑） ──────────────────────

/** 造一条当日榜龙虎记录 */
const L = (code, name, o = {}) => ({
  code, name,
  reason: o.reason || '日涨幅偏离值达7%的证券',
  close: o.close ?? 10,
  change_pct: o.change_pct ?? 5,
  net_buy_wan: o.net ?? 5000,
  buy_wan: o.buy ?? 20000,
  sell_wan: o.sell ?? 15000,
  deal_wan: (o.buy ?? 20000) + (o.sell ?? 15000),
  turnover_pct: o.turnover ?? 10,
  is_range: !!o.isRange,
});

/** 造席位明细：机构专用 / 股通专用 / 营业部 */
const seat = (name, v) => [name, v];

/**
 * 造一天存档。seats.detail[code] = { b:[...], s:[...] }
 * summary.lhb_daily_net 是「亿」，本测试里统一用 marketNetYi 指定。
 */
function makeDay(o = {}) {
  return {
    trade_date: o.date || '2026-09-30',
    lhb: o.lhb || [],
    hot: o.hot || [],
    summary: {
      lhb_daily_net: o.marketNetYi ?? 10,
      main_theme: o.mainTheme !== undefined ? o.mainTheme : { name: '业绩线', main_yi: 2, tot_yi: 10, pct: 20 },
      seats: { detail: o.detail || {} },
    },
  };
}

// ────────────────────── 一、龙虎榜前置过滤 ──────────────────────

test('特征抽取：净买率用龙虎榜成交额作分母（口径代理，可核验）', () => {
  const day = makeDay({ lhb: [L('600000', '浦发银行', { net: 1000, buy: 4000, sell: 1000 })] });
  const f = featuresOf('600000', day);
  assert.equal(f.netWan, 1000);
  assert.equal(f.lhbAmtWan, 5000);            // 分母 = buy + sell
  assert.equal(f.netBuyRate, 0.2);            // 1000/5000
});

test('强制剔除①：上市 5 日内无涨跌幅限制新股', () => {
  const day = makeDay({
    lhb: [L('001246', '力勤资源', { reason: '无价格涨跌幅限制的证券', net: 50000, buy: 74589, sell: 24176 })],
    marketNetYi: 100,
  });
  const r = filterOne('001246', day);
  assert.equal(r.bucket, BUCKET.REJECTED);
  assert.ok(r.rejectedBy.some((x) => x.code === 'NEW_STOCK'));
});

test('降级规则②：龙虎榜净买入 ≤ 0 —— 不阻断委托，但降级+扣分+告警+人工复核', () => {
  const day = makeDay({ lhb: [L('600000', '浦发银行', { net: -500 })] });
  const r = filterOne('600000', day);
  // ① 不再进强制剔除（rejectedBy 必须为空）——否则等于禁止生成买入委托，与规则定位矛盾
  assert.equal(r.rejectedBy.length, 0, '净买入≤0 不得再进强制剔除');
  assert.equal(r.passed, true, '不阻断：passed 应为 true');
  // ② 不得进主候选池（主池=可自动下单，而这条规则要求人工复核）
  assert.equal(r.bucket, BUCKET.WATCH, '应降级进备选观察池（禁止自动下单）');
  // ③ 降级条目与告警标签必须显式带出
  assert.ok(r.netOutflow, '须带 netOutflow 降级条目');
  assert.equal(r.netOutflow.code, 'NET_BUY_NON_POSITIVE');
  assert.equal(r.netOutflow.kind, 'negative');
  assert.equal(r.needReview, true, '须要求人工复核');
  assert.ok(r.flags.length > 0 && r.flags[0].includes('⚠龙虎当日资金净流出，谨慎开仓'),
    `告警标签文案不符：${r.flags[0]}`);
  // ④ 扣分值必须出现在结论里（用户要能看见"扣了多少分"）
  assert.match(r.text, /已扣综合分\s*10\s*分/);
  assert.match(r.text, /上涨概率\s*8\s*个百分点/);
  assert.match(r.text, /人工复核/);

  // 净买恰好为 0 同样降级（规则原文「≤ 0」）
  const r0 = filterOne('600000', makeDay({ lhb: [L('600000', '浦发银行', { net: 0 })] }));
  assert.equal(r0.bucket, BUCKET.WATCH);
  assert.equal(r0.passed, true);
  assert.equal(r0.netOutflow.kind, 'zero');
  assert.equal(r0.needReview, true);

  // 净买为正：不得出现降级条目（否则降级规则会误伤所有票）
  const rp = filterOne('600000', makeDay({
    lhb: [L('600000', '浦发银行', { net: 5000 })],
    detail: { '600000': { b: [seat('机构专用', 3000), seat('某营业部1', 2800), seat('某营业部2', 2600), seat('某营业部3', 2400), seat('某营业部4', 2200), seat('某营业部5', 2000)], s: [seat('沪股通专用', 100)] } },
  }));
  assert.equal(rp.netOutflow, null);
  assert.equal(rp.needReview, false);
  assert.equal(rp.bucket, BUCKET.MAIN);
});

test('降级规则②：降级条目与「数据不足留痕」是两类东西（不含 blocking 字段、不进 skipped）', () => {
  const r = filterOne('600000', makeDay({ lhb: [L('600000', '浦发银行', { net: -100 })] }));
  // skipped 只装"数据不足"，降级是"数据充足但结论不好"——混进去会让用户以为缺数据
  assert.ok(!r.skipped.some((s) => s.code === 'NET_BUY_NON_POSITIVE' || s.key === 'NET_BUY_NON_POSITIVE'));
  // 无当日记录时的 NO_RECORD / 异常时的 FILTER_ERROR 仍是阻断类（仍走 rejectedBy）——
  // 这两个是"根本没有依据"，与"有依据但不好"（净流出）必须区别对待
  assert.equal(filterOne('999999', makeDay({})).bucket, BUCKET.REJECTED);
});

test('降级扣分值常量必须与用户裁定一致（锁死，防被改）', () => {
  assert.equal(LHB_NET_OUTFLOW_PENALTY.SCORE, 10, '综合分固定扣减 10 分');
  assert.equal(LHB_NET_OUTFLOW_PENALTY.PROB, 8, '上涨概率固定扣减 8 个百分点');
  assert.equal(FLAG_LHB.NET_OUTFLOW, '⚠龙虎当日资金净流出，谨慎开仓');
  // 判据本身也只有一份实现
  assert.deepEqual(isNetOutflow(100), { hit: false, kind: null, value: 100 });
  assert.deepEqual(isNetOutflow(0), { hit: true, kind: 'zero', value: 0 });
  assert.deepEqual(isNetOutflow(-5), { hit: true, kind: 'negative', value: -5 });
  assert.equal(isNetOutflow(null).hit, true);
  assert.equal(isNetOutflow(undefined).hit, true);
});

test('强制剔除③：龙虎净买占全市场总净额 > 25%', () => {
  // 全市场净额 10 亿 = 100000 万；单票净买 30000 万 = 30% > 25%
  const day = makeDay({ lhb: [L('600000', '浦发银行', { net: 30000 })], marketNetYi: 10 });
  const r = filterOne('600000', day);
  assert.ok(r.rejectedBy.some((x) => x.code === 'SHARE_TOO_HIGH'));
  // 恰好 25% 不该被剔（规则是「> 25%」）
  const day2 = makeDay({ lhb: [L('600000', '浦发银行', { net: 25000 })], marketNetYi: 10 });
  assert.ok(!filterOne('600000', day2).rejectedBy.some((x) => x.code === 'SHARE_TOO_HIGH'));
});

test('强制剔除④：买方仅游资（机构与北向均净卖出）且集中度 > 80%', () => {
  const day = makeDay({
    lhb: [L('600000', '浦发银行', { net: 5000 })],
    detail: {
      // 买方：3 个营业部，集中度极高；卖方：机构+北向都在卖
      '600000': {
        b: [seat('某某证券股份有限公司某营业部', 9000), seat('某某证券股份有限公司某营业部2', 500), seat('某某证券股份有限公司某营业部3', 100)],
        s: [seat('机构专用', 3000), seat('沪股通专用', 2000)],
      },
    },
  });
  const r = filterOne('600000', day);
  assert.equal(r.features.buyTop3Pct, 100);           // 3 席全在前三
  assert.ok(r.rejectedBy.some((x) => x.code === 'HOT_ONLY_AND_CONC'));
});

test('强制剔除④：机构或北向有净买时不触发（买方并非「只有游资」）', () => {
  const day = makeDay({
    lhb: [L('600000', '浦发银行', { net: 5000 })],
    detail: {
      '600000': {
        b: [seat('机构专用', 9000), seat('某某证券某营业部', 500), seat('某某证券某营业部2', 100)],
        s: [seat('沪股通专用', 100)],
      },
    },
  });
  const r = filterOne('600000', day);
  assert.ok(!r.rejectedBy.some((x) => x.code === 'HOT_ONLY_AND_CONC'));   // 机构净买 +8900
});

test('强制剔除⑦：主线题材强度分 < 0.5 时拦截', () => {
  // 主线净买占全榜 5% → 强度 5/20 = 0.25 < 0.5
  const day = makeDay({
    lhb: [L('600000', '浦发银行', { net: 5000 })],
    mainTheme: { name: '弱线', main_yi: 0.5, tot_yi: 10, pct: 5 },
  });
  const r = filterOne('600000', day);
  assert.ok(r.rejectedBy.some((x) => x.code === 'THEME_TOO_WEAK'));
  // 主线净买占比 20% → 强度 1.0，不拦
  const day2 = makeDay({
    lhb: [L('600000', '浦发银行', { net: 5000 })],
    mainTheme: { name: '强线', main_yi: 2, tot_yi: 10, pct: 20 },
  });
  assert.ok(!filterOne('600000', day2).rejectedBy.some((x) => x.code === 'THEME_TOO_WEAK'));
});

test('主线题材强度：主线净买为负时强度为 0（主线在卖不构成强度）', () => {
  const day = makeDay({ mainTheme: { name: '出货线', main_yi: -3, tot_yi: 10, pct: 0 } });
  assert.equal(themeStrengthOf(day), 0);
  // 无主线判定 → null（不猜）
  assert.equal(themeStrengthOf(makeDay({ mainTheme: null })), null);
});

test('数据不足的两条规则必须留痕跳过、绝不参与拦截', () => {
  const day = makeDay({
    lhb: [L('600000', '浦发银行', { net: 5000 })],
    detail: { '600000': { b: [seat('机构专用', 3000), seat('某营业部1', 2800), seat('某营业部2', 2600), seat('某营业部3', 2400), seat('某营业部4', 2200), seat('某营业部5', 2000)], s: [seat('沪股通专用', 100)] } },
  });
  const r = filterOne('600000', day);
  const keys = r.skipped.map((s) => s.key);
  assert.ok(keys.includes('LOCKUP_RATIO'), '锁仓资金规则须留痕');
  assert.ok(keys.includes('GAIN_60D'), '近60日涨幅规则须留痕');
  // 关键：这两条不得让标的进 rejected（passed 必须为 true）
  assert.equal(r.passed, true);
  assert.equal(r.bucket, BUCKET.MAIN);
  assert.equal(r.rejectedBy.length, 0);
  for (const s of r.skipped) assert.equal(s.blocking, false, '数据不足的规则不得为 blocking');
});

test('主候选池准入：4 条全满足才进主池，否则进备选观察池', () => {
  // 净买率 5000/(20000+15000)=14.3% ≥4%；集中度低；机构净买为正 → main
  // 买方 9000/2000/2000/2000 → 前三 13000/15000=86.7% 超 75%，故改为均匀分布压低集中度
  const day = makeDay({
    lhb: [L('600000', '浦发银行', { net: 5000 })],
    detail: { '600000': { b: [seat('机构专用', 3000), seat('某营业部1', 2800), seat('某营业部2', 2600), seat('某营业部3', 2400), seat('某营业部4', 2200), seat('某营业部5', 2000)], s: [seat('沪股通专用', 100)] } },
  });
  const r = filterOne('600000', day);
  assert.equal(r.bucket, BUCKET.MAIN);
  assert.ok(r.admit.all);
  assert.ok(r.features.buyTop3Pct <= 75, `集中度 ${r.features.buyTop3Pct} 应 ≤75`);

  // 机构与北向都净卖 → 准入第④条不满足 → watch
  // 注意：买方须分散（前3 ≤80%）且买方有正的游资净买，否则会先触发强制剔除④
  const day2 = makeDay({
    lhb: [L('600000', '浦发银行', { net: 5000 })],
    detail: {
      '600000': {
        b: [seat('某营业部1', 2000), seat('某营业部2', 1900), seat('某营业部3', 1800), seat('某营业部4', 1700), seat('某营业部5', 1600)],
        s: [seat('机构专用', 3000), seat('沪股通专用', 100)],
      },
    },
  });
  const r2 = filterOne('600000', day2);
  assert.equal(r2.bucket, BUCKET.WATCH, '未满足准入④应进备选观察池');
  assert.ok(r2.admit.unmet.some((u) => u.key === 'instOrNorth'));
});

test('备选观察池的标的：passed=true 但 bucket 不是 main（禁止自动下单）', () => {
  // 净买率低（准入①不满足）但买方分散、机构净买为正 → 不触发任何强制剔除 → watch
  const day = makeDay({
    lhb: [L('600000', '浦发银行', { net: 100 })],
    detail: {
      '600000': {
        b: [seat('机构专用', 2000), seat('某营业部1', 1900), seat('某营业部2', 1800), seat('某营业部3', 1700), seat('某营业部4', 1600)],
        s: [seat('沪股通专用', 100)],
      },
    },
  });
  const r = filterOne('600000', day);
  assert.equal(r.passed, true);
  assert.equal(r.bucket, BUCKET.WATCH);
  assert.match(r.text, /禁止自动下单/);
});

test('降级不得给其他强制剔除开后门：净买≤0 且同时踩硬伤 → 仍 REJECTED', () => {
  // 一票同时满足：净买为负（降级） + 买方仅游资且前三集中度 >80%（强制剔除③）
  // 席位：机构净卖、北向净卖、营业部净买 → 三个条件全中
  const day = makeDay({
    lhb: [L('600000', '浦发银行', { net: -200, buy: 20000, sell: 20200 })],
    detail: {
      '600000': {
        b: [seat('某营业部1', 9000), seat('某营业部2', 8000), seat('某营业部3', 7000), seat('某营业部4', 100), seat('某营业部5', 100)],
        s: [seat('机构专用', 12000), seat('沪股通专用', 3000)],
      },
    },
  });
  const r = filterOne('600000', day);
  // 顺序即语义：!passed 必须优先于 netOutflow。否则降级分支先命中，
  // 就等于「只要净买为负，其他硬伤一律不算」——把降级变成了豁免权。
  assert.equal(r.bucket, BUCKET.REJECTED, '降级不得覆盖其他强制剔除');
  assert.equal(r.passed, false);
  assert.ok(r.rejectedBy.some((x) => x.code === 'HOT_ONLY_AND_CONC'));
  assert.match(r.text, /禁止生成买入委托/);
  assert.match(r.text, /买方仅游资/);
  // 但降级条目本身仍要如实记录（它在 ② 步已算出）——剔除原因与告警信息是两件事，
  // UI 若只看到 rejected 就丢掉告警，人工复核时会少一条关键依据。
  assert.ok(r.netOutflow, '降级条目不应因被剔除而被抹掉');
  assert.equal(r.needReview, true);
});

test('无当日记录：直接拒绝，禁止生成买入委托', () => {
  const r = filterOne('999999', makeDay({}));
  assert.equal(r.bucket, BUCKET.REJECTED);
  assert.equal(r.passed, false);
  assert.match(r.text, /禁止生成买入委托/);
  // "没有记录"是**阻断类**，不能与"净流出"（降级类）混为一谈：
  // 前者连判断依据都没有，后者有依据、只是依据不好。二者对下游的含义完全不同。
  assert.equal(r.needReview, false, '阻断类不应走降级复核路径');
  assert.equal(r.netOutflow, null);
});

test('批量过滤：单只失败不影响其他，且同票去重', () => {
  const day = makeDay({
    lhb: [
      L('600000', '好票', { net: 5000 }),
      // 差票：净买为负 → 降级进 watch。
      // 席位明细刻意给「机构净买 >0」的形态，避免同时踩到集中度/游资类强制剔除——
      // 本用例要验的是**降级单独生效**，不能把两种处置混在一个样本里。
      L('600001', '差票', { net: -100, buy: 4000, sell: 4100 }),
    ],
    detail: {
      '600000': { b: [seat('机构专用', 3000), seat('某营业部1', 2800), seat('某营业部2', 2600), seat('某营业部3', 2400), seat('某营业部4', 2200), seat('某营业部5', 2000)], s: [seat('沪股通专用', 100)] },
      '600001': { b: [seat('机构专用', 2000), seat('某营业部1', 1000), seat('某营业部2', 900), seat('某营业部3', 100)], s: [seat('沪股通专用', 1500), seat('某营业部', 2600)] },
    },
  });
  const r = filterBatch(['600000', '600001', '999999', '600000'], day);
  assert.equal(r.summary.total, 3);                 // 去重后 3 只
  assert.equal(r.main.length, 1);
  // 600001 净买为负 → 降级进 watch（不再是被剔除）；999999 无记录 → 仍被剔除
  assert.equal(r.rejected.length, 1);
  assert.equal(r.watch.length, 1);
  assert.equal(r.summary.needReview, 1);
  assert.deepEqual(r.summary.flaggedCodes, ['600001']);
  assert.ok(r.summary.skippedRules.includes('LOCKUP_RATIO'));
});

test('阈值常量必须与规则原文一致（锁死，防被改）', () => {
  assert.equal(MAX_SHARE_OF_MARKET, 0.25);          // 25%
  assert.equal(MAX_TOP3_CONC, 75);                  // 75%
  assert.equal(MAX_TOP3_CONC_STRICT, 80);           // 80%
  assert.equal(ADMIT.netBuyRate, 0.04);             // 4%
  assert.equal(ADMIT.top3ConcMax, 0.75);
  assert.equal(LHBFILTER_VERSION, 'lhbfilter-v1');
});

// ────────────────────── 二、账户全局风控 ──────────────────────

test('账户快照：历史峰值取 nav 最大值与当前值中的较大者，回撤按峰值算', () => {
  const acct = { ...emptyAccount(1000000, '2026-09-01'), nav: [{ date: '2026-09-05', equity: 1200000 }] };
  const s = accountStats(acct);
  assert.equal(s.peak, 1200000);
  assert.equal(s.drawdown.toFixed(4), '0.1667');    // (120-100)/120
  // 当前创新高时，峰值必须含当前值（否则回撤虚高）
  const hi = { ...emptyAccount(1000000, '2026-09-01'), cash: 1300000, nav: [{ date: '2026-09-05', equity: 1200000 }] };
  assert.equal(accountStats(hi).peak, 1300000);
  assert.equal(accountStats(hi).drawdown, 0);
});

test('降仓档位：回撤 ≥9% → 70%，≥15% → 40%，正常 100%', () => {
  assert.equal(ddTier(0).cap, 1.00);
  assert.equal(ddTier(0.08).cap, 1.00);
  assert.equal(ddTier(0.09).cap, 0.70);
  assert.equal(ddTier(0.14).cap, 0.70);
  assert.equal(ddTier(0.15).cap, 0.40);
  assert.equal(ddTier(0.50).cap, 0.40);
  assert.equal(MAX_DAILY_POSITION_CHANGE, 0.20);
  assert.equal(HARD_STOP_LOSS, -0.08);
  assert.equal(DD_TIERS.length, 3);
});

test('风控①：单日仓位变动超 20% 总资产 → 拦截', () => {
  const acct = emptyAccount(1000000, '2026-09-01');
  // 买 25 万 = 25% > 20%
  const r = riskGuard(acct, { side: 'buy', qty: 25000 }, { price: 10 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, RISK_REJECT.DAILY_CHANGE);
  // 买 10 万 = 10% ≤ 20% → 放行
  assert.equal(riskGuard(acct, { side: 'buy', qty: 10000 }, { price: 10 }).ok, true);
});

test('风控①：当日累计口径——分笔绕过必须被拦住', () => {
  const acct = emptyAccount(1000000, '2026-09-01');
  // 已下 15 万，再下 10 万 → 累计 25% > 20%
  const r = riskGuard(acct, { side: 'buy', qty: 10000 }, { price: 10 }, { todayBuyAmount: 150000 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, RISK_REJECT.DAILY_CHANGE);
});

test('风控②：回撤触发降仓后，突破上限的委托被拦；未突破的放行', () => {
  // 峰值 120 万、当前 105 万 → 回撤 12.5% → 上限 70%
  const acct = {
    ...emptyAccount(1000000, '2026-09-01'), cash: 450000,
    nav: [{ date: '2026-09-05', equity: 1200000 }],
    positions: { '600000': { code: '600000', name: 'X', qty: 60000, avail: 60000, avgCost: 10, cost: 600000, last: 10 } },
  };
  // 下单后仓位 (60+15)/105 = 71.4% > 70% → 拦
  const r = riskGuard(acct, { side: 'buy', qty: 15000 }, { price: 10 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, RISK_REJECT.DD_CAP);
  assert.equal(r.cap, 0.70);
  // 买 5 万 → 仓位 61.9% < 70% → 放行
  assert.equal(riskGuard(acct, { side: 'buy', qty: 5000 }, { price: 10 }).ok, true);
});

test('风控：卖出方向不受仓位变动与降仓上限约束（否则降仓后会被锁死）', () => {
  const acct = {
    ...emptyAccount(1000000, '2026-09-01'), cash: 200000,
    nav: [{ date: '2026-09-05', equity: 1500000 }],   // 回撤 40% → 上限 40%
    positions: { '600000': { code: '600000', name: 'X', qty: 100000, avail: 100000, avgCost: 10, cost: 1000000, last: 10 } },
  };
  const r = riskGuard(acct, { side: 'sell', qty: 50000 }, { price: 10 });
  assert.equal(r.ok, true);
  assert.match(r.note, /卖出/);
});

// ────────────────────── 三、批量委托 ──────────────────────

test('批量买入：龙虎过滤前置生效，非主池标的绝不生成委托', () => {
  const day = makeDay({
    trade_date: '2026-09-30',
    lhb: [
      L('600000', '好票', { net: 5000, close: 10 }),
      // 净流出票：只触发降级（机构净买 >0，不踩集中度/游资类强制剔除）
      L('600001', '净流出票', { net: -100, buy: 4000, sell: 4100, close: 10 }),
      // 新股：强制剔除（reason 命中「无价格涨跌幅限制」）
      L('600002', '新股', { net: 5000, close: 10, reason: '无价格涨跌幅限制的证券' }),
    ],
    detail: {
      '600000': { b: [seat('机构专用', 3000), seat('某营业部1', 2800), seat('某营业部2', 2600), seat('某营业部3', 2400), seat('某营业部4', 2200), seat('某营业部5', 2000)], s: [seat('沪股通专用', 100)] },
      '600001': { b: [seat('机构专用', 2000), seat('某营业部1', 1000), seat('某营业部2', 900), seat('某营业部3', 100)], s: [seat('沪股通专用', 1500), seat('某营业部', 2600)] },
    },
  });
  const acct = emptyAccount(1000000, '2026-09-29');
  const r = batchSubmit(acct, [
    { code: '600000', pct: 0.05 }, { code: '600001', pct: 0.05 }, { code: '600002', pct: 0.05 },
  ], day);
  assert.equal(r.summary.submitted, 1);
  // 净流出票（降级）+ 新股（强制剔除）都进不了主池 → 两笔都被龙虎前置拦下
  assert.equal(r.summary.blockedByLhb, 2);
  assert.equal(r.next.pending.length, 1);
  assert.equal(r.next.pending[0].code, '600000');
  // 降级票同样**不生成任何委托**（降级 = 禁止自动下单，不是"放行但排序靠后"）
  assert.ok(!r.next.orders.some((o) => o.code === '600001' && o.status === 'pending'));
  assert.ok(!r.next.orders.some((o) => o.code === '600002' && o.status === 'pending'));
  // 但拦截原因必须能分辨：降级票给"备选观察池"，新股给"龙虎榜前置过滤未通过"
  const r1 = r.results.find((x) => x.code === '600001');
  const r2 = r.results.find((x) => x.code === '600002');
  assert.match(r1.reason, /备选观察池/);
  assert.match(r1.detail, /谨慎开仓/, '降级票的明细里必须带告警标签文案');
  assert.match(r2.reason, /龙虎榜前置过滤未通过/);
});

test('批量买入：批次内共享「当日累计」累加器，防止分笔绕过 20% 上限', () => {
  // 造 5 只都合格的票，各买 6% → 前 3 笔 18% 通过，第 4 笔累计 24% 被风控拦
  const lhb = [], detail = {};
  for (let i = 0; i < 5; i++) {
    const c = '60000' + i;
    lhb.push(L(c, '票' + i, { net: 5000, close: 10 }));
    detail[c] = { b: [seat('机构专用', 3000), seat('某营业部1', 2800), seat('某营业部2', 2600), seat('某营业部3', 2400), seat('某营业部4', 2200), seat('某营业部5', 2000)], s: [seat('沪股通专用', 100)] };
  }
  const day = makeDay({ trade_date: '2026-09-30', lhb, detail });
  const acct = emptyAccount(1000000, '2026-09-29');
  const items = [0, 1, 2, 3, 4].map((i) => ({ code: '60000' + i, pct: 0.06 }));
  const r = batchSubmit(acct, items, day);
  assert.ok(r.summary.blockedByRisk >= 1, '应至少有一笔被风控拦下');
  assert.ok(r.summary.todayBuyPct <= 20.5, `当日买入占比 ${r.summary.todayBuyPct}% 不应超 20% 上限`);
});

test('批量买入：单只失败不影响其他（每只独立校验）', () => {
  const day = makeDay({
    trade_date: '2026-09-30',
    lhb: [L('600000', '好票', { net: 5000, close: 10 }), L('600001', '次票', { net: 5000, close: 10 })],
    detail: {
      '600000': { b: [seat('机构专用', 3000), seat('某营业部1', 2800), seat('某营业部2', 2600), seat('某营业部3', 2400), seat('某营业部4', 2200), seat('某营业部5', 2000)], s: [seat('沪股通专用', 100)] },
      '600001': { b: [seat('机构专用', 3000), seat('某营业部1', 2800), seat('某营业部2', 2600), seat('某营业部3', 2400), seat('某营业部4', 2200), seat('某营业部5', 2000)], s: [seat('沪股通专用', 100)] },
    },
  });
  const acct = emptyAccount(1000000, '2026-09-29');
  // 中间插一只无行情/无记录的票
  const r = batchSubmit(acct, [
    { code: '600000', pct: 0.05 },
    { code: '999999', pct: 0.05 },
    { code: '600001', pct: 0.05 },
  ], day);
  assert.equal(r.summary.submitted, 2);
  assert.equal(r.summary.blocked, 1);
  assert.deepEqual(r.blocked[0].code, '999999');
});

test('批量卖出：按比例减仓，清仓传 pct=1 卖全部可卖', () => {
  const day = makeDay({
    trade_date: '2026-09-30',
    hot: [{ code: '600000', name: 'X', close: 10, change_pct: 0, huanshou: 5 }],
  });
  const acct = {
    ...emptyAccount(1000000, '2026-09-29'),
    positions: { '600000': { code: '600000', name: 'X', qty: 1000, avail: 1000, avgCost: 8, cost: 8000, last: 10, lastDate: '2026-09-29' } },
  };
  const r = batchSell(acct, [{ code: '600000', pct: 0.25 }], day);
  assert.equal(r.summary.submitted, 1);
  // 1000 的 1/4 = 250 → 整手向下 200
  assert.equal(r.submitted[0].qty, 200);
});

test('批量卖出：T+1 未解冻的票卖不出（可卖为 0）', () => {
  const day = makeDay({
    trade_date: '2026-09-30',
    hot: [{ code: '600000', name: 'X', close: 10, change_pct: 0, huanshou: 5 }],
  });
  const acct = {
    ...emptyAccount(1000000, '2026-09-30'),
    positions: { '600000': { code: '600000', name: 'X', qty: 1000, avail: 0, avgCost: 8, cost: 8000, last: 10, lastBuyDate: '2026-09-30' } },
  };
  const r = batchSell(acct, [{ code: '600000', pct: 1 }], day);
  assert.equal(r.summary.blocked, 1);
  assert.match(r.blocked[0].reason, /可卖数量为 0/);
});

// ────────────────────── 四、委托与拦截日志 ──────────────────────

test('日志：龙虎拦截 / 风控拦截 / 委托提交三类事件全部入流', () => {
  const day = makeDay({
    trade_date: '2026-09-30',
    lhb: [L('600000', '好票', { net: 5000, close: 10 }), L('600001', '差票', { net: -100, close: 10 })],
    detail: {
      '600000': { b: [seat('机构专用', 3000), seat('某营业部1', 2800), seat('某营业部2', 2600), seat('某营业部3', 2400), seat('某营业部4', 2200), seat('某营业部5', 2000)], s: [seat('沪股通专用', 100)] },
      '600001': { b: [seat('某营业部', 500)], s: [seat('机构专用', 100)] },
    },
  });
  const acct = emptyAccount(1000000, '2026-09-29');
  const r = batchSubmit(acct, [{ code: '600000', pct: 0.05 }, { code: '600001', pct: 0.05 }, { code: '600002', pct: 0.25 }], day);
  const logs = readLogs(r.next);
  assert.ok(logs.length >= 3);
  assert.ok(logs.some((l) => l.stage === 'lhb' && l.result === 'rejected'));      // 差票被过滤拦
  assert.ok(logs.some((l) => l.stage === 'lhb' && l.result === 'pass'));          // 好票过滤通过
  assert.ok(logs.some((l) => l.stage === 'order' && l.result === 'submitted'));   // 好票提交成功
  // 每条日志必须带时间戳与可读说明（规则原文要求）
  for (const l of logs) { assert.ok(l.ts > 0); assert.ok(typeof l.text === 'string' && l.text.length > 0); }
});

test('日志：结算成交/失效写入日志，且可追加到研判报告文本', () => {
  const acct = emptyAccount(1000000, '2026-09-29');
  const quotes = { '600000': { code: '600000', name: 'X', price: 10, changePct: 1 } };
  const sub = submitOrder(acct, { code: '600000', side: 'buy', qty: 1000 }, { code: '600000', name: 'X', price: 9.9 }, { date: '2026-09-29' });
  const res = settleDay(sub.next, '2026-09-30', quotes);
  const logs = readLogs(res.account, { stage: 'settle' });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].result, 'filled');
  assert.match(logs[0].text, /成交/);
  const md = logsToReport(res.account);
  assert.match(md, /交易引擎事件日志/);
  assert.match(md, /600000/);
  // 无日志时不产生空表格
  assert.equal(logsToReport(emptyAccount(1000)), '');
});

test('日志：条数上限生效，不无限增长', () => {
  let acct = emptyAccount(1000000, '2026-09-01');
  for (let i = 0; i < MAX_LOGS + 50; i++) acct = { ...acct, logs: appendLog(acct, { text: 'x' + i }) };
  assert.equal(acct.logs.length, MAX_LOGS);
  assert.equal(acct.logs[acct.logs.length - 1].text, 'x' + (MAX_LOGS + 49));   // 保留最新
});

test('日志：可按交易日/阶段/结果过滤', () => {
  let acct = emptyAccount(1000000, '2026-09-01');
  acct = { ...acct, logs: appendLog(acct, { date: '2026-09-30', stage: 'lhb', result: 'rejected', text: 'a' }) };
  acct = { ...acct, logs: appendLog(acct, { date: '2026-09-30', stage: 'order', result: 'submitted', text: 'b' }) };
  acct = { ...acct, logs: appendLog(acct, { date: '2026-09-29', stage: 'lhb', result: 'pass', text: 'c' }) };
  assert.equal(readLogs(acct, { date: '2026-09-30' }).length, 2);
  assert.equal(readLogs(acct, { stage: 'lhb' }).length, 2);
  assert.equal(readLogs(acct, { result: 'rejected' }).length, 1);
  assert.equal(readLogs(acct, { limit: 1 })[0].text, 'c');
});

// ────────────────────── 五、收盘持仓扫描止损 ──────────────────────

test('止损扫描：浮亏 ≤ −8% 生成 T+1 卖出委托', () => {
  const acct = {
    ...emptyAccount(1000000, '2026-09-29'),
    positions: { '600000': { code: '600000', name: 'X', qty: 1000, avail: 1000, avgCost: 10, cost: 10000, last: 9.1, lastDate: '2026-09-30', lastBuyDate: '2026-09-01' } },
  };
  const s = scanStopLoss(acct, '2026-09-30');
  assert.equal(s.list.length, 1);
  assert.equal(s.list[0].pnlPct, -9);      // (9.1-10)/10 = -9%
  assert.equal(s.list[0].willSell, 1000);
  const after = s.apply(acct, '2026-09-30');
  assert.equal(after.pending.length, 1);
  assert.equal(after.pending[0].side, 'sell');
});

test('止损扫描：浮亏未达 −8% 不动作；恰好 −8% 触发', () => {
  const mk = (last) => ({
    ...emptyAccount(1000000, '2026-09-29'),
    positions: { '600000': { code: '600000', name: 'X', qty: 1000, avail: 1000, avgCost: 10, cost: 10000, last, lastDate: '2026-09-30', lastBuyDate: '2026-09-01' } },
  });
  assert.equal(scanStopLoss(mk(9.3), '2026-09-30').list.length, 0);    // -7%
  assert.equal(scanStopLoss(mk(9.2), '2026-09-30').list.length, 1);    // 恰好 -8% 触发
});

test('止损扫描：T+1 未解冻时如实留痕，不假装已止损', () => {
  const acct = {
    ...emptyAccount(1000000, '2026-09-30'),
    positions: { '600000': { code: '600000', name: 'X', qty: 1000, avail: 0, avgCost: 10, cost: 10000, last: 9, lastDate: '2026-09-30', lastBuyDate: '2026-09-30' } },
  };
  const s = scanStopLoss(acct, '2026-09-30');
  assert.equal(s.list.length, 1);
  assert.match(s.list[0].skipped, /T\+1/);
  const after = s.apply(acct, '2026-09-30');
  assert.equal(after.pending.length, 0);
  const logs = readLogs(after, { stage: 'stop' });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].result, 'expired');
  assert.match(logs[0].text, /无法生成卖出委托/);
});

test('止损扫描：settleDay 内置执行，并可在结算结果里取回清单', () => {
  const acct = {
    ...emptyAccount(1000000, '2026-09-29'),
    positions: { '600000': { code: '600000', name: 'X', qty: 1000, avail: 1000, avgCost: 10, cost: 10000, last: 10, lastDate: '2026-09-29', lastBuyDate: '2026-09-01' } },
  };
  const quotes = { '600000': { code: '600000', name: 'X', price: 9, changePct: -10 } };
  const res = settleDay(acct, '2026-09-30', quotes);
  assert.equal(res.stopLoss.length, 1);
  assert.equal(res.stopLoss[0].pnlPct, -10);
  assert.equal(res.account.pending.length, 1);
  // 可关闭
  const off = settleDay(acct, '2026-09-30', quotes, { scanStopLoss: false });
  assert.equal(off.stopLoss.length, 0);
  assert.equal(off.account.pending.length, 0);
});

// ────────────────────── 六、结构化输出（规则第八块） ──────────────────────

test('结构化详情：买入 pending 含代码/名称/方向/价格/股数/成交金额/各项费用/冻结资金/撮合说明', () => {
  const acct = emptyAccount(1000000, '2026-09-30');
  const sub = submitOrder(acct, { code: '600000', side: 'buy', qty: 1000 }, { code: '600000', name: '浦发银行', price: 10 }, { date: '2026-09-30' });
  const d = orderDetail(sub.order, sub.next);
  assert.equal(d.code, '600000');
  assert.equal(d.name, '浦发银行');
  assert.equal(d.side, 'buy'); assert.equal(d.sideLabel, '买入');
  assert.equal(d.qty, 1000);
  // 默认滑点 2‱：10 元 → 10.002，四舍五入到分是 10.00（方向丢失），
  // 故按「方向必须体现」的保守取法抬到 10.01（引擎刻意设计，低价股不豁免滑点）
  assert.equal(d.price, 10.01);
  assert.equal(d.grossAmount, 10010);
  assert.equal(d.fee.commission, 5);            // 10010*0.0003=3.003 < 5，取最低
  assert.equal(d.fee.transfer, 0.1);            // 10010*0.00001=0.1001 → 0.1
  assert.equal(d.fee.stampTax, 0);              // 买入无印花税
  assert.equal(d.frozenOrReturn.kind, 'freeze');
  assert.equal(d.freezeAmount, 10015.1);        // 10010 + 5 + 0.1
  assert.match(d.text, /T\+1/);
});

test('结构化详情：卖出含印花税；成交后价格与回款用实际值', () => {
  const acct = {
    ...emptyAccount(1000000, '2026-09-29'),
    positions: { '600000': { code: '600000', name: 'X', qty: 1000, avail: 1000, avgCost: 8, cost: 8000, last: 10, lastDate: '2026-09-29', lastBuyDate: '2026-09-01' } },
  };
  const sub = submitOrder(acct, { code: '600000', side: 'sell', qty: 1000 }, { code: '600000', name: 'X', price: 10 }, { date: '2026-09-29' });
  const res = settleDay(sub.next, '2026-09-30', { '600000': { code: '600000', name: 'X', price: 12, changePct: 2 } });
  const trade = res.account.trades[0];
  assert.ok(trade, '应有成交记录');
  assert.equal(trade.fillDate, '2026-09-30');
  const d = orderDetail(trade, res.account);
  // 成交后滑点方向为卖方压价：12 → 11.9976 → 11.99（方向丢失再压一格）
  assert.equal(d.fillPrice, 11.99);
  assert.equal(d.grossAmount, 11990);
  assert.equal(d.fee.commission, 5);            // 11990*0.0003=3.597 < 5
  assert.equal(d.fee.stampTax, 6);              // 11990*0.0005=5.995 → 6（四舍五入到分）
  assert.equal(d.returnAmount, 11990 - d.fee.total);
  assert.equal(d.frozenOrReturn.kind, 'return');
  // 成交记录带 driftPct（委托价→成交价漂移，T+1 撮合的必然结果）
  assert.ok(trade.driftPct != null);
});

test('结构化详情：被拒/失效给出可读说明', () => {
  const acct = emptyAccount(1000000, '2026-09-30');
  const rej = submitOrder(acct, { code: '600000', side: 'buy', qty: 150 }, { code: '600000', name: 'X', price: 10 }, { date: '2026-09-30' });
  const d = orderDetail(rej.order);
  assert.equal(d.ok, false);
  assert.equal(d.status, 'rejected');
  assert.match(d.text, /未提交/);
  // 批量订单列表转详情
  const list = orderDetails([rej.order], acct);
  assert.equal(list.length, 1);
});

test('版本常量：规则引擎版本号锁定', () => {
  assert.equal(SKIPPED_RULES.LOCKUP_RATIO.length > 0, true);
  assert.match(SKIPPED_RULES.GAIN_60D, /33 个交易日/);
});
