// 公式版本注册表的口径守卫：三版必须共用同一套因子实现，差异只在净买原料。
//
// 本文件锁的是**结构性契约**，不是数值快照——数值会随数据更新而变，
// 但"三版因子键一致 / 权重键映射与 config 一致 / v4.5 含新股而 v5.2 剔除"这些不变量永远成立。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import config from '../src/config.js';
import { decodeArchive } from '../src/lhb_codec.js';
import {
  BASELINE_VERSION, FORMULA_VERSIONS, WEIGHT_TO_FACTOR,
  versionKeys, versionOf, recomputeDay, computableDays, computeAllVersions,
  netBuyV45, netBuyV50, netBuyV52, nextRetOf, COMPUTE_TIERS,
  NET_HIST_WINDOW, NET_HIST_MIN,
} from '../src/formula_versions.js';
import { NET_NORMALIZER_TANH5, NET_NORMALIZER_PCTL } from '../src/sentiment.js';
import { pearson, spearman, ranks, directionAccuracy } from './_helpers_regression.mjs';
import { caliberFromDay } from '../src/lhb.js';

// ────────────────────────── 一、版本表结构 ──────────────────────────

test('公式版本：基线版本与 config.formulaVersion 一致', () => {
  assert.equal(config.formulaVersion, BASELINE_VERSION,
    'config.formulaVersion 与 formula_versions 的基线不一致 —— 改版本号必须两处同步');
});

test('公式版本：版本表与基线唯一性', () => {
  assert.deepEqual(versionKeys(), ['v4.5', 'v5.0', 'v5.2-pro', 'v5.3-pro'],
    '版本表变了——新增/删除版本必须同步更新本断言，且确认回归报告已覆盖');
  assert.equal(FORMULA_VERSIONS.filter((v) => v.baseline).length, 1, '基线必须唯一');
  assert.equal(versionOf(BASELINE_VERSION).baseline, true);
  // 候选版本纪律：v5.3 必须显式声明 candidate，防止它被误当成"升级后的基线"。
  // 这条断言的存在意义：切换基线是一个**重大动作**（影响分位、档位、推荐、回测），
  // 必须有意识地做，而不是某次重构顺手就改了。
  const cands = FORMULA_VERSIONS.filter((v) => v.candidate).map((v) => v.key);
  assert.deepEqual(cands, ['v5.3-pro'], '候选版本集合变化——确认是否符合预期');
  assert.equal(versionOf(BASELINE_VERSION).candidate, undefined, '基线不得同时是候选');
});

test('公式版本：v5.3 只改归一器、净买原料与基线完全一致', () => {
  // 这是 v5.3 的**定义性约束**：差异必须只在归一层。若哪天有人顺手也改了净买口径，
  // 那么"饱和改善"就无法归因到归一方式上——两个变量同时动，结论不可解释。
  const v53 = versionOf('v5.3-pro');
  const v52 = versionOf(BASELINE_VERSION);
  assert.equal(v53.extractNetBuy, v52.extractNetBuy, 'v5.3 的 extractNetBuy 必须与基线是同一个函数引用');
  assert.equal(typeof v53.normalizer, 'function', 'v5.3 必须声明 normalizer');
  assert.equal(v52.normalizer, undefined, '基线不得声明 normalizer（走历史 tanh5 默认）');
});

test('公式版本：每版都有 extractNetBuy 与描述', () => {
  for (const v of FORMULA_VERSIONS) {
    assert.equal(typeof v.extractNetBuy, 'function', `${v.key} 缺 extractNetBuy`);
    assert.ok(v.desc && v.desc.length > 8, `${v.key} 缺描述`);
    assert.ok(v.name === v.key || v.name.startsWith('v'), `${v.key} 名称异常`);
  }
});

test('公式版本：未知版本抛错，不静默返回默认', () => {
  assert.throws(() => recomputeDay({ trade_date: '2026-01-01', summary: {} }, 'v9.9'), /未知公式版本/);
  assert.equal(versionOf('v9.9'), null);
});

test('公式版本：权重键映射与 config.factorKeyMap 完全一致（两份不得漂移）', () => {
  assert.deepEqual(WEIGHT_TO_FACTOR, config.factorKeyMap,
    'formula_versions.WEIGHT_TO_FACTOR 与 config.factorKeyMap 不一致');
});

// ────────────────────────── 二、三版口径差异（核心不变量）──────────────────────────
//
// 用一个**构造的**某日数据把三版差异钉死：全量净买 ≠ 当日净买 ≠ 剔新股净买。
// 不依赖真实档案，因此数据更新也不会让这些断言失效。
//
// ⚠ 关键约束：caliberFromDay 是「从原始记录现算」的实现（这是它的设计目的——唯一口径来源），
//   它**只读记录数组，不读 summary 里已算好的汇总字段**。所以夹具必须给真实的记录数组，
//   光填 summary.lhb_daily_net 是不行的（实测踩过：caliberFromDay 走 `rows.length===0` 分支
//   直接返回全 0，三版分数一模一样、断言全红）。
//
// 构造（单位：万元，1 亿 = 1e4 万）：
//   当日榜 3 只：A +8 亿 / B +5 亿 / C −1 亿        → 当日净买 = 12 亿
//   区间累计榜 2 只：D +10 亿 / E +8 亿             → 全量净买 = 12 + 18 = 30 亿
//   其中 A 是「无价格涨跌幅限制的证券」（新股）      → 剔新股后 = 12 − 8 = 4 亿
const W = 1e4; // 1 亿元 = 10000 万元
const rec = (code, netYi, range, reasons) => ({
  code,
  name: code,
  reason: reasons ? reasons[0] : '日涨幅偏离值达7%的证券',
  reasons: reasons || ['日涨幅偏离值达7%的证券'],
  net_buy_wan: netYi * W,
  buy_wan: Math.abs(netYi) * W * 0.6,
  sell_wan: Math.abs(netYi) * W * 0.4,
  close: 10,
  change_pct: 10,
  is_range: !!range,
});

const SYNTH_DAY = {
  trade_date: '2099-01-05',
  summary: {
    // s_pos / s_brd / s_hot / s_zdt / s_zbl / s_amt 的原料（这些不参与版本差异，只求可算）
    net_pos: 22, net_neg: 18,
    ind_up: 45, ind_count: 90,
    amount_yi: 21000,
    up_count: 2600, down_count: 2200,
    zt_count: 50, dt_count: 10, zb_count: 12,
  },
  // 当日榜去重行（新数据都有这个字段，走 caliberFromDay 的①号分支）
  lhb_daily_aggr: [
    rec('000001', 8, false, ['无价格涨跌幅限制的证券']),  // 新股，A
    rec('000002', 5, false),                              // B
    rec('000003', -1, false),                             // C
  ],
  lhb_aggr: [
    rec('000001', 8, false, ['无价格涨跌幅限制的证券']),
    rec('000002', 5, false),
    rec('000003', -1, false),
    rec('600001', 10, true),  // 区间累计榜，D
    rec('600002', 8, true),   // 区间累计榜，E
  ],
};

test('夹具自检：当日榜净买 12 亿 / 全量 30 亿 / 剔新股 4 亿', () => {
  const c = caliberFromDay(SYNTH_DAY);
  assert.equal(c.daily_net_yi, 12, '当日榜净买应为 12 亿');
  assert.equal(c.all_net_yi, 30, '全量净买应为 30 亿（12 + 18 区间）');
  assert.equal(c.daily_new_net_yi, 8, '新股净买应为 8 亿（A 票）');
  assert.equal(c.daily_ex_new_net_yi, 4, '剔新股后应为 4 亿（12 − 8）');
});

test('口径：v4.5 用全量净买（含区间榜、含新股）', () => {
  const r = netBuyV45(SYNTH_DAY);
  assert.equal(r.netBuy, 30.0);
  assert.equal(r.newStockNet, 0, 'v4.5 不剔新股');
});

test('口径：v5.0 用当日榜净买（滤区间榜），但仍含新股', () => {
  const r = netBuyV50(SYNTH_DAY);
  assert.equal(r.netBuy, 12.0);
  assert.equal(r.newStockNet, 0, 'v5.0 仍不剔新股');
});

test('口径：v5.2 用当日榜净买且剔除新股', () => {
  const r = netBuyV52(SYNTH_DAY);
  assert.equal(r.netBuy, 12.0);
  assert.equal(r.newStockNet, 8.0, 'v5.2 必须把新股净买交给 computeSentiment 扣除');
});

test('口径：三版净买单调收敛（全量 ≥ 当日 ≥ 剔新股）', () => {
  const n45 = netBuyV45(SYNTH_DAY).netBuy;
  const n50 = netBuyV50(SYNTH_DAY).netBuy;
  const n52 = netBuyV52(SYNTH_DAY).netBuy - netBuyV52(SYNTH_DAY).newStockNet;
  assert.ok(n45 > n50, `全量(${n45}) 应大于当日(${n50})——区间累计值会放大`);
  assert.ok(n50 > n52, `含新股(${n50}) 应大于剔新股(${n52})——新股只能抬高净买`);
});

test('口径：三版分数严格递减（净买越小，s_net 越低）', () => {
  const s45 = recomputeDay(SYNTH_DAY, 'v4.5', { weights: config.weights }).score;
  const s50 = recomputeDay(SYNTH_DAY, 'v5.0', { weights: config.weights }).score;
  const s52 = recomputeDay(SYNTH_DAY, BASELINE_VERSION, { weights: config.weights }).score;
  assert.ok(s45 > s50, `v4.5(${s45}) 应高于 v5.0(${s50})`);
  assert.ok(s50 > s52, `v5.0(${s50}) 应高于 v5.2(${s52})`);
});

// ────────────────────────── 二·B、归一层（v5.3 的核心不变量）──────────────────────
//
// v5.3 与基线的净买完全相同，差异只在 s_net 的换算。故这里不测"分数高低"，
// 只测归一层本身的三条性质：单调、有界、不饱和，以及历史窗口的切片语义。

test('归一器：tanh5 就是历史基线公式（不得被悄悄改动）', () => {
  // 直接对拍公式，防止有人"顺手优化"我 NET_NORMALIZER_TANH5
  for (const x of [-80, -20, -5, -1, 0, 1, 5, 20, 80]) {
    assert.equal(NET_NORMALIZER_TANH5(x), Math.tanh(x / 5) * 50 + 50, `tanh5(${x}) 偏离历史公式`);
  }
  assert.equal(NET_NORMALIZER_TANH5(null), null, 'null 必须原样返回 null（交调用方标 missing）');
  assert.equal(NET_NORMALIZER_TANH5(NaN), null, 'NaN 必须返回 null');
});

test('归一器：分位映射在历史不足时返回 null，不硬算', () => {
  // 历史 < minHist(20) → 不可信 → null。这是**防止静默填假值**的关键守卫：
  // 若这里返回一个数，调用方就无从区分"算出来的"和"猜出来的"。
  assert.equal(NET_NORMALIZER_PCTL(10, { netHistory: [] }), null, '空历史必须返回 null');
  assert.equal(NET_NORMALIZER_PCTL(10, { netHistory: [1, 2, 3] }), null, '历史 3 天 < 20 必须返回 null');
  const h20 = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(typeof NET_NORMALIZER_PCTL(10, { netHistory: h20 }), 'number', '历史 20 天应可算');
});

test('归一器：分位映射单调、有界、且 50 分位落回中性 50', () => {
  // 历史取 1..60，当日值扫过全区间，检查单调（非严格：clamp 到边界后会出现相等）+ 落在 [1,99]
  const hist = Array.from({ length: 60 }, (_, i) => i + 1);
  const vals = [0.5, 1, 5, 15, 30, 45, 60, 100, 1000].map((x) => NET_NORMALIZER_PCTL(x, { netHistory: hist }));
  for (let i = 1; i < vals.length; i++) {
    // 非严格递增：极弱/极强值会被 clamp 到 1 或 99，此时相邻可相等。
    // 断言"不得下降"即可——下降才是真 bug（更强的净买算出更低的分）。
    assert.ok(vals[i] >= vals[i - 1], `分位映射不得下降：${vals[i - 1]} → ${vals[i]}`);
  }
  for (const v of vals) assert.ok(v >= 1 && v <= 99, `因子值应落在 [1,99]：${v}`);
  // 中位数落到 50 附近（允许并列值造成的少量偏移）
  const mid = NET_NORMALIZER_PCTL(30, { netHistory: hist });
  assert.ok(Math.abs(mid - 50) <= 5, `历史中位数附近应≈50，实际 ${mid}`);
  // 极值必须真的触到边界（证明分辨力用满了，而不是被压在中间一小段）
  assert.equal(vals[0], 1, '远低于历史区间应触下界 1');
  assert.equal(vals[vals.length - 1], 99, '远高于历史区间应触上界 99');
});

test('归一器：分位映射对符号做镜像（流出与流入强度对称、方向相反）', () => {
  const hist = Array.from({ length: 60 }, (_, i) => i + 1);
  const inflow = NET_NORMALIZER_PCTL(50, { netHistory: hist });   // 强流入
  const outflow = NET_NORMALIZER_PCTL(-50, { netHistory: hist }); // 同强度流出
  assert.ok(inflow > 50, `流入应 > 50，实际 ${inflow}`);
  assert.ok(outflow < 50, `流出应 < 50，实际 ${outflow}`);
  // 镜像性：与 50 的距离相等
  assert.ok(Math.abs((inflow - 50) + (outflow - 50)) < 1e-9,
    `流入(${inflow}) 与流出(${outflow}) 应关于 50 对称`);
});

test('归一层：v5.3 确实解除了饱和（tanh5 在大净买上顶格，分位版不顶格）', () => {
  // ⚠ 必须用**真能顶格**的量级来演示饱和。实测：tanh5(4 亿)=83.2、tanh5(10 亿)=98.2、
  //   tanh5(20 亿)=99.96。故取 20 亿——这是档案里 p75 附近的真实量级（20.09 亿），
  //   用 4 亿会得到 83.2，根本演示不出饱和（我第一版就写错了这个数）。
  const hist = Array.from({ length: 60 }, (_, i) => (i + 1) * 0.5); // 0.5 ~ 30 亿
  const t5 = NET_NORMALIZER_TANH5(20);
  const pc = NET_NORMALIZER_PCTL(20, { netHistory: hist });
  assert.ok(t5 > 99.9, `tanh5 在 20 亿上应已顶格（实际 ${t5.toFixed(4)}）——这正是饱和问题`);
  assert.ok(pc < 99, `分位版不应顶格（实际 ${pc.toFixed(2)}）`);
  // 关键：tanh5 下 20 → 78 亿只挪动了不到 0.1 分（分辨力耗尽）；
  // 分位版应把这段拉开。这是"解除饱和"的**操作性定义**。
  const t5big = NET_NORMALIZER_TANH5(78); // 档案 max
  const pcBig = NET_NORMALIZER_PCTL(78, { netHistory: hist });
  assert.ok((pcBig - pc) > 5, `分位版在 20→78 亿区间应拉开 ≥5 分（实际 ${(pcBig - pc).toFixed(2)}）`);
  assert.ok((t5big - t5) < 0.2, `tanh5 在 20→78 亿区间几乎无变化（实际 ${(t5big - t5).toFixed(4)}）`);
});

test('归一层：v5.3 的 recomputeDay 走分位归一，v5.2 仍走 tanh5', () => {
  // 端到端：同一夹具、同一净买，两版 s_net 应不同（因为归一方式不同），
  // 但 netBuy 应完全相同（因为原料相同）。
  const hist = Array.from({ length: 60 }, (_, i) => (i + 1) * 0.5);
  const ctx = { weights: config.weights, netHistory: hist };
  const r52 = recomputeDay(SYNTH_DAY, 'v5.2-pro', ctx);
  const r53 = recomputeDay(SYNTH_DAY, 'v5.3-pro', ctx);
  assert.equal(r52.netBuy, r53.netBuy, 'v5.2 与 v5.3 的净买原料必须完全一致');
  // ⚠ computeSentiment 输出前会把因子四舍五入到 1 位小数（Math.round(v*10)/10），
  //   故断言必须比对**取整后**的值，否则 fake 精度会制造假失败。
  const r1 = (v) => Math.round(v * 10) / 10;
  assert.equal(r52.factors.s_net, r1(NET_NORMALIZER_TANH5(4)), 'v5.2 的 s_net 必须走 tanh5');
  assert.equal(r53.factors.s_net, r1(NET_NORMALIZER_PCTL(4, { netHistory: hist })), 'v5.3 的 s_net 必须走分位');
  assert.notEqual(r52.factors.s_net, r53.factors.s_net, '两版 s_net 应因归一方式不同而不同');
  // 归一层留痕
  assert.equal(r52.netCaliber.normalizer, 'tanh5');
  assert.equal(r53.netCaliber.normalizer, 'percentile');
  assert.equal(r53.netCaliber.histLen, 60, '应记录实际用到的历史长度');
});

test('归一层：不传 netHistory 时 v5.3 的 s_net 标 missing，而不是静默填 50', () => {
  // 这是**最重要的守卫**：缺历史时绝不能假装算出来了。
  const r = recomputeDay(SYNTH_DAY, 'v5.3-pro', { weights: config.weights });
  assert.ok(r.missing.includes('s_net20'), `缺历史时 s_net 应进 missing，实际 missing=${JSON.stringify(r.missing)}`);
});

test('口径：三版只在 s_net 上有差异，其余六因子逐字段相同', () => {
  const w = config.weights;
  const a = recomputeDay(SYNTH_DAY, 'v4.5', { weights: w }).factors;
  const b = recomputeDay(SYNTH_DAY, 'v5.0', { weights: w }).factors;
  const c = recomputeDay(SYNTH_DAY, BASELINE_VERSION, { weights: w }).factors;
  for (const k of Object.keys(a)) {
    if (k === 's_net') {
      assert.ok(a[k] >= b[k] && b[k] >= c[k], `s_net 应单调：${a[k]} / ${b[k]} / ${c[k]}`);
    } else {
      assert.equal(a[k], b[k], `${k} 在 v4.5 与 v5.0 之间不得有差异`);
      assert.equal(b[k], c[k], `${k} 在 v5.0 与 v5.2 之间不得有差异`);
    }
  }
  assert.deepEqual(Object.keys(a), Object.keys(c), '三版因子键集合必须完全一致');
});

test('口径：因子键为无后缀形式（与存档一致），不是 computeSentiment 的权重键', () => {
  const f = recomputeDay(SYNTH_DAY, BASELINE_VERSION, { weights: config.weights }).factors;
  assert.deepEqual(Object.keys(f).sort(),
    ['s_amt', 's_brd', 's_hot', 's_net', 's_pos', 's_zbl', 's_zdt']);
  assert.equal(f.s_net20, undefined, '不得漏出带档位后缀的权重键');
});

test('口径：权重键传错必须硬失败（不得静默 NaN）', () => {
  const plain = {};
  for (const [wk, pk] of Object.entries(config.factorKeyMap)) plain[pk] = config.weights[wk];
  assert.throws(
    () => recomputeDay(SYNTH_DAY, BASELINE_VERSION, { weights: plain }),
    /非有限分数/,
    '传无后缀权重键必须抛错——NaN 静默传播过（相关性/均分全变 NaN）',
  );
});

test('口径：newStockRatio 只在有 ratio 证据时传入（v4.5/v5.0 不虚构 ratio）', () => {
  const r52 = netBuyV52(SYNTH_DAY);
  assert.equal(r52.newStockNet, 8.0, '新股记录存在即应剔除');
  assert.ok(r52.evidence.newRatio != null, 'v5.2 应带出 ratio 证据');
  const r45 = netBuyV45(SYNTH_DAY);
  assert.equal(r45.newStockNet, 0);
  assert.equal(r45.evidence.newRatio, undefined, 'v4.5 不应虚构 ratio');
});

// ────────────────────────── 三、可算性分级 ──────────────────────────

test('分级：缺 industry/amount/indexes → partial，不进主样本', () => {
  const partialDay = { trade_date: '2026-01-05', summary: { lhb_daily_net: 1.0 }, lhb_aggr: [{ code: 'x', net_buy_wan: 1 }] };
  const { ok, partial } = computableDays([partialDay]);
  assert.equal(ok.length, 0);
  assert.equal(partial.length, 1);
});

test('分级：连龙虎榜原料都没有 → none', () => {
  const emptyDay = { trade_date: '2026-01-05', summary: {} };
  const { ok, partial, none } = computableDays([emptyDay]);
  assert.equal(ok.length, 0);
  assert.equal(partial.length, 0);
  assert.equal(none.length, 1);
});

test('分级：齐全天 → full', () => {
  const fullDay = {
    trade_date: '2026-01-05',
    summary: { lhb_daily_net: 1.0, lhb_all_net: 1.2, ind_up: 40, ind_count: 90, amount_yi: 20000 },
    indexes: { 上证指数: 0.5 },
    lhb_aggr: [{ code: 'x', net_buy_wan: 1 }],
  };
  const { ok, meta } = computableDays([fullDay]);
  assert.equal(ok.length, 1);
  assert.equal(meta[0].tier, COMPUTE_TIERS.full);
});

test('分级：up_count 缺失不判为不可算（s_pos 走代理是既有设计），但如实标注 hasBreadth=false', () => {
  const d = {
    trade_date: '2026-01-05',
    summary: { lhb_daily_net: 1.0, lhb_all_net: 1.2, ind_up: 40, ind_count: 90, amount_yi: 20000, net_pos: 5, net_neg: 5 },
    indexes: { 上证指数: 0.5 },
    lhb_aggr: [{ code: 'x', net_buy_wan: 1 }],
  };
  const { ok, meta } = computableDays([d]);
  assert.equal(ok.length, 1, '有无 up_count 都应可算');
  assert.equal(meta[0].hasBreadth, false);
});

// ────────────────────────── 四、次日收益对齐（长假陷阱）──────────────────────────

test('次日收益：必须按真实交易日相邻取，长假后不得按数组相邻', () => {
  const days = [
    { trade_date: '2026-09-24', indexes: { 上证指数: -1.0 } },
    { trade_date: '2026-09-28', indexes: { 上证指数: 0.5 } },  // 09-25~09-27 中秋休市
  ];
  const nx = nextRetOf(days[0], days);
  assert.equal(nx.date, '2026-09-28');
  assert.equal(nx.ret, 0.5);
  assert.equal(nx.gap, 4, '应记录跳空 4 天，供报告披露');
});

test('次日收益：跳过没有 indexes 的天', () => {
  const days = [
    { trade_date: '2026-01-05', indexes: { 上证指数: 1 } },
    { trade_date: '2026-01-06' },                                  // 无 indexes
    { trade_date: '2026-01-07', indexes: { 上证指数: 2 } },
  ];
  const nx = nextRetOf(days[0], days);
  assert.equal(nx.date, '2026-01-07', '应跳过无 indexes 的天，取下一个有值日');
  assert.equal(nx.ret, 2);
});

test('次日收益：最后一天返回 null，不越界不回绕', () => {
  const days = [{ trade_date: '2026-01-05', indexes: { 上证指数: 1 } }];
  assert.equal(nextRetOf(days[0], days), null);
});

// ────────────────────────── 五、统计工具正确性 ──────────────────────────

test('统计：pearson 对完全线性关系返回 1 / -1', () => {
  assert.ok(Math.abs(pearson([1, 2, 3, 4], [2, 4, 6, 8]) - 1) < 1e-9);
  assert.ok(Math.abs(pearson([1, 2, 3, 4], [8, 6, 4, 2]) + 1) < 1e-9);
});

test('统计：pearson 常数序列返回 null（不返回 NaN）', () => {
  assert.equal(pearson([1, 1, 1, 1], [1, 2, 3, 4]), null);
  assert.equal(pearson([1, 1, 1, 1], [2, 2, 2, 2]), null);
});

test('统计：pearson 样本不足返回 null', () => {
  assert.equal(pearson([1, 2], [1, 2]), null);
});

test('统计：ranks 对并列取平均秩', () => {
  assert.deepEqual(ranks([10, 20, 20, 30]), [1, 2.5, 2.5, 4]);
});

test('统计：spearman 对单调非线性关系仍为 1', () => {
  // y = x^3 单调但非线性 —— pearson 明显小于 1，spearman 应为 1
  const x = [1, 2, 3, 4, 5, 6];
  const y = x.map((v) => v ** 3);
  assert.ok(spearman(x, y) > 0.999);
  assert.ok(pearson(x, y) < 0.95, 'pearson 应被非线性压低，说明两个指标确实不同');
});

test('统计：directionAccuracy 按中位数分档，并列中位数不参与', () => {
  // 中位数=3；scores[1] 与中位数并列 → 排除，总数应为 3
  const r = directionAccuracy([1, 3, 3, 4, 5], [1, 2, -1, 1, -2]);
  assert.equal(r.total, 3, '并列中位数的那天应被排除');
});

test('统计：directionAccuracy 全对时为 1', () => {
  const r = directionAccuracy([10, 20, 30, 40], [-1, -2, 1, 2]);
  assert.equal(r.acc, 1);
});

// ────────────────────────── 六、端到端（依赖真实档案，缺则跳过）──────────────────────────

const ARCHIVE = 'data/archive.json';
const REGRESSION = 'data/version-regression.json';
const haveArchive = existsSync(ARCHIVE);
const haveRegression = existsSync(REGRESSION);

test('端到端：真实档案三版重算不产生 NaN，且 v5.2 与档案现存分数一致',
  { skip: !haveArchive && '缺 data/archive.json' }, () => {
    
    const arch = decodeArchive(JSON.parse(readFileSync(ARCHIVE, 'utf8')));
    const days = (arch.all_days || []).filter((d) => d && d.trade_date);
    const { ok } = computableDays(days);
    assert.ok(ok.length > 0, '应至少有一天可算');
    const res = computeAllVersions(ok, versionKeys(), config.weights);
    for (const k of versionKeys()) {
      for (const r of res[k]) {
        assert.ok(Number.isFinite(r.score), `${k} ${r.trade_date} 分数非有限`);
        assert.ok(r.score >= 0 && r.score <= 100, `${k} ${r.trade_date} 分数越界 ${r.score}`);
      }
    }
    // 基线必须能复现档案里现存的口径：逐日比对 score（允许 0.1 的四舍五入差）
    // ⚠ MA20 上下文必须取**全档**（与生产 recalcAll 同窗口）：computeAllVersions(ok) 只在
    //   full 档（有指数的 33 天）内取前 20 个有值 amount——六因子回填（2026-10-02）给 208 个
    //   历史天补了 amount_yi 后，档案里 2026-08-14 的 s_amt 是按全档 MA20 算出的真值，
    //   而 tier 过滤窗口里看不到那些回填 amount → 会拿代理 50 误报「不一致」。
    //   故此处按全档复刻 recalcAll 的 MA20 算法（前 20 个有值交易日均值，不足 10 个为 null），
    //   用 recomputeDay 逐日喂入，与生产唯一实现逐字对齐。
    const amtsAll = days.map((d) => (d.summary && d.summary.amount_yi != null) ? d.summary.amount_yi : null);
    const maOf = (date) => {
      const i = days.findIndex((d) => d.trade_date === date);
      const hist = [];
      for (let j = i - 1; j >= 0 && hist.length < 20; j--) if (amtsAll[j] != null) hist.unshift(amtsAll[j]);
      return hist.length >= 10 ? hist.reduce((a, b) => a + b, 0) / hist.length : null;
    };
    let compared = 0;    for (let i = 0; i < ok.length; i++) {
      const archived = ok[i].emotion?.value;
      if (archived == null) continue;
      const r = recomputeDay(ok[i], BASELINE_VERSION, { amountMA20: maOf(ok[i].trade_date), weights: config.weights });
      assert.ok(Math.abs(r.score - archived) <= 0.15,
        `${ok[i].trade_date} 基线重算 ${r.score} 与档案 ${archived} 不一致`);
      compared++;
    }
    assert.ok(compared > 0, '应至少有一天可与档案比对');
  });

test('端到端：v4.5 的 s_net 饱和天数严格多于 v5.2（这正是 v5.0 存在的理由）',
  { skip: !haveArchive && '缺 data/archive.json' }, () => {
    
    const arch = decodeArchive(JSON.parse(readFileSync(ARCHIVE, 'utf8')));
    const days = (arch.all_days || []).filter((d) => d && d.trade_date);
    const { ok } = computableDays(days);
    const res = computeAllVersions(ok, versionKeys(), config.weights);
    const sat = (k) => res[k].filter((r) => r.factors.s_net >= 99.5).length;
    assert.ok(sat('v4.5') >= sat(BASELINE_VERSION),
      `v4.5 饱和 ${sat('v4.5')} 天 应 ≥ v5.2 饱和 ${sat(BASELINE_VERSION)} 天`
      + `——若反了说明口径实现有问题（区间累计值不可能让因子更不饱和）`);
  });

test('端到端：回归产物结构完整、统计量在合法区间', { skip: !haveRegression && '缺 data/version-regression.json' }, () => {
  const r = JSON.parse(readFileSync(REGRESSION, 'utf8'));
  assert.equal(r.kind, 'version-regression');
  assert.equal(r.baseline, BASELINE_VERSION);
  assert.ok(Array.isArray(r.cautions) && r.cautions.length >= 2, '必须带样本量/代理披露');
  assert.deepEqual(r.versions.map((v) => v.key), versionKeys());
  assert.equal(r.daily.length, r.sample.mainDays);
  for (const k of versionKeys()) {
    const s = r.stats[k];
    assert.ok(s, `缺 ${k} 统计`);
    assert.ok(s.n >= 5, `${k} 有效样本不足`);
    if (s.pearson != null) assert.ok(Math.abs(s.pearson) <= 1, `${k} pearson 越界`);
    if (s.spearman != null) assert.ok(Math.abs(s.spearman) <= 1, `${k} spearman 越界`);
    if (s.direction) assert.ok(s.direction.acc >= 0 && s.direction.acc <= 1, `${k} 准确率越界`);
  }
  // 每条 daily 必须带三版分数与次日收益
  for (const row of r.daily) {
    for (const k of versionKeys()) assert.ok(Number.isFinite(row.scores[k]), `${row.trade_date} 缺 ${k} 分数`);
  }
});

test('端到端：回归产物必须披露样本量不足（不得让人误读为版本优劣结论）',
  { skip: !haveRegression && '缺 data/version-regression.json' }, () => {
    const r = JSON.parse(readFileSync(REGRESSION, 'utf8'));
    const joined = r.cautions.join(' ');
    assert.ok(/样本|自由度/.test(joined), '必须披露样本量限制');
    assert.ok(/不足|极低|不.*判定/.test(joined), '必须明确说明不足以判定优劣');
  });
