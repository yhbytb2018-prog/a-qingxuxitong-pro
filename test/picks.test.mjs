// 研判推荐引擎测试：锁死「推荐从哪来、按什么排序、仓位怎么给」的每一条纪律。
//
// 这些用例的价值不在「跑通」，而在「别人改引擎时不会悄悄破坏纪律」——
// 例如把区间累计榜放回候选池（净买额变成三天累计值）、让没有资金证据的票进推荐、
// 或者在清仓档位依然给出建仓建议（逆着市场档位推荐重仓是自相矛盾）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PICK_TOP_N, SCORE_WEIGHTS, TIER_THRESHOLDS, POSITION_TIERS,
  marketTier, buildCandidates, scoreFund, scoreStreak, scoreCandidate,
  reasonsOf, risksOf, suggestWeight, recommendPicks,
} from '../src/picks.js';

// 构造一份最小可用的「存档日」。字段名与 archive.json 严格一致，
// 避免测试因为字段拼错而「恰好通过」——那会让引擎上线后取不到值却无人发现。
const day = (over = {}) => ({
  trade_date: '2026-09-30',
  hot: [],
  lhb: [],
  themes: {},
  summary: {},
  ...over,
});

const lhbRow = (code, name, netWan, over = {}) => ({
  code, name, net_buy_wan: netWan, buy_wan: Math.max(netWan, 0) * 2, sell_wan: Math.max(netWan, 0),
  close: 10, change_pct: 5, turnover_pct: 8, reason: '日涨幅偏离值达7%', is_range: false, ...over,
});

// ────────────────────── 一、市场档位（阈值必须与 V5.2 引擎一致） ──────────────────────

test('市场档位：阈值边界与 V5.2 引擎逐点一致', () => {
  // 阈值集中在一处，这里锁死「边界值落在哪一侧」——差一档就是「满仓」与「只减仓」的区别
  assert.equal(marketTier(TIER_THRESHOLDS.overheat).key, 'overheat');
  assert.equal(marketTier(85).key, 'overheat');
  assert.equal(marketTier(TIER_THRESHOLDS.overheat - 0.01).key, 'full');
  assert.equal(marketTier(TIER_THRESHOLDS.full).key, 'full');
  assert.equal(marketTier(TIER_THRESHOLDS.full - 0.01).key, 'half');
  assert.equal(marketTier(TIER_THRESHOLDS.half + 0.01).key, 'half');
  assert.equal(marketTier(TIER_THRESHOLDS.half).key, 'clear');
  assert.equal(marketTier(0).key, 'clear');
});

test('市场档位：过热与清仓都不允许新建仓，只有满仓/半仓允许', () => {
  assert.equal(marketTier(90).allowNew, false);
  assert.equal(marketTier(70).allowNew, true);
  assert.equal(marketTier(50).allowNew, true);
  assert.equal(marketTier(10).allowNew, false);
});

test('市场档位：情绪分缺失时返回 null（不猜、不默认满仓）', () => {
  assert.equal(marketTier(null), null);
  assert.equal(marketTier(undefined), null);
  assert.equal(marketTier(NaN), null);
  assert.equal(marketTier('abc'), null);
});

// ────────────────────── 二、评分权重与子项 ──────────────────────

test('评分权重必须和为 1（否则分数不可跨日比较）', () => {
  const sum = Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(Math.round(sum * 1e6) / 1e6, 1);
});

test('资金分：净买额越大分越高，且分档单调', () => {
  const xs = [0, 1000, 2000, 5000, 10000, 20000, 50000, 999999];
  const ss = xs.map(scoreFund);
  for (let i = 1; i < ss.length; i++) assert.ok(ss[i] >= ss[i - 1], `${xs[i]} 应 >= ${xs[i - 1]}`);
  assert.equal(scoreFund(999999), 1);
  assert.equal(scoreFund(null), 0);
  assert.equal(scoreFund(NaN), 0);
});

test('连板分：1 板起步，4 板及以上封顶 1，且单调不减', () => {
  assert.equal(scoreStreak(0), 0);
  assert.ok(scoreStreak(1) > 0);
  assert.ok(scoreStreak(2) > scoreStreak(1));
  assert.ok(scoreStreak(3) > scoreStreak(2));
  assert.equal(scoreStreak(4), 1);
  assert.equal(scoreStreak(9), 1);
  assert.equal(scoreStreak(null), 0);
});

test('综合评分：龙虎榜净买更大的票得分更高（同连板同题材）', () => {
  const ctx = { totalDealWan: 200000 };
  const a = scoreCandidate({ netWan: 60000, buyWan: 100000, sellWan: 20000, themes: [] }, ctx);
  const b = scoreCandidate({ netWan: 3000, buyWan: 5000, sellWan: 2000, themes: [] }, ctx);
  assert.ok(a.score > b.score, `${a.score} 应 > ${b.score}`);
});

test('综合评分：主线精确命中 > 词根命中 > 仅泛题材', () => {
  const base = { netWan: 5000, buyWan: 8000, sellWan: 3000, themes: ['业绩预增'] };
  const ex = scoreCandidate({ ...base, inMainTheme: true, mainThemeMatch: 'exact' });
  const st = scoreCandidate({ ...base, inMainTheme: true, mainThemeMatch: 'stem' });
  const gn = scoreCandidate({ ...base, inMainTheme: false, mainThemeMatch: null });
  assert.ok(ex.score > st.score, `精确 ${ex.score} 应 > 词根 ${st.score}`);
  assert.ok(st.score > gn.score, `词根 ${st.score} 应 > 泛题材 ${gn.score}`);
});

// ────────────────────── 三、候选池去噪（口径纪律） ──────────────────────

test('候选池：剔除区间累计榜（其净买额是连续多日累计值，不可当日度值用）', () => {
  const d = day({
    lhb: [
      lhbRow('600001', '当日票', 12000),
      lhbRow('600002', '区间票', 999999, { is_range: true, reason: '连续三个交易日涨跌幅偏离值累计达20%' }),
    ],
  });
  const codes = buildCandidates(d).map((c) => c.code);
  assert.ok(codes.includes('600001'));
  assert.ok(!codes.includes('600002'), '区间累计榜必须被剔除');
});

test('候选池：区间榜判定在缺少 is_range 字段时按 reason 兜底（存量数据兼容）', () => {
  const d = day({
    lhb: [{ code: '600003', name: '旧档区间票', net_buy_wan: 50000, buy_wan: 9e5, sell_wan: 4e5,
      close: 10, change_pct: 30, turnover_pct: 50,
      reason: '严重异常期间日收盘价格涨幅偏离值累计达到100%的证券' }],
  });
  assert.equal(buildCandidates(d).length, 0, '无 is_range 时也须按 reason 剔除');
});

test('候选池：剔除新股/无涨跌幅限制个股（涨跌幅不可比，涨跌停判定会失真）', () => {
  const d = day({
    lhb: [
      lhbRow('600010', '正常票', 8000),
      lhbRow('001246', '力勤资源', 50412, { reason: '无价格涨跌幅限制的证券', change_pct: 206.59 }),
    ],
  });
  const codes = buildCandidates(d).map((c) => c.code);
  assert.ok(codes.includes('600010'));
  assert.ok(!codes.includes('001246'), '新股/无涨跌幅限制必须被剔除');
});

test('候选池：净买为负的票不进候选（资金在出，不能作为买入推荐）', () => {
  const d = day({ lhb: [lhbRow('600020', '净卖票', -20000), lhbRow('600021', '净买票', 5000)] });
  const codes = buildCandidates(d).map((c) => c.code);
  assert.ok(!codes.includes('600020'));
  assert.ok(codes.includes('600021'));
});

test('候选池：涨停股即使没有龙虎榜也能入选（市场共识是独立证据）', () => {
  const d = day({
    hot: [{ code: '600030', name: '涨停票', close: 12, change_pct: 10, huanshou: 15, reason: '固态电池+龙头' }],
    summary: { zt_codes: ['600030'], zt_lb: { 600030: 2 } },
  });
  const c = buildCandidates(d);
  assert.equal(c.length, 1);
  assert.equal(c[0].isZt, true);
  assert.equal(c[0].streak, 2);
});

test('候选池：同一只票既有龙虎榜又涨停时不重复计数，字段正确合并', () => {
  const d = day({
    hot: [{ code: '600040', name: '双证据票', close: 20, change_pct: 10, huanshou: 22, reason: '机器人+减速器' }],
    lhb: [lhbRow('600040', '双证据票', 30000)],
    summary: { zt_codes: ['600040'], zt_lb: { 600040: 3 } },
    themes: { 机器人: 3 },
  });
  const c = buildCandidates(d);
  assert.equal(c.length, 1, '同票必须只出现一次');
  assert.equal(c[0].netWan, 30000);
  assert.equal(c[0].streak, 3);
  // source 记录该票的证据来源：龙虎榜 + 涨停 + 热点榜各计一次（标签用于透明度，不参与评分）
  assert.deepEqual(c[0].source.slice().sort(), ['hot', 'lhb', 'zt']);
  // 热点榜的业务诱因与龙虎榜的上榜原因都必须保留（早先只留后者，导致题材匹配全部落空）
  assert.equal(c[0].hotReason, '机器人+减速器');
  assert.ok(c[0].themes.includes('机器人'), `题材应含机器人，实际 ${JSON.stringify(c[0].themes)}`);
});

test('候选池：空输入/畸形输入安全返回空数组，不抛错', () => {
  assert.deepEqual(buildCandidates(null), []);
  assert.deepEqual(buildCandidates({}), []);
  assert.deepEqual(buildCandidates({ lhb: 'not-an-array', hot: null }), []);
});

// ────────────────────── 四、主线题材匹配（聚合桶标签的词根兜底） ──────────────────────

test('主线题材：主线名是聚合桶标签时用词根匹配，并如实标注为 stem 而非 exact', () => {
  // 实测场景：main_theme.name = 「业绩线」在当日热点 reason 中出现 0 次，
  // 而「业绩增长/业绩预增」出现多次。只做字面匹配会让主线判定恒为 false。
  const d = day({
    hot: [
      { code: '600050', name: '业绩票', close: 10, change_pct: 5, huanshou: 5, reason: '汽车电子+业绩预增' },
      { code: '600051', name: '无关票', close: 10, change_pct: 5, huanshou: 5, reason: '固态电池+铝塑膜' },
    ],
    lhb: [lhbRow('600050', '业绩票', 8000), lhbRow('600051', '无关票', 8000)],
    themes: { 业绩线: 3, 业绩预增: 2, 固态电池: 2, 汽车电子: 1 },
    summary: { main_theme: { name: '业绩线' } },
  });
  const c = buildCandidates(d);
  const hit = c.find((x) => x.code === '600050');
  const miss = c.find((x) => x.code === '600051');
  assert.equal(hit.mainThemeMatch, 'stem', '「业绩预增」应经词根命中主线「业绩线」');
  assert.equal(miss.mainThemeMatch, null, '无关票不得被判为主线');
});

test('主线题材：字面命中时标 exact（不因有词根兜底就把精确命中降级）', () => {
  const d = day({
    hot: [{ code: '600060', name: '精确票', close: 10, change_pct: 5, huanshou: 5, reason: '固态电池+铝塑膜' }],
    lhb: [lhbRow('600060', '精确票', 8000)],
    themes: { 固态电池: 4 },
    summary: { main_theme: { name: '固态电池' } },
  });
  assert.equal(buildCandidates(d)[0].mainThemeMatch, 'exact');
});

// ────────────────────── 五、理由与风险必须可核验 ──────────────────────

test('理由：每条都对应真实字段，且净买为负时不出现「净买」正面理由', () => {
  const r1 = reasonsOf({ netWan: 13900, isZt: true, streak: 4, themes: [], inMainTheme: false, turnoverPct: 22 });
  const texts = r1.map((x) => x.text).join('|');
  assert.ok(/龙虎榜净买 1\.39 亿/.test(texts), texts);
  assert.ok(/涨停（4 连板）/.test(texts), texts);
  assert.ok(/换手 22/.test(texts), texts);

  const r2 = reasonsOf({ netWan: -5000, isZt: false, themes: [] });
  assert.ok(!r2.some((x) => x.text.includes('龙虎榜净买')), '净卖不得生成正面理由');
});

test('理由：词根命中不得说成「属当日主线题材」（诚实边界）', () => {
  const ex = reasonsOf({ netWan: 100, themes: ['业绩预增'], inMainTheme: true, mainThemeMatch: 'exact' });
  const st = reasonsOf({ netWan: 100, themes: ['业绩预增'], inMainTheme: true, mainThemeMatch: 'stem' });
  assert.ok(ex.some((x) => x.text === '属当日主线题材'));
  assert.ok(st.some((x) => x.text.includes('词根匹配')), '词根命中必须自曝证据强度');
  assert.ok(!st.some((x) => x.text === '属当日主线题材'));
});

test('风险：无龙虎榜资金证据时必须明说证据强度弱（不能只靠涨停就当强票推）', () => {
  const weak = risksOf({ code: '600001', netWan: null, isZt: true, streak: 1 });
  assert.ok(weak.some((x) => x.includes('证据强度弱')), weak.join('|'));
  const strong = risksOf({ code: '600001', netWan: 30000, isZt: true, streak: 1 });
  assert.ok(!strong.some((x) => x.includes('证据强度弱')));
});

test('风险：高连板/高换手/涨停/20% 品种都要给出具体风险，且不空口说「注意风险」', () => {
  const r = risksOf({ code: '301190', netWan: 2500, isZt: true, streak: 3, turnoverPct: 33, changePct: 10 });
  const t = r.join('|');
  assert.ok(/3 连板高位/.test(t), t);
  assert.ok(/换手 33/.test(t), t);
  assert.ok(/已涨停/.test(t), t);
  assert.ok(/20% 涨跌幅品种/.test(t), t);
  assert.ok(!r.some((x) => x.trim() === '注意风险'), '不接受空泛的风险措辞');
});

// ────────────────────── 六、仓位建议与档位联动 ──────────────────────

test('仓位建议：禁止新建仓的档位下一律给 0（不逆着市场档位推荐建仓）', () => {
  assert.equal(suggestWeight(marketTier(90), 5), 0, '过热档不得给建仓仓位');
  assert.equal(suggestWeight(marketTier(10), 5), 0, '清仓档不得给建仓仓位');
  assert.equal(suggestWeight(null, 5), 0, '档位未知不得给仓位');
});

test('仓位建议：满仓 100% 分给 5 只，单只受 20% 上限约束', () => {
  const w = suggestWeight(marketTier(70), 5);
  assert.equal(w, 0.2);
  const w8 = suggestWeight(marketTier(70), 8);
  assert.ok(w8 <= 0.2, '单只不得超过 20% 上限');
});

test('仓位建议：半仓时分给 5 只 = 10%（总仓位 ÷ 只数）', () => {
  assert.equal(suggestWeight(marketTier(50), 5), 0.1);
});

test('仓位建议：只数为 0 时返回 0（不做除零）', () => {
  assert.equal(suggestWeight(marketTier(70), 0), 0);
});

// ────────────────────── 七、主入口端到端 ──────────────────────

const fullDay = () => day({
  hot: [
    { code: '600101', name: '强票A', close: 10, change_pct: 10, huanshou: 22, reason: '固态电池+铝塑膜' },
    { code: '600102', name: '强票B', close: 10, change_pct: 10, huanshou: 8, reason: '机器人+减速器' },
  ],
  lhb: [
    lhbRow('600101', '强票A', 60000),         // 净买 6 亿
    lhbRow('600102', '强票B', 3000),          // 净买 3000 万
    lhbRow('600103', '弱票C', 100),           // 净买很小
  ],
  themes: { 固态电池: 4, 铝塑膜: 2, 机器人: 3, 减速器: 1 },
  summary: { main_theme: { name: '固态电池' }, zt_codes: ['600101', '600102'], zt_lb: { 600101: 3, 600102: 1 } },
});

test('主入口：返回档位、评分、推荐列表与可读说明，且按上涨概率降序', () => {
  const r = recommendPicks(fullDay(), { emotionScore: 70 });
  assert.equal(r.asOf, '2026-09-30');
  assert.equal(r.tier.key, 'full');
  assert.equal(r.score, 70);
  // 候选 3 只中，600103「净买 100 万」命中「仅小额外资金且无涨停」被剔除；
  // 600101/600102 是首板且 600101 净买 6 亿 → 2 只进推荐。推荐数受**预测筛选**约束，
  // 不再是「候选数截断到 topN」——这是升级后最重要的行为变化。
  assert.equal(r.pool, 3, '候选池仍应统计全部候选');
  assert.equal(r.picks.length, 2);
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].code, '600103');
  const probs = r.picks.map((p) => p.prob.score);
  for (let i = 1; i < probs.length; i++) assert.ok(probs[i] <= probs[i - 1], '必须按上涨概率降序');
  assert.ok(r.picks[0].name === '强票A', `榜首应为双证据票，实际 ${r.picks[0].name}`);
  assert.ok(r.note.text.includes('满仓'));
});

test('主入口：清仓档位时仍列标的，但明确标注「不建议建仓」且仓位为 0', () => {
  const r = recommendPicks(fullDay(), { emotionScore: 10 });
  assert.equal(r.tier.key, 'clear');
  assert.equal(r.note.level, 'blocked');
  assert.ok(/不新建仓|不建议此时建仓/.test(r.note.text), r.note.text);
  assert.ok(r.picks.length > 0, '仍应列出观察标的');
  assert.ok(r.picks.every((p) => p.suggestWeight === 0), '清仓档不得给出建仓仓位');
});

test('主入口：无候选时给出空态说明，而不是静默返回空列表', () => {
  const r = recommendPicks(day({ lhb: [lhbRow('600001', '净卖票', -9000)] }), { emotionScore: 50 });
  assert.equal(r.picks.length, 0);
  assert.equal(r.note.level, 'empty');
  assert.ok(r.note.text.length > 10, '空态必须说明原因');
});

test('主入口：情绪分缺失时标记 unknown，且不给出仓位', () => {
  const r = recommendPicks(fullDay(), {});
  assert.equal(r.score, null);
  assert.equal(r.note.level, 'unknown');
  assert.ok(r.picks.every((p) => p.suggestWeight === 0));
});

test('主入口：候选充足时默认取 PICK_TOP_N 条，且 topN 可覆盖', () => {
  // 造 12 只净买递减的候选，验证默认截断到 5
  const many = day({
    lhb: Array.from({ length: 12 }, (_, i) => lhbRow(`6002${String(i).padStart(2, '0')}`, `票${i}`, 60000 - i * 4000)),
  });
  const rDef = recommendPicks(many, { emotionScore: 70 });
  assert.equal(rDef.pool, 12);
  assert.equal(rDef.picks.length, PICK_TOP_N, `默认应取 ${PICK_TOP_N} 条`);
  // 超出 topN 的进 overflow（不被静默丢弃）
  assert.ok(rDef.picks.length + rDef.overflow.length + rDef.rejected.length + rDef.belowThreshold.length === 12,
    '进池的票必须出现在四个桶之一');
  const r2 = recommendPicks(many, { emotionScore: 70, topN: 2 });
  assert.equal(r2.picks.length, 2);
  const r99 = recommendPicks(many, { emotionScore: 70, topN: 99 });
  // 不得超过来自预测筛选后的可用数（剔除了净买最小、不达门槛的那些）
  assert.ok(r99.picks.length <= 12, '不得超过实际候选数');
  assert.equal(r99.picks.length, r99.picks.length + r99.overflow.length, 'topN 很大时不应有 overflow');
});

test('主入口：畸形输入安全，不抛错', () => {
  assert.doesNotThrow(() => recommendPicks(null, {}));
  assert.doesNotThrow(() => recommendPicks({}, { emotionScore: 50 }));
  assert.doesNotThrow(() => recommendPicks(undefined, { emotionScore: NaN }));
  const r = recommendPicks({}, { emotionScore: 50 });
  assert.equal(r.picks.length, 0);
});

test('确定性：同一份输入连算两次结果完全一致（推荐可复现）', () => {
  const a = recommendPicks(fullDay(), { emotionScore: 70 });
  const b = recommendPicks(fullDay(), { emotionScore: 70 });
  assert.deepEqual(a.picks.map((p) => [p.code, p.score]), b.picks.map((p) => [p.code, p.score]));
});

// ────────────────────── 八、回归：既有结构不得被误改 ──────────────────────

test('推荐条数常量为 5（与 UI 文案、README 一致）', () => {
  assert.equal(PICK_TOP_N, 5);
});

test('档位表常量自洽：仓位随市场转冷而降低，过热档是「只减不新建」的特殊态', () => {
  assert.equal(POSITION_TIERS.length, 4);
  assert.deepEqual(POSITION_TIERS.map((t) => t.key), ['overheat', 'full', 'half', 'clear']);
  const by = (k) => POSITION_TIERS.find((t) => t.key === k);
  // 从最热到最冷的主链：满仓 > 半仓 > 清仓
  assert.ok(by('full').pos > by('half').pos, '满仓仓位应高于半仓');
  assert.ok(by('half').pos > by('clear').pos, '半仓仓位应高于清仓');
  assert.equal(by('clear').pos, 0, '清仓档仓位必须为 0');
  // 过热档不是「比满仓更高」，而是「只减不新建」的特殊态（仓位低于满仓且禁止新开）
  assert.equal(by('overheat').allowNew, false);
  assert.ok(by('overheat').pos < by('full').pos, '过热档应低于满仓（准备减仓）');
  assert.equal(by('full').allowNew, true);
  assert.equal(by('half').allowNew, true);
});
