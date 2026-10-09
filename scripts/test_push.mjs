#!/usr/bin/env node
// ── 推送链路自检（零污染 · 2026-10-07）────────────────────────────────────
//
// 目的：不动 CI、不写任何状态/数据档，验证企微 Webhook 端到端连通性与消息格式。
//   适用场景：配置/更换机器人后先测一发、明天首跑前的最后确认、换群换 secret 后回归。
//
// 用法（本地 PowerShell）：
//   $env:OPS_WEBHOOK='https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=你的KEY'
//   node scripts/test_push.mjs            # 两条通道都测（AI 报告 + 运维告警）
//   node scripts/test_push.mjs --report   # 仅 AI 报告通道
//   node scripts/test_push.mjs --alert    # 仅运维告警通道
//
// 零污染保证（不影响明天首跑）：
//   · AI 报告通道：pushReports({ stateFile: null })——走完整生产链路
//     （renderPushText 渲染 + 企微 text 格式 + fetch），但**不创建/不写**
//     data/reports/push_state.json（正式首跑照常首建，指纹世界从零开始）；
//   · 运维告警通道：pushOpsAlerts + 纯内存合成事件——**不调 writeOpsAlerts**，
//     data/ops-alerts-latest.json 一字不动；
//   · 两条通道读的都是 env OPS_WEBHOOK（与 CI 同名同值，测通即 CI 通）。
//
// 安全提示：webhook URL 只应出现在你本地终端/环境变量里，
//   不要贴进对话、提交进仓库。泄露了去群设置里删除机器人重建即可。
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pushReports, renderPushText } from '../src/ai_report_push.js';
import { pushOpsAlerts } from '../src/opsalerts.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_REPORT = join(ROOT, 'data', 'reports', 'post_market_2026-09-30.json');

const argv = process.argv.slice(2);
const wantReport = argv.includes('--report') || argv.length === 0;
const wantAlert = argv.includes('--alert') || argv.length === 0;

if (!process.env.OPS_WEBHOOK) {
  console.error('[test-push] 未设置 env OPS_WEBHOOK——先在终端设好再跑（见脚本头注释用法）');
  process.exit(1);
}

// ── 通道 1：AI 报告（推 09-30 盘后示例 → 群里看到的就是明晚 21:00 消息的样子）──
if (wantReport) {
  if (!existsSync(SAMPLE_REPORT)) {
    console.error('[test-push] 示例报告缺失: data/reports/post_market_2026-09-30.json');
    process.exit(1);
  }
  const report = JSON.parse(readFileSync(SAMPLE_REPORT, 'utf8'));
  console.log('[test-push] AI 报告通道：推送 09-30 盘后示例（stateFile: null，不记指纹）\n--- 推送文案预览 ---');
  console.log(renderPushText(report));
  console.log('---');
  const r = await pushReports([report], { stateFile: null });
  for (const x of r.results) {
    console.log(`[test-push] → ${x.type} ${x.date}: ${x.pushed ? '推送成功' : `未推送（${x.reason}）`}`);
  }
}

// ── 通道 2：运维告警（合成一条 error 测试事件，纯内存不落盘）────────────────
if (wantAlert) {
  const event = {
    at: new Date().toISOString(),
    severity: 'error',
    kind: 'push-test',
    source: 'scripts/test_push.mjs',
    detail: '推送链路自检（合成事件，无需处理）：OPS_WEBHOOK 连通性与消息格式验证',
  };
  console.log('[test-push] 运维告警通道：合成 error 事件（不落盘 ops-alerts-latest.json）');
  const r = await pushOpsAlerts([event], {});
  console.log(`[test-push] → 运维告警: ${r.pushed ? '推送成功' : `未推送（${r.skipped ? 'skipped' : ''}${r.error || ''}）`}`);
}
