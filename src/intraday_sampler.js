// ─────────────────────────────────────────────────────────────────────────────
// S3-1 页面即时轨采样器（浏览器 ESM，自启动；挂 window.__intradayLive）──────────
// ─────────────────────────────────────────────────────────────────────────────
// 数据流：data/paper/dual_track_latest.json::intraday_valuation（估值锚，生产方
// 数字唯一出处）+ 腾讯指数实时涨幅（JSONP 变量捕获，模式与 ui/src/lab-realtime.js
// 同源——dist 审计面不在部署面，故自带一份）→ src/intraday_live.js 纯函数估值
// → localStorage 当日序列（60 秒采样，跨日重置）→ window.__intradayLive 桥发布
// accountStats 形态对齐的 live 账本（S3-4 报告卡片 / S3-2 dd_now 的 input.live）。
//
// 降级纪律（全部静默，不冒充不报错弹窗）：
//   · 估值锚段缺席（老档）→ 待命（__intradayLive = null 直到锚就位）
//   · 非交易时段（quote.js::inTradingSession）→ 不采样，桥保持最近一次快照
//   · 任一指数实时涨幅缺失 → 本次采样放弃（intradayEquity 返回 null）
//   · fetch/JSONP 失败 → 本轮跳过，下轮重试（60 秒节拍不变）
import { inTradingSession } from './quote.js';
import {
  intradayEquity, buildLiveAccount, liveAccountStats, dailyDrawdown, riskTierDistance,
  seriesKey, appendSample, deserializeSeries,
} from './intraday_live.js';

const TICK_MS = 60 * 1000; // 采样节拍（用户拍板：盘中每 1 分钟）
const LS_KEY = 'asent-ilv-store';

// ── JSONP 变量捕获（腾讯 qt.gtimg.cn：返回 var v_xxx="..." 裸赋值，与
//    ui/src/lab-realtime.js::jsonpVar 同一模式；部署面不加载 lab-realtime）──
function jsonpVar(url, varNames) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    const tmo = setTimeout(() => { s.remove(); reject(new Error('timeout')); }, 9000);
    s.onload = () => {
      clearTimeout(tmo);
      const out = {};
      varNames.forEach((n) => { try { out[n] = window[n]; } catch { /* 跨域变量不可读 */ } });
      s.remove();
      resolve(out);
    };
    s.onerror = () => { clearTimeout(tmo); s.remove(); reject(new Error('network')); };
    s.referrerPolicy = 'no-referrer';
    s.src = url + (url.includes('?') ? '&' : '?') + '_=' + Date.now();
    document.head.appendChild(s);
  });
}

/** 拉池指数实时涨幅（腾讯口径：f[32] = 涨跌幅%）。返回 { [资产名]: { pct } }；全失败 → null */
async function fetchPoolQuotes(pool) {
  const codes = pool.filter((p) => p && p.code).map((p) => p.code);
  if (!codes.length) return null;
  try {
    const res = await jsonpVar('https://qt.gtimg.cn/q=' + codes.join(','), codes.map((c) => 'v_' + c));
    const byCode = {};
    for (const p of pool) {
      if (!p || !p.code) continue;
      const f = String(res['v_' + p.code] || '').split('~');
      // 腾讯字段布局（src/quote.js 口径注释）：[32]涨跌幅%——按代码对齐（不依赖 GBK 名称字段）
      if (f.length > 32 && Number.isFinite(+f[32])) byCode[p.name] = { pct: +f[32] };
    }
    return Object.keys(byCode).length ? byCode : null;
  } catch {
    return null;
  }
}

// ── 状态 ──
let anchor = null;      // intraday_valuation 段（估值锚）
let samples = [];        // 当日权益序列 [{date, ts, equity}]
let lastKey = null;      // 当日序列键（跨日检测）
let timer = null;

function todayStr() { return new Date().toISOString().slice(0, 10); }

function loadSeries(key) {
  try {
    return deserializeSeries(JSON.parse(localStorage.getItem(LS_KEY) || 'null'), key);
  } catch { return []; }
}

function persistSeries(key) {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ key, samples })); } catch { /* 隐私模式等 → 内存态降级 */ }
}

/** 桥发布（S3-4 报告卡片读这里装配 input.live；第二步快照卡展示行同源） */
function publish() {
  const account = anchor && samples.length
    ? buildLiveAccount({
      navSeries: anchor.nav_series,
      equityRealtime: samples[samples.length - 1].equity,
      tradeDate: todayStr(),
      initCash: anchor.init_cash,
    })
    : null;
  const stats = account ? liveAccountStats(account) : null;
  window.__intradayLive = account
    ? {
      updatedAt: new Date().toISOString(),
      valuation: anchor,                    // 估值锚（equity_prev / pos_today / pool）
      samples,                               // 当日权益序列
      account,                              // accountStats 形态（generateIntraday input.live）
      stats,                                 // 便捷快照（total / drawdown / …）
      drawdownDaily: dailyDrawdown(samples), // 当日高点回撤（null = 不足两点）
      ddDistance: riskTierDistance(stats.drawdown), // 距下一档风控线（总回撤实时版口径，与报告同尺）
    }
    : null;
  window.dispatchEvent(new Event('intraday-live-update'));
}

async function tick() {
  if (!anchor || !inTradingSession()) return;
  const quotes = await fetchPoolQuotes(anchor.pool);
  if (!quotes) return;
  const val = intradayEquity({ equityPrev: anchor.equity_prev, posToday: anchor.pos_today, quotes });
  if (!val) return; // 任一资产缺涨幅 → 本次放弃（不冒充）
  const key = seriesKey(todayStr());
  if (key && key !== lastKey) { lastKey = key; samples = loadSeries(key); }
  samples = appendSample(samples, { date: todayStr(), ts: Date.now(), equity: val.equity });
  persistSeries(key || SERIES_KEY_PREFIX + 'unknown');
  publish();
}

async function loadAnchor() {
  try {
    const res = await fetch('./data/paper/dual_track_latest.json', { cache: 'no-store' });
    if (!res.ok) return;
    const doc = await res.json();
    const v = doc && doc.intraday_valuation;
    if (v && Number.isFinite(+v.equity_prev) && v.pos_today && Array.isArray(v.nav_series) && v.nav_series.length) {
      anchor = v;
      publish();
    }
  } catch { /* file:// / 离线 → 待命 */ }
}

// ── 自启动 ──
// ── 自启动 ──
loadAnchor();
// 中危1（2026-10-07）审计：定时器清理策略说明。本项目是经典整页文档（非 SPA：
// 无路由 / 无组件销毁周期 / 无模块热重载），本模块经 index.html 动态 import
// 仅评估一次（ESM 模块映射保证）——定时器是页面级单例，**随页面卸载由平台整体
// 回收**（浏览器保证 JS 堆与全部定时器一起销毁），无需 clearInterval。
// timer 槽位保留：它是未来停用即时轨（如 SIMULATION_MODE 扩展到前端）的抓手。
timer = setInterval(() => { loadAnchor(); tick(); }, TICK_MS);
if (document.visibilitychange !== undefined) {
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
}
