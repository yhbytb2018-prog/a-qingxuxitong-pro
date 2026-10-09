// 公式版本回归验证集：把 v4.5 / v5.0 / v5.2 三版公式在**同一段历史**上并行重算，
// 对每个交易日的「次日上证涨跌幅」计算相关性 + 方向准确率，产出可直接读的回归报告。
//
// 为什么需要它（用户第 7 项的原始诉求）：
//   过去 v4.5 → v5.0 → v5.2 三次改公式，都是靠"看到某天数字不对劲"发现的，没有任何量化回归。
//   改一次公式，影响是全局的（分位、档位、推荐、回测全跟着动），但没人能说清"这版到底比上版好在哪"。
//   本脚本把这件事变成可复现的数字：以后每改一次公式，跑一次就出一份对比。
//
// 用法：
//   node scripts/version_regression.mjs [--archive data/archive.json] [--out data/version-regression.json]
//
// ⚠ 样本量纪律（本脚本最重要的设计约束）：
//   三版差异**只在 s_net 一项**。要让差异显形，样本天必须有齐全的原始量。
//   历史现状：2026-10-05 指数收益回填（scripts/backfill_indexes.mjs）之前，241 天里
//   只有 33 天（2026-08-14 起）同时具备 ind_up / amount_yi / indexes（次日收益原料）；
//   回填后主样本恢复到全档（~240 天，仅末日无次日收益）。故本脚本：
//     · 主统计样本 = full 档天数，并**显式披露**其中多少天 s_pos 走了代理；
//     · 样本量警示按 nU 自适应（<60 天 → 自由度极低话术；≥60 → 实算置信区间宽度），
//       任何情况下都不给"版本优劣排序"的结论性表述，只给数字与置信度提示。
//   这不是保守，是诚实：拿样本内相关去宣称公式优劣，就是自欺。

import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import config from '../src/config.js';
import { decodeArchive } from '../src/lhb_codec.js';
import {
  BASELINE_VERSION, FORMULA_VERSIONS, versionKeys,
  computableDays, computeAllVersions, nextRetOf,
} from '../src/formula_versions.js';

const args = process.argv.slice(2);
const argOf = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const ARCHIVE = argOf('--archive', 'data/archive.json');
const OUT = argOf('--out', 'data/version-regression.json');

const arch = decodeArchive(JSON.parse(readFileSync(ARCHIVE, 'utf8')));
const allDays = (arch.all_days || []).filter((d) => d && d.trade_date);

const { ok: sampleDays, partial, none, meta } = computableDays(allDays);
if (sampleDays.length < 5) {
  console.error(`[version-regression] 主样本不足（${sampleDays.length} 天），跳过生成`);
  process.exit(0);
}

const keys = versionKeys();

// ⚠ 权重键陷阱：computeSentiment 内部按 **带档位后缀的权重键**（s_net20 / s_pos10 / …）取 w[k]，
//   而存档里存的因子键是无后缀的（s_net / s_pos / …）。传错键的后果是 w[k] 为 undefined
//   → score = NaN，且**不会报错**（NaN 一路静默传播到相关性、均分、准确率全变 NaN）。
//   实测踩过：传了 factorKeyMap 转出来的 plainW（无后缀），三版全部 NaN。
//   这里直接交付 config.weights（就是带后缀的原始权重）—— 绝不做任何键名转换。
const weights = { ...config.weights };

// ────────────────────────── 统计工具 ──────────────────────────
//
// 实现在 test/_helpers_regression.mjs —— 单测与脚本**共用同一份**，
// 否则统计口径会漂移：回归报告与守卫说的不是一回事，而且很难发现。
import { mean, stdev, pearson, spearman, directionAccuracy, scoreShift } from '../test/_helpers_regression.mjs';

// ────────────────────────── 主流程 ──────────────────────────

const byVersion = computeAllVersions(sampleDays, keys, weights);

// 次日收益对齐：按**真实交易日相邻**取，并记录跳空天数（长假后首日的"次日"含跳空）
const rets = [], retMeta = [];
for (const d of sampleDays) {
  const nx = nextRetOf(d, allDays);
  rets.push(nx ? nx.ret : null);
  retMeta.push(nx);
}

// 只用「有次日收益」的天做统计（最后一天必然没有）
const usable = [];
for (let i = 0; i < sampleDays.length; i++) if (rets[i] != null) usable.push(i);

const retsU = usable.map((i) => rets[i]);
// s_net 饱和判定的阈值（唯一出处）。取 99.9 而非 99.5：
//   实测 241 天里 s_net 落在 [99.5, 99.9) 的有 27 天、落在 [99.9, 100] 的有 79 天。
//   99.5 会把"接近满格但仍有 0.5 分辨力"的日子也算成饱和，夸大问题；
//   99.9 只认"真顶格"，是本指标该有的严格口径。
const SAT_THRESHOLD = 99.9;
const stats = {};
for (const k of keys) {
  const scoresU = usable.map((i) => byVersion[k][i].score);
  const netsU = usable.map((i) => byVersion[k][i].netBuy);
  const sNetU = usable.map((i) => byVersion[k][i].factors.s_net);
  const sNetFinite = sNetU.filter((v) => Number.isFinite(v));
  // 分位归一器在历史不足时返回 null → 该日 s_net 标 missing、因子值 50。
  // 必须与"真值 50"区分开，否则"0 饱和"可能是"根本没算"造成的假象。
  const sNetMissing = sNetU.length - sNetFinite.length;
  stats[k] = {
    version: k,
    name: FORMULA_VERSIONS.find((v) => v.key === k)?.name || k,
    desc: FORMULA_VERSIONS.find((v) => v.key === k)?.desc || '',
    scoreMean: mean(scoresU),
    scoreStdev: stdev(scoresU),
    scoreMin: Math.min(...scoresU),
    scoreMax: Math.max(...scoresU),
    // s_net 饱和 = 顶到 ≥99.9 的天数（失去分辨力）。旧字段名保留兼容，值口径收紧到 99.9。
    sNetSaturated: sNetFinite.filter((v) => v >= SAT_THRESHOLD).length,
    // 新增：s_net 走 missing（归一器算不出）的天数 —— 与"饱和"是一对反向指标。
    // 一个版本若靠"大量 missing → 因子恒 50"来降低饱和率，这两列一起看就会露馅。
    sNetMissing,
    sNetOk: sNetFinite.length,
    pearson: pearson(scoresU, retsU),
    spearman: spearman(scoresU, retsU),
    direction: directionAccuracy(scoresU, retsU),
    // 净买与次日收益的直接相关：三版差异的物理来源
    netPearson: pearson(netsU, retsU),
    n: scoresU.length,
    // 归一层留痕：本版用的归一器与历史窗口（v4.5/v5.0/v5.2 恒为 tanh5）
    normalizer: byVersion[k].find((r) => r.netCaliber)?.netCaliber?.normalizer ?? 'tanh5',
  };
}

// 版本间差异（以基线为参照）
const shifts = {};
for (const k of keys) {
  if (k === BASELINE_VERSION) continue;
  const a = usable.map((i) => byVersion[k][i].score);
  const b = usable.map((i) => byVersion[BASELINE_VERSION][i].score);
  shifts[k] = { vs: BASELINE_VERSION, ...scoreShift(a, b) };
}

// 逐日明细（报告与人工复核都用它）
const daily = sampleDays.map((d, i) => {
  const row = {
    trade_date: d.trade_date,
    nextDate: retMeta[i] ? retMeta[i].date : null,
    nextRet: rets[i],
    nextGapDays: retMeta[i] ? retMeta[i].gap : null,
    scores: {}, nets: {}, sNet: {}, sNetCaliber: {},
  };
  for (const k of keys) {
    row.scores[k] = byVersion[k][i].score;
    row.nets[k] = byVersion[k][i].netBuy;
    row.sNet[k] = byVersion[k][i].factors.s_net;
    // 归一层留痕：前端对比表要能显示"同一净买、两套换算"的分岔点
    row.sNetCaliber[k] = byVersion[k][i].netCaliber || null;
  }
  return row;
});

// 代理披露：本样本里 s_pos 走代理的天数（up_count 缺失 → fallback 到 posRatio）
const breadthProxyDays = meta.filter((m) => sampleDays.some((d) => d.trade_date === m.trade_date) && !m.hasBreadth).length;

// 置信度提示：n 与自由度
const nU = retsU.length;
const cautions = [];
if (nU < 60) {
  cautions.push(`主样本仅 ${nU} 个交易日（含次日收益），统计自由度极低，任何相关系数的 95% 置信区间都宽于 ±0.35——本报告只用于**发现异常**（如某版 s_net 全部饱和、某版分数与收益反向），不足以判定版本优劣。`);
} else {
  const ci = (1.96 / Math.sqrt(Math.max(1, nU - 3))).toFixed(2);
  cautions.push(`主样本 ${nU} 个交易日（含次日收益），相关系数的 95% 置信区间约 ±${ci}——足以暴露量级差异与方向性异常，但版本间小幅差异仍不足以判定优劣，需样本外证据佐证。`);
}
if (breadthProxyDays > 0) {
  cautions.push(`本样本中有 ${breadthProxyDays}/${sampleDays.length} 天缺少涨跌家数真值（up_count/down_count），s_pos 因子走 posRatio 代理——版本间差异会被代理值稀释，真实差异应大于本表所示。`);
}
cautions.push(`版本差异可归因于「净买原料口径」（v4.5 全量 / v5.0 当日 / v5.2 当日剔新股）与「s_net 归一方式」（v5.3 分位映射 vs 其余 tanh5）两个维度；其余因子在各版本中完全相同。`);

// 归一层专项披露：v5.3 的均分系统性下移是**设计后果，不是 bug**。
// 必须在报告里讲清，否则读者看到"候选版均分低 5 分"会误判成"变差了"。
const cand = stats['v5.3-pro'];
const base = stats[BASELINE_VERSION];
if (cand && base) {
  const dMean = cand.scoreMean - base.scoreMean;
  cautions.push(`v5.3-pro 的均分相对基线偏移 ${dMean.toFixed(2)} 分（${base.scoreMean.toFixed(1)} → ${cand.scoreMean.toFixed(1)}），这是**分位归一转 positive 作用的必然结果**：tanh(x/5) 把中位数交易日顶到 97 分以上，分位映射把中位数拉回 50 分——即"削掉了虚高"。⚠ 因此切换基线**必须同步重标定档位阈值（24/65/80）**，否则大量原本判"满仓"的日子会掉到"半仓"档，这是口径变更而非市场变化。`);
  if (cand.sNetSaturated < base.sNetSaturated) {
    cautions.push(`饱和改善：s_net ≥${SAT_THRESHOLD} 的天数 ${base.sNetSaturated}/${base.n} → ${cand.sNetSaturated}/${cand.n}（候选版 vs 基线）。这是 v5.3 存在的**唯一设计目标**，已达成；但它不能被解读为"预测力更强"——Pearson 差异在 n=${nU} 下不显著。`);
  }
  if (cand.sNetMissing > 0) {
    cautions.push(`v5.3-pro 有 ${cand.sNetMissing}/${cand.n} 天 s_net 因历史窗口不足走 missing（因子回落 50）——这是**诚实标记**而非缺陷，但会稀释该版的因子分辨率，与饱和指标须成对阅读。`);
  }
}
if (allDays.length - sampleDays.length > 0) {
  cautions.push(`档案共 ${allDays.length} 天，其中 ${allDays.length - sampleDays.length} 天因缺 ind_up/amount_yi/indexes 未纳入主样本（partial 档：可算 s_net 差异但无次日收益），故样本集中在 ${sampleDays[0].trade_date} 起。`);
}

const payload = {
  kind: 'version-regression',
  version: '1.0',
  generatedAt: new Date().toISOString(),
  baseline: BASELINE_VERSION,
  formulaVersion: config.formulaVersion,
  sample: {
    archiveDays: allDays.length,
    mainDays: sampleDays.length,
    withNextRet: nU,
    dateRange: [sampleDays[0].trade_date, sampleDays[sampleDays.length - 1].trade_date],
    partialDays: partial.length,
    noneDays: none.length,
    breadthProxyDays,
  },
  cautions,
  versions: keys.map((k) => {
    const v = FORMULA_VERSIONS.find((x) => x.key === k);
    return {
      key: k, name: v.name, desc: v.desc, baseline: !!v.baseline, candidate: !!v.candidate,
      // 归一层：该版用哪套 s_net 换算。前端对比表据此说明"差异从何而来"。
      normalizer: stats[k].normalizer,
    };
  }),
  // 饱和判定阈值（唯一出处，前端不得自行硬编码）
  satThreshold: SAT_THRESHOLD,
  stats,
  shifts,
  // 逐日：供前端表格渲染（33 行，体积可控）
  daily,
  // 口径纪律：本文件由 scripts/version_regression.mjs 唯一产出，前端只渲染不重算。
  caliber: '各版共用 src/sentiment.js 的 computeSentiment（同一函数、同一权重）；版本差异来自两个维度：净买原料口径（由 src/formula_versions.js 的 extractNetBuy 描述）与 s_net 归一方式（tanh5 基线 / 分位映射，由 src/sentiment.js 的 NET_NORMALIZER_* 描述）。次日收益取真实交易日相邻的下一交易日上证涨跌幅。',
};

// writeJsonStable：剥时间戳后内容未变则跳过——回归数字是确定性的，
// 重跑不再产生纯 generatedAt diff（缩进 1 保持原格式，避免一次性全文件重排）
const { writeJsonStable } = await import('../src/lhb_codec.js');
const w = writeJsonStable(OUT, payload, { readFileSync, writeFileSync, renameSync, unlinkSync, indent: 1, log: '[version-regression]' });
console.log('[version-regression]', w.skipped ? '内容未变，跳过写盘' : '已写出', OUT);
console.log('  主样本', sampleDays.length, '天（有次日收益', nU, '天）|', sampleDays[0].trade_date, '→', sampleDays[sampleDays.length - 1].trade_date);
for (const k of keys) {
  const s = stats[k];
  const fmt = (x, d = 3) => (x == null ? '  —  ' : x.toFixed(d));
  const tag = versionKeys().includes(k) && FORMULA_VERSIONS.find((v) => v.key === k)?.baseline ? '★基线'
    : FORMULA_VERSIONS.find((v) => v.key === k)?.candidate ? '☆候选' : '     ';
  console.log(`  ${k.padEnd(9)}${tag} 均分 ${fmt(s.scoreMean, 1).padStart(6)}  σ ${fmt(s.scoreStdev, 2).padStart(5)}`
    + `  s_net饱和 ${String(s.sNetSaturated).padStart(2)}/${s.n}`
    + `  missing ${String(s.sNetMissing).padStart(2)}`
    + `  Pearson ${fmt(s.pearson).padStart(7)}  Spearman ${fmt(s.spearman).padStart(7)}`
    + `  方向 ${s.direction ? (s.direction.acc * 100).toFixed(1) + '%' : '  —  '}`
    + `  [${s.normalizer}]`);
}
console.log(`  ⚠ 样本 ${nU} 天，只看异常，不排优劣。`);
console.log(`  饱和判定阈值：s_net ≥ ${SAT_THRESHOLD}`);
for (const k of Object.keys(shifts)) {
  const s = shifts[k];
  console.log(`  与基线差异 ${k}: 均偏移 ${s.meanDiff.toFixed(2)} 分 / 最大 ${s.maxAbsDiff.toFixed(1)} 分 / 变化 ${s.changedDays} 天`);
}
