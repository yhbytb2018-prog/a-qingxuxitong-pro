// 主线识别单测（2026-10-08）：聚类逐位、三条件逐项排除、强度分级边界（3/5/6/10/11）、
// 持续性（主线身份连续、断即清零）、轮动（掉出也算衰减、恰等 50% 不算）、
// prev_main_theme 多主线取最大、空输入、无有效 fund。
// 造数注：全市场均值是各板块均值的加权平均——两个板块要同时过线（avg_fund > 全市场
// 均值），必须有低 fund 陪跑票（单板块 1 只，不成主线）拉低全市场均值，故各场景都带 filler。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clusterThemes, classifyThemeStrength, identifyMainThemes, detectRotation, computeMainTheme,
  MAIN_THEME_RULES,
} from '../src/main_theme.js';

/** 造涨停池条目：默认硬板首板电池股，fund 2 亿 */
const st = (over = {}) => ({
  c: '000001', m: 0, n: 'X', p: 10000, zdp: 10, amount: 1e8,
  ltsz: 1e9, tshare: 1e9, hs: 1, lbc: 1, fbt: 92500, lbt: 92500,
  fund: 2e8, zbc: 0, hybk: '电池', zttj: { days: 1, ct: 1 }, ...over,
});

/** 陪跑票：每板块 1 只（不成主线），低 fund 拉低全市场均值 */
const filler = (n = 3, fund = 1e8) => Array.from({ length: n }, (_, i) => st({ c: `F${i}`, hybk: `陪跑${i}`, fund }));

/** 板块组：[hybk, 只数, fund]，首只造 2 连板保证 lb_count≥1 */
const grp = (hybk, n, fund) => Array.from({ length: n }, (_, i) => st({ c: `${hybk}${i}`, hybk, lbc: i === 0 ? 2 : 1, fund }));
const dayP = (groups, fillN = 3) => groups.flatMap(([h, n, f]) => grp(h, n, f)).concat(filler(fillN));

/** 基准池：电池 3 只（1 连板）fund 各 2 亿；消费电子 3 只 fund 各 1 亿；陪跑 2 只 0.5 亿 */
// 全市场均值 = (3×2 + 3×1 + 2×0.5)/8 = 1.25 亿 → 电池(2亿)过线、消费电子(1亿)不过线
const basePool = () => [
  ...grp('电池', 3, 2e8),
  ...grp('消费电子', 3, 1e8),
  ...filler(2, 0.5e8),
];

test('聚类：家数/连板/均值/成分逐位，hybk 缺失不聚类，排序 zt_count 降序并列 name 升序', () => {
  const cs = clusterThemes(basePool());
  assert.equal(cs.length, 4); // 电池、消费电子、陪跑0、陪跑1（陪跑每板块 1 只也聚组，只是不成主线）
  const [d, x] = cs; // 电池 3 = 消费电子 3 并列 → name 升序：消(U+6D88) < 电(U+7535) → 消费电子在前
  assert.equal(d.name, '消费电子');
  assert.equal(d.zt_count, 3);
  assert.equal(x.name, '电池');
  assert.equal(x.zt_count, 3);
  assert.equal(x.lb_count, 1);
  assert.equal(x.avg_fund, 2e8);
  assert.deepEqual(x.stocks, ['电池0', '电池1', '电池2']);
  assert.equal(cs[2].zt_count, 1); // 陪跑组垫底（zt_count 降序）
  assert.deepEqual(clusterThemes([]), []);
  assert.deepEqual(clusterThemes(null), []);
});

test('聚类：板块内 fund 全缺 → avg_fund=null（条件③不满足）', () => {
  const cs = clusterThemes([st({ c: '1', fund: undefined }), st({ c: '2', fund: null }), st({ c: '3', fund: undefined })]);
  assert.equal(cs[0].name, '电池');
  assert.equal(cs[0].zt_count, 3);
  assert.equal(cs[0].avg_fund, null); // null fund 被挡（+null=0 缺陷已修），不拉低均值
});

test('主线判定：基准池 → 仅电池（消费电子 1 亿 < 全市场均值 1.25 亿）', () => {
  const themes = identifyMainThemes(basePool());
  assert.equal(themes.length, 1);
  assert.equal(themes[0].name, '电池');
  assert.equal(themes[0].strength, '弱主线');
});

test('主线判定：条件①板块家数 <3 → 排除（即使 fund 高）', () => {
  const themes = identifyMainThemes(dayP([['地产', 2, 9e8]]));
  assert.deepEqual(themes, []);
});

test('主线判定：条件②连板家数 =0 → 排除', () => {
  // 3 只全首板（无 lbc≥2）→ lb_count=0
  const pool = [
    st({ c: '1', hybk: '地产', fund: 5e8 }),
    st({ c: '2', hybk: '地产', fund: 5e8 }),
    st({ c: '3', hybk: '地产', fund: 5e8 }),
    ...filler(3),
  ];
  assert.deepEqual(identifyMainThemes(pool), []);
});

test('主线判定：全池无有效 fund → 无主线（条件③不可判）', () => {
  const pool = [st({ fund: undefined }), st({ c: '2', fund: undefined }), st({ c: '3', fund: undefined })];
  assert.deepEqual(identifyMainThemes(pool), []);
});

test('强度分级边界：3/5 弱，6/10 强，11 绝对（恰等归下档）', () => {
  assert.equal(classifyThemeStrength(3), '弱主线');
  assert.equal(classifyThemeStrength(5), '弱主线');
  assert.equal(classifyThemeStrength(6), '强主线');
  assert.equal(classifyThemeStrength(10), '强主线');
  assert.equal(classifyThemeStrength(11), '绝对主线');
  assert.equal(MAIN_THEME_RULES.weak_max, 5); // 锚阈值
  assert.equal(MAIN_THEME_RULES.strong_max, 10);
});

test('主入口：首日 consecutive_days=1、is_continuous=false、prev_main_theme=null', () => {
  const { result, state } = computeMainTheme(basePool(), null, '20260930');
  assert.equal(result.date, '20260930');
  assert.equal(result.main_themes.length, 1);
  const t = result.main_themes[0];
  assert.equal(t.consecutive_days, 1);
  assert.equal(t.is_continuous, false);
  assert.equal(result.prev_main_theme, null);
  assert.equal(result.rotation, false);
  assert.equal(state.mainTheme, '电池');
  assert.equal(state.themeDays['电池'], 1);
});

test('持续性：主线身份连续 +1；第 3 天 is_continuous=true（恰 3 天触发）', () => {
  const d1 = computeMainTheme(basePool(), null, 'D1');
  const d2 = computeMainTheme(basePool(), d1.state, 'D2');
  assert.equal(d2.result.main_themes[0].consecutive_days, 2);
  assert.equal(d2.result.main_themes[0].is_continuous, false); // 2 天不足 3
  assert.equal(d2.result.prev_main_theme, '电池');
  const d3 = computeMainTheme(basePool(), d2.state, 'D3');
  assert.equal(d3.result.main_themes[0].consecutive_days, 3);
  assert.equal(d3.result.main_themes[0].is_continuous, true); // 恰 3 天
  assert.equal(MAIN_THEME_RULES.continuous_min_days, 3);
});

test('持续性：断一天清零重来（周二掉出主线，周三重回 → 1）', () => {
  const d1 = computeMainTheme(basePool(), null, '周一');
  const d2 = computeMainTheme(grp('电池', 2, 2e8), d1.state, '周二'); // 电池 2 只 → 掉出主线
  assert.equal(d2.result.main_themes.length, 0);
  const d3 = computeMainTheme(basePool(), d2.state, '周三'); // 重回主线
  assert.equal(d3.result.main_themes[0].consecutive_days, 1); // 清零重来（2026-10-08 拍板口径）
  assert.equal(d3.result.main_themes[0].is_continuous, false);
});

test('持续性：断档期间不残留计数', () => {
  const d1 = computeMainTheme(basePool(), null, 'D1');
  const d2 = computeMainTheme(grp('电池', 2, 2e8), d1.state, 'D2');
  const d3 = computeMainTheme(grp('电池', 2, 2e8), d2.state, 'D3'); // 连续两天非主线
  const d4 = computeMainTheme(basePool(), d3.state, 'D4');
  assert.equal(d4.result.main_themes[0].consecutive_days, 1);
});

// ── 轮动场景（地产 8 只 5 亿为主线；军工 6 只 4.5 亿为新晋；陪跑 3 只 1 亿）──
// 昨日均值 = (40+3)/11 ≈ 3.91 亿 → 地产过线；掉出日均值 = (10+27+3)/11 ≈ 3.64 亿 → 军工过线
test('轮动：旧主线掉出名单（8→2 只）+ 新主线出现 → rotation=true', () => {
  const d1 = computeMainTheme(dayP([['地产', 8, 5e8]]), null, 'D1');
  assert.deepEqual(d1.result.main_themes.map((t) => t.name), ['地产']);
  const d2 = computeMainTheme(dayP([['地产', 2, 5e8], ['军工', 6, 4.5e8]]), d1.state, 'D2');
  assert.deepEqual(d2.result.main_themes.map((t) => t.name), ['军工']); // 地产 2 只不成主线
  assert.equal(d2.result.rotation, true); // 掉出也算衰减（2026-10-08 拍板）
  assert.equal(d2.result.prev_main_theme, '地产');
});

test('轮动：旧主线仍在名单但缩量 >50%（8→3 只）+ 新主线 → rotation=true', () => {
  const d1 = computeMainTheme(dayP([['地产', 8, 5e8]]), null, 'D1');
  const d2 = computeMainTheme(dayP([['地产', 3, 5e8], ['军工', 6, 4.5e8]]), d1.state, 'D2');
  assert.deepEqual(d2.result.main_themes.map((t) => t.name), ['军工', '地产']); // 地产 3 只仍是主线
  assert.equal(d2.result.rotation, true); // 3 < 8×0.5=4 → 衰减
});

test('轮动边界：恰等 50%（8→4 只）不算衰减 → rotation=false', () => {
  const d1 = computeMainTheme(dayP([['地产', 8, 5e8]]), null, 'D1');
  const d2 = computeMainTheme(dayP([['地产', 4, 5e8], ['军工', 6, 4.5e8]]), d1.state, 'D2');
  assert.equal(d2.result.rotation, false); // 4 = 8×0.5，严格 < 不成立
});

test('轮动：无新主线（旧主线衰减但无新晋）→ rotation=false', () => {
  const d1 = computeMainTheme(dayP([['地产', 8, 5e8]]), null, 'D1');
  const d2 = computeMainTheme(dayP([['地产', 2, 5e8]]), d1.state, 'D2');
  assert.equal(d2.result.main_themes.length, 0);
  assert.equal(d2.result.rotation, false);
});

test('轮动：新主线出现但旧主线未衰减（8→7 只）→ rotation=false', () => {
  const d1 = computeMainTheme(dayP([['地产', 8, 5e8]]), null, 'D1');
  const d2 = computeMainTheme(dayP([['地产', 7, 5e8], ['军工', 6, 4.5e8]]), d1.state, 'D2');
  assert.equal(d2.result.rotation, false); // 地产 7 ≥ 8×0.5，未衰减
});

test('轮动：旧主线彻底消失（0 只）也算衰减', () => {
  const d1 = computeMainTheme(dayP([['地产', 8, 5e8]]), null, 'D1');
  const d2 = computeMainTheme(dayP([['军工', 6, 4.5e8]]), d1.state, 'D2');
  assert.equal(d2.result.rotation, true); // 地产今日 0 < 8×0.5
});

test('detectRotation 独立调用：faded/emerging 明细', () => {
  const r = detectRotation(
    [{ name: '地产', zt_count: 2 }, { name: '军工', zt_count: 6 }],
    [{ name: '军工', zt_count: 6 }],
    [{ name: '地产', zt_count: 8 }],
  );
  assert.deepEqual(r.faded, ['地产']);
  assert.deepEqual(r.emerging, ['军工']);
  assert.equal(r.rotation, true);
});

test('prev_main_theme：多主线取 zt_count 最大者；并列取字典序最小', () => {
  // 军工 U+519B < 地产 U+5730 → 并列时取军工
  const d1 = computeMainTheme(dayP([['地产', 6, 5e8], ['军工', 6, 4.5e8]]), null, 'D1');
  assert.equal(d1.state.mainTheme, '军工');
  const d2 = computeMainTheme(grp('电池', 2, 2e8), d1.state, 'D2');
  assert.equal(d2.result.prev_main_theme, '军工');
});

test('prev_main_theme：昨日无主线 → null', () => {
  const d1 = computeMainTheme(grp('电池', 2, 2e8), null, 'D1');
  const d2 = computeMainTheme(basePool(), d1.state, 'D2');
  assert.equal(d2.result.prev_main_theme, null);
});

test('空池 / 非法输入：空结果 + 状态安全', () => {
  const { result, state } = computeMainTheme([], null, 'D');
  assert.deepEqual(result, { date: 'D', main_themes: [], rotation: false, prev_main_theme: null });
  assert.deepEqual(state.themeDays, {});
  assert.equal(state.mainTheme, null);
  const bad = computeMainTheme(null, undefined, 'D2');
  assert.equal(bad.result.main_themes.length, 0);
});
