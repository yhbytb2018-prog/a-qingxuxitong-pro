// ── AI 报告推送与调度闸门（S2 · 2026-10-06 用户拍板）──────────────────────
//
// Node/CI 专用模块：import 了 node:fs 与 freshness/calendar（读日历），
//   **不入浏览器/Worker bundle**——Worker 推送代理（决议 2 云端代理）与页面
//   即时轨只 import 纯渲染层 src/push_text.js（PUSH_CONSTS/renderPushText，
//   零 Node 依赖三端通用，本模块 re-export 保持既有 import 路径零改动）；
//   页面即时轨调度复用 marketPhase 而非本模块。
//
// 推送纪律（沿 src/opsalerts.js::pushOpsAlerts 同一通道与同一哲学）：
//   · 同一企微机器人（env OPS_WEBHOOK，复用现有运维 secret，零新增配置）；
//     未配置 → 静默跳过（skipped），本地零打扰；
//   · 指纹防风暴 = **内容指纹去重**：剔除 generated_at 等易变字段后哈希——
//     同内容重跑（如 18:30 首抓后 21:00 补抓数据未变）不重推；数据真变了 →
//     新指纹 → 照推。宁可多推一条真变化，不静默漏推；
//   · urgent（event:* 四类，决议 3 枚举锁死）免指纹直达；
//   · fetch 失败绝不 throw（推送不能炸数据管线）：错误如实上报调用方，
//     且失败**不记指纹** → 下个 tick 自然重试（自愈，无需人工干预）。
//
// 调度闸门（纯函数，相位判据与 scripts/snapshot_intraday.mjs 同源）：
//   gatePreMarket —— 北京当日为交易日才生成（09:05 cron 用，9:00-9:10 窗口）；
//   gateIntraday  —— 相位 live（09:30-15:00）才生成（盘中 tick 用）；
//   gateWeekly    —— tradeDate 为本周最后交易日才生成（周五，或节前最后一天）。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { atomicWriteJSON } from './fsutil.js';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { marketPhase } from './freshness.js';
import { resolveHolidays } from './calendar.js';
import { PUSH_CONSTS, renderPushText } from './push_text.js';

export { PUSH_CONSTS, renderPushText }; // 纯渲染层 re-export（Worker/浏览器经 push_text.js 直取，既有 import 路径零改动）

// ── 指纹（内容去重键）──────────────────────────────────────────────────
/**
 * 报告 → 内容指纹（sha256 前 16 位十六进制）。
 * 稳定域 = report_type / date / trigger / status / payload / missing_notes；
 * 剔除 generated_at / generated_by / data_health / data_completeness /
 * concepts / sources / disclaimer（易变或派生，重跑即变但内容未变）。
 */
export function fingerprintOf(report) {
  const stable = {
    report_type: report?.report_type,
    date: report?.date,
    trigger: report?.trigger,
    status: report?.status,
    payload: report?.payload,
    missing_notes: report?.missing_notes,
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 16);
}

/**
 * 防风暴判定（纯函数）。
 * @returns {{push:boolean, fingerprint:string, reason:string}}
 *   urgent（trigger ≠ schedule，决议 3 四类事件）恒放行（免防风暴直达）；
 *   否则 30 天内同指纹已推过 → 拦下。
 */
export function shouldPush(report, state, now = new Date()) {
  const fp = fingerprintOf(report);
  if (report?.urgent === true) return { push: true, fingerprint: fp, reason: 'urgent_direct（event:* 免防风暴直达，决议 3）' };
  const hit = (state?.pushed || []).some((p) => p && p.fingerprint === fp
    && now.getTime() - Date.parse(p.pushed_at) < PUSH_CONSTS.STATE_TTL_MS);
  return hit
    ? { push: false, fingerprint: fp, reason: 'duplicate_fingerprint（30 天内同内容已推）' }
    : { push: true, fingerprint: fp, reason: 'new_content' };
}

/** 状态修剪：超龄清理 + 条目上限（按 pushed_at 降序保最新 STATE_CAP 条）。 */
export function pruneState(state, now = new Date()) {
  const arr = (state?.pushed || [])
    .filter((p) => p && p.fingerprint && now.getTime() - Date.parse(p.pushed_at) < PUSH_CONSTS.STATE_TTL_MS)
    .sort((a, b) => String(b.pushed_at).localeCompare(String(a.pushed_at)))
    .slice(0, PUSH_CONSTS.STATE_CAP);
  return { schema_version: '1.0', pushed: arr };
}

/** 记一条成功推送（返回新状态对象，纯函数）。 */
export function recordPushed(state, entry, now = new Date()) {
  return pruneState({
    pushed: [...(state?.pushed || []), { ...entry, pushed_at: entry.pushed_at || now.toISOString() }],
  }, now);
}

// ── 状态文件 IO（坏档不炸推送：读失败按空状态处理）──────────────────────
export function loadPushState(file) {
  const empty = { schema_version: '1.0', pushed: [] };
  try {
    if (!file || !existsSync(file)) return empty;
    const s = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(s?.pushed) ? s : empty;
  } catch { return empty; }
}

export function savePushState(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  atomicWriteJSON(file, JSON.stringify(pruneState(state), null, 1) + '\n');
  return state;
}

// ── 文本渲染（PUSH_CONSTS / renderPushText）已抽取至 src/push_text.js（纯函数层，
//    零 Node 依赖，Node/Worker/浏览器三端通用）——本模块 re-export 保持兼容。

// ── 推送出口（唯一副作用点：fetch + 状态文件；均可注入以便单测）──────────
/**
 * 推送一组报告（按序；同批内也做指纹去重——重跑同内容只推一次）。
 * @param {Array<object>|object} reports 报告对象（信封完整结构）
 * @param {{env?:object, fetchImpl?:Function, stateFile?:string|null, now?:Date}} opts
 *   env.fetchImpl/stateFile 全部可注入（测试零网络零磁盘）；
 *   stateFile 为 null → 纯推送不落状态（不推荐 CI 用，仅供测试/预览）。
 * @returns {{results:Array, pushed:number, skipped:number, state:object}}
 *   永不 reject（告警纪律：推送失败不炸数据管线，错误进 results[].reason）。
 */
export async function pushReports(reports, { env = process.env, fetchImpl, stateFile = null, now = new Date() } = {}) {
  const list = (Array.isArray(reports) ? reports : [reports]).filter(Boolean);
  const url = env?.[PUSH_CONSTS.WEBHOOK_ENV];
  let state = stateFile ? loadPushState(stateFile) : { schema_version: '1.0', pushed: [] };
  const results = [];
  let pushed = 0;
  if (!url) {
    for (const report of list) results.push({ type: report.report_type, date: report.date, pushed: false, reason: '未配置 OPS_WEBHOOK，仅落盘' });
    return { results, pushed: 0, skipped: list.length, state };
  }
  const fetchFn = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  for (const report of list) {
    const verdict = shouldPush(report, state, now);
    if (!verdict.push) { results.push({ type: report.report_type, date: report.date, pushed: false, reason: verdict.reason }); continue; }
    if (!fetchFn) { results.push({ type: report.report_type, date: report.date, pushed: false, reason: '当前环境无 fetch' }); continue; }
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: renderPushText(report) } }),
      });
      // 解析企微响应体（fetch 注入的 mock 可能没有 .json()/.text()，标准 Response 两者俱在）
      let wechat = {};
      try {
        if (typeof res?.json === 'function') wechat = await res.json();
        else if (typeof res?.text === 'function') { try { wechat = JSON.parse(await res.text()); } catch { /* swallow: 落到空对象 */ } }
      } catch { wechat = {}; }
      console.log(`[企微推送结果] ${report.report_type} ${report.date} → HTTP ${res.status}, errcode: ${wechat.errcode}, errmsg: ${wechat.errmsg}`);
      // 失败判据：HTTP 非 2xx OR 企微 errcode ≠ 0（93xxx 静默丢包场景：企微常以 HTTP 200 + errcode 9xxxx 表示群解散/机器人被拉起）
      const httpFail = !res.ok;
      const apiFail = wechat.errcode !== undefined && wechat.errcode !== 0;
      if (httpFail || apiFail) {
        // 失败不记指纹 → 下个 tick 内容未变仍会重试（自愈）
        const reason = httpFail
          ? `webhook HTTP ${res.status}（未记指纹，下拍重试）`
          : `企微 errcode=${wechat.errcode} errmsg=${wechat.errmsg}（未记指纹，下拍重试）`;
        results.push({ type: report.report_type, date: report.date, pushed: false, reason });
        continue;
      }
      pushed += 1;
      state = recordPushed(state, { fingerprint: verdict.fingerprint, type: report.report_type, date: report.date }, now);
      results.push({ type: report.report_type, date: report.date, pushed: true, reason: verdict.reason });
    } catch (e) {
      results.push({ type: report.report_type, date: report.date, pushed: false, reason: `推送失败: ${e?.message || e}（未记指纹，下拍重试）` });
    }
  }
  if (stateFile) savePushState(stateFile, state);
  return { results, pushed, skipped: list.length - pushed, state };
}

// ── 调度闸门（纯函数；跳过 = 正常退出，不是错误）────────────────────────
/** 盘前闸门：北京当日为交易日（09:05 cron；非交易日不出盘前报告）。 */
export function gatePreMarket(now = new Date(), holidays = resolveHolidays()) {
  const ph = marketPhase(now, holidays);
  return ph.isTradingDay
    ? { ok: true, reason: `交易日 ${ph.bjDate}（北京 ${ph.bjTime}）→ 生成盘前报告` }
    : { ok: false, reason: `北京 ${ph.bjDate} 非交易日 → 盘前报告跳过` };
}

/** 盘中闸门：相位 live（09:30~15:00；与 snapshot_intraday 同一判据源）。 */
export function gateIntraday(now = new Date(), holidays = resolveHolidays()) {
  const ph = marketPhase(now, holidays);
  return ph.phase === 'live'
    ? { ok: true, reason: `相位 live（北京 ${ph.bjDate} ${ph.bjTime}）→ 生成盘中报告` }
    : { ok: false, reason: `相位 ${ph.phase}（北京 ${ph.bjDate} ${ph.bjTime}）→ 盘中报告跳过` };
}

/**
 * 周报闸门：tradeDate 必须是**本周最后一个交易日**（正常为周五；
 * 节前半周则为节前最后交易日——用 calendar.closed 判定，不写死周五）。
 * @param {string} tradeDate YYYY-MM-DD（dual_track 的数据日）
 * @param {string[]} closedDays 休市日数组（data/calendar.json::closed）
 */
export function gateWeekly(tradeDate, closedDays = []) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate || '')) return { ok: false, reason: `tradeDate 非法: ${tradeDate}` };
  const closed = new Set(closedDays);
  const cur = new Date(`${tradeDate}T00:00:00Z`);
  const dow = cur.getUTCDay(); // 0=周日 … 6=周六
  // 回退到本周一（ISO 周）
  cur.setUTCDate(cur.getUTCDate() - ((dow + 6) % 7));
  const weekMonday = cur.toISOString().slice(0, 10);
  // 从 tradeDate 次日起走到本周日：其间还有交易日 → tradeDate 不是本周最后交易日
  const probe = new Date(`${tradeDate}T00:00:00Z`);
  for (;;) {
    probe.setUTCDate(probe.getUTCDate() + 1);
    if (probe.getUTCDay() === 0) break; // 到周日为止（周六日本就非交易日）
    const iso = probe.toISOString().slice(0, 10);
    if (probe.getUTCDay() >= 1 && probe.getUTCDay() <= 5 && !closed.has(iso)) {
      return { ok: false, reason: `本周后续仍有交易日 ${iso} → 周报等 ${iso} 收盘后再生成（本周一 ${weekMonday}）` };
    }
  }
  return { ok: true, reason: `${tradeDate} 为本周（周一起 ${weekMonday}）最后交易日 → 生成周报` };
}
