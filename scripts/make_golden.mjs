// 集成测 golden 生成器：把当前 data/archive.json 固化为 known-good 快照 + 期望输出摘要。
//
// 用法：
//   node scripts/make_golden.mjs              # 生成/刷新 test/fixtures/golden_input.json + golden_summary.json
//
// 纪律：
//   · fixture 输入 = 真实档案的 all_days 原样拷贝（不精简字段——精简本身就是引入口径偏差的机会）。
//   · golden 摘要 = 用**生产同一条管道**（enrich + recalcAll 全档，src/pipeline.js 唯一出处）
//     重跑这份输入后的关键值。CI 里 test/integration_pipeline.test.mjs 用同一条管道重放 fixture，
//     输出与 golden 逐位比较——任何让历史值漂移的改动（公式/权重/去噪/分位）都会红。
//   · 改口径是合法操作（公式版本迭代），刷新 golden 必须显式跑本脚本并在 commit message 里
//     说明漂移来源；测试不会静默跳过缺失的 golden。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { atomicWriteJSON } from '../src/fsutil.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enrich, recalcAll } from '../src/pipeline.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIX_DIR = path.join(ROOT, 'test', 'fixtures');

const arc = JSON.parse(readFileSync(path.join(ROOT, 'data', 'archive.json'), 'utf8'));
const allDays = JSON.parse(JSON.stringify(arc.all_days)); // 深拷贝，绝不动生产档

// ── 跑生产同一条管道（与 runOffline 完全一致的顺序：enrich → recalcAll 全档）──
const { out, momObj } = enrich(allDays);
recalcAll(out);

// ── fixture：静态输入快照 ──
mkdirSync(FIX_DIR, { recursive: true });
const fixture = {
  meta: {
    capturedAt: new Date().toISOString(),
    sourceArchive: 'data/archive.json',
    archiveDays: allDays.length,
    firstDay: allDays[0].trade_date,
    lastDay: allDays[out.length - 1].trade_date,
    note: 'known-good 固定快照：集成测输入。刷新=改口径后显式重跑 scripts/make_golden.mjs 并在 commit 里说明漂移来源。',
  },
  all_days: allDays,
};
atomicWriteJSON(path.join(FIX_DIR, 'golden_input.json'), JSON.stringify(fixture));

// ── golden：期望输出摘要（只存关键值，不存全档——diff 要能一眼看出哪里漂了）──
const realDays = out.filter((d) => d.emotion && !d.emotion._backfill);
const golden = {
  meta: {
    generatedAt: new Date().toISOString(),
    pipeline: 'enrich + recalcAll(全档) —— src/pipeline.js 生产同源',
    formulaVersion: out[out.length - 1].emotion && 'v5.2-pro',
    disclaimers: '值漂移 = 口径变更（公式/权重/去噪/分位）。合法，但必须显式刷新本文件并说明来源。',
  },
  structure: {
    archiveDays: out.length,
    realDays: realDays.length,
    backfillDays: out.length - realDays.length,
    firstDay: out[0].trade_date,
    lastDay: out[out.length - 1].trade_date,
    tradeDatesStrictlyAscending: out.every((d, i) => i === 0 || d.trade_date > out[i - 1].trade_date),
  },
  // 每个真实天的关键值（重算后的）：情绪分 + 去噪后题材数 + 七因子
  realDaysSeries: realDays.map((d) => ({
    date: d.trade_date,
    value: d.emotion.value,
    topics: (d.topics || []).length,
    s_net: d.emotion.s_net, s_pos: d.emotion.s_pos, s_brd: d.emotion.s_brd,
    s_hot: d.emotion.s_hot, s_zdt: d.emotion.s_zdt, s_zbl: d.emotion.s_zbl, s_amt: d.emotion.s_amt,
    missing: (d.emotion.missing || []).length,
  })),
  // 最新日分位（防前视窗口口径）
  latest: {
    date: out[out.length - 1].trade_date,
    value: out[out.length - 1].emotion.value,
    pct_rank: out[out.length - 1].emotion.pct_rank,
    net_daily_pct_rank: out[out.length - 1].emotion.net_daily_pct_rank,
  },
  // 题材动量分类计数（去噪 + 双窗口口径的聚合结果）
  momentum: {
    fresh: momObj.fresh ? momObj.fresh.length : null,
    fading: momObj.fading ? momObj.fading.length : null,
    continuing: momObj.continuing ? momObj.continuing.length : null,
  },
};
atomicWriteJSON(path.join(FIX_DIR, 'golden_summary.json'), JSON.stringify(golden, null, 2));

console.log(`fixture: ${out.length} 天（真实 ${realDays.length} / 回填 ${out.length - realDays.length}）`);
console.log(`golden:  最新日 ${golden.latest.date} 情绪 ${golden.latest.value} · 动量 fresh/fading/continuing = ${golden.momentum.fresh}/${golden.momentum.fading}/${golden.momentum.continuing}`);
console.log('写入 test/fixtures/golden_input.json + golden_summary.json');
