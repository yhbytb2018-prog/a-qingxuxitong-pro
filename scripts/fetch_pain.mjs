// 收盘后抓取「亏钱效应」所需的真实行情，产出 data/pain-latest.json。
//
// 为什么单独成脚本、且必须走真实行情：
//   昨涨停今日表现**不能**用 archive.hot 算——hot 是涨幅榜，实测 2026-09-30 的 56 只
//   hot 里涨跌幅最小 9.87、低于 0 的有 0 只。用它会静默丢弃"昨涨停里今天下跌的那一半"，
//   结果**每天都是 +10%**（实测 17 天全在 +9.98~+11.44，"假繁荣"恒成立）。
//   只有拉全市场真实行情，才能看见翻绿的那 49%。
//
// 用法：
//   node scripts/fetch_pain.mjs                # 用档案最后一天作"昨日"，抓今日行情
//   node scripts/fetch_pain.mjs --prev 2026-09-29 --date 2026-09-30
//   node scripts/fetch_pain.mjs --dry          # 只打印不写盘
//
// ⚠ 必须在**收盘后**运行（含 ca盘后固定价格成交），否则拿到的是盘中快照，
//   翻绿比例会随分时波动。脚本会校验行情 tickDate 与目标日一致，不一致则拒绝写盘。
import { readFileSync, writeFileSync } from 'node:fs';
import { atomicWriteJSON } from '../src/fsutil.js';
import { painReport } from '../src/pain.js';
import { fetchQuotes } from '../src/quote.js';
import { decodeArchive } from '../src/lhb_codec.js';

const FILE = 'data/archive.json';
const OUT = 'data/pain-latest.json';
const DRY = process.argv.includes('--dry');
const argOf = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };

const a = decodeArchive(JSON.parse(readFileSync(FILE, 'utf8')));
const days = a.all_days.filter((d) => d && d.trade_date);
if (!days.length) { console.error('[pain] 档案为空'); process.exit(1); }

const wantDate = argOf('--date');
const prevArg = argOf('--prev');

// 昨日 = 显式指定，或"倒数第二个交易日"（最后一天是今日，需其行情）
let curIdx = wantDate ? days.findIndex((d) => d.trade_date === wantDate) : days.length - 1;
if (curIdx < 0) { console.error('[pain] 未找到日期', wantDate); process.exit(1); }
const curDay = days[curIdx];
const prevDay = prevArg
  ? days.find((d) => d.trade_date === prevArg)
  : days[curIdx - 1];

if (!prevDay || !prevDay.summary) {
  console.error('[pain] 找不到"昨日"存档（无可比对对象）');
  process.exit(1);
}

const prevZt = Array.isArray(prevDay.summary.zt_codes) ? prevDay.summary.zt_codes.map(String) : [];
const lbCodes = Object.keys(prevDay.summary.zt_lb || {});
// 需要行情的票：昨日涨停全部 + 昨日高位板（并集，去重）。只抓这些，不拉全市场。
const need = [...new Set([...prevZt, ...lbCodes])];
console.log(`[pain] 昨日 ${prevDay.trade_date}（涨停 ${prevZt.length} 只、连板票 ${lbCodes.length} 只）`
  + ` → 今日 ${curDay.trade_date}，需抓 ${need.length} 只行情`);

if (!need.length) {
  console.error('[pain] 昨日无涨停/连板名单，无法计算');
  process.exit(1);
}

const { quotes, failed } = await fetchQuotes(need);
console.log(`[pain] 行情取到 ${Object.keys(quotes).length}/${need.length}${failed.length ? `，失败 ${failed.length}` : ''}`);

// 校验行情日期与目标日一致（防止用盘中快照或隔夜数据算收盘表现）
const dates = new Set(Object.values(quotes).map((q) => q.tickDate).filter(Boolean));
if (!dates.has(curDay.trade_date)) {
  console.error(`[pain] ⚠ 行情日期 ${[...dates].join('/')} 与目标日 ${curDay.trade_date} 不一致，拒绝写盘`
    + '（请在收盘后运行）');
  process.exit(2);
}

const report = painReport(prevDay, quotes, {});
report.generatedAt = new Date().toISOString();
report.curDate = curDay.trade_date;

console.log('\n=== 亏钱效应 ===');
console.log(`昨涨停今日表现: 均 ${report.perf.avg}% / 中位 ${report.perf.median}% / 翻绿 ${(report.perf.lossRatio * 100).toFixed(0)}%`
  + ` / 再涨停 ${report.perf.limitUpAgain} / 跌停 ${report.perf.limitDown} / 大面 ${report.perf.bigLoss}`);
console.log(`连板晋级: 失败率 ${(report.advance.failRate * 100).toFixed(0)}% 最高板 ${report.advance.maxLb}`
  + ` | 分层 ${JSON.stringify(report.advance.byTier)}`);
console.log(`大面股 ${report.bigLoss.n} 只 / 天地板 ${report.skyFloor.n} 只`);
console.log(`★ ${report.verdict.label} — ${report.verdict.reason}`);

if (DRY) { console.log('\n[pain] --dry，未写盘'); } else {
  atomicWriteJSON(OUT, JSON.stringify(report, null, 1));
  console.log(`\n[pain] 已写出 ${OUT}`);
}
