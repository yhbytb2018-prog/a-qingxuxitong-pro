#!/usr/bin/env node
// ── 盘后 14 栏目日报断更守卫（scripts/check_reports_gap.mjs · 2026-10-22）──────
//
// 用途：daily.yml 的 23:50 守卫班（cron '50 15 * * 1-5'）终检——当日为交易日而
//   reports_html/ 缺当日文件 → 企微 + issue 双通道告警（复用 src/opsalerts.js
//   pushOpsAlerts，与 check_eastmoney/cross_check 同一通道）。
//
// 用法：node scripts/check_reports_gap.mjs [--date YYYY-MM-DD]   # --date 仅供本地演练
//
// 纪律：观察者不是门禁——判定在 src/reports_gap.js 纯函数层，本脚本只做 IO；
//   恒 exit 0（通知失败也只落日志，绝不拖红 CI）；日历不可判/非交易日静默跳过。
//   issue 兜底由 pushOpsAlerts 内部承接（GITHUB_TOKEN 注入，未配置 OPS_WEBHOOK 时
//   仍有 issue 台账，不静默）。
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pushOpsAlerts } from '../src/opsalerts.js';
import { findReportsGap, beijingYmd, REPORT_LIVE_COLS } from '../src/reports_gap.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const dateArg = (() => { const i = argv.indexOf('--date'); return i >= 0 ? argv[i + 1] : null; })();

// IO：读交易日历 + 扫各栏目目录的 YYYYMMDD.html（目录缺席 = 空列表）
const calendar = (() => {
  try { return JSON.parse(readFileSync(join(ROOT, 'data', 'calendar.json'), 'utf8')); }
  catch { return null; } // 缺席/损坏 → 纯函数层判 null（不告警不臆测）
})();
const filesByCol = {};
for (const col of REPORT_LIVE_COLS) {
  try {
    filesByCol[col] = readdirSync(join(ROOT, 'reports_html', col)).filter((f) => /^\d{8}\.html$/.test(f));
  } catch { filesByCol[col] = []; }
}

const today = dateArg || beijingYmd();
const event = findReportsGap({ today, calendar, filesByCol });
if (!event) {
  console.log(`[reports-gap] ${today} 无断更（非交易日 / 日历不可判 / 当日文件齐全）——不告警`);
  process.exit(0);
}

try {
  const r = await pushOpsAlerts([event]);
  if (r.pushed > 0) console.log('[reports-gap] 断更告警已推送（企微 + issue 兜底）');
  else console.log('[reports-gap] 断更告警未推送：', r.error ?? (r.skipped ? 'OPS_WEBHOOK 未配置（仅落日志；issue 兜底见 pushOpsAlerts 内部行为）' : '无事件'));
} catch (e) {
  console.error('[reports-gap] 告警通道异常（不拖红 CI）:', e?.message ?? e);
}
process.exit(0);
