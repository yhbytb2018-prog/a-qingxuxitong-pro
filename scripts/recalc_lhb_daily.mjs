// 存量全档重算：龙虎榜「双口径」+ 情绪因子。
//
// 起因：东财龙虎榜一次披露里混装两类榜单，字段语义不同 ——
//   ① 当日榜（日涨幅偏离 7% / 换手 20% / 振幅 15% / 无涨跌幅限制…）：席位买卖与净额都是当日口径（权威）；
//   ② 区间累计榜（"连续 3/10 个交易日涨跌幅偏离值累计达 X%"）：是区间累计值，
//      且 BILLBOARD_BUY_AMT 被填成区间累计成交额（2026-09-30 近岸蛋白 10 日榜 BUY==SELL==ACCUM==116.97 亿、净额 0）。
//
// 本脚本做三件事，全部走同一个口径实现（src/lhb.js），不另写一份判断：
//   1. 把双口径字段写回 summary（lhb_daily_* 权威 / lhb_all_net 诊断），并清掉歧义字段名 net_total_yi；
//      同时给每条原始记录补 is_range、给聚合行补 caliber，让 UI 能标注「区间」。
//   2. 用当日榜净额重算七因子情绪分（改口径前 s_net 喂的是含区间榜的全量净额，
//      会让日度因子把三天累计当成一天：2026-09-08 当日榜 -0.11 亿 vs 全量 +13.42 亿 → s_net 48.9 → 99.5）。
//   3. 重算题材与主线资金占比（分母同样改用当日榜）。
//
// 存量 lhb 记录没有 BILLBOARD_DEAL_AMT，但当日榜记录满足 DEAL == BUY + SELL（已对源核验），由 lhb.js 回退。
//
// 用法：node scripts/recalc_lhb_daily.mjs [--dry]
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { caliberFromDay, isRangeBoard, mergeDuplicateRecords, duplicateKeys } from '../src/lhb.js';
import { recalcAll, enrich } from '../src/pipeline.js';
import { decodeArchive, writeArchiveSafely, appendNote } from '../src/lhb_codec.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = path.join(ROOT, 'data', 'archive.json');
const DRY = process.argv.includes('--dry');
const nf = (v) => (v == null ? '—' : Number(v).toFixed(2));

const a = decodeArchive(JSON.parse(readFileSync(P, 'utf8')));
const days = a.all_days || [];
// 幂等判据：重算前后数据完全一致就不写盘（否则每次运行都追加一条 meta.note，产生噪音提交）
const signature = () => JSON.stringify({ d: a.all_days, m: a.signals?.momentum, n: a.meta?.note || '' });
const beforeSig = signature();
const rows = [];

for (const day of days) {
  // 1) 原始记录自描述：存量记录没有 is_range，按 reason 现判并写回（此后任何读取都不必再猜）
  for (const l of day.lhb || []) if (l.is_range == null) l.is_range = isRangeBoard(l.reason);
  // 1b) 同票多榜去重：东财同一次披露里同票多榜且数值常完全相同（2026-08-14 蓝盾光电 300862 两条
  //     净额都是 37382.3 万）。lhb 原始数组是 picks/paper/lhbfilter/fetch_universe 的共同入口，
  //     不合并则任何 `reduce(净买)` 都会双算。判据与实现全部走 src/lhb.js（五元组同值）。
  const rawBefore = Array.isArray(day.lhb) ? day.lhb.length : 0;
  const rawMerged = mergeDuplicateRecords(day.lhb || []);
  // 补 is_range 后再合并（mergeDuplicateRecords 的判据依赖它，缺失会被当成 daily 而与区间榜混并）
  day.lhb = rawMerged;
  const rawAfter = day.lhb.length;
  const dups = duplicateKeys(day.lhb);
  if (dups.length) throw new Error(`${day.trade_date} 合并后仍存在重复记录：${dups.slice(0, 3).join(' | ')}`);

  const c = caliberFromDay(day);
  if (!c.total_records) continue;
  const mergedAway = Math.max(0, rawBefore - rawAfter);

  // 2) 聚合行带口径标签 + 全部上榜原因
  //
  // ⚠ 体积纪律（本处曾造成主档翻倍的实证 bug，勿回退）：
  //   `c.all_aggr` 是**派生数据**——它可由 day.lhb（原始记录）完全重建：
  //   src/lhb.js 的 caliberFromDay 在缺 lhb_aggr 时会自动回退到 day.lhb 现算
  //   （见 lhb.js:263 起的「明细优先 / 回退」分支）。而 app.js 各处读取也统一写作
  //   `day.lhb_aggr || day.lhb || []`，即**消费方本就不依赖它被持久化**。
  //
  //   若把它写进档：每只上榜个股约 250 字节 × 平均 70 只 ≈ 17.5 KB/天，
  //   241 天累计 ≈ 4.2 MB —— 实测主档从 5.28MB 膨胀到 10.9MB（**翻倍**），
  //   而运行时行为零变化（因为读的地方都有回退）。这是纯浪费，且制造出
  //   "有的天有 lhb_aggr、有的天没有"的第三种不一致形态。
  //
  //   故此处**只算不存**：c.all_aggr 仅在 caliberFromDay 内部消费（它自己会重算），
  //   本脚本不依赖持久化的 lhb_aggr，故直接剔除。
  delete day.lhb_aggr;   // 显式清除存量（老档可能已被上一版脚本写脏）

  const s = (day.summary = day.summary || {});
  const beforeDaily = s.lhb_daily_net ?? null;
  const beforeAll = s.lhb_all_net ?? s.net_total_yi ?? null;
  delete s.net_total_yi;                    // 歧义字段名：不带口径后缀，一律清除
  s.lhb_count = c.total_records;
  s.lhb_raw_count = rawBefore;              // 东财原始披露条数
  s.lhb_merged_away = mergedAway;           // 被合并掉的同票同值重复条数
  s.lhb_stocks = c.all_stocks;
  s.lhb_all_net = c.all_net_yi;
  s.net_pos = c.all_pos;
  s.net_neg = c.all_neg;
  s.lhb_daily_stocks = c.daily_stocks;
  s.lhb_daily_net = c.daily_net_yi;
  s.lhb_daily_amt = c.daily_amt_yi;
  s.lhb_range_count = c.range_records;

  const e = (day.emotion = day.emotion || {});
  const beforeFactor = e.factors?.s_net ?? null;
  delete e.net_total_yi;
  delete e.net_pct_rank;
  e.lhb_daily_net = c.daily_net_yi;

  rows.push({
    date: day.trade_date,
    records: c.total_records, raw: rawBefore, mergedAway, range: c.range_records,
    allNet: c.all_net_yi, dailyNet: c.daily_net_yi, dailyAmt: c.daily_amt_yi,
    dailyStocks: c.daily_stocks,
    rate: c.daily_amt_yi > 0 ? `${(c.daily_net_yi / c.daily_amt_yi * 100).toFixed(1)}%` : '—',
    beforeDaily, beforeAll, beforeFactor,
  });
}

// 3) 题材 + 主线资金占比（分母改当日榜）→ 复用在线管道的同一个 enrich
const { out, momObj } = enrich(days);
a.all_days = out;
if (a.signals) a.signals.momentum = momObj;

// 4) 全档因子重算（口径：netBuy = 当日榜净额）+ 分位重算
recalcAll(a.all_days);

console.log('日期         原始  合并  记录  区间  当日只数  当日净额   全量净额   当日成交   净买率   s_net 前→后');
for (const r of rows) {
  const d = a.all_days.find((x) => x.trade_date === r.date);
  const afterFactor = d?.emotion?.factors?.s_net ?? null;
  console.log(`${r.date}  ${String(r.raw).padStart(4)}  ${String(r.mergedAway).padStart(4)}  `
    + `${String(r.records).padStart(4)}  ${String(r.range).padStart(4)}  ${String(r.dailyStocks).padStart(8)}  `
    + `${nf(r.dailyNet).padStart(8)}  ${nf(r.allNet).padStart(8)}  ${nf(r.dailyAmt).padStart(8)}  ${r.rate.padStart(6)}  `
    + `${nf(r.beforeFactor)}→${nf(afterFactor)}`);
}
const changed = a.all_days.filter((d, i) => {
  const b = rows.find((r) => r.date === d.trade_date);
  return b && Math.abs((b.beforeFactor ?? -1) - (d.emotion?.factors?.s_net ?? -2)) > 0.05;
}).length;
const nsChanged = a.all_days.filter((d) => d.emotion?.newStock?.adjusted).length;
const totalMerged = rows.reduce((a, r) => a + r.mergedAway, 0);
console.log(`\n共 ${rows.length} 天；s_net 因子值发生变化 ${changed} 天`
  + `（口径：含区间累计榜 → 当日榜 → **当日榜且剔除新股**）；`
  + `其中因剔除新股而修正的 ${nsChanged} 天。`);
console.log(`同票多榜重复披露合并：合计合并掉 ${totalMerged} 条（东财原始 ${rows.reduce((a, r) => a + r.raw, 0)} 条`
  + ` → 合并后 ${rows.reduce((a, r) => a + r.records, 0)} 条）。`);

if (DRY) { console.log('（--dry：仅预览，未写盘）'); process.exit(0); }
a.meta = a.meta || {};
const stamp = new Date().toISOString().slice(0, 10);
// 先按迁移标记词清掉**历史改名前**的旧版留痕段（appendNote 的签名替换只认内容相同的段，
// 历史版本文案不同的段只能靠关键词迁移清理）；再走 appendNote 做签名去重追加。
const STALE = /龙虎榜双口径全档重算|当日榜净额输入|lhb_daily_\*|lhb_all_net|剔除新股|同票多榜合并/;
const entry = '龙虎榜双口径全档重算＋同票多榜合并：当日榜口径写入 lhb_daily_*（权威）、全量口径改名 lhb_all_net（仅诊断）、'
  + '清除歧义字段 net_total_yi；lhb 原始数组按五元组(code+is_range+净额+买+卖)同值合并、reasons 数组化，'
  + '消灭同票多榜的重复披露（否则下游按 code 求净买会双算）；情绪因子 s_net 改为「当日榜且剔除新股」净额输入'
  + `（新股/无涨跌幅限制标的自动剥离并留痕 emotion.newStock），${rows.length} 天，${stamp}`;
a.meta.note = String(a.meta.note || '').split('；').map((s) => s.trim()).filter(Boolean)
  .filter((s) => !STALE.test(s)).join('；');
a.meta.note = appendNote(a, entry);
if (signature() === beforeSig) {
  console.log('存档已是最新口径（无实际变化），未写盘。');
  process.exit(0);
}
// 必须重编码写回（直接 stringify 会把压缩档解压成 9.2MB 且丢掉 rc 的可读性）
writeArchiveSafely(P, a, { writeFileSync, renameSync, unlinkSync });
console.log(`已写回 ${path.relative(ROOT, P)}`);
