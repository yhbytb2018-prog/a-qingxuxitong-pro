// 幂等 / 重抓 / 重算范围报告（#1）
//
// 只读诊断脚本：不抓网络、不写盘。回答三个问题——
//   ① 我手上这份档案，凭什么可信、够不够新？（抓取凭据）
//   ② 这一轮真正需要重抓哪几天？（防重复抓）
//   ③ 重算哪几天就够？历史天会不会漂移？（重算范围 + 幂等实证）
//
// ── 用法 ───────────────────────────────────────────────────────────────────
//   node scripts/need_rebuild.mjs                      # 只读报告
//   node scripts/need_rebuild.mjs --json               # 机器可读（供 CI 判定）
//   node scripts/need_rebuild.mjs --now 2026-10-08T22:00
//                                                      # 指定"当前时刻"（北京时间），
//                                                      # 用于测试/复现定稿窗口判定
//   node scripts/need_rebuild.mjs --verify             # 追加做一次"重算幂等实证"：
//                                                      # 清空 emotion 派生字段后重跑
//                                                      # recalcAll，比较历史天是否漂移
//
// ⚠ 本脚本**不修改任何文件**。--verify 的重算全在内存里做（用主档的深拷贝），
//   结果只打印。要真正回写存量档用 scripts/recalc_lhb_daily.mjs。
//
// ⚠ 读主档必须走 decodeArchive：主档是码表压缩态，直接读 raw 会让 caliberFromDay
//   的 isRangeBoard 拿不到中文原文而静默失配（区间榜被当当日榜）。这是本项目
//   反复踩过的坑，故本脚本一律先 decode。

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeArchive } from '../src/lhb_codec.js';
import { bjStamp, bjInstant } from '../src/time.js';
import { recalcAll } from '../src/pipeline.js';
import {
  digestCompare, dayFingerprint, needFetch, computeRecomputeScope, IDEMPOTENCE_LIMITS,
} from '../src/idempotence.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname + '/..';

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const AS_JSON = has('--json');
const VERIFY = has('--verify');
/** --now 传的是**北京时间**（人类可读），用于复现"定稿窗口"判定。 */
const NOW_ARG = argOf('--now', '') || null;

function resolveNow() {
  if (!NOW_ARG) return new Date();
  const s = NOW_ARG.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(s);
  if (!m) {
    console.error(`[need-rebuild] --now 无法解析：${NOW_ARG}（期望 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm）`);
    process.exit(2);
  }
  const [, y, mo, d, hh = '00', mm = '00'] = m;
  // 北京墙上时刻 → 绝对时间点（换算收敛至 src/time.js；中国无夏令时，固定 UTC+8 偏移）。
  return new Date(bjInstant(`${y}-${mo}-${d}`, `${hh}:${mm}`));
}

const mainPath = join(ROOT, 'data', 'archive.json');
if (!existsSync(mainPath)) {
  console.error('[need-rebuild] 找不到主档 data/archive.json');
  process.exit(2);
}
const archive = decodeArchive(JSON.parse(readFileSync(mainPath, 'utf8')));
const days = archive.all_days || [];
const now = resolveNow();

// ── ① 抓取凭据：最近出现的交易日 ──────────────────────────────────────────
const sorted = days.slice().sort((a, b) => (a.trade_date < b.trade_date ? -1 : 1));
const latest = sorted[sorted.length - 1] || null;
const prev = sorted.length >= 2 ? sorted[sorted.length - 2] : null;

const fetchTargets = [latest, prev].filter(Boolean).map((d) => ({
  date: d.trade_date,
  lhb_stocks: d.summary?.lhb_stocks ?? null,
  seats_cover: d.summary?.seats?.cover ?? null,
  ...needFetch(d, { now }),
}));

// ── ② 重算范围 ─────────────────────────────────────────────────────────────
const scope = computeRecomputeScope(days);

// ── ③ 幂等实证（可选）─────────────────────────────────────────────────────
let verify = null;
if (VERIFY) {
  // ⚠ 这一步的**取证纪律**：只清空「重算会重建的东西」，绝不碰「重算要读的凭据」。
  //
  //   踩过的坑（实测，别回退）：第一版为了"逼 recalcAll 真的重算"，把 emotion 整段
  //   压成 `{ value, score }`。结果 241/241 天全报"漂移"——但根因不是代码有问题，
  //   而是**我把证据删了**：recalcAll 需要 `emotion.hot_count` / `industryCount` 作为
  //   "这一天到底采过没采过强势股/行业"的凭据（用于区分"真 0"与"未采集"），
  //   凭据被抹掉 → 重算只能判定"未采集" → 字段整组消失 → 指纹报差异。
  //   这类"守卫自身的 bug 伪装成被测对象的 bug"最危险：它会让人去改本来正确的代码。
  //   教训：**验证工具与被测对象共享同一份证据链时，工具必须只破坏"输出"不破坏"输入"。**
  //
  //   故此处只做两件安全的事：
  //     ① 清空**纯派生**的分位字段（它们是 recalcAll 末尾算的，且不参与任何输入）——
  //        这样若有"分位仍依赖未来"，它会在重算后算出不同值而暴露；
  //     ② 清空 summary.industry_relative（同理，纯派生、仅输出）。
  //   数值因子（s_net 等）**不清**：若要连它们一起验，应另开一项并显式说明
  //   "本项会破坏因子留痕，结论仅看 score 与 pct_rank"——而不是悄悄混在一次验证里。
  const clone = JSON.parse(JSON.stringify(days));
  clone.forEach((d) => {
    if (d.emotion) {
      delete d.emotion.pct_rank;
      delete d.emotion.net_daily_pct_rank;
    }
    if (d.summary) delete d.summary.industry_relative;
  });
  recalcAll(clone);
  verify = {
    ...digestCompare(days, clone),
    limits: IDEMPOTENCE_LIMITS,
    scopeOfCheck: '清空 emotion.pct_rank / net_daily_pct_rank / summary.industry_relative 后全档重算，'
      + '比较全部历史日是否逐字段未变。**不**清空因子与凭据字段（那会破坏输入，导致假漂移）。',
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  nowBeijing: bjStamp(now),
  archive: {
    totalDays: days.length,
    firstDate: sorted[0]?.trade_date ?? null,
    latestDate: latest?.trade_date ?? null,
    generatedAt: archive.meta?.generatedAt ?? null,
    freshnessState: archive.meta?.freshness?.state ?? null,
  },
  fetch: {
    targets: fetchTargets,
    needCount: fetchTargets.filter((t) => t.need).length,
    note: '凭据式判定：看"已落盘的证据"（龙虎榜条数/席位覆盖率/是否过定稿时刻），不看"第几次运行"。'
      + '定稿时刻默认当日 21:00 北京时间（龙虎榜 18:30 首抓 / 21:00 补抓）。',
  },
  rescan: scope,
  verify,
  notes: [
    '本报告不修改任何文件；--verify 的重算全部在内存里做。',
    '重算范围能缩小的前提是"分位只看到 T 日为止"（src/sources.js windowedPctRank）。',
    '若 verify.status = changed，说明历史天会漂移 —— 此时**不得**缩小重算范围，须先查根因。',
  ],
};

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const r = report;
  console.log('══ 幂等 / 抓取 / 重算范围报告（#1）══');
  console.log(`  当前时刻（北京）  ${r.nowBeijing}`);
  console.log(`  档案               ${r.archive.totalDays} 天  ${r.archive.firstDate} → ${r.archive.latestDate}`);
  console.log(`  主档新鲜度         ${r.archive.freshnessState || '未知'}`);
  console.log('');
  console.log('── ① 抓取凭据 ─────────────────────────────────────');
  for (const t of r.fetch.targets) {
    console.log(`  ${t.date}  ${t.need ? '需重抓' : '可跳过'}  [${t.kind}]`);
    console.log(`      龙虎榜 ${t.lhb_stocks == null ? '未知' : t.lhb_stocks} 条 · 席位覆盖 ${t.seats_cover == null ? '未知' : t.seats_cover + '%'}`);
    console.log(`      ${t.reason}`);
  }
  console.log(`  → ${r.fetch.needCount} / ${r.fetch.targets.length} 个目标需要抓取`);
  console.log('');
  console.log('── ② 重算范围 ─────────────────────────────────────');
  console.log(`  ${r.rescan.full ? '全档' : '增量'} ${r.rescan.dates.length} / ${r.archive.totalDays} 天：${r.rescan.dates.join('、') || '（无）'}`);
  console.log(`  ${r.rescan.reason}`);
  console.log('');
  if (r.verify) {
    console.log('── ③ 幂等实证（重算历史天是否漂移）─────────────────');
    console.log(`  判定  ${r.verify.status}  ·  可比 ${r.verify.checkedDays} 天  ·  新增 ${r.verify.added.length}  ·  删除 ${r.verify.removed.length}`);
    console.log(`  ${r.verify.reason}`);
    if (r.verify.status === 'changed') {
      console.log('  ⚠ 历史天发生漂移 —— 必须先查根因，不得缩小重算范围。');
    }
    console.log('');
  }
  console.log('注：本报告不修改任何文件；不构成投资建议。');
}
