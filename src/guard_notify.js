// 守卫结果双通道通知（2026-10-08 第二+三步合并交付）· 纯函数层（零 IO，可单测）
//
// 「守卫」= CI smoke job（六源冒烟）：源挂 → BLOCK → 拦下 build 主跑（宽度/主线/
// 账本当日停摆）。本模块把守卫终态翻译成三态 + 双通道载荷：
//   PASS  = step 成功（冒烟全绿，build 放行）→ 企微 info 一条（守卫活着的心跳，
//           「首跑盯防」刚需；嫌吵 workflow 层 GUARD_PASS_NOTIFY=false 可关）
//   BLOCK = step 失败 + smoke-latest.json 落盘为失败态 → 企微 error（复用
//           smokeFailEvent，正文与既有告警逐字一致）+ GitHub issue 兜底
//   ERROR = step 失败但落盘档不可读/为成功态（脚本自身异常：网络炸/超时 kill/
//           报告被后续 run 覆盖）→ 企微 error + issue 兜底
//
// 架构纪律（与用户伪代码的关键偏离，理由见 scripts/guard_notify.mjs 头注）：
//   通知器**独立于守卫脚本**、由 workflow 层 if: always() step 调用——守卫脚本
//   崩掉时它自己的通知函数同样不会执行，「脚本 ERROR → issue 兜底」只有站在
//   守卫进程之外的观察者才做得到。判定依据 steps.smoke.outcome + 落盘报告，
//   两者交叉印证，不信任单一信号。
import { smokeFailEvent } from './opsalerts.js';

/**
 * 守卫终态三态判定（纯函数）。
 * @param {object} [o]
 * @param {string|null} [o.stepOutcome] steps.smoke.outcome（success/failure/cancelled/skipped…）
 * @param {object|null} [o.smoke] data/smoke-latest.json（本 run 刚落盘形态；读不到传 null）
 * @param {string} [o.at] ISO 时间戳
 * @returns {{status:'PASS'|'BLOCK'|'ERROR', reason:string, event:{at,severity,kind,source,detail}}}
 *   event 为 opsalerts 通道事件（pushOpsAlerts 直接消费）；reason 为 issue 标题级短摘要
 */
export function guardVerdict({ stepOutcome = null, smoke = null, at = new Date().toISOString() } = {}) {
  const day = typeof smoke?.tradeDateAnchored === 'string' ? smoke.tradeDateAnchored : null;
  const srcs = Array.isArray(smoke?.sources) ? smoke.sources : [];
  const passCount = srcs.length ? `${srcs.filter((x) => x && x.ok).length}/${srcs.length}` : null;
  if (stepOutcome === 'success') {
    return {
      status: 'PASS',
      reason: `冒烟通过${passCount ? `（${passCount}）` : ''} @ 档案日 ${day ?? '未知'}，build 放行`,
      event: {
        at, severity: 'info', kind: 'guard', source: 'smoke',
        detail: `冒烟 PASS${passCount ? ` ${passCount}` : ''} @ 档案日 ${day ?? '未知'} · build 放行（守卫心跳，关闭见 GUARD_PASS_NOTIFY）`,
      },
    };
  }
  if (stepOutcome === 'failure' && smoke?.allOk === false) {
    // BLOCK：复用既有事件构造——正文（硬失败源/通过率/下游停摆警示）与 alert_smoke_fail
    // 时代逐字一致，老告警语义零漂移；reason 摘要供 issue 标题。
    const ev = smokeFailEvent(smoke, { at });
    const hard = Array.isArray(smoke?.hardFail) ? smoke.hardFail.filter(Boolean) : [];
    return { status: 'BLOCK', reason: `冒烟硬失败：${hard.join('；') || '明细见 run 日志'} @ 档案日 ${day ?? '未知'}`, event: ev };
  }
  // ERROR：step 失败但报告不可读 / 报告竟为成功态（被后续 run 覆盖）/ outcome 异常
  // （cancelled=超时 kill 等）。凡是「失败但说不清失败在哪」都按脚本异常对待。
  const why = stepOutcome == null ? 'step outcome 缺失'
    : smoke == null ? '冒烟档不可读（脚本未走到落盘即崩）'
    : smoke.allOk !== false ? `冒烟档为成功态（allOk=${smoke.allOk}），与 step 失败矛盾（超时/报告被覆盖）`
    : `step outcome 异常（${stepOutcome}）`;
  return {
    status: 'ERROR',
    reason: `守卫脚本自身异常：${why}`,
    event: {
      at, severity: 'error', kind: 'guard', source: 'smoke',
      detail: `守卫脚本自身异常：${why} · 失败详情见 run 日志`,
    },
  };
}

/**
 * issue 是否该建（纯函数）：BLOCK/ERROR 恒建；PASS 默认不建——smoke 每天三班，
 * PASS 流水 issue 会淹没真异常台账（issue 的语义是「要处理的异常」不是运行日志）；
 * 要 PASS 也建（用户覆盖矩阵原案）在调用方传 passIssue: true 打开。
 */
export function shouldCreateIssue(verdict, { passIssue = false } = {}) {
  return verdict.status !== 'PASS' || passIssue === true;
}

/**
 * 守卫结果 → GitHub issue 载荷（纯函数；POST /repos/{owner}/{repo}/issues 的 body）。
 * @param {{status,reason,event}} verdict guardVerdict 产物（或同形对象：东财探测等
 *   其他观察者传 { status: 'OK'|'FAIL', reason, event }）
 * @param {object} [o] { repo?: 'owner/name', runId?: string, runUrl?: string,
 *   at?: string, titlePrefix?: string, labels?: string[] }
 *   titlePrefix/labels 默认守卫口径（「守卫」/['guard']）；探测等其他观察者按
 *   语义覆盖（如「东财探测」），台账标签可共用 guard 也可细分
 */
export function buildIssuePayload(verdict, { repo = null, runId = null, runUrl = null, titlePrefix = '守卫', labels = ['guard'] } = {}) {
  const url = runUrl
    || (repo && runId ? `https://github.com/${repo}/actions/runs/${runId}` : null);
  const body = [
    '🛡️ 守卫结果',
    `状态: ${verdict.status}`,
    `理由: ${verdict.reason}`,
    `时间: ${verdict.event.at}`,
    url ? `Run: ${url}` : null,
    '',
    '> 企微通道若同时在线你会收到同文通知；本 issue 是兜底通道（企微 secrets 失效 /',
    '> 脚本自身 ERROR 时仍可触达）。处理完请关闭本 issue。',
  ].filter((x) => x !== null).join('\n');
  return {
    title: `🛡️ ${titlePrefix} ${verdict.status}: ${verdict.reason}`.slice(0, 256), // GitHub title 上限语义截断
    body,
    labels,
  };
}

/**
 * 创建 GitHub issue（IO 出口；无 token 跳过、任何失败返回错误绝不抛——通知通道
 * 自身故障不能把守卫 CI 拖红，与 pushOpsAlerts 同一纪律）。
 * @param {{title,body,labels}} payload buildIssuePayload 产物
 * @param {object} [o] { token?: string, owner?: string, repoName?: string, fetchImpl?, apiBase?: string }
 *   token 默认 env.GITHUB_TOKEN（CI 里 ${{ secrets.GITHUB_TOKEN }} 注入，零新增 secret）
 * @returns {Promise<{created:boolean, number?:number, url?:string, skipped?:boolean, error?:string}>}
 */
export async function createGuardIssue(payload, { token = null, owner = null, repoName = null, fetchImpl = null, apiBase = 'https://api.github.com' } = {}) {
  if (!token || !owner || !repoName) return { created: false, skipped: true };
  const fetchFn = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchFn) return { created: false, skipped: true, error: '当前环境无 fetch' };
  try {
    const res = await fetchFn(`${apiBase}/repos/${owner}/${repoName}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return { created: false, error: `issue HTTP ${res.status}: ${await res.text().catch(() => '')}`.slice(0, 300) };
    const j = await res.json().catch(() => null);
    return { created: true, number: j?.number ?? null, url: j?.html_url ?? null };
  } catch (e) {
    return { created: false, error: String(e?.message || e) };
  }
}
