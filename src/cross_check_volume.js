// 两市成交额跨源对账锚点（2026-10-08 对账任务）· 纯函数层（fetch 可注入，可单测）
//
// 语义：用东财 push2his（备源）核验主数据源（同花顺，经 smoke s6 顺产落盘）的
// 当日两市成交额；差值超阈值 → 企微 + issue 告警，**不拦 build**（纯观测——
// 观察者不是门禁，CI 红只属于守卫）。
//
// 对用户伪代码的三处修正（10-08 实测教训）：
//   ① 备源必须拉上证 1.000001 + 深证 0.399001 **两 secid 相加**——单拉上证只有
//     沪市 ~8100 亿，对两市 16821 亿必然「差值 50%」假告警；
//   ② 成交额字段是 f57（元）非 f56（f56 是成交量/手）——fields2 只请求 f51,f57，
//     split 索引固定 [0]=日期 [1]=成交额，不依赖字段位次猜测；
//   ③ 主备必须锚定**同一交易日**——拿昨日东财核今日同花顺是假对账，日期错位
//     一律按不可用处理（不硬算差值）。
//
// 半市绝不顶两市（src/sources.js:296 实录教训：8301 几乎纯沪市冒充两市 →
// s_amt=12.5 二次污染）——两 secid 任一失败 → 整体不可用，不降级单市。

/** 东财指数日K：只请求日期 f51 + 成交额 f57（元），lmt=1 取最新交易日一根。 */
export const emKlineUrl = (secid) =>
  `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3&fields2=f51,f57&klt=101&fqt=0&lmt=1`;

/**
 * 拉东财两市成交额（纯 IO 函数：不抛出，失败原因进 result.error）。
 * @param {object} [o] { fetchImpl?: typeof fetch, timeoutMs?: number }
 * @returns {Promise<{ok:boolean, amountYi:number|null, date:string|null, error:string|null}>}
 *   date 为 'YYYY-MM-DD'（东财原生）；两市取同一根交易日，错位即不可信。
 */
export async function fetchEastmoneyTwoMarketAmount({ fetchImpl = null, timeoutMs = 15000 } = {}) {
  const fetchFn = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchFn) return { ok: false, amountYi: null, date: null, error: '当前环境无 fetch' };
  const grab = async (secid) => {
    const res = await fetchFn(emKlineUrl(secid), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}（${secid}）`);
    const j = await res.json().catch(() => null);
    const lines = Array.isArray(j?.data?.klines) ? j.data.klines : [];
    const line = lines[lines.length - 1]; // lmt=1 只有一根；取末根防接口多给
    if (!line) throw new Error(`klines 空（${secid}，限流/改版征兆）`);
    const [d, amt] = String(line).split(',');
    const amountYi = Number(amt) / 1e8; // f57 元 → 亿
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '') || !Number.isFinite(amountYi) || amountYi <= 0) {
      throw new Error(`K线形态异常（${secid}）: ${line}`);
    }
    return { date: d, amountYi };
  };
  try {
    const [sh, sz] = await Promise.all([grab('1.000001'), grab('0.399001')]);
    if (sh.date !== sz.date) return { ok: false, amountYi: null, date: null, error: `两市日期错位：沪 ${sh.date} vs 深 ${sz.date}（跨日界窗口，不采信）` };
    return { ok: true, amountYi: Math.round((sh.amountYi + sz.amountYi) * 10) / 10, date: sh.date, error: null };
  } catch (e) {
    return { ok: false, amountYi: null, date: null, error: String(e?.message || e) };
  }
}

/**
 * 跨源对账主判定（纯函数）。
 * @param {number|null} main 主源两市成交额（亿；smoke s6 顺产的锚点值）
 * @param {object} [o] { mainDate?: 'YYYYMMDD'|'YYYY-MM-DD', fetchImpl?, thresholdPct?: number,
 *   backup?: {ok,amountYi,date,error} }——backup 可注入：单测/离线，默认现场拉东财
 * @returns {Promise<{ok, verdict:'PASS'|'WARN'|'UNAVAILABLE', main, backup, diffPct, reason}>}
 *   ok=true → 静默通过（对账是日常观测，通过不通知——与守卫心跳的差异化定位）；
 *   WARN/UNAVAILABLE → 调用方走双通道告警。
 */
export async function crossCheckVolume(main, { mainDate = null, fetchImpl = null, thresholdPct = 5, backup = null } = {}) {
  if (!Number.isFinite(main) || main <= 0) {
    return { ok: false, verdict: 'UNAVAILABLE', main: main ?? null, backup: null, diffPct: null,
      reason: '主源锚点值不可用（s6 未产出当日成交额）' };
  }
  const bk = backup ?? await fetchEastmoneyTwoMarketAmount({ fetchImpl });
  if (!bk.ok) {
    return { ok: false, verdict: 'UNAVAILABLE', main, backup: null, diffPct: null,
      reason: `备用源不可用：${bk.error}` };
  }
  const norm = (d) => String(d || '').replace(/-/g, '');
  if (mainDate && bk.date && norm(mainDate) !== norm(bk.date)) {
    return { ok: false, verdict: 'UNAVAILABLE', main, backup: bk.amountYi, diffPct: null,
      reason: `交易日错位：主源 ${mainDate} vs 备源 ${bk.date}（拿不同交易日比对是假对账）` };
  }
  const diffPct = Math.abs(main - bk.amountYi) / main * 100;
  const ok = diffPct <= thresholdPct;
  const out = { ok, verdict: ok ? 'PASS' : 'WARN', main, backup: bk.amountYi, diffPct: +diffPct.toFixed(2), reason: null };
  if (!ok) out.reason = `两市成交额差值 ${out.diffPct}%（主 ${main} 亿 vs 备 ${out.backup} 亿，阈值 ${thresholdPct}%）`;
  return out;
}

/**
 * 对账结果 → 企微事件（opsalerts 通道；PASS 静默不发，异常才构造给调用方）。
 * 正文按定稿明细格式：理由 + 主源/备源/差值分行（UNAVAILABLE 场景 null 段自动省略）。
 * @param {object} result crossCheckVolume 产物
 * @param {object} [o] { mainDate?: 'YYYYMMDD', at?: string }
 */
export function crossCheckEvent(result, { mainDate = null, at = new Date().toISOString() } = {}) {
  const lines = [`跨源对账异常：${result.reason}`];
  if (result.main != null) lines.push(`主源｜${result.main} 亿${mainDate ? `（${mainDate}）` : ''}`);
  if (result.backup != null) lines.push(`备源｜${result.backup} 亿`);
  if (result.diffPct != null) lines.push(`差值｜${result.diffPct}%`);
  return { at, severity: 'error', kind: 'cross-check', source: 'volume', detail: lines.join('\n') };
}
