// 实时行情口径唯一来源（腾讯 qt.gtimg.cn，浏览器直连 + Node 可用）
//
// 为什么需要单独一份、而不是继续用存档收盘价：
//   模拟交易原来只能用「存档里出现过的票」取价（hot/lhb 约 101 只），池子里 1337 只票有
//   92% 点不动，界面提示「无真实行情，不可下单」。而存档本质是「收盘后生成的日频数据」，
//   它给不出任意代码的当前价，也给不出盘中价。要按实时真实价格买卖，就必须有一个
//   能查**全市场任意 A 股当前价**的来源。
//
// 为什么选腾讯 qt.gtimg.cn：
//   · 实测响应头 `Access-Control-Allow-Origin: *` → 浏览器可直连，不需要后端代理
//     （这一点是选型的决定性因素：本系统是纯静态零构建站点，没有服务端可用）
//   · 支持一次请求多只（60 只/批，官方惯例），全市场扫描可行
//   · 返回最后成交时间戳，能判断「这个价是盘中实时的，还是上一交易日收盘价」
//   · 与管道侧 fetchHotQuotes 同源同字段，前端与后端口径天然一致
//
// 严格的诚实边界（与 src/lhb.js / src/global.js 同一套纪律）：
//   1. 拿不到就是拿不到——绝不用历史价、存档价冒充「实时价」。取不到价就返回 null，
//      由调用方决定降级方式与文案，不在这里悄悄填一个看起来合理的数字。
//   2. 区分「实时价」与「最近收盘价」：非交易时段（含周末/节假日/收盘后）腾讯返回的是
//      最近一次真实收盘价 + 它的时间戳。这仍然是**真实价格**，但必须标注它是什么，
//      不能谎称是盘中实时价。
//   3. 不做任何价格推算/插值/平滑——行情只做搬运与解析。

import { quoteSymbol } from './sources.js';

/** 腾讯行情接口（与管道侧同源）；HTTP 与 HTTPS 都可用，HTTPS 便于浏览器直连 */
export const QUOTE_ENDPOINT = 'https://qt.gtimg.cn/q=';

/** 单批请求代码数上限（腾讯惯例 60；批太大容易被截断或拒绝） */
export const BATCH_SIZE = 60;

/**
 * A 股连续竞价时段（北京时间，仅用于给行情打「实时/收盘」标注，不参与撮合）。
 * 09:30-11:30 / 13:00-15:00。集合竞价（09:15-09:25）也视为盘中。
 */
export const SESSIONS = [
  [9 * 60 + 15, 11 * 60 + 30],
  [13 * 60, 15 * 60],
];

/** 十进制度数 → 分钟数（用于时段比较） */
function minutesOf(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.getHours() * 60 + d.getMinutes();
}

/** 是否处于 A 股连续竞价/集合竞价时段（按本地时间的钟点判定；交易日历由调用方把关） */
export function inTradingSession(date = new Date()) {
  const m = minutesOf(date);
  return SESSIONS.some(([a, b]) => m >= a && m <= b);
}

/**
 * 解析腾讯行情一行文本 → 结构化报价。
 * 字段布局（实测确认，88 个 ~ 分隔字段）：
 *   [1]名称(GBK) [2]代码 [3]现价 [4]昨收 [5]今开
 *   [30]最后成交时间 yyyyMMddHHmmss [31]涨跌额 [32]涨跌幅%
 *   [33]最高 [34]最低 [36]成交量(手) [38]换手率%
 * 返回 null 表示这一行没有可用价格——**不做兜底填充**。
 * @param {string} line 形如 `v_sz300893="51~名称~300893~15.13~..."`
 * @param {string} [name] 覆盖名称（一般不必传：名称就在 f[1]，且调用方已整体解码 GBK）
 */
export function parseQuoteLine(line, name) {
  const m = String(line || '').match(/v_((?:sh|sz|bj)\d{6})="([^"]*)"/);
  if (!m) return null;
  const sym = m[1];
  const f = m[2].split('~');
  const code = f[2] || sym.slice(2);
  const price = parseFloat(f[3]);
  // 关键：停牌 / 未上市 / 无成交时 [3] 可能为空或 0，一律视为「无价」
  if (!Number.isFinite(price) || price <= 0) return null;
  const prevClose = parseFloat(f[4]);
  const chg = parseFloat(f[32]);
  const ts = String(f[30] || '');
  const tickTime = /^\d{14}$/.test(ts)
    ? `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} ${ts.slice(8, 10)}:${ts.slice(10, 12)}:${ts.slice(12, 14)}`
    : null;
  return {
    code,
    symbol: sym,
    name: name || f[1] || '',
    price,
    prevClose: Number.isFinite(prevClose) && prevClose > 0 ? prevClose : null,
    open: (() => { const v = parseFloat(f[5]); return Number.isFinite(v) && v > 0 ? v : null; })(),
    high: (() => { const v = parseFloat(f[33]); return Number.isFinite(v) && v > 0 ? v : null; })(),
    low: (() => { const v = parseFloat(f[34]); return Number.isFinite(v) && v > 0 ? v : null; })(),
    // 涨跌幅优先用源给的 [32]；源没给就用昨收现算（两者都是真实数据，不是推算价格）
    changePct: Number.isFinite(chg) ? chg
      : (Number.isFinite(prevClose) && prevClose > 0 ? Math.round((price / prevClose - 1) * 10000) / 100 : null),
    turnover: (() => { const v = parseFloat(f[38]); return Number.isFinite(v) ? v : null; })(),
    tickTime,
    tickDate: tickTime ? tickTime.slice(0, 10) : null,
    src: 'qt',
  };
}

/**
 * 把一批代码解析成 { code: quote }，丢弃无价条目。
 * @param {string} text 接口原始文本（GBK 已解码）
 */
export function parseQuoteText(text) {
  const out = {};
  // 名称是 GBK 编码：调用方已整体解码，这里直接按行取（避免二次解码把中文弄乱）
  for (const m of String(text || '').matchAll(/v_((?:sh|sz|bj)\d{6})="([^"]*)"/g)) {
    const q = parseQuoteLine(m[0]);
    if (q) out[q.code] = q;
  }
  return out;
}

/**
 * 拉取一批代码的实时报价（自动分批、单批失败容错、返回已解析表）。
 * @param {string[]} codes 6 位代码
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl] 注入 fetch（Node 测试用；浏览器默认全局 fetch）
 * @param {number} [opts.batchSize]
 * @returns {Promise<{quotes: Object, failed: string[], requested: number, at: string}>}
 */
export async function fetchQuotes(codes, opts = {}) {
  const f = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const batchSize = opts.batchSize || BATCH_SIZE;
  const list = [...new Set((codes || []).map((c) => String(c).trim()).filter((c) => /^\d{6}$/.test(c)))];
  const quotes = {};
  const failed = [];
  if (!f) return { quotes, failed: list, requested: list.length, at: new Date().toISOString() };

  for (let i = 0; i < list.length; i += batchSize) {
    const batch = list.slice(i, i + batchSize);
    const syms = batch.map(quoteSymbol).filter(Boolean);
    if (!syms.length) continue;
    try {
      const res = await f(QUOTE_ENDPOINT + syms.join(','), {
        // 腾讯行情对 Referer 敏感：带上才稳定返回（实测无 Referer 偶发空响应）
        headers: { Referer: 'https://finance.qq.com' },
      });
      // 腾讯返回 GBK；浏览器侧用 arrayBuffer + TextDecoder('gbk') 解码
      let text;
      if (res && typeof res.arrayBuffer === 'function') {
        const buf = await res.arrayBuffer();
        text = decodeGBK(buf);
      } else {
        text = String((res && res.text) || '');
      }
      const parsed = parseQuoteText(text);
      for (const b of batch) if (parsed[b]) quotes[b] = parsed[b];
      for (const b of batch) if (!parsed[b]) failed.push(b);
    } catch (e) {
      // 单批失败只影响这一批，不炸整体
      for (const b of batch) failed.push(b);
    }
  }
  return { quotes, failed, requested: list.length, at: new Date().toISOString() };
}

/** GBK 解码（浏览器 TextDecoder('gbk')；Node 无该编码时退回按 latin1 读原始字节再逐字节映射不行 → 用内置 TextDecoder） */
function decodeGBK(buf) {
  try {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('gbk').decode(buf);
  } catch (e) { /* 环境不支持 gbk 时走下面兜底 */ }
  try {
    return Buffer.from(buf).toString('latin1');
  } catch (e) {
    return String(buf);
  }
}

/**
 * 给一条报价标注「这是什么价」——界面必须能区分实时价与最近收盘价。
 * @param {object} q 报价
 * @param {Date} [now]
 * @returns {{kind:'live'|'close', label:string, tickTime:string|null}}
 */
export function priceKind(q, now = new Date()) {
  if (!q) return { kind: 'close', label: '无报价', tickTime: null };
  const live = inTradingSession(now) && q.tickDate === toDateStr(now);
  return {
    kind: live ? 'live' : 'close',
    label: live ? '实时价' : '最近收盘价',
    tickTime: q.tickTime,
  };
}

function toDateStr(d) {
  const t = d instanceof Date ? d : new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

/** 生成请求代码（去重、过滤非法），供 UI 展示「查了哪些票」 */
export function normalizeCodes(codes) {
  return [...new Set((codes || []).map((c) => String(c || '').trim()).filter((c) => /^\d{6}$/.test(c)))];
}
