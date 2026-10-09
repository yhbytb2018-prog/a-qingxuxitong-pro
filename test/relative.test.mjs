// 板块相对强弱（industry_relative）守卫。
//
// 本文件把三个「不会抛错但后果严重」的错误钉死：
//   ① 把「未计算」渲染成 0 —— 0 是确定结论（与基准完全同步），null 是不知道，
//      混同就是编造数据；无行业明细的 208 天都会踩这个坑。
//   ② 排序键用绝对涨幅而非超额 —— 普跌日里"涨得最少"的才是最强，
//      按绝对涨幅排会让普跌日的进攻榜全是负数、含义混乱。
//   ③ 基准混用不标注 —— 同一个 4.63 在 vs 上证是 +4.32、vs 中位数是 +4.56，
//      说成"超额 4.6"而不说是哪个基准，就是假精确。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  computeRelative, pickBoard, relativeLine, median,
  REL_BASE, REL_BASE_LABEL, REL_SIDE, REL_SIDE_LABEL, REL_TOP_N,
} from '../src/relative.js';

// ────────────────────────── 一、中位数工具 ──────────────────────────

test('median：奇数 / 偶数 / 空 / 含非法值', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);          // 偶数取中间两数均值
  assert.equal(median([]), null);
  assert.equal(median(null), null);
  assert.equal(median([1, NaN, 3, 'x', null]), 2);  // 非法值剔除后 [1,3]
});

test('median：不被极值绑架（与均值的关键差异）', () => {
  const a = [0, 0, 0, 0, 15];
  const mean = a.reduce((x, y) => x + y, 0) / a.length;
  assert.equal(median(a), 0);       // 位次决定，极值不影响
  assert.ok(mean > 2);              // 均值被 15 拽偏——正是弃用均值的原因
});

// ────────────────────────── 二、缺数据必须返回 null（不得是 0）──────────────────────────

test('无 industry 字段 → null（不得返回 0）', () => {
  assert.equal(computeRelative({ trade_date: '2025-10-09' }), null);
  assert.equal(computeRelative({ trade_date: 'x', industry: [] }), null);
  assert.equal(computeRelative(null), null);
});

test('行业数不足 30 → null（残缺列表的中位数没有代表性）', () => {
  const ind = Array.from({ length: 29 }, (_, i) => ({ name: 'I' + i, change_pct: i / 10 }));
  assert.equal(computeRelative({ trade_date: 'x', industry: ind, indexes: { 上证指数: 0.5 } }), null);
  const ind30 = Array.from({ length: 30 }, (_, i) => ({ name: 'I' + i, change_pct: i / 10 }));
  assert.ok(computeRelative({ trade_date: 'x', industry: ind30, indexes: { 上证指数: 0.5 } }));
});

test('行业涨幅全为非法值 → null', () => {
  const ind = Array.from({ length: 40 }, (_, i) => ({ name: 'I' + i, change_pct: null }));
  assert.equal(computeRelative({ trade_date: 'x', industry: ind, indexes: { 上证指数: 0.5 } }), null);
});

// ────────────────────────── 三、双基准并存 ──────────────────────────

// 合成日：行业数须 ≥30（模块的残缺列表守卫），故把少量样本值循环铺满。
// 布局：前 5 个是"有意义的样本值"，其余为 0（不影响攻防两端，只凑数量）。
const MIN_IND = 30;
const mkDay = (pcts, idx) => {
  const vals = pcts.slice();
  while (vals.length < MIN_IND) vals.push(0);
  return {
    trade_date: '2026-01-02',
    industry: vals.map((p, i) => ({ name: 'S' + i, change_pct: p })),
    indexes: idx === undefined ? { 上证指数: 0.31 } : (idx === null ? {} : { 上证指数: idx }),
  };
};

test('双基准并存：vsIndex 与 vsMedian 都算出且基准值正确', () => {
  const day = mkDay([5, 3, 1, -1, -3]);
  const rel = computeRelative(day);
  assert.equal(rel.vsIndex.baseLabel, '上证指数');
  assert.equal(rel.vsIndex.basePct, 0.31);
  assert.equal(rel.vsMedian.baseLabel, '行业中位数');
  // 中位数须按实际铺满后的样本算（不硬编码，避免夹具扩容时断言失真）
  assert.equal(rel.vsMedian.basePct, median(day.industry.map((x) => x.change_pct)));
  assert.equal(rel.primary, REL_BASE.INDEX);
  assert.equal(rel.degraded, false);
});

test('两基准的超额差额 = 基准值之差（恒等式）', () => {
  const day = mkDay([5, 3, 1, -1, -3]);
  const rel = computeRelative(day);
  for (let i = 0; i < rel.vsIndex.attack.length; i++) {
    const a = rel.vsIndex.attack[i], b = rel.vsMedian.attack[i];
    assert.equal(a.name, b.name);  // 同序（两榜都按各自超额降序，单日下顺序一致）
    assert.ok(Math.abs((b.excess - a.excess) - (rel.vsIndex.basePct - rel.vsMedian.basePct)) < 0.02,
      `${a.name}: vsMedian-vsIndex 差额应等于基准差`);
  }
});

test('缺上证指数 → 降级为 median 主榜并留痕（不得静默当成"与大盘完全同步"）', () => {
  const rel = computeRelative(mkDay([5, 3, 1, -1, -3], null));
  assert.equal(rel.primary, REL_BASE.MEDIAN);
  assert.equal(rel.degraded, true);
  assert.ok(rel.degradedReason && rel.degradedReason.includes('上证'));
  assert.equal(rel.vsIndex, null);          // 缺基准 → 该榜为 null，不是全 0
  assert.ok(rel.vsMedian);
});

// ────────────────────────── 四、排序键必须是超额，不是绝对涨幅 ──────────────────────────

test('普跌日：进攻榜 = 跌得最少的（按超额排，不是按绝对涨幅）', () => {
  // ⚠ 本用例刻意让样本**全部覆盖铺满值**：mkDay 会把不足 30 的补 0，
  //   而 0 在普跌日里比任何负数都强，会挤占攻榜前位（这正是我第一版断言写错的原因）。
  //   故这里直接传满 30 个互不相同、全为负的值——没有铺满项，排序就是纯粹的样本序。
  const vals = Array.from({ length: 30 }, (_, i) => -(i + 1));  // −1 … −30
  const rel = computeRelative(mkDay(vals, -2));                  // 上证 −2%
  // 超额 = pct − (−2)：−1 → +1（最强）；−30 → −28（最弱）
  assert.equal(rel.vsIndex.attack[0].name, 'S0');                // −1%：跌最少
  assert.equal(rel.vsIndex.attack[0].excess, 1);
  assert.equal(rel.vsIndex.defense[0].name, 'S29');              // −30%：跌最多
  assert.equal(rel.vsIndex.defense[0].excess, -28);
  // 攻防两端都不与中位数混淆：中位数基准下 −15.5 是中位，超额同样按 −1…−30 单调
  assert.equal(rel.vsMedian.attack[0].name, 'S0');
  assert.equal(rel.vsMedian.defense[0].name, 'S29');

  // 关键反例：上证 +8% 强于所有行业 → 连"最好的行业"都是负超额（整体跑输大盘）。
  // 若误用绝对涨幅排序，榜首名字相同但会漏掉这个结论。
  const up = computeRelative(mkDay(vals, 8));
  assert.equal(up.vsIndex.attack[0].name, 'S0');                 // −1% 仍是行业里最强
  assert.equal(up.vsIndex.attack[0].excess, -9);                 // −1 − 8
  assert.ok(up.vsIndex.attack.every((r) => r.excess < 0),
    '上证强于所有行业时，进攻榜应全部为负超额（整体跑输大盘）');
  assert.ok(up.vsIndex.defense.every((r) => r.excess < 0));
});

test('attack 降序 / defense 升序（最弱排最前，便于"避雷"直接读）', () => {
  const rel = computeRelative(mkDay([5, 3, 1, -1, -3, 4, 2, 0]));
  const ex = (rows) => rows.map((r) => r.excess);
  const a = ex(rel.vsIndex.attack);
  for (let i = 1; i < a.length; i++) assert.ok(a[i - 1] >= a[i], 'attack 应降序');
  const d = ex(rel.vsIndex.defense);
  for (let i = 1; i < d.length; i++) assert.ok(d[i - 1] <= d[i], 'defense 应升序（最弱在前）');
  // 攻防两端不重叠（题量足够时）
  assert.ok(a[0] > d[0]);
});

test('榜单家数 = REL_TOP_N（行业足够多时）', () => {
  const pcts = Array.from({ length: 40 }, (_, i) => (i - 20) / 5);
  const rel = computeRelative(mkDay(pcts));
  assert.equal(rel.vsIndex.attack.length, REL_TOP_N);
  assert.equal(rel.vsIndex.defense.length, REL_TOP_N);
  assert.equal(rel.vsMedian.attack.length, REL_TOP_N);
});

test('行内含 name / change_pct / excess 三字段，且 excess = change_pct − 基准', () => {
  const day = mkDay([5, 3, 1, -1, -3]);
  const rel = computeRelative(day);
  for (const r of rel.vsIndex.attack) {
    assert.equal(typeof r.name, 'string');
    assert.equal(typeof r.change_pct, 'number');
    assert.ok(Math.abs(r.excess - (r.change_pct - rel.vsIndex.basePct)) < 0.011,
      `${r.name}: excess 应 = change_pct − basePct`);
  }
});

// ────────────────────────── 五、扩散度与规模字段 ──────────────────────────

test('upCount / total / medianPct 与原始数据一致', () => {
  const day = mkDay([5, 3, 0, -1, -3]);   // 铺满的 0 不算上涨（>0 才计）
  const rel = computeRelative(day);
  assert.equal(rel.total, day.industry.length);
  assert.equal(rel.upCount, day.industry.filter((x) => x.change_pct > 0).length);
  assert.equal(rel.medianPct, median(day.industry.map((x) => x.change_pct)));
  assert.equal(rel.topN, REL_TOP_N);
});

// ────────────────────────── 六、pickBoard / relativeLine ──────────────────────────

test('pickBoard：默认取 primary，显式传基准时按传入取', () => {
  const rel = computeRelative(mkDay([5, 3, 1, -1, -3]));
  assert.equal(pickBoard(rel), rel.vsIndex);
  assert.equal(pickBoard(rel, REL_BASE.MEDIAN), rel.vsMedian);
  assert.equal(pickBoard(rel, REL_BASE.INDEX), rel.vsIndex);
  assert.equal(pickBoard(null), null);
});

test('relativeLine：无数据时明说"未计算"，不得输出 0', () => {
  const s = relativeLine(null);
  assert.ok(s.includes('未计算'));
  assert.ok(!/\d\.\d/.test(s), '未计算时不应出现任何两位小数数字');
});

test('relativeLine：含基准名与攻防两端', () => {
  const rel = computeRelative(mkDay([5, 3, 1, -1, -3]));
  const s = relativeLine(rel);
  assert.ok(s.includes('上证指数'), '必须标注基准名');
  assert.ok(s.includes(REL_SIDE_LABEL[REL_SIDE.ATTACK]));
  assert.ok(s.includes(REL_SIDE_LABEL[REL_SIDE.DEFENSE]));
});

test('relativeLine：降级时把原因一并输出（读者需知道基准换了）', () => {
  const rel = computeRelative(mkDay([5, 3, 1, -1, -3], null));
  const s = relativeLine(rel);
  assert.ok(s.includes('行业中位数'));
  assert.ok(s.includes('⚠'));
});

// ────────────────────────── 七、标签常量唯一出处 ──────────────────────────

test('REL_BASE_LABEL / REL_SIDE_LABEL 覆盖全部枚举', () => {
  for (const k of Object.values(REL_BASE)) assert.ok(REL_BASE_LABEL[k], `缺 ${k} 的标签`);
  for (const k of Object.values(REL_SIDE)) assert.ok(REL_SIDE_LABEL[k], `缺 ${k} 的标签`);
});

// ────────────────────────── 八、真实档案端到端（引擎现生成，禁手抄）──────────────────────────

const ARC = 'data/archive.json';
const haveArc = existsSync(ARC);
const arc = haveArc ? JSON.parse(readFileSync(ARC, 'utf8')) : null;

test('真实档案：有 industry 的天数 == 有 上证指数 的天数（两源同生共死）', { skip: !haveArc }, () => {
  const withInd = arc.all_days.filter((d) => Array.isArray(d.industry) && d.industry.length).length;
  const withIdx = arc.all_days.filter((d) => d.indexes && Number.isFinite(d.indexes['上证指数'])).length;
  // 六因子回填（2026-10-02）后世界变了：208 个历史天的行业明细由同花顺年线回填，
  // 但指数快照（盘中抓取口径）无法历史重建 → industry 天数（241）≥ 指数天数（真实日）。
  // 守卫方向随之反转：指数有值的天**必须**也有行业（实时采集同生），反之行业可单独存在（回填）。
  const idxNoInd = arc.all_days.filter((d) => d.indexes && Number.isFinite(d.indexes['上证指数'])
    && !(Array.isArray(d.industry) && d.industry.length));
  assert.equal(idxNoInd.length, 0, '有指数快照却无行业明细——实时采集两源应同日成对，缺一侧说明静默失败');
  assert.ok(withInd >= withIdx, `行业天数(${withInd})不应少于指数天数(${withIdx})`);
});

test('真实档案：无 industry 的天 computeRelative 必须为 null（历史缺口已回填后应为零天）', { skip: !haveArc }, () => {
  const noInd = arc.all_days.filter((d) => !Array.isArray(d.industry) || !d.industry.length);
  // 六因子回填后 241 天全部有行业明细——「缺口天」守卫退化为「若未来再出现缺口天，其 relative 必须为 null」
  for (const d of noInd) {
    assert.equal(computeRelative(d), null, `${d.trade_date} 无行业明细却算出了相对强弱`);
  }
  assert.equal(noInd.length, 0, `六因子回填后不应再有无行业明细的天（实际 ${noInd.length}）`);
});

test('真实档案：最新交易日实算，基准与榜单自洽', { skip: !haveArc }, () => {
  const withInd = arc.all_days.filter((d) => Array.isArray(d.industry) && d.industry.length);
  const d = withInd[withInd.length - 1];
  const rel = computeRelative(d);
  assert.ok(rel, '最新一天应有行业明细');
  assert.equal(rel.vsIndex.basePct, d.indexes['上证指数']);
  assert.equal(rel.total, d.industry.length);
  assert.equal(rel.vsIndex.attack.length, REL_TOP_N);
  // 攻榜首的超额必须 ≥ 攻榜末，且 ≥ 中位数行业
  assert.ok(rel.vsIndex.attack[0].excess >= rel.vsIndex.attack[REL_TOP_N - 1].excess);
  // 真实数据下两基准都应算出（上证在同日采集中）
  assert.ok(rel.vsMedian && rel.vsIndex);
});

test('真实档案：口径可重现（同入参两次调用结果一致）', { skip: !haveArc }, () => {
  const withInd = arc.all_days.filter((d) => Array.isArray(d.industry) && d.industry.length);
  const d = withInd[withInd.length - 1];
  assert.deepEqual(computeRelative(d), computeRelative(d));
});
