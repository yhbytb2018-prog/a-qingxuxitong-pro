// 存量回填：为 signals.momentum 补 prev_fresh/prev_continuing/prev_fading（昨日视角动量）。
// 报告「昨日新晋题材存活率」需要昨日视角的 fresh 名单，老存档没有这个字段 → 回填。
//
// 用法：node scripts/backfill_prev_momentum.mjs [--dry]
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { enrich } from '../src/pipeline.js';
import { decodeArchive, writeArchiveSafely } from '../src/lhb_codec.js';

const FILE = 'data/archive.json';
const DRY = process.argv.includes('--dry');

const a = decodeArchive(JSON.parse(readFileSync(FILE, 'utf8')));
const before = a.signals?.momentum || {};
console.log('回填前 momentum 键:', Object.keys(before).join(', '));

// enrich 只依赖 all_days（题材去噪 + 动量），不抓网络。它同时会重算 themes（幂等）。
const { out, momObj } = enrich(a.all_days);

console.log('');
console.log('回填后 momentum 键:', Object.keys(momObj).join(', '));
console.log('  今日 fresh', momObj.fresh.length, '｜continuing', momObj.continuing.length, '｜fading', momObj.fading.length);
console.log('  昨日 fresh', momObj.prev_fresh.length, '｜continuing', momObj.prev_continuing.length, '｜fading', momObj.prev_fading.length);
console.log('  昨日新晋清单:', momObj.prev_fresh.join('、'));

// 存活率：昨日 fresh → 今日 themes 是否仍存在
const todayThemes = out[out.length - 1].themes || {};
const alive = momObj.prev_fresh.filter((t) => (todayThemes[t] || 0) > 0);
console.log('');
console.log('  昨日新晋今日存活:', alive.length + '/' + momObj.prev_fresh.length, '=', Math.round(alive.length / momObj.prev_fresh.length * 100) + '%');
console.log('  存活清单:', alive.join('、') || '(无)');

a.signals = a.signals || {};
a.signals.momentum = momObj;
if (DRY) console.log('\n（--dry 未写盘）');
else {
  // 必须重编码写回（直接 stringify 会把压缩档解压成 9.2MB 且丢掉 rc 的可读性）
  writeArchiveSafely(FILE, a, { writeFileSync, renameSync, unlinkSync });
  console.log('\n已写盘', FILE);
}
