// ③ 东财 push2his 连通性探测 · IO 编排入口（daily.yml us-close job 04:30 班）。
//
// 与守卫（guard_notify）的分工：守卫是**门禁**（BLOCK 拦 build），探测是**观察者**
// ——结果只通知不拦截，恒 exit 0（含 main().catch 兜底），CI 红只属于守卫。探测
// 挂掉不拖红美股收盘档 job，通知通道自身故障同理（承 pushOpsAlerts / createGuardIssue
// 「绝不抛」纪律 + workflow 层 continue-on-error 双保险）。
//
// 通知矩阵（与守卫同款拍板，双通道复用 guard_notify 的载荷/IO 函数）：
//   OK   → 企微 info 心跳（s6 量能备源可用；GUARD_PASS_NOTIFY 同款开关可静默 OK）；
//          issue 不建——每天一班，OK 流水会淹没异常台账；
//   FAIL → 企微 error + issue 兜底（title「东财探测 FAIL」，labels ['guard','eastmoney']，
//          与守卫共用台账但可按标签筛出探测异常）。
//
// 用法：node scripts/check_eastmoney.mjs [--run-id <id>] [--run-url <url>] [--quiet-ok]
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeEastmoney, probeEvent } from '../src/eastmoney_probe.js';
import { buildIssuePayload, createGuardIssue } from '../src/guard_notify.js';
import { pushOpsAlerts } from '../src/opsalerts.js';

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};

const result = await probeEastmoney();
console.log(`[eastmoney-check] 结果: ${JSON.stringify(result)}`);
const event = probeEvent(result);
console.log(`[eastmoney-check] ${event.detail}`);

const quietOk = argv.includes('--quiet-ok') || process.env.PROBE_QUIET_OK === 'true';
if (result.ok && quietOk) {
  console.log('[eastmoney-check] OK 心跳已按配置静默（--quiet-ok / PROBE_QUIET_OK=true）');
  process.exit(0);
}

// 通道 1：企微（未配 OPS_WEBHOOK → skipped，CI 不受影响）
try {
  const r = await pushOpsAlerts([event]);
  if (r.pushed > 0) console.log('[eastmoney-check] 企微通知已推送');
  else console.log('[eastmoney-check] 企微未推送：', r.error ?? (r.skipped ? 'OPS_WEBHOOK 未配置（仅落日志）' : '无事件'));
} catch (e) {
  console.error('[eastmoney-check] 企微通知异常（不拖红 CI）:', e?.message ?? e);
}

// 通道 2：FAIL → GitHub issue 兜底（OK 不建，防台账刷屏）
if (!result.ok) {
  const repo = process.env.GITHUB_REPOSITORY || arg('repo') || null;
  const [owner, repoName] = repo ? repo.split('/') : [null, null];
  try {
    const payload = buildIssuePayload(
      { status: 'FAIL', reason: `push2his 不可达/异常：${result.error}`, event },
      {
        repo, runId: process.env.GITHUB_RUN_ID || arg('run-id'), runUrl: arg('run-url'),
        titlePrefix: '东财探测', labels: ['guard', 'eastmoney'],
      },
    );
    const r = await createGuardIssue(payload, { token: process.env.GITHUB_TOKEN || arg('token'), owner, repoName });
    if (r.created) console.log(`[eastmoney-check] issue 兜底已建 #${r.number} ${r.url ?? ''}`);
    else console.log('[eastmoney-check] issue 未建：', r.error ?? (r.skipped ? 'GITHUB_TOKEN / repo 未配置（仅 CI 内创建）' : '未知原因'));
  } catch (e) {
    console.error('[eastmoney-check] issue fallback 异常（不拖红 CI）:', e?.message ?? e);
  }
} else {
  console.log('[eastmoney-check] OK 不建 issue（防刷屏；FAIL 才兜底）');
}

process.exit(0); // 探测任务自身不导致 CI 失败——观察者不拦截，红只属于守卫
