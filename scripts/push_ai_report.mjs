#!/usr/bin/env node
// ── AI 报告推送入口（S2 · 企微 Webhook + 指纹防风暴，urgent 直达）─────────
//
// 用法：
//   node scripts/push_ai_report.mjs --latest post_market --latest weekly
//        按 data/reports/index.json 最新一期推送（可重复 --latest 多类型）；
//        仅推**新鲜度窗口内**（15 分钟）生成的报告——防把闸门跳过后残留的
//        上一期旧报告当新一期重推（旧内容另有指纹去重兜底，双保险）。
//   node scripts/push_ai_report.mjs data/reports/intraday_2026-10-08.json
//        显式文件推送（无新鲜度检查——点名要推的就是要推）。
//
// 通道：env OPS_WEBHOOK（现有运维企微机器人，零新增 secret；未配置 → 静默跳过）。
// 纪律：永不因推送失败退出非零（推送不炸数据管线；失败不记指纹 → 下拍自愈重试）；
//   仅参数错误（index 缺类型/文件不存在）exit 1——那是配置问题，必须红出来。
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pushReports, PUSH_CONSTS } from '../src/ai_report_push.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports');
const INDEX_FILE = join(REPORTS_DIR, 'index.json');
const STATE_FILE = join(REPORTS_DIR, 'push_state.json');

const argv = process.argv.slice(2);
const latestTypes = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--latest' && argv[i + 1]) { latestTypes.push(argv[i + 1]); i += 1; }
}
const files = argv.filter((a, i) => a !== '--latest' && argv[i - 1] !== '--latest');
if (!latestTypes.length && !files.length) {
  console.error('[ai-report-push] 缺参数：--latest <type>（可重复）或显式报告文件路径');
  process.exit(1);
}

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const reports = [];

for (const f of files) {
  const p = f.startsWith('data/') || f.startsWith('/') ? resolve(ROOT, f) : resolve(process.cwd(), f);
  if (!existsSync(p)) { console.error(`[ai-report-push] 文件不存在: ${f}`); process.exit(1); }
  reports.push(readJson(p));
}

if (latestTypes.length) {
  if (!existsSync(INDEX_FILE)) { console.error('[ai-report-push] data/reports/index.json 不存在（先跑 build_ai_report.mjs）'); process.exit(1); }
  const index = readJson(INDEX_FILE);
  const now = Date.now();
  for (const type of latestTypes) {
    const entry = index.reports?.[type];
    if (!entry?.file) { console.error(`[ai-report-push] index 中无 ${type} 类型（先跑 build_ai_report.mjs --type ${type}）`); process.exit(1); }
    const p = join(REPORTS_DIR, entry.file);
    const report = readJson(p);
    // 新鲜度窗口：只推"本次运行刚生成"的（generated_at 距今 ≤ 15 分钟）
    const age = now - Date.parse(report.generated_at);
    if (!Number.isFinite(age) || age > PUSH_CONSTS.FRESH_WINDOW_MS) {
      console.log(`[ai-report-push] ${type} ${entry.date} 生成于 ${report.generated_at}（超出 ${PUSH_CONSTS.FRESH_WINDOW_MS / 60000} 分钟新鲜度窗口）→ 疑为上一期残留，跳过推送`);
      continue;
    }
    reports.push(report);
  }
}

if (!reports.length) {
  console.log('[ai-report-push] 无待推报告（全部跳过），结束。');
  process.exit(0);
}

const { results, pushed, skipped } = await pushReports(reports, { stateFile: STATE_FILE });
for (const r of results) console.log(`[ai-report-push] ${r.type} ${r.date}: ${r.pushed ? '已推送' : '未推送'}（${r.reason}）`);
console.log(`[ai-report-push] 完成：推 ${pushed} / 跳 ${skipped} · 状态落 ${'data/reports/push_state.json'} · 通道 ${PUSH_CONSTS.WEBHOOK_ENV}${process.env[PUSH_CONSTS.WEBHOOK_ENV] ? '' : '（未配置 → 仅落盘）'}`);
