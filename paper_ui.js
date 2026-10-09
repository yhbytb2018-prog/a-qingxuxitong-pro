// 模拟交易台前端（ESM，浏览器直接加载，无构建步骤）
//
// 与 app.js 的分工：
//   · app.js 继续负责「只读展示」（情绪/回测/报告/外围），不碰账户状态
//   · 本文件负责「有状态交互」（账户、下单、结算），并把交易规则判断全部委托给 src/paper.js
// 这样做的原因：交易规则一旦在 UI 里再写一遍，就会和引擎漂移——模拟器的价值恰恰是
// 「规则和真实一致」，所以规则只能有一个出处。
//
// 持久化：localStorage（单机、无后端）。key 带版本号，升级引擎时旧账本不会被误读。

import {
  emptyAccount, submitOrder, cancelOrder, settleDay, accountStats, paperMetrics,
  exportAccount, importAccount, fees, fillPrice, boardOf, limitPctOf, isStName,
  validateOrder, quotesFromDay, PAPER_VERSION, LOT, MIN_COMMISSION,
  COMMISSION_RATE, STAMP_TAX_RATE, TRANSFER_FEE_RATE, DEFAULT_SLIP, REJECT,
  LIMIT_PCT, isLimitHit, POS_TIERS, CUT_TIERS, qtyByAssetPct, qtyByHoldPct,
  // ── V5.2-pro：批量委托与事件日志（规则第五、六块）──
  // 批量下单面板与事件日志面板的**全部规则判断**仍由引擎负责，UI 只解析输入、渲染结果。
  // 为什么不在 UI 里自己拼一遍过滤/风控链路：那就是规则的第二出处，一旦漂移，
  // 页面上显示的「拦没拦住」就和账本里实际发生的「拦没拦住」不是一回事。
  batchSubmit, batchSell, readLogs, logsToReport, orderDetail, MAX_LOGS,
  // 风控口径常量：日志面板在「全部/风控」过滤之外还要按档位说明拦截原因，取同一份阈值
  MAX_DAILY_POSITION_CHANGE, HARD_STOP_LOSS, DD_TIERS,
} from './src/paper.js';
// 龙虎榜前置过滤（规则第一块，唯一出处 src/lhbfilter.js）。
// 批量买入时引擎内部会调用它；UI 侧另需 filterOne 来**预检并解释**——
// 让用户在提交前就能看到「这几只为什么不给买」，而不是提交后只看到一句「未通过」。
// 降级规则（龙虎净买 ≤ 0）的常量也从唯一出处取——UI 一处都不手抄：
// 扣分值 LHB_NET_OUTFLOW_PENALTY 用于提示条文案，FLAG_LHB 用于告警标签，
// isNetOutflow 供 outflowOf 判断（判断本身还走 filterOne 的桶判定）。
import { filterOne, BUCKET, LHBFILTER_VERSION, LHB_NET_OUTFLOW_PENALTY, FLAG_LHB, isNetOutflow } from './src/lhbfilter.js';
// 实时行情（腾讯 qt.gtimg.cn，CORS 为 * → 浏览器可直连）。
// 为什么必须引入：存档是「收盘后生成的日频数据」，只含当日上榜/热点约 100 只票，
// 池子里其余 1200+ 只票取不到价，界面只能提示「无真实行情，不可下单」。
// 要按实时真实价格买卖，就必须有一个能查全市场任意 A 股当前价的来源。
import { fetchQuotes, priceKind, inTradingSession, normalizeCodes } from './src/quote.js';
// 研判推荐引擎（把市场研判结论落到具体个股）。
// 规则同样只有一个出处：src/picks.js。本文件只负责渲染、以及把用户点击转成下单区输入。
import { recommendPicks, PICK_TOP_N, SCORE_WEIGHTS, NET_OUTFLOW_TAG } from './src/picks.js';
// 双层预警引擎（大盘层档位偏离 + 持仓层止损/集中度/T+1）。
// 与 picks.js 同纪律：规则只有一个出处（src/alerts.js），UI 只渲染 + 把动作转成下单区输入。
import { buildAlerts, MARKET_CFG, POS_CFG, LEVELS } from './src/alerts.js';
// 预警台账与收益归因——回答「预警到底有没有帮我少亏、多赚」。
// 同样只有一个出处（src/alert_log.js）：UI 只负责把当前预警喂进台账、把归因结果画出来。
import { appendSignals, summarizeLog, summarizeText, LOG_CAP } from './src/alert_log.js';
// 模拟交易复盘引擎——回答「这笔交易为什么赚、为什么亏」。
// 研判报告（app.js）里新增的「⑦ 模拟交易复盘」段落读的就是它。此处只在每次账户变化后
// 把「账户 + 台账 + 实时价快照 + 情绪分」挂到 window.__paperSnapshot，报告端据此生成段落。
// 为什么用 window 桥接而不是让 app.js import：app.js 是经典脚本（不能用 import），
// paper_ui.js 是 module，两者没有共享状态。挂一个带版本号的快照是最小的耦合面。
import { REVIEW_VERSION } from './src/paper_review.js';
// 标的池的 reason 走码表压缩，前端解回明文（见 boot 内注释）
import { decodeStrField } from './src/lhb_codec.js';

// ── config.json 桥（唯一事实源的前端入口）──
// 静态 import 失败会挂掉整个 paper_ui（旧浏览器不支持 import attributes），
// 故用动态 import + 静默降级：拿到就挂 window.ASENT_CONFIG，拿不到就走各处兜底默认值
// （app.js 的 TH_DEFAULT 等）。app.js 是经典脚本无法 import，运行时从 window 取——
// module 总在经典脚本之后、DOMContentLoaded 前执行完毕，而 app.js 的阈值消费点
// （getThresholds 等）都在用户交互/数据加载时才调用，时序安全。
import('./config.json', { with: { type: 'json' } })
  .then((m) => { window.ASENT_CONFIG = m.default; })
  .catch(() => { /* 旧浏览器/异常路径：静默降级，走兜底默认值 */ });

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v, d = 2) => (v == null || !Number.isFinite(+v)) ? '—'
  : (+v).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
const yi = (v) => (v == null || !Number.isFinite(+v)) ? '—' : (v / 1e4).toFixed(2);
const pct = (v, d = 2) => (v == null || !Number.isFinite(+v)) ? '—' : `${v > 0 ? '+' : ''}${(+v).toFixed(d)}%`;
// 涨跌配色沿用中文语境：涨=红、跌=绿
const cls = (v) => (v == null || !Number.isFinite(+v)) ? 'muted' : (v > 0 ? 'hl' : v < 0 ? 'hl-dn' : 'muted');

const LS_KEY = 'paper-acct-' + PAPER_VERSION;
// 预警台账 key **不带** PAPER_VERSION：台账记的是「当时预警说了什么、后来价格怎么走」，
// 这是历史事实，不随交易引擎版本升级而失效。带版本号会导致升级后战绩被清空，
// 而那恰恰是最该保留的东西（用户要拿它判断「这套预警值不值得继续听」）。
const AL_KEY = 'paper-alerts-log';
/** 初始资金默认值（元）。用户可在账户总览里自定义，自定义值另存 PAPER_INIT_KEY。 */
const INIT_CASH = 1000000;
/**
 * 自定义初始资金的持久化 key。
 * 为什么单独存一份、而不直接读账户的 initCash：用户可能想「先设 50 万，过会再建账户」，
 * 或者重置前先看看能改多少。把「偏好」与「账户事实」分开，重置时才能按用户设定的金额重建，
 * 而不是被上一次的账户值绑架。**不带 PAPER_VERSION**——这是用户偏好，不是引擎数据。
 */
const INIT_KEY = 'paper-init-cash';
/** 初始资金合法区间：下限 1000（连一手低价股都买不起的账户没意义），上限 10 亿（防手滑多打 0）。 */
const INIT_MIN = 1000;
const INIT_MAX = 1000000000;
const SLIP = DEFAULT_SLIP;

let ACCT = null;          // 当前账户
let UNI = null;           // 标的池（仅作「参考/快速选择」，不再是可下单的白名单）
let UNI_META = {};
let QMAP = {};            // 存档当日行情 code → quote（降级用）
let LIVEQ = {};           // 实时行情 code → quote（腾讯源，优先）
let LIVE_AT = null;       // 最近一次实时抓取时刻
let LIVE_FAIL = [];       // 最近一次抓取失败的代码
let LIVE_BUSY = false;    // 抓取中（防重复请求）
let LAST_DATE = null;     // 存档最新交易日
let ARC_DAYS = [];        // 存档全部交易日（研判推荐用：取最后一天算推荐，取序列算情绪分）
let ORDER = { side: 'buy', code: '', qty: 0 };
// 单独下单区的「自定义比例买入」输入值（百分数，如 15 表示 15%）。
// 要保留在内存里：renderQuick 会因行情刷新/方向切换重渲染，值若丢用户得重填。
// 但切换代码时要清零——上一个票填的 15% 是针对那只票的，套到新票上是误操作。
let PQ_PCT = null;
let HIST = { view: 'trade' };
// ── 批量下单面板状态 ──
// side/mode 是「输入解释方式」，不是账户状态：side 决定走 batchSubmit 还是 batchSell，
// mode 决定第 2 列的数值是「占总资产比例%」还是「股数」。两者都不持久化——
// 下次打开页面时回到最保守的默认（买入 + 按比例），避免上一次的激进设置被静默沿用。
let BATCH = { side: 'buy', mode: 'pct', defaultPct: 5, applyLhb: true, checkRisk: true, result: null };
// ── 事件日志面板状态 ──
// stage 为空串表示「全部」。这是**视图过滤**，不改数据，只改渲染。
let LOG = { stage: '' };
// 预警台账（持久化，跨会话累积）。不放进 ACCT —— 它不是账户状态，导出账本时也不该混进去。
let ALOG = [];

// ── 人工复核门槛（降级规则：龙虎榜净买入 ≤ 0）──
// 规则原文：「不直接禁止委托，但扣分降优先级 + 打告警标签 + **人工复核后才允许下单**」。
// 这条门槛是**会话级、按代码记账、一次性**的：
//   · 不持久化——复核是「本次操作前我确实看过依据了」的确认，隔天/重载后旧确认不成立；
//   · 不绑定数量——用户改的是数量，不是「我看过净流出了」这个事实；
//   · 一次性——放行一次后即清除，避免一张票反复下单都靠同一次确认。
// 改代码/改方向/改数量都会清空，见 clearReview()。
let REVIEW_OK = new Set();

/** 取该票的降级信息（龙虎净买 ≤ 0 且有人工复核要求）。非降级票返回 null。 */
function outflowOf(code) {
  const c = String(code || '');
  if (!c) return null;
  try {
    const day = ARC_DAYS[ARC_DAYS.length - 1];
    if (!day) return null;
    // 走规则引擎判定，绝不自己比 netWan <= 0 —— 那是规则，不是渲染。
    const f = filterOne(c, day, {
      marketNetWan: day.summary && day.summary.lhb_daily_net != null
        ? +day.summary.lhb_daily_net * 1e4 : null,
    });
    return f && f.netOutflow ? f : null;
  } catch (e) { return null; }
}

/** 复核是否已通过（未通过则下单被门槛拦住） */
function reviewPassed(code) { return REVIEW_OK.has(String(code || '')); }

/** 标记复核已通过——只应由「用户显式确认」这一个入口调用 */
function markReviewed(code) { REVIEW_OK.add(String(code || '')); }

/** 清空复核标记：换代码 / 换方向时必须清，否则上一个票的确认会被顺延到新票上 */
function clearReview() { REVIEW_OK.clear(); }

// ────────────────────────── 持久化 ──────────────────────────

/**
 * 读取用户设定的初始资金（元）。没设过就用默认 100 万。
 * 越界/非数值一律回落到默认值——宁可用默认的 100 万，也不要一个非法金额建出诡异账户。
 */
function loadInitCash() {
  try {
    const raw = localStorage.getItem(INIT_KEY);
    if (raw == null) return INIT_CASH;
    const v = Math.round(+raw);
    if (!Number.isFinite(v) || v < INIT_MIN || v > INIT_MAX) return INIT_CASH;
    return v;
  } catch (e) {
    return INIT_CASH;
  }
}

/** 保存用户设定的初始资金。越界直接拒绝并说明区间（不静默夹紧——用户要能发现填错了）。 */
function saveInitCash(v) {
  const n = Math.round(+v);
  if (!Number.isFinite(n) || n < INIT_MIN || n > INIT_MAX) {
    msg(`初始资金需在 ${INIT_MIN.toLocaleString()} ~ ${INIT_MAX.toLocaleString()} 元之间（当前填的是 ${v}）`, 'err');
    return null;
  }
  try {
    localStorage.setItem(INIT_KEY, String(n));
  } catch (e) { /* 存储不可用则只在本次会话生效 */ }
  return n;
}

function save() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(ACCT));
  } catch (e) {
    msg('保存失败：' + e.message + '（浏览器存储不可用或已满）', 'err');
  }
}

function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const r = importAccount(raw);
    if (!r.ok) {
      msg('本地账本无法读取（' + r.error + '），已重新开始', 'err');
      return null;
    }
    return r.account;
  } catch (e) {
    return null;
  }
}

/** 导入后必须写入 localStorage 的格式与导出格式不同（导出是带元信息的可读文件） */
function persistRaw(acct) {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ ...acct, version: PAPER_VERSION })); } catch (e) { /* 静默 */ }
}

// ── 预警台账持久化 ──
//
// 为什么不放在 ACCT 里：① 台账不是「账户状态」，导出账本时混进去会让导入方多一份无关数据；
// ② 账户可以随时重置（一键清空），但**预警战绩不该跟着清零**——它衡量的正是规则本身。
// 读取时逐条做形状校验：任何一条不合规就整条丢弃（不是整份丢弃）——台账是累积记录，
// 一条脏数据不应该毁掉其余全部历史。

/** 台账条目形状校验（与 src/alert_log.js 的落账字段一一对应） */
function validLogEntry(e) {
  return !!e && typeof e === 'object'
    && typeof e.key === 'string' && e.key
    && (e.layer === 'market' || e.layer === 'position')
    && typeof e.type === 'string' && e.type
    && typeof e.action === 'string' && e.action
    && (e.layer === 'market' || Number.isFinite(+e.px));
}

function loadAlertLog() {
  try {
    const raw = localStorage.getItem(AL_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(validLogEntry).slice(-LOG_CAP);
  } catch (e) {
    return [];
  }
}

function saveAlertLog() {
  try {
    localStorage.setItem(AL_KEY, JSON.stringify(ALOG));
  } catch (e) {
    // 存储不可用/已满：台账只是战绩记录，写不进去不该打断交易流程，但要说清后果
    msg('预警台账保存失败（' + e.message + '）：本会话的战绩不会被记住', 'warn');
  }
}

function msg(text, kind) {
  const el = $('paperMsg');
  if (!el) return;
  el.textContent = text || '';
  // warn 用于「部分成功」——既不是全成功也不是全失败，用警示色避免被当成成功略过
  el.className = kind === 'err' ? 'hl-dn' : kind === 'ok' ? 'hl' : kind === 'warn' ? 'bf-warn' : 'muted';
  const ms = kind === 'warn' || kind === 'err' ? 12000 : 6000;
  if (text) setTimeout(() => { if (el.textContent === text) { el.textContent = ''; el.className = 'muted'; } }, ms);
}

// ────────────────────────── 实时行情 ──────────────────────────

/**
 * 抓一批代码的实时行情并并进 LIVEQ。
 * 为什么是「合并」而不是「替换」：用户每输入一个代码就抓一次，若整表替换，
 * 之前查过的票会立刻失去实时价（持仓列表、待成交列表都会闪回存档价）。
 * 合并保留已取到的价，配合 LIVE_AT 标注抓取时刻。
 * @returns {Promise<{ok:number, failed:string[]}>}
 */
async function refreshLive(codes) {
  const list = normalizeCodes(codes);
  if (!list.length) return { ok: 0, failed: [] };
  LIVE_BUSY = true;
  try {
    const r = await fetchQuotes(list);
    const got = Object.keys(r.quotes).length;
    if (got) {
      LIVEQ = { ...LIVEQ, ...r.quotes };
      LIVE_AT = new Date();
    }
    LIVE_FAIL = r.failed || [];
    return { ok: got, failed: LIVE_FAIL };
  } catch (e) {
    // 网络/跨域失败：不炸界面，降级回存档价，并在下单区如实提示
    LIVE_FAIL = list;
    return { ok: 0, failed: list };
  } finally {
    LIVE_BUSY = false;
  }
}

/** 抓当前屏幕上所有需要现价的代码（下单标的 + 持仓 + 待成交），一次批量拉齐 */
async function refreshAllLive() {
  const codes = [
    ORDER.code,
    ...Object.keys(ACCT?.positions || {}),
    ...(ACCT?.pending || []).map((p) => p.code),
  ];
  const uniq = normalizeCodes(codes);
  if (!uniq.length) return { ok: 0, failed: [] };
  const r = await refreshLive(uniq);
  // 用实时价刷新持仓浮盈（持仓的 last 字段是显示用，成本/数量不动）
  syncPositionsLive();
  return r;
}

/** 用最新实时价更新持仓的现价字段（只动 last/lastDate，不碰成本与数量） */
function syncPositionsLive() {
  if (!ACCT?.positions) return;
  let changed = false;
  const positions = { ...ACCT.positions };
  for (const code of Object.keys(positions)) {
    const q = LIVEQ[code];
    if (!q || !Number.isFinite(+q.price)) continue;
    if (positions[code].last !== q.price || positions[code].lastDate !== q.tickDate) {
      positions[code] = { ...positions[code], last: q.price, lastDate: q.tickDate || LAST_DATE, pxStale: false };
      changed = true;
    }
  }
  if (changed) { ACCT = { ...ACCT, positions }; save(); }
}

// ────────────────────────── 数据装载 ──────────────────────────

/**
 * 还原惰性字段（`_sub` → 原位置）。
 *
 * 引擎侧把"席位明细"和"龙虎原始榜"从每日顶层提到了 `_sub` 以省首屏流量
 * （见 src/lhb_codec.js）。模拟器唯一需要的是 `lhb`：quotesFromDay() 从
 * `day.lhb` 取收盘价，但它是**未提子**的原始榜——最新的 latest 带 `_sub`，
 * 而 29 个曲线点字段已被裁到最小集（没有 lhb），故这里的还原是"有则归位"。
 *
 * 缺少 lhb 的曲线点不影响结算：quotesFromDay 对空数组返回 {}，
 * 那些日子本就没有该股行情，与"字段被省掉了"是两回事——但为安全起见，
 * 我们只对**带 _sub 的那一天**（即 latest）做还原。
 */
function liftSeats(day) {
  if (!day || !day._sub) return day;
  const { _sub, ...rest } = day;
  const out = { ...rest };
  if (_sub.lhb != null) out.lhb = _sub.lhb;
  if (_sub.seats != null) out.summary = { ...(rest.summary || {}), seats: _sub.seats };
  return out;
}

// ── 滚动窗的**跨模块单次拉取** ──────────────────────────────────────────────
// 为什么必须共享：`app.js`（主页面，index.html 里先求值的普通 script）与
// `paper_ui.js`（同为该文档的 type=module，**晚于 app.js 求值**）在同一次首屏
// 各拉一次 `archive-recent.json`，真浏览器网络中实测就是**两次 204KB 请求**
// （首屏 1056KB，其中一份纯属重复）。分层加载的首屏成本本来只有 200KB 级，
// 多拉一次直接吃掉一半收益。
// 故：入口由**先求值的 app.js** 建立并挂到 window，本文件复用同一 promise。
// 若因加载顺序异常没挂上，则本地兜底（宁可多拉一次，也不能拉不到）。
function loadRecentArchive() {
  if (typeof window !== 'undefined' && typeof window.__loadRecentArchive === 'function') {
    return window.__loadRecentArchive();
  }
  if (typeof window !== 'undefined') {
    if (!window.__recentPromise) {
      window.__recentPromise = fetch('./data/archive-recent.json?_=' + Date.now(), { cache: 'no-store' })
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error('HTTP ' + res.status))))
        // H-2：成功时刻记入共享时间戳（与 app.js 同一槽位）——TTL 过期判定
        // 统一由 app.js 的读取端负责，本兜底只保证写入的档不比正常路径活得"更久"。
        .then((d) => { window.__recentPromiseAt = Date.now(); return d; })
        .catch((e) => { window.__recentPromise = null; window.__recentPromiseAt = null; throw e; });
    }
    return window.__recentPromise;
  }
  return fetch('./data/archive-recent.json?_=' + Date.now(), { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error('HTTP ' + res.status))));
}

/** 滚动窗 → 日期升序的逐日序列（含最新日明细，quotesFromDay 只认 latest 的 hot/lhb_aggr）。 */
function recentDays(arc) {
  return (arc && arc.kind === 'archive-recent'
    ? [...(arc.days || []), ...(arc.latest ? [arc.latest] : [])]
    : ((arc && arc.all_days) || []))
    .map(liftSeats)
    .sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)));
}

// ────────────────────────── 标的池：分档加载 ──────────────────────────
//
// 标的池（data/paper_universe.json，3558 只 / 1059KB）是首屏最重的请求，比滚动窗还大 5 倍。
// 但它承担两类**时效要求完全不同**的职责，拆开就能把首屏成本砍掉七成：
//
//   · 硬依赖（必须首屏）：代码 → 名称映射。账户持仓、待成交、预警台账、推荐个股全都要
//     显示股票名，没有它整页都是光秃秃的代码。字段只有 code + name。
//   · 软依赖（可延后）：板段/ST/涨跌停幅度/最近收盘价/换手/amount 来源，只在
//     **用户真正输入代码或准备下单**时才需要 —— 那时已经过了 200ms 防抖，晚到几十毫秒无感。
//
// 关键前提：所有软依赖都是**纯函数可推导**的（board/boardLabel/tradable/limitPct/st/active），
// 或者只影响「输入框旁的一行提示文案」（last/changePct/lastSeen/srcs/reason/huanshou）。
// 换言之软依赖的数据即使到得晚，也**不会改变任何下单判定结果**——这点经 test/universe_lazy.test.mjs 断言。
// 反之，若软依赖参与了下单判定，分档就会变成"先看到的信息决定能不能下单"，绝不可接受。
const UNI_LITE_FILE = './data/paper_universe-lite.json';
const UNI_FULL_FILE = './data/paper_universe.json';
let UNI_FULL_READY = false;   // 完整池是否已就位（决定 lookup 是否还该提示"信息补全中"）
let UNI_FULL_ERROR = null;    // 完整池拉取失败时的原因（界面如实披露，不静默降级）

/** 精简池 → 代码映射（只需 code/name；软依赖字段一概不参与，故这里缺字段是正常的）。 */
function liteUniverse(lite) {
  const m = {};
  for (const r of (lite && lite.symbols) || []) {
    if (r && r.code) m[r.code] = { code: r.code, name: r.name || '' };
  }
  return m;
}

/** 完整池 → 代码映射（解回 reason 明文字段，见原注释）。 */
function fullUniverse(uni) {
  // 标的池的 reason 已按码表压缩（reasonIdx → meta.reasonCodes，3558 条唯一值仅 663 个：
  // 1634.5KB → 1059.1KB）。前端目前不读该字段，但仍**解回明文**再挂 UNI——
  // 保留 reasonIdx 会让以后任何想读 reason 的代码拿到 undefined，属"静默缺字段"。
  // 表缺失（未压缩的存量文件）时 decodeStrField 原样返回，故兼容。
  return uni.meta && Array.isArray(uni.meta.reasonCodes)
    ? decodeStrField(Object.values(uni.symbols || {}), uni.meta.reasonCodes, 'reason')
      .reduce((m, r) => { m[r.code] = r; return m; }, {})
    : (uni.symbols || {});
}

/**
 * 分档拉标的池。返回 { lite, full }，两个 promise 独立——lite 先到先渲染，full 到了再补。
 * 精简池缺失（未生成 / 旧存档）时回退为直接拉完整池，行为与分档之前完全一致。
 */
function loadUniverseStaged() {
  const bust = '?_=' + Date.now();
  const liteP = fetch(UNI_LITE_FILE + bust, { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);
  return { liteP };
}

async function boot() {
  try {
    // 分层加载：精简标的池 + 滚动窗（近 30 日）。
    // 模拟器只需要"最近几个交易日的收盘价"来补结算（autoCatchUp / settleNow），
    // 从不需要 241 天前的价格——故拉滚动窗即可，不再拉 5.1MB 完整档。
    // 结算窗口由最近一次结算日决定，正常使用下至多落后数个交易日，30 天有充裕余量。
    const { liteP } = loadUniverseStaged();
    const [lite, arc] = await Promise.all([liteP, loadRecentArchive()]);

    if (lite && lite.symbols) {
      UNI = liteUniverse(lite);          // 首屏只拿到"代码 → 名称"
      UNI_META = lite.meta || {};
      // 给上层（app.js 的 #loadScope）一个可读的分档标记，让它能如实披露
      // "标的池现在是精简档"。没有这个标记，页面会同时显示"已载入最近 30 日"
      // 和"标的池完整"，读者无法判断哪些数字来自哪一档。
      //
      // ⚠ 时序坑：index.html 里 app.js（经典脚本）**先**求值，paper_ui.js（module）后求值。
      //   也就是说 app.js 的 renderAll → renderScope 跑完时，这个标记还不存在，
      //   披露块里不会带"精简档"。故设置标记后必须**主动再刷一次**披露块。
      //   （这正是把 renderScope 抽成独立函数的原因：它必须能被重复调用。）
      if (typeof window !== 'undefined') window.__uniStaged = true;
      if (typeof window !== 'undefined' && typeof window.__renderScope === 'function') {
        try { window.__renderScope(window.__lastArc || null); } catch { /* 披露失败不影响功能 */ }
      }
    } else {
      // 精简池不可用：退回完整池（老部署 / 精简池生成失败），此时首屏就是旧行为
      const res = await fetch(UNI_FULL_FILE + '?_=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('标的池 HTTP ' + res.status);
      const uni = await res.json();
      UNI = fullUniverse(uni);
      UNI_META = uni.meta || {};
      UNI_FULL_READY = true;
      UNI_FULL_ERROR = '精简池缺失，已直接载入完整池';
    }
    // 滚动窗是分层结构：曲线点 + 最新日。模拟器要的是"逐日收盘价"，故拼成日期升序序列。
    const days = recentDays(arc);
    ARC_DAYS = days;
    const last = days[days.length - 1] || {};
    LAST_DATE = last.trade_date || null;
    QMAP = quotesFromDay(last);

    // 账户：优先本地账本；没有则按「用户设定的初始资金」新建（起始日 = 存档最新交易日）
    ACCT = load() || emptyAccount(loadInitCash(), LAST_DATE);
    // 预警台账：与账户相互独立（重置账户不清空战绩——它衡量的是规则本身，不是某一笔交易）
    ALOG = loadAlertLog();
    // 若本地账户落后于存档（比如隔了一天），自动补结算到最后可用的存档日
    autoCatchUp(days);
    syncInitCashInput();
    // 副标题交给 renderAllPaper → renderSub 统一刷新，避免两处文案各自演化
    renderAllPaper();
    // 首屏完成标记。为什么要有它：**"首屏"必须是一个可观测的时刻，而不是"等 1.2 秒"**。
    // 用固定延时去界定首屏，会把"首屏之后按设计补拉的东西"算进首屏成本——
    // 于是要么误报回归，要么逼着人把断言放宽到没有意义。真浏览器核对脚本读这个标记：
    // 在它触发之前发生的请求才算首屏成本，之后的一律归"按需/后台补全"。
    // 用 setTimeout(0) 把它排在当前微/宏任务队列之后，保证 renderAllPaper 的 DOM 已落定。
    setTimeout(() => {
      if (typeof window !== 'undefined') window.__paperFirstPaint = Date.now();
      document.documentElement?.setAttribute('data-paper-first-paint', String(Date.now()));
    }, 0);

    // 实时行情放在首屏渲染之后：先把界面画出来，再异步补价，避免网络慢时白屏。
    // 首次抓「持仓 + 待成交」，让账户列表立刻有实时价；用户输入代码时再按需补抓。
    refreshAllLive().then(() => renderAllPaper());
    // 完整标的池**不在这里抢带宽**。1MB 的请求若与首屏的滚动窗（204KB）并行发出，
    // 会在同一条 HTTP/1.1 连接上排队，把首屏关键路径拉长——"分档"的账面上省了 900KB，
    // 体感上却因为慢了一个 RTT 而变差。
    // 故：等浏览器空闲（首屏渲染 + 实时行情都落定）再补拉；用户若先输了代码，
    // lookup() 会立刻触发它（那条路径是用户主动等待，抢带宽是对的）。
    if (!UNI_FULL_READY) scheduleIdleUniverse();
  } catch (e) {
    const box = $('paperSub');
    if (box) box.textContent = `模拟器数据未就绪（${e.message}）——先运行 node scripts/fetch_universe.mjs 生成 data/paper_universe.json`;
    msg('加载失败：' + e.message, 'err');
  }
}

/**
 * 把完整标的池的补拉推迟到浏览器空闲。
 * 优先 requestIdleCallback（真正的"主线程空且网络不忙"），
 * 不可用时退化为 setTimeout 2s —— 2s 足够首屏与实时行情收尾，又不至于让用户输完代码还没到。
 * 注意：这只影响**主动补拉**；用户输代码触发的 lookup() 分支不受影响（那里直接调 loadFullUniverse）。
 */
function scheduleIdleUniverse() {
  const run = () => { if (!UNI_FULL_READY) loadFullUniverse().then(() => renderAllPaper()); };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 3000 });
  else setTimeout(run, 2000);
}

/**
 * 后台补拉完整标的池（板段/ST/涨跌停/最近收盘价/换手/来源）。
 * 首屏用的是精简池（只有代码+名称），这里补齐**软依赖**字段。
 * 失败不阻断——界面继续用精简池工作，只在下单区如实提示"信息仍在补全"。
 * 也绝不重复拉：UNI_FULL_READY 一旦为真就直接返回。
 */
function loadFullUniverse() {
  if (UNI_FULL_READY) return Promise.resolve(UNI);
  if (!window.__uniFullPromise) {
    window.__uniFullPromise = fetch(UNI_FULL_FILE + '?_=' + Date.now(), { cache: 'no-store' })
      .then((res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then((uni) => {
        // 合并而非替换：精简池已有的 name 保留，完整池补齐其余字段。
        // 直接替换会把「完整池里没有、精简池里有」的边缘票弄丢（两者本应同源，但不做假设）。
        const full = fullUniverse(uni);
        const merged = { ...UNI };
        for (const [code, r] of Object.entries(full)) merged[code] = { ...(merged[code] || {}), ...r };
        UNI = merged;
        UNI_META = { ...(uni.meta || {}), staged: true };
        UNI_FULL_READY = true;
        UNI_FULL_ERROR = null;
        // 完整档到位：撤下"精简档"披露标记，并**只**重刷披露块
        // （不调 renderAll —— 那会重跑全部 7 段渲染与 3 个网络加载，只为改一行文案）
        if (typeof window !== 'undefined') {
          window.__uniStaged = false;
          if (typeof window.__renderScope === 'function') {
            try { window.__renderScope(window.__lastArc || null); } catch { /* 披露失败不影响功能 */ }
          }
        }
        renderAllPaper();
        return UNI;
      })
      .catch((e) => {
        window.__uniFullPromise = null;   // 允许下次重试（例如用户重新输入代码时）
        UNI_FULL_ERROR = e.message;
        // 如实披露：不静默降级成"就是没有这只票"——那会让用户以为代码打错了。
        msg('标的池明细未载入（' + e.message + '）：可下单性判定暂不可用，可稍后重新输入代码重试', 'warn');
        renderAllPaper();
        return UNI;
      });
  }
  return window.__uniFullPromise;
}

/**
 * 用存档里「晚于账户最后结算日」的交易日补齐结算。
 * 只补存档真实存在的交易日——周末/休市不会凭空产生净值点。
 */
function autoCatchUp(days) {
  if (!ACCT.lastSettle) {
    ACCT = { ...ACCT, lastSettle: LAST_DATE };
    return;
  }
  const todo = days.filter((d) => d.trade_date > ACCT.lastSettle);
  if (!todo.length) {
    // 至少给首日记一个净值点，否则净值曲线一直空着
    if (!(ACCT.nav || []).length && LAST_DATE) {
      const st = accountStats(ACCT);
      ACCT = { ...ACCT, nav: [{ date: LAST_DATE, equity: Math.round(st.total * 100) / 100, cash: Math.round((st.cash + st.freeze) * 100) / 100, marketValue: Math.round(st.marketValue * 100) / 100 }] };
    }
    return;
  }
  let cur = ACCT;
  let filled = 0, expired = 0;
  for (const d of todo) {
    const r = settleDay(cur, d.trade_date, quotesFromDay(d));
    cur = r.account;
    filled += r.fills.length;
    expired += r.expired.length;
  }
  ACCT = cur;
  save();
  if (filled || expired) {
    msg(`已按存档补齐结算（${todo[0].trade_date} ~ ${todo[todo.length - 1].trade_date}）：成交 ${filled} 笔、失效 ${expired} 笔`, 'ok');
  }
}

// ────────────────────────── 行情查询 ──────────────────────────

/**
 * 综合实时行情 / 存档行情 / 标的池，给出一只票的完整可交易状态。
 *
 * 取价优先级（这是本次改造的核心）：
 *   1) 实时行情 LIVEQ（腾讯源）—— 全市场任意 A 股，盘中是实时价、盘后是最近真实收盘价
 *   2) 存档当日行情 QMAP —— 实时源拿不到时的降级（仍是真实收盘价，但要标注来源与日期）
 * 两者都没有 → fresh=false，界面如实说明「取不到价」，而不是谎称不可交易。
 *
 * 关键修复：旧版把「在不在标的池里」当成可下单的前提，池子里只有上榜股（约 100 只），
 * 于是 1200+ 只正常股票都被判「无真实行情，不可下单」。现在**标的池只作参考**，
 * 是否能下单取决于「有没有取到真实价格」。
 */
function lookup(code) {
  const c = String(code || '').trim();
  if (!/^\d{6}$/.test(c)) return null;
  const b = boardOf(c);
  const u = UNI?.[c] || null;
  // 分档加载：首屏只有代码+名称，完整池的板段/最近收盘价等**软依赖**字段还没到。
  // 这里触发一次后台补拉（幂等，已在首屏之后主动调过一次；此处是用户输代码时的保险）。
  if (!UNI_FULL_READY) loadFullUniverse();
  const live = LIVEQ[c] || null;
  const arch = QMAP[c] || null;
  // 实时优先；实时没有才用存档收盘价
  const q = live || arch;
  const name = q?.name || u?.name || '';
  const kind = live ? priceKind(live) : null;
  return {
    code: c,
    name,
    board: b,
    st: isStName(name),
    limitPct: limitPctOf(c, name),
    price: q?.price ?? null,
    changePct: q?.changePct ?? null,
    turnover: q?.turnover ?? u?.huanshou ?? null,
    prevClose: q?.prevClose ?? null,
    // 价格来源与时间：界面据此如实标注是「实时价」还是「最近收盘价」
    src: live ? 'live' : (arch ? 'archive' : null),
    srcLabel: live ? (kind?.kind === 'live' ? '实时价' : '最近收盘价') : (arch ? '存档收盘价' : null),
    tickTime: live?.tickTime || null,
    quoteDate: live ? (live.tickDate || LAST_DATE) : (arch ? LAST_DATE : (u?.asOf || null)),
    fresh: !!q,
    history: u,
    inUniverse: !!u,
    // 标的池明细是否已就位。界面据此区分「确实不在池里」与「池子还在补全」——
    // 后者若不区分，用户会以为代码打错了。
    universeReady: UNI_FULL_READY,
    universeError: UNI_FULL_ERROR,
  };
}

// ────────────────────────── 渲染：账户 ──────────────────────────

function renderAllPaper() {
  renderSub();
  renderStats();
  renderAlerts();
  renderPicks();
  renderPositions();
  renderPending();
  renderHist();
  renderPerf();
  renderOrderForm();
  renderQuick();
  renderBatch();
  renderLogs();
  publishSnapshot();
}

/**
 * 副标题（区域头下方那行小字）。
 * 为什么放进 renderAllPaper 而不是只在 boot 里写一次：初始资金是**可改的**，
 * 改完只更新总览、副标题还挂旧金额，两处数字打架比不显示更糟。
 */
function renderSub() {
  const sub = $('paperSub');
  if (!sub) return;
  // 报账户实际的初始资金（initCash），不是用户偏好里那个——两者可能不同
  // （改了设定但还没建新账户），报偏好值会与下方总览自相矛盾。
  const cash = ACCT?.initCash || loadInitCash();
  sub.textContent = `仅初始资金为虚拟（${num(cash)} 元）· 行情来源：腾讯实时行情`
    + ` · 规则对齐 A 股现行制度（T+1、整手、涨跌停、真实费用）`;
}

/**
 * 把「账户 + 预警台账 + 实时价 + 当日情绪分」挂到 window.__paperSnapshot，
 * 供经典脚本 app.js 生成研判报告的「⑦ 模拟交易复盘」段落。
 *
 * 为什么在 renderAllPaper 末尾调用：renderAllPaper 是**所有账户变更的唯一收口**
 * （下单、撤单、结算、重置、导入、补结算后都会走这里），挂在这里就不会漏更新。
 *
 * 快照是**只读拷贝**（结构化克隆），不是引用——报告端绝不能拿到能反向改账户的对象。
 * 价格用 lookup() 的当前值（实时 > 存档 > 标的池），与台账记账、下单区同一口径，
 * 保证「报告里说的浮盈」和「界面上看到的浮盈」是同一个数。
 */
function publishSnapshot() {
  if (!ACCT) { delete window.__paperSnapshot; return; }
  const day = ARC_DAYS[ARC_DAYS.length - 1] || {};
  const priceMap = {};
  for (const code of Object.keys(ACCT.positions || {})) {
    const q = lookup(code);
    if (q && q.price != null && Number.isFinite(+q.price)) priceMap[code] = +q.price;
  }
  window.__paperSnapshot = {
    version: REVIEW_VERSION,
    updatedAt: new Date().toISOString(),
    asOf: day.trade_date || LAST_DATE || null,
    emotionScore: (day.emotion && day.emotion.value != null) ? +day.emotion.value : null,
    account: JSON.parse(JSON.stringify({ ...ACCT, orders: undefined, pending: undefined })),
    log: JSON.parse(JSON.stringify(ALOG)),
    priceMap,
    meta: {
      liveAt: LIVE_AT,
      liveCount: Object.keys(LIVEQ).length,
      lastDate: LAST_DATE,
    },
  };
  // 通知报告端刷新第⑦段（app.js 监听此事件）。用事件而不是让 app.js 轮询：
  // 账户变化是低频动作（下单/结算/导入），轮询只会白白增加耦合。
  try { window.dispatchEvent(new Event('paper-snapshot')); } catch (e) { /* 静默 */ }
  // 前端断言脚本（scripts/check_frontend.mjs）需要「账户 + lookup」才能独立复算
  // 「按建议比例该填多少股」——本文件被包在 IIFE 里执行，ACCT/lookup 取不到，
  // 故与 __paperSnapshot 同样的桥接方式挂一个最小只读句柄（仅供测试与报告端复用）。
  try {
    window.__paperCtx = { account: () => ACCT, lookup: (c) => lookup(c), stats: () => accountStats(ACCT) };
    // 初始资金的读写与常量也要可测：越界拦截是**唯一**的口径防线，
    // 但输入框上可能挂多个 change 监听（如测试脚本重复 eval 本文件），
    // 靠 dispatch 事件验证会假绿/假红。直接暴露纯函数给断言用。
    window.__paperInitTest = {
      saveInitCash, loadInitCash, newAccountWith,
      INIT_CASH, INIT_MIN, INIT_MAX, INIT_KEY,
    };
    // 降级复核门槛的状态与判定也要可测：这是**规则**（不是渲染），
    // 断言必须能独立问「当前这只票有没有过复核」，而不是去读 DOM 文案猜。
    window.__reviewGate = {
      outflowOf: (c) => outflowOf(c),
      passed: (c) => reviewPassed(c),
      mark: (c) => markReviewed(c),
      clear: () => clearReview(),
      // 常量从 lhbfilter 取，绝不在这里另写字面量
      PENALTY: LHB_NET_OUTFLOW_PENALTY,
      TAG: FLAG_LHB.NET_OUTFLOW,
    };
  } catch (e) { /* 静默 */ }
}

function renderStats() {
  const box = $('paperStats');
  if (!box) return;
  const st = accountStats(ACCT);
  const rows = [
    ['总资产', num(st.total), '', `现金 + 冻结 + 持仓市值`, 'stat-total'],
    ['可用资金', num(st.cash), '', '可用于新开仓', ''],
    ['冻结资金', num(st.freeze), '', '买入挂单占用，撤单/成交后释放', ''],
    ['持仓市值', num(st.marketValue), '', '按最新真实行情价计', ''],
    ['浮动盈亏', num(st.floatPnl), cls(st.floatPnl), `成本 ${num(st.costValue)} · ${pct(st.floatPnlPct * 100)}`, ''],
    ['已实现盈亏', num(st.realized), cls(st.realized), '清仓结转，含买入成本分摊', ''],
    ['累计费用', num(st.totalFee), '', '佣金 + 过户费 + 印花税', ''],
    ['账户收益率', pct(st.retPct), cls(st.retPct), `初始 ${st.initCash.toLocaleString()} 元`, ''],
  ];
  box.innerHTML = rows.map(([k, v, c, note, extra]) => `<div class="ps-cell ${extra}" data-act="pstat" data-k="${esc(k)}" tabindex="0" role="button">
      <div class="ps-k">${esc(k)}</div>
      <div class="ps-v ${c}">${esc(v)}</div>
      <div class="ps-n muted">${esc(note)}</div>
    </div>`).join('');
}

function renderPositions() {
  const tb = $('paperPosTable')?.querySelector('tbody');
  const cards = $('paperPosCards');
  const note = $('paperPosNote');
  const rows = Object.values(ACCT.positions || {}).sort((a, b) => (b.last * b.qty) - (a.last * a.qty));
  const html = rows.map((p) => {
    const mv = (p.last ?? p.avgCost) * p.qty;
    const pnl = mv - (p.cost || 0);
    const pnlPct = p.cost ? (pnl / p.cost) * 100 : 0;
    const frozen = (ACCT.pending || []).filter((x) => x.code === p.code && x.side === 'sell').reduce((a, x) => a + x.qty, 0);
    return { p, mv, pnl, pnlPct, frozen };
  });
  if (tb) {
    tb.innerHTML = rows.length
      ? html.map(({ p, mv, pnl, pnlPct, frozen }) => `<tr class="clickable" data-act="ppos" data-code="${esc(p.code)}" tabindex="0">
          <td>${esc(p.code)}</td><td>${esc(p.name || (UNI?.[p.code]?.name) || '')}</td>
          <td class="num">${p.qty}</td>
          <td class="num">${Math.max(0, (p.avail || 0) - frozen)}${frozen ? `<span class="tag-mini">冻${frozen}</span>` : ''}</td>
          <td class="num">${num(p.avgCost, 3)}</td>
          <td class="num">${num(p.last)}${p.pxStale ? '<span class="tag-mini warn">旧价</span>' : ''}</td>
          <td class="num ${cls(pnl)}">${num(pnl)}<span class="psub">${pct(pnlPct)}</span></td>
        </tr>`).join('')
      : '<tr class="empty-row"><td colspan="7" class="muted">暂无持仓——在上方「下单」提交委托，次日按真实收盘价成交</td></tr>';
  }
  if (cards) {
    cards.innerHTML = rows.length
      ? html.map(({ p, pnl, pnlPct, frozen }) => `<div class="card-row" data-act="ppos" data-code="${esc(p.code)}" tabindex="0" role="button">
          <div class="cr-top"><b>${esc(p.name || p.code)}</b><span class="${cls(pnl)}">${num(pnl)} (${pct(pnlPct)})</span></div>
          <div class="cr-bot muted">${esc(p.code)} · ${p.qty} 股 · 可卖 ${Math.max(0, (p.avail || 0) - frozen)} · 成本 ${num(p.avgCost, 3)} · 现价 ${num(p.last)}</div>
        </div>`).join('')
      : '<div class="dw-empty">暂无持仓</div>';
  }
  if (note) {
    // rows 里装的是「原始持仓对象」（{p,...} 包装只存在于 html 数组），故直接读 x.pxStale
    const stale = rows.filter((x) => x.pxStale).map((x) => x.code);
    note.innerHTML = `成本含买入费用（加权平均）· 「可卖」已扣除待成交卖单的冻结 · `
      + `T+1：当日买入次一交易日才可卖`
      + (stale.length ? ` · <span class="bf-warn">${esc(stale.join('、'))} 最近一档无行情，沿用上一价（已标「旧价」）</span>` : '');
  }
}

function renderPending() {
  const tb = $('paperPendTable')?.querySelector('tbody');
  const cards = $('paperPendCards');
  const note = $('paperPendNote');
  const list = ACCT.pending || [];
  if (tb) {
    tb.innerHTML = list.length
      ? list.map((p) => `<tr class="clickable" data-act="ppend" data-id="${p.id}" tabindex="0">
          <td>${esc(p.submitDate || '—')}</td><td>${esc(p.code)}</td><td>${esc(p.name || '')}</td>
          <td class="${p.side === 'buy' ? 'hl' : 'hl-dn'}">${p.side === 'buy' ? '买入' : '卖出'}</td>
          <td class="num">${p.qty}</td><td class="num">${num(p.estPrice)}</td>
          <td class="num">${num(p.need)}</td>
          <td><button class="mini" type="button" data-act="pcancel" data-id="${p.id}">撤单</button></td>
        </tr>`).join('')
      : '<tr class="empty-row"><td colspan="8" class="muted">无待成交委托</td></tr>';
  }
  if (cards) {
    cards.innerHTML = list.length
      ? list.map((p) => `<div class="card-row" data-act="ppend" data-id="${p.id}" tabindex="0" role="button">
          <div class="cr-top"><b>${esc(p.name || p.code)}</b><span class="${p.side === 'buy' ? 'hl' : 'hl-dn'}">${p.side === 'buy' ? '买入' : '卖出'} ${p.qty}</span></div>
          <div class="cr-bot muted">${esc(p.code)} · 预估 ${num(p.estPrice)} · 冻结 ${num(p.need)} · 点此撤单</div>
        </div>`).join('')
      : '<div class="dw-empty">无待成交委托</div>';
  }
  if (note) {
    note.innerHTML = `委托在<b>次一交易日</b>按该日真实收盘价撮合（防前视偏差）· 买入预冻结资金、卖出预冻结股份`
      + ` · 涨停买不进 / 跌停卖不掉 / 资金不足 会在结算时自动失效并释放冻结`;
  }
}

const HIST_COLS = {
  trade: [
    ['fillDate', '成交日'], ['code', '代码'], ['name', '名称'], ['side', '方向'],
    ['qty', '数量'], ['price', '成交价'], ['drift', '委托价差'], ['gross', '成交额'], ['fee', '费用'],
  ],
  order: [
    ['submitDate', '提交日'], ['code', '代码'], ['name', '名称'], ['side', '方向'],
    ['qty', '数量'], ['estPrice', '预估/成交价'], ['status', '状态'], ['detail', '说明'],
  ],
};

function renderHist() {
  const view = HIST.view;
  const cols = HIST_COLS[view];
  const head = $('paperHistHead');
  const tb = $('paperHistTable')?.querySelector('tbody');
  const cards = $('paperHistCards');
  const list = view === 'trade' ? [...(ACCT.trades || [])].reverse() : [...(ACCT.orders || [])].reverse();
  if (head) head.innerHTML = cols.map(([, label]) => `<th>${esc(label)}</th>`).join('');
  const cnt = $('paperHistCount');
  if (cnt) {
    cnt.textContent = view === 'trade'
      ? `共 ${(ACCT.trades || []).length} 笔成交`
      : `共 ${(ACCT.orders || []).length} 张委托（被拒 ${(ACCT.orders || []).filter((o) => o.status === 'rejected').length} 张）`;
  }
  const emptyTxt = view === 'trade' ? '暂无成交——委托在次一交易日撮合' : '暂无委托记录';

  const cell = (t, c) => {
    switch (c) {
      case 'side': return `<td class="${t.side === 'buy' ? 'hl' : 'hl-dn'}">${t.side === 'buy' ? '买入' : '卖出'}</td>`;
      case 'price': return `<td class="num">${num(t.price)}</td>`;
      case 'drift': return `<td class="num ${cls(t.driftPct)}">${t.driftPct == null ? '—' : pct(t.driftPct)}</td>`;
      case 'gross': return `<td class="num">${num(t.gross)}</td>`;
      case 'fee': return `<td class="num">${num(t.fee)}</td>`;
      case 'estPrice': return `<td class="num">${num(t.fillPrice ?? t.estPrice)}</td>`;
      case 'status': return `<td>${statusTag(t)}</td>`;
      case 'detail': return `<td class="muted">${esc(t.detail || t.reject || '—')}</td>`;
      default: return `<td class="num">${esc(t[c] ?? '—')}</td>`;
    }
  };
  if (tb) {
    tb.innerHTML = list.length
      ? list.map((t, i) => `<tr class="clickable" data-act="phist" data-view="${view}" data-i="${list.length - 1 - i}" tabindex="0">`
        + cols.map(([, c]) => cell(t, c)).join('') + '</tr>').join('')
      : `<tr class="empty-row"><td colspan="${cols.length}" class="muted">${emptyTxt}</td></tr>`;
  }
  if (cards) {
    cards.innerHTML = list.length
      ? list.map((t, i) => `<div class="card-row" data-act="phist" data-view="${view}" data-i="${list.length - 1 - i}" tabindex="0" role="button">
          <div class="cr-top"><b>${esc(t.name || t.code)}</b><span class="${t.side === 'buy' ? 'hl' : 'hl-dn'}">${t.side === 'buy' ? '买入' : '卖出'} ${t.qty}</span></div>
          <div class="cr-bot muted">${esc(view === 'trade' ? t.fillDate : t.submitDate)} · ${esc(t.code)}
            · ${view === 'trade' ? `成交 ${num(t.price)}（委托 ${num(t.submitPrice)}）` : statusText(t)}</div>
        </div>`).join('')
      : `<div class="dw-empty">${emptyTxt}</div>`;
  }
}

const STATUS_LABEL = {
  filled: '已成', pending: '待成交', rejected: '已拒绝', cancelled: '已撤单', expired: '已失效',
};
function statusText(t) { return STATUS_LABEL[t.status] || t.status || '—'; }
function statusTag(t) {
  const clsMap = { filled: 'ok', pending: 'wait', rejected: 'bad', cancelled: 'mut', expired: 'warn' };
  return `<span class="stag ${clsMap[t.status] || 'mut'}">${esc(statusText(t))}</span>`;
}

function renderPerf() {
  const box = $('paperPerf');
  const note = $('paperPerfNote');
  const nav = (ACCT.nav || []).map((r) => r.equity);
  const m = nav.length >= 2 ? paperMetrics(nav) : null;
  if (box) {
    if (!m) {
      box.innerHTML = `<div class="ps-cell wide"><div class="ps-k">净值样本不足</div>
        <div class="ps-v">—</div>
        <div class="ps-n muted">按存档交易日逐日累积；至少需要 2 个交易日才能算收益与回撤</div></div>`;
    } else {
      const rows = [
        ['区间收益', pct(m.total * 100), cls(m.total), `${m.days} 个交易日`],
        ['年化收益', pct(m.annual * 100), cls(m.annual), `按 252 交易日年化（样本短，参考意义有限）`],
        ['最大回撤', pct(-m.ddPct), m.ddPct > 0 ? 'hl-dn' : 'muted', '峰值到谷底的最大跌幅'],
        ['夏普比率', num(m.sharpe), m.sharpe >= 1 ? 'hl' : m.sharpe > 0 ? '' : 'hl-dn', '与策略回测同口径'],
        ['日胜率', pct(m.winRate * 100), cls(m.winRate - 0.5), '上涨交易日占比'],
      ];
      box.innerHTML = rows.map(([k, v, c, n]) => `<div class="ps-cell" data-act="pperf" data-k="${esc(k)}" tabindex="0" role="button">
        <div class="ps-k">${esc(k)}</div><div class="ps-v ${c}">${esc(v)}</div>
        <div class="ps-n muted">${esc(n)}</div></div>`).join('');
    }
  }
  drawNavChart($('paperNavSvg'), ACCT.nav || []);
  if (note) {
    note.innerHTML = `净值 = 现金 + 冻结 + 持仓市值（按每日真实收盘价）· 指标定义与 <b>src/backtest.js</b> 的 metrics() 完全一致，`
      + `因此可与上方「策略回测」的夏普/回撤直接对比`;
  }
}

/** 净值曲线：与 app.js drawNav 同一画法，但数据源是账户净值 */
function drawNavChart(svg, rows) {
  if (!svg) return;
  const W = 300, H = 90, P = 6;
  // 空态提示用 HTML 渲染而非 SVG text：本图 preserveAspectRatio="none"（非等比拉伸铺满宽度），
  // SVG 里的文字会被横向放大到失真（300 视口 → 千级像素宽，字被拉大 3 倍以上）
  let tip = svg.nextElementSibling;
  if (!tip || !tip.classList.contains('nav-empty')) {
    tip = document.createElement('div');
    tip.className = 'nav-empty empty';
    tip.textContent = '净值曲线需要至少 2 个交易日';
    svg.after(tip);
  }
  if (!rows || rows.length < 2) {
    svg.innerHTML = '';
    svg.style.display = 'none';
    tip.style.display = '';
    return;
  }
  svg.style.display = '';
  tip.style.display = 'none';
  const vals = rows.map((r) => r.equity);
  const base = ACCT.initCash || vals[0];
  const lo = Math.min(...vals, base), hi = Math.max(...vals, base);
  const span = (hi - lo) || 1;
  const x = (i) => P + (i / (rows.length - 1)) * (W - 2 * P);
  const y = (v) => H - P - ((v - lo) / span) * (H - 2 * P);
  const line = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${P},${H - P} ${line} ${(W - P).toFixed(1)},${H - P}`;
  const up = vals[vals.length - 1] >= base;
  const color = up ? '#f0616d' : '#3fb950';   // 中文语境：赚=红、亏=绿
  const baseY = y(base).toFixed(1);
  svg.innerHTML = `
    <polygon points="${area}" fill="${color}" opacity="0.12"></polygon>
    <polyline points="${line}" fill="none" stroke="${color}" stroke-width="1.6"></polyline>
    <line x1="${P}" y1="${baseY}" x2="${W - P}" y2="${baseY}" stroke="#8b949e" stroke-width="0.7" stroke-dasharray="3 3"></line>
    ${rows.map((r, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(r.equity).toFixed(1)}" r="2.4" fill="${color}"
        class="pnav-pt" data-date="${esc(r.date)}" data-eq="${esc(r.equity)}" tabindex="0" role="button"><title>${esc(r.date)} 净值 ${esc(r.equity)}</title></circle>`).join('')}
    <text x="${P}" y="9" fill="#8b949e" font-size="8">${esc(rows[0].date)}</text>
    <text x="${W - P}" y="9" text-anchor="end" fill="#8b949e" font-size="8">${esc(rows[rows.length - 1].date)}</text>
    <text x="${P}" y="${H - 1}" fill="#8b949e" font-size="8">基准 ${base}</text>`;
}

// ────────────────────────── 渲染：下单表单 ──────────────────────────

function renderOrderForm() {
  const info = ORDER.code ? lookup(ORDER.code) : null;
  const qbox = $('poQuote');
  if (qbox) {
    if (!ORDER.code) {
      qbox.className = 'po-quote muted';
      // 全市场任意 A 股都能查实时价：文案必须说清楚，否则用户不知道入口变宽了
      qbox.textContent = '输入 6 位代码查询实时行情（全市场 A 股，沪/深/北交所均可）';
    } else if (!info || !info.board.tradable) {
      qbox.className = 'po-quote bad';
      qbox.textContent = info ? `${ORDER.code}：${info.board.label} —— 模拟器不纳入此类品种` : `${ORDER.code}：代码格式非法（需 6 位数字）`;
    } else {
      const hit = isLimitHit(info.changePct, info.code, info.name);
      qbox.className = 'po-quote';
      // 价格来源标注：实时价 / 最近收盘价 / 存档收盘价，三态必须让用户看得见
      const badge = info.src === 'live'
        ? (info.srcLabel === '实时价'
          ? '<span class="gtag live">实时价</span>'
          : '<span class="gtag close">最近收盘价</span>')
        : (info.src === 'archive' ? '<span class="gtag close">存档收盘价</span>' : '');
      qbox.innerHTML = `<b>${esc(info.name || '（名称未知）')}</b> <span class="muted">${esc(info.code)}</span>`
        + `<span class="gtag">${esc(info.board.label)}</span>${info.st ? '<span class="gtag n">ST</span>' : ''}`
        + `<span class="gtag">±${(info.limitPct * 100).toFixed(0)}%</span>${badge}`
        + (info.fresh
          ? `<div class="pq-line">${info.srcLabel === '实时价' ? '最新' : '收盘'} <b>${num(info.price)}</b> 元`
            + ` <span class="${cls(info.changePct)}">${pct(info.changePct)}</span>`
            + (hit === 'up' ? ' <span class="gtag d">涨停</span>' : hit === 'down' ? ' <span class="gtag u">跌停</span>' : '')
            + (info.turnover != null ? `<span class="muted"> · 换手 ${num(info.turnover)}%</span>` : '')
            + `<span class="muted"> · ${esc(info.tickTime || info.quoteDate || '—')}</span></div>`
          : `<div class="pq-line bf-warn">取不到 ${esc(ORDER.code)} 的行情（实时源与存档都没有该代码的价格）`
            + `——请核对代码是否存在/是否已停牌；已有持仓仍可正常卖出。</div>`)
        // 分档加载的诚实披露：板段/幅度**由代码纯函数推导**，不依赖标的池，故永远是准的；
        // 但「最近一次真实收盘价 / 换手 / 是否曾在池内」来自完整池，补全前不能假装知道。
        + (info.universeReady ? ''
          : `<div class="pq-line muted">标的池明细载入中（首屏只加载了代码与名称）；`
            + `板段与涨跌停幅度由代码规则直接判定、始终有效${info.universeError ? ` · 上次失败：${esc(info.universeError)}` : ''}</div>`);
    }
  }

  // ── 降级复核提示条（龙虎净买 ≤ 0）──
  // 这条横幅不是「装饰」：submit() 里的门槛只负责拦截，用户必须在这里**看到依据**
  // 才有资格点「确认复核并下单」。所以横幅要给出：命中原因 + 扣分明细 + 当日净额。
  const gate = $('poGate');
  if (gate) {
    const od = ORDER.side === 'buy' ? outflowOf(ORDER.code) : null;
    if (!od) {
      gate.innerHTML = '';
      gate.hidden = true;
    } else {
      const netWan = od.netOutflow ? od.netOutflow.value : null;
      const amt = netWan == null ? '当日龙虎榜无净买记录'
        : (netWan < 0 ? `当日龙虎榜净买 −${(Math.abs(+netWan) / 1e4).toFixed(2)} 亿`
          : '当日龙虎榜净买为 0');
      const done = reviewPassed(ORDER.code);
      gate.hidden = false;
      gate.className = 'po-gate' + (done ? ' ok' : '');
      gate.innerHTML = `<div class="po-gate-h">${esc(FLAG_LHB.NET_OUTFLOW)}</div>`
        + `<div class="po-gate-b">${esc(amt)}。该票已被规则引擎降级：综合分 −${LHB_NET_OUTFLOW_PENALTY.SCORE} 分、`
        + `上涨概率 −${LHB_NET_OUTFLOW_PENALTY.PROB} 个百分点，落<b>备选观察池（禁止自动下单）</b>。`
        + `${esc(String(od.netOutflow ? od.netOutflow.text : ''))}</div>`
        + (done
          ? `<div class="po-gate-a muted">✓ 本次会话已确认复核（换代码/改方向后需重新确认）。</div>`
          : `<div class="po-gate-a"><button class="mini po-gate-btn" type="button" data-act="review-ok" data-code="${esc(ORDER.code)}">`
            + `我已知悉该票当日资金净流出，确认复核并下单</button>`
            + `<span class="muted">　点此仅为**授权**下单，不会自动提交；数量仍需你自行填写。</span></div>`);
    }
  }

  // 数量快捷项
  const qty = ORDER.qty;
  const prev = $('poPreview');
  if (prev) {
    if (!info || !info.board.tradable || !info.fresh || !qty) {
      prev.innerHTML = '<div class="muted">填写代码与数量后显示预估费用与冻结金额</div>';
    } else {
      const px = fillPrice(info.price, ORDER.side, SLIP);
      const gross = Math.round(px * qty * 100) / 100;
      const f = fees(gross, ORDER.side);
      const v = validateOrder(ACCT, { code: info.code, side: ORDER.side, qty, slip: SLIP }, { code: info.code, price: info.price, name: info.name, changePct: info.changePct });
      prev.innerHTML = `<table class="po-tb"><tbody>
          <tr><td>预估成交价</td><td class="num">${num(px)} 元 <span class="muted">（${info.srcLabel === '实时价' ? '最新' : '收盘'} ${num(info.price)} ${ORDER.side === 'buy' ? '+' : '−'} 滑点 ${SLIP * 1e4}‱）</span></td></tr>
          <tr><td>成交金额</td><td class="num">${num(gross)} 元</td></tr>
          <tr><td>佣金</td><td class="num">${num(f.comm)} 元 <span class="muted">（万三，最低 ${MIN_COMMISSION} 元）</span></td></tr>
          <tr><td>过户费</td><td class="num">${num(f.transfer)} 元 <span class="muted">（万0.1，双边）</span></td></tr>
          ${ORDER.side === 'sell' ? `<tr><td>印花税</td><td class="num">${num(f.stamp)} 元 <span class="muted">（万五，仅卖出）</span></td></tr>` : ''}
          <tr class="po-sum"><td>${ORDER.side === 'buy' ? '需冻结' : '预计到账'}</td><td class="num"><b>${num(ORDER.side === 'buy' ? gross + f.total : gross - f.total)} 元</b></td></tr>
          ${v.ok ? '' : `<tr><td colspan="2" class="bf-warn">✗ ${esc(v.reason)}${v.detail ? '：' + esc(v.detail) : ''}</td></tr>`}
        </tbody></table>`;
    }
  }
  const hint = $('poHint');
  if (hint) {
    hint.innerHTML = `下一可撮合日：<b>${esc(nextSessionLabel())}</b>（按该日真实收盘价成交）`
      + ` · 买入须 ${LOT} 股整数倍 · 可用 ${num(ACCT.cash)} 元`
      + (LIVE_AT ? ` · <span class="muted">行情 ${esc(fmtClock(LIVE_AT))} 抓取</span>` : '');
  }
}

/** 下一可撮合日：**今天（北京时间）之后**的下一个 A 股交易日。
 *  不再锚定存档日——实时结算下，如果今天就是交易日且盘后，次日即可撮合。 */
function nextSessionLabel() {
  // 若今天已是交易日且已过结算时点，从明天起算；否则今天本身可能是可撮合日
  const d = new Date(bjToday() + 'T00:00:00Z');
  for (let i = 0; i < 30; i++) {
    d.setUTCDate(d.getUTCDate() + 1);
    const w = d.getUTCDay();
    if (w === 0 || w === 6) continue;
    const iso = d.toISOString().slice(0, 10);
    if (HOLIDAYS.has(iso)) continue;
    return iso;
  }
  return '—';
}
// 与 src/config.js manualHolidays 同源（该文件的默认导出在浏览器里不易直接 import，故并列一份；
// test/paper.test.mjs 有同源守卫锁两处一致，漂移即红）
const HOLIDAYS = new Set([
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
]);

/** A 股交易日粗判（周末 + 休市表）。settleByLive 的门禁一用它：
 *  非交易日的「实时价」其实是上一收盘价，拿它结算 = 用已知价成交。 */
function isTradingDay(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return false;
  const d = new Date(iso + 'T00:00:00Z');
  const w = d.getUTCDay();
  if (w === 0 || w === 6) return false;
  return !HOLIDAYS.has(iso);
}

/**
 * 数量快捷区（按方向给出不同语义的档位）。
 *
 * 买入：轻仓/半仓/重仓/满仓（分母 = 账户总资产，见 src/paper.js qtyByAssetPct）
 * 卖出：减 1/4、减 1/2、减 3/4、清仓（分母 = 该票可卖数量，清仓=全部可卖）
 *
 * 为什么买卖两套分母不同：建仓说的是「占我整个账户多少」，减仓说的是「这只票卖掉多少」。
 * 混用一套比例会在「账户里已有多只票」时给出明显不合理的手数。
 */
function renderQuick() {
  const box = $('poQuick');
  if (!box) return;
  const info = ORDER.code ? lookup(ORDER.code) : null;
  // 档位按钮：qty=0 且带 sub 说明时渲染为禁用态（而非隐藏）——高价股上「轻仓够不着一手」
  // 是真实约束，静默隐藏会让用户以为功能缺失；禁用+原因才说得清。
  const btns = (items) => items
    .filter((x) => x && (x.qty > 0 || x.disabled))
    .map((x) => {
      const dis = x.qty > 0 ? '' : ' disabled';
      return `<button class="mini${x.primary ? ' primary-ghost' : ''}" type="button" data-act="pqty" data-qty="${x.qty}"${dis}${x.note ? ` title="${esc(x.note)}"` : ''}>${esc(x.label)}${x.sub ? `<span class="pq-sub">${esc(x.sub)}</span>` : ''}</button>`;
    })
    .join('');

  if (ORDER.side === 'sell') {
    const pos = ACCT.positions?.[ORDER.code];
    if (!pos) { box.innerHTML = '<span class="muted">该股无持仓，暂无可卖数量</span>'; return; }
    const frozen = (ACCT.pending || []).filter((x) => x.code === ORDER.code && x.side === 'sell').reduce((a, x) => a + x.qty, 0);
    const free = Math.max(0, (pos.avail || 0) - frozen);
    if (!free) {
      box.innerHTML = `<span class="muted">当前无可卖数量（持仓 ${pos.qty} 股${frozen ? `，其中 ${frozen} 股已挂卖单` : ''}${pos.avail === 0 ? '，当日买入需次日才可卖' : ''}）</span>`;
      return;
    }
    const cut = CUT_TIERS.map((t) => ({ label: t.label, qty: qtyByHoldPct(free, t.pct) }));
    box.innerHTML = `<span class="muted">可卖 ${free} 股：</span>`
      + btns(cut) + btns([{ label: '清仓', qty: free, primary: true, note: '卖出该票全部可卖数量' }]);
    return;
  }

  const canSize = info && info.board.tradable && info.fresh && info.price;
  if (!canSize) { box.innerHTML = '<span class="muted">填入有效代码后可按仓位档位快速估量</span>'; return; }
  if (!ACCT) { box.innerHTML = ''; return; }
  const st = accountStats(ACCT);
  const px = fillPrice(info.price, 'buy', SLIP);
  const lotCost = px * LOT + MIN_COMMISSION;      // 一手的含费成本（含最低佣金）
  const tiers = POS_TIERS.map((t) => {
    const r = qtyByAssetPct(st.total, t.pct, px, { cash: ACCT.cash });
    if (r.qty <= 0) {
      return { label: t.label, qty: 0, disabled: true, sub: '不足一手',
        note: `${t.note} → 预算 ${num(st.total * t.pct)} 元，不足一手（约 ${num(lotCost)} 元）` };
    }
    return { label: t.label, qty: r.qty, sub: r.capped ? '受可用资金限' : t.note, note: `${t.note}：${num(r.need)} 元（含费用）` };
  });
  const head = `<span class="muted">按仓位（总资产 ${num(st.total)} 元，一手约 ${num(lotCost)} 元）：</span>`;
  const any = tiers.some((t) => t.qty > 0);
  const html = btns(tiers);
  box.innerHTML = head + (any ? html
    : `<span class="muted">总资产 ${num(st.total)} 元买不起 ${esc(info.name || info.code)} 一手（约 ${num(lotCost)} 元），四档均不可建仓</span>`)
    + pctRow();
}

/**
 * 自定义比例买入（任意百分比，不限于四档）。
 *
 * 为什么要有：四档（10/50/80/100%）只覆盖粗粒度建仓，实际常要「先上 15% 试探」这类
 * 非整档比例。这里给一个输入框，填 N% → 按 N% 预算算**最大整手数**。
 *
 * 三条口径纪律：
 *  ① 整手取整 / 含费预算 / 可用资金上限**一律复用** qtyByAssetPct——UI 里绝不另写公式；
 *  ② 结果必须能被用户复核算得出来，故把「预算 → 实际占用」都写在提示里；
 *  ③ 算不足一手时不静默留空，直接说明缺多少。
 *
 * 输入框用 input 事件实时算（不需要点按钮），失焦后保留用户填的比例，方便微调。
 */
function pctRow() {
  return `<div class="pq-pct">
    <span class="muted">或按比例买入：</span>
    <label class="pq-pct-in">
      <input id="poPct" type="number" inputmode="decimal" min="0" max="100" step="1"
        value="${PQ_PCT || ''}" placeholder="如 15" aria-label="按总资产百分比买入" />
      <span class="pq-pct-unit">% 总资产</span>
    </label>
    <button class="mini" type="button" data-act="pqty-pct">算数量</button>
    <span class="pq-pct-hint muted" id="poPctHint"></span>
  </div>`;
}

/**
 * 按百分比算出股数并返回可读结论（供输入框提示与「算数量」按钮共用）。
 * 只做「翻译」：把百分比换算成 qtyByAssetPct 的入参，取整规则完全交给引擎。
 */
function qtyByPct(pct) {
  const p = Math.max(0, Math.min(100, +pct || 0)) / 100;
  if (!(p > 0)) return { qty: 0, need: 0, capped: false, budget: 0, reason: '请输入 0~100 之间的比例' };
  const info = ORDER.code ? lookup(ORDER.code) : null;
  // 与四档按钮同一判据：取不到真实价就没法按比例估量
  if (!info || !info.board.tradable || !info.fresh || !info.price) {
    return { qty: 0, need: 0, capped: false, budget: 0, reason: '先填入有效代码并取到实时行情' };
  }
  if (!ACCT) return { qty: 0, need: 0, capped: false, budget: 0, reason: '模拟账户未就绪' };
  const st = accountStats(ACCT);
  const px = fillPrice(info.price, 'buy', SLIP);
  const budget = st.total * p;
  const r = qtyByAssetPct(st.total, p, px, { cash: ACCT.cash });
  if (r.qty <= 0) {
    return { qty: 0, need: 0, capped: false, budget,
      reason: `预算 ${num(budget)} 元不足一手（一手约 ${num(px * LOT + MIN_COMMISSION)} 元）` };
  }
  return { qty: r.qty, need: r.need, capped: !!r.capped, budget, reason: null };
}

function syncOrderInputs() {
  const c = $('poCode'), q = $('poQty');
  if (c) c.value = ORDER.code;
  if (q) q.value = ORDER.qty || '';
  document.querySelectorAll('#poSide button').forEach((b) => {
    const on = b.dataset.side === ORDER.side;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}

// ────────────────────────── 交易预警（大盘 + 持仓双层） ──────────────────────────

/**
 * 当前预警结果。与 currentPicks 同思路：**不缓存**——预警要反映「此刻的仓位与浮盈」，
 * 而账户和实时行情随时在变（下单、结算、抓价都会改），缓存一天前的结论是危险的。
 * 引擎是纯函数且规模很小（持仓数量级），每次重算的代价可以忽略。
 */
function currentAlerts() {
  if (!ACCT) return null;
  const day = ARC_DAYS[ARC_DAYS.length - 1] || {};
  const score = (day.emotion && day.emotion.value != null) ? day.emotion.value : null;
  const st = accountStats(ACCT);
  // 推荐池用于「持仓是否在今日推荐内」的信息提示；取不到就传空（引擎按「无结论」处理，不误报）
  const picks = currentPicks();
  const pickCodes = picks && picks.picks ? picks.picks.map((p) => p.code) : [];
  return buildAlerts({
    emotionScore: score,
    account: ACCT,
    stats: st,
    pickCodes,
    asOf: day.trade_date || LAST_DATE || null,
  });
}

/** 严重度 → 徽标文案。顺序与 src/alerts.js 的 LEVELS 一致（risk > opp > tip）。 */
const AL_LABEL = { risk: '风险', opp: '机会', tip: '提示' };

/**
 * 把当前这批预警落进台账（幂等，重复调用不产生重复条目）。
 *
 * 取价用 lookup() —— 与下单区同一口径（实时 > 存档 > 标的池），
 * 保证「台账里的价格基准」和「用户当时在界面上看到的价格」是同一个数。
 * 大盘层没有标的价格，传 null 即可（它按仓位金额记账）。
 *
 * @returns {number} 本次新增条数（0 表示全是重复或不可归因）
 */
function recordAlerts(r) {
  if (!r || !r.alerts || !r.alerts.length) return 0;
  const st = accountStats(ACCT);
  const tier = r.tier || null;
  const res = appendSignals(ALOG, r.alerts, {
    asOf: r.asOf,
    // 大盘层的「当前/目标仓位」必须由 UI 提供——引擎的 quote 是给人看的字符串，
    // 反解字符串算金额是极易出错的做法（且改文案就会静默算错）。
    curPos: st.total > 0 ? st.marketValue / st.total : 0,
    targetPos: tier ? tier.pos : null,
    total: st.total,
    now: new Date().toISOString(),
    priceOf: (code) => {
      const q = lookup(code);
      const px = q && q.price != null && Number.isFinite(+q.price) ? +q.price : null;
      return px;
    },
  });
  if (res.added > 0) {
    ALOG = res.log;
    saveAlertLog();
  }
  return res.added;
}

/** 今日真实价（code → 价），供归因结算用。与 recordAlerts 同一取价口径。 */
function priceMapForLog() {
  const m = {};
  for (const e of ALOG) {
    if (e.layer !== 'position' || !e.code) continue;
    const q = lookup(e.code);
    if (q && q.price != null && Number.isFinite(+q.price)) m[e.code] = +q.price;
  }
  return m;
}

/** 当前台账的归因汇总（不缓存：价格一变结论就得跟着变） */
function currentAttribution() {
  return summarizeLog(ALOG, null, { priceOf: (code) => {
    const q = lookup(code);
    return q && q.price != null && Number.isFinite(+q.price) ? +q.price : null;
  } });
}

function renderAlerts() {
  const meta = $('alertsMeta');
  const box = $('alertsList');
  const note = $('alertsNote');
  if (!box) return;

  const r = currentAlerts();
  if (!r) {
    if (meta) meta.innerHTML = '<span class="muted">数据未就绪</span>';
    box.innerHTML = '<div class="alerts-empty muted">等待账户与行情存档加载…</div>';
    if (note) note.textContent = '';
    return;
  }

  // 先落账再接渲染：这样「归因条」里的条数与下方卡片是同一次计算的产物，不会出现
  // 「卡片显示 7 条、战绩说 6 条」这种自相矛盾的画面。
  recordAlerts(r);

  if (meta) {
    const tierTxt = r.tier
      ? `<span class="pk-tier ${r.tier.allowNew ? '' : 'warn'}">${esc(r.tier.label)}</span>`
      : '<span class="pk-tier warn">档位未知</span>';
    meta.innerHTML = `数据日期 <b>${esc(r.asOf || '—')}</b> · 情绪分 <b>${r.score == null ? '—' : r.score.toFixed(1)}</b>`
      + ` → ${tierTxt} · 共 <b>${r.total}</b> 条`
      + `${r.truncated ? `（按严重度显示前 ${r.alerts.length} 条）` : ''}`
      + ` · <span class="hl">风险 ${r.counts.risk || 0}</span>`
      + ` / <span class="hl-dn">机会 ${r.counts.opp || 0}</span>`
      + ` / <span class="muted">提示 ${r.counts.tip || 0}</span>`;
  }

  renderAttribution();

  if (!r.alerts.length) {
    box.innerHTML = '<div class="alerts-empty muted">当前无预警：仓位贴合市场档位，持仓未触及止损线或集中度上限。</div>';
  } else {
    box.innerHTML = r.alerts.map((a, i) => {
      // 一键动作：只有能转成「下单区输入」的建议才给按钮（绝不自动提交）
      const canFill = a.action === 'sell' || a.action === 'reduce';
      const fillQty = a.qty > 0 ? ` data-qty="${a.qty}"` : '';
      return `<div class="alert-row ${esc(a.level)}" data-act="alert" data-i="${i}" tabindex="0" role="button"
          title="点击查看该条预警的触发依据">
        <span class="al-badge ${esc(a.level)}">${esc(AL_LABEL[a.level] || a.level)}</span>
        <div class="al-main">
          <div class="al-head">
            <span class="al-act">${esc(ACTIONS_CN[a.action] || a.action)}</span>
            ${a.code ? `<b class="al-code">${esc(a.name || a.code)} ${esc(a.code)}</b>` : '<b class="al-code">大盘</b>'}
          </div>
          <div class="al-text">${esc(a.text)}</div>
        </div>
        ${canFill ? `<div class="al-actions"><button class="mini al-fill" type="button"
            data-act="alert-fill" data-i="${i}"${fillQty}
            title="把该股与建议数量填入下单区（不自动提交）">填入卖出</button></div>` : ''}
      </div>`;
    }).join('');
  }

  if (note) {
    // 阈值一律从引擎常量取，避免 UI 文案与引擎悄悄漂移
    note.innerHTML = `<span class="muted">`
      + `大盘层：档位偏离容忍带 ${(MARKET_CFG.band * 100).toFixed(0)}%、`
      + `最小可执行差额 ${(MARKET_CFG.minActionPos * 100).toFixed(0)}% · `
      + `持仓层：止损线 ${(POS_CFG.stopLoss * 100).toFixed(0)}%、`
      + `单票上限 ${(POS_CFG.concMax * 100).toFixed(0)}%、`
      + `回撤降仓线 ${(POS_CFG.ddTrigger * 100).toFixed(0)}%`
      + `</span>`
      + ` 阈值与 V5.2 回测引擎同源；预警由规则引擎按当档数据与账户实况生成，`
      + `<b>不构成投资建议</b>，按键只把参数填入下单区，是否下单由你决定。`;
  }
}

/** 动作中文名（与 src/alerts.js 的 ACTIONS 一致；UI 侧留一份只为渲染，不参与判断） */
const ACTIONS_CN = {
  buy: '买入', sell: '卖出', add: '加仓', reduce: '减仓',
  clear: '空仓', exit: '清仓', hold: '持有', wait: '等待', watch: '观望',
};

// ────────────────────────── 预警战绩（收益归因） ──────────────────────────
//
// 为什么要有这块：预警的价值不在「说了什么」，而在「说了之后价格怎么走」。
// 把每条预警触发时的价格冻结进台账，用今天的真实价结算，就能回答用户最关心的问题——
// **这套预警到底帮我少亏了多少、多赚了多少、准不准**。
//
// 三个数字的符号约定（与 src/alert_log.js 一致，UI 不得另立一套）：
//   · 已规避亏损：卖出/减仓类预警在下跌中避免的损失（越大越好）
//   · 错杀/错过：卖出后反弹（卖飞）、或加仓后下跌（看错）造成的负贡献
//   · 净贡献 = 规避 − 错杀；**命中率分母只含已有结论的条目**（待验证的不算分母）

/** 归因汇总的判定类目 → 配色类名。规避亏损用蓝（不是红/绿——它既不是涨也不是跌） */
const ATTR_CLS = { pos: 'al-blue', neg: 'hl-dn', flat: 'muted' };

function renderAttribution() {
  const box = $('alertsAttr');
  if (!box) return;

  const s = currentAttribution();
  if (!s || !s.n) {
    box.innerHTML = `<div class="al-attr-empty muted">`
      + `尚无预警战绩——每触发一条预警就会按当刻真实价记账，后续用真实行情结算，`
      + `用来回答「这套预警到底帮我少亏了多少、多赚了多少」。</div>`;
    return;
  }

  const judged = s.hit + s.miss;
  const netCls = s.net > 0 ? 'al-blue' : s.net < 0 ? 'hl-dn' : 'muted';
  const cells = [
    { k: '已规避亏损', v: s.avoidedLoss > 0 ? `+${num(s.avoidedLoss, 0)}` : '0', c: 'al-blue',
      note: '卖出/减仓后在下跌中避免的损失', act: 'attr-detail', extra: 'pos' },
    { k: '错杀 / 错过', v: s.missedGain > 0 ? `−${num(s.missedGain, 0)}` : '0', c: 'hl-dn',
      note: '卖飞（反弹）或加仓后下跌', act: 'attr-detail', extra: 'neg' },
    { k: '净贡献', v: `${s.net >= 0 ? '+' : '−'}${num(Math.abs(s.net), 0)}`, c: netCls,
      note: `规避 − 错杀，按真实行情结算`, act: 'attr-detail', extra: 'net' },
    { k: '命中率', v: s.hitRate == null ? '待积累' : `${(s.hitRate * 100).toFixed(0)}%`,
      c: s.hitRate == null ? 'muted' : (s.hitRate >= 0.5 ? 'al-blue' : 'hl-dn'),
      note: judged ? `${s.hit} 对 / ${s.miss} 错，另有 ${s.flat + s.pending + s.tracked} 条未定` : '暂无已结算条目',
      act: 'attr-detail', extra: 'rate' },
  ];

  box.innerHTML = `<div class="al-attr">
      <div class="al-attr-hd">
        <b>预警战绩</b>
        <span class="muted">共记账 ${s.n} 条 · 点数字看逐条明细</span>
      </div>
      <div class="al-attr-cells">${cells.map((c) => `<div class="al-cell" data-act="${c.act}" data-k="${esc(c.k)}" tabindex="0" role="button">
          <div class="al-k">${esc(c.k)}</div>
          <div class="al-v ${c.c}">${esc(c.v)}</div>
          <div class="al-n muted">${esc(c.note)}</div>
        </div>`).join('')}</div>
      <div class="al-attr-txt">${esc(summarizeText(s))}</div>
    </div>`;
}

/** 归因明细表：按规则拆解，每条给出「触发价 → 今日价 → 差额」，全部可核验 */
function attrDetail() {
  const s = currentAttribution();
  if (!s || !s.n) return null;

  const rows = s.byType.map((t) => {
    const rate = (t.hit + t.miss) > 0 ? `${((t.hit / (t.hit + t.miss)) * 100).toFixed(0)}%` : '—';
    const netCls = t.net > 0 ? 'al-blue' : t.net < 0 ? 'hl-dn' : 'muted';
    return `<tr>
      <td>${esc(t.type)}</td>
      <td>${esc(ACTIONS_CN[t.action] || t.action)}</td>
      <td class="num">${t.count}</td>
      <td class="num ${netCls}">${t.net >= 0 ? '+' : '−'}${num(Math.abs(t.net), 0)}</td>
      <td class="num">${esc(rate)}</td>
      <td class="num muted">${t.pending || 0}</td>
    </tr>`;
  }).join('');

  // 逐条明细：只列已结算的，未结算的单独计数（避免把「还不知道」混进战绩里）
  const settled = s.details.filter((d) => d.result && d.result.pnl != null);
  const list = settled.map((d) => {
    const r = d.result;
    const cls2 = r.pnl > 0 ? 'al-blue' : r.pnl < 0 ? 'hl-dn' : 'muted';
    return `<div class="al-line">
      <span class="al-line-d">${esc(d.asOf || '—')}</span>
      <span class="al-line-c">${esc(d.code ? `${d.name || d.code} ${d.code}` : '大盘')}</span>
      <span class="al-line-t">${esc(d.type)}</span>
      <span class="al-line-p">${num(r.px)} → ${num(r.finalPx)}（${pct(r.pct)}）</span>
      <span class="al-line-v ${cls2}">${r.pnl >= 0 ? '+' : '−'}${num(Math.abs(r.pnl), 0)} 元</span>
      <span class="al-line-b muted">${r.verdict === 'hit' ? '方向对' : r.verdict === 'miss' ? '方向错' : '几乎没动'}</span>
    </div>`;
  }).join('') || '<div class="muted">暂无已结算条目（预警需要后续真实价格才能验证）。</div>';

  const body = dwSection('战绩总览',
    `<div class="dw-note">${esc(summarizeText(s))}</div>`
    + dwKv([
      ['已规避亏损', `${num(s.avoidedLoss, 0)} 元`],
      ['错杀 / 错过', `${num(s.missedGain, 0)} 元`],
      ['净贡献', `${s.net >= 0 ? '+' : '−'}${num(Math.abs(s.net), 0)} 元`],
      ['命中率', s.hitRate == null ? '待积累' : `${(s.hitRate * 100).toFixed(0)}%（${s.hit} 对 / ${s.miss} 错）`],
      ['记账条数', `${s.n} 条（已结算 ${s.hit + s.miss + s.flat} · 待验证 ${s.pending + s.tracked}）`],
    ]))
    + dwSection('按规则拆解', `<table class="dw-tb"><thead><tr>
        <th>规则</th><th>动作</th><th class="num">条数</th><th class="num">净贡献(元)</th><th class="num">命中率</th><th class="num">待验证</th>
      </tr></thead><tbody>${rows}</tbody></table>`)
    + dwSection('逐条明细', `<div class="al-lines">${list}</div>`)
    + dwSection('计分口径',
      `<div class="dw-note">归因只做「照做 vs 不动」的差额，按<b>股数 × 价差</b>计算，`
      + `不含费用（费用在两边都发生，做差会抵消）。触发价在记账时冻结、永不被后续行情改写；`
      + `不足 100 股（一手）的建议不计分——A 股执行不了。`
      + `大盘层没有单一标的价格，只记「应调整多少金额」，<b>不编造收益数字</b>。</div>`);

  return {
    title: '预警战绩明细',
    sub: `记账 ${s.n} 条 · 净贡献 ${s.net >= 0 ? '+' : '−'}${num(Math.abs(s.net), 0)} 元`,
    body,
  };
}

/**
 * 把预警的建议转成下单区输入（**只填不提交**——与「研判推荐」的填入同纪律）。
 * 卖出方向要把数量也带上，否则用户还得自己算「减多少股」。
 */
function fillAlertToOrder(i) {
  const r = currentAlerts();
  const a = r && r.alerts[i];
  if (!a) return;
  if (a.action === 'clear' || a.action === 'exit') {
    // 空仓/清仓是「一键空仓」那种批量动作，不在这里做——引导用户用账户栏那颗按钮更安全
    msg('「空仓」涉及全部持仓，请用账户总览的「一键空仓」，避免只卖一只造成误解', 'ok');
    return;
  }
  if (!a.code) return;
  ORDER = { ...ORDER, code: a.code, side: 'sell', qty: a.qty > 0 ? a.qty : 0 };
  syncOrderInputs();
  renderOrderForm();
  renderQuick();
  const nm = LIVEQ[a.code]?.name || a.name || '';
  if (!LIVEQ[a.code] && !LIVE_BUSY) {
    refreshLive([a.code]).then((res) => {
      renderOrderForm();
      renderQuick();
      msg(res.ok ? `已填入 ${a.code} ${LIVEQ[a.code]?.name || nm} 卖出，请核对数量后提交` : `${a.code} 取不到行情，请核对代码`, res.ok ? 'ok' : 'err');
    });
  } else {
    msg(`已填入 ${a.code} ${nm} 卖出${a.qty > 0 ? ` ${a.qty} 股` : ''}，请核对后提交`, 'ok');
  }
  $('poQty')?.focus?.();
}

/** 预警条目详情抽屉：把引擎给出的触发依据原样展示，便于核对 */
function alertDetail(i) {
  const r = currentAlerts();
  const a = r && r.alerts[i];
  if (!a) return null;
  const title = a.code ? `${a.name || a.code} ${a.code}` : '大盘仓位';
  // 复用抽屉的 dwSection / dwKv（函数声明会提升，放在后面定义也能用）——
  // 手写一份 HTML 结构等于多一套需要同步维护的版式。
  const body = dwSection('建议动作',
    `<div class="dw-note"><b>${esc(ACTIONS_CN[a.action] || a.action)}</b>`
    + `${a.qty > 0 ? ` · 数量 ${a.qty} 股` : ''}`
    + ` · 严重度 ${esc(AL_LABEL[a.level] || a.level)}`
    + ` · 规则出处 ${esc(a.layer === 'market' ? 'src/alerts.js marketAlerts()' : 'src/alerts.js positionAlerts()')}</div>`)
    + dwSection('触发依据', `<div class="dw-note">${esc(a.why || '—')}</div>`)
    + dwSection('当时的字段取值', dwKv(Object.entries(a.quote || {}).map(([k, v]) => [k, esc(v)])))
    + alertTrackRecord(a, r);
  return {
    title: `${esc(title)}`,
    sub: `${AL_LABEL[a.level] || a.level} · ${ACTIONS_CN[a.action] || a.action} · 数据日 ${esc(r.asOf || '—')}`,
    body,
  };
}

/**
 * 这条规则的历史战绩：同类预警过去触发过几次、方向对了几次、累计贡献多少。
 *
 * 为什么按 type 聚合而不是只看这一条：单条预警当天还没结算（价格没走出来），
 * 此时「这一条赚没赚」是无意义的；有意义的是**这条规则历史上准不准**——
 * 那才是用户决定「要不要照做」的依据。
 */
function alertTrackRecord(a, r) {
  const s = currentAttribution();
  const t = s && s.byType ? s.byType.find((x) => x.type === a.type) : null;
  if (!t) {
    return dwSection('这条规则的历史战绩',
      `<div class="dw-note muted">本条规则尚无往期记账——本次触发已写入战绩台账，`
      + `后续用真实行情结算后，这里会显示「照做 vs 不动」的累计差额。</div>`);
  }
  const judged = t.hit + t.miss;
  const netCls = t.net > 0 ? 'al-blue' : t.net < 0 ? 'hl-dn' : 'muted';
  return dwSection('这条规则的历史战绩',
    `<div class="dw-note">按规则 <code>${esc(t.type)}</code> 累计，`
    + `不含本次未结算的部分。</div>`
    + dwKv([
      ['累计触发', `${t.count} 次`],
      ['累计贡献', `${t.net >= 0 ? '+' : '−'}${num(Math.abs(t.net), 0)} 元`],
      ['方向对/错', judged ? `${t.hit} 对 / ${t.miss} 错` : '—'],
      ['待验证', `${t.pending || 0} 次`],
    ])
    + `<div class="dw-note ${netCls}">${esc(
      t.net > 0 ? '历史看，按这条规则操作整体是「省下/赚到」的。'
        : t.net < 0 ? '历史看，这条规则有过「卖飞」或「看错」，请结合当前依据自行判断。'
          : '历史看，累计贡献接近零。')}</div>`);
}

// ────────────────────────── 研判推荐（小模块） ──────────────────────────

/**
 * 当前推荐结果（缓存，供抽屉与渲染共用，避免两处各算一遍导致数字不一致）。
 * 每天都重算——推荐是「当日」的，不是「永久」的。
 */
let PICKS = null;

function currentPicks() {
  const day = ARC_DAYS[ARC_DAYS.length - 1];
  if (!day) return null;
  // 情绪分取当档（与研判报告、回测引擎同源），不是页面当前实时值——推荐必须可复现
  const score = (day.emotion && day.emotion.value != null) ? day.emotion.value : null;
  if (!PICKS || PICKS.asOf !== (day.trade_date || null)) {
    // stopLossPct 由这里显式传入：picks.js 不 import alerts.js（避免 picks ⇄ alerts 互引），
    // 但止损线口径仍取自 alerts.js 的 POS_CFG，保持「阈值唯一出处」。
    PICKS = recommendPicks(day, {
      emotionScore: score, topN: PICK_TOP_N, stopLossPct: POS_CFG.stopLoss,
    });
  }
  return PICKS;
}

const TONE_CLS = { up: 'hl', warn: 'bf-warn', muted: 'muted' };

function renderPicks() {
  const meta = $('picksMeta');
  const box = $('picksList');
  const rejBox = $('picksRejected');
  const note = $('picksNote');
  if (!box) return;

  const r = currentPicks();
  if (!r) {
    // 存档没就绪：如实说明，不给假数据
    if (meta) meta.innerHTML = '<span class="muted">数据未就绪</span>';
    box.innerHTML = '<div class="picks-empty muted">等待行情存档加载…</div>';
    if (rejBox) rejBox.innerHTML = '';
    if (note) note.textContent = '';
    return;
  }

  if (meta) {
    const tierTxt = r.tier
      ? `<span class="pk-tier ${r.tier.allowNew ? '' : 'warn'}">${esc(r.tier.label)}</span>`
      : '<span class="pk-tier warn">档位未知</span>';
    const st = r.pred || {};
    meta.innerHTML = `数据日期 <b>${esc(r.asOf || '—')}</b> · 情绪分 <b>${r.score == null ? '—' : r.score.toFixed(1)}</b>`
      + ` → 市场档位 ${tierTxt} · 候选池 <b>${r.pool}</b> 只`
      + ` → 预测筛选：推荐 <b class="hl">${r.picks.length}</b> 只`
      + `、剔除 <b class="hl-dn">${st.rejected == null ? '—' : st.rejected}</b> 只（大概率亏）`
      + `、未达概率门槛 ${st.below == null ? '—' : st.below} 只`
      // 连板维度单独报：置顶了几只、门槛多少——用户能核对自己看到的排序
      + (st.streakTop
        ? ` · 其中 <b class="hl">${st.streakTop}</b> 只 T+1 连板概率 ≥${st.streakTopMin}%（已置顶打标签）`
        : ` · 无连板概率 ≥${st.streakTopMin == null ? 30 : st.streakTopMin}% 的标的`);
  }

  if (!r.picks.length) {
    box.innerHTML = `<div class="picks-empty muted">${esc(r.note.text)}</div>`;
  } else {
    // 置顶组与普通组之间插一条分隔说明——不插的话用户不知道「为什么上面那几只排前面」
    const topCnt = r.picks.filter((p) => p.streakTop).length;
    let rendered = 0;
    box.innerHTML = r.picks.map((p, i) => {
      // 置顶组结束、普通组开始时插入分隔条（只插一次）
      let sep = '';
      if (topCnt > 0 && rendered === topCnt && i === topCnt) {
        sep = `<div class="pk-sep"><span>以下按上涨概率排序（未达连板门槛）</span></div>`;
      }
      if (p.streakTop) rendered++;
      const chg = p.changePct == null ? null : +p.changePct;
      const chgCls = chg == null ? 'muted' : (chg > 0 ? 'hl' : chg < 0 ? 'hl-dn' : 'muted');
      const prob = p.prob || {};
      const band = prob.band || {};
      const bandCls = band.key === 'high' ? 'pb-high' : band.key === 'mid' ? 'pb-mid' : band.key === 'low' ? 'pb-low' : 'pb-poor';
      const lp = p.limitUp || {};
      const sb = lp.band || {};
      const sbCls = sb.key === 'high' ? 'pb-high' : sb.key === 'mid' ? 'pb-mid' : sb.key === 'low' ? 'pb-low' : 'pb-poor';
      const exp = p.exp || {};
      const expC = exp.atClose || {};
      const factorTxt = (prob.factors || []).map((f) => f.label).join(' + ') || '无实测有效因子';
      return sep + `<div class="pk-row${p.streakTop ? ' pk-row-top' : ''}" data-act="pick" data-code="${esc(p.code)}"
          data-suggest-weight="${p.suggestWeight > 0 ? p.suggestWeight : 0}" tabindex="0" role="button"
          title="点击查看 ${esc(p.name || p.code)} 的详情">
        <span class="pk-rank${i === 0 ? ' top' : ''}">${i + 1}</span>
        <div class="pk-main">
          <div class="pk-line1">
            <b class="pk-name">${esc(p.name || p.code)}</b>
            <span class="pk-code muted">${esc(p.code)}</span>
            ${chg == null ? '' : `<span class="pk-chg ${chgCls}">${pct(chg)}</span>`}
            ${p.streakTop
              ? `<span class="pk-streak ${sbCls}" title="连板概率：历史同特征组（${esc(lp.group || '')}）里 T+1 再次涨停的占比。基准 ${r.streakBaseline == null ? 21.8 : r.streakBaseline}%。">${esc(p.streakText || '大概率连板')}</span>`
              : ''}
            <span class="pk-prob ${bandCls}" title="上涨概率分：历史同特征组的实际上涨占比（不是主观置信度）">上涨概率 ${prob.score == null ? '—' : prob.score.toFixed(1)}</span>
            ${p.netOutflow ? `<span class="pk-outflow" title="${esc(NET_OUTFLOW_TAG)}：该票当日龙虎榜净买入 ≤ 0，已扣综合分 ${LHB_NET_OUTFLOW_PENALTY.SCORE} 分 / 上涨概率 ${LHB_NET_OUTFLOW_PENALTY.PROB} 个百分点，且须人工复核后才能下单。">${esc(NET_OUTFLOW_TAG)}</span>` : ''}
          </div>
          <div class="pk-reasons">
            <span class="pk-tag muted">依据：${esc(factorTxt)}</span>
            ${expC.median == null ? '' : `<span class="pk-tag hl" title="T 日收盘价买入 → T+1 收盘的实测中位涨幅（同特征分组）">历史同组中位 ${expC.median > 0 ? '+' : ''}${expC.median}%</span>`}
            <span class="pk-tag muted" title="该分组的实测样本量，样本越小可信度越低">样本 ${prob.sample || '—'} 例</span>
            ${lp.isStreak && lp.n ? `<span class="pk-tag muted" title="连板概率的实测样本量（连板档 × 换手档分层）">连板样本 ${lp.n} 例</span>` : ''}
            ${p.reasons.map((x) => `<span class="pk-tag ${TONE_CLS[x.tone] || 'muted'}">${esc(x.text)}</span>`).join('')}
          </div>
          ${p.risks.length ? `<div class="pk-risks muted">风险：${esc(p.risks.join('；'))}</div>` : ''}
          ${exp.warn ? `<div class="pk-risks bf-warn">${esc(exp.warn.replace(/\*\*/g, ''))}</div>` : ''}
        </div>
        <div class="pk-actions">
          <span class="pk-w" title="建议仓位（占总资产）">${p.suggestWeight > 0 ? (p.suggestWeight * 100).toFixed(1) + '%' : '观察'}</span>
          <span class="pk-stop muted" title="止损位（系统单笔止损纪律）">止损 ${p.stop ? (p.stop.stopLossPct * 100).toFixed(0) : '—'}%</span>
          <button class="mini pk-buy" type="button" data-act="pick-fill" data-code="${esc(p.code)}"
            title="把该股代码填入下方下单区">填入下单</button>
        </div>
      </div>`;
    }).join('');
  }

  // 被剔除的票必须让用户看得见——「静默丢弃」会让人以为池子里本来就没有这些票
  if (rejBox) {
    const rj = r.rejected || [];
    if (!rj.length) {
      rejBox.innerHTML = '';
    } else {
      rejBox.innerHTML = `<details class="pk-rej"><summary>已剔除 ${rj.length} 只「大概率亏」标的（点开看原因）</summary>`
        + `<div class="pk-rej-body">` + rj.map((p) => {
          const d = [];
          if (p.changePct != null) d.push(`当日 ${p.changePct > 0 ? '+' : ''}${p.changePct}%`);
          if (p.turnoverPct != null) d.push(`换手 ${p.turnoverPct}%`);
          if (p.streak != null && p.streak > 1) d.push(`${p.streak} 连板`);
          return `<div class="pk-rej-row">`
            + `<span class="pk-rej-name">${esc(p.name || p.code)}</span>`
            + `<span class="pk-code muted">${esc(p.code)}</span>`
            + `<span class="pk-rej-why bf-warn">${esc(p.reason)}</span>`
            + `<span class="muted">${esc(d.join(' · '))}</span>`
            + `<div class="pk-rej-detail muted">${esc(String(p.why || '').replace(/\*\*/g, ''))}</div>`
            + `</div>`;
        }).join('') + `</div></details>`;
    }
  }

  if (note) {
    const n = r.note;
    note.innerHTML = `<span class="${n.level === 'blocked' ? 'bf-warn' : 'muted'}">${esc(n.text)}</span>`
      // 权重一律从引擎常量取，避免 UI 文案与引擎权重悄悄漂移
      + ` 排序依据：<b>连板概率达门槛的置顶打标签</b>，其余按预测上涨概率降序`
      + `（基于 ${(r.pred && r.pred.baselineN) || 975} 个涨停样本，基准上涨占比 ${(r.pred && r.pred.baselineUp) || 55.3}%；`
      + `连板概率基于同批样本的 ${(r.pred && r.pred.streakBaselineN) || 976} 例分层统计，基准再涨停率 ${r.streakBaseline == null ? 21.8 : r.streakBaseline}%）。`
      + `剔除规则：换手≥25%、连板≥5、北交所、ST、仅小额外资金且无涨停。`
      + `数据取自当日榜（区间累计榜与新股已剔除）。<b>概率是历史统计，不是收益承诺</b>，`
      + `且<b>不构成投资建议</b>，仅供模拟盘练习参考；买卖由你自行判断。`;
  }
}

/**
 * 按「研判推荐的建议比例」算出该票的可下单数量（唯一出处）。
 *
 * 需求：点「填入下单」时要自动按建议比例填数量，且**必须是 100 的整数倍**；
 * 不足 100 整手时，取「不超过该比例预算的最大整手数」。
 *
 * 为什么不自己写一套取整逻辑：整手规则（LOT=100）、含费预算、可用资金上限
 * 全都已经在 src/paper.js 的 qtyByAssetPct 里定义过一遍了。这里再写一遍必然漂移
 * （手续费率、最低佣金、滑点任一调整就会两处不一致）。所以本函数只做三件事：
 *   ① 取比例（推荐的 suggestWeight，已含宽波动打折）；
 *   ② 取价（与「仓位档位」按钮同一口径：实时价 → 存档价，再叠加买入滑点）；
 *   ③ 把口径原样委托给 qtyByAssetPct —— 它已保证整手向下取整 + 受可用资金约束。
 *
 * @returns {{qty:number, pct:number, px:number|null, need:number, capped:boolean,
 *            reason:string|null}} qty=0 时 reason 说明为什么填不出来
 */
function qtyBySuggestWeight(code) {
  const c = String(code || '');
  const p = (currentPicks()?.picks || []).find((x) => x.code === c) || null;
  const pct = p && Number.isFinite(+p.suggestWeight) ? +p.suggestWeight : 0;
  // 降级票（龙虎净买 ≤ 0）**不自动填量**：填量 = 替用户把仓位算好了，
  // 而这条规则的处置恰恰是「先人工复核再决定买多少」。系统在这里退一步，
  // 只把代码填进去并说明原因，把「买多少」的决定权交回用户。
  const od = outflowOf(c);
  if (od) {
    return { qty: 0, pct, px: null, need: 0, capped: false, needReview: true,
      reason: `${FLAG_LHB.NET_OUTFLOW}：已扣综合分 ${LHB_NET_OUTFLOW_PENALTY.SCORE} 分 / `
        + `上涨概率 ${LHB_NET_OUTFLOW_PENALTY.PROB} 个百分点，进入备选观察池。`
        + `系统不代填数量——请先人工复核，并自行决定买多少` };
  }
  if (!(pct > 0)) {
    return { qty: 0, pct, px: null, need: 0, capped: false,
      reason: '当前档位不建议新建仓（建议比例为 0）——可手动填数量' };
  }
  const info = lookup(c);
  // 与 renderQuick 的档位按钮同一判据：能取到真实价才谈得上算数量
  if (!info || !info.board.tradable || !info.fresh || !info.price) {
    return { qty: 0, pct, px: null, need: 0, capped: false,
      reason: '取不到该股真实价格，无法按比例估量——请先拉到行情' };
  }
  if (!ACCT) {
    return { qty: 0, pct, px: null, need: 0, capped: false, reason: '模拟账户未就绪' };
  }
  const px = fillPrice(info.price, 'buy', SLIP);
  const st = accountStats(ACCT);
  const r = qtyByAssetPct(st.total, pct, px, { cash: ACCT.cash });
  if (r.qty <= 0) {
    return { qty: 0, pct, px, need: 0, capped: true,
      reason: `预算 ${num(st.total * pct)} 元不足一手（一手约 ${num(px * LOT + MIN_COMMISSION)} 元，含最低佣金）` };
  }
  return { qty: r.qty, pct, px, need: r.need, capped: !!r.capped, reason: null };
}

/** 把推荐股填入下单区（不自动提交——绝不替用户下单） */
function fillPickToOrder(code) {
  const c = String(code || '');
  if (!c) return;
  // 换票即作废上一个票的复核确认：确认是「针对这只票看过净流出了」，
  // 顺延到另一只票上就成了走过场。
  if (ORDER.code !== c) clearReview();
  // 数量按建议比例自动算好再填（整手向下取整；算不出来则留空并说明原因）
  const s = qtyBySuggestWeight(c);
  ORDER = { ...ORDER, code: c, qty: s.qty, side: 'buy' };
  syncOrderInputs();
  renderOrderForm();
  renderQuick();
  const nm = LIVEQ[c]?.name || lookup(c)?.name || '';
  // 降级票：不抓实时价、不重算数量——数量留空是**刻意的**，不是算不出来。
  // 抓价会把「留空」当成「价格没到」自动填回去，反而绕过了规则。
  if (s.needReview) {
    msg(`已填入 ${c} ${nm}，但**数量留空**：${s.reason}`, 'err');
    $('poQty')?.focus?.();
    return;
  }
  const said = s.qty > 0
    ? `已填入 ${c} ${nm} 建议 ${(s.pct * 100).toFixed(1)}% → ${s.qty} 股（约 ${num(s.need)} 元含费用）`
      + `${s.capped ? '，已受可用资金限制' : ''}`
    : `已填入 ${c} ${nm}，但数量留空：${s.reason}`;
  // 输入框的实时抓价逻辑挂在 input 事件上；这里用程序赋值不会触发，故显式抓一次
  if (!LIVEQ[c] && !LIVE_BUSY) {
    msg(`正在获取 ${c} 实时行情…`, 'ok');
    refreshLive([c]).then((r) => {
      // 拉到实时价后用**同一口径**重算数量：首次填的是存档价估量，
      // 实时价到手后价格可能变了，数量必须跟着变，否则"建议比例"其实没兑现。
      const s2 = r.ok ? qtyBySuggestWeight(c) : s;
      // 重算前再判一次降级：抓价期间规则结果不会变，但这一行让「不代填」的口径
      // 在两条分支上都成立，不必依赖上面的提前 return。
      if (s2.needReview) {
        ORDER = { ...ORDER, qty: 0 };
        syncOrderInputs();
        renderOrderForm();
        renderQuick();
        msg(`${c} ${FLAG_LHB.NET_OUTFLOW}，数量留空：${s2.reason}`, 'err');
        return;
      }
      if (r.ok && s2.qty !== s.qty) {
        ORDER = { ...ORDER, qty: s2.qty };
        syncOrderInputs();
        renderOrderForm();
      }
      renderQuick();
      msg(r.ok
        ? `已填入 ${c} ${LIVEQ[c]?.name || nm}`
          + (s2.qty > 0 ? ` 建议 ${(s2.pct * 100).toFixed(1)}% → ${s2.qty} 股（按实时价重算）` : `，数量留空：${s2.reason}`)
        : `${c} 取不到行情，请核对代码`, r.ok ? 'ok' : 'err');
    });
  } else {
    msg(said, s.qty > 0 ? 'ok' : 'err');
  }
  // 滚到下单区并聚焦数量，减少一次滚动操作
  $('poQty')?.focus?.();
}

/** 推荐个股的详情抽屉（含入选理由与风险，便于「点击查看个股信息」） */
function pickDetail(code) {
  const r = currentPicks();
  const p = r && r.picks.find((x) => x.code === code);
  if (!p) return null;
  const info = lookup(code);
  const netTxt = (p.netWan == null || !Number.isFinite(+p.netWan))
    ? '<span class="muted">无当日龙虎榜净买记录</span>'
    : `<span class="${p.netWan > 0 ? 'hl' : 'hl-dn'}">${(p.netWan / 1e4).toFixed(2)} 亿</span>`;
  const parts = p.scoreParts || {};
  const prob = p.prob || {};
  const exp = p.exp || {};
  const expC = exp.atClose || {};
  const expO = exp.atOpen || {};
  const stop = p.stop || {};
  // 注意：dwKv 收的是 [键, 值] 二元组数组（内部对键做 esc、对值按 HTML 处理）；
  // 早先误把拼好的 HTML 字符串当二元组传进去，字符串被逐字符解构 → 渲染成 "<d<d<d"。
  const bar = (label, w, v) => [
    `${label}（权重 ${Math.round(w * 100)}%）`,
    `${(v * 100).toFixed(0)} 分 <span class="muted">→ 贡献 ${(w * v * 100).toFixed(1)}</span>`,
  ];
  const bandCls = (prob.band && prob.band.key) === 'high' ? 'pb-high'
    : (prob.band && prob.band.key) === 'mid' ? 'pb-mid'
      : (prob.band && prob.band.key) === 'low' ? 'pb-low' : 'pb-poor';
  const lp = p.limitUp || {};
  const sbCls = (lp.band && lp.band.key) === 'high' ? 'pb-high'
    : (lp.band && lp.band.key) === 'mid' ? 'pb-mid'
      : (lp.band && lp.band.key) === 'low' ? 'pb-low' : 'pb-poor';
  return {
    title: `${esc(p.name || code)}　${esc(code)}`,
    sub: `研判推荐第 ${r.picks.indexOf(p) + 1} 位 · 上涨概率 ${prob.score == null ? '—' : prob.score.toFixed(1)}`
      + `${lp.isStreak && lp.prob != null ? ` · 连板概率 ${lp.prob}%` : ''} · 数据日期 ${esc(r.asOf || '—')}`,
    body: (p.streakTop
      ? dwSection('连板预测：T+1 大概率再涨停（已置顶）', dwKv([
        ['连板概率', `<span class="${sbCls}">${lp.prob == null ? '—' : lp.prob}%</span>`
          + `　<span class="muted">${esc((lp.band && lp.band.label) || '')}　${esc((lp.band && lp.band.desc) || '')}</span>`],
        ['这个数是什么', `<span class="muted">历史同特征组里 <b>T+1 再次涨停的占比</b>——与上面的「上涨概率」是两个目标。`
          + `基准（全部涨停股）为 ${r.streakBaseline == null ? 21.8 : r.streakBaseline}%。</span>`],
        ['实测分组', `${esc(lp.group || '—')}　<span class="muted">样本 ${lp.n || '—'} 例（连板档 × 换手档分层表）</span>`],
        ['⚠ 持有风险', `<span class="bf-warn">该组 T+3 中位 ${lp.t3Med == null ? '—' : lp.t3Med}%</span>`
          + `　<span class="muted">连板是<b>短打逻辑</b>：T+1 冲高不封板就该走，不是「强势可持有」。</span>`],
      ]) + `<div class="dw-note">${esc(lp.note || '')}</div>`
        + `<div class="dw-note muted">连板概率高 ≠ 盈利确定：实测 3 板低换手组的再涨停率虽有 54.2%，`
        + `但该组 T+3 中位 −3.10%——<b>连得上不代表拿得住</b>，请按次日不封板即离场的纪律执行。</div>`
      )
      : '')
      + dwSection('预测：为什么认为它大概率会涨', dwKv([
      ['上涨概率分', `<span class="${bandCls}">${prob.score == null ? '—' : prob.score.toFixed(1)}</span>`
        + `　<span class="muted">${esc((prob.band && prob.band.label) || '—')}　${esc((prob.band && prob.band.desc) || '')}</span>`],
      ['这个分是什么', `<span class="muted">历史同特征组的<b>实际上涨占比</b>——不是主观置信度，也不是收益预测。基准（全部涨停股）为 ${prob.baseline == null ? '—' : prob.baseline}%。</span>`],
      ['命中的实测因子', (prob.factors && prob.factors.length)
        ? prob.factors.map((f) => `<span class="pk-tag hl">${esc(f.label)} ${f.adj > 0 ? '+' : ''}${f.adj}pt</span>`).join(' ')
        : '<span class="muted">无（按基准概率处理）</span>'],
      ['最弱证据样本量', `${prob.sample == null ? '—' : prob.sample} 例　<span class="muted">取所有命中因子里最小的样本量（木桶原理）</span>`],
    ]) + (prob.factors && prob.factors.length
      ? `<div class="dw-note">${prob.factors.map((f) => '· ' + esc(f.note)).join('<br>')}</div>`
      : ''))

      + dwSection('预期收益（实测分组中位数）', dwKv([
        ['T 日收盘买入 → T+1 收盘', expC.median == null ? '—'
          : `<span class="${expC.median > 0 ? 'hl' : 'hl-dn'}">${expC.median > 0 ? '+' : ''}${expC.median}%</span>`
            + `　<span class="muted">${esc(expC.group || '')}　n=${expC.n || '—'}</span>`],
        ['T+1 开盘买入 → T+1 收盘', expO.median == null ? '—'
          : `<span class="${expO.median > 0 ? 'hl' : 'hl-dn'}">${expO.median > 0 ? '+' : ''}${expO.median}%</span>`
            + `　<span class="muted">${esc(expO.group || '')}　n=${expO.n || '—'}</span>`],
      ]) + (exp.warn ? `<div class="dw-note bf-warn">${esc(String(exp.warn).replace(/\*\*/g, ''))}</div>`
        : '<div class="dw-note muted">该分组无实测正期望记录。</div>'))

      + dwSection('止损与仓位', dwKv([
        ['止损位', `<span class="bf-warn">${(stop.stopLossPct * 100).toFixed(0)}%</span>　<span class="muted">系统单笔止损纪律</span>`],
        ['实测 3 日平均最大回撤', stop.maxDD == null ? '—' : `${stop.maxDD}%`],
        ['仓位系数', `${stop.maxPosFactor == null ? 1 : stop.maxPosFactor} 倍　<span class="muted">宽波动品种自动打折</span>`],
        ['本股建议', p.suggestWeight > 0
          ? `${(p.suggestWeight * 100).toFixed(1)}% 总资产（${num(p.suggestWeight * accountStats(ACCT).total)} 元）`
          : '<span class="bf-warn">当前档位不建议新建仓，仅供观察</span>'],
      ]) + `<div class="dw-note">${esc(String(stop.reason || '').replace(/\*\*/g, ''))}</div>`)

      + dwSection('为什么入选（原始证据）', dwKv([
        ['龙虎榜当日净买', netTxt],        ['涨停 / 连板', p.isZt ? (p.streak > 1 ? `涨停（${p.streak} 连板）` : '涨停') : '<span class="muted">未涨停</span>'],
        ['主线题材', p.mainThemeMatch === 'exact' ? '属当日主线题材'
          : p.mainThemeMatch === 'stem' ? '<span class="bf-warn">与主线题材同源（词根匹配，非精确命中）</span>'
            : '<span class="muted">不在当日主线内</span>'],
        ['所属题材', p.themes && p.themes.length ? esc(p.themes.join('、')) : '<span class="muted">—</span>'],
        ['换手率', p.turnoverPct == null ? '—' : `${p.turnoverPct}%`],
        ['现价（当档收盘）', p.close == null ? '—' : `${p.close} 元`],
      ]))
      // 降级规则（净买 ≤ 0）的扣分明细：必须让用户看到「扣了多少、扣前是多少」，
      // 否则「上涨概率 47.3」会被误读成模型的原始判断，而它其实是被规则扣过的。
      + (p.netOutflow ? dwSection(`⚠ 规则降级：${NET_OUTFLOW_TAG}`, dwKv([
        ['命中规则', `<span class="bf-warn">龙虎榜当日净买入 ≤ 0</span>　<span class="muted">唯一出处 src/lhbfilter.js（票数桶 + 扣分）</span>`],
        ['综合分扣减', `−${LHB_NET_OUTFLOW_PENALTY.SCORE} 分　<span class="muted">`
          + `${p.scoreRaw == null ? '—' : p.scoreRaw} → ${p.score == null ? '—' : p.score}`
          + `${p.scorePenalty ? '（已生效）' : '（该分制下扣减为展示口径）'}</span>`],
        ['上涨概率扣减', `−${LHB_NET_OUTFLOW_PENALTY.PROB} 个百分点　<span class="muted">`
          + `${prob.rawScore == null ? '—' : prob.rawScore} → ${prob.score == null ? '—' : prob.score}</span>`],
        ['处置', `<span class="bf-warn">进入备选观察池（禁止自动下单）；<b>人工复核后方可下单</b></span>`
          + `　<span class="muted">系统不会代填买入数量</span>`],
      ]) + `<div class="dw-note bf-warn">${esc(String(p.scoreOutflow || ''))}</div>`
        + `<div class="dw-note muted">这不是"不建议关注"，而是"今天它没有资金证据支持"：`
        + `规则只降优先级、不禁止委托——若你另有依据，可以人工复核后自行决定下单数量。`
        + `但填量与下单的责任随复核一并回到你手上，系统不再代劳。</div>`)
        : '')
      + dwSection('展示分（旧口径，仅供参考）', dwKv([
        bar('资金面 · 龙虎榜净买', SCORE_WEIGHTS.fund, parts.fund || 0),
        bar('连板高度', SCORE_WEIGHTS.streak, parts.streak || 0),
        bar('主线题材', SCORE_WEIGHTS.theme, parts.theme || 0),
        bar('流动性 · 占全榜比重', SCORE_WEIGHTS.liquidity, parts.liquidity || 0),
      ]) + '<div class="dw-note muted">这是升级前的加权分（权重和为 1），现在**不再用于排序**——'
      + '实测显示「资金面/题材」这类因子的边际预测力弱于连板与换手，故排序已改为上涨概率分。</div>')
      + dwSection('风险提示', p.risks.length
        ? `<div class="dw-note">${p.risks.map((x) => '· ' + esc(x)).join('<br>')}</div>`
        : '<div class="dw-empty">按当前规则未命中风险特征（不代表无风险）</div>')
      + dwSection('实时行情', info
        ? dwKv([['最新价', `${num(info.price)} 元`], ['涨跌幅', `<span class="${(info.changePct || 0) >= 0 ? 'hl' : 'hl-dn'}">${pct(info.changePct)}</span>`], ['价格来源', esc(info.srcLabel || '—')]])
        : '<div class="dw-empty">取不到实时行情</div>')
      + `<div class="dw-note"><b>概率是历史统计，不是收益承诺。</b>本推荐由规则引擎按当档数据自动生成，`
      + `<b>不构成投资建议</b>。是否买卖、买多少，由你自行判断。</div>`,
  };
}

// ────────────────────────── 详情抽屉（复用 app.js 的 #drawer） ──────────────────────────

function drawerEl() { return document.getElementById('drawer'); }
let PAPER_STACK = [];

function dwSection(h, body) { return `<div class="dw-sec"><div class="dw-h">${esc(h)}</div>${body}</div>`; }
function dwKv(pairs) {
  return `<div class="dw-kv">${pairs.map(([k, v]) => `<div class="k">${esc(k)}</div><div class="v">${v}</div>`).join('')}</div>`;
}

function openPaperDrawer(v) {
  const d = drawerEl();
  if (!d || !v) return;
  document.getElementById('dwTitle').innerHTML = v.title || '';
  document.getElementById('dwSub').innerHTML = v.sub || '';
  document.getElementById('dwBody').innerHTML = v.body || '';
  d.classList.add('open');
  d.setAttribute('aria-hidden', 'false');
  document.getElementById('drawerMask')?.classList.add('open');
}

// 各个详情

function statDetail(k) {
  const st = accountStats(ACCT);
  const common = [['初始资金', `${st.initCash.toLocaleString()} 元（虚拟）`], ['当前总资产', `${num(st.total)} 元`]];
  const M = {
    总资产: {
      pairs: [...common, ['构成', `可用 ${num(st.cash)} + 冻结 ${num(st.freeze)} + 市值 ${num(st.marketValue)}`],
        ['恒等式', `总资产 − 初始 = 已实现 ${num(st.realized)} + 浮动 ${num(st.floatPnl)}`]],
      note: '市值按最新真实收盘价计；冻结来自未成交的买入委托。',
    },
    可用资金: { pairs: [...common, ['可用', `${num(st.cash)} 元`], ['冻结中', `${num(st.freeze)} 元`]], note: '买入挂单会预冻结资金（今收价 + 费用），撤单或成交后释放。' },
    冻结资金: { pairs: [...common, ['冻结', `${num(st.freeze)} 元`], ['来源', `${(ACCT.pending || []).filter((p) => p.side === 'buy').length} 张待成交买单`]], note: '真实券商的同一行为：委托提交即冻结，成交时按实际价结算。' },
    持仓市值: { pairs: [...common, ['市值', `${num(st.marketValue)} 元`], ['持仓成本', `${num(st.costValue)} 元`], ['持仓数', `${st.posCount} 只`]], note: '取不到最新行情的票沿用上一价并标「旧价」，不会归零。' },
    浮动盈亏: { pairs: [...common, ['浮动盈亏', `${num(st.floatPnl)} 元`], ['幅度', pct(st.floatPnlPct * 100)]], note: '＝最新市值 − 持仓成本；成本含买入时的佣金与过户费，所以「平价卖出」也是亏的。' },
    已实现盈亏: { pairs: [...common, ['已实现', `${num(st.realized)} 元`]], note: '清仓或部分卖出时结转：卖出净收入（扣佣金/过户费/印花税）− 对应股份的持仓成本。' },
    累计费用: {
      pairs: [...common, ['累计', `${num(st.totalFee)} 元`], ['占初始资金', pct(st.totalFee / st.initCash * 100)],
        ['佣金费率', `万三（单笔最低 ${MIN_COMMISSION} 元）`], ['过户费', '万0.1（双边）'], ['印花税', '万五（仅卖出）'], ['滑点', `万${SLIP * 1e4}（买入抬价 / 卖出压价）`]],
      note: '滑点是模拟的冲击成本，不进入「累计费用」（它不是付给券商的费用，而是成交价的让价）。',
    },
    账户收益率: { pairs: [...common, ['收益率', pct(st.retPct)], ['绝对收益', `${num(st.total - st.initCash)} 元`]], note: '＝（总资产 − 初始资金）÷ 初始资金。' },
  };
  const d = M[k];
  if (!d) return null;
  return { title: `账户指标 · ${k}`, sub: `数据日 ${LAST_DATE || '—'} · 全部按真实行情与 A 股现行制度计算`, body: dwSection('口径', dwKv(d.pairs)) + `<div class="dw-note">${d.note}</div>` };
}

function posDetail(code) {
  const p = ACCT.positions?.[code];
  if (!p) return null;
  const info = lookup(code);
  const mv = (p.last ?? p.avgCost) * p.qty;
  const pnl = mv - (p.cost || 0);
  const frozen = (ACCT.pending || []).filter((x) => x.code === code && x.side === 'sell').reduce((a, x) => a + x.qty, 0);
  const trades = (ACCT.trades || []).filter((t) => t.code === code);
  const buyGross = trades.filter((t) => t.side === 'buy').reduce((a, t) => a + t.gross, 0);
  const buyFee = trades.filter((t) => t.side === 'buy').reduce((a, t) => a + t.fee, 0);
  return {
    title: `${esc(p.name || code)}　${esc(code)}`,
    sub: `持仓 ${p.qty} 股 · 成本 ${num(p.avgCost, 3)} · 现价 ${num(p.last)} · 浮动 ${num(pnl)}`,
    body: dwSection('持仓明细', dwKv([
      ['代码 / 名称', `${esc(code)} ${esc(p.name || '')}`],
      ['板段 / 涨跌停', `${esc(info?.board?.label || '—')} ±${info?.limitPct != null ? (info.limitPct * 100).toFixed(0) : '—'}%${info?.st ? '（ST）' : ''}`],
      ['持仓数量', `${p.qty} 股`],
      ['可卖数量', `${Math.max(0, (p.avail || 0) - frozen)} 股${frozen ? `（另有 ${frozen} 股被卖单冻结）` : ''}`],
      ['T+1 说明', (p.avail || 0) < p.qty
        ? `<span class="bf-warn">${p.qty - (p.avail || 0)} 股为当日买入，次一交易日可卖</span>`
        : '全部可卖'],
      ['加权平均成本', `${num(p.avgCost, 4)} 元（含买入费用）`],
      ['持仓总成本', `${num(p.cost)} 元`],
      ['最新价', `${num(p.last)} 元${p.pxStale ? ' <span class="bf-warn">（最近一档无行情，沿用上一价）</span>' : ''}`],
      ['市值', `${num(mv)} 元`],
      ['浮动盈亏', `<span class="${cls(pnl)}">${num(pnl)} 元（${pct(p.cost ? pnl / p.cost * 100 : 0)}）</span>`],
      ['建仓日 / 持有', `${esc(p.openDate || '—')} · ${p.days || 0} 个交易日`],
    ]))
      + dwSection('买入成本构成', dwKv([
        ['累计买入金额', `${num(buyGross)} 元`],
        ['累计买入费用', `${num(buyFee)} 元`],
        ['费用占比', buyGross ? pct(buyFee / buyGross * 100, 3) : '—'],
      ]) + `<div class="dw-note">成本 = 买入金额 + 买入费用；因此把持仓按成本价卖出仍是亏的（还要再扣一遍卖出费用与印花税）。</div>`)
      + (trades.length ? dwSection('该股成交记录',
        `<table class="dw-tb"><thead><tr><th>成交日</th><th>方向</th><th class="num">数量</th><th class="num">价格</th><th class="num">费用</th></tr></thead><tbody>`
        + trades.map((t) => `<tr><td>${esc(t.fillDate)}</td><td class="${t.side === 'buy' ? 'hl' : 'hl-dn'}">${t.side === 'buy' ? '买入' : '卖出'}</td>`
          + `<td class="num">${t.qty}</td><td class="num">${num(t.price)}</td><td class="num">${num(t.fee)}</td></tr>`).join('')
        + '</tbody></table>') : '')
      + `<div class="dw-note">模拟器不提供自动交易：买卖一律由你决定，引擎只负责按真实制度撮合与记账。</div>`,
  };
}

function pendingDetail(id) {
  const p = (ACCT.pending || []).find((x) => x.id === id);
  if (!p) return null;
  const info = lookup(p.code);
  return {
    title: `待成交委托 #${p.id}`,
    sub: `${p.side === 'buy' ? '买入' : '卖出'} ${esc(p.name || p.code)} ${p.qty} 股 · 提交于 ${p.submitDate}`,
    body: dwSection('委托详情', dwKv([
      ['代码 / 名称', `${esc(p.code)} ${esc(p.name || '')}`],
      ['方向 / 数量', `${p.side === 'buy' ? '买入' : '卖出'} ${p.qty} 股`],
      ['提交日', esc(p.submitDate || '—')],
      ['提交时价', `${num(p.submitPrice)} 元<span class="muted">（下单瞬间的真实行情）</span>`],
      ['预估成交价', `${num(p.estPrice)} 元（含滑点）`],
      ['冻结金额', `${num(p.need)} 元`],
      ['撮合规则', '次一交易日按该日<b>真实收盘价</b>成交'],
    ]))
      + dwSection('可能失效的情形', `<div class="dw-note">
        · 次日<b>涨停</b>（买单）或<b>跌停</b>（卖单）→ 无对手盘，委托失效并释放冻结<br>
        · 次日价格跳空导致<b>资金不足</b> → 委托失效（不会透支）<br>
        · 次日该股<b>无真实行情</b> → 委托失效并释放冻结<br>
        以上都是真实交易里会遇到的情况，不是系统故障。</div>`)
      + `<div class="dw-note">点抽屉底部「撤销委托」或列表里的撤单按钮可立即释放冻结。</div>`,
  };
}

function histDetail(view, i) {
  const t = (view === 'trade' ? ACCT.trades : ACCT.orders)?.[i];
  if (!t) return null;
  const isTrade = view === 'trade';
  const px = isTrade ? t.price : (t.fillPrice ?? t.estPrice);
  const gross = isTrade ? t.gross : (t.gross ?? (px ? Math.round(px * t.qty * 100) / 100 : null));
  const f = gross ? fees(gross, t.side) : null;
  return {
    title: isTrade ? `成交详情 · ${esc(t.name || t.code)}` : `委托 #${t.id} · ${statusText(t)}`,
    sub: `${t.side === 'buy' ? '买入' : '卖出'} ${t.qty} 股 · ${esc(t.code)} · ${esc(isTrade ? t.fillDate : t.submitDate)}`,
    body: (t.status && t.status !== 'filled' && !isTrade
      ? dwSection('结果', dwKv([['状态', statusTag(t)], ['原因', esc(t.reject || '—')], ['说明', esc(t.detail || '—')]]))
      : '')
      + dwSection('价格与金额', dwKv([
        ['委托价（提交日收盘）', `${num(t.submitPrice)} 元`],
        ['成交价', `${num(px)} 元`],
        ['价格漂移', t.driftPct != null
          ? `<span class="${cls(t.driftPct)}">${pct(t.driftPct)}</span>（T+1 撮合的必然结果：下单时只能看到今收）`
          : '—'],
        ['成交金额', gross ? `${num(gross)} 元` : '—'],
        ['滑点', `万${SLIP * 1e4}（买入抬价 / 卖出压价）`],
      ]))
      + (f ? dwSection('费用明细（按真实费率重算，可与账本核对）', dwKv([
        ['佣金', `${num(f.comm)} 元（万三，最低 ${MIN_COMMISSION} 元）`],
        ['过户费', `${num(f.transfer)} 元（万0.1）`],
        ['印花税', `${num(f.stamp)} 元${t.side === 'buy' ? '（买入不收）' : '（万五，仅卖出）'}`],
        ['费用合计', `<b>${num(f.total)} 元</b>`],
        ['账本记账费用', t.fee != null ? `${num(t.fee)} 元 ${Math.abs(t.fee - f.total) < 0.02 ? '✓ 一致' : '<span class="bf-warn">✗ 与重算不一致</span>'}` : '—'],
      ])) : '')
      + `<div class="dw-note">说明：${esc(t.reason || '手动下单')}。成交由引擎按 T+1 规则撮合，费用按 A 股现行费率逐笔计价。</div>`,
  };
}

function perfDetail(k) {
  const nav = (ACCT.nav || []).map((r) => r.equity);
  if (nav.length < 2) return null;
  const m = paperMetrics(nav);
  return {
    title: `账户绩效 · ${k}`,
    sub: `${m.days} 个交易日 · 区间收益 ${pct(m.total * 100)} · 最大回撤 ${pct(-m.ddPct)}`,
    body: dwSection('全部指标', dwKv([
      ['样本交易日', `${m.days} 日（${esc(ACCT.nav[0].date)} ~ ${esc(ACCT.nav[ACCT.nav.length - 1].date)}）`],
      ['区间总收益', `<span class="${cls(m.total)}">${pct(m.total * 100)}</span>`],
      ['年化收益', pct(m.annual * 100)],
      ['最大回撤', pct(-m.ddPct)],
      ['夏普比率', num(m.sharpe)],
      ['日胜率', pct(m.winRate * 100)],
      ['最新净值', `${num(nav[nav.length - 1])} 元`],
    ]))
      + dwSection('净值序列', `<table class="dw-tb"><thead><tr><th>交易日</th><th class="num">净值</th><th class="num">现金</th><th class="num">市值</th><th class="num">日变动</th></tr></thead><tbody>`
        + ACCT.nav.slice(-20).reverse().map((r, idx, arr) => {
          const prev = ACCT.nav[ACCT.nav.length - 1 - idx - 1];
          const chg = prev ? (r.equity / prev.equity - 1) * 100 : null;
          return `<tr><td>${esc(r.date)}</td><td class="num">${num(r.equity)}</td><td class="num">${num(r.cash)}</td>`
            + `<td class="num">${num(r.marketValue)}</td><td class="num ${cls(chg)}">${chg == null ? '—' : pct(chg)}</td></tr>`;
        }).join('')
        + '</tbody></table>')
      + `<div class="dw-note">指标定义与 <b>src/backtest.js</b> metrics() 一致（年化 252、回撤按峰值、夏普按日收益标准差）。`
      + `样本仅 ${m.days} 个交易日，年化/夏普的统计意义有限。</div>`,
  };
}

// ────────────────────────── 渲染：批量下单（V5.2-pro 规则第五块） ──────────────────────────
//
// 设计取舍（为什么这样接）：
//   · **规则判断全部在引擎**。本文件只做三件事：解析文本输入 → 组装 items → 调 batchSubmit/batchSell。
//     过滤条件、风控阈值、日志文案一律不由 UI 决定，保证屏幕上看到的和账本里发生的是同一件事。
//   · **价格用实时源**。batchSubmit 的签名收的是 archive 的「某一天」，但模拟器是实时撮合下的
//     真实价口径，所以这里用实时价**现造**一个 day 对象喂进去（与单票 submit() 同源）。
//     为什么敢这么做：batchSubmit 只从 day 里读 trade_date / lhb（龙虎榜） / summary.lhb_daily_net，
//     行情本身由 quotesFromDay(day) 取——我们用实时价覆盖同名键，语义仍是「今天的真实价」。
//   · **卖出不做龙虎过滤**（规则原文：龙虎榜过滤只针对买入标的前置），走 batchSell。
//   · **预检不等于拦截**。用户点提交前，UI 不预先拦他；但提交后每只票的结果必须逐条说清
//     「在哪一步、因为什么被拦」，否则用户会以为挂单成功了。

/** 当前用于批量过滤的「当日」对象：优先取存档最新日（含龙虎榜），再叠加实时价 */
function batchDay() {
  const day = ARC_DAYS[ARC_DAYS.length - 1] || {};
  // 实时价覆盖：把 live 盘中/盘后价写进 quotes，让 batchSubmit 的成交额估算用真实价
  const quotes = {};
  for (const code of Object.keys(LIVEQ)) {
    const q = LIVEQ[code];
    if (!q || !Number.isFinite(+q.price)) continue;
    quotes[code] = { code, name: q.name, price: +q.price, changePct: q.changePct ?? null, prevClose: q.prevClose ?? null, src: 'live' };
  }
  return { ...day, quotes: { ...(day.quotes || {}), ...quotes } };
}

/**
 * 解析批量输入框文本 → items。
 * 容忍格式：`600519`、`600519,10`、`600519 10`、`600519,200`（mode=qty 时 200 是股数）、
 * `#注释`、空行。**不猜**：无法解析的行如实标为解析失败，不静默丢弃。
 * @returns {{items:Array, errors:Array}}
 */
function parseBatchInput(text, { mode, side, defaultPct }) {
  const items = [];
  const errors = [];
  const lines = String(text || '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    // 代码：前 6 位数字（允许带 .SH/.SZ 后缀或前后空格）
    const m = line.match(/^(\d{6})/);
    if (!m) { errors.push(`第 ${i + 1} 行「${line}」：找不到 6 位股票代码`); return; }
    const code = m[1];
    const rest = line.slice(m[0].length).replace(/^[\s,，]+/, '').trim();
    const val = rest ? Number(String(rest).replace(/[%％]/g, '')) : null;
    const row = { code };
    if (side === 'buy') {
      if (mode === 'qty') {
        // 按股数：显式值必须是正整数；缺省时不给默认股数（股数没有「合理默认」，宁可不填让对方看到提示）
        if (val != null && Number.isFinite(val) && val > 0) row.qty = Math.floor(val);
        else if (val != null) { errors.push(`第 ${i + 1} 行「${line}」：股数需为正整数`); return; }
        else row.pct = defaultPct;   // 无值时退回默认比例（引擎会换算整手）
      } else {
        // 按比例：显式值视为「占总资产百分比」；缺省用默认仓位
        if (val != null && Number.isFinite(val) && val > 0) row.pct = val / 100;
        else if (val != null) { errors.push(`第 ${i + 1} 行「${line}」：比例需为正数`); return; }
        else row.pct = defaultPct / 100;
      }
    } else if (val != null && Number.isFinite(val) && val > 0) {
      // 批量卖出：卖出没有「比例」的引擎口径，只有全部可卖。显式数值暂不支持——
      // 诚实拦下并告知，而不是悄悄按全卖处理（那是最危险的一种「猜」）。
      errors.push(`第 ${i + 1} 行「${line}」：批量卖出目前按「全部可卖数量」执行，不支持指定数值`);
      return;
    }
    items.push(row);
  });
  return { items, errors };
}

/** 批量提交（买入走 batchSubmit，卖出走 batchSell） */
async function runBatch() {
  const ta = $('btInput');
  const text = ta ? ta.value : '';
  const side = BATCH.side;
  const mode = BATCH.mode;

  // 读控件当前值（用户可能改了默认比例/勾选项但没触发 change）
  const defPctEl = $('btDefaultPct');
  const defaultPct = Math.max(0.1, +((defPctEl && defPctEl.value) || 5) || 5);
  const applyLhbEl = $('btApplyLhb');
  const checkRiskEl = $('btCheckRisk');
  const applyLhb = applyLhbEl ? !!applyLhbEl.checked : true;
  const checkRisk = checkRiskEl ? !!checkRiskEl.checked : true;

  const { items, errors } = parseBatchInput(text, { mode, side, defaultPct });
  if (!items.length) {
    msg(errors.length ? `没有可提交的标的 —— ${errors[0]}` : '请先在输入框填写至少一只标的（每行「代码,值」）', 'err');
    BATCH = { ...BATCH, result: { side, items: [], errors, summary: null } };
    renderBatch();
    return;
  }

  // 先抓齐所有标的实时价（批量提交的成交额估算依赖真实价；缺价的票会被引擎如实拦下）
  msg(`正在获取 ${items.length} 只标的的实时行情…`, 'ok');
  await refreshLive(items.map((it) => it.code));

  const day = batchDay();
  // date 同单票路径用真实提交日：风控的「单日累计买入」按此分组，且 T+1 门禁据此顺延
  const opts = { date: bjToday(), applyLhbFilter: applyLhb, checkRisk };
  // 卖出：不做龙虎过滤（规则原文只对买入做前置过滤），也不做仓位变动风控（降仓必须放行）
  const r = side === 'buy'
    ? batchSubmit(ACCT, items, day, opts)
    : batchSell(ACCT, items, day, { date: opts.date });

  ACCT = r.next;
  save();
  BATCH = { ...BATCH, result: { side, items: r.results, errors, summary: r.summary } };
  renderAllPaper();
  syncPositionsLive();

  const s = r.summary || {};
  const okN = s.submitted ?? 0;
  const blkN = s.blocked ?? 0;
  if (okN && !blkN) {
    msg(`批量${side === 'buy' ? '买入' : '卖出'}完成：${okN} 笔已挂单，将于下一交易日按真实收盘价撮合`, 'ok');
  } else if (okN && blkN) {
    msg(`批量完成：${okN} 笔已挂单、${blkN} 笔被拦`
      + (s.blockedByLhb ? `（龙虎过滤 ${s.blockedByLhb}）` : '')
      + (s.blockedByRisk ? `（风控 ${s.blockedByRisk}）` : '')
      + ` —— 逐只原因见下表`, 'warn');
  } else {
    msg(`全部 ${blkN} 笔被拦，未产生任何委托 —— 逐只原因见下表`, 'err');
  }
}

const BT_STAGE_LABEL = { lhb: '龙虎过滤', risk: '风控', quote: '行情', position: '持仓', qty: '股数', order: '委托' };
const BT_STATUS_LABEL = { submitted: '已挂单', blocked: '已拦截' };

/** 批量结果面板渲染 */
function renderBatch() {
  const box = $('btSummary');
  const tb = $('btTable')?.querySelector('tbody');
  const hint = $('btHint');

  // 同步方向/口径分段控件的选中态（渲染是唯一收口，避免两处各改一次 className）
  document.querySelectorAll('#btSide button').forEach((b) => {
    const on = b.dataset.side === BATCH.side;
    b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('#btMode button').forEach((b) => {
    const on = b.dataset.mode === BATCH.mode;
    b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false');
    // 卖出没有「按比例/按股数」之分（恒为全部可卖）——把口径控件禁用并说明，
    // 否则用户会以为「卖出按比例 10%」生效了，而实际挂的是全部持仓，这是最危险的一种误解。
    b.disabled = BATCH.side === 'sell';
  });
  const pctWrap = $('btDefaultPct')?.closest('label');
  if (pctWrap) pctWrap.style.display = BATCH.side === 'sell' ? 'none' : '';

  const r = BATCH.result;
  if (box) {
    if (!r) {
      box.innerHTML = '<div class="muted">填写标的后点「批量提交委托」——每只独立走龙虎过滤与账户风控，'
        + '结果逐条列出（含被拦原因），不会替你自动成交。</div>';
    } else {
      const s = r.summary;
      const errN = (r.errors || []).length;
      box.innerHTML = `<div class="bt-sum-line">`
        + `<span class="bt-chip ${r.side === 'buy' ? 'hl' : 'hl-dn'}">批量${r.side === 'buy' ? '买入' : '卖出'}</span>`
        + `<span class="bt-chip">共 ${r.items.length + errN} 行输入</span>`
        + (s
          ? `<span class="bt-chip ok">已挂单 <b>${s.submitted}</b></span>`
            + `<span class="bt-chip ${s.blocked ? 'bad' : ''}">被拦 <b>${s.blocked}</b></span>`
            + (s.blockedByLhb ? `<span class="bt-chip warn">龙虎过滤 ${s.blockedByLhb}</span>` : '')
            + (s.blockedByRisk ? `<span class="bt-chip warn">风控 ${s.blockedByRisk}</span>` : '')
            + (r.side === 'buy' && s.todayBuyPct != null
              ? `<span class="bt-chip">当日已买入 ${num(s.todayBuyAmount)} 元（占总资产 ${s.todayBuyPct.toFixed(2)}%，上限 ${(MAX_DAILY_POSITION_CHANGE * 100).toFixed(0)}%）</span>`
              : '')
          : '<span class="bt-chip">未提交</span>')
        + (errN ? `<span class="bt-chip bad">输入解析失败 ${errN} 行</span>` : '')
        + `</div>`
        + (errN ? `<ul class="bt-errs">${r.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : '');
    }
  }

  if (tb) {
    if (!r || !r.items.length) {
      tb.innerHTML = '<tr class="empty-row"><td colspan="6" class="muted">暂无批量提交记录</td></tr>';
    } else {
      tb.innerHTML = r.items.map((it) => {
        const st = it.status === 'submitted' ? 'submitted' : 'blocked';
        const stage = it.stage ? (BT_STAGE_LABEL[it.stage] || it.stage) : '—';
        const why = it.status === 'submitted'
          ? (it.detail || '已挂单，待次一交易日撮合')
          : `${stage}：${it.reason || '未通过'}${it.detail ? '（' + it.detail + '）' : ''}`;
        return `<tr class="${it.status === 'submitted' ? '' : 'bt-blocked-row'}">`
          + `<td>${esc(it.code)}</td><td>${esc(it.name || '—')}</td>`
          + `<td class="${it.side === 'buy' ? 'hl' : 'hl-dn'}">${it.side === 'buy' ? '买入' : '卖出'}</td>`
          + `<td class="num">${it.qty == null ? '—' : it.qty}</td>`
          + `<td><span class="stag ${st === 'submitted' ? 'ok' : 'bad'}">${esc(BT_STATUS_LABEL[st])}</span></td>`
          + `<td class="muted">${esc(why)}</td></tr>`;
      }).join('');
    }
  }

  if (hint) {
    const s = r && r.summary;
    hint.innerHTML = `龙虎榜前置过滤版本 <b>${esc(LHBFILTER_VERSION)}</b>`
      + ` · 过滤档位：主池 <b>${esc(BUCKET.MAIN)}</b>（可下单）/ 备选观察 <b>${esc(BUCKET.WATCH)}</b>（禁止自动下单）/ 剔除 <b>${esc(BUCKET.REJECTED)}</b>`
      + ` · 硬止损线 <b>${(HARD_STOP_LOSS * 100).toFixed(0)}%</b>（收盘扫描，触发即生成 T+1 卖单）`
      + (s && s.todayBuyPct != null
        ? ` · 本批次后当日仓位变动 <b>${s.todayBuyPct.toFixed(2)}%</b> / 上限 ${(MAX_DAILY_POSITION_CHANGE * 100).toFixed(0)}%`
        : '')
      + ` · <span class="muted">批量卖出不做龙虎过滤（该规则只约束买入）；全部委托仍为 T+1 次日按真实收盘价撮合</span>`;
  }
}

// ────────────────────────── 渲染：事件日志（V5.2-pro 规则第六块） ──────────────────────────
//
// 日志由引擎在**每一次**委托流转与拦截时写入 ACCT.logs（submitOrder / batchSubmit / batchSell /
// settleDay / scanStopLoss 都会 appendLog）。UI 只读不写——这样「日志完整性」不依赖于
// 用户是否打开了某个面板，也就不会出现「因为界面没渲染所以没记录」的漏洞。

const LOG_STAGE_LABEL = { lhb: '龙虎过滤', risk: '风控', order: '委托', settle: '结算', stop: '止损' };
const LOG_STAGE_CLS = { lhb: 'warn', risk: 'bad', order: 'mut', settle: 'ok', stop: 'warn' };
const LOG_RESULT_LABEL = {
  pass: '通过', rejected: '拦截', submitted: '已提交', filled: '已成交',
  expired: '失效', cancelled: '已撤单', info: '记录',
};
const LOG_RESULT_CLS = {
  pass: 'ok', submitted: 'ok', filled: 'ok', rejected: 'bad',
  expired: 'warn', cancelled: 'mut', info: 'mut',
};

function renderLogs() {
  const tb = $('logTable')?.querySelector('tbody');
  const cards = $('logCards');
  const cnt = $('logCount');
  const note = $('logNote');
  if (!tb && !cards) return;

  const all = readLogs(ACCT, {});
  const rows = LOG.stage ? all.filter((r) => r.stage === LOG.stage) : all;

  document.querySelectorAll('#logTabs button').forEach((b) => {
    const on = (b.dataset.stage || '') === LOG.stage;
    b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false');
  });

  if (cnt) {
    cnt.textContent = LOG.stage
      ? `${LOG_STAGE_LABEL[LOG.stage] || LOG.stage} ${rows.length} 条 / 全部 ${all.length} 条（上限 ${MAX_LOGS}）`
      : `共 ${all.length} 条（上限 ${MAX_LOGS}，超出自动丢弃最早的记录）`;
  }

  // 最新在前：日志是「最近发生了什么」，用户第一眼要看的永远是最新一条
  const list = [...rows].reverse();
  if (tb) {
    tb.innerHTML = list.length
      ? list.map((r) => {
        const ts = r.ts ? fmtClock(new Date(r.ts)) : '—';
        const stCls = LOG_STAGE_CLS[r.stage] || 'mut';
        const rsCls = LOG_RESULT_CLS[r.result] || 'mut';
        return `<tr><td class="muted">${esc(ts)}</td><td>${esc(r.date || '—')}</td>`
          + `<td>${esc(r.code || '—')}</td><td>${esc(r.name || '—')}</td>`
          + `<td class="${r.side === 'buy' ? 'hl' : r.side === 'sell' ? 'hl-dn' : 'muted'}">${r.side === 'buy' ? '买入' : r.side === 'sell' ? '卖出' : '—'}</td>`
          + `<td class="num">${r.qty == null ? '—' : r.qty}</td>`
          + `<td><span class="stag ${stCls}">${esc(LOG_STAGE_LABEL[r.stage] || r.stage)}</span></td>`
          + `<td><span class="stag ${rsCls}">${esc(LOG_RESULT_LABEL[r.result] || r.result)}</span></td>`
          + `<td class="muted">${esc(r.text || r.reason || '—')}</td></tr>`;
      }).join('')
      : `<tr class="empty-row"><td colspan="9" class="muted">暂无日志——下单、结算或触发拦截后会自动记录</td></tr>`;
  }
  if (cards) {
    cards.innerHTML = list.length
      ? list.slice(0, 60).map((r) => {
        const ts = r.ts ? fmtClock(new Date(r.ts)) : '—';
        return `<div class="card-row"><div class="cr-top"><b>${esc(r.name || r.code || '账户事件')}</b>`
          + `<span class="stag ${LOG_STAGE_CLS[r.stage] || 'mut'}">${esc(LOG_STAGE_LABEL[r.stage] || r.stage)}</span>`
          + `<span class="stag ${LOG_RESULT_CLS[r.result] || 'mut'}">${esc(LOG_RESULT_LABEL[r.result] || r.result)}</span></div>`
          + `<div class="cr-bot muted">${esc(r.date || '—')} ${esc(ts)} · ${esc(r.text || r.reason || '')}</div></div>`;
      }).join('')
      : '<div class="dw-empty">暂无日志</div>';
  }
  if (note) {
    note.innerHTML = `日志由交易引擎在每次委托流转与拦截时**自动写入**（不依赖本面板是否打开）。`
      + `阶段口径：龙虎过滤（买入前置）/ 风控（仓位变动与降仓上限）/ 委托（提交与被拒）/ 结算（成交与失效）/ 止损（收盘扫描 −${Math.abs(HARD_STOP_LOSS * 100).toFixed(0)}%）。`
      + `点「导出日志」可把当前过滤结果追加进每日研判报告。`;
  }
}

/** 导出/复制日志文本（Markdown，与研判报告同一格式） */
function logText() {
  const txt = logsToReport(ACCT, LOG.stage ? { stage: LOG.stage } : {});
  if (!txt) return '';
  return txt;
}

function doLogExport() {
  const txt = logText();
  if (!txt) { msg('当前过滤条件下没有日志可导出', 'err'); return; }
  const blob = new Blob([txt], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `paper-logs-${LOG.stage || 'all'}-${LAST_DATE || 'unknown'}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  msg('事件日志已导出（Markdown，可直接粘贴进每日研判报告）', 'ok');
}

async function doLogCopy() {
  const txt = logText();
  if (!txt) { msg('当前过滤条件下没有日志可复制', 'err'); return; }
  try {
    await navigator.clipboard.writeText(txt);
    msg('事件日志已复制到剪贴板', 'ok');
  } catch (e) {
    // 剪贴板 API 在非 https / 无权限时会失败：降级为「下载」，不让用户空手而归
    doLogExport();
    msg('浏览器不允许直接写剪贴板，已改为下载文件', 'warn');
  }
}

function doLogClear() {
  const n = (ACCT?.logs || []).length;
  if (!n) { msg('当前没有日志', 'ok'); return; }
  if (!window.confirm(`将清空全部 ${n} 条事件日志。\n日志是「这笔委托当时为什么被拦」的唯一凭据，清空后不可恢复。\n\n确定继续？`)) return;
  ACCT = { ...ACCT, logs: [] };
  save();   // logs 是账户的一部分（ACCT.logs），随账户一起落盘，故 save() 即可
  renderAllPaper();
  msg('事件日志已清空', 'ok');
}

// ────────────────────────── 事件 ──────────────────────────

async function submit() {
  const info = ORDER.code ? lookup(ORDER.code) : null;
  if (!info) { msg('请先输入 6 位股票代码', 'err'); return; }
  if (!ORDER.qty) { msg('请填写委托数量', 'err'); return; }
  // ── 降级规则的**硬门槛**：龙虎榜净买入 ≤ 0 的买入委托，人工复核通过前一律不下发 ──
  // 规则说「人工复核后才允许下单」，那门槛就必须拦在真正下单的那一行之前，
  // 而不能只停留在按钮上的提示文案——提示是可以被绕过的（回车提交、批量面板、程序调用）。
  // 卖出不设门槛：净流出是「谨慎开仓」的理由，不是「不许离场」的理由。
  if (ORDER.side === 'buy') {
    const od = outflowOf(ORDER.code);
    if (od && !reviewPassed(ORDER.code)) {
      msg(`已拦截：${info.name || ORDER.code} 命中「${FLAG_LHB.NET_OUTFLOW}」，须人工复核后才能下单。`
        + `该票已扣综合分 ${LHB_NET_OUTFLOW_PENALTY.SCORE} 分 / 上涨概率 ${LHB_NET_OUTFLOW_PENALTY.PROB} 个百分点，`
        + `当前落入备选观察池（禁止自动下单）。请先确认下方告警详情，再点一次「确认复核并下单」。`, 'err');
      renderOrderForm();   // 让复核按钮显形
      return;
    }
  }
  // 下单前实时校验一次价格：用户可能是几分钟前输入的代码，价格已经变了。
  // 这是「按实时真实价格买卖」的必要动作——用陈旧价算出来的冻结金额会不准。
  if (!LIVEQ[info.code]) {
    msg(`正在获取 ${info.code} 最新行情…`, 'ok');
    await refreshLive([info.code]);
    const fresh = lookup(ORDER.code);
    if (!fresh || !fresh.fresh) {
      msg(`${info.code} 取不到行情（实时源无此代码或已停牌），无法下单；已有持仓仍可卖出`, 'err');
      renderOrderForm();
      return;
    }
    Object.assign(info, fresh);
    renderOrderForm();
  }
  const q = { code: info.code, name: info.name, price: info.price, changePct: info.changePct };
  // submitDate 必须用**真实提交日**（北京时间今天），不能用存档最新交易日（LAST_DATE）：
  //   引擎的 T+1 门禁按 submitDate ≥ 结算日顺延——若记成存档日（盘中时是昨天），
  //   当天点「按实时价结算」就能同日撮合 = T+0 作弊。存档滞后时两者差着整个交易日。
  const r = submitOrder(ACCT, { code: info.code, side: ORDER.side, qty: ORDER.qty, slip: SLIP }, q, { date: bjToday() });
  ACCT = r.next;
  save();
  renderAllPaper();
  syncOrderInputs();
  if (r.order.status === 'rejected') {
    msg(`委托被拒：${r.order.reject}${r.order.detail ? '（' + r.order.detail + '）' : ''}`, 'err');
  } else {
    const pxSrc = info.src === 'live' ? `按${info.srcLabel} ${num(info.price)} 元` : `按${info.srcLabel || '行情'} ${num(info.price)} 元`;
    msg(`${ORDER.side === 'buy' ? '买入' : '卖出'} ${info.name || info.code} ${ORDER.qty} 股已挂单（${pxSrc}预估冻结），将于下一交易日按真实收盘价撮合`, 'ok');
  }
}

function cancel(id) {
  const r = cancelOrder(ACCT, id);
  if (!r.ok) { msg(r.error, 'err'); return; }
  ACCT = r.next;
  save();
  renderAllPaper();
  msg(`委托 #${id} 已撤销，冻结资金已释放`, 'ok');
}

/**
 * 一键空仓：把全部持仓按各自「可卖数量」逐票挂卖单。
 *
 * 诚实边界：T+1 下当日买入的股份不可卖，必然有票卖不掉。这里**不伪造、不排队等解冻**，
 * 而是把不能卖的部分明确跳过，并在结果里逐条列出原因——用户需要知道"哪些没卖掉、为什么"，
 * 否则会误以为已经空仓了。
 *
 * 卖价一律取**实时价**（与单票下单同一口径）；取不到价的标的跳过并说明。
 */
async function closeAll() {
  const positions = Object.values(ACCT?.positions || {});
  if (!positions.length) { msg('当前无持仓，无需空仓', 'ok'); return; }
  const frozenOf = (code) => (ACCT.pending || [])
    .filter((x) => x.code === code && x.side === 'sell').reduce((a, x) => a + x.qty, 0);

  // 先把所有要卖的代码抓一次实时价（与单票下单同源，避免用陈旧价挂单）
  await refreshLive(positions.map((p) => p.code));

  const sold = [];      // 成功挂单
  const skipped = [];   // 未挂单（附原因）
  for (const p of positions) {
    const free = Math.max(0, (p.avail || 0) - frozenOf(p.code));
    if (free <= 0) {
      const why = (p.qty > 0 && (p.avail || 0) === 0) ? '当日买入，T+1 未解冻' : (frozenOf(p.code) > 0 ? '已全部挂卖单' : '可卖数量为 0');
      skipped.push(`${p.name || p.code}：${why}`);
      continue;
    }
    const info = lookup(p.code);
    if (!info || !info.fresh || !Number.isFinite(+info.price) || +info.price <= 0) {
      skipped.push(`${p.name || p.code}：取不到实时行情，无法挂单`);
      continue;
    }
    const q = { code: info.code, name: info.name, price: info.price, changePct: info.changePct };
    const r = submitOrder(ACCT, { code: p.code, side: 'sell', qty: free, slip: SLIP }, q, { date: LAST_DATE });
    if (r.order.status === 'rejected') {
      skipped.push(`${p.name || p.code}：${r.order.reject}${r.order.detail ? '（' + r.order.detail + '）' : ''}`);
      continue;
    }
    ACCT = r.next;
    sold.push(`${p.name || p.code} ${free} 股`);
  }
  save();
  renderAllPaper();
  syncPositionsLive();

  if (sold.length && !skipped.length) {
    msg(`已按实时价挂出卖单：${sold.join('、')}（下一交易日按真实收盘价撮合）`, 'ok');
  } else if (sold.length && skipped.length) {
    msg(`已挂卖 ${sold.length} 只：${sold.join('、')}；未挂 ${skipped.length} 只 —— ${skipped.join('；')}`, 'warn');
  } else {
    msg(`未能挂出任何卖单 —— ${skipped.join('；')}`, 'err');
  }
}

/** 用指定金额新建一个空账户（含起始净值锚点）。初始资金是唯一「虚拟」的输入，其余全部由引擎算。 */
function newAccountWith(cash) {
  let a = emptyAccount(cash, LAST_DATE);
  if (LAST_DATE) {
    a = { ...a, nav: [{ date: LAST_DATE, equity: cash, cash, marketValue: 0 }] };
  }
  return a;
}

/** 把「用户设定的初始资金」同步到输入框（避免渲染后输入框与设定值不一致）。 */
function syncInitCashInput() {
  const inp = $('paperInitCash');
  if (!inp) return;
  // 账户已存在时报账户实际值更有用：用户看到的就是「我这个账户当初用了多少」
  const v = ACCT?.initCash || loadInitCash();
  inp.value = String(Math.round(v));
}

/** 按输入框金额新建账户（会先确认：这是破坏性操作，清空现有记录）。 */
function applyInitCash() {
  const inp = $('paperInitCash');
  if (!inp) return;
  const n = saveInitCash(inp.value);
  if (n == null) return;                      // 越界已提示，保持原账户不动
  if (ACCT && !window.confirm(
    `将按 ${n.toLocaleString()} 元新建账户，现有持仓、成交与委托记录会被清空（不可恢复）。\n\n确定继续？`)) return;
  ACCT = newAccountWith(n);
  save();
  renderAllPaper();
  syncInitCashInput();
  msg(`已按 ${n.toLocaleString()} 元新建模拟账户`, 'ok');
}

function reset() {
  // 重置优先用「账户自己的初始资金」而不是用户偏好：重置的语义是「把这个账户打回原点」，
  // 保持本金不变才符合预期；想换本金请用左边的「按此金额新建账户」。
  const cash = ACCT?.initCash || loadInitCash();
  if (!window.confirm(
    `重置账户将清空全部持仓、成交与委托记录，且不可恢复。\n\n将按原初始资金 ${cash.toLocaleString()} 元重建。\n确定继续？`)) return;
  ACCT = newAccountWith(cash);
  save();
  renderAllPaper();
  syncInitCashInput();
  msg('账户已重置为 ' + cash.toLocaleString() + ' 元虚拟资金', 'ok');
}

function doExport() {
  const text = exportAccount(ACCT);
  const blob = new Blob([text], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `paper-account-${LAST_DATE || 'unknown'}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  msg('账本已导出（可用于离线核验或迁移到另一台设备）', 'ok');
}

function doImport() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'application/json,.json';
  inp.onchange = () => {
    const f = inp.files?.[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      const r = importAccount(String(rd.result || ''));
      if (!r.ok) { msg('导入被拒绝：' + r.error, 'err'); return; }
      ACCT = r.account;
      persistRaw(ACCT);
      renderAllPaper();
      msg('账本已导入', 'ok');
    };
    rd.readAsText(f);
  };
  inp.click();
}

/**
 * 用**实时行情**结算当日挂单（T+1 撮合的「次日」到了）。
 *
 * 与旧的「按存档日补齐」的区别：
 *   · 存档日只在收盘后（当晚 ~18:30）才生成，若用户当天盘中/收盘后想结算，存档里还没有今天 ——
 *     旧逻辑会提示「已是最新，无需结算」，委托卡在那里动不了。
 *   · 实时源随时能拿到「今天」的真实价，所以「今天」也可以作为结算日。
 *
 * 结算价仍取**真实价格**（盘中=最新价，收盘后=当日收盘价），不是模拟价。
 * @param {string} [date] 结算日（默认：今天，北京时间）
 * @returns {Promise<{ok:boolean, date?:string, filled?:number, expired?:number, reason?:string}>}
 */
async function settleByLive(date) {
  const pending = ACCT?.pending || [];
  if (!pending.length) return { ok: false, reason: '当前没有待成交委托' };
  const today = date || bjToday();
  if (ACCT.lastSettle && today <= ACCT.lastSettle) {
    return { ok: false, reason: `今日（${today}）已结算过，下一交易日再结算` };
  }
  // ── 门禁一：今天必须是 A 股交易日 ──
  //   非交易日（周末/休市）时实时源返回的是**上一收盘价**：用它结算 = 用提交时已知的价
  //   成交，击穿「次一交易日按真实价撮合」的防前视设计。此前没有这道门禁——
  //   国庆假期（如 10-02）也能把 09-30 提交的委托按 09-30 收盘价「结算」掉。
  if (!isTradingDay(today)) {
    return { ok: false, tone: 'warn', reason: `今日（${today}）非 A 股交易日，实时源只有上一收盘价——按已知价结算会击穿防前视设计，拒绝。下一可撮合日 ${nextSessionLabel()}` };
  }
  // 只抓「待成交委托」涉及的代码——不为了结算去抓全市场
  const codes = normalizeCodes(pending.map((p) => p.code));
  const r = await refreshLive(codes);
  if (!r.ok) return { ok: false, reason: '取不到实时行情，无法结算（请稍后重试）' };

  const quotes = {};
  for (const c of codes) {
    const q = LIVEQ[c];
    if (q && Number.isFinite(+q.price)) quotes[c] = { code: c, name: q.name, price: +q.price, changePct: q.changePct ?? null, prevClose: q.prevClose ?? null, tickDate: q.tickDate ?? null, src: 'live' };
  }
  // ── 门禁二：结算价必须属于结算日当天 ──
  //   行情自带成交日期（tickDate）：交易日的开盘前，腾讯返回的还是昨收——
  //   用昨收结算等于跳过今天整个交易日，同样是防前视破口。
  //   这道门禁还能兜住 HOLIDAYS 表未收录的年份（行情日期自证休市，不靠硬编码表）。
  const stale = Object.values(quotes).filter((q) => q.tickDate && q.tickDate !== today);
  if (stale.length) {
    return { ok: false, tone: 'warn', reason: `行情还是 ${stale[0].tickDate} 的（今日 ${today} 尚无成交价：未开盘或休市）——用旧价结算会击穿防前视设计，拒绝。今日开盘后再结算` };
  }
  const res = settleDay(ACCT, today, quotes);
  ACCT = res.account;
  save();
  renderAllPaper();
  return { ok: true, date: today, filled: res.fills.length, expired: res.expired.length, t1Hold: res.t1Hold || 0 };
}

/** 北京时间「今天」的 YYYY-MM-DD（结算日/行情日期一律用北京时间，与行情源一致） */
function bjToday() {
  const d = new Date(Date.now() + 8 * 3600e3);
  return d.toISOString().slice(0, 10);
}

/** 行情抓取时刻的简短展示（HH:MM:SS，24 小时制本地时间） */
function fmtClock(d) {
  const t = new Date(d);
  if (isNaN(t)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
}

function settleNow() {
  // 先试「按今天实时价结算」；没有待成交委托或今天已结算，则回退到「按存档日补齐」
  settleByLive().then((r) => {
    if (r.ok) {
      msg(`结算完成（${r.date} 实时价）：成交 ${r.filled} 笔、失效 ${r.expired} 笔${r.t1Hold ? `、顺延 ${r.t1Hold} 笔（T+1 未到，下一交易日撮合）` : ''}`, 'ok');
      return;
    }
    // 回退档同样走滚动窗而非完整档：补结算只可能落后几个交易日。
    // 若账户确实落后超过滚动窗（极端情况：长期未打开），会结算到窗口起点为止——
    // 此时用**日期早于窗口起点**这个事实明确告知用户，而不是静默少算几天。
    // 走 loadRecentArchive 复用同一 promise：boot 已拉过，这里不再产生第二次网络请求。
    loadRecentArchive()
      .then((arc) => {
        const days = recentDays(arc);
        const todo = days.filter((d) => d.trade_date > (ACCT.lastSettle || ''));
        if (!todo.length) { msg(r.reason || '已是最新，无需结算', r.tone || 'ok'); return; }
        const from = days[0]?.trade_date;
        if (ACCT.lastSettle && from && from > ACCT.lastSettle) {
          msg(`账户最后结算日 ${ACCT.lastSettle} 早于本地滚动窗起点 ${from}，仅结算窗口内交易日；`
            + `如需补齐更早日期，请重跑 node scripts/split_archive.mjs 后刷新`, 'err');
        }
        let cur = ACCT, filled = 0, expired = 0, held = 0;
        for (const d of todo) { const rr = settleDay(cur, d.trade_date, quotesFromDay(d)); cur = rr.account; filled += rr.fills.length; expired += rr.expired.length; held += rr.t1Hold || 0; }
        ACCT = cur;
        QMAP = { ...QMAP, ...quotesFromDay(days[days.length - 1]) };
        LAST_DATE = days[days.length - 1].trade_date;
        save();
        renderAllPaper();
        msg(`结算完成（存档日）：成交 ${filled} 笔、失效 ${expired} 笔${held ? `、顺延 ${held} 笔（T+1 未到，下一交易日撮合）` : ''}`, 'ok');
      })
      .catch((e) => msg('结算失败：' + e.message, 'err'));
  });
}

document.addEventListener('click', (e) => {
  const t = e.target;
  if (!t || typeof t.closest !== 'function') return;

  const sideBtn = t.closest('#poSide button');
  if (sideBtn) {
    // 买卖切换必须作废复核记录：降级门槛只针对**买入**（卖出不设槛），
    // 若不清，切换前的确认会静默顺延到另一个方向的操作上。
    if (sideBtn.dataset.side !== ORDER.side) clearReview();
    ORDER = { ...ORDER, side: sideBtn.dataset.side, qty: 0 }; syncOrderInputs(); renderOrderForm(); renderQuick(); return;
  }

  const tab = t.closest('#paperTabs button');
  if (tab) {
    HIST = { view: tab.dataset.view };
    document.querySelectorAll('#paperTabs button').forEach((b) => {
      const on = b.dataset.view === HIST.view;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    renderHist();
    return;
  }

  // 批量下单：方向切换（买/卖）——切换时清掉上一次的结果表，避免「卖出的结果」留在屏幕上被当成买
  const btSide = t.closest('#btSide button');
  if (btSide) {
    const side = btSide.dataset.side;
    if (side !== BATCH.side) BATCH = { ...BATCH, side, result: null };
    renderBatch();
    return;
  }
  // 批量下单：数量口径切换（按比例 / 按股数）。只影响**后续解析**，不回溯已提交的记录
  const btMode = t.closest('#btMode button');
  if (btMode) {
    if (!btMode.disabled) BATCH = { ...BATCH, mode: btMode.dataset.mode, result: null };
    renderBatch();
    return;
  }
  // 事件日志：阶段过滤（纯视图过滤，不改数据）
  const logTab = t.closest('#logTabs button');
  if (logTab) {
    LOG = { stage: logTab.dataset.stage || '' };
    renderLogs();
    return;
  }

  const el = t.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (act === 'pqty') {
    ORDER = { ...ORDER, qty: +el.dataset.qty || 0 };
    syncOrderInputs();
    renderOrderForm();
    return;
  }
  // 按比例买入：点「算数量」用当前输入框的比例算；比例无效/不足一手时说明原因，不留空静默
  if (act === 'pqty-pct') {
    const inp = $('poPct');
    PQ_PCT = inp ? inp.value : PQ_PCT;
    const r = qtyByPct(PQ_PCT);
    if (r.qty > 0) {
      ORDER = { ...ORDER, qty: r.qty };
      syncOrderInputs();
      msg(`${(+PQ_PCT).toFixed(1)}% 总资产 → ${r.qty} 股（约 ${num(r.need)} 元含费用`
        + `${r.capped ? '，已受可用资金限制' : ''}）`, 'ok');
    } else {
      ORDER = { ...ORDER, qty: 0 };
      syncOrderInputs();
      msg(`按 ${PQ_PCT}% 算不出数量：${r.reason}`, 'err');
    }
    renderOrderForm();
    return;
  }
  if (act === 'pcancel') { e.stopPropagation(); cancel(+el.dataset.id); return; }
  // 降级复核确认：**只授权，不提交**。授权后仍需用户点「提交委托」（或自己回车），
  // 这样「人工复核」与「下达委托」始终是两个分离的动作，不会一按就连带下单。
  if (act === 'review-ok') {
    e.stopPropagation();
    markReviewed(el.dataset.code || ORDER.code);
    renderOrderForm();
    msg(`已记录复核：${ORDER.code} 允许本次下单。系统不会自动提交，`
      + `请自行填写数量后点「提交委托」。`, 'ok');
    return;
  }
  if (act === 'pstat') { openPaperDrawer(statDetail(el.dataset.k)); return; }
  if (act === 'ppos') { openPaperDrawer(posDetail(el.dataset.code)); return; }
  if (act === 'ppend') { openPaperDrawer(pendingDetail(+el.dataset.id)); return; }
  if (act === 'phist') { openPaperDrawer(histDetail(el.dataset.view, +el.dataset.i)); return; }
  if (act === 'pperf') { openPaperDrawer(perfDetail(el.dataset.k)); return; }
  // 研判推荐：点「填入下单」只填不提交（绝不替用户下单）；点整行看详情
  if (act === 'pick-fill') { e.stopPropagation(); fillPickToOrder(el.dataset.code); return; }
  if (act === 'pick') { openPaperDrawer(pickDetail(el.dataset.code)); return; }
  // 交易预警：同上——「填入卖出」只填代码与建议数量，点整行看触发依据
  if (act === 'alert-fill') { e.stopPropagation(); fillAlertToOrder(+el.dataset.i); return; }
  if (act === 'alert') { openPaperDrawer(alertDetail(+el.dataset.i)); return; }
  // 战绩格子：点开逐条归因明细（含「触发价 → 今日价 → 差额」的完整链路）
  if (act === 'attr-detail') { openPaperDrawer(attrDetail()); return; }
});

// 输入满 6 位就抓实时行情（防抖 250ms，避免边打字边发请求）。
// 这是「全市场任意 A 股都能下单」得以成立的入口：不再要求代码先出现在标的池里。
let codeTimer = null;
$('poCode')?.addEventListener('input', (e) => {
  const v = String(e.target.value || '').replace(/\D/g, '').slice(0, 6);
  e.target.value = v;
  // 换票时清掉上一只票填的比例：15% 是针对那只票的仓位决定，套到新票上是误操作
  if (v !== ORDER.code) PQ_PCT = null;
  // 同理：降级复核确认也是**按代码**的，换代码即作废（不区分是换成哪一只）
  if (v !== ORDER.code) clearReview();
  ORDER = { ...ORDER, code: v, qty: 0 };
  renderOrderForm();
  renderQuick();
  if (codeTimer) clearTimeout(codeTimer);
  if (v.length === 6) {
    codeTimer = setTimeout(async () => {
      // 已有同代码实时价则不必重复请求；抓取期间先给个提示，避免用户以为卡住
      if (!LIVEQ[v] && !LIVE_BUSY) {
        msg(`正在获取 ${v} 实时行情…`, 'ok');
        const r = await refreshLive([v]);
        renderOrderForm();
        renderQuick();
        if (r.ok) {
          const q = LIVEQ[v];
          msg(`已获取 ${v} ${q?.name || ''} 实时行情`, 'ok');
        } else {
          msg(`${v} 取不到行情（请核对代码是否正确 / 是否停牌）`, 'err');
        }
      } else if (LIVEQ[v]) {
        renderOrderForm();
        renderQuick();
      }
    }, 250);
  }
});
$('poQty')?.addEventListener('input', (e) => {
  ORDER = { ...ORDER, qty: Math.max(0, Math.floor(+e.target.value || 0)) };
  renderOrderForm();
});
// 按比例买入：输入即算（不等点按钮），并把结果显示在提示里。
// 只更新提示、不改 ORDER.qty —— 用户可能只是想看看「15% 是多少股」，
// 直接覆盖他自己填的数量会造成误操作；要点「算数量」才真正采用。
document.addEventListener('input', (e) => {
  if (!e.target || e.target.id !== 'poPct') return;
  PQ_PCT = e.target.value;
  const hint = $('poPctHint');
  if (!hint) return;
  const r = qtyByPct(PQ_PCT);
  if (r.qty > 0) {
    hint.className = 'pq-pct-hint';
    hint.textContent = `= ${r.qty} 股（预算 ${num(r.budget)} 元 → 占用 ${num(r.need)} 元含费用`
      + `${r.capped ? '，受可用资金限制' : ''}）`;
  } else {
    hint.className = 'pq-pct-hint bad';
    hint.textContent = r.reason || '';
  }
});
$('poSubmit')?.addEventListener('click', submit);
$('paperReset')?.addEventListener('click', reset);
// 初始资金：输入框失焦时只**记住偏好**（不建账户），点按钮才真正新建——
// 与下单区的「比例买入」同一交互分层：先看/先设，明确动作才产生后果。
$('paperInitCash')?.addEventListener('change', (e) => {
  const n = saveInitCash(e.target.value);
  // 越界：saveInitCash 已经 msg 了原因。**先记下来再回填**——syncInitCashInput 内部
  // 不写 msg，但若顺序反过来先回填、后又有别的渲染调用 msg，用户就永远看不到为什么被拒。
  // 这里先把提示亮出来，再回填输入框（回填只改 value，不动 msg）。
  if (n == null) {
    const why = $('paperMsg')?.textContent;
    syncInitCashInput();
    if (why) msg(why, 'err');
    return;
  }
  msg(`初始资金已设为 ${n.toLocaleString()} 元（点「按此金额新建账户」生效）`, 'ok');
});
$('paperApplyInit')?.addEventListener('click', applyInitCash);
$('paperExport')?.addEventListener('click', doExport);
$('paperImport')?.addEventListener('click', doImport);
$('paperSettle')?.addEventListener('click', settleNow);
// 一键空仓：先确认（会一次性挂出多笔卖单，误点代价大）
$('paperCloseAll')?.addEventListener('click', () => {
  const n = Object.keys(ACCT?.positions || {}).length;
  if (!n) { msg('当前无持仓，无需空仓', 'ok'); return; }
  if (!window.confirm(`将对 ${n} 只持仓全部挂出卖单（按各自可卖数量、按实时价）。\nT+1 下当日买入的股份卖不掉，会如实告知。\n\n确定继续？`)) return;
  closeAll();
});

// ── 批量下单面板 ──
$('btSubmit')?.addEventListener('click', runBatch);
$('btClear')?.addEventListener('click', () => {
  const ta = $('btInput');
  if (ta) ta.value = '';
  BATCH = { ...BATCH, result: null };
  renderBatch();
});
// 「从研判推荐填入」：把当前推荐清单写成「代码,默认仓位%」逐行填入。
// 只填不提交——与单票的「填入下单」同一纪律：绝不替用户下单。
$('btFillPicks')?.addEventListener('click', () => {
  const r = currentPicks();
  if (!r || !r.picks.length) { msg('暂无研判推荐（需先有行情存档），无法填入', 'err'); return; }
  const ta = $('btInput');
  if (!ta) return;
  const pct = Math.max(0.1, +($('btDefaultPct')?.value || 5) || 5);
  ta.value = r.picks.map((p) => `${p.code},${pct}`).join('\n');
  BATCH = { ...BATCH, side: 'buy', result: null };
  renderBatch();
  msg(`已填入 ${r.picks.length} 只研判推荐（每只 ${pct}% 仓位预览）——请核对后点「批量提交委托」`, 'ok');
});
// 「从持仓填入」：把所有持仓写成代码逐行填入，方向切到卖出（批量卖出=全部可卖）。
// 这是「一键空仓」的**可预览版本**：先看清单再决定，而不是点一下就挂出去。
$('btFillPos')?.addEventListener('click', () => {
  const codes = Object.keys(ACCT?.positions || {});
  if (!codes.length) { msg('当前无持仓，无法填入', 'err'); return; }
  const ta = $('btInput');
  if (!ta) return;
  ta.value = codes.join('\n');
  BATCH = { ...BATCH, side: 'sell', result: null };
  renderBatch();
  msg(`已填入 ${codes.length} 只持仓（按各自可卖数量卖出）——请核对后点「批量提交委托」`, 'ok');
});

// ── 事件日志面板 ──
$('logExport')?.addEventListener('click', doLogExport);
$('logCopy')?.addEventListener('click', doLogCopy);
$('logClear')?.addEventListener('click', doLogClear);
// 默认比例改动即时生效（不用等提交才读值）
$('btDefaultPct')?.addEventListener('change', (e) => {
  BATCH = { ...BATCH, defaultPct: Math.max(0.1, +e.target.value || 5) };
});

// 键盘快捷键 6 跳转到模拟交易（与 app.js 的 1-5 互补；app.js 只认 1-5，故不冲突）
document.addEventListener('keydown', (e) => {
  const t = e.target;
  const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '6') {
    const z = document.getElementById('zone-paper');
    if (z) { e.preventDefault(); z.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
  }
});

boot();
