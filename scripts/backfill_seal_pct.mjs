// 一次性回填：给存量 archive 的每日 summary 补 seal_pct / zb_pct / seal_den（封板率口径修正）。
// 为什么可以纯本地回填：这三个字段只是 zt_count / zb_count 的确定性派生量（seal=zt/(zt+zb)），
// 不含任何抓取依赖，因此重算结果与当日线上算出的完全一致（幂等）。
// 用法：node scripts/backfill_seal_pct.mjs [--dry]
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { decodeArchive, writeArchiveSafely } from '../src/lhb_codec.js';

const DRY = process.argv.includes('--dry');
const FILE = 'data/archive.json';
const a = decodeArchive(JSON.parse(readFileSync(FILE, 'utf8')));
const r1 = (x) => Math.round(x * 10) / 10;
let n = 0, skipped = 0;
for (const d of a.all_days) {
  const s = d.summary;
  if (!s) { skipped++; continue; }
  const zt = s.zt_count, zb = s.zb_count;
  if (zt == null || zb == null || (zt + zb) <= 0) {
    // 无涨停池数据的日子：如实写成 null，不编造
    if (s.seal_pct !== undefined) { delete s.seal_pct; delete s.zb_pct; delete s.seal_den; }
    skipped++;
    continue;
  }
  const seal = r1((zt / (zt + zb)) * 100);
  s.seal_pct = seal;
  s.zb_pct = r1(100 - seal);
  s.seal_den = zt + zb;
  n++;
}
// ⚠ 写盘必须带 2 空格缩进（与 src/pipeline.js 的写盘格式一致）——否则整个 archive
//   会被压成单行，git diff 无法审阅（本次修复 archive 被 minify 的教训）。
// 必须重编码写回（直接 stringify 会把压缩档解压成 9.2MB 且丢掉 rc 的可读性）
if (!DRY) writeArchiveSafely(FILE, a, { writeFileSync, renameSync, unlinkSync });
console.log(`[backfill-seal] ${DRY ? '(dry) ' : ''}更新 ${n} 天，跳过 ${skipped} 天（无涨停池数据）`);
const last = a.all_days[a.all_days.length - 1].summary;
console.log(`样本 ${last.trade_date ?? a.all_days[a.all_days.length - 1].trade_date}: zt=${last.zt_count} zb=${last.zb_count} → 封板率 ${last.seal_pct}% / 炸板率 ${last.zb_pct}%（旧 zbl_pct=${last.zbl_pct}）`);
