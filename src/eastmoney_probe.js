// 东财 push2his 连通性探测（2026-10-08 第三件）· 纯函数层（fetch 可注入，可单测）
//
// 为什么值得每天一班探测：s6 量能备源（fetchAmountMap 的东财/同花顺互切）依赖
// push2his 可用性，而 10-08 本机实测它在部分网络下 TLS 被断 / 返回空数据——
// 接口健康是「备源到底靠不靠得住」的前提事实，攒下来的每日记录也是备源决策
// 的依据。探测对象：上证指数日K（secid=1.000001，与量能备源同款接口族，探测
// 即代表 s6 备源真实可用性）。
//
// 纪律：探测是**观察者**不是守卫——结果只通知不拦截（脚本层恒 exit 0，CI 红
// 只属于守卫）；事件构造纯函数，IO 集中在 scripts/check_eastmoney.mjs 编排。

/** 探测端点：上证指数日K 最近 5 根（轻量、只读、无鉴权）。 */
export const EM_PROBE_URL = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.000001&fields1=f1,f2,f3&fields2=f51,f57&klt=101&fqt=1&lmt=5';

/**
 * 探测 push2his 连通性（纯 IO 函数：不抛出，失败原因进 result.error）。
 * @param {object} [o] { fetchImpl?: typeof fetch, timeoutMs?: number }
 * @returns {Promise<{ok:boolean, latencyMs:number|null, klines:number, error:string|null}>}
 *   判定：HTTP 2xx 且 data.klines 非空才算 OK——200 + 空 klines 是东财限流/
 *   接口改版的典型征兆（10-08 实测形态），不算连通。
 */
export async function probeEastmoney({ fetchImpl = null, timeoutMs = 15000 } = {}) {
  const fetchFn = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchFn) return { ok: false, latencyMs: null, klines: 0, error: '当前环境无 fetch' };
  const t0 = Date.now();
  try {
    const res = await fetchFn(EM_PROBE_URL, { signal: AbortSignal.timeout(timeoutMs) });
    const latencyMs = Date.now() - t0;
    if (!res.ok) return { ok: false, latencyMs, klines: 0, error: `HTTP ${res.status}` };
    const j = await res.json().catch(() => null);
    const klines = Array.isArray(j?.data?.klines) ? j.data.klines.length : 0;
    if (klines === 0) return { ok: false, latencyMs, klines: 0, error: 'HTTP 200 但 klines 为空（限流/接口改版征兆，不算连通）' };
    return { ok: true, latencyMs, klines, error: null };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - t0, klines: 0, error: String(e?.message || e) };
  }
}

/**
 * 探测结果 → 企微事件（opsalerts 通道，pushOpsAlerts 直接消费）。
 * OK = info 心跳（量能备源可用）；FAIL = error（备源将依赖同花顺/腾讯兜底）。
 */
export function probeEvent(result, { at = new Date().toISOString() } = {}) {
  if (result.ok) {
    return { at, severity: 'info', kind: 'eastmoney-probe', source: 'eastmoney',
      detail: `东财 push2his 探测 OK：${result.klines} 根K线 · ${result.latencyMs}ms（s6 量能备源可用）` };
  }
  return { at, severity: 'error', kind: 'eastmoney-probe', source: 'eastmoney',
    detail: `东财 push2his 探测 FAIL：${result.error}（s6 量能备源将依赖同花顺/腾讯兜底）` };
}
