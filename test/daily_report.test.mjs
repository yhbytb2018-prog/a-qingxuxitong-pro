// #4 日报生成器 daily_report.js —— 真调用断言
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDailyReport, DISPLAY } from '../src/daily_report.js';

// 一份"素材齐全"的 fixtures（贴近 signals-latest.json 真实形态）
function fullSignals() {
  return {
    meta: { tradeDate: '2026-09-30', stale: false, freshness: { state: 'fresh' } },
    latest: {
      trade_date: '2026-09-30',
      value: 64.4, pct_rank: 76.3, net_daily_pct_rank: 49.2,
      factors: { s_net: 74.6, s_pos: 46.7, s_brd: 53.3, s_hot: 85.2, s_zdt: 85.2, s_zbl: 81.3, s_amt: 31.5 },
      missing: [], imputedRatio: 0,
      zt_count: 52, dt_count: 9, zb_count: 12, seal_pct: 80,
      up_count: 2393, down_count: 2730,
      main_theme: { name: '业绩线', main_yi: 1.06, tot_yi: 7.74, pct: 13.7 },
      industry_relative: {
        degraded: false,
        vsIndex: { baseLabel: '上证指数', attack: [{ name: '生物制品', change_pct: 4.63, excess: 4.32 }], defense: [{ name: '元件', change_pct: -4.03, excess: -4.34 }] },
      },
    },
    regimeSeries: [{ value: 60 }, { value: 62 }, { value: 60.2 }, { value: 64.4 }],
    breadth: { verdict: { level: 'narrow', label: '宽度收窄', detail: '站上20日线仅 30.1%' }, summary: { latest: { maRatio: 0.3007 } } },
    pain: {
      verdict: { level: 'normal', label: '多空拉锯', reason: '昨涨停今日翻绿 49%' },
      perf: { n: 57, avg: 1.3, median: 0, lossRatio: 0.49, limitUpAgain: 14, limitDown: 3, reliable: true },
      advance: { n: 10, kept: 6, failed: 4, failRate: 0.4 },
      bigLoss: { n: 1, list: [{ code: '605058', name: '澳弘电子', chg: -10 }] },
    },
    seats: { verdict: { level: 'hot', label: '游资主导', reason: '游资净买 8.43 亿' }, summary: { instNet: { last: 6.72 }, northNet: { last: 1.75 }, hotNet: { last: 8.43 }, totalRows: 3, coverage: 0.01 } },
    dirty: { totalDays: 241, taggedDays: 1, dirtyDays: 0, warnDays: 1, recent: [{ date: '2026-08-18', issues: [{ reason: '行业数值孤立' }] }] },
    health: { summary: '数据健康：注意——因子补位率需关注' },
    crosscheck: { verdict: { label: '一致', level: 'ok' } },
  };
}

test('buildDailyReport: 结构完整（date/headline/tag/divergence/sections/caveats/sources）', () => {
  const R = buildDailyReport(fullSignals());
  assert.equal(R.date, '2026-09-30');
  assert.ok(R.headline.includes('2026-09-30'));
  assert.ok(R.tag.key);
  assert.ok(Array.isArray(R.sections));
  assert.equal(R.sections.length, 8, '应有八节（V5.3 增节 8 舆情参考）');
  assert.ok(Array.isArray(R.caveats));
  assert.ok(R.sources && R.sources.regime);
  assert.ok(typeof R.disclaimer === 'string' && R.disclaimer.length > 0);
});

test('buildDailyReport: 八个分节标题齐全且顺序固定', () => {
  const R = buildDailyReport(fullSignals());
  const ids = R.sections.map((s) => s.id);
  assert.deepEqual(ids, ['regime', 'sentiment', 'breadth', 'pain', 'seats', 'theme', 'quality', 'llm']);
});

test('buildDailyReport: 高潮日 + 宽度窄 → ★ 切换期（V5.3 矛盾覆盖），headline 含"切换期"与"假繁荣"', () => {
  const R = buildDailyReport(fullSignals());
  // fixture：分位 76.3（high）+ 方向 flat → 主标签 climax；但宽度收窄 → 假繁荣背离
  // → V5.3 矛盾覆盖为切换期（保守档），背离线索仍完整披露
  assert.equal(R.tag.key, 'shift');
  assert.match(R.headline, /切换期/);
  assert.match(R.headline, /假繁荣/);
  assert.match(R.headline, /推荐仓位区间 0%~30%/, '切换期 → 强制降仓区间');
  assert.equal(R.divergence.diverged, true);
});

test('buildDailyReport: ★ V5.3 节一带仓位区间（neutral → 30%~50%），unknown 不给区间', () => {
  const S = fullSignals();
  // 无背离 + 无末段特征 → neutral 主标签（value 55 / pct 50 / 方向 flat）
  S.latest = { ...S.latest, value: 55, pct_rank: 50 };
  S.regimeSeries = [{ value: 54 }, { value: 55 }, { value: 55 }, { value: 55 }];
  S.breadth = { verdict: { level: 'mid', label: '宽度中性' } };
  const R = buildDailyReport(S);
  assert.equal(R.tag.key, 'neutral');
  assert.match(R.headline, /推荐仓位区间 30%~50%/);
  const sec = R.sections.find((s) => s.id === 'regime');
  assert.ok(sec.points.some((p) => /推荐仓位区间 30%~50%/.test(p.text)));
  assert.equal(sec.title, '一、市场状态判定');
  assert.ok(sec.position && sec.position.range === '30%~50%');
  // unknown：不给区间（缺失显式化）
  const U = buildDailyReport({});
  const usec = U.sections.find((s) => s.id === 'regime');
  assert.equal(usec.missing, true);
  assert.ok(!U.headline.includes('推荐仓位区间'));
});

test('buildDailyReport: caveats 含背离与（真正的）判据缺口', () => {
  const R = buildDailyReport(fullSignals());
  assert.ok(R.caveats.some((c) => /假繁荣/.test(c)));
});

test('buildDailyReport: ★ 双尺子读数差异【不进】caveats（是已解释的建模取舍，不是缺口）', () => {
  const S = fullSignals();
  // 宽度同向（broad）→ 无背离，主标签保持 climax；分位 76.3 high vs 绝对 64.4 mid 两尺子不一致
  S.breadth = { verdict: { level: 'broad', label: '宽度扩张' } };
  const R = buildDailyReport(S);
  assert.equal(R.tag.key, 'climax');
  assert.ok(R.tag.level === 'high');
  assert.ok(!R.caveats.some((c) => /判据缺口.*以分位为准/.test(c)),
    '尺度差异已在第二节披露，不应混进缺口清单');
  // 但第二节里必须如实披露
  const sec = R.sections.find((s) => s.id === 'sentiment');
  assert.ok(sec.points.some((p) => /水位判据分歧/.test(p.text)), '分歧必须披露，只是不算缺口');
});

test('buildDailyReport: ★ 缺失显式化 —— pain 未注入 → 该节 missing + 原因，不编造', () => {
  const S = fullSignals();
  S.pain = null;
  const R = buildDailyReport(S);
  const sec = R.sections.find((s) => s.id === 'pain');
  assert.equal(sec.missing, true);
  assert.ok(sec.missingReason);
  assert.equal(sec.points.length, 0, '缺失节不得编造要点');
  assert.match(R.headline, /缺数据|缺失|个区块/, '末尾应提示有缺数据区块');
});

test('buildDailyReport: ★ 缺失显式化 —— seats 未注入 → missing', () => {
  const S = fullSignals();
  S.seats = null;
  const sec = buildDailyReport(S).sections.find((s) => s.id === 'seats');
  assert.equal(sec.missing, true);
});

test('buildDailyReport: ★ 缺失显式化 —— 无行业明细 → theme missing，不显示 0', () => {
  const S = fullSignals();
  S.latest.industry_relative = null;
  S.relative = null;
  S.latest.main_theme = null;
  const sec = buildDailyReport(S).sections.find((s) => s.id === 'theme');
  assert.equal(sec.missing, true);
  assert.ok(!JSON.stringify(sec).includes('0%'), '缺失不得出现 0%');
});

test('buildDailyReport: ★ 全空输入 → 不炸，标签 unknown，headline 明说数据不足', () => {
  const R = buildDailyReport({});
  assert.equal(R.date, null);
  assert.equal(R.tag.key, 'unknown');
  assert.match(R.headline, /数据不足/);
  assert.ok(R.sections.length === 8);
});

test('buildDailyReport: null 输入不炸', () => {
  const R = buildDailyReport(null);
  assert.equal(R.tag.key, 'unknown');
});

test('buildDailyReport: 情绪分缺失 → 第二节 missing，不填 0', () => {
  const S = fullSignals();
  S.latest.value = null;
  const sec = buildDailyReport(S).sections.find((s) => s.id === 'sentiment');
  assert.equal(sec.missing, true);
});

test('buildDailyReport: 因子里的 null 被跳过（不显示成 0）', () => {
  const S = fullSignals();
  S.latest.factors = { s_net: 74.6, s_pos: null, s_brd: 53.3 };
  const sec = buildDailyReport(S).sections.find((s) => s.id === 'sentiment');
  const facLine = sec.points.find((p) => /因子：/.test(p.text));
  assert.ok(!/s_pos/.test(facLine.text), 'null 因子不应出现在明细里');
  assert.match(facLine.text, /s_net 74\.6/);
});

test('buildDailyReport: 缺失因子列入"缺失因子"提示', () => {
  const S = fullSignals();
  S.latest.missing = ['s_pos'];
  const sec = buildDailyReport(S).sections.find((s) => s.id === 'sentiment');
  assert.ok(sec.points.some((p) => /缺失因子：s_pos/.test(p.text)));
});

test('buildDailyReport: 代理补位比例 >0 时给 caution', () => {
  const S = fullSignals();
  S.latest.imputedRatio = 0.25;
  const sec = buildDailyReport(S).sections.find((s) => s.id === 'sentiment');
  assert.ok(sec.points.some((p) => /代理补位比例 25%/.test(p.text)));
});

test('buildDailyReport: 涨跌家数缺失时该节标 warn 并列出未采集项', () => {
  const S = fullSignals();
  S.latest.up_count = null;
  S.latest.down_count = null;
  const sec = buildDailyReport(S).sections.find((s) => s.id === 'breadth');
  assert.equal(sec.level, 'warn');
  assert.ok(sec.points.some((p) => /未采集：涨跌家数/.test(p.text)));
});

test('buildDailyReport: ★ 节三口径披露——指数/成交额/样本范围固定呈现（复盘对比纪律）', () => {
  // 场景对应 2026-09-30 真实档：上证 +0.31%、成交 14380 亿（前日 14092 → +288 亿）、
  //   涨 2393/跌 2730/平 167（样本 5290）。此前指数与成交额数据在档但报告从不显示，
  //   涨跌合计不含平盘（5123）与全市场口径对比时放大差异。
  const S = fullSignals();
  S.latest.flat_count = 167;
  S.latest.amount_yi = 14380.2;
  S.latest.indexes = { 上证指数: 0.31, 深证成指: -0.11, 创业板指: -0.23 };
  S.latest.breadth_scope = '沪深两市A股（不含北交所/ST口径与各平台统计或有出入）';
  S.amountPrevYi = 14092;
  const sec = buildDailyReport(S).sections.find((s) => s.id === 'breadth');
  const line = (re) => sec.points.find((p) => re.test(p.text));
  assert.match(line(/指数/).text, /上证指数 \+0\.3% · 深证成指 -0\.1% · 创业板指 -0\.2%/);
  assert.match(line(/涨 2393/).text, /涨 2393 \/ 跌 2730 \/ 平 167（样本 5290）/, '合计必须含平盘（真实样本量）');
  assert.match(line(/成交额/).text, /两市成交额 14380 亿（较前一日 \+288 亿）/);
  assert.match(line(/口径/).text, /不含北交所/, '必须写明样本范围');
  assert.match(line(/口径/).text, /样本范围差异/, '必须说明与全市场口径的差异性质');
});

test('buildDailyReport: ★ 节三——前日成交额缺失时只报当日值，不编增量', () => {
  const S = fullSignals();
  S.latest.amount_yi = 14380.2;
  delete S.amountPrevYi;
  const sec = buildDailyReport(S).sections.find((s) => s.id === 'breadth');
  const line = sec.points.find((p) => /成交额/.test(p.text));
  assert.match(line.text, /^两市成交额 14380 亿$/);
});

test('buildDailyReport: 亏钱效应 warn 级 → 该节 level=warn', () => {
  const S = fullSignals();
  S.pain.verdict = { level: 'warn', label: '亏钱明显', reason: 'x' };
  const sec = buildDailyReport(S).sections.find((s) => s.id === 'pain');
  assert.equal(sec.level, 'warn');
});

test('buildDailyReport: 大面股名单进入要点（含名称与涨跌幅）', () => {
  const S = fullSignals();
  S.pain.bigLoss = { n: 2, list: [{ name: 'A', chg: -10 }, { name: 'B', chg: -9 }] };
  const sec = buildDailyReport(S).sections.find((s) => s.id === 'pain');
  assert.ok(sec.points.some((p) => /大面 2 只.*A -10%/.test(p.text)));
});

test('buildDailyReport: 质量节 —— 有 warnDays 标 warn 并说明"只标记不剔除"', () => {
  const sec = buildDailyReport(fullSignals()).sections.find((s) => s.id === 'quality');
  assert.equal(sec.level, 'warn');
  assert.ok(sec.points.some((p) => /只标记、不剔除/.test(p.text)));
});

test('buildDailyReport: 质量节 —— 无脏数据时给"校验通过"', () => {
  const S = fullSignals();
  S.dirty = { totalDays: 241, taggedDays: 0, dirtyDays: 0, warnDays: 0 };
  const sec = buildDailyReport(S).sections.find((s) => s.id === 'quality');
  assert.ok(sec.points.some((p) => /241 天校验通过/.test(p.text)));
});

test('buildDailyReport: ★ 质量节 —— 告警复核闭环披露（day.review 聚合下发）', () => {
  // 场景：5 条 WARN 已由 scripts/review_alerts.mjs 跨源互证全部销案 →
  //   报告必须披露"N/M 已销案"，最近留痕行必须带销案后缀——
  //   否则读者对着已复核的告警重复劳动（这就是本测试锁定的行为）。
  const S = fullSignals();
  S.dirty = {
    totalDays: 241, taggedDays: 5, dirtyDays: 0, warnDays: 5,
    review: { checked: 5, verified: 5, mismatch: 0, at: '2026-10-02' },
    recent: [{ date: '2026-08-18', issues: [{ reason: '行业数值孤立' }], reviewVerdict: 'verified' }],
  };
  const sec = buildDailyReport(S).sections.find((s) => s.id === 'quality');
  assert.ok(sec.points.some((p) => /告警复核：5\/5 条已跨源互证销案/.test(p.text)), '销案计数行缺失');
  const trace = sec.points.find((p) => /最近留痕/.test(p.text));
  assert.match(trace.text, /已复核销案（跨源互证通过）$/, '留痕行必须带销案后缀');
});

test('buildDailyReport: ★ 质量节 —— 复核未通过维持告警（mismatch → caution，不放行）', () => {
  const S = fullSignals();
  S.dirty = {
    totalDays: 241, taggedDays: 2, dirtyDays: 0, warnDays: 2,
    review: { checked: 2, verified: 1, mismatch: 1, at: '2026-10-02' },
    recent: [{ date: '2026-08-18', issues: [{ reason: '行业数值孤立' }], reviewVerdict: 'mismatch' }],
  };
  const sec = buildDailyReport(S).sections.find((s) => s.id === 'quality');
  assert.ok(sec.points.some((p) => p.kind === 'caution' && /1 条两源数值不符，维持告警/.test(p.text)), 'mismatch 必须是 caution');
  const trace = sec.points.find((p) => /最近留痕/.test(p.text));
  assert.match(trace.text, /复核未通过（两源不符，维持告警）$/);
});

test('buildDailyReport: ★ 质量节 —— 无复核留痕时不冒充"已通过"（review 缺失 → 无销案行）', () => {
  const S = fullSignals();
  // fullSignals 的 dirty 无 review 字段 → 不得出现销案措辞（缺失≠通过）
  const sec = buildDailyReport(S).sections.find((s) => s.id === 'quality');
  assert.ok(!sec.points.some((p) => /已跨源互证销案/.test(p.text)), '无 review 时不得显示销案');
  assert.ok(!sec.points.some((p) => /已复核销案/.test(p.text)));
});

test('buildDailyReport: ★ 跨源互证缺失 → 明说"缺失不等于一致"（不放行成 ok）', () => {
  const S = fullSignals();
  S.crosscheck = null;
  const sec = buildDailyReport(S).sections.find((s) => s.id === 'quality');
  assert.ok(sec.points.some((p) => /未进行（缺失不等于一致）/.test(p.text)));
});

test('buildDailyReport: stale 时给醒目告警', () => {
  const S = fullSignals();
  S.meta.stale = true; S.meta.staleReason = '抓取失败';
  const sec = buildDailyReport(S).sections.find((s) => s.id === 'quality');
  assert.equal(sec.level, 'warn');
  assert.ok(sec.points.some((p) => /数据过期.*抓取失败/.test(p.text)));
});

test('buildDailyReport: health 前缀不重复（数据健康：数据健康：）', () => {
  const sec = buildDailyReport(fullSignals()).sections.find((s) => s.id === 'quality');
  const line = sec.points.find((p) => /数据健康/.test(p.text));
  assert.equal((line.text.match(/数据健康/g) || []).length, 1);
});

test('buildDailyReport: 席位净买三分类都显示', () => {
  const sec = buildDailyReport(fullSignals()).sections.find((s) => s.id === 'seats');
  const line = sec.points.find((p) => /当日净买/.test(p.text));
  assert.match(line.text, /机构 6\.7 亿/);
  assert.match(line.text, /北向 1\.8 亿/);
  assert.match(line.text, /游资 8\.4 亿/);
});

test('buildDailyReport: 相对强弱降级 → caution', () => {
  const S = fullSignals();
  S.latest.industry_relative.degraded = true;
  S.latest.industry_relative.degradedReason = '行业明细不足';
  const sec = buildDailyReport(S).sections.find((s) => s.id === 'theme');
  assert.ok(sec.points.some((p) => /已降级.*行业明细不足/.test(p.text)));
});

test('buildDailyReport: 免责声明必须存在且含"不构成投资建议"', () => {
  const R = buildDailyReport(fullSignals());
  assert.match(R.disclaimer, /不构成投资建议/);
});

test('buildDailyReport: ★ 报告不含任何买卖动作指令（只描述状态）', () => {
  const R = buildDailyReport(fullSignals());
  const all = JSON.stringify(R);
  for (const bad of ['建议买入', '建议卖出', '立即买入', '立即卖出', '推荐买入']) {
    assert.ok(!all.includes(bad), `报告不得含投资建议措辞：${bad}`);
  }
});

test('buildDailyReport: sources 覆盖全部七节的来源模块', () => {
  const R = buildDailyReport(fullSignals());
  for (const k of ['regime', 'sentiment', 'breadth', 'pain', 'seats', 'relative', 'dirty', 'health', 'llm']) {
    assert.ok(R.sources[k], `缺少来源声明：${k}`);
  }
});

test('DISPLAY: 显示层舍入常量存在（唯一出处）', () => {
  assert.equal(typeof DISPLAY.pct1, 'number');
  assert.equal(typeof DISPLAY.score1, 'number');
});

test('buildDailyReport: 序列不足（regimeSeries 只有一个点）→ 标签 unknown 且 headline 说明', () => {
  const S = fullSignals();
  S.regimeSeries = [{ value: 64.4 }];
  const R = buildDailyReport(S);
  assert.match(R.headline, /数据不足|判据不全/);
});

test('buildDailyReport: 无背离时不往 caveats 塞噪音', () => {
  const S = fullSignals();
  S.breadth.verdict = { level: 'broad', label: '宽度扩张' };
  const R = buildDailyReport(S);
  assert.equal(R.divergence.diverged, false);
  assert.ok(!R.caveats.some((c) => /假繁荣|底部背离/.test(c)));
});

// ── V5.3 P2：节 8 舆情参考（LLM 试点，原分不动仅参考） ────────────────────

test('buildDailyReport: 无 llm 段 → 节 8 missing（未生成 ≠ 舆情中性）', () => {
  const R = buildDailyReport(fullSignals());
  const sec = R.sections.find((x) => x.id === 'llm');
  assert.ok(sec, '节 8 必须存在（即使缺数据）');
  assert.equal(sec.missing, true);
  assert.match(sec.missingReason, /fetch_llm_sentiment\.mjs/);
  assert.match(sec.missingReason, /未跑 ≠ 舆情中性/);
});

test('buildDailyReport: llm 生效块 → 节 8 给参考修正分与口径披露', () => {
  const S = fullSignals();
  S.llm = {
    asOfDate: '2026-09-30', model: 'test-model', sentimentRaw: 0.6, adj: 3,
    effective: true, effectNote: '同向增强：原分 70 偏多，舆情正面 → 参考分上浮/下调 +3',
    direction: 'bullish', original: 70, modified: 73,
    events: [{ type: '业绩预告', target: '某板块', tone: 'positive' }],
    confidence: 0.7, reason: '龙头业绩预增', note: '口径',
  };
  const R = buildDailyReport(S);
  const sec = R.sections.find((x) => x.id === 'llm');
  assert.equal(sec.missing, false);
  assert.equal(sec.level, 'info', '同向增强是参考信息不上告警色');
  assert.ok(sec.points.some((p) => /70 → 73/.test(p.text)), '参考修正分主读数');
  assert.ok(sec.points.some((p) => /不独立生成买卖信号/.test(p.text)), '口径披露');
  assert.ok(sec.points.some((p) => /2026-09-30｜模型 test-model/.test(p.text)), '证据日期与模型留痕');
  // 原分不动：latest.value 仍是 64.4（llm 不写回）
  assert.equal(S.latest.value, 64.4);
});

test('buildDailyReport: llm 反向不生效块 → level=info 且只给原因不给修正分', () => {
  const S = fullSignals();
  S.llm = {
    asOfDate: '2026-09-30', model: 'm', sentimentRaw: -0.8, adj: -4,
    effective: false, effectNote: '方向矛盾：原分 70 偏多 vs 舆情负面——保守起见保持原分，仅提示分歧',
    direction: 'bullish', original: 70, modified: null,
    events: [], confidence: 0.5, reason: null, note: '口径',
  };
  const R = buildDailyReport(S);
  const sec = R.sections.find((x) => x.id === 'llm');
  assert.ok(sec.points.some((p) => /不生效/.test(p.text)));
  assert.ok(!sec.points.some((p) => /→/.test(p.text)), '不生效时无修正分形态');
});
