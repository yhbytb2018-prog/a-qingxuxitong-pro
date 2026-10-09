// 存量修补：把「强势股行情缺失」的条目用同日龙虎榜明细的行情补齐。
//
// 起因：fetchHotQuotes 的代码前缀判断漏了北交所（9/8/4 段），920779 武汉蓝电 2026-09-29 进榜时
// 行情补全请求被整批过滤掉，close / 涨跌幅 / 换手全空；旧代码又把「空」写成 0，页面于是显示
// 「现价 —、换手 0、涨幅 0.00%」，看着像数据本身出错。
// src/sources.js 已修（quoteSymbol 覆盖北交所与 B 股 + 缺失保持 null + 同日龙虎榜兜底），
// 之后新抓取的档不会再出现这种情况；本脚本只处理已经落盘的存量档。
// 依据：同一天、同一只票的收盘价与涨跌幅，在两个独立数据源（腾讯行情 / 东财龙虎榜明细）应当一致，
// 所以缺失时借用另一个源是安全的补齐，而不是编造 —— 每条都会写入 quote_src 标明来源。
//
// 用法：node scripts/repair_hot_quotes.mjs [--dry]
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeArchive, writeArchiveSafely, appendNote } from '../src/lhb_codec.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = path.join(ROOT, 'data', 'archive.json');
const DRY = process.argv.includes('--dry');

// 存档是压缩态（reason→rc 码表 + lhb 提子），读进来必须先解码成明文再改。
const a = decodeArchive(JSON.parse(readFileSync(P, 'utf8')));
const fixed = [];

for (const day of a.all_days || []) {
  const lhbByCode = new Map((day.lhb_aggr || []).map((r) => [r.code, r]));
  let repaired = 0;
  for (const h of day.hot || []) {
    if (h.close != null) continue;
    const l = lhbByCode.get(h.code);
    if (!l || l.close == null) continue;
    fixed.push(`${day.trade_date} ${h.code} ${h.name}：空 → 收盘 ${l.close} / 涨跌 ${l.change_pct}% / 换手 ${l.turnover_pct}%`);
    if (DRY) continue;
    h.close = l.close;
    h.change_pct = l.change_pct ?? null;
    h.huanshou = l.turnover_pct ?? null;
    h.quote_src = 'lhb';
    repaired += 1;
  }
  if (!DRY && repaired && day.summary) {
    // 缺口计数与 missing 标记同步刷新（口径与 buildDay 一致）
    const miss = (day.hot || []).filter((h) => h.close == null).length;
    day.summary.hot_quote_missing = miss;
    const rest = (day.summary._missing || []).filter((m) => !String(m).startsWith('hot_quotes'));
    if (miss) rest.push(`hot_quotes(${miss})`);
    if (rest.length) day.summary._missing = rest; else delete day.summary._missing;
  }
}

console.log(`待修补条目：${fixed.length}`);
fixed.forEach((x) => console.log('  ' + x));

if (!fixed.length) { console.log('无需修补，未写盘。'); process.exit(0); }
if (DRY) { console.log('（--dry：仅预览，未写盘）'); process.exit(0); }

a.meta = a.meta || {};
const stamp = new Date().toISOString().slice(0, 10);
// appendNote：签名去重——重跑只更新日期与条数，不堆叠重复段
a.meta.note = appendNote(a, `强势股行情空值已按同日龙虎榜明细回填（${fixed.length} 条，${stamp}）`);
// 必须重编码写回（直接 stringify 会把压缩档解压成 9.2MB，且丢掉 rc 的可读性）
writeArchiveSafely(P, a, { writeFileSync, renameSync, unlinkSync });
console.log(`已写回 ${path.relative(ROOT, P)}`);
