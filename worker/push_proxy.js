// ── Cloudflare Worker 推送代理（决议 2 · P0 · 2026-10-07）──────────────────
//
// 定位：页面即时轨报告的「复制 → 云端推送」代理端。浏览器拿不到 secret、
//   直连企微 Webhook 还有 CORS 墙——所以报告信封 POST 到本代理，由 Worker
//   持有 OPS_WEBHOOK 完成推送（与 CI 同一机器人同一通道，决议 2 原文：
//   「页面即时轨的云端推送走云函数代理，不经 Node 模块」）。
//
// 零 Node API：只 import 纯渲染层 src/push_text.js（零依赖）+ 标准 fetch/
//   Request/Response/URL——Workers/Node 18+/浏览器三环境同构，单测可直跑。
//
// 推送纪律（与 src/ai_report_push.js::pushReports 同一哲学）：
//   · 未配置 OPS_WEBHOOK → 静默跳过（200 + pushed:false，本地零打扰）；
//   · 内容指纹去重（同稳定域哈希，KV 存 30 天）——同内容重推被拦；
//   · urgent（trigger ≠ 'schedule'，决议 3 四类事件）免指纹直达；
//   · fetch 失败不记指纹 → 调用方重试自愈；
//   · 滥用面三闸：来源校验（ALLOWED_ORIGIN）/ 请求体上限 / 每日推送上限。
//
// 防护说明（个人系统威胁模型，如实记录）：secret 只在 Worker 侧；
//   ALLOWED_ORIGIN 未配置时放行（本地 dev / 初次部署期），上线后应在
//   wrangler.toml [vars] 设页面部署域——这不是强认证，是低摩擦滥用闸。
export { PUSH_CONSTS, renderPushText } from '../src/push_text.js';
import { renderPushText } from '../src/push_text.js'; // re-export 不入本模块作用域，本地渲染需显式 import

export const PROXY_CONSTS = {
  BODY_CAP: 64 * 1024,            // 请求体上限（信封 JSON 远小于此，防投毒）
  DEDUP_TTL_S: 30 * 86400,        // 指纹记忆 30 天（对齐 PUSH_CONSTS.STATE_TTL_MS）
  DAILY_CAP: 100,                 // 每日推送上限（KV 计数兜底，防代理被滥用刷量）
  REPORT_TYPES: ['pre_market', 'intraday', 'post_market', 'weekly'],
};

/** 稳定域抽取（与 ai_report_push.js::fingerprintOf 同域：易变字段剔除）。 */
function stableOf(report) {
  return JSON.stringify({
    report_type: report?.report_type,
    date: report?.date,
    trigger: report?.trigger,
    status: report?.status,
    payload: report?.payload,
    missing_notes: report?.missing_notes,
  });
}

/** 轻量内容指纹（djb2 双轮 + 长度，16 hex）：**去重用**，非安全哈希——
 *  Worker 免费层无 node:crypto，WebCrypto 摘要则是异步且此处非安全场景。 */
export function proxyFingerprint(report) {
  const s = stableOf(report);
  let h1 = 5381; let h2 = 52711;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    h1 = (h1 * 33 + c) >>> 0; // eslint-disable-line no-bitwise
    h2 = (h2 * 31 + c) >>> 0; // eslint-disable-line no-bitwise
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`.slice(0, 16) + `_${s.length.toString(16)}`;
}

const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
});

export function corsHeaders(env) {
  const origin = env?.ALLOWED_ORIGIN || '*';
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
}

/** GET /healthz —— 存活探针（wrangler dev 验收端点）。 */
export function handleHealth() {
  return json({ ok: true, ts: new Date().toISOString(), service: 'a-sentiment-push-proxy' });
}

/** 北京时区日期键（每日计数用；仅键名，粗粒度日界足够）。 */
function bjDayKey(now) {
  const d = now instanceof Date ? now : new Date(now);
  const bj = new Date(d.getTime() + 8 * 3600 * 1000);
  return `day:${bj.toISOString().slice(0, 10)}`;
}

/**
 * POST /push —— 报告信封 → 企微推送（KV 去重 + 每日限额 + 来源闸）。
 * @param {Request} request 标准 Fetch Request
 * @param {{OPS_WEBHOOK?:string, ALLOWED_ORIGIN?:string, PUSH_STATE?:object}} env
 *   Worker 绑定：OPS_WEBHOOK=secret，ALLOWED_ORIGIN=var，PUSH_STATE=KV namespace
 * @param {{now?:Date, fetchImpl?:Function}} opts 测试注入
 */
export async function handlePush(request, env, { now = new Date(), fetchImpl } = {}) {
  if (request.method !== 'POST') return json({ ok: false, reason: '仅接受 POST' }, 405, corsHeaders(env));
  const allow = env?.ALLOWED_ORIGIN;
  if (allow) {
    const origin = request.headers.get('origin');
    const referer = request.headers.get('referer') || '';
    if (origin !== allow && !referer.startsWith(`${allow}/`)) {
      return json({ ok: false, reason: '来源未授权' }, 403, corsHeaders(env));
    }
  }
  const len = Number(request.headers.get('content-length') || 0);
  if (len > PROXY_CONSTS.BODY_CAP) return json({ ok: false, reason: '请求体超限' }, 413, corsHeaders(env));
  let report;
  try {
    const body = await request.text();
    if (body.length > PROXY_CONSTS.BODY_CAP) return json({ ok: false, reason: '请求体超限' }, 413, corsHeaders(env));
    report = JSON.parse(body);
  } catch {
    return json({ ok: false, reason: '请求体不是合法 JSON' }, 400, corsHeaders(env));
  }
  if (!PROXY_CONSTS.REPORT_TYPES.includes(report?.report_type) || typeof report?.payload !== 'object' || !report.payload) {
    return json({ ok: false, reason: '报告信封不合法（report_type/payload 缺失）' }, 400, corsHeaders(env));
  }

  const url = env?.OPS_WEBHOOK;
  if (!url) return json({ ok: true, pushed: false, reason: '未配置 OPS_WEBHOOK，仅校验通过' }, 200, corsHeaders(env));
  const fetchFn = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchFn) return json({ ok: false, reason: '当前环境无 fetch' }, 500, corsHeaders(env));

  const kv = env?.PUSH_STATE ?? null;
  const fp = proxyFingerprint(report);
  const urgent = report?.trigger && report.trigger !== 'schedule'; // 决议 3：urgent 免指纹直达
  const fpKey = `fp:${fp}`;
  const dayKey = bjDayKey(now);
  if (!urgent && kv) {
    try { if (await kv.get(fpKey)) return json({ ok: true, pushed: false, reason: '同内容 30 天内已推过（指纹去重）', fingerprint: fp }, 200, corsHeaders(env)); } catch { /* KV 故障不拦推送 */ }
  }
  if (kv) {
    try {
      const used = Number(await kv.get(dayKey)) || 0;
      if (used >= PROXY_CONSTS.DAILY_CAP) return json({ ok: false, reason: `已达每日上限 ${PROXY_CONSTS.DAILY_CAP} 条` }, 429, corsHeaders(env));
    } catch { /* KV 故障不拦推送 */ }
  }

  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: renderPushText(report) } }),
    });
    if (!res.ok) return json({ ok: false, reason: `webhook HTTP ${res.status}（未记指纹，可重试）` }, 502, corsHeaders(env));
    if (kv) {
      try {
        if (!urgent) await kv.put(fpKey, now.toISOString(), { expirationTtl: PROXY_CONSTS.DEDUP_TTL_S });
        const used = (Number(await kv.get(dayKey)) || 0) + 1;
        await kv.put(dayKey, String(used), { expirationTtl: 86400 });
      } catch { /* 记账失败不影响已完成的推送 */ }
    }
    return json({ ok: true, pushed: true, fingerprint: fp, urgent }, 200, corsHeaders(env));
  } catch (e) {
    // 失败不记指纹 → 调用方重试即自愈（与 CI pushReports 同纪律）
    return json({ ok: false, reason: `推送失败: ${e?.message || e}（未记指纹，可重试）` }, 502, corsHeaders(env));
  }
}
