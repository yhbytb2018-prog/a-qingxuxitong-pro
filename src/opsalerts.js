// 运维告警（降维预埋 · 2026-10-02 拍板）：拦截器触发 → 结构化事件 → 落盘 + 可选企微推送。
//
// 「拦截器」= 管道既有的数据容灾 / 缺失显式化机制——meta.lastAttempt（抓取成败）、
// meta.freshness（数据滞后）、signals.imputedRatioLatest（补位超标线）、
// emotion.missing（缺失因子清单）、meta.dataQuality（源健康）。本模块**不新增任何
// 判定口径**，只把它们已经产出的「坏事实」翻译成告警事件——判定逻辑若有第二套，
// 就会和主口径漂移，那是比没有告警更糟的事。
//
// 纪律：
//   · push 失败**绝不抛出**（告警通道自身故障不能把数据管道搞崩——返回错误信息即可）；
//   · 无 OPS_WEBHOOK 环境变量 → 静默跳过推送（本地零打扰，CI 配 secret 才推）；
//   · 事件构造（opsEventsFromArchive）是纯函数可单测；副作用（fs / fetch）集中在
//     writeOpsAlerts / pushOpsAlerts 两个出口，且都由调用方包 try-catch（双保险）。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { atomicWriteJSON } from './fsutil.js';
import path from 'node:path';

// 事件严重度：error = 数据已坏（抓取失败/源失效）；warn = 可用但该看（滞后/补位超标）；info = 边界告知
export const OPS_SEVERITIES = ['error', 'warn', 'info'];

/**
 * ① smoke 终态失败事件（2026-10-08 第三批；CI smoke job 的 if: failure() step 调用，
 * 脚本入口 scripts/alert_smoke_fail.mjs）。纯函数：不读盘不推网——IO 由调用方负责。
 *
 * 语义边界：只描述「冒烟两次重试后仍败」这一事实及其下游影响（build 被拦 → 宽度/
 * 主线档当日不刷新）；账本接入 CI（⑥）后同被 build 拦，但正文按用户拍板只写
 * 宽度/主线，账本滞后走 ② 守卫的产出路径（freshness 门禁 + 消费端 missing），
 * 不在告警里混淆因果。
 *
 * @param {object|null} smoke data/smoke-latest.json（失败 run 刚落盘的形态：tradeDateAnchored /
 *                           allOk / hardFail[] / sources[]）；读不到传 null（正文自动降级）
 * @param {object} [o] { runId?: string, runUrl?: string, at?: string }
 * @returns {{at,severity,kind,source,detail}} 企微事件（kind: 'smoke-fail'）
 */
export function smokeFailEvent(smoke, { runId = null, runUrl = null, at = new Date().toISOString() } = {}) {
  const day = typeof smoke?.tradeDateAnchored === 'string' ? smoke.tradeDateAnchored : null;
  const hard = Array.isArray(smoke?.hardFail) ? smoke.hardFail.filter(Boolean) : [];
  const srcs = Array.isArray(smoke?.sources) ? smoke.sources : [];
  const pass = srcs.length ? `${srcs.filter((x) => x && x.ok).length}/${srcs.length}` : null;
  const lines = [
    `冒烟终态失败（含重试）@ 档案日 ${day ?? '未知'}` + (runId ? ` · run ${runId}` : ''),
    hard.length ? `硬失败源：${hard.join('；')}`
      : smoke && smoke.allOk !== false ? '落盘冒烟档为成功态（可能被后续 run 覆盖），失败详情见 run 日志'
      : '硬失败明细不可读（见 run 日志）',
    pass ? `通过率 ${pass}` : null,
    runUrl || null,
    '⚠ 宽度/主线档今日未刷新（build 被拦）',
  ].filter(Boolean);
  return { at, severity: 'error', kind: 'smoke-fail', source: 'smoke', detail: lines.join('\n') };
}

/**
 * 从存档构造运维告警事件（纯函数）。
 * @param {object} archive 管道产物（data/archive.json 结构：meta / signals / all_days）
 * @param {object} [opts]
 * @param {number} [opts.warnImputedRatio] 补位告警线（默认 0.34，与 config.healthWarnImputedRatio 同值——
 *                                          调用方应显式传 config.healthWarnImputedRatio 保持同源）
 * @param {string} [opts.now] ISO 时间戳（默认当前）
 * @returns {Array<{at,severity,kind,source,detail}>} 事件列表（可能为空 = 一切正常）
 */
export function opsEventsFromArchive(archive, { warnImputedRatio = 0.34, now = new Date().toISOString() } = {}) {
  const ev = [];
  const meta = archive?.meta || {};
  const signals = archive?.signals || {};
  const days = archive?.all_days || [];
  const latest = days[days.length - 1];

  // ① 抓取失败（走了回退档）：最严重——页面数据是旧的且 meta 里写着为什么
  const outcome = meta.lastAttempt?.outcome;
  if (outcome === 'failed') {
    ev.push({
      at: now, severity: 'error', kind: 'fetch-failed', source: 'pipeline',
      detail: `本跑抓取失败，写入回退档：${meta.lastAttempt?.reason || '原因未记录'}（页面数据非最新，见 meta.lastAttempt）`,
    });
  }

  // ② 数据滞后：存档交易日落后于最近已收盘交易日（源悄悄挂掉/连续失败的表现形态）
  // H-5（2026-10-07）：freshness.state 的合法值域是 fresh | pending | behind | unknown
  //（生成端 src/freshness.js:145），历史上这里误判 === 'stale'——永不触发的死分支，
  // 数据滞后告警形同虚设。stale 不是 state 的值，而是旁边那个独立布尔字段
  //（freshness.js:148 stale: state === 'behind'）。
  if (meta.freshness?.state === 'behind') {
    ev.push({
      at: now, severity: 'warn', kind: 'data-stale', source: 'freshness',
      detail: `存档已滞后（behind，落后 ${meta.freshness?.behindSessions ?? '?'} 个会话）${meta.staleReason ? '：' + meta.staleReason : ''}`,
    });
  }

  // ③ 补位超标：当日缺失因子按代理/中性补位的比例越过告警线（情绪分代表性存疑）
  const ir = Number(signals.imputedRatioLatest);
  if (Number.isFinite(ir) && ir > warnImputedRatio) {
    ev.push({
      at: now, severity: 'warn', kind: 'imputed-ratio-high', source: 'signals',
      detail: `最新日补位因子占比 ${(ir * 100).toFixed(1)}% 超过告警线 ${(warnImputedRatio * 100).toFixed(0)}%`,
    });
  }

  // ④ 缺失因子清单（信息级：分数算出来了，但哪些因子没真实数据应如实可见）
  const missing = latest?.emotion?.missing;
  if (Array.isArray(missing) && missing.length > 0) {
    ev.push({
      at: now, severity: 'info', kind: 'factors-missing', source: 'sentiment',
      detail: `最新交易日（${latest.trade_date}）缺失因子：${missing.join('、')}（已按缺失策略处理并留痕）`,
    });
  }

  // ⑤ 源健康：dataQuality 里任何 *Ok === false 的键（行业源失效等——键名防御式扫描，
  //    不锁死字段清单：未来新增的源健康标记自动被覆盖，不会静默漏报）
  const dq = meta.dataQuality;
  if (dq && typeof dq === 'object') {
    for (const [k, v] of Object.entries(dq)) {
      if (k.endsWith('Ok') && v === false) {
        ev.push({
          at: now, severity: 'error', kind: 'source-degraded', source: `dataQuality.${k}`,
          detail: `数据源健康标记 ${k} = false（该源当日失效，相关因子走了代理/中性通道）`,
        });
      }
    }
  }

  // 排序：error > warn > info（推送与落盘都按此序）
  return ev.sort((a, b) => OPS_SEVERITIES.indexOf(a.severity) - OPS_SEVERITIES.indexOf(b.severity));
}

/** 事件 → 企微机器人 text 消息（超长截断，机器人上限约 2048 字节）。 */
export function formatOpsText(events, { cap = 1900 } = {}) {
  const head = `【A股情绪系统 PRO · 运维告警】${events.length} 条`;
  const body = events.map((e) => `[${e.severity.toUpperCase()}] ${e.kind}（${e.source}）${e.detail}`).join('\n');
  const text = `${head}\n${body}`;
  return text.length > cap ? text.slice(0, cap) + '…' : text;
}

/**
 * 落盘（默认 data/ops-alerts-latest.json）：本轮事件 + 既往历史，保留最近 cap 条。
 * 结构：{ updatedAt, count, events: [...] }（events 按时间升序，旧→新）。
 * @returns {{updatedAt:string, count:number}} 落盘结果摘要（调用方可直接打日志）
 */
export function writeOpsAlerts(events, file, { cap = 50, now = new Date().toISOString() } = {}) {
  if (!file) throw new Error('writeOpsAlerts: file 必填');
  const list = Array.isArray(events) ? events : [];
  let history = [];
  try {
    const prev = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(prev?.events)) history = prev.events;
  } catch { /* 首次落盘或旧文件损坏 → 从零开始 */ }
  const merged = [...history, ...list].slice(-cap);
  const out = { updatedAt: now, count: merged.length, events: merged };
  mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteJSON(file, JSON.stringify(out, null, 2) + '\n');
  return { updatedAt: now, count: merged.length };
}

/**
 * 推送到企微机器人（webhook 取 env[webhookEnv]，未配置 → 跳过）。
 * @returns {Promise<{pushed:number, skipped?:boolean, error?:string}>}
 * 纪律：任何失败都返回错误信息而**不抛出**。
 */
export async function pushOpsAlerts(events, { env = process.env, fetchImpl, webhookEnv = 'OPS_WEBHOOK' } = {}) {
  const url = env?.[webhookEnv];
  if (!url || !Array.isArray(events) || events.length === 0) return { pushed: 0, skipped: true };
  const fetchFn = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchFn) return { pushed: 0, skipped: true, error: '当前环境无 fetch' };
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: formatOpsText(events) } }),
    });
    if (!res.ok) return { pushed: 0, error: `webhook HTTP ${res.status}` };
    return { pushed: events.length };
  } catch (e) {
    return { pushed: 0, error: String(e?.message || e) };
  }
}
