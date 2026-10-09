// 双层预警引擎单测（src/alerts.js）
//
// 纪律：这里测的是「规则本身」，不是实现细节。每个用例都对应一条会被用户照着操作的建议，
// 所以断言必须写清「因为哪个字段、应该给出什么档位/动作」。边界一律取等号两侧各一例。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAlerts, marketAlerts, positionAlerts,
  MARKET_CFG, POS_CFG, LEVELS, ACTIONS,
} from '../src/alerts.js';
import { TIER_THRESHOLDS, POSITION_TIERS } from '../src/picks.js';

const T = 1_000_000;

/** 造一份 accountStats 形状的快照（只给引擎读的字段） */
const stats = (marketValue, cash = T - marketValue) => ({
  cash, freeze: 0, marketValue, total: cash + marketValue,
});

/** 造一只持仓 */
const pos = (o = {}) => ({
  code: '600519', name: '贵州茅台', qty: 100, avail: 100,
  avgCost: 100, cost: 10000, last: 100, lastDate: '2026-09-30', pxStale: false,
  ...o,
});

const find = (list, type) => list.find((a) => a.type === type);

// ────────────────────────── 一、档位边界（与 picks.marketTier 同源） ──────────────────────────

test('档位边界：情绪分取等号两侧各判一档（阈值与 V5.2 引擎同源）', async () => {
  const { marketTier } = await import('../src/picks.js');
  assert.equal(marketTier(TIER_THRESHOLDS.overheat).key, 'overheat', `≥${TIER_THRESHOLDS.overheat} 过热`);
  assert.equal(marketTier(TIER_THRESHOLDS.overheat - 0.1).key, 'full', '差一点不到 → 满仓');
  assert.equal(marketTier(TIER_THRESHOLDS.full).key, 'full', `≥${TIER_THRESHOLDS.full} 满仓`);
  assert.equal(marketTier(TIER_THRESHOLDS.full - 0.1).key, 'half', '差一点不到 → 半仓');
  assert.equal(marketTier(TIER_THRESHOLDS.half + 0.1).key, 'half', `>${TIER_THRESHOLDS.half} 半仓`);
  assert.equal(marketTier(TIER_THRESHOLDS.half).key, 'clear', `=${TIER_THRESHOLDS.half} 清仓（开区间）`);
  // 情绪分缺失不得默认任何档位（否则会凭空给出仓位建议）
  for (const bad of [null, undefined, '', NaN, 'abc', true]) {
    assert.equal(marketAlerts({ emotionScore: bad, total: T, marketValue: 0 }).find((a) => a.type === 'market-unknown')?.level, 'tip',
      `畸形的情绪分 ${JSON.stringify(bad)} 只能走「档位未知」分支`);
  }
});

test('档位未知：只说明能力边界，不给出任何仓位建议', () => {
  const out = marketAlerts({ emotionScore: null, total: T, marketValue: 300000 });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'market-unknown');
  assert.equal(out[0].action, 'watch');
  assert.ok(out[0].text.includes('不猜档'), out[0].text);
});

// ────────────────────────── 二、大盘层四条动作 ──────────────────────────

test('大盘层 · 加仓：满仓档空仓 → 机会级「加仓」', () => {
  const out = marketAlerts({ emotionScore: 70, total: T, marketValue: 0 }); // ≥65 → 满仓 100%
  const a = find(out, 'market-add');
  assert.ok(a, '应给出加仓提示');
  assert.equal(a.level, 'opp');
  assert.equal(a.action, 'add');
  assert.ok(a.text.includes('100%') && a.text.includes('低于建议 100.0%'), a.text);
  // 加仓空间 = 100 万
  assert.ok(a.text.includes('1,000,000 元'), a.text);
});

test('大盘层 · 减仓：满仓档只持 30 万 → 风险级「减仓」且给出超额金额', () => {
  const out = marketAlerts({ emotionScore: 70, total: T, marketValue: 300000 });
  const a = find(out, 'market-add');
  assert.ok(a && a.action === 'add', '满仓档 30% 属低配，应为加仓');
  const over = marketAlerts({ emotionScore: 70, total: T, marketValue: T });
  assert.ok(!find(over, 'market-trim'), '正好满仓不提示减仓');
});

test('大盘层 · 减仓：半仓档却满仓 → 风险级「减仓」，超额 50 万', () => {
  const out = marketAlerts({ emotionScore: 50, total: T, marketValue: 900000 }); // 50 分 → 半仓 50%
  const a = find(out, 'market-trim');
  assert.ok(a, '应给出减仓提示');
  assert.equal(a.level, 'risk');
  assert.equal(a.action, 'reduce');
  assert.ok(a.text.includes('超配 40.0%'), a.text);
  assert.ok(a.text.includes('400,000 元'), a.text);
});

test('大盘层 · 空仓/清仓：情绪分 ≤ 24 且有持仓 → 风险级「空仓」', () => {
  const out = marketAlerts({ emotionScore: 20, total: T, marketValue: 120000 });
  const a = find(out, 'market-exit');
  assert.ok(a, '清仓档有持仓应给空仓预警');
  assert.equal(a.level, 'risk');
  assert.equal(a.action, 'clear');
  assert.equal(a.weight, 90);
  assert.ok(a.text.includes('应清仓离场'), a.text);
  assert.ok(a.why.includes(String(TIER_THRESHOLDS.half)), a.why);
});

test('大盘层 · 清仓档已空仓：给「保持空仓」提示而不是空列表', () => {
  const out = marketAlerts({ emotionScore: 20, total: T, marketValue: 0 });
  const a = find(out, 'market-stay-flat');
  assert.ok(a, '空仓时应明确说「保持」');
  assert.equal(a.level, 'tip');
  assert.equal(a.action, 'hold');
});

test('大盘层 · 过热档（≥80）：只减不新建——低配也不给加仓', () => {
  const low = marketAlerts({ emotionScore: 88, total: T, marketValue: 100000 }); // 10% 远低于 40%
  assert.ok(!find(low, 'market-add'), '过热档不得给出加仓建议');
  const a = find(low, 'market-no-new');
  assert.ok(a, '应给出「只减仓不新建」提示');
  assert.equal(a.action, 'watch');
  assert.ok(a.text.includes('只减仓不新建'), a.text);

  const high = marketAlerts({ emotionScore: 88, total: T, marketValue: 800000 }); // 80% > 40%
  const b = find(high, 'market-trim');
  assert.ok(b && b.level === 'risk', '过热档超配应为风险级减仓');
  assert.ok(b.text.includes('400,000 元'), b.text); // 80 万 − 40 万
});

test('大盘层 · 贴合档位：差距在容忍带内不打扰用户', () => {
  // 半仓 50%，实际 55% → 差 5% 在 band 内
  const out = marketAlerts({ emotionScore: 50, total: T, marketValue: T * 0.55 });
  const a = find(out, 'market-on-target');
  assert.ok(a && a.action === 'hold', '容忍带内应只说「无需调整」');
  assert.equal(a.level, 'tip');
  // 恰好等于容忍带边界：gap = band → 不触发（用的是严格大于）
  const edge = marketAlerts({ emotionScore: 50, total: T, marketValue: T * (0.5 + MARKET_CFG.band) });
  assert.ok(find(edge, 'market-on-target'), '等于容忍带边界时视为贴合');
});

test('大盘层 · 略超但未达 minActionPos：仍按容忍带提示，不报风险级', () => {
  // 半仓档 50%，实际 57% → gap 7%：超过 band(10%) 吗？不超过 → 视为贴合。
  // 真正落在 (band, minActionPos] 之间的档只有一条路：band < gap < minActionPos，
  // 但 band(10%) > minActionPos(5%)，两者区间不相交——所以 minActionPos 的实际作用是
  // 「容忍带内不再细分」，即 gap ≤ band 时一律只说「无需调整」。这里锁住这个事实。
  const inBand = marketAlerts({ emotionScore: 50, total: T, marketValue: T * 0.57 });
  assert.ok(find(inBand, 'market-on-target'), 'gap 7% < band 10% → 仍属贴合');
  assert.ok(!find(inBand, 'market-trim'), '容忍带内不得出现减仓提示');

  // 越过容忍带但差额仍小于 minActionPos：band=10% 已 > minActionPos=5%，
  // 故 gap 恰为 5%~10% 时不会触发；gap > 10% 时 strong 必为 true。
  // 断言二者关系，避免将来有人把 band 调小到 minActionPos 以下却没意识到分级失效。
  assert.ok(MARKET_CFG.band >= MARKET_CFG.minActionPos,
    '容忍带不得小于可执行差额，否则会出现「提示但执行不了」的中间态');

  // 半仓档 65% → gap 15% > band 且 > minActionPos → 风险级
  const strong = marketAlerts({ emotionScore: 50, total: T, marketValue: T * 0.65 });
  const a = find(strong, 'market-trim');
  assert.ok(a && a.level === 'risk', 'gap 15% 应为风险级减仓');
  assert.ok(a.text.includes('应减仓至建议仓位'), a.text);
});

// ────────────────────────── 三、持仓层 ──────────────────────────

test('持仓层 · 止损线：浮亏恰好 -8% 触发（边界取等号）', () => {
  const p = pos({ avgCost: 100, last: 92, cost: 10000 });       // -8.00%
  const s = { cash: 0, freeze: 0, marketValue: 9200, total: 9200 };
  const a = find(positionAlerts({ positions: { '600519': p }, stats: s, tier: null }), 'pos-stop-loss');
  assert.ok(a, '恰好 -8% 应触发止损预警');
  assert.equal(a.level, 'risk');
  assert.equal(a.action, 'sell');
  assert.equal(a.qty, 100);
  assert.ok(a.why.includes('-8.0%'), a.why);
});

test('持仓层 · 止损线：-7.99% 不触发止损，走「接近止损」提示', () => {
  const p = pos({ avgCost: 100, last: 92.01, cost: 10000 });    // -7.99%
  const s = { cash: 0, freeze: 0, marketValue: 9201, total: 9201 };
  const list = positionAlerts({ positions: { '600519': p }, stats: s, tier: null });
  assert.ok(!find(list, 'pos-stop-loss'), '未击穿不得报止损');
  const near = find(list, 'pos-near-stop');
  assert.ok(near && near.level === 'tip', '-7.99% 已过接近线（-4.8%）');
});

test('持仓层 · 接近止损线：恰好 -4.8% 触发提示', () => {
  const p = pos({ avgCost: 100, last: 95.2, cost: 10000 });     // -4.80%
  const s = { cash: 0, freeze: 0, marketValue: 9520, total: 9520 };
  const list = positionAlerts({ positions: { '600519': p }, stats: s, tier: null });
  assert.ok(find(list, 'pos-near-stop'), '恰好等于接近线应提示');
  const p2 = pos({ avgCost: 100, last: 95.21, cost: 10000 });   // -4.79%
  const s2 = { cash: 0, freeze: 0, marketValue: 9521, total: 9521 };
  assert.ok(!find(positionAlerts({ positions: { '600519': p2 }, stats: s2, tier: null }), 'pos-near-stop'),
    '未到接近线不提示');
});

test('持仓层 · 止损与接近线互斥：击穿止损时不再叠加「接近止损」', () => {
  const p = pos({ avgCost: 100, last: 85, cost: 10000 });       // -15%
  const s = { cash: 0, freeze: 0, marketValue: 8500, total: 8500 };
  const list = positionAlerts({ positions: { '600519': p }, stats: s, tier: null });
  assert.equal(list.filter((a) => a.type === 'pos-stop-loss').length, 1);
  assert.equal(list.filter((a) => a.type === 'pos-near-stop').length, 0, '不叠加同类提示，避免刷屏');
});

test('持仓层 · 止损但无可卖（T+1）：给出卖出建议同时如实说明卖不掉', () => {
  // 成本 1 万（100 股 × 100 元），现价 90 → 浮亏 -10%，且当日买入 avail=0。
  // 这是最容易误导用户的组合：说了「应止损」却下不了单，必须同时给出 T+1 原因。
  const p = pos({ avgCost: 100, last: 90, cost: 10000, qty: 100, avail: 0 });
  const s = { cash: 0, freeze: 0, marketValue: 9000, total: 9000 };
  const list = positionAlerts({ positions: { '600519': p }, stats: s, tier: null });
  const a = find(list, 'pos-stop-loss');
  assert.ok(a, '仍应给出止损建议');
  assert.ok(a.text.includes('无可卖数量'), a.text);
  assert.equal(a.qty, 0, '无可卖时不得给出正数卖出股数（否则下单必被拒）');
  // 但「计分股数」必须是全部持仓——止损的战绩衡量的正是「本应保护多少」，
  // 若跟着 qty 一起变 0，这条最该被追责的规则就会在台账里消失（已在 alert_log 侧修掉）。
  assert.equal(a.heldQty, 100, 'heldQty 必须是全部持仓，供收益归因计分');
  assert.ok(find(list, 'pos-t1-locked'), '必须同时给出 T+1 说明（否则用户不知道为什么下不了单）');
});

test('持仓层 · 单票集中度：恰好 20% 不报，20.1% 报警并算出减仓股数', () => {
  // 总资产 10 万，一只票市值 2 万 = 20%
  const p20 = pos({ avgCost: 100, last: 200, cost: 10000, qty: 100 });
  const s20 = { cash: 80000, freeze: 0, marketValue: 20000, total: 100000 };
  assert.ok(!find(positionAlerts({ positions: { '600519': p20 }, stats: s20, tier: null }), 'pos-concentration'),
    '恰好等于上限不报（上限是「不超过」）');

  const p21 = pos({ avgCost: 100, last: 210, cost: 10000, qty: 100 });
  const s21 = { cash: 79000, freeze: 0, marketValue: 21000, total: 100000 };
  const a = find(positionAlerts({ positions: { '600519': p21 }, stats: s21, tier: null }), 'pos-concentration');
  assert.ok(a, '超过上限应报警');
  assert.equal(a.level, 'risk');
  assert.equal(a.action, 'reduce');
  // 超额 1000 元 ÷ 210 元 ≈ 4.76 股 → 向下取整到 100 股整手 = 0 → 提示可卖不足
  assert.equal(a.qty, 0, '不足一手时应为 0');
  assert.ok(a.text.includes('可卖数量不足'), a.text);
});

test('持仓层 · 单票集中度：超配足够大时算出可执行的减仓股数', () => {
  // 总资产 100 万，一只票 40 万 = 40%，上限 20% → 需减 20 万；价 100 元 → 2000 股
  // 成本 39.6 万（均价 99）→ 浮盈 +1%，远在止损线之上，确保集中度是唯一触发项。
  // 注意 avail 必须显式给全（pos() 默认 avail=100，会先把减仓股数封顶到 100）。
  const p = pos({ avgCost: 99, last: 100, cost: 396000, qty: 4000, avail: 4000 });
  const s = { cash: 600000, freeze: 0, marketValue: 400000, total: 1000000 };
  const list = positionAlerts({ positions: { '600519': p }, stats: s, tier: null });
  assert.ok(!find(list, 'pos-stop-loss'), '浮盈状态不应触发止损');
  const a = find(list, 'pos-concentration');
  assert.ok(a);
  assert.equal(a.qty, 2000);
  assert.ok(a.text.includes('减 2000 股'), a.text);
});

test('持仓层 · 单票集中度：减仓股数受可卖数量封顶（T+1 不得超卖）', () => {
  const p = pos({ avgCost: 99, last: 100, cost: 396000, qty: 4000, avail: 500 });
  const s = { cash: 600000, freeze: 0, marketValue: 400000, total: 1000000 };
  const a = find(positionAlerts({ positions: { '600519': p }, stats: s, tier: null }), 'pos-concentration');
  assert.equal(a.qty, 500, '不得超过可卖数量');
});

test('持仓层 · 止损优先于集中度：已击穿止损时只给止损动作，不并列减仓', () => {
  // 浮亏 -20% 且占 40%：两条规则都命中，但「全部卖出」已经覆盖「减至 20%」，
  // 并列会让人误以为有两个动作要做。
  const p = pos({ avgCost: 125, last: 100, cost: 500000, qty: 4000 });
  const s = { cash: 600000, freeze: 0, marketValue: 400000, total: 1000000 };
  const list = positionAlerts({ positions: { '600519': p }, stats: s, tier: null });
  assert.ok(find(list, 'pos-stop-loss'), '应给出止损');
  assert.ok(!find(list, 'pos-concentration'), '不得并列集中度减仓');
});

test('持仓层 · T+1：持仓 1000 / 可卖 0 时给出解冻说明', () => {
  const p = pos({ qty: 1000, avail: 0, last: 100, avgCost: 100, cost: 100000 });
  const s = { cash: 900000, freeze: 0, marketValue: 100000, total: 1000000 };
  const a = find(positionAlerts({ positions: { '600519': p }, stats: s, tier: null }), 'pos-t1-locked');
  assert.ok(a);
  assert.equal(a.action, 'wait');
  assert.ok(a.text.includes('1000 股中 1000 股'), a.text);
  // 全部可卖时不得出现该提示
  const p2 = pos({ qty: 1000, avail: 1000, last: 100, avgCost: 100, cost: 100000 });
  assert.ok(!find(positionAlerts({ positions: { '600519': p2 }, stats: s, tier: null }), 'pos-t1-locked'));
});

test('持仓层 · 到达单票目标仓位：档位允许新建且已达上限 80% 时提示「持有不再加」', () => {
  const tier = POSITION_TIERS.find((t) => t.key === 'full');
  const p = pos({ avgCost: 100, last: 170, cost: 10000, qty: 100 }); // 1.7 万 / 10 万 = 17%
  const s = { cash: 83000, freeze: 0, marketValue: 17000, total: 100000 };
  const a = find(positionAlerts({ positions: { '600519': p }, stats: s, tier }), 'pos-at-target');
  assert.ok(a, '17% ≥ 16%（20%×0.8）应提示');
  assert.equal(a.action, 'hold');
  // 档位不允许新建时不该出现（清仓档本来就要清）
  const clear = POSITION_TIERS.find((t) => t.key === 'clear');
  assert.ok(!find(positionAlerts({ positions: { '600519': p }, stats: s, tier: clear }), 'pos-at-target'));
});

test('持仓层 · 推荐池：不在池内只作信息提示，且不构成卖出建议', () => {
  const p = pos({ code: '000001', name: '平安银行' });
  const s = { cash: 990000, freeze: 0, marketValue: 10000, total: 1000000 };
  const a = find(positionAlerts({ positions: { '000001': p }, stats: s, tier: null, pickCodes: ['600519', '000858'] }), 'pos-not-in-picks');
  assert.ok(a);
  assert.equal(a.action, 'watch', '绝不能是 sell');
  assert.ok(a.why.includes('不构成卖出依据'), a.why);
  // 空推荐池 = 无结论，不得提示「不在池内」
  assert.ok(!find(positionAlerts({ positions: { '000001': p }, stats: s, tier: null, pickCodes: [] }), 'pos-not-in-picks'));
});

test('持仓层 · 停牌/无价：说明估值失真，不谎称有盈亏', () => {
  // 停牌场景：last 保留最近成交价 150（浮盈 +50%，不触发止损），pxStale=true 表示它不是当日价
  const p = pos({ last: 150, pxStale: true, avgCost: 100, cost: 10000, qty: 100 });
  const s = { cash: 985000, freeze: 0, marketValue: 15000, total: 1000000 };
  const a = find(positionAlerts({ positions: { '600519': p }, stats: s, tier: null }), 'pos-stale-px');
  assert.ok(a, 'pxStale 应给出失真提示');
  assert.ok(a.text.includes('失真'), a.text);
  assert.ok(a.quote['最新价'].includes('无当日行情'), a.quote['最新价']);

  // 完全取不到价（last=null）：市值退化为成本 → 浮亏为 0，不得因此误报止损
  const p2 = pos({ last: null, pxStale: true, avgCost: 100, cost: 10000, qty: 100 });
  const s2 = { cash: 990000, freeze: 0, marketValue: 10000, total: 1000000 };
  const l2 = positionAlerts({ positions: { '600519': p2 }, stats: s2, tier: null });
  assert.ok(find(l2, 'pos-stale-px'), '无价应提示失真');
  assert.ok(!find(l2, 'pos-stop-loss'), '按成本估值时浮亏为 0，不得凭空报止损');
});

// ────────────────────────── 四、汇总与排序 ──────────────────────────

test('汇总 · 严重度排序：风险 > 机会 > 提示；同级按权重降序', () => {
  const positions = {
    // 击穿止损 → risk, weight 100（成本 10 万 / 现价 85 → -15%）
    '600000': pos({ code: '600000', name: '浦发银行', avgCost: 100, last: 85, cost: 100000, qty: 1000 }),
    // 集中度超限 → risk, weight 75（占 40%）
    '600519': pos({ code: '600519', name: '贵州茅台', avgCost: 125, last: 100, cost: 500000, qty: 4000 }),
  };
  // 市值：8.5 万 + 40 万 = 48.5 万；总资产 100 万
  const marketValue = 85000 + 400000;
  const st = { cash: 1000000 - marketValue, freeze: 0, marketValue, total: 1000000 };
  const r = buildAlerts({ emotionScore: 70, account: { positions }, stats: st, asOf: '2026-09-30' });
  const lv = r.alerts.map((a) => LEVELS.indexOf(a.level));
  for (let i = 1; i < lv.length; i++) assert.ok(lv[i] >= lv[i - 1], `第 ${i} 条严重度不得轻于前一条`);
  const risks = r.alerts.filter((a) => a.level === 'risk');
  assert.ok(risks.length >= 2, `应有至少 2 条风险级，实际 ${risks.length}`);
  assert.equal(risks[0].weight, 100, '止损（100）应排在集中度（75）之前');
  assert.equal(r.counts.risk, risks.length);
});

test('汇总 · 每条预警都有可核验依据（why/quote 非空）与合法动作', () => {
  const positions = {
    // 止损（-9%）：成本 1 万、市值 9100
    '600000': pos({ code: '600000', avgCost: 100, last: 91, cost: 10000 }),
    // 集中度（占 40%）：成本 50 万、市值 40 万
    '000001': pos({ code: '000001', name: '平安银行', avgCost: 125, last: 100, cost: 500000, qty: 4000 }),
  };
  const mv = 9100 + 400000;
  const st = { cash: 1000000 - mv, freeze: 0, marketValue: mv, total: 1000000 };
  const r = buildAlerts({ emotionScore: 50, account: { positions }, stats: st, pickCodes: ['600519'] });
  assert.ok(r.alerts.length >= 3, `至少 止损 + 集中度 + 不在推荐池 三条，实际 ${r.alerts.length}`);
  for (const a of r.alerts) {
    assert.ok(a.text && a.text.length > 8, `缺 text：${JSON.stringify(a)}`);
    assert.ok(a.why && a.why.length > 8, `缺 why（无法核验）：${a.text}`);
    assert.ok(a.quote && Object.keys(a.quote).length >= 3, `缺 quote：${a.text}`);
    assert.ok(ACTIONS[a.action], `非法动作 ${a.action}`);
    assert.ok(LEVELS.includes(a.level), `非法级别 ${a.level}`);
  }
});

test('汇总 · 空账户只给大盘层结论，不产生持仓层噪声', () => {
  const st = { cash: T, freeze: 0, marketValue: 0, total: T };
  const r = buildAlerts({ emotionScore: 70, account: { positions: {} }, stats: st });
  assert.ok(r.alerts.length >= 1);
  assert.ok(r.alerts.every((a) => a.layer === 'market'), '无持仓时不应有持仓层预警');
  assert.equal(r.counts.risk, 0);
});

test('汇总 · 截断：limit 生效且 total 保留真实条数', () => {
  const positions = {};
  for (let i = 0; i < 8; i++) {
    positions['60000' + i] = pos({ code: '60000' + i, name: 'X' + i, avgCost: 100, last: 90, cost: 10000 });
  }
  const mv = 9000 * 8;
  const st = { cash: T - mv, freeze: 0, marketValue: mv, total: T };
  const r = buildAlerts({ emotionScore: 70, account: { positions }, stats: st, limit: 3 });
  assert.equal(r.alerts.length, 3);
  assert.equal(r.truncated, true);
  assert.ok(r.total > 3);
});

test('汇总 · 确定性：同样输入两次调用结果完全一致（含顺序）', () => {
  const positions = {
    '600000': pos({ code: '600000', avgCost: 100, last: 91, cost: 10000 }),
    '000001': pos({ code: '000001', name: '平安银行', avgCost: 125, last: 100, cost: 500000, qty: 4000 }),
  };
  const mv = 9100 + 400000;
  const st = { cash: T - mv, freeze: 0, marketValue: mv, total: T };
  const args = { emotionScore: 50, account: { positions }, stats: st, pickCodes: ['600519'], asOf: '2026-09-30' };
  const a = JSON.stringify(buildAlerts({ ...args, account: { positions: { ...positions } } }));
  const b = JSON.stringify(buildAlerts({ ...args, account: { positions: { ...positions } } }));
  assert.equal(a, b);
});

test('汇总 · 畸形输入不抛错：缺账户/缺 stats/缺 positions 一律降级', () => {
  const cases = [
    {},
    { emotionScore: 50 },
    { emotionScore: 50, account: null, stats: null },
    { emotionScore: 50, account: {}, stats: null },
    { emotionScore: 50, account: { positions: null }, stats: { total: 0, marketValue: 0 } },
    { emotionScore: 50, account: { positions: { '600519': { qty: 0 } } }, stats: { total: T, marketValue: 0 } },
    { emotionScore: NaN, account: { positions: { '600519': { qty: 100, avgCost: 'x', last: 'y' } } }, stats: { total: T, marketValue: 0 } },
  ];
  for (const [i, c] of cases.entries()) {
    let r;
    assert.doesNotThrow(() => { r = buildAlerts(c); }, `用例 ${i} 抛错`);
    assert.ok(Array.isArray(r.alerts), `用例 ${i} 未返回列表`);
  }
});

test('汇总 · 账户统计缺省兜底：不传 stats 时用 positions 现算，口径与 accountStats 一致', () => {
  const positions = {
    '600519': pos({ avgCost: 100, last: 100, cost: 10000, qty: 100 }),
    '000001': pos({ code: '000001', name: '平安银行', avgCost: 10, last: null, cost: 10000, qty: 1000, pxStale: true }),
  };
  // 有价按价（10000）、无价按成本（10000） → 市值 20000
  const r = buildAlerts({ emotionScore: 70, account: { positions, cash: 980000 } });
  assert.equal(r.alerts.find((a) => a.type === 'market-add').quote['持仓市值'], '20,000 元');
  assert.equal(r.alerts.find((a) => a.type === 'market-add').quote['总资产'], '1,000,000 元');
});

test('常量 · 阈值与上游同源，不允许各自一套', async () => {
  const cfg = (await import('../src/config.js')).default;
  assert.equal(POS_CFG.stopLoss, cfg.backtest.stopLoss, '止损线必须取自 config.backtest.stopLoss');
  assert.equal(POS_CFG.ddTrigger, cfg.backtest.ddTrigger, '回撤线必须取自 config.backtest.ddTrigger');
  const picks = await import('../src/picks.js');
  assert.equal(POS_CFG.concMax, 0.20, '单票上限与 picks.suggestWeight 的 perStockCap 一致');
  assert.equal(picks.suggestWeight(POSITION_TIERS[1], 5), 0.20, 'suggestWeight 单票上限也应是 20%');
  assert.equal(MARKET_CFG.band, 0.10);
});
