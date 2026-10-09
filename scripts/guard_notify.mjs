// ② 守卫结果双通道通知 · IO 编排入口（daily.yml smoke job 末尾 if: always() step）。
//
// 与用户伪代码的关键偏离（拍板理由，先读这个）：
//   通知器**不在守卫脚本（smoke_sources.mjs）内部**，而是独立进程 + workflow 层
//   if: always() step。用户覆盖矩阵第 4 行「脚本本身 ERROR（未走到 sendWechat）→
//   issue 兜底」在脚本内实现是逻辑矛盾——脚本崩了它自己的通知函数同样不会执行。
//   只有站在守卫进程之外的观察者（本脚本，读 steps.smoke.outcome + 落盘报告交叉
//   印证）才兜得住三态。PASS/BLOCK/ERROR 全覆盖因此成为可能。
//
// 三态 → 通道矩阵（issue 通道用 GITHUB_TOKEN，CI 自动注入零新增 secret）：
//   PASS  → 企微 info（守卫心跳，「首跑盯防」刚需）；issue 默认不建——smoke 每天
//           三班，PASS 流水 issue 会淹没真异常台账。要按原案 PASS 也建：传
//           --pass-issue 或 env GUARD_PASS_ISSUE=true。
//   BLOCK → 企微 error（正文复用 smokeFailEvent，与 alert_smoke_fail 时代逐字一致）
//           + issue 兜底。
//   ERROR → 企微 error + issue 兜底（脚本崩/超时 kill/报告不可读均归此类）。
//
// 纪律（承 alert_smoke_fail，它是本脚本的前身、职能已并入）：
//   · 恒 exit 0——通知通道自身故障（webhook 未配/网络挂/issue API 拒绝）绝不把
//     CI 拖红，错误只落日志；CI 语义只有「守卫本身过没过」一种红；
//   · 判定/载荷构造全在 src/guard_notify.js 纯函数层，本脚本只做 IO 编排。
//
// 用法：node scripts/guard_notify.mjs --step-outcome <success|failure|...> \
//          [--run-id <id>] [--run-url <url>] [--file <smoke.json>] \
//          [--pass-issue] [--no-pass-notify]
//   --file 默认 data/smoke-latest.json，本地 mock 验证可指向临时档不污染真档。
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardVerdict, shouldCreateIssue, buildIssuePayload, createGuardIssue } from '../src/guard_notify.js';
import { pushOpsAlerts } from '../src/opsalerts.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};
const flag = (name) => argv.includes(`--${name}`);

const smokePath = arg('file') || join(ROOT, 'data', 'smoke-latest.json');
let smoke = null;
if (existsSync(smokePath)) {
  try { smoke = JSON.parse(readFileSync(smokePath, 'utf8')); } catch { smoke = null; }
}

const verdict = guardVerdict({
  stepOutcome: arg('step-outcome'),
  smoke,
  at: new Date().toISOString(),
});
console.log(`[guard] 终态 ${verdict.status}：${verdict.reason}`);

// PASS 通知可关（用户矩阵「嫌吵可关 PASS」；默认开——首跑盯防要知道守卫活着）。
const passNotify = !(flag('no-pass-notify') || process.env.GUARD_PASS_NOTIFY === 'false');
if (verdict.status === 'PASS' && !passNotify) {
  console.log('[guard] PASS 通知已按配置关闭（GUARD_PASS_NOTIFY=false / --no-pass-notify）');
  process.exit(0);
}

// 通道 1：企微（复用 pushOpsAlerts；未配 OPS_WEBHOOK → skipped，CI 不受影响）
try {
  const r = await pushOpsAlerts([verdict.event]);
  if (r.pushed > 0) console.log('[guard] 企微通知已推送');
  else console.log('[guard] 企微未推送：', r.error ?? (r.skipped ? 'OPS_WEBHOOK 未配置（仅落日志）' : '无事件'));
} catch (e) {
  console.error('[guard] 企微通知异常（不拖红 CI）:', e?.message ?? e);
}

// 通道 2：GitHub issue 兜底（GITHUB_TOKEN 由 CI 注入；本地未配 → 跳过）
if (shouldCreateIssue(verdict, { passIssue: flag('pass-issue') || process.env.GUARD_PASS_ISSUE === 'true' })) {
  const repo = process.env.GITHUB_REPOSITORY || arg('repo') || null; // 'owner/name'
  const [owner, repoName] = repo ? repo.split('/') : [null, null];
  try {
    const payload = buildIssuePayload(verdict, { repo, runId: process.env.GITHUB_RUN_ID || arg('run-id'), runUrl: arg('run-url') });
    const r = await createGuardIssue(payload, {
      token: process.env.GITHUB_TOKEN || arg('token'),
      owner, repoName,
    });
    if (r.created) console.log(`[guard] issue 兜底已建 #${r.number} ${r.url ?? ''}`);
    else console.log('[guard] issue 未建：', r.error ?? (r.skipped ? 'GITHUB_TOKEN / repo 未配置（仅 CI 内创建）' : '未知原因'));
  } catch (e) {
    console.error('[guard] issue fallback 异常（不拖红 CI）:', e?.message ?? e);
  }
} else {
  console.log('[guard] PASS 不建 issue（防刷屏；需 PASS 也建 → --pass-issue / GUARD_PASS_ISSUE=true）');
}

process.exit(0); // 通知通道永远不是新的单点：失败只留日志，不拖红 CI
