// 历史龙虎榜回填（12 个月 ≈ 240 交易日）
//
// ── 为什么需要 ────────────────────────────────────────────────────────────────
// 分位（pct_rank / net_daily_pct_rank）是**相对指标**：样本只有 33 天时，"分位 80"
// 只是"在这 33 天里排第 27"，统计意义几乎为零。原始 a-sentiment 就吃过这个亏。
// 东财 RPT_DAILYBILLBOARD_DETAILSNEW 支持任意历史交易日，故可一次性把龙虎榜
// 明细补齐到 12 个月，让分位立刻有统计意义。
//
// ── 回填粒度（用户决策：只重算 s_net，其余六因子保原值）────────────────────────
// 历史天**除 lhb 外的原始数据本就不存在**（pools/breadth/industry 都没抓过）。
// 若走 recalcAll 全量重算：
//   · s_hot / s_zdt / s_zbl（缺涨跌停池）→ 退化为中性 50
//   · s_pos（缺涨跌家数）→ 退化为中性 50
//   · s_brd（缺行业涨比）→ 退化为中性 50
//   · 甚至可能触发 emotion._legacy
// 这会让"综合分曲线"变成"一半真一半假"，分位基线与因子基线的变动互相污染，
// 也会让后续「公式版本对比」失去可解释性。
//
// 故本脚本**只做两件事**：
//   1) 填 lhb 相关字段（summary.lhb_daily_*、lhb_new_*、lhb_count 等）+ 真实 s_net；
//   2) 全部天（含原有 33 天）重算 pct_rank / net_daily_pct_rank。
// 其余六因子对原有天**一个字节都不动**。
//
// ── 历史天 emotion 占位 ──────────────────────────────────────────────────────
// validateArchive 要求每天 emotion.score/value 是 0~100 数值、hot 是数组。
// 历史天没有六因子，无法构成有效综合分，故：
//   · emotion._backfill = true  ← 前端/报告据此过滤，不展示、不引用
//   · emotion.value / score = s_net 单因子值  ← 仅占位满足校验，**不是**综合分
//   · e.lhb_daily_net 写真实值  ← 它是 net_daily_pct_rank 的入参，必须有真值
//   · hot = []                  ← 未采集，空数组
//
// ── 幂等 ─────────────────────────────────────────────────────────────────────
// 已存在的天（无论完整档还是回填档）默认跳过，除非 --overwrite。
// 回填档再次运行 = 恒等（不重抓、不重写），signature 不变则连盘都不写。
//
// 用法：
//   node scripts/backfill_lhb_history.mjs --months 12            # 正式回填写盘
//   node scripts/backfill_lhb_history.mjs --months 12 --dry      # 只抓不写，打印统计
//   node scripts/backfill_lhb_history.mjs --since 2025-10-01     # 指定起始日
//   node scripts/backfill_lhb_history.mjs --months 12 --overwrite # 覆盖已有天
//   node scripts/backfill_lhb_history.mjs --months 1 --no-ranks  # 不重算分位（调试用）

import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fetchLhb, LhbNotPublishedError, recalcRanks } from '../src/sources.js';
import { buildBackfillDay, BACKFILL_FLAG } from '../src/backfill.js';
import { sleep, todayBeijing } from '../src/util.js';
import { decodeArchive, encodeArchive, buildReasonCodes, writeArchiveSafely } from '../src/lhb_codec.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const ARCHIVE = resolve(ROOT, 'data/archive.json');

// ── 参数解析 ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { months: 12, since: null, dry: false, overwrite: false, ranks: true, delay: 220 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--months') out.months = Number(argv[++i]);
    else if (a === '--since') out.since = argv[++i];
    else if (a === '--dry') out.dry = true;
    else if (a === '--overwrite') out.overwrite = true;
    else if (a === '--no-ranks') out.ranks = false;
    else if (a === '--delay') out.delay = Number(argv[++i]);
  }
  return out;
}

// 日期工具（本地实现，不引第三方；全部走 UTC 运算避免时区漂移）
const ymd = (d) => d.toISOString().slice(0, 10);
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}
function addMonths(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + n);
  return ymd(d);
}

// 枚举候选日期：从 start 到 end（含）逐自然日。
// 交易日判定**不依赖日历表**——直接看接口：success:true 即交易日。
// 实测非交易日（如 2026-08-01 周六）返回 success:false + message "返回数据为空"。
function dateRange(start, end) {
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

// 判断东财是否"该日无数据"（非交易日 / 尚未披露）
function isNoData(err) {
  return err && (err.name === 'LhbNotPublishedError' || /返回数据为空/.test(err.message || ''));
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(ARCHIVE)) {
    console.error(`[backfill] 找不到 ${ARCHIVE}`);
    process.exit(1);
  }
  const arc = decodeArchive(JSON.parse(readFileSync(ARCHIVE, 'utf8')));
  const days = arc.all_days;
  const have = new Set(days.map((d) => d.trade_date));
  const lastKnown = days.reduce((m, d) => (d.trade_date > m ? d.trade_date : m), '');

  const today = todayBeijing();
  const start = args.since || addMonths(today, -args.months);
  const end = lastKnown ? addDays(lastKnown, -1) : today;

  console.log(`[backfill] 目标区间 ${start} ~ ${end}（已有最新档 ${lastKnown}）`);
  console.log(`[backfill] 已存档 ${days.length} 天；模式 ${args.dry ? 'DRY-RUN' : '写盘'}${args.overwrite ? ' +覆盖' : ''}`);

  const candidates = dateRange(start, end);
  console.log(`[backfill] 候选自然日 ${candidates.length} 天，开始逐个探测…`);

  const added = [];
  const skippedHave = [];
  const skippedFull = [];
  const skippedNoData = [];
  const failed = [];

  // 完整档（有六因子的正式天）与回填档要分开看待：
  //   · 完整档：**任何情况下都不覆盖**——回填天只有 lhb+s_net，覆盖会丢掉六因子与综合分。
  //     这是不可逆的数据损失，故这里硬拦，不提供「覆盖完整档」的开关。
  //   · 回填档：默认跳过（幂等），--overwrite 时重抓（用于修正字段口径，如 lhb_raw_count）。
  const fullSet = new Set(
    days.filter((d) => !(d.emotion && d.emotion[BACKFILL_FLAG])).map((d) => d.trade_date),
  );

  for (let i = 0; i < candidates.length; i++) {
    const date = candidates[i];
    const tag = `[${String(i + 1).padStart(3)}/${candidates.length}] ${date}`;
    if (fullSet.has(date)) {
      skippedFull.push(date);
      process.stdout.write(`${tag} 完整档，保护性跳过\n`);
      continue;
    }
    if (have.has(date) && !args.overwrite) {
      skippedHave.push(date);
      process.stdout.write(`${tag} 已有，跳过\n`);
      continue;
    }
    try {
      const raw = await fetchLhb(date);
      if (!raw || !raw.length) {
        skippedNoData.push(date);
        process.stdout.write(`${tag} 无数据（非交易日/未披露）\n`);
      } else {
        const day = buildBackfillDay(date, raw);
        added.push(day);
        process.stdout.write(
          `${tag} ✓ 原始 ${day.summary.lhb_raw_count} → 合并 ${day.lhb.length} 条 · `
          + `当日榜净买 ${day.summary.lhb_daily_net} 亿 · s_net ${day.emotion.s_net}\n`,
        );
      }
    } catch (err) {
      if (isNoData(err)) {
        skippedNoData.push(date);
        process.stdout.write(`${tag} 无数据（${err.message || '空'}）\n`);
      } else {
        failed.push({ date, msg: err.message });
        process.stdout.write(`${tag} ✗ 失败：${err.message}\n`);
      }
    }
    await sleep(args.delay);
  }

  console.log('');
  console.log(`[backfill] 汇总：新增/覆盖 ${added.length} 天 / 完整档保护 ${skippedFull.length} 天 / `
    + `回填档已有跳过 ${skippedHave.length} 天 / 无数据 ${skippedNoData.length} 天 / 失败 ${failed.length} 天`);
  if (failed.length) {
    console.log('[backfill] 失败明细（可重跑补齐）：');
    for (const f of failed) console.log(`  · ${f.date} ${f.msg}`);
  }
  if (!added.length) {
    console.log('[backfill] 无新增，未改盘。');
    return;
  }

  // 合并：以原有天为基底，新回填天**按日期替换**同日的旧条目，再按日期升序。
  //
  // ⚠ 早期实现写成 `[...days, ...added]`（纯追加）——在 --overwrite 下会让同一天出现两次
  //   （原档一份 + 新抓一份），档案天数凭空翻倍，分位分母也跟着翻倍。
  //   改成 Map 后「追加」与「覆盖」语义统一：日期是主键，同键必然替换。
  const byDate = new Map(days.map((d) => [d.trade_date, d]));
  let replaced = 0;
  for (const d of added) {
    if (byDate.has(d.trade_date)) replaced++;
    byDate.set(d.trade_date, d);
  }
  const merged = [...byDate.values()].sort((a, b) => (a.trade_date < b.trade_date ? -1 : 1));
  if (replaced) console.log(`[backfill] 覆盖同日 ${replaced} 天（--overwrite）`);

  // 自检：合并后日期必须唯一。真出现重复说明上面的 Map 被绕过，宁可停在这里也不写坏档。
  const uniq = new Set(merged.map((d) => d.trade_date));
  if (uniq.size !== merged.length) {
    console.error(`[backfill] ✗ 致命：合并后日期不唯一（${merged.length} 条 / ${uniq.size} 个日期），已中止写盘。`);
    process.exit(1);
  }

  // 重算分位（唯一实现来自 sources.js；不自己写排序公式）
  if (args.ranks) {
    // 前提：所有天的 emotion.lhb_daily_net 必须可读（原有天已有，回填天刚写入）
    const bad = merged.filter((d) => !d.emotion || d.emotion.lhb_daily_net == null);
    if (bad.length) {
      console.log(`[backfill] ⚠ ${bad.length} 天缺 emotion.lhb_daily_net（分位分母会含 null），列出前 5：`);
      for (const d of bad.slice(0, 5)) console.log(`  · ${d.trade_date}`);
    }
    recalcRanks(merged);
    const rs = merged.map((d) => d.emotion.pct_rank).filter((x) => typeof x === 'number');
    const rsN = merged.map((d) => d.emotion.net_daily_pct_rank).filter((x) => typeof x === 'number');
    console.log(`[backfill] 分位重算完成：pct_rank 覆盖 ${rs.length}/${merged.length} 天，`
      + `net_daily_pct_rank 覆盖 ${rsN.length}/${merged.length} 天`);
  } else {
    console.log('[backfill] --no-ranks：跳过分位重算');
  }

  // 累计回填天数按**实际标记**统计（而不是本次新增数）——重跑时 added 可能为 0，
  // 但档案里的回填天依然存在，meta 必须如实反映存量。
  const bfTotal = merged.filter((d) => d.emotion && d.emotion[BACKFILL_FLAG]).length;
  const fullTotal = merged.length - bfTotal;
  console.log(`[backfill] 档案结构：完整档 ${fullTotal} 天 · 回填档 ${bfTotal} 天 · 合计 ${merged.length} 天`);

  const out = {
    ...arc,
    meta: {
      ...arc.meta,
      backfill: {
        version: 1,
        ranAt: new Date().toISOString(),
        range: [start, end],
        addedDays: added.length,
        backfilledDays: bfTotal,
        fullDays: fullTotal,
        totalDays: merged.length,
        noDataDays: skippedNoData.length,
        failedDays: failed.length,
        note: '历史龙虎榜回填：仅补 lhb 与 s_net，其余六因子未采集，页面与报告按 emotion._backfill 过滤不展示',
      },
    },
    all_days: merged,
  };

  if (args.dry) {
    console.log('[backfill] DRY-RUN：不写盘。');
    return;
  }

  const before = readFileSync(ARCHIVE, 'utf8');
  // ⚠ `out` 是**解码后**的明文态（读进来时 decodeArchive 过），直接 stringify 写回会把
  //   压缩档解压成 9.2MB 明文。必须重编码 + 写前往返自检（见 writeArchiveSafely）。
  const after = JSON.stringify(encodeArchive(out, buildReasonCodes(out.all_days)));
  const mb = (s) => (Buffer.byteLength(s, 'utf8') / 1024 / 1024).toFixed(2);
  if (before === after) {
    console.log('[backfill] 内容无变化，未写盘。');
    return;
  }
  const info = writeArchiveSafely(ARCHIVE, out, { writeFileSync, renameSync, unlinkSync });
  console.log(`[backfill] 已写盘 ${ARCHIVE}：${mb(before)}MB → ${mb(after)}MB，`
    + `总天数 ${days.length} → ${merged.length}（码表 ${info.codes} 条 · 往返自检通过）`);
}

main().catch((e) => {
  console.error('[backfill] 致命错误：', e);
  process.exit(1);
});
