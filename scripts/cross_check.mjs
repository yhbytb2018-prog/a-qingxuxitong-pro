// 两市成交额跨源对账 · IO 编排入口（daily.yml smoke job，对账 step）。
//
// 语义：smoke 守卫之后、build 放行之前的**独立观测**——用东财 push2his 备源核验
// 主数据源（同花顺，smoke s6 顺产落盘的 amountAnchor）的当日两市成交额。差值超
// 阈值（默认 5%）或备源不可用 → 企微 + GitHub issue 双通道告警；**纯观测不拦
// build**——CI 红只属于守卫（对账是观察者，恒 exit 0 + continue-on-error 双保险）。
//
// 主源值从哪来（用户字段确认一节拍板「不猜」）：data/smoke-latest.json 的
// amountAnchor（s6 顺产 { date, amountYi }，零额外网络请求）。null = s6 未产出
// （硬失败）→ 对账无从谈起，静默跳过——那时守卫已在告 s6，对账不重复打扰。
//
// 通知矩阵（复用 guard_notify 双通道载荷/IO；notifyGuardResult 伪代码名在真实现
// 里是 buildIssuePayload+createGuardIssue 分件，titlePrefix/labels 已参数化直接接）：
//   PASS（差值 ≤ 阈值）→ 静默通过，零通知（对账是日常观测，通过不是新闻）；
//   WARN（差值超阈值）→ 企微 error + issue（labels ['guard','cross-check']）；
//   UNAVAILABLE（备源挂/交易日错位/主值缺）→ 同 WARN。主值缺走静默跳过不告警。
//
// 用法：node scripts/cross_check.mjs [--run-id <id>] [--run-url <url>] [--file <smoke.json>]
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crossCheckVolume, crossCheckEvent } from '../src/cross_check_volume.js';
import { buildIssuePayload, createGuardIssue } from '../src/guard_notify.js';
import { pushOpsAlerts } from '../src/opsalerts.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};

const smokePath = arg('file') || join(ROOT, 'data', 'smoke-latest.json');
let smoke = null;
if (existsSync(smokePath)) {
  try { smoke = JSON.parse(readFileSync(smokePath, 'utf8')); } catch { smoke = null; }
}

const anchor = smoke?.amountAnchor ?? null;
if (!anchor || !Number.isFinite(anchor.amountYi)) {
  console.log('[cross-check] 主源锚点值缺失（s6 未产出，smoke-latest.json 无 amountAnchor）——对账无从谈起，跳过；s6 硬失败由守卫告警');
  process.exit(0);
}

const result = await crossCheckVolume(anchor.amountYi, { mainDate: anchor.date });
console.log(`[cross-check] ${JSON.stringify(result)}`);

if (result.ok) {
  console.log(`[cross-check] 两市成交额对账通过: 主=${result.main}亿 备=${result.backup}亿 差=${result.diffPct}%（阈值 5%）`);
  process.exit(0); // 通过是常态，静默不通知
}

// WARN / UNAVAILABLE → 双通道告警（差值超阈或备源不可用，都是「主源数值可信度」
// 的事实变化，值得建 issue 留痕——但不拦 build，纯观测）。正文按定稿明细格式：
// 理由 + 主源/备源/差值分行（UNAVAILABLE 场景 null 段自动省略）。
const event = crossCheckEvent(result, { mainDate: anchor.date });
console.log(`[cross-check] ⚠ ${event.detail}`);

// 通道 1：企微
try {
  const r = await pushOpsAlerts([event]);
  if (r.pushed > 0) console.log('[cross-check] 企微通知已推送');
  else console.log('[cross-check] 企微未推送：', r.error ?? (r.skipped ? 'OPS_WEBHOOK 未配置（仅落日志）' : '无事件'));
} catch (e) {
  console.error('[cross-check] 企微通知异常（不拖红 CI）:', e?.message ?? e);
}

// 通道 2：GitHub issue 兜底（labels guard + cross-check，可按标签筛出对账异常）
const repo = process.env.GITHUB_REPOSITORY || arg('repo') || null;
const [owner, repoName] = repo ? repo.split('/') : [null, null];
try {
  const payload = buildIssuePayload(
    { status: result.verdict, reason: result.reason, event },
    {
      repo, runId: process.env.GITHUB_RUN_ID || arg('run-id'), runUrl: arg('run-url'),
      titlePrefix: '跨源对账', labels: ['guard', 'cross-check'],
    },
  );
  const r = await createGuardIssue(payload, { token: process.env.GITHUB_TOKEN || arg('token'), owner, repoName });
  if (r.created) console.log(`[cross-check] issue 兜底已建 #${r.number} ${r.url ?? ''}`);
  else console.log('[cross-check] issue 未建：', r.error ?? (r.skipped ? 'GITHUB_TOKEN / repo 未配置（仅 CI 内创建）' : '未知原因'));
} catch (e) {
  console.error('[cross-check] issue fallback 异常（不拖红 CI）:', e?.message ?? e);
}

process.exit(0); // 恒 exit 0 不拦 build——观察者不是门禁，红只属于守卫
