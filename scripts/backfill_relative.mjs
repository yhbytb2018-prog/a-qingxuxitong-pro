// 一次性回填：为存量主档补算 summary.industry_relative。
//
// ── 为什么需要它 ──────────────────────────────────────────────────────────────
// industry_relative 是**派生指标**，口径实现在 src/relative.js。管线本会在每次
// 写档时重算（见 src/pipeline.js 的 enrich），但存量 241 天是用旧代码写下的，
// 里面根本没有这个字段。若不回填，前端/报告要等到下一个交易日才有超额榜
// ——而 2026-10-01 起是国庆长假，最早也要等到 10-08。
//
// ── 为什么走「读主档 → 重算 → 写回」而不是重跑管线 ────────────────────────────
// 重跑 runOffline 会从 snapshot.html 重建 all_days，那是**另一条数据路径**
// （快照解析），会把当前主档里管线产出的字段（双口径、新股分离、席位、breadth
// 回填等）替换成快照里可能更旧的值。本任务是"加一列"，不该顺带动别的列。
// 故只解码 → 逐日 computeRelative → 写回，其余字段原样透传。
//
// ── 为什么用 writeArchiveSafely 而不是 writeArchive ──────────────────────────
// writeArchive（src/pipeline.js）会顺带重建切片，但它**不做往返自检**：
// 编码/解码一旦不等价（reason 丢失、天数变化），它照样落盘。
// writeArchiveSafely 会在写盘前逐日比对 reason 语义指纹，不一致就抛错不写。
// 本脚本是"改存量档"，改坏了没有上游数据可重放（历史天无法重抓），
// 故必须用带自检的那条路径。切片由 writeArchiveSafely 之后的 split_archive 重建。
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { decodeArchive, writeArchiveSafely, appendNote } from '../src/lhb_codec.js';
import { computeRelative, relativeLine } from '../src/relative.js';
import * as fsMod from 'fs';

// 用法：
//   node scripts/backfill_relative.mjs            # 写盘 + 重建切片
//   node scripts/backfill_relative.mjs --check    # 只统计，不写盘
//
// 写盘后必须重建切片（本脚本末尾调用 split_archive），否则主档有字段而首屏读的切片没有。

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const MAIN = path.join(DATA, 'archive.json');
const CHECK = process.argv.includes('--check');

if (!existsSync(MAIN)) {
  console.error(`[backfill-relative] 主档不存在：${MAIN}`);
  process.exit(1);
}

const archive = decodeArchive(JSON.parse(readFileSync(MAIN, 'utf8')));
const days = archive.all_days || [];
console.log(`[backfill-relative] 主档 ${days.length} 天 · ${CHECK ? '只检查' : '写盘'}`);

let has = 0, computed = 0, noData = 0, overturned = 0;
const withInd = [];
for (const d of days) {
  if (!d.summary) { noData++; continue; }
  const before = d.summary.industry_relative ? 'yes' : 'no';
  const rel = computeRelative(d);
  if (rel) {
    d.summary.industry_relative = rel;
    withInd.push(d);
    has++;
    if (before === 'no') computed++;
  } else {
    // 明确删除而非留 undefined：JSON.stringify 会丢掉 undefined，
    // 但留一个 undefined 键会让"有字段但值为空"与"没这字段"在内存里长得不一样，
    // 下游 `'industry_relative' in s` 这类判断会得到意外结果。
    delete d.summary.industry_relative;
    noData++;
    if (before === 'yes') overturned++;
  }
}

console.log(`[backfill-relative] 有行业明细并算出：${has} 天（其中新补算 ${computed}）`);
console.log(`[backfill-relative] 无行业明细（保持未计算）：${noData} 天`);
if (overturned) console.log(`[backfill-relative] ⚠ 原有值被撤销：${overturned} 天（说明历史值不可信，请排查）`);

if (withInd.length) {
  const last = withInd[withInd.length - 1];
  console.log(`[backfill-relative] 最近一天 ${last.trade_date}：${relativeLine(last.summary.industry_relative)}`);
  const first = withInd[0];
  console.log(`[backfill-relative] 最早一天 ${first.trade_date}：${relativeLine(first.summary.industry_relative)}`);
}

if (CHECK) {
  console.log('[backfill-relative] --check：未写盘');
  process.exit(0);
}

// meta 留痕：让后人知道这 241 天里哪些字段是回填来的，而不是原生采集时就有
// （appendNote：签名去重——重跑只更新日期，不堆叠重复段）
archive.meta.note = appendNote(archive,
  `板块相对强弱（industry_relative）已于 ${new Date().toISOString()} 对存量档回填；口径见 src/relative.js。`);

writeArchiveSafely(MAIN, archive, fsMod);
console.log('[backfill-relative] 已写盘（码表 + 提子，含往返自检）');

// 切片必须紧跟着重建：主档是权威源，但**首屏读的是切片**。
// writeArchiveSafely 只写主档（它是"改存量档"的通用工具，不该知道切片的存在），
// 故此处显式重建，保证两档同步——否则会出现"主档有字段、页面显示未计算"的假阴性。
const { spawnSync } = await import('child_process');
const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'split_archive.mjs')], { stdio: 'inherit' });
if (r.status !== 0) {
  console.error('[backfill-relative] ⚠ 切片重建失败，主档已更新但切片仍是旧版（首屏会读到旧切片）');
  process.exit(1);
}
console.log('[backfill-relative] 切片已重建');
