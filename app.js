// 前端：分层加载 data/archive-index.json（10KB）+ archive-recent.json（124KB）后渲染
// （纯 vanilla，无构建步骤）。完整档 data/archive.json 仅由脚本/审计/回测读取，前端不拉。
// 分层规则与切片生成见 src/archive_split.js（唯一出处）；惰性字段见 src/lhb_codec.js。
const $ = (id) => document.getElementById(id);

// ── 通用工具 ──
// 所有拼接进 innerHTML 的动态文本一律转义：题材名里含 “ ” 等全角引号、诱因里含 + & 等字符，
// 不转义会破属性或注入。
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const yiOf = (wan, d = 2) => (wan == null || !Number.isFinite(+wan)) ? '—' : (Math.round(wan / 1e4 * 10 ** d) / 10 ** d).toFixed(d);
const sgnOf = (v, d = 2) => (v == null || !Number.isFinite(+v)) ? '—' : `${v > 0 ? '+' : ''}${(+v).toFixed(d)}`;
const pctOf2 = (v, d = 2) => (v == null || !Number.isFinite(+v)) ? '—' : `${v > 0 ? '+' : ''}${(+v).toFixed(d)}%`;
const trendCls = (v) => (v == null || !Number.isFinite(+v)) ? 'muted' : (v > 0 ? 'hl' : v < 0 ? 'hl-dn' : 'muted');
const nf = (v) => (v == null || v === '') ? '—' : (Number.isFinite(+v) ? String(v) : String(v));

// ── 席位口径桥接 ──
// src/seats.js 是 ESM 纯函数（席位解析的唯一来源），index.html 用模块脚本挂到 window.Seats。
// app.js 是经典脚本、不能 import，模块脚本又是异步加载的，所以这里做一层薄桥接：
// 已就绪就直接用；尚未就绪则用**同口径**的内联降级实现，绝不让抽屉因为时序问题白屏。
// 两组实现只在「是否有 window.Seats」上分叉，读取口径（含类别汇总行过滤）逐字对齐，
// Node 侧测试覆盖的是模块本体；副本↔主模块的行为一致性由 test/seats_parity.test.mjs 守卫。
function seatsMod() {
  if (window.Seats) return window.Seats;
  // 降级：与 src/seats.js 同逻辑的最小实现（仅读取与身份解析，够抽屉用）
  const normPair = (p) => (Array.isArray(p)
    ? [String(p[0] ?? ''), Number(p[1]) || 0]
    : [String(p?.name ?? ''), Number(p?.v ?? p?.amount ?? 0) || 0]);
  // H-3（2026-10-07）：类别汇总行过滤。东财席位明细在部分票（区间榜尤其）里混有
  // 「自然人 / 机构 / 中小投资者…」这类交易所投资者结构统计行——它们不是席位，金额
  // 与整票成交同阶。此前降级副本漏了这道过滤（主模块 src/seats.js 一直有）：模块脚本
  // 未就绪的窗口期打开抽屉，这些污染行会顶着 23 倍虚增的金额直接上屏。词表与判据
  // （全等匹配 + trim）和 src/seats.js 的 AGGREGATE_ROW_NAMES / isAggregateSeatRow 逐字一致。
  const AGGREGATE_ROW_NAMES = new Set([
    '自然人', '机构', '中小投资者', '其他自然人', '其他机构', '专业机构', '个人投资者', '非金融类上市公司',
  ]);
  const isAggregateSeatRow = (name) => AGGREGATE_ROW_NAMES.has(String(name || '').trim());
  const keepSeat = ([nm]) => !isAggregateSeatRow(nm);
  return {
    seatsOf(detailMap, code) {
      const raw = detailMap && code != null ? detailMap[code] : null;
      if (!raw) return { b: [], s: [], hasSell: false };
      if (Array.isArray(raw)) return { b: raw.map(normPair).filter(keepSeat), s: [], hasSell: false };
      const b = Array.isArray(raw.b) ? raw.b.map(normPair).filter(keepSeat) : [];
      const s = Array.isArray(raw.s) ? raw.s.map(normPair).filter(keepSeat) : [];
      return { b, s, hasSell: s.length > 0 };
    },
    sideStats(pairs) {
      const rows = Array.isArray(pairs) ? pairs : [];
      const sum = rows.reduce((a, x) => a + (Number(x[1]) || 0), 0);
      const top3 = rows.slice().sort((x, y) => y[1] - x[1]).slice(0, 3)
        .reduce((a, x) => a + (Number(x[1]) || 0), 0);
      return { n: rows.length, sum, top3Pct: sum > 0 ? top3 / sum * 100 : null };
    },
    seatIdentity(name) {
      const s = String(name || '').trim();
      const type = /机构专用/.test(s) ? 'inst'
        : /(沪|深)股通/.test(s) ? 'north'
        : (/总部/.test(s) || /自营/.test(s) || /证券投资部/.test(s)) ? 'prop'
        : /营业部/.test(s) ? 'sales'
        : /分公司/.test(s) ? 'branch'
        : /证券|基金|资管/.test(s) ? 'sales' : 'other';
      const LABEL = { inst: '机构专用', north: '沪深股通', prop: '券商总部/自营', branch: '分公司', sales: '证券营业部', other: '其他' };
      let broker = '';
      if (!/机构专用|(沪|深)股通/.test(s)) {
        const m = s.match(/^(.{2,30}?(?:证券|基金|资管|资产管理|期货))(?:(?:股份)?有限(?:责任)?公司|\(|（|$)/)
          || s.match(/^(.{2,30}?)(?:股份有限公司|有限责任公司|有限公司)/);
        broker = m ? m[1].trim() : s.slice(0, 6);
      }
      return { name: s, broker, type, typeLabel: LABEL[type], foreign: false, city: '' };
    },
    buySeatsOf(dm, code) { return seatsMod().seatsOf(dm, code).b.slice().sort((x, y) => y[1] - x[1]); },
    sellSeatsOf(dm, code) { return seatsMod().seatsOf(dm, code).s.slice().sort((x, y) => y[1] - x[1]); },
    SEAT_TYPE_LABEL: { inst: '机构专用', north: '沪深股通', prop: '券商总部/自营', branch: '分公司', sales: '证券营业部', other: '其他' },
  };
}

// 全局状态：最新存档 / 回测档 / 个股明细表的视图与排序（搜索与排序纯前端，不改数据）
let ARC = null;
let HOT_STATE = { view: 'hot', q: '', key: null, dir: -1 };

function scoreClass(v) {
  if (v < 40) return 'low';
  if (v < 60) return 'mid';
  return 'high';
}

function renderAlerts(meta) {
  const box = $('alerts');
  box.innerHTML = '';
  // 绝对时刻 → 北京 MM-DD HH:MM（meta.freshness.publishDeadline 带 +08:00 偏移，比较与时区无关）
  const tz = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const b = new Date(d.getTime() + 8 * 3600e3).toISOString();
    return `${b.slice(5, 10)} ${b.slice(11, 16)}`;
  };
  const f = meta.freshness || {};
  const td = meta.tradeDate || f.tradeDate || '--';
  const attempt = meta.lastAttempt || {};
  const msgs = [];

  // ① 真滞后：服务端按交易日历判定「已过预期更新时刻仍落后于最近已收盘交易日」
  if (meta.stale) {
    let t = `数据滞后：${meta.staleReason || '存档交易日落后于最近已收盘交易日'}。当前展示 ${td} 收盘数据。`;
    if (attempt.reason) t += ` 最近一次抓取：${attempt.reason}。`;
    else if (meta.fallbackReason) t += ` 回退原因：${meta.fallbackReason}。`;
    msgs.push({ cls: 'alert', icon: '⚠', text: t });
  } else if (f.publishDeadline && Date.now() > Date.parse(f.publishDeadline)) {
    // ② 服务端判定「生成时未滞后」，但客户端此刻已过预期更新时刻 → 说明此后一直没更新成功
    msgs.push({ cls: 'alert', icon: '⚠', text:
      `数据尚未更新至最新交易日：当前展示 ${td} 收盘数据，预期 ${tz(f.publishDeadline)} 前更新（18:30 首抓 / 21:00 补抓）。` });
  }

  // ③ 抓取动作本身的结果——与「数据是否滞后」解耦，避免把正常等待说成抓取失败
  if (attempt.outcome === 'failed') {
    msgs.push({ cls: 'alert', icon: '⚠', text:
      `最近一次抓取失败（${attempt.reason || '未给出原因'}），已保留 ${td} 收盘数据。` });
  } else if (attempt.outcome === 'skipped') {
    msgs.push({ cls: 'alert info', icon: 'ℹ', text:
      `本次未抓取新数据：${attempt.reason || '数据源尚未发布'}；保留 ${td} 收盘数据。` });
  } else if (attempt.outcome === 'non-trading-day') {
    msgs.push({ cls: 'alert info', icon: 'ℹ', text: `${attempt.reason || '非交易日'}，保留 ${td} 收盘数据。` });
  }

  // ②B 盘中相位（与新鲜度正交）：phase 说「现在市场在什么阶段」，
  //      freshness.state 说「存档是不是最新已收盘会话」。盘中两者语义必然不同——
  //      行情实时可得，但情绪分/分位/因子仍是上一收盘日算的，绝不能混读。
  //      故盘中必须显著标注，且附口径说明（meta.phaseNote 由引擎下发，前端不自行措辞）。
  const phase = meta.phase || null;
  if (phase === 'live') {
    msgs.push({ cls: 'alert phase-live', icon: '🕐', text:
      meta.phaseNote || '盘中：行情为实时快照，情绪分/分位/因子仍为上一收盘日口径（未重算）。' });
  } else if (phase === 'pre') {
    msgs.push({ cls: 'alert info phase-pre', icon: '🌅', text:
      meta.phaseNote || '开盘前：今日行情尚未产生，下方为上一交易日收盘口径。' });
  }

  // ④ 字段级修补说明（与新鲜度正交，可同时出现）
  if (meta.note) msgs.push({ cls: 'alert info', icon: 'ℹ', text: `数据说明：${meta.note}。` });

  if (meta.source === 'offline-replay') {
    msgs.push({ cls: 'alert', icon: '⚠', text: '当前为离线演示数据，非实时行情。' });
  }
  for (const m of msgs) {
    const d = document.createElement('div');
    d.className = m.cls;
    d.textContent = `${m.icon} ${m.text}`;
    box.appendChild(d);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 错误边界 + 离线/陈旧横幅
//
// 分两级（判定在 src/error_boundary.js，此处只做编排与渲染）：
//   致命 → 首屏必需档（archive-index）拿不到 → 整页替代卡，明确说"没有数据 ≠ 今天没什么"
//   降级 → 其它档拿不到 → 保留已渲染内容，只把对应卡片标成未加载，整页不中断
// 白屏是最坏的失败形态：它连"这儿本该有东西、只是没加载成功"都没有。
//
// ⚠ 本模块**不吞异常**：window.onerror 里只做渲染与提示，不改任何已展示的数值。
//   本项目铁律——错误边界的作用是"说清楚发生了什么"，不是"让错误看起来没发生"。
// ════════════════════════════════════════════════════════════════════════════
let EB = null;            // src/error_boundary.js 导出的纯函数集（ESM 桥接，见下）
const LOAD_RESULTS = [];  // 各档加载结果留痕（供横幅汇总）
let OFFLINE_FRAME = { offline: false, offlineSince: null };

/** ESM 桥接：src/error_boundary.js 是模块脚本，app.js 是经典脚本，不能 import。 */
function ebMod() {
  if (window.__errorBoundary) return window.__errorBoundary;
  if (window.ErrorBoundary) return window.ErrorBoundary;
  return null;
}

/** 记一次档位加载结果（ok=false 时进横幅汇总）。 */
function noteLoad(what, ok, error) {
  LOAD_RESULTS.push({ what, ok, error: error || null, at: new Date().toISOString() });
}

/** 当前时间帧：离线时带上 offlineSince，避免"更新时间"停在离线那一刻而无人察觉。 */
function frameNow() {
  const E = ebMod();
  const now = new Date();
  if (E && typeof E.nowFrame === 'function') {
    return E.nowFrame(now, OFFLINE_FRAME);
  }
  // 降级实现：与 src/error_boundary.js 同口径（守卫断言过字段名一致）
  return {
    iso: now.toISOString(),
    local: now.toISOString().replace('T', ' ').slice(0, 16),
    offline: !!OFFLINE_FRAME.offline,
    offlineSince: OFFLINE_FRAME.offlineSince || null,
  };
}

/**
 * 渲染顶部离线/陈旧横幅。
 *
 * ⚠ 无 engine 时**不静默返回空**：那会让"数据陈旧"这条最要紧的提示因为
 *   一个模块没挂上就整条消失。故降级路径自己拼一份最小横幅（只讲最重的两件事）。
 */
function renderOfflineBar(health) {
  const box = $('offlineBar');
  if (!box) return;
  const E = ebMod();
  const meta = (ARC && ARC.meta) || {};
  const loadState = E && typeof E.classifyLoadResults === 'function'
    ? E.classifyLoadResults(LOAD_RESULTS)
    : null;

  let model;
  if (E && typeof E.staleBannerModel === 'function') {
    model = E.staleBannerModel(meta, health || HEALTH, frameNow(), loadState || {});
  } else {
    // 降级：只覆盖"陈旧"与"离线"这两件最不能漏的事
    const stale = !!meta.stale;
    model = {
      show: stale || OFFLINE_FRAME.offline,
      level: stale ? 'stale' : (OFFLINE_FRAME.offline ? 'degraded' : 'ok'),
      chips: [...(stale ? [{ kind: 'stale', text: '数据陈旧' }] : []),
        ...(OFFLINE_FRAME.offline ? [{ kind: 'offline', text: '离线' }] : [])],
      lines: [...(stale ? [meta.staleReason || '存档落后于最近已收盘交易日。'] : []),
        ...(OFFLINE_FRAME.offline ? ['离线模式：展示最近一次缓存的档，不会再自动更新。'] : [])],
    };
  }

  if (!model.show) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.className = 'offline-bar ob-' + (model.level || 'unknown');
  box.innerHTML = (E && typeof E.renderBannerHtml === 'function')
    ? E.renderBannerHtml(model, esc)
    : `<div class="ob-inner ob-${esc(model.level)}">`
      + `<div class="ob-head">${(model.chips || []).map((c) => `<span class="ob-chip ${esc(c.kind)}">${esc(c.text)}</span>`).join('')}</div>`
      + `<div class="ob-lines">${(model.lines || []).map((l) => `<div class="ob-line">${esc(l)}</div>`).join('')}</div>`
      + `<div class="ob-note">数据仅供参考，不构成投资建议。</div></div>`;
}

/**
 * 致命错误：用替代卡换掉 #alerts 之外的首屏内容。
 * 刻意**不清空** #alerts 与 #offlineBar —— 它们正是解释"为什么什么都没了"的地方。
 */
function renderFatal(err) {
  const E = ebMod();
  const main = document.querySelector('main');
  const info = (E && typeof E.classifyLoadError === 'function')
    ? E.classifyLoadError('archive-index', err)
    : { message: String((err && err.message) || err || '未知错误'), hint: '' };
  const html = (E && typeof E.renderFatalHtml === 'function')
    ? E.renderFatalHtml(info, esc)
    : `<div class="fatal-card"><div class="fc-title">⚠ 首屏数据加载失败</div>`
      + `<div class="fc-msg">${esc(info.message)}</div>`
      + `<button class="mini primary" type="button" data-act="retry-boot">重试加载</button></div>`;
  const holder = $('fatalHolder');
  if (holder) { holder.hidden = false; holder.innerHTML = html; }
  if (main) main.setAttribute('aria-hidden', 'true');
  const nav = $('zoneNav'); if (nav) nav.setAttribute('aria-hidden', 'true');
}

function clearFatal() {
  const holder = $('fatalHolder');
  if (holder) { holder.hidden = true; holder.innerHTML = ''; }
  const main = document.querySelector('main');
  if (main) main.removeAttribute('aria-hidden');
  const nav = $('zoneNav'); if (nav) nav.removeAttribute('aria-hidden');
}

/**
 * 运行期错误兜底。
 * ⚠ 只置一次（首个错误就够定位）；且**不清空页面**——已渲染的内容仍然有效，
 *   这是"降级"而非"致命"。清空页面＝把局部失败放大成整体失败。
 */
let RUNTIME_ERR_SHOWN = false;
function noteRuntimeError(err) {
  if (RUNTIME_ERR_SHOWN) return;
  RUNTIME_ERR_SHOWN = true;
  noteLoad('runtime', false, err);
  const E = ebMod();
  const m = (E && typeof E.runtimeErrorModel === 'function')
    ? E.runtimeErrorModel(err, frameNow())
    : { title: '页面运行出错', message: String((err && err.message) || err), lines: [] };
  // 复用横幅容器：这是"有话说"，不是一个新面板（多开容器＝多一处要维护的空态）
  const box = $('offlineBar');
  if (!box || !box.hidden) return;
  box.hidden = false;
  box.className = 'offline-bar ob-degraded';
  box.innerHTML = `<div class="ob-inner ob-degraded">`
    + `<div class="ob-head"><span class="ob-chip degraded">${esc(m.title || '运行出错')}</span></div>`
    + `<div class="ob-lines"><div class="ob-line">${esc(m.message || '')}</div>`
    + (m.lines || []).map((l) => `<div class="ob-line">${esc(l)}</div>`).join('') + `</div>`
    + `<div class="ob-note">数据仅供参考，不构成投资建议。</div></div>`;
}

// 注册兜底：window.onerror 与 unhandledrejection。
// ⚠ 不 e.preventDefault()：控制台仍要看到原始报错（开发者需要堆栈）。
window.addEventListener('error', (e) => {
  if (e && e.error) noteRuntimeError(e.error);
  else if (e && e.message) noteRuntimeError(new Error(e.message));
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e && e.reason;
  noteRuntimeError(r instanceof Error ? r : new Error(String(r == null ? '未处理的 Promise 拒绝' : r)));
});

// ── 离线状态：SW 通过 postMessage 告知"这次是从缓存拿的" ─────────────────────
if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    const d = (e && e.data) || {};
    if (d.type === 'data-offline') {
      if (!OFFLINE_FRAME.offline) {
        OFFLINE_FRAME = { offline: true, offlineSince: new Date().toISOString() };
        renderOfflineBar();
      }
    } else if (d.type === 'data-online') {
      if (OFFLINE_FRAME.offline) { OFFLINE_FRAME = { offline: false, offlineSince: null }; renderOfflineBar(); }
    }
  });
}
// 浏览器自身的在线/离线事件（SW 未接管时也有用），与上面的 data-* 消息互为补充
window.addEventListener('offline', () => {
  OFFLINE_FRAME = { offline: true, offlineSince: OFFLINE_FRAME.offlineSince || new Date().toISOString() };
  renderOfflineBar();
});
window.addEventListener('online', () => {
  OFFLINE_FRAME = { offline: false, offlineSince: null };
  renderOfflineBar();
});

function renderEmotion(latest) {
  const e = latest.emotion || {};
  const sc = e.value ?? e.score ?? null;
  if (sc == null) return;
  const el = $('emScore');
  el.textContent = sc.toFixed(1);
  el.className = 'score ' + scoreClass(sc);
  $('emPct').textContent = (e.pct_rank ?? '--');
  // 口径：当日榜（权威）。全量口径含「连续N个交易日」区间累计榜，数值是区间累计值，
  // 与日度因子/净买率不同源，故这里不取，避免首页数字与报告口径打架。
  $('emNet').textContent = e.lhb_daily_net != null ? `当日龙虎净买 ${e.lhb_daily_net} 亿` : '';
  // 仓位档位与报告 §6 / 回测引擎同源，首页一眼可见（口径见 getThresholds/posTier）
  const tier = posTier(sc, getThresholds());
  const te = $('emTier');
  if (te) te.innerHTML = tier ? `档位 <b>${esc(tier.label)}</b>` : '';

  const fac = e.factors || e; // 七因子可能直接挂在 emotion 根上
  const names = { s_net: '龙虎榜', s_pos: '涨跌家', s_brd: '行业涨', s_hot: '涨停', s_zdt: '涨跌停', s_zbl: '封板', s_amt: '量能' };
  const hints = {
    s_net: '龙虎榜净额强度', s_pos: '涨跌家数对比', s_brd: '板块红盘占比', s_hot: '涨停强度',
    s_zdt: '涨停与跌停对比', s_zbl: '封板质量（反炸板）', s_amt: '两市量能',
  };
  const wrap = $('factors');
  wrap.innerHTML = '';
  for (const [k, label] of Object.entries(names)) {
    const v = fac[k];
    if (v == null) continue;
    const row = document.createElement('div');
    row.className = 'factor';
    row.title = `${label}（${hints[k] || ''}）：原始因子分 ${v}／100，越高越强`;
    row.innerHTML = `<span class="label">${label}</span><span class="bar"><i style="width:${v}%"></i></span><span class="val">${v}</span>`;
    wrap.appendChild(row);
  }
}

/**
 * 板块相对强弱（超额进攻 / 超额防御）——首页情绪面板可折叠区块。
 *
 * 与报告 §4 同一份数据（summary.industry_relative，口径在 src/relative.js），
 * 本函数**只渲染不重算**。两处渲染同一字段是刻意的：报告是"结论"，面板是"随手看"，
 * 若各自现算，改口径时必然一处生效一处不生效（本项目反复踩过的坑）。
 *
 * 缺数据时必须显示「未计算」而非 0：历史 208 天无行业明细，渲染成 0 会被读成
 * "板块与大盘完全同步"——一个与事实相反的确定结论。
 */
function renderRelative(latest) {
  const host = $('relBlock');
  if (!host) return;
  const rel = latest?.summary?.industry_relative;
  if (!rel) {
    host.innerHTML = `<details class="rel-fold"><summary>板块相对强弱（超额进攻 / 防御）`
      + `<span class="rel-na">未计算</span></summary>`
      + `<div class="rel-body"><div class="muted">该日无行业明细，未计算相对强弱。`
      + `相对强弱需要当日各行业涨跌幅（90 个行业）与上证涨跌幅同源对比，`
      + `历史回填天只有情绪分，故不计算——不用可疑数据凑榜。</div></div></details>`;
    return;
  }
  const b = (rel.primary === 'median' ? rel.vsMedian : rel.vsIndex) || rel.vsMedian || rel.vsIndex;
  if (!b) {
    host.innerHTML = `<details class="rel-fold"><summary>板块相对强弱（超额进攻 / 防御）`
      + `<span class="rel-na">基准缺失</span></summary></details>`;
    return;
  }
  const f2 = (v) => (v >= 0 ? '+' : '') + v.toFixed(2);
  const tone = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
  const row = (r, i) => `<div class="rel-row">`
    + `<span class="rel-rank">${i + 1}</span>`
    + `<span class="rel-name" title="${esc(r.name)}">${esc(r.name)}</span>`
    + `<span class="rel-pct ${tone(r.change_pct)}">${f2(r.change_pct)}%</span>`
    + `<span class="rel-ex ${tone(r.excess)}">${f2(r.excess)}</span>`
    + `</div>`;
  const col = (title, rows, hint) => `<div class="rel-col">`
    + `<div class="rel-col-h">${title}<span class="rel-hint">${hint}</span></div>`
    + rows.map(row).join('') + `</div>`;
  const degraded = rel.degraded
    ? `<div class="rel-warn">⚠ ${esc(rel.degradedReason)}，主榜已降级</div>` : '';
  host.innerHTML = `<details class="rel-fold" open><summary>板块相对强弱（超额进攻 / 防御）`
    + `<span class="rel-base">基准 ${esc(b.baseLabel)} ${f2(b.basePct)}%</span></summary>`
    + `<div class="rel-body">`
    + `<div class="rel-meta">行业中位 ${f2(rel.medianPct)}% · 飘红 ${rel.upCount}/${rel.total} 个行业`
    + `（超额 ＝ 行业涨跌幅 − 基准涨跌幅，同日同源）</div>`
    + degraded
    + `<div class="rel-cols">`
    + col('超额进攻', b.attack, '强于基准前 ' + rel.topN)
    + col('超额防御', b.defense, '弱于基准后 ' + rel.topN)
    + `</div></div></details>`;
}

function chips(list, attr) {  const wrap = $(attr);
  wrap.innerHTML = '';
  const arr = (list || []).map((t) => (typeof t === 'string' ? t : (t.theme || t.name || ''))).filter(Boolean);
  if (!arr.length) { wrap.innerHTML = '<span class="empty">无</span>'; return; }
  for (const label of arr) {
    const c = document.createElement('span');
    c.className = 'chip click';
    c.textContent = label;
    c.dataset.act = 'theme';
    c.dataset.theme = label;
    c.tabIndex = 0;
    c.title = `查看题材「${label}」的成分股与强度`;
    wrap.appendChild(c);
  }
}

function renderMomentum(mom) {
  $('freshN').textContent = (mom.fresh || []).length;
  $('fadeN').textContent = (mom.fading || []).length;
  $('contN').textContent = (mom.continuing || []).length;
  chips(mom.fresh, 'freshList');
  chips(mom.fading, 'fadeList');
  chips(mom.continuing, 'contList');
}

function renderTrend(days) {
  const svg = $('trendSvg');
  // 保留原始索引 i，供「点数据点 → 当日盘面详情」定位到 all_days
  const pts = days.map((d, i) => ({ i, v: d.emotion?.value ?? d.emotion?.score ?? null, date: d.trade_date }));
  const win = pts.slice(-15).filter((x) => x.v != null);
  const tip = $('trendTip');
  if (!win.length) { svg.innerHTML = ''; if (tip) tip.textContent = '情绪序列不足，暂无法绘制'; return; }
  const W = 300, H = 90, pad = 10;
  const vals = win.map((x) => x.v);
  const min = Math.max(0, Math.min(...vals) - 8), max = Math.min(100, Math.max(...vals) + 8);
  const x = (i) => pad + (i * (W - 2 * pad)) / (win.length - 1 || 1);
  const y = (v) => H - pad - ((v - min) / (max - min || 1)) * (H - 2 * pad);
  const line = win.map((p, i) => `${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  // 参考线：引擎阈值（过热/满仓/半仓/清仓），让走势与档位有对照
  const th = getThresholds();
  const guides = [th.overheat, th.lo, th.panic].map((g) => {
    const yy = y(g).toFixed(1);
    return `<line x1="0" y1="${yy}" x2="${W}" y2="${yy}" style="stroke-dasharray:3 3;opacity:.5"></line>`;
  }).join('');
  const dots = win.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="2.6" `
    + `data-act="day" data-i="${p.i}" tabindex="0" style="cursor:pointer" `
    + `aria-label="${esc(p.date)} 情绪分 ${p.v}"><title>${esc(p.date)} 情绪 ${p.v}</title></circle>`).join('');
  svg.innerHTML = guides + `<polyline points="${line}"></polyline>` + dots;
  const lastP = win[win.length - 1];
  if (tip) {
    tip.innerHTML = `共 ${win.length} 个交易日 · 区间 ${vals.length ? Math.min(...vals).toFixed(1) : '—'}~${Math.max(...vals).toFixed(1)}`
      + ` · 参考线为引擎档位 ${th.overheat}/${th.lo}/${th.panic}（过热/满仓/半仓）`
      + ` · 最新 ${esc(lastP.date)} ${lastP.v}`;
  }
}

function renderThemes(latest) {
  const wrap = $('themeBars');
  wrap.innerHTML = '';
  const themes = latest.themes || {};
  const entries = Object.entries(themes).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const max = entries.length ? entries[0][1] : 1;
  const total = Object.values(themes).reduce((a, b) => a + b, 0) || 1;
  if (!entries.length) { wrap.innerHTML = '<div class="empty">当日无题材数据</div>'; return; }
  for (const [name, cnt] of entries) {
    const row = document.createElement('div');
    row.className = 'tb click';
    row.dataset.act = 'theme';
    row.dataset.theme = name;
    row.tabIndex = 0;
    row.title = `点击查看「${name}」成分股（当日涨停 ${cnt} 只，占全题材涨停 ${(cnt / total * 100).toFixed(1)}%）`;
    row.innerHTML = `<span class="name">${esc(name)}</span><span class="bar"><i style="width:${(cnt / max) * 100}%"></i></span><span class="cnt">${cnt}</span>`;
    wrap.appendChild(row);
  }
}

// ── 个股明细表：双视图（强势股归因 / 龙虎榜资金）+ 搜索 + 点列头排序 + 行点击详情 ──
// 涨幅单元格：数值 + 新股标记 + 无行情标记。
// 「无行情」与「0」必须区分开：0 是真实行情（如一字板当日换手可为 0），
// 无行情是数据源没覆盖到这条代码，两者含义完全不同，混在一起会让人以为数据出错。
function chgCell(r) {
  return `<span class="${trendCls(r.change_pct)}">${pctOf2(r.change_pct)}</span>`
    + (isNewStock(r) ? '<span class="newb" title="无价格涨跌幅限制（新股/次新），涨幅与普通个股不可比">新股</span>' : '')
    + (r.close == null ? '<span class="newb nob" title="该代码段暂无行情源覆盖，现价 / 涨跌幅 / 换手为空值（不是 0）">无行情</span>' : '');
}

// 列定义：raw 供排序（数值），cell 供显示（缺省用原值），hint 是表头说明。
const HOT_COLS = {
  hot: [
    { key: 'code', t: '代码' },
    { key: 'name', t: '名称' },
    { key: 'change_pct', t: '涨幅', num: true, hint: '当日涨跌幅（新股无涨跌幅限制，涨幅不具可比性）',
      cell: chgCell,
      raw: (r) => r.change_pct },
    { key: 'close', t: '现价', num: true, hint: '收盘价（元）', raw: (r) => r.close },
    { key: 'huanshou', t: '换手%', num: true, hint: '当日换手率', raw: (r) => r.huanshou },
    { key: 'lb', t: '连板', num: true, hint: '连续涨停板数（来自当日涨停梯队）', cell: (r) => (r.lb == null ? '—' : `${r.lb}板`), raw: (r) => r.lb ?? 0 },
    { key: 'seat', t: '席位', num: true, hint: '东财买卖榜买方席位明细条数', raw: (r) => r.seat ?? 0 },
    { key: 'reason', t: '诱因（点击行看详情）', wide: true, hint: '东财榜单给出的上涨诱因' },
  ],
  lhb: [
    { key: 'code', t: '代码' },
    { key: 'name', t: '名称' },
    { key: 'change_pct', t: '涨幅', num: true, hint: '当日涨跌幅（新股无涨跌幅限制，涨幅不具可比性）',
      cell: chgCell,
      raw: (r) => r.change_pct },
    // 「区间」标记：该笔来自「连续N个交易日」区间累计榜，数值是区间累计值而非当日，
    // 与同列的当日值不可直接比较（把两类混读正是 511 亿事件的起点），故在此显式区分。
    { key: 'net_buy_wan', t: '龙虎净买(亿)', num: true,
      hint: '当日龙虎净买入额（买−卖）；带「区间」标记的来自连续N个交易日累计榜，是区间累计值，不可与当日值直接比较',
      cell: (r) => `<span class="${trendCls(r.net_buy_wan)}">${yiOf(r.net_buy_wan)}</span>${r.caliber === 'range' ? '<span class="rngb" title="来自「连续N个交易日」区间累计榜：数值为区间累计值（非当日），不可与当日值直接比较，也不计入当日榜净买率">区间</span>' : ''}`,
      raw: (r) => r.net_buy_wan },
    // 数据源字段单位是「万元」（sources.js: BILLBOARD_*_AMT / 1e4），表头写的是「亿」，
    // 必须过 yiOf 换算；否则 5.61 亿的买入额会被显示成 56133.2（差 1e4 倍）。
    { key: 'buy_wan', t: '买入(亿)', num: true, hint: '龙虎榜买方合计', cell: (r) => yiOf(r.buy_wan), raw: (r) => r.buy_wan },
    { key: 'sell_wan', t: '卖出(亿)', num: true, hint: '龙虎榜卖方合计', cell: (r) => yiOf(r.sell_wan), raw: (r) => r.sell_wan },
    { key: 'turnover_pct', t: '换手%', num: true, raw: (r) => r.turnover_pct },
    { key: 'lb', t: '连板', num: true, cell: (r) => (r.lb == null ? '—' : `${r.lb}板`), raw: (r) => r.lb ?? 0 },
    { key: 'seat', t: '席位', num: true, raw: (r) => r.seat ?? 0 },
    { key: 'reason', t: '诱因（点击行看详情）', wide: true },
  ],
};

// 卡片视图（窄屏用）：与表格共用同一份 rows / cols，字段顺序即卡片结构 ——
// 前两列（代码/名称）作标题行，第 3 列（涨幅）作右侧大字，末列（wide · 诱因）作说明行，其余列作标签行。
// 这样切换视图（强势股/龙虎榜）、搜索、排序都不必另写一套逻辑，卡片自动跟随。
function hotCardHTML(r, cols) {
  const [c0, c1] = cols;
  const big = cols[2];
  const tags = cols.slice(3, cols.length - 1);
  const last = cols[cols.length - 1];
  const cellOf = (c) => (c ? (c.cell ? c.cell(r) : esc(nf(c.raw ? c.raw(r) : r[c.key]))) : '');
  const name = r[c1?.key] ?? r.code;
  const reason = last ? String(r[last.key] ?? '').trim() : '';
  return `<div class="hcard" data-act="stock" data-code="${esc(r.code)}" tabindex="0" role="button"`
    + ` aria-label="查看 ${esc(name)} 的席位与资金详情" title="点击查看 ${esc(name)} 的席位与资金详情">`
    + `<div class="hc-head"><span class="hc-name">${esc(name)}</span>`
    + `<span class="hc-code muted">${esc(r[c0?.key] ?? r.code)}</span>`
    + `<span class="hc-big ${big ? trendCls(big.raw ? big.raw(r) : r[big.key]) : 'muted'}">${cellOf(big)}</span></div>`
    + `<div class="hc-tags">${tags.map((c) => `<span class="hc-tag"><i>${esc(c.t)}</i>${cellOf(c)}</span>`).join('')}</div>`
    + (reason ? `<div class="hc-reason">${esc(reason)}</div>` : '')
    + '</div>';
}

function hotRows() {
  const days = displayDays(ARC);
  const last = days[days.length - 1] || {};
  const ztLb = last.summary?.zt_lb || {};
  const detail = last.summary?.seats?.detail || {};
  const S = seatsMod();
  const base = HOT_STATE.view === 'lhb' ? (last.lhb_aggr || last.lhb || []) : (last.hot || []);
  return base.map((r) => {
    // 席位明细有新旧两代：v1 是买方数组、v2 是 {b,s}。用统一读取器取「买卖双侧总条数」，
    // 避免旧写法 detail[r.code].length 在 v2 上得到 undefined（会把有明细的票显示成"无"）。
    const st = S.seatsOf(detail, r.code);
    return {
      ...r,
      lb: ztLb[r.code] ?? null,
      seat: (st.b.length + st.s.length) || null,
      net_buy_wan: r.net_buy_wan ?? null,
    };
  });
}

function renderHotTable() {
  const cols = HOT_COLS[HOT_STATE.view] || HOT_COLS.hot;
  const all = hotRows();
  const q = HOT_STATE.q.trim().toLowerCase();
  let rows = q
    ? all.filter((r) => [r.code, r.name, r.reason, r.close].some((x) => String(x ?? '').toLowerCase().includes(q)))
    : all;

  // 排序：显式点列头优先；未点过时用视图默认（强势股按涨幅、资金榜按净买额降序）
  const key = HOT_STATE.key || (HOT_STATE.view === 'lhb' ? 'net_buy_wan' : 'change_pct');
  const col = cols.find((c) => c.key === key);
  // 取值必须「按列」进行：此前这里闭包捕获了当前排序列 col，导致所有无 cell 的列
  // 都渲染成排序列的值（截图核对时发现：按涨幅排序时，代码/现价/换手列全是 20.01）。
  const rawOf = (c, r) => (c && c.raw ? c.raw(r) : c ? r[c.key] : r[key]);
  rows = rows.slice().sort((a, b) => {
    const x = rawOf(col, a), y = rawOf(col, b);
    const xs = (x == null || !Number.isFinite(+x)) ? -Infinity : +x;
    const ys = (y == null || !Number.isFinite(+y)) ? -Infinity : +y;
    if (xs === ys) return 0;
    return (xs < ys ? 1 : -1) * (HOT_STATE.dir < 0 ? 1 : -1);
  });

  $('hotHead').innerHTML = cols.map((c) => {
    const on = key === c.key;
    return `<th class="sortable${c.num ? ' num' : ''}" data-sort="${c.key}" title="${esc(c.hint || '点击按此列排序')}">`
      + `${esc(c.t)}${on ? `<span class="dir">${HOT_STATE.dir < 0 ? '▼' : '▲'}</span>` : ''}</th>`;
  }).join('');

  // 窄屏排序控件与表头同步（同一 HOT_STATE，两处都可改）。
  // 只在「列集合」变化时重建选项，避免每次渲染重置元素、打断用户正在操作的下拉框。
  const sel = $('hotSortSel');
  if (sel) {
    const wantKeys = cols.map((c) => c.key).join(',');
    if (sel.dataset.keys !== wantKeys) {
      sel.innerHTML = cols.map((c) => `<option value="${esc(c.key)}">`
        + `按${esc(String(c.t).replace(/（[^）]*）/g, ''))}排序</option>`).join('');
      sel.dataset.keys = wantKeys;
    }
    sel.value = key;
  }
  const dirBtn = $('hotSortDir');
  if (dirBtn) {
    const arrow = HOT_STATE.dir < 0 ? '▼' : '▲';
    if (dirBtn.textContent !== arrow) dirBtn.textContent = arrow;
    dirBtn.title = HOT_STATE.dir < 0 ? '当前降序，点击改升序' : '当前升序，点击改降序';
  }

  const tb = $('hotTable').querySelector('tbody');
  tb.innerHTML = '';
  if (!rows.length) {
    tb.innerHTML = `<tr><td colspan="${cols.length}" class="empty">没有匹配的个股，试试清空搜索框</td></tr>`;
  }
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.className = 'clickable';
    tr.dataset.act = 'stock';
    tr.dataset.code = r.code;
    tr.tabIndex = 0;
    tr.title = `点击查看 ${r.name || r.code} 的席位与资金详情`;
    tr.innerHTML = cols.map((c) => {
      const cls = `${c.num ? 'num' : ''}${c.wide ? ' muted' : ''}`.trim();
      const v = c.cell ? c.cell(r) : esc(nf(rawOf(c, r)));
      return `<td class="${cls}">${v}</td>`;
    }).join('');
    tb.appendChild(tr);
  }
  const cnt = $('hotCount');
  if (cnt) cnt.textContent = `显示 ${rows.length}/${all.length} 只${q ? '（已筛选）' : ''} · 点行或卡片看详情`;

  // 惰性字段提示：本表若引用了被剥离首屏的字段，且该字段尚未补齐，
  // 对应列会显示为 null（看起来像"这些票都没有"）。有则提示"未加载"，无则不显示。
  const lazyBox = $('hotLazyNote');
  if (lazyBox) {
    lazyBox.innerHTML = lazyNoticeHTML();
    lazyBox.hidden = !lazyBox.innerHTML;
  }

  // 窄屏卡片列表：与上表同源同序（CSS 决定何时显示哪一个，无需监听 resize）
  const cardBox = $('hotCards');
  if (cardBox) {
    cardBox.innerHTML = rows.length
      ? rows.map((r) => hotCardHTML(r, cols)).join('')
      : '<div class="empty">没有匹配的个股，试试清空搜索框</div>';
  }
}

function setHotView(v) {
  if (!HOT_COLS[v]) return;
  HOT_STATE = { ...HOT_STATE, view: v, key: null, dir: -1 };
  const tabs = $('hotTabs');
  if (tabs) {
    for (const b of tabs.querySelectorAll('button')) {
      const on = b.dataset.view === v;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    }
  }
  renderHotTable();
}

// ── V5.2 报告口径：阈值单一真相源 ──
// 报告结论不再用自算的五模块分套阈值，改为引擎口径的七因子情绪分（= archive.emotion.value，
// 与「策略回测」「主线自动选股」卡、scripts/backtest.mjs 同源）——否则同一交易日会出现
// 两个相反结论（实测：主体报告 83.8 →「过热」，引擎 76.8 →「满仓持有」）。
let BT = null;      // data/backtest.json 缓存，loadBacktest 成功后赋值
let lastArc = null; // 最近一次 archive.json：BT 就绪后用它重刷报告，让阈值/主线切到引擎口径

// 模板③规定的口径折叠件标题。放模块级是因为多个章节的 cal() 共用同一标题——
// 复制一份字符串迟早会漂移，导出层 src/report.js 的 CALIBER_SUMMARY 也是同一份约定。
const CAL_SUMMARY = '🔍 点击展开查看口径';
const TH_DEFAULT = { panic: 24, hi: 44, lo: 65, overheat: 80 };
// config.json 唯一事实源桥：index.html 的 config 桥模块脚本动态 import config.json 后挂
// window.ASENT_CONFIG；本文件是经典脚本拿不到 import，运行时从这里读。
// 兜底链：data/backtest.json 的 params → window.ASENT_CONFIG → TH_DEFAULT 手抄副本。
// TH_DEFAULT 仍保留（旧浏览器 import attributes 不可用时最后一道防线），
// 与 config.json 的一致性由 test/config.test.mjs 的防漂移断言守护。
function getThresholds() {
  const t = BT && BT.params && BT.params.thresholds;
  if (t && Number.isFinite(+t.overheat)) return t;
  // schemaVersion 2 起 config.json 顶层不再保留参数键，阈值唯一住所 = params.live.thresholds
  const c = window.ASENT_CONFIG && window.ASENT_CONFIG.params && window.ASENT_CONFIG.params.live
    && window.ASENT_CONFIG.params.live.thresholds;
  return (c && Number.isFinite(+c.overheat)) ? c : TH_DEFAULT;
}
// 仓位档位：严格对齐 src/backtest.js positions() 的**实际行为**（注意 hi 在引擎里是保留但
// 未参与判档的参数，24~65 同属半仓）：
//   score >= overheat → 过热（已持有保留上限仓位，空仓不新建）
//   score >= lo       → 满仓（受回撤动态降仓 cap 限制）
//   score >  panic    → 半仓
//   else              → 清仓
function posTier(score, t) {
  if (score == null || !Number.isFinite(+score)) return null;
  if (score >= t.overheat) return { key: 'overheat', label: '过热 · 只减仓不新建', pos: '不新建（已持有者保留）', note: '高位过热，兑现压力大于进攻价值，勿在新高追涨' };
  if (score >= t.lo) return { key: 'hold', label: '满仓持有', pos: '满仓（上限 100%）', note: '行情强势，主线清晰，适合做主线' };
  if (score > t.panic) return { key: 'half', label: '半仓', pos: '半仓（50%）', note: '震荡分歧，结构性行情，控仓操作' };
  return { key: 'clear', label: '清仓', pos: '清仓（0%）', note: '亏钱效应扩散或情绪冰点，空仓防御' };
}

// ── 研判报告：规则引擎，全部由当档数据推导，无手写文案 ──
// 新股/独立标的：上市首5日无涨跌幅限制（东财榜单诱因原话）
const isNewStock = (l) => (l.reasons || [l.reason || '']).some((r) => String(r).includes('无价格涨跌幅限制'));

// 锁仓/新进资金口径（规格阈值：新进占比 >70% 短线脉冲 / 50~70% 中等 / <50% 锁仓偏好强）
// 当日买方席位与近2日同票买方席位比对，未重复出现=新进；样本=有席位明细的连续上榜股
// 注：本口径**只用买方**——锁仓/新进问的是"买盘是不是老面孔"。明细已升级为买卖双侧（{b,s}），
// 故统一走 seatsOf 取 b，避免把 s（卖方）也当买盘统计进去而虚增样本。
function calcLockNew(days) {
  const S = seatsMod();
  const cur = days[days.length - 1]?.summary?.seats?.detail;
  const prevs = days.slice(-3, -1).map((d) => d.summary?.seats?.detail).filter(Boolean);
  if (!cur || !prevs.length) return null;
  const hist = {};
  for (const pd of prevs) for (const c of Object.keys(pd)) {
    const b = S.seatsOf(pd, c).b;
    if (!b.length) continue;
    if (!hist[c]) hist[c] = new Set();
    for (const [nm] of b) hist[c].add(nm);
  }
  let nb = 0, tb = 0, used = 0;
  for (const c of Object.keys(cur)) {
    if (!hist[c] || !hist[c].size) continue; // 无历史样本的票不计入
    const b = S.seatsOf(cur, c).b;
    if (!b.length) continue;
    used++;
    for (const [nm, buy] of b) { tb += buy; if (!hist[c].has(nm)) nb += buy; }
  }
  if (!tb || !used) return null;
  return { n: used, pct: Math.round(nb / tb * 1000) / 10, lockYi: Math.round((tb - nb) / 1e4 * 100) / 100, win: prevs.length };
}

// ── V5.0 五模块分解分（规格：情绪25%/盈亏25%/广度20%/题材20%/主线板块内部结构10%，0~100，分数越高市场越热越强）──
// 注意：这是 V5.0 的「结构解释分」，**不含资金面**，且自 V5.2 起已降级为因子分解、不参与档位判定。
// 它不是主分数——主分数是七因子情绪分（龙虎净额 s_net 权重 20%，见 src/config.js weights），
// 二者不可混为一谈：不能说「资金面不参与打分」，只能说「资金面不在这套五模块分解里」。
const clamp100 = (x) => Math.max(0, Math.min(100, Math.round(x)));
// 因子1 情绪定位：分值即热度（80~100高潮/60~79偏强/40~59中性/20~39偏弱/0~19冰点），历史分位极端在文字区提示，不改动分数
function scoreEmotion(v) { return v == null ? null : clamp100(Math.round(v)); }
// 盈亏效应：涨停多跌停少定基线，封板率/高标空间/梯队饱满度微调
// ⚠ 历史坑：第 3 参曾传 s.zbl_pct（存储值是封板率）却按「炸板率」阈值判分——80.5% 的封板率
//   会被 `zbl <= 20 ? 0 : -8` 判成 −8 分（实际应为优秀档 +6）。现改为直接传封板率并按封板率阈值判。
function scorePnl(zt, dt, sealPct, mlb, lb2n) {
  if (zt == null || dt == null) return null;
  let s = (zt >= 50 && dt <= 10) ? 88 : (zt >= 30 && dt <= 20) ? 72 : 50;
  if (sealPct != null) s += sealPct >= 90 ? 6 : sealPct >= 80 ? 0 : -8;
  if (mlb != null) s += mlb >= 6 ? 5 : mlb >= 3 ? 2 : -5;
  if (lb2n != null) s += lb2n >= 15 ? 4 : lb2n >= 8 ? 0 : -5;
  return clamp100(s);
}
// 广度量能：红盘占比定基线，行业扩散/成交额环比微调
function scoreBreadth(redPct, indPct, amtChg) {
  if (redPct == null) return null;
  let s = redPct >= 65 ? 85 : redPct >= 55 ? 72 : redPct >= 45 ? 60 : 45;
  if (indPct != null) s += indPct >= 70 ? 5 : indPct >= 50 ? 0 : -6;
  if (amtChg != null) s += amtChg >= 10 ? 5 : amtChg >= -10 ? 0 : -6;
  return clamp100(s);
}
// 题材结构：聚焦vs发散定基线，主线强度/存活率微调
function scoreTheme(contN, freshN, mainZt, surv) {
  if (!contN && !freshN) return null;
  let s = 70;
  if (contN > freshN * 1.5) s += 10; else if (freshN > contN) s -= 10;
  if (mainZt != null) s += mainZt >= 6 ? 8 : mainZt >= 3 ? 0 : -8;
  if (surv) s += surv.pct >= 50 ? 5 : surv.pct >= 30 ? 0 : -8;
  return clamp100(s);
}
// 因子5 主线板块内部结构：主线涨停梯队定基线，内部红盘率/龙头强度微调，涨幅离散度大=跟风分化扣分
// （规格采集指标中"板块成交额占比/板块内涨跌家数"暂无独立数据源，用热点榜主线成分票代理，口径见备注）
function scoreMainStructure(mainTheme, hot, mainZt) {
  if (!mainTheme || !Array.isArray(hot)) return null;
  const ms = hot.filter((h) => String(h.reason || '').includes(mainTheme));
  if (!ms.length) return null;
  const n = ms.length;
  const chgs = ms.map((h) => h.change_pct || 0);
  const red = chgs.filter((c) => c > 0).length / n;
  const top = Math.max(...chgs);
  const avg = chgs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(chgs.reduce((a, c) => a + (c - avg) * (c - avg), 0) / n);
  let s = mainZt >= 6 ? 80 : mainZt >= 3 ? 62 : 45;
  if (red >= 0.7) s += 8; else if (red < 0.5) s -= 8;
  if (top >= 9.9) s += 5; else if (top >= 5) s += 2; else s -= 5;
  if (sd > 6) s -= 4; else s += 2;
  return clamp100(s);
}

function buildBrief(days, arc) {
  const d = days[days.length - 1] || {};
  const p = days[days.length - 2] || {};
  const s = d.summary || {}, ps = p.summary || {};
  const e = d.emotion || {}, pe = p.emotion || {};
  const f = e.factors || e;
  const mom = arc.signals?.momentum || {};
  const last5 = days.slice(-5);
  // ── 公文体例：段（章节）渲染 ──
  // 序号由**版式层**统一生成（一、黑体），不在标题字符串里手写——见 REPORT_SPEC 注释。
  // 标题里历史残留的「① 情绪定位…」由导出层的 sectionTitle() 摘除，屏幕这里直接传纯标题。
  const seg = (h, b, sid) => `<div class="bf-sec" id="${sid}">`
    + `<div class="bf-h"><span class="bf-sec-no">${h.no}</span><span class="bf-sec-t">${h.text}</span></div>`
    + `<div class="bf-body">${b}</div></div>`;
  const li = (t) => `<div class="bf-li">${t}</div>`;
  // ── 模板③：章节口径折叠件 ──
  // 默认收起、只展示指标；口径原文一字不改地装进 .bf-cal-body，点开即见。
  // 用 <details>（原生折叠，无需脚本），导出文档与屏幕共用同一套标签语义。
  const cal = (t) => t ? `<details class="bf-caliber"><summary>${CAL_SUMMARY}</summary><div class="bf-cal-body">${t}</div></details>` : '';
  // ── 模板④：明日跟踪项复选框清单 ──
  // role/aria-checked **初始就要写死**，不能等用户点一下才补：屏幕上它从第一帧起
  // 就是一个"可勾选的复选框"，屏幕阅读器与审计闸门读的都是这个属性（缺了就不是复选框）。
  const todo = (t) => `<div class="bf-todo" role="checkbox" aria-checked="false" tabindex="0">${t}</div>`;
  // ── 模板④：三档配色标记（🔴风险 / 🟢积极 / ⚫中性）──
  // 屏幕侧用语义 class + emoji 双写：class 负责主题配色，emoji 保证导出任何形态都认得出。
  const ico = (kind, t) => `<span class="ico ico-${kind}">${{ risk: '🔴', pos: '🟢', neutral: '⚫' }[kind] || '⚫'} ${t}</span>`;
  const num = (v, fix = 1) => (v == null || !Number.isFinite(+v)) ? '—' : (+v).toFixed(fix);
  const arrow = (cur, pre) => (cur == null || pre == null) ? '' :
    (cur > pre ? `<span class="bf-up">↑${num(cur - pre)}</span>` : cur < pre ? `<span class="bf-dn">↓${num(pre - cur)}</span>` : '持平');

  // 数据落款（V5.2）：报告"每日随档生成"，必须说清是哪一档、数据新不新，
  // 状态口径与 src/freshness.js 三态一致（fresh / pending / behind）。
  const meta = arc.meta || {};
  const fresh = meta.freshness || {};
  const freshLabel = { fresh: '最新', pending: '待更新（未到发布时刻）', behind: '滞后' }[fresh.state]
    || (meta.stale ? '滞后' : '未判定');
  const dataDate = meta.tradeDate || d.trade_date || '—';
  const att = meta.lastAttempt || {};
  // 相位标注（盘中/开盘前）：报告必须自带时点说明，否则读者会把盘中实时涨跌家数
  // 与「按上一收盘日算的分位」对照，误判为「情绪分突然跳变」。
  const phaseTag = meta.phase === 'live' ? ' · 时点 <b>盘中</b>（实时快照，分位/因子为上一收盘日口径）'
    : meta.phase === 'pre' ? ' · 时点 <b>开盘前</b>（展示上一交易日收盘口径）' : '';
  const stamp = `<div class="bf-meta">数据日期 <b>${dataDate}</b> · 抓取状态 <b>${freshLabel}</b>`
    + (fresh.behindSessions ? `（落后 ${fresh.behindSessions} 个交易日）` : '')
    + phaseTag
    + (att.outcome === 'skipped' ? ' · 本次尝试跳过（当日数据未发布，属正常等待）' : '')
    + (att.outcome === 'failed' ? ` · 本次抓取失败：${att.reason || '原因未记录'}` : '')
    + ` · 样本 ${days.length} 个交易日 · 打分模型 ${(BT && BT.meta && BT.meta.formulaVersion) || meta.formulaVersion || '—'}</div>`;

  // 1. 情绪定位
  const v = e.value, pct = e.pct_rank;
  const delta = (v != null && pe.value != null) ? (v - pe.value) : null;
  const zone = v == null ? '' :
    v < 40 ? '冰点区' : v < 55 ? '偏冷区' : v < 70 ? '中性区' : v < 85 ? '偏热区' : '狂热区';
  let zoneNote = '';
  if (v != null && pct != null) {
    if (pct <= 10) zoneNote = '历史极端低位，统计上常见修复脉冲，但缩量阴跌需防钝化';
    else if (pct <= 30) zoneNote = '历史低位区，赔率占优、胜率一般，右侧确认前不抢跑';
    else if (pct >= 90) zoneNote = '历史极端高位，兑现压力大于进攻价值';
    else if (pct >= 70) zoneNote = '历史高位区，持仓友好但追高性价比下降';
    else zoneNote = '中位震荡区，结构机会为主';
  }
  const emo5 = last5.map((x) => x.emotion?.value).filter((x) => x != null);
  let dirTxt = '';
  if (emo5.length >= 3) {
    const last3 = emo5.slice(-3);
    const upN = last3.slice(1).filter((x, i) => x > last3[i]).length;
    const rebound = delta != null && delta > 0 && emo5.length >= 3 && last3[0] > last3[1];
    dirTxt = upN === 2 ? '近3日连升' : upN === 0 ? '近3日连降' + (rebound ? '后今日强力反弹' : '') : '近3日方向反复';
  }
  const sec1 = [
    li(`情绪 <b>${num(v)}</b>（历史分位 <b>${pct == null ? '—' : pct + '%'}</b>）${delta != null ? `，较昨日 <b>${delta >= 0 ? '+' : ''}${num(delta)}</b>` : ''}，落于<b>${zone}</b>。${dirTxt}`),
    zoneNote ? li(zoneNote) : '',
    e.missing && e.missing.length ? li(`<span class="bf-warn">⚠ 因子缺失：${e.missing.join('、')}，今日分可信度降权</span>`) : '',
  ].join('') + cal('情绪分为七因子加权合成（龙虎净额20%／涨跌家数10%／板块涨比20%／涨停强度10%／涨跌停对比15%／封板质量10%／量能15%），与页面情绪分、回测引擎同源；历史分位＝该分在样本窗口内的百分位排名。分区阈值：<40 冰点区／40~55 偏冷区／55~70 中性区／70~85 偏热区／≥85 狂热区。');

  // 2. 资金（龙虎榜）
  // 近5日净买序列：必须与净买率同口径（当日榜）。此处原取全量口径，
  // 导致同一句话里「净买率 5.7%」是当日榜、而紧挨着的「近3日滚动净买」是全量，读者会当成同一口径。
  const nets = last5.map((x) => x.summary?.lhb_daily_net).filter((x) => x != null);
  const netTxt = nets.length ? nets.map((x) => (x > 0 ? `<span class="bf-up">+${num(x)}</span>` : `<span class="bf-dn">${num(x)}</span>`)).join(' → ') : '—';
  let netVerdict = '';
  if (nets.length >= 2) {
    const cur = nets[nets.length - 1], pre = nets[nets.length - 2];
    if (cur > 0 && pre <= 0) netVerdict = '净买 5 日来首次转正，游资回补信号';
    else if (cur < 0 && pre >= 0) netVerdict = '净买转负，短线资金撤退';
    else if (cur > 0) netVerdict = '净买连续为正，进攻意愿延续';
    else netVerdict = '净买连续为负，观望/出货氛围';
  }
  const topBuy = (d.lhb_aggr || []).filter((l) => l.net_buy_wan > 0).slice(0, 3)
    .map((l) => `${l.name} +${num(l.net_buy_wan / 1e4, 2)}亿${isNewStock(l) ? '<span class="bf-warn">（独立新股，非主线）</span>' : ''}`);
  // 体量/净买率：分子分母必须同源。东财龙虎榜原始记录混装两类榜单——当日榜（席位买卖即当日口径）
  // 与"连续N个交易日区间累计榜"（字段是区间累计值，且 BUY_AMT 被填成区间累计成交额）。
  // 两者不加区分地相加，曾把 2026-09-30 的上榜总成交算成 511 亿（当日榜去重后真实仅 136.5 亿），
  // 净买率被稀释成 2.4%，定性从"中等力度"错判成"脉冲级、可信度低"。故统一取当日榜口径。
  const curNet = nets[nets.length - 1];
  const dAmt = s.lhb_daily_amt, dNet = s.lhb_daily_net;
  const nbRate = (dAmt > 0 && dNet != null) ? dNet / dAmt * 100 : null;
  let rateTxt = '';
  if (nbRate != null) {
    const ab = Math.abs(nbRate);
    rateTxt = ab >= 8 ? '强进攻' : ab >= 4 ? '中等力度' : '脉冲级，可信度低';
  }
  // 3日滚动净额（与5日并行，抓资金转向拐点）
  const roll3Sum = nets.slice(-3).reduce((a, b) => a + b, 0);
  // 新股/独立标的识别与扰动（诱因=无价格涨跌幅限制，上市 5 日内）
  //
  // ⚠ 口径已上收到引擎：引擎（src/lhb.js → src/sentiment.js）在打分时就自动剔除了新股，
  //   本处只做**展示与告警**，不再自行现算。原因：报告端原先从 d.lhb_aggr（全量数组）过滤，
  //   而 lhb_daily_aggr 明细在部分历史天为空，一旦回退拼接就会把区间累计榜混进来
  //   （与「511 亿事件」同一个坑）。统一读引擎写出的字段，杜绝两套口径。
  //   相关字段：summary.lhb_new_net（新股净买）/ lhb_new_ratio（占比）/ lhb_daily_ex_new_net（剔后净买）
  //             emotion.newStock（{netRaw, netExNew, newStockNet, newStockRatio, adjusted, disturbed}）
  const nsMeta = (e && e.newStock) || {};
  const newStocks = Array.isArray(s.lhb_new_stocks) ? s.lhb_new_stocks : [];
  const totNetDaily = s.lhb_daily_net ?? null;   // 当日榜净买（权威口径，含新股）
  const newNet = s.lhb_new_net ?? (nsMeta.newStockNet ?? 0);
  const mainNet = s.lhb_daily_ex_new_net ?? (totNetDaily != null ? totNetDaily - newNet : null);
  const disturb = nsMeta.disturbed ?? (s.lhb_new_ratio != null ? s.lhb_new_ratio > 0.25 : false);
  // 资金-行情背离校验（有背离才写）
  const divs = [];
  if (curNet > 0 && s.amount_yi != null && ps.amount_yi != null && s.amount_yi < ps.amount_yi * 0.92) divs.push('两市缩量下净流入——资金集中抱团，扩散不足');
  if (curNet > 0 && s.up_count != null && s.down_count != null && s.up_count < s.down_count) divs.push('净流入但红盘家数占少数——指数层面承接偏弱');
  if (curNet > 0 && s.ind_up != null && s.ind_count && s.ind_up / s.ind_count < 0.4) divs.push('净流入但行业红盘不足四成——个股分化明显');
  // 席位级拆分（东财席位明细）：资金属性/买方集中度/对手盘结构
  const seats = s.seats;
  let seatLines = '';
  if (seats && seats.cover) {
    const dirTxt2 = (v) => v > 0 ? '净买 +' + num(v, 2) : v < 0 ? '净卖 ' + num(v, 2) : '持平';
    const instN = seats.inst_buy - seats.inst_sell, northN = seats.north_buy - seats.north_sell, hotN = seats.hot_buy - seats.hot_sell;
    // 市场级买方头部3席位集中度（规格：>50% 高度集中 / 30~50% 中等 / <30% 分散）
    const b3 = seats.buy_top3_pct;
    const b3Txt = b3 != null ? `；买方头部3席位集中度 <b>${b3}%</b>（${b3 > 50 ? '高度集中——爆发力强，一日游风险高' : b3 >= 30 ? '中等' : '分散——持续性更好'}）` : '';
    const conc = (seats.conc_top || []).length ? `；个股买方前三集中度TOP: ${seats.conc_top.map((c) => `${c[0]} ${c[1]}%`).join('、')}` : '';
    const totSell = seats.hot_sell + seats.inst_sell + seats.north_sell;
    let opp = '';
    if (totSell > 0) {
      const parts = [['游资', seats.hot_sell], ['机构', seats.inst_sell], ['北向', seats.north_sell]].sort((a, b) => b[1] - a[1]);
      opp = `；对手盘: 卖方以${parts[0][0]}为主（游资 ${num(seats.hot_sell, 1)} / 机构 ${num(seats.inst_sell, 1)} / 北向 ${num(seats.north_sell, 1)} 亿）`;
      // 抛压预警（规格：机构+北向合计净卖出 >5亿 = 高抛压预警）
      const instNorthNet = instN + northN;
      if (instNorthNet < -5) opp += ` <span class="bf-warn">⚠ 机构+北向合计净卖 ${num(-instNorthNet, 2)} 亿，高抛压预警</span>`;
      else opp += `；对手盘分歧中等，无大规模机构砸盘`;
    }
    const seatN = seats.universe_n != null ? seats.universe_n : (seats.detail ? Object.keys(seats.detail).length : '—');
    seatLines = li(`席位拆分: 机构${dirTxt2(instN)} / 北向${dirTxt2(northN)} / 游资${dirTxt2(hotN)} 亿（席位覆盖 ${seats.cover}%）${b3Txt}${conc}${opp}`)
      + li(`　<span class="muted">口径：上述分项为<b>逐只上榜股买卖双侧席位明细的加总</b>，样本 ${seatN} 只（＝有席位明细的全部上榜个股，含区间累计榜个股）；与「当日榜 ${s.lhb_daily_stocks ?? '—'} 只」不是同一集合，故分项之和 ≠ 当日榜净买，两者不可互相校验。分项为<b>成交额</b>口径（买卖各自加总），净额=买−卖。此处为「榜上席位」口径，覆盖不足 100% 时拆分为部分样本。</span>`);
  }
  // 锁仓/新进资金占比 + 主线题材龙虎资金占比（规格阈值）
  const lock = calcLockNew(days);
  const lockLine = lock ? li(`锁仓与资金留存（近${lock.win + 1}日连续上榜样本 ${lock.n} 只）: 锁仓金额 ${num(lock.lockYi, 2)} 亿，新进资金占当日买入 <b>${lock.pct}%</b>——${lock.pct > 70 ? '短线脉冲，兑现风险高' : lock.pct >= 50 ? '中等' : '锁仓偏好强，持续性更好'}`)
    + li(`　<span class="muted">口径：对每只连续上榜股，把当日买方席位与近2日同票买方席位做<b>名称比对</b>，未重复出现的席位计为「新进」；新进占比=新进买方买入额 ÷ 当日买方买入额，只用买方。样本为有席位明细的 ${lock.n} 只，非全市场。可逐只跨日比对复核，但依赖席位披露完整度。</span>`) : '';
  const mt = s.main_theme;
  const mtLine = (mt && mt.tot_yi > 0 && mt.pct != null) ? li(`资金-题材联动: 主线题材（${mt.name}）龙虎净买 ${mt.main_yi >= 0 ? '+' : ''}${num(mt.main_yi, 2)} 亿，占全部龙虎净买 <b>${mt.pct}%</b>——${mt.pct >= 60 ? '资金聚焦主线' : mt.pct >= 40 ? '资金分化' : '资金散乱，主线弱化'}`) : '';
  const sec2 = [
    li(`近5日当日龙虎净买（亿）: ${netTxt}`),
    dAmt > 0 ? li(`上榜总成交 ${num(dAmt, 0)} 亿（当日榜 ${nf(s.lhb_daily_stocks)} 只，净买 ${nf(s.lhb_daily_net)} 亿；分子分母同源），净买率 <b>${num(nbRate, 1)}%</b>（${rateTxt}）；近3日滚动净买 ${roll3Sum >= 0 ? '+' : ''}${num(roll3Sum)} 亿`) : '',
    s.lhb_range_count > 0 ? li(`<span class="muted">口径说明：另有 ${s.lhb_range_count} 条「连续 N 个交易日累计」榜记录，其买卖额与净额都是区间累计值（非当日），已单列——不计入上方总成交与净买率，也不计入情绪因子 s_net、近5日净额序列与新股扰动占比（全站日度口径只有「当日榜」一个来源）。</span>`) : '',
    netVerdict ? li(netVerdict + `（结构 ${s.net_pos ?? '—'} 买 / ${s.net_neg ?? '—'} 卖）`) : '',
    (newStocks.length && totNetDaily != null && totNetDaily > 0) ? li(`新股/独立标的（${newStocks.map((l) => l.name).join('、')}）净买 +${num(newNet, 2)} 亿，占当日龙虎净买 <b>${(newNet / totNetDaily * 100).toFixed(0)}%</b>${disturb ? '，<span class="bf-warn">超 25% 扰动线</span>' : ''}；剔除后主线净买 ${mainNet >= 0 ? '+' : ''}${num(mainNet, 2)} 亿`) : '',
    (nsMeta.adjusted && totNetDaily != null) ? (() => {
      // ⚠ 因子分一律从引擎结果读（nsMeta.factorRaw / factorUsed），**不得在此重写公式**。
      //   历史教训：这里曾硬编码 Math.tanh(nb/5)*50+50，那是 s_net 的第二套口径实现；
      //   一旦归一方式变更（如切到 v5.3 的分位映射），本行会继续显示 tanh 的值，
      //   与页面顶部的真实情绪分不符，而且**不会报错**——是最难发现的一类漂移。
      //   引擎已在 emotion.newStock 里同时产出两套分数（见 src/sentiment.js）。
      const fRaw = nsMeta.factorRaw != null ? numS(nsMeta.factorRaw, 1) : '—';
      const fUsed = nsMeta.factorUsed != null ? numS(nsMeta.factorUsed, 1) : '—';
      // 兜底：老存档没有 factorRaw/factorUsed 字段时，退化为只报净买额，不擅自补算分数。
      const scoreTxt = (nsMeta.factorRaw != null && nsMeta.factorUsed != null)
        ? `，因子分 ${fRaw} → <b>${fUsed}</b>`
        : '（旧存档未记录修正前后因子分，仅列净买额）';
      return li(`<span class="muted">✅ 引擎已自动修正：情绪因子 s_net 入参已剔除新股（净买 ${num(totNetDaily, 2)} → <b>${num(nsMeta.netExNew, 2)}</b> 亿）${scoreTxt}${nsMeta.disturbed ? '，已触发 25% 扰动熔断' : ''}。本页情绪分与仓位档位即为修正后结果，无需人工二次剔除。</span>`);
    })() : '',
    topBuy.length ? li('净买头部: ' + topBuy.join('、')) : '',
    seatLines,
    lockLine,
    mtLine,
    divs.length ? li(`<span class="bf-warn">背离校验：${divs.join('；')}</span>`) : '',
  ].join('') + cal('<b>席位分项（机构/北向/游资买卖总额）与锁仓统计覆盖的是「当日有席位明细的全部上榜个股」</b>，其只数多于「当日榜」家数（区间累计榜个股当日无独立榜、但其席位明细仍在披露名单内），故席位分项之和与「当日榜净买」不必相等，<b>二者不可相互校验</b>。上榜总成交、净买率、日度因子 s_net、近5日净额序列、新股扰动占比、主线题材资金占比全部只取「当日榜」口径（剔除「连续 N 个交易日累计」类区间榜——其买卖额与净额都是区间累计值，混入会把总成交放大数倍、净买率稀释至失真，并让日度因子把三天累计当成一天），分子分母一律同源；全量口径（含区间累计榜）仅在「完整参数」中单列作诊断，禁止与当日值混用。新股/独立标的＝上市首 5 日无涨跌幅限制个股，其净买单独列示不计入主线；买方头部 3 席位集中度＝全市场前 3 席位买入 ÷ 全部买方买入（分子分母均已剔除「自然人/中小投资者/机构/其他自然人」这类投资者结构汇总行——它们非席位，混入会虚增买方总额并稀释集中度）；锁仓统计＝当日买方席位与近 2 日同票买方席位比对，未重复出现计为新进，样本为有席位明细的连续上榜股；主线题材龙虎资金占比＝主线题材个股当日榜净买 ÷ 当日榜全榜净买。席位数据来自东财买卖榜明细（榜上席位口径），覆盖不足 100% 时拆分为部分样本。');

  // 3. 盈亏效应（涨跌停结构）——规格阈值：涨停≥50&跌停≤10强/30~49&11~20中等/<30或>20偏弱；封板率≥90优秀/80~90中等/<80弱；高标≥6板空间打开/3~5中等/≤2压制；2板以上≥15饱满/8~14一般/<8断层
  const zt = s.zt_count, dt = s.dt_count, mlb = s.max_lb, lb2n = s.lb2_count;
  // 封板率/炸板率：新字段优先，旧存档回退到 zbl_pct（旧存档的 zbl_pct 存的是…见下）
  const sealPct = s.seal_pct != null ? s.seal_pct : s.zbl_pct;
  const zbPct = s.zb_pct != null ? s.zb_pct : (sealPct != null ? Math.round((100 - sealPct) * 10) / 10 : null);
  const deden = s.seal_den != null ? s.seal_den : ((s.zt_count != null && s.zb_count != null) ? s.zt_count + s.zb_count : null);
  // 连板天梯：把 zt_lb（代码→连板数）按板数归组，让「最高板数 / 二板以上只数」可逐只核对。
  // 数字一律现算，不写死任何具体板数或只数（口径守卫会拦硬编码）。
  //
  // 模板②要求「连板天梯用表格」——故这里产出真 <table class="bf-table">，
  // 而不是把结构摊平成一串竖线分隔的长文本（长文本既难扫读，导出后也无法逐列对齐）。
  // 表头/行内容全部由上面的 buckets 现算而来，未引入任何新指标。
  const ladderTbl = (() => {
    const m = s.zt_lb;
    if (!m || typeof m !== 'object') return '';
    const buckets = {};
    for (const [code, n] of Object.entries(m)) {
      const v = Number(n);
      if (!Number.isFinite(v) || v < 2) continue;
      (buckets[v] = buckets[v] || []).push(code);
    }
    const keys = Object.keys(buckets).map(Number).sort((a, b) => b - a);
    if (!keys.length) return '';
    const rows = keys.map((k) => {
      const arr = buckets[k];
      const shown = arr.slice(0, 8).map((c) => {
        const hit = (d.lhb || []).find((x) => x.code === c) || (d.hot || []).find((x) => x.code === c);
        return hit && hit.name ? `${hit.name}(${c})` : c;
      });
      return `<tr><td>${k} 板</td><td>${arr.length} 只</td><td>${shown.join('、')}${arr.length > 8 ? ` 等 ${arr.length} 只` : ''}</td></tr>`;
    }).join('');
    const tot = keys.reduce((a, k) => a + buckets[k].length, 0);
    return `<table class="bf-table" data-caption="连板天梯（当日涨停股连板数映射 zt_lb，逐只可核）">`
      + `<thead><tr><th>板数</th><th>只数</th><th>个股</th></tr></thead>`
      + `<tbody>${rows}</tbody>`
      + `<tfoot><tr><td>合计</td><td>${tot} 只</td><td>2 板及以上梯队</td></tr></tfoot></table>`;
  })();
  let pnl = '';
  if (zt != null && dt != null) {
    if (zt >= 50 && dt <= 10) pnl = `涨停 ${zt} / 跌停 ${dt}，赚钱效应强`;
    else if (zt >= 30 && dt <= 20) pnl = `涨停 ${zt} / 跌停 ${dt}，赚钱效应中等`;
    else pnl = `涨停 ${zt} / 跌停 ${dt}，赚钱效应偏弱`;
  }
  const sec3 = [
    pnl ? li(pnl + `（昨日 ${ps.zt_count ?? '—'}/${ps.dt_count ?? '—'}）`) : '',
    sealPct != null ? li(`<b>封板率 ${sealPct}%</b>（收盘涨停 ${s.zt_count ?? '—'} ÷ 触板 ${deden ?? '—'}只，其中炸板 ${s.zb_count ?? '—'}只；炸板率 ${zbPct}%）。口径=盘中触及涨停的个股为分母，与各行情软件通用算法一致。${sealPct >= 90 ? '封板质量优秀' : sealPct >= 80 ? '封板质量中等' : '封板质量弱，接力意愿差'}`) : '',
    mlb != null ? li(`连板高标 ${mlb} 板${mlb >= 6 ? '，空间打开' : mlb >= 3 ? '，空间中等' : '，空间压制，情绪偏弱'}；2板以上 ${lb2n ?? '—'} 只${lb2n != null ? (lb2n >= 15 ? '，梯队饱满' : lb2n >= 8 ? '，梯队一般' : '，梯队断层') : ''}<span class="muted">（取自当日 ${s.zt_count ?? '—'} 只涨停股的连板数映射 zt_lb，逐只可核；连板天梯见下方）</span>`) : '',
    ladderTbl,
  ].join('') + cal('封板率＝收盘涨停 ÷ 盘中触板个股（＝涨停+炸板），与各行情软件通用算法一致；炸板率＝100−封板率，二者同一分母互补。连板高度/梯队取自当日涨停股的连板数映射（zt_lb），可与公开连板天梯逐只核对。阈值：涨停≥50 且跌停≤10 为强／30~49 且 11~20 为中等／其余偏弱；封板率≥90 优秀／80~90 中等／<80 弱；高标≥6 板空间打开／3~5 中等／≤2 压制；2 板以上≥15 饱满／8~14 一般／<8 断层。');

  // 4. 广度与量能——规格阈值：红盘占比≥65普涨/55~65结构性/45~55震荡分化/<45普跌；行业红盘≥70扩散好/50~70结构性/<50抱团；环比±10%放量/平稳/缩量；量能因子≥40高/20~40中/<20低
  const up = s.up_count, dn = s.down_count, amt = s.amount_yi, pamt = ps.amount_yi;
  const redPct = (up != null && dn != null && up + dn > 0) ? up / (up + dn) * 100 : null;
  const indPct = (s.ind_count && s.ind_up != null) ? s.ind_up / s.ind_count * 100 : null;
  const amtChg = (amt != null && pamt != null && pamt > 0) ? (amt - pamt) / pamt * 100 : null;

  // 板块相对强弱（超额进攻 / 超额防御）
  // ── 口径全在 src/relative.js，此处**只渲染不重算**（本项目铁律：规则唯一出处）。
  // 数据来自 summary.industry_relative；历史 208 天无行业明细 → 字段缺失 →
  // 必须显示「未计算」，绝不能渲染成 0：0 是"与基准完全同步"的确定结论，
  // 缺失是"不知道"，二者含义相反，混同就是编造数据。
  const REL = s.industry_relative;
  // ★ 返回的是「一行说明 + 两张并列的表」，不是一张表——原因见下方 col/tbl 注释。
  const relTbl = (() => {
    if (!REL) return li(`<span class="muted">板块相对强弱：未计算——该日无行业明细（历史回填天仅有情绪分，不含行业涨跌幅）。</span>`);
    const b = (REL.primary === 'median' ? REL.vsMedian : REL.vsIndex) || REL.vsMedian || REL.vsIndex;
    if (!b) return li(`<span class="muted">板块相对强弱：未计算——基准缺失。</span>`);
    const f2 = (v) => (v >= 0 ? '+' : '') + v.toFixed(2);
    // 报告内的涨跌配色一律用 bf-up / bf-dn（本项目已有类，红涨绿跌），
    // 不新造类名——新类名在导出/打印样式里不会有定义，会退化成无色。
    const cls = (v) => (v >= 0 ? 'bf-up' : 'bf-dn');
    const scls = (v) => (v > 0 ? 'bf-up' : v < 0 ? 'bf-dn' : 'muted');
    const rowsOf = (rows, label) => rows.map((r) => `<tr>`
      + `<td>${esc(r.name)}</td>`
      + `<td class="num ${scls(r.change_pct)}">${f2(r.change_pct)}%</td>`
      + `<td class="num ${cls(r.excess)}"><b>${f2(r.excess)}</b></td>`
      + `</tr>`).join('');
    // ★ 为什么是**两张表**而不是一张带双表头的表（这是一个真实 bug 的修复）：
    //   原先写成「一个 <table> 里放两组 <thead>+<tbody>」。这有两处坏：
    //   ① 一张表只允许一个 <thead>，第二个表头在真实浏览器里会被移位/丢弃 → 屏幕上看就"缺一块"；
    //   ② 导出层按「所有 thead th 拼成一个表头 + 所有 tbody tr 作为数据行」解析，
    //      于是得到"6 列表头 vs 3 单元格数据行"，而且解析器还会把它摊平成一行连续文字
    //      （因为表格被包在 .bf-li 里，见 report.js::extractLines 的说明）。
    //   拆成两张各自合法的表后，表头与数据行数一一对应，屏幕、导出、打印三处都正常。
    const tbl = (caption, headLabel, rows) =>
      `<table class="bf-table rel-table" data-caption="${esc(caption)}">`
      + `<thead><tr><th>${esc(headLabel)}</th><th>涨跌幅</th><th>超额</th></tr></thead>`
      + `<tbody>${rowsOf(rows)}</tbody></table>`;
    const baseCap = `板块相对强弱（基准 ${b.baseLabel} ${f2(b.basePct)}%）`;
    const degraded = REL.degraded
      ? `<span class="muted">（⚠ ${esc(REL.degradedReason)}，主榜已降级）</span>` : '';
    const head = li(`板块相对强弱（基准 <b>${esc(b.baseLabel)}</b> ${f2(b.basePct)}%）：`
      + `<b>超额进攻</b> ${esc(b.attack[0] ? b.attack[0].name : '—')} ${b.attack[0] ? f2(b.attack[0].excess) : ''}；`
      + `<b>超额防御</b> ${esc(b.defense[0] ? b.defense[0].name : '—')} ${b.defense[0] ? f2(b.defense[0].excess) : ''}`
      + `。行业红盘中位 ${f2(REL.medianPct)}%（${REL.upCount}/${REL.total} 个行业飘红）${degraded}`);
    // 两张表**裸传**（不经 li() 包裹）：导出层只把 .bf-body 的**直接子** .bf-table 认作表格，
    // 套一层 .bf-li 会让它退化成一条被摊平的纯文本（同 连板天梯 的做法，见 sec3 的 ladderTbl）。
    return head
      + tbl(`${baseCap} · 超额进攻（前 ${REL.topN}）`, `超额进攻（前 ${REL.topN}）`, b.attack)
      + tbl(`${baseCap} · 超额防御（后 ${REL.topN}）`, `超额防御（后 ${REL.topN}）`, b.defense);
  })();

  const sec4 = [
    redPct != null ? li(`涨跌家数 ${up} / ${dn}（沪深口径），红盘占比 ${redPct.toFixed(0)}%——${redPct >= 65 ? '普涨' : redPct >= 55 ? '结构性行情' : redPct >= 45 ? '震荡分化' : '普跌'}`) : '',
    indPct != null ? li(`行业红盘 ${s.ind_up ?? '—'}/${s.ind_count}（${indPct.toFixed(0)}%）——${indPct >= 70 ? '板块扩散良好' : indPct >= 50 ? '结构性扩散' : '抱团行情，扩散不足'}；最强 ${s.top_industry || '—'} / 最弱 ${s.bottom_industry || '—'}`) : '',
    amtChg != null ? li(`两市成交额 ${num(amt, 0)} 亿，环比 ${amtChg >= 0 ? '+' : ''}${amtChg.toFixed(1)}%${amt === pamt ? '' : `（${amt >= pamt ? '放量' : '缩量'} ${num(Math.abs(amt - pamt), 0)} 亿）`}——${amtChg >= 10 ? '放量' : amtChg <= -10 ? '缩量' : '量能平稳'}；量能因子 ${f.s_amt ?? '—'}（${f.s_amt >= 40 ? '高量能' : f.s_amt >= 20 ? '中等量能' : '低量能'}）`) : '',
    relTbl,
  ].join('') + cal('涨跌家数为沪深两市口径（不含北交所）；红盘占比＝上涨家数 ÷（上涨+下跌）。阈值：红盘占比≥65 普涨／55~65 结构性／45~55 震荡分化／<45 普跌；行业红盘≥70 扩散良好／50~70 结构性扩散／<50 抱团；成交额环比 ±10% 为放量/缩量的分界（区间内视为平稳）。'
    + '<br><b>板块相对强弱口径</b>：超额 ＝ 行业当日涨跌幅 − 基准当日涨跌幅，基准取<b>同日同源</b>（上证指数取当日收盘涨跌幅，行业中位数取同日全部行业涨跌幅的中位数）。排序键是<b>超额</b>而非绝对涨幅——普跌日里"跌得最少"的才是最强，按绝对涨幅排会让普跌日的进攻榜全是负数、含义混乱。两基准并存的原因：vs 上证回答"跑赢大盘了吗"（体感最贴近持仓），但上证含大量低波权重股，题材行情里它常躺平，会让几乎所有题材行业显示正超额；vs 行业中位数回答"在板块里排前还是排后"（中位数基准下攻防榜天然均衡，必有强弱）。报告主榜优先取上证，上证缺失时降级为中位数并显式标注。'
    + '<br>行业数不足 30 个（残缺列表）或无行业明细时返回「未计算」——不用可疑数据凑一个榜。历史回填天（共 208 天）无行业明细，其超额榜一律显示「未计算」，与 0 严格区分（0＝与基准完全同步，是确定结论；未计算＝不知道）。');

  // 5. 题材结构——规格阈值：主线涨停≥6强/3~5中等/<3弱化；昨日新晋存活率≥50%延续性强/30~50中等/<30一日游
  const freshN = (mom.fresh || []).length, contN = (mom.continuing || []).length, fadeN = (mom.fading || []).length;
  const th = d.themes || {};
  const topTheme = Object.entries(th).sort((a, b) => b[1] - a[1])[0];
  const mainZt = topTheme ? topTheme[1] : null;
  // 主线强度分/密集度：与引擎 selectMainLine 同式（强度分 = 涨停家数 × 密集度），
  // 让报告 §5 与「主线自动选股」卡说同一件事，而不是各报一个数。
  const themeTotal = Object.values(th).reduce((a, b) => a + b, 0) || 1;
  const mainDensity = topTheme ? topTheme[1] / themeTotal : null;
  const mainScore = topTheme ? Math.round(topTheme[1] * mainDensity * 100) / 100 : null;
  let focus = '';
  if (contN && freshN) focus = contN > freshN * 1.5 ? '延续远多于新晋——资金聚焦而非轮动，题材成色足' :
    freshN > contN ? '新晋多于延续——题材轮动发散，追首板胜率低' : '新晋延续均衡——题材消化中';
  // 昨日新晋题材存活率（题材口径）
  // 正确口径：分子分母都必须来自「昨日视角的新晋名单」（signals.momentum.prev_fresh，引擎用切的
  // byDay 重算的昨日 fresh），再看这些题材**今日是否仍存在**。
  // 历史 bug：早先用「今日 fresh 名单」去比「昨日 themes 是否存在」——语义变成「今日新晋在昨日
  // 是否已存在」，而新晋的定义就是昨日不存在，二者自相矛盾，得数恒为一个不小的小数
  // （2026-09-30 实测 9/17=53%，看似合理其实无意义）。见 scripts/audit_lhb_caliber.mjs 守卫。
  const surv = (() => {
    const yf = (mom.prev_fresh || []).map((t) => (typeof t === 'string' ? t : t.theme)).filter(Boolean);
    if (!yf.length) return null;
    // 「今日仍存在」= 出现在今日 themes 覆盖表里（与 momentum 的存在性判据同源）
    const th = d.themes || {};
    const alive = yf.filter((t) => (th[t] || 0) > 0);
    return { n: yf.length, alive: alive.length, pct: Math.round(alive.length / yf.length * 100) };
  })();
  const sec5 = [
    li(`新晋 ${freshN} / 延续 ${contN} / 退潮 ${fadeN}。<span class="muted">（引擎自定义标签：题材在近5日窗口内覆盖个股数≥2 视为「存在」，与前一5日窗口比对定新晋/延续/退潮；交易所无官方题材标准，平台间题材划分不同会改变此三数）</span>${focus}`),
    topTheme ? li(`今日最强题材: ${topTheme[0]}（${mainZt} 只涨停）——题材涨停强度${mainZt >= 6 ? '强势' : mainZt >= 3 ? '中等' : '弱化'}<span class="muted">（归属为引擎自动归类，需人工核对当日涨停股，无官方唯一标准。此处只述当日题材涨停强度的相对水平；是否列为「主线」由「主线自动选股」卡的动态阈值单独判定——两判据口径不同：最强题材可以不达主线阈值（如 10-08 新能源 8 只 < 阈值 10.7 只），不构成矛盾）</span>`) : '',
    (topTheme && mainDensity != null) ? li(`主线强度分 <b>${mainScore}</b>（涨停 ${mainZt} × 密集度 ${(mainDensity * 100).toFixed(1)}%，与引擎 selectMainLine 同式）——标的清单见「主线自动选股」卡`) : '',
    surv ? li(`昨日新晋题材存活 ${surv.alive}/${surv.n}（${surv.pct}%）——${surv.pct >= 50 ? '题材延续性强' : surv.pct >= 30 ? '延续性中等' : '题材一日游风险高'}<span class="muted">（分子＝昨日新晋名单，分母＝该名单今日仍在题材覆盖表内的只数；两侧同一动量口径，可逐题材核对）</span>`) : '',
  ].join('') + cal('<b>题材标签（新晋/延续/退潮、主线归属、涨停题材归类）为引擎自定义分类，沪深交易所无官方题材标准</b>，标签由「近 5 日窗口内覆盖个股数≥2」的存在性比对自动生成，不同平台的题材划分会影响该口径下的数字，仅供参考。主线强度分＝涨停家数 × 密集度（该题材涨停数 ÷ 当日全题材涨停数），与引擎 selectMainLine 同式。昨日新晋题材存活率＝昨日视角新晋名单（引擎用截至昨日数据重算动量所得）中今日仍存在的只数 ÷ 该名单只数，两侧同一口径；阈值：≥50% 延续性强／30~50% 中等／<30% 一日游风险高。');

  // 6. 综合研判（规则表决）
  const ev = [];
  if (v != null && pct != null) {
    if (v >= 70 && pct >= 70) ev.push('情绪与分位双高');
    else if (v <= 35 && pct <= 30) ev.push('情绪分位双冰');
    else if (delta != null) ev.push(delta >= 0 ? '情绪修复' : '情绪走弱');
  }
  const netsC = nets;
  if (netsC.length >= 2) ev.push(netsC[netsC.length - 1] > 0 ? '龙虎榜资金进场' : '龙虎榜资金离场');
  if (zt != null && dt != null) ev.push(dt > zt ? '亏钱效应' : '赚钱效应');
  if (fadeN > freshN * 1.5) ev.push('题材退潮主导');
  else if (contN > freshN * 1.5 && freshN > 0) ev.push('主线聚焦');
  let verdict = '中性震荡，控制仓位做结构。';
  if (ev.includes('情绪与分位双高') && ev.includes('龙虎榜资金进场')) verdict = '情绪与分位双高 + 资金进场共振，但分位已处高位，追高性价比下降，持仓者让利润奔跑、空仓者等分歧低吸。';
  else if (ev.includes('情绪与分位双高')) verdict = '情绪与分位双高，兑现压力大于进攻价值，勿在新高追涨。';
  else if (ev.includes('情绪分位双冰')) verdict = ev.includes('龙虎榜资金进场') ? '冰点 + 资金试探进场，修复脉冲概率上升，轻仓试错、止损要快。' : '冰点区无资金承接，空仓等右侧，接飞刀是找死。';
  else if (ev.includes('情绪修复') && ev.includes('龙虎榜资金进场') && ev.includes('赚钱效应')) verdict = '修复三要素齐（情绪回升+资金进场+赚钱效应），可逐步转进攻，主线优先。';
  else if (ev.includes('情绪走弱') && ev.includes('龙虎榜资金离场')) verdict = '情绪资金双弱，退潮期防守为主，新题材一律当反弹看。';

  // 明日观测（规格六：九条触发规则，触发才输出，非固定列表）
  const watch = [];
  if (v != null && v >= 70) watch.push('跌停若回升超 40 则退潮未尽'); // 1.情绪偏热/狂热触发
  if (disturb) watch.push(`主线剔除新股后的净买（今日 ${mainNet >= 0 ? '+' : ''}${num(mainNet, 2)} 亿）能否守住正轴（0 亿上方）`); // 2.新股扰动触发
  if (mlb != null && mlb >= 6) watch.push(`${mlb} 板高标能否晋级（断板无替补 = 空间坍塌）`); // 3.6板及以上高标触发
  if (surv && surv.pct < 50) watch.push(`今日 ${freshN} 个新晋题材明日存活率（≥50% = 聚焦，<30% = 一日游）`); // 4.昨日存活率<50%触发
  if (nbRate != null && nbRate >= 4 && nbRate < 8) watch.push(`龙虎榜净买率是否维持在 4% 以上（今日 ${num(nbRate, 1)}%），买方集中度是否出现极端抬升`); // 5.净买率4~8%中等区间触发
  if (seats && seats.cover && (seats.inst_sell > 0 || seats.north_sell > 0)) watch.push('卖方是否出现机构/北向集中大额砸盘（合计净卖 >5 亿为预警线）'); // 6.机构/北向有卖出触发
  if (divs.some((x) => x.includes('缩量'))) watch.push('缩量背离是否修复：主线板块成交额能否扩容'); // 7.抱团缩量背离触发
  if (lock && lock.pct > 50) watch.push(`头部标的资金留存: 新进资金（今日占比 ${lock.pct}%）是否大规模兑现`); // 8.新进占比>50%触发
  if (mt && mt.pct != null && mt.pct >= 60) watch.push(`主线题材龙虎资金占比是否维持在 60% 以上（今日 ${mt.pct}%）`); // 9.主线占比≥60%触发

  // V5.0 五模块分解分（结构性解释用；**不含资金面**，不参与档位判定）。
  // 真正的档位由下方 mainScoreV（七因子情绪分，含龙虎净额 20%）决定——别把「五模块不含资金面」
  // 说成「资金面不参与打分」。
  const scE = scoreEmotion(v);
  const scP = scorePnl(zt, dt, sealPct, mlb, s.lb2_count);
  const scB = scoreBreadth(redPct, indPct, amtChg);
  const scT = scoreTheme(contN, freshN, mainZt, surv);
  const scM = scoreMainStructure(topTheme ? topTheme[0] : null, d.hot || [], mainZt);
  const mods = [['情绪定位', 25, scE], ['盈亏效应', 25, scP], ['广度量能', 20, scB], ['题材结构', 20, scT], ['主线结构', 10, scM]].filter((m) => m[2] != null);
  const wSum = mods.reduce((a, m) => a + m[1], 0);
  const total = wSum ? Math.round(mods.reduce((a, m) => a + m[1] * m[2], 0) / wSum * 10) / 10 : null;
  // V5.2：不再用 V5.0 的「极低风险/极高风险」五档措辞——它既与引擎语义相悖
  // （≥80 引擎是"过热只减不新建"，说成"极低风险"会被读成可加仓），分界值也与
  // 引擎阈值不一致（45/25 vs 44/24）。改由下方 posTier 按引擎阈值输出仓位档位。
  const weak = mods.filter((m) => m[2] < 60).map((m) => m[0]);
  // 注意措辞：这里说的是「这两类告警未单列进 V5.0 五模块分解分」，不是「资金面不参与打分」——
  // 龙虎净额 s_net 本身是 V5.2 主分数的 20% 权重项，写成整体否定会与权重直接矛盾。
  const auxWarn = (disturb || divs.length) ? '；资金面内部另有' + [disturb ? '新股扰动' : '', divs.length ? '量价背离' : ''].filter(Boolean).join('与') + '诊断告警（该告警不单列进上方五模块分解，但资金面主因子 s_net 已计入主分数）' : '';
  const riskHint = (weak.length ? `短板在${weak.join('与')}，注意对应风险` : '五模块均衡，无明显短板') + auxWarn;
  // 主结论走引擎口径：七因子情绪分（= 页面情绪分，与回测引擎同源）套 V5.2 阈值 → 可执行的仓位档位；
  // V5.0 五模块分降级为"因子分解"，只解释分位构成，不再作为结论依据（两套分套同一阈值会给出相反结论）。
  const thr = getThresholds();
  const mainScoreV = (e.value != null && Number.isFinite(+e.value)) ? +e.value : total;
  const tier = posTier(mainScoreV, thr);
  const v52p = (BT && BT.params && BT.params.v52) || {};
  const pctOf = (x, d) => (x == null || !Number.isFinite(+x)) ? '—' : (Math.abs(+x) * 100).toFixed(d) + '%';
  const bpOf = (x, dflt) => Math.round((x == null ? dflt : +x) * 1e4 * 10) / 10; // 小数 → ‱（万分之一），抹掉浮点尾差
  const tierLine = tier ? li(`<b>仓位档位（V5.2 引擎口径）</b>：七因子情绪分 <b>${num(mainScoreV)}</b>（与页面情绪分、回测引擎同源）→ <b>${tier.label}</b>，建议仓位 <b>${tier.pos}</b>。${tier.note}。<br><span class="muted">档位阈值：≥${num(thr.overheat, 0)} 过热只减仓不新建 / ≥${num(thr.lo, 0)} 满仓 / ${num(thr.panic, 0)}~${num(thr.lo, 0)} 半仓 / ≤${num(thr.panic, 0)} 清仓（收盘打分、T+1 生效）</span>`) : '';
  const decompLine = total != null ? li(`因子分解（V5.0 五模块，仅供结构解释，不参与档位判定）: 情绪定位 ${scE} · 盈亏效应 ${scP} · 广度量能 ${scB} · 题材结构 ${scT} · 主线结构 ${scM} → 复合 ${total}。<span class="bf-warn">${riskHint}</span>`) : '';
  const riskLine = li(`V5.2 实盘约束：单笔止损 <b>-${pctOf(v52p.stopLoss ?? -0.08, 0)}</b>（优先于信号）｜回撤 ≥<b>${pctOf(v52p.ddTrigger ?? -0.15, 0)}</b> 动态降仓至 40%（0.6 倍阈值处降至 70%）｜单日仓位变动 ≤<b>${num(v52p.maxPosChg ?? 0.2, 2)}</b>｜换仓成本 佣金 ${bpOf(v52p.comm, 0.0003)}‱（双边）+ 印花税 ${bpOf(v52p.stamp, 0.0005)}‱（卖出）+ 滑点 ${bpOf(v52p.slip, 0.0002)}‱，按仓位变动幅度计提`);
  // 模板④：风险提示带 ⚠（已有），并按三档配色标记给关键结论标注风险/积极/中性。
  // 档位语义直接来自引擎输出（tier），不额外自造判据：
  //   过热/清仓档 → 🔴 风险；满仓档 → 🟢 积极；半仓档 → ⚫ 中性。
  const tierKind = !tier ? 'neutral'
    : (mainScoreV >= thr.overheat || mainScoreV <= thr.panic) ? 'risk'
    : (mainScoreV >= thr.lo) ? 'pos' : 'neutral';
  const sec6 = li(`<b>${verdict}</b>`) + tierLine + decompLine + riskLine +
    (watch.length
      // 模板④：明日跟踪项用复选框清单（屏幕可勾选，刷新后重置——刻意不做持久化，
      // 跟踪项是"当日看盘清单"，隔日勾选残留会比没勾更误导）
      ? `<div class="bf-h2">明日跟踪项（引擎动态生成）</div>` + watch.map((w) => todo(w)).join('')
      : '')
    + li(ico(tierKind, tier ? `仓位档位 ${tier.label}（七因子情绪分 ${num(mainScoreV)}）` : '仓位档位待定'))
    + cal(`仓位档位采用 V5.2 引擎口径——主分数为七因子加权情绪分（龙虎净额 20%／涨跌家数 10%／板块涨比 20%／涨停强度 10%／涨跌停对比 15%／封板质量 10%／量能 15%，与页面情绪分、回测引擎同源），阈值 过热 ${num(thr.overheat, 0)}／满仓 ${num(thr.lo, 0)}／半仓 ${num(thr.panic, 0)}~${num(thr.lo, 0)}／清仓 ${num(thr.panic, 0)}，收盘打分、T+1 生效，并叠加止损 -8%、回撤 ≥15% 动态降仓、单日仓位变动 ≤20%、佣金万 3 + 印花税万 5 + 滑点万 2 的实盘约束。因子分解中的 V5.0 五模块分仅用于结构解释，不参与档位判定（该五模块口径<b>不含资金面</b>，切勿据此误判资金面在整体打分中的地位）；<b>资金面（龙虎榜净额）是 V5.2 主分数 s_net 的组成部分，权重 20%</b>，与 §② 的资金面观测同为一股数据、同一口径，二者不冲突。明日跟踪项由九条触发规则动态生成（触发才输出，非固定列表）。`);

  // 口径正文（**文字一字未改**，只是从"包在 .bf-foot 里的独立段落"改为"折叠附录的正文"）：
  //   · 屏幕：收进文末 <details class="bf-appendix" open> 折叠附录（模板③：文末独立折叠附录汇总全部口径）
  //   · 导出：同样渲染为 <details>（纯文本形态平铺 + [口径] 前缀）
  // 之所以摘掉外层 <div class="bf-foot">：它会被 parseReport 当成一个"独立段落"参与编号，
  // 而模板要求口径属附录、不占章节号。
  const footBody = `口径备注：涨跌家数为沪深两市（不含北交所）；<b>封板率</b>=收盘涨停 ÷ 盘中触板个股（＝涨停+炸板），与各行情软件通用算法一致；炸板率＝100−封板率，二者同一分母互补；<b>席位分项（机构/北向/游资买卖总额）与锁仓统计覆盖的是「当日有席位明细的全部上榜个股」</b>，其只数多于「当日榜」家数（区间累计榜个股当日无独立榜、但其席位明细仍在披露名单内），故席位分项之和与「当日榜净买」不必相等，二者不可相互校验；上榜总成交、净买率、日度因子 s_net、近5日净额序列、新股扰动占比、主线题材资金占比全部只取「当日榜」口径（剔除"连续N个交易日累计"类区间榜——其买卖额与净额都是区间累计值，混入会把总成交放大数倍、净买率稀释至失真，并让日度因子把三天累计当成一天），分子分母一律同源；全量口径（含区间累计榜）仅在「完整参数」中单列作诊断，禁止与当日值混用；新股/独立标的=上市首5日无涨跌幅限制个股，其净买单独列示不计入主线；买方头部3席位集中度=全市场前3席位买入÷全部买方买入（分子分母均已剔除「自然人/中小投资者/机构/其他自然人」这类投资者结构汇总行——它们非席位，混入会虚增买方总额并稀释集中度）；锁仓统计=当日买方席位与近2日同票买方席位比对，未重复出现计为新进，样本为有席位明细的连续上榜股；主线题材龙虎资金占比=主线题材个股当日榜净买÷当日榜全榜净买；主线强度分=涨停家数×密集度（该题材涨停数÷当日全题材涨停数），与引擎 selectMainLine 同式；昨日新晋题材存活率=昨日视角新晋名单（引擎用截至昨日数据重算动量所得）中今日仍存在的只数÷该名单只数，两侧同一口径；<b>题材标签（新晋/延续/退潮、主线归属、涨停题材归类）为引擎自定义分类，沪深交易所无官方题材标准，标签由「近N日覆盖个股数≥2」的存在性比对自动生成，不同平台的题材划分会影响该口径下的数字，仅供参考</b>；连板高度/梯队取自当日涨停股连板数映射（zt_lb），可与公开连板天梯逐只核对；仓位档位采用 V5.2 引擎口径——主分数为七因子加权情绪分（龙虎净额20%／涨跌家数10%／板块涨比20%／涨停强度10%／涨跌停对比15%／封板质量10%／量能15%，与页面情绪分、回测引擎同源），阈值 过热80／满仓65／半仓24~65／清仓24，收盘打分、T+1 生效，并叠加止损-8%、回撤≥15%动态降仓、单日仓位变动≤20%、佣金万3+印花税万5+滑点万2 的实盘约束；因子分解中的 V5.0 五模块分仅用于结构解释，不参与档位判定（该五模块口径**不含资金面**，切勿据此误判资金面在整体打分中的地位）；<b>资金面（龙虎榜净额）是 V5.2 主分数 s_net 的组成部分，权重 20%</b>，与 §② 的资金面观测同为一股数据、同一口径，二者不冲突。席位数据来自东财买卖榜明细（榜上席位口径），覆盖不足100%时拆分为部分样本。本报告由规则引擎根据当档数据自动生成，非投资建议。`;

  // ── 模板①：极简摘要（报告开头一句话核心）──
  // 组成（全部来自上面已经算好的结论变量，不新增任何指标/阈值）：
  //   ① 综合研判 verdict 首句（结论）
  //   ② 仓位档位 tier.label / tier.pos（可执行动作）
  //   ③ 情绪分 + 分区（定位）
  //   ④ 最强/最弱环节（风险方向，来自 weak 与 riskHint 的同一份判据）
  const abParts = [];
  abParts.push(String(verdict || '').split('，')[0].replace(/[。；]$/, ''));
  if (tier) abParts.push(`建议仓位 ${tier.pos}`);
  if (v != null) abParts.push(`情绪 ${num(v)} 落于${zone}`);
  if (weak.length) abParts.push(`${ico('risk', '短板')}在${weak.join('、')}`);
  else if (total != null) abParts.push(`${ico('pos', '五模块均衡')}`);
  const abstract = abParts.filter(Boolean).join('｜');
  const absBlock = `<div class="bf-abstract"><span class="bf-ab-tag">〔摘要〕</span><span class="bf-ab-text">${abstract}</span></div>`;

  // ── 数据可信度提示（#115）：紧随摘要，因为它是"这份结论能信多少"的前提 ──
  // 口径纪律：本块**只渲染** HEALTH（来自 signals-latest.json 的 health 段，由 src/health.js 算好）。
  //   报告不得自行判定健康等级——阈值只在 src/health.js 一处。
  const healthBlock = (() => {
    if (!HEALTH) return '';
    const cls = { ok: 'bf-hl-ok', warn: 'bf-hl-warn', fail: 'bf-hl-fail', unknown: 'bf-hl-unknown' }[HEALTH.level] || 'bf-hl-unknown';
    const items = (HEALTH.items || []).map((it) => {
      const rowTxt = it.rows
        ? '；' + it.rows.map((r) => {
          const rr = r.ratioRecent == null ? '—' : (r.ratioRecent * 100).toFixed(0) + '%';
          return `${r.label} 近${r.totalRecent}日 ${r.hasRecent}/${r.totalRecent}（${rr}）`;
        }).join('、')
        : '';
      return `<div class="bf-hl-item"><b>${esc(it.label)}</b>：${esc(it.detail)}${esc(rowTxt)}</div>`;
    }).join('');
    return `<div class="bf-health ${cls}">`
      + `<div class="bf-hl-head">〔数据可信度〕<b>${esc(HEALTH.label || HEALTH.level)}</b>——${esc(HEALTH.summary || '')}</div>`
      + items
      + `<div class="bf-hl-note">${esc(HEALTH.note || '')}</div>`
      + `</div>`;
  })();

  // 口径统一出口：模型/样本落款（历史上只存在于脚注里，模板②/③要求"每章节折叠口径 +
  // 文末独立折叠附录"，故把它作为共享段落到附录，**文字一字未改**）。
  const modelNote = `打分模型 ${(BT && BT.meta && BT.meta.formulaVersion) || meta.formulaVersion || '—'}；样本 ${days.length} 个交易日；数据日期 ${dataDate}，抓取状态 ${freshLabel}。`;

  // ── 模板③：文末独立折叠附录（汇总全部口径）──
  // 与各章节折叠件是**同一份口径文本**：章节处给"这一段怎么算"，附录给"全报告统一口径"。
  // 附录默认展开（它是给要核对口径的人用的，藏起来等于没有），章节折叠件默认收起。
  //
  // ★ modelNote 直接落成平铺段落，**不再套一层折叠件**（这是一个真实 bug 的修复）：
  //   旧写法是 cal(modelNote).replace(/<details class="bf-caliber">/, '<div class="bf-flat">')…
  //   ——它只换掉了外层 <details> 标签，却把里面的 <summary>🔍 点击展开查看口径</summary>
  //   留了下来。于是文末附录里凭空多出一句"点击展开查看口径"，而它后面根本没有可折叠的东西
  //   （外层已 open、且标签已被换成 div）。导出成文档后，这句"点击"就成了一句做不到的邀请。
  //   现在直接按附录正文的形态输出，结构与文案都对得上。
  const appendix = `<details class="bf-caliber bf-appendix" open><summary>📚 口径附录（全报告统一口径汇总）</summary><div class="bf-cal-body">`
    + footBody
    + `<div class="bf-flat">${modelNote}</div>`
    + `</div></details>`;

  // ── 公文体例：报头（简报名称 + 编号，编号居右）+ 主标题（2 号小标宋，居中） ──
  // 「简报名称」与「主标题」在公文里是两行不同性质的文字：
  //   名称＝文种标识（固定不变，作用等同于 logo）；主标题＝这一期讲什么。
  // 本报告的"这一期讲什么"就是数据日期，故主标题＝数据日期；不另编标题，免得与正文结论打架。
  const serial = RPT() && RPT().briefSerial
    ? RPT().briefSerial(dataDate, briefIssueNo()) : '';
  const head = `<div class="bf-head">`
    + (serial ? `<div class="bf-serial">${serial}</div>` : '')
    + `<div class="bf-masthead">${(RPT() && RPT().REPORT_TITLE) || 'A股市场情绪研判简报'}</div>`
    + `<div class="bf-title">A 股市场情绪研判简报（${dataDate}）</div>`
    + `</div>`;

  // 段序号：一、（黑体）——号码由版式层给，标题文本不再自带序号
  const S = [
    ['情绪定位（核心因子·25%）', sec1, 'bfsec1'],
    ['资金面（龙虎榜）· 参与打分（主分数 s_net 权重 20%）+ 辅助观测（北向/机构行为）', sec2, 'bfsec2'],
    ['盈亏效应（核心因子·25%）', sec3, 'bfsec3'],
    ['广度与量能（核心因子·20%）', sec4, 'bfsec4'],
    ['题材结构（核心因子·20%）', sec5, 'bfsec5'],
    ['综合研判（含 V5.2 仓位档位）', sec6, 'bfsec6'],
  ];
  const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  return head + stamp + absBlock + healthBlock
    + S.map(([t, b, id], i) => seg({ no: `${CN[i]}、`, text: t }, b, id)).join('')
    + appendix;
}

// ── 研判报告「出厂质检」闸门 ────────────────────────────────────────────────
// 为什么需要：报告的屏幕渲染与导出已共用同一份 DOM，但「结构对不对」此前只有
// CI 里的事后脚本来保证（scripts/check_frontend.mjs）。也就是说线上/本地打开页面时，
// 用户完全可能看到一份**坏报告**（缺摘要、少一段、口径折叠件没挂上、指标被重算），
// 而没有任何东西会拦下来。
//
// 现在改成：先构建 → 审计 → 通过才写入 #briefBody。不通过就**不渲染报告**，
// 改为显示审计面板（列出每条失败原因 + 重试按钮）。宁可什么都不显示，
// 也不能让用户读到一份没通过模板契约的报告。
//
// 纪律：审计只读，不改数据/指标/阈值（引擎见 src/report_audit.js，纯函数、Node 与浏览器共用）。
const AUDIT = () => window.ReportAudit || null;

/**
 * 在 parseReport **之前**采集 DOM 事实。
 *
 * 为什么必须提前采集：parseReport 为了「口径不混进正文」会就地 remove 掉
 * .bf-caliber 节点。若审计规则在那之后再查 DOM，就永远找不到口径折叠件——
 * 闸门首次接上时正是这样把一份完全合规的报告判成「未通过」的。
 * 所以 DOM 侧的事实只在这一处、只在这一刻采一次，之后各规则读快照。
 * @returns {{domCaliberSummaries:string[], domTodoCount:number, domTodoAriaCount:number, domAppendix:boolean}}
 */
function collectDomFacts(stage) {
  const calSums = [...stage.querySelectorAll('.bf-sec .bf-caliber summary')]
    .map((s) => s.textContent.trim());
  const todos = [...stage.querySelectorAll('.bf-todo')];
  // 三档配色 class 的"机制在位"判据：样式表里三档都有规则 → 模板落地了。
  // 之所以查样式而不是查 DOM：标记是数据驱动的，当日没触发某档时 DOM 里自然没有它，
  // 但那不代表模板没落地（把「数据没触发」当成「模板没落地」会天天误报）。
  const hasMarkerClasses = ['ico-risk', 'ico-pos', 'ico-neutral'].every((k) => {
    for (const sheet of document.styleSheets) {
      try {
        for (const r of sheet.cssRules) if (r.selectorText && r.selectorText.includes('.' + k)) return true;
      } catch (e) { /* 跨域样式表读 cssRules 会抛，跳过 */ }
    }
    return false;
  });
  return {
    domCaliberSummaries: calSums,
    domTodoCount: todos.length,
    // 复选框必须带 aria-checked 才是"可勾选题"（模板④）；屏幕上初始就应设好，
    // 而不是等用户点一下才补上——否则屏幕阅读器读到的是普通文本。
    domTodoAriaCount: todos.filter((t) => t.hasAttribute('aria-checked')).length,
    domAppendix: !!stage.querySelector('.bf-appendix'),
    // 导出层的三档映射表（report.js 的 MARKERS 键）——机制在位即通过
    markerKinds: window.ReportExport && window.ReportExport.MARKERS
      ? Object.keys(window.ReportExport.MARKERS) : null,
    hasMarkerClasses,
  };
}

/** 把审计结果渲染成用户能读懂的面板（不通过时替换报告正文） */
function renderAuditPanel(result) {  const env = document.createElement('div');
  env.className = 'bf-audit-fail';
  const items = (result.failed || []).map((f) =>
    `<li><code>${f.id}</code> ${f.reason || f.msg}</li>`).join('');
  env.innerHTML = `<div class="bf-af-h">⚠ 报告未通过出厂质检，已阻止显示</div>`
    + `<div class="bf-af-sub">共 ${result.total} 项检查，失败 <b>${result.failed.length}</b> 项。`
    + `这是一道保护：宁可不出报告，也不让没通过模板契约的内容被读到。</div>`
    + `<ul class="bf-af-list">${items}</ul>`
    + `<div class="bf-af-foot">修复后点右侧「重试质检」重新校验。</div>`;
  return env;
}

/** 展示/隐藏报告中部的审计面板；通过时也把结论写进状态条，让用户知道这份报告是验过的 */
function paintAudit(state, result) {
  const bar = $('briefAudit');
  if (bar) {
    const A = AUDIT();
    bar.className = 'bf-audit ' + state;
    bar.hidden = false;
    bar.textContent = state === 'running' ? '质检中…'
      : state === 'pass' ? '✓ ' + (A ? A.auditSummary(result) : '已通过')
      : '⚠ ' + (A ? A.auditSummary(result) : '未通过');
  }
  const btn = $('briefAuditRetry');
  if (btn) btn.hidden = state !== 'fail';
}

function renderBrief(days, arc) {
  const A = AUDIT();
  const html = buildBrief(days, arc);
  const body = $('briefBody');

  // 审计引擎未挂载（离线打开/模块加载失败）：如实降级为「直接渲染 + 状态条说明未审计」。
  // 不静默跳过——用户有权知道这份报告没经过质检。
  if (!A || typeof A.auditReport !== 'function') {
    body.innerHTML = html;
    renderBriefNav();
    paintAudit('skip', null);
    window.__briefAudit = { pass: null, reason: 'audit-engine-unavailable' };
    return;
  }

  // ── 数据未就绪：明确区分「数据还没到」与「报告不合格」 ──
  // 这两种情况的处理必须不同：数据未就绪是**正常的中间态**（首屏加载中、拉取失败），
  // 报「未通过质检」会把用户吓一跳且指向错误的排查方向；而报告不合格是真问题。
  // 判据用「构建产物里一个章节都没有」——这是数据缺失的确定性特征
  // （buildBrief 在任何有数据的档位下都必然产出 7 段）。
  if (!/class="bf-sec"/.test(html)) {
    body.innerHTML = '';
    body.classList.remove('audit-blocked');
    body.innerHTML = '<div class="bf-li muted">报告数据尚未就绪——等待行情数据拉取完成后会自动生成（本段不是质检失败）。</div>';
    renderBriefNav();
    paintAudit('skip', null);
    window.__briefAudit = { pass: null, reason: 'data-not-ready' };
    return;
  }

  // 在**离屏容器**里先装一遍，供审计读取真实 DOM 结构（不能直接写 #briefBody，
  // 那样不通过时用户会先看到一帧坏报告，再被替换——闪烁反倒像出了 bug）。
  const stage = document.createElement('div');
  stage.className = 'brief-body';
  stage.innerHTML = html;

  // ⚠ 顺序很重要：parseReport 会**移除** .bf-caliber 节点（它要防口径混进正文），
  // 所以 DOM 结构类检查（折叠件标题）必须在 parseReport **之前**跑，
  // 否则一律报「屏幕 DOM 里找不到章节口径折叠件」——这是真踩过的坑：
  // 闸门首次接上时就是这样把一份完全合规的报告判成未通过的。
  const domFacts = collectDomFacts(stage);

  // 三形态产物同时审计：结构问题常常只在某一种形态里暴露
  // （例：GFM 表格语法、<details> 配对、导出时间只在 md/txt 里）。
  // 注意 parseReport 传**克隆节点**：stage 还要留着做后续 DOM 检查与失败时的兜底，
  // 不能被 parseReport 的就地修改（remove 口径件）污染。
  const rep = window.ReportExport ? window.ReportExport.parseReport(stage.cloneNode(true)) : null;
  const opts = reportOpts();
  const E = RPT();
  const md = E ? E.toMarkdown(rep, opts) : '';
  const txt = E ? E.toPlainText(rep, opts) : '';
  const out = E ? E.toStandaloneHtml(rep, opts) : '';

  let result;
  try {
    result = A.auditReport(rep, { rootEl: stage, ...domFacts, md, txt, html: out });
  } catch (e) {
    // 审计自身崩了：按「未通过」处理（不能因为质检工具坏了就放行）
    result = { pass: false, total: 0, passed: 0, failed: [{ id: 'audit-crashed', msg: '质检异常', reason: String(e && e.message || e) }], checks: [] };
  }

  window.__briefAudit = result;
  // 审计结论同时挂到 body 上，供前端断言脚本直接读（不必依赖 window 时序）
  document.body.dataset.briefAudit = result.pass ? 'pass' : 'fail';

  if (result.pass) {
    body.innerHTML = html;
    body.classList.remove('audit-blocked');
    renderBriefNav(); // 段落标题由 DOM 读出，不硬编码，避免与 buildBrief 的段落数漂移
    paintAudit('pass', result);
    return;
  }

  // ── 未通过：不渲染报告 ──
  body.innerHTML = '';
  body.classList.add('audit-blocked');
  body.appendChild(renderAuditPanel(result));
  renderBriefNav(); // 无 .bf-sec 时目录自然为空（不保留上一份的陈旧目录）
  paintAudit('fail', result);
  console.error('[brief-audit] 报告未通过出厂质检，已阻止显示：', result.failed);
}

// 「重试质检」：重新构建并重新审计（用于排查/数据刷新后手动恢复）
function retryBriefAudit(btn) {
  if (btn) { btn.disabled = true; btn.textContent = '质检中…'; }
  try {
    const dd = displayDays(ARC); if (dd.length) renderBrief(dd, ARC);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '重试质检'; }
  }
}

// ── 审计闸门的测试钩子 ──
// 前端断言脚本（scripts/check_frontend.mjs）跑在 jsdom 里，在页面加载之后才把
// ReportAudit 挂上 window（模块脚本不执行），此时报告已经渲染过一次了。这两个钩子
// 让断言脚本能① 触发一次完整重渲染、② 注入任意报告 HTML 走同一条闸门路径。
// 它们的唯一用途是「让闸门可被验证」——没有它们，断言只能看闸门代码而不能证明它拦得住。
window.__rerenderBriefForAudit = () => {
  const dd = displayDays(ARC); if (dd.length) { renderBrief(dd, ARC); return true; }
  return false;
};
/** 把给定 HTML 当作 buildBrief 的产物走一遍闸门（负向验证注入坏报告用） */
window.__renderBriefHtmlForAudit = (html) => {
  const A = AUDIT();
  const body = $('briefBody');
  const stage = document.createElement('div');
  stage.innerHTML = html;
  const rep = RPT() ? RPT().parseReport(stage) : null;
  const opts = reportOpts();
  const E = RPT();
  const md = E ? E.toMarkdown(rep, opts) : '';
  const txt = E ? E.toPlainText(rep, opts) : '';
  const out = E ? E.toStandaloneHtml(rep, opts) : '';
  const result = A
    ? A.auditReport(rep, { rootEl: stage, md, txt, html: out })
    : { pass: true, total: 0, passed: 0, failed: [], checks: [] };
  window.__briefAudit = result;
  document.body.dataset.briefAudit = result.pass ? 'pass' : 'fail';
  if (result.pass) {
    body.innerHTML = html;
    body.classList.remove('audit-blocked');
    renderBriefNav();
    paintAudit('pass', result);
  } else {
    body.innerHTML = '';
    body.classList.add('audit-blocked');
    body.appendChild(renderAuditPanel(result));
    renderBriefNav();
    paintAudit('fail', result);
  }
  return result;
};

// 报告目录：从渲染后的 .bf-sec 读标题生成跳转 chip（点击 → 滚到该段 + 展开）
function renderBriefNav() {
  const nav = $('briefNav');
  if (!nav) return;
  const secs = [...document.querySelectorAll('#briefBody .bf-sec')];
  nav.innerHTML = '';
  for (const s of secs) {
    const h = s.querySelector('.bf-h');
    if (!h) continue;
    const full = h.textContent.trim();
    // 段落标题本身也是折叠开关：加 tabindex/role，键盘 Enter 走同一套 data-act 委托
    h.tabIndex = 0;
    h.setAttribute('role', 'button');
    h.setAttribute('aria-expanded', 'true');
    h.dataset.act = 'bftoggle';
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = full.split('（')[0] || full;
    b.dataset.act = 'brsec';
    b.dataset.t = s.id;
    b.title = `跳转到 ${full}`;
    nav.appendChild(b);
  }
  const tg = $('briefToggle');
  if (tg) tg.textContent = '全部折叠';
}

// 「全部折叠/展开」按钮文案跟随实际段落状态，避免按钮说反话
function syncBriefToggleLabel() {
  const secs = [...document.querySelectorAll('#briefBody .bf-sec')];
  const tg = $('briefToggle');
  if (tg) tg.textContent = (secs.length && secs.every((s) => s.classList.contains('collapsed'))) ? '全部展开' : '全部折叠';
}

// ── V5.2 策略回测面板：读 data/backtest.json（由 node scripts/backtest.mjs 预生成）──
// 数据文件缺失时只在卡片内提示，不影响其余区块渲染。
const pctS = (v, d = 2) => (v == null || !Number.isFinite(+v)) ? '—' : (+v * 100).toFixed(d) + '%';
const numS = (v, d = 2) => (v == null || !Number.isFinite(+v)) ? '—' : (+v).toFixed(d);

function drawNav(svg, series, dates = []) {
  const W = 300, H = 100, pad = 8;
  const all = series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
  if (!all.length) { svg.innerHTML = ''; return; }
  const min = Math.min(...all), max = Math.max(...all);
  const n = Math.max(...series.map((s) => s.values.length));
  const x = (i) => pad + (i * (W - 2 * pad)) / (n - 1 || 1);
  const y = (v) => H - pad - ((v - min) / (max - min || 1)) * (H - 2 * pad);
  let out = `<line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}"></line>`;
  for (const s of series) {
    if (!s.values.length) continue;
    const pts = s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    out += `<polyline points="${pts}" style="stroke:${s.color}${s.dash ? ';stroke-dasharray:4 3' : ''}"></polyline>`;
  }
  // 数据点：默认透明（CSS 控制 opacity），hover 显示该点日期与净值，避免只能看曲线猜数值。
  // 同时可点开当日盘面（backtest.series.dates 与 archive.all_days 逐项一致，按日期匹配即可）。
  let dots = '';
  for (const s of series) {
    if (!s.values.length) continue;
    dots += s.values.map((v, i) => (v == null || !Number.isFinite(v)) ? '' :
      `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3.2" style="fill:${s.color}" `
      + `data-act="btpt" data-d="${esc(dates[i] || '')}" tabindex="0" aria-label="${esc(s.name)} ${esc(dates[i] || '')} 净值 ${(+v).toFixed(4)}">`
      + `<title>${esc(s.name)}｜${esc(dates[i] || `第 ${i + 1} 日`)}｜净值 ${(+v).toFixed(4)}（点击看当日盘面）</title></circle>`).join('');
  }
  svg.innerHTML = out + dots;
}

function renderBacktest(bt) {
  const m = bt.meta || {}, P = bt.params || {}, v52 = P.v52 || {};
  // V5.3 动态仓位口径（右侧确认 + regime 帽子；止盈两段叠加其上）——
  // 旧档（无 v53 段）不渲染该列，宽表降级回 3 列（向后兼容，渐进上线）。
  const v53 = bt.v53 || null;
  const tpP = bt.v53tpPartial || null;
  const tpT = bt.v53tpTrail || null;
  const hasV53 = !!v53;
  const cmp = [
    ['年化收益', bt.base.annual, bt.v52.annual, v53 && v53.annual],
    ['最大回撤', bt.base.maxDd, bt.v52.maxDd, v53 && v53.maxDd],
    ['夏普比率', bt.base.sharpe, bt.v52.sharpe, v53 && v53.sharpe],
    ['Calmar', bt.base.calmar, bt.v52.calmar, v53 && v53.calmar],
    ['持仓日胜率', bt.base.winRate, bt.v52.winRate, v53 && v53.winRate],
    ['空仓占比', bt.base.emptyRatio, bt.v52.emptyRatio, v53 && v53.emptyRatio],
  ];
  const fmt = (v, i) => (i === 2 || i === 3) ? numS(v) : pctS(v, 1);
  $('btMetrics').innerHTML = '<table><thead><tr><th>指标</th><th>V5 基准口径</th><th>V5.2 增强口径</th>'
    + (hasV53 ? '<th>V5.3 动态仓位</th>' : '')
    + '</tr></thead><tbody>'
    + cmp.map((r, i) => `<tr><td class="muted">${r[0]}</td><td>${fmt(r[1], i)}</td><td>${fmt(r[2], i)}</td>`
      + (hasV53 ? `<td>${fmt(r[3], i)}</td>` : '') + '</tr>').join('')
    + '</tbody></table>'
    // V5.3 与 V5.2 的回撤差是核心读数（P0 验收线"最大回撤显著降低"），直接给结论行
    + (hasV53 && Number.isFinite(+v53.maxDd) && Number.isFinite(+bt.v52.maxDd)
      ? `<div class="bf-foot">V5.3 相对 V5.2：年化 ${pctS(v53.annual - bt.v52.annual, 2)}｜回撤 ${pctS(v53.maxDd - bt.v52.maxDd, 2)}`
        + `（确认 + regime 帽子的净贡献；regime 分布 ${Object.entries(v53.regimeCounts || {}).map(([k, n]) => `${k}${n}`).join('/')}）</div>` : '');

  const s = bt.series || {};
  const series = [
    { name: 'V5 基准（无成本/无风控）', values: s.navBase || [], color: 'var(--muted)', dash: true },
    { name: 'V5.2 增强（成本+平滑+风控）', values: s.navV52 || [], color: 'var(--acc)' },
  ];
  if (s.navV53 && s.navV53.length) series.push({ name: 'V5.3 动态仓位（确认+市场状态帽子）', values: s.navV53, color: 'var(--ok)' });
  series.push({ name: '等权指数买入持有', values: s.navHold || [], color: 'var(--warn)', dash: true });
  drawNav($('btNavSvg'), series, s.dates || []);
  $('btLegend').innerHTML = series.map((x) => `<span><i style="background:${x.color}"></i>${x.name}</span>`).join('')
    + `<span>样本 ${m.days || 0} 个交易日（${(s.dates || [])[0] || '—'} ~ ${(s.dates || []).slice(-1)[0] || '—'}）</span>`;

  // 卡内只留最影响读数的两行（阈值 / 风控）；样本、标的、成本、口径备注收进「完整参数」抽屉
  $('btParams').innerHTML = [
    `阈值：过热 ${numS(P.thresholds?.overheat, 0)} / 满仓 ${numS(P.thresholds?.lo, 0)} / 半仓 ${numS(P.thresholds?.panic, 0)}~${numS(P.thresholds?.lo, 0)} / 清仓 ${numS(P.thresholds?.panic, 0)}（收盘打分，T+1 生效；hi=${numS(P.thresholds?.hi, 0)} 为保留参数，引擎判档未使用）`,
    `风控：最大仓位 ${numS(v52.maxPos, 2)}｜单笔止损 ${pctS(v52.stopLoss, 0) || '—'}｜回撤降仓触发 ${pctS(v52.ddTrigger, 0) || '—'}｜单日仓位变动 ≤ ${numS(v52.maxPosChg, 2)}`,
  ].join('<br>')
    // V5.3 止盈两模式（可切换）：叠加在动态仓位口径之上；triggeredDays 披露实际介入
    // 天数——零触发时数值与 V5.3 相同是机制中性（指数腿浮盈不足 5%），不是失效。
    + (tpP ? `<br>止盈·分批（${(tpP.params && tpP.params.ladder || []).map((l) => `+${Math.round((l[0] - 1) * 100)}%→${l[1] === 0 ? '清仓' : (l[1] * 100 + '%仓')}`).join('，')}）：`
      + `年化 ${pctS(tpP.annual, 2)}｜回撤 ${pctS(tpP.maxDd, 2)}｜实际介入 ${tpP.triggeredDays ?? '—'} 天` : '')
    + (tpT ? `<br>止盈·移动（浮盈 ≥5% 激活后峰值回撤 ≥30% 离场）：`
      + `年化 ${pctS(tpT.annual, 2)}｜回撤 ${pctS(tpT.maxDd, 2)}｜实际介入 ${tpT.triggeredDays ?? '—'} 天`
      + ((tpT.triggeredDays ?? 1) === 0 ? '（指数池腿浮盈不足激活线，零触发属常态——机制已由跨语言夹具锁定）' : '') : '');
  $('btNote').textContent = `口径备注：${m.caveat || ''}`;

  const p = bt.pareto || {};
  $('paretoSummary').textContent = `扫描 ${p.scanned || 0} 组权重 · 去重后 ${p.uniqueCount || 0} 个不同结果 · 非支配解 ${p.count ?? '—'} 个。${p.note || ''}`;
  const ptb = $('paretoTable').querySelector('tbody');
  ptb.innerHTML = '';
  (p.rows || []).forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.className = 'clickable';
    tr.dataset.act = 'wrow';
    tr.dataset.i = String(i);
    tr.tabIndex = 0;
    tr.title = `点击查看第 ${i + 1} 行权重组合的 7 因子权重与完整绩效`;
    tr.innerHTML = `<td>${numS(r.sharpe)}</td><td>${pctS(r.maxDd, 2)}</td><td>${numS(r.calmar)}</td>`
      + `<td>${pctS(r.annual, 2)}</td><td class="${r.np ? 'np-yes' : 'muted'}">${r.np ? '✓ 前沿' : '—'}</td>`;
    ptb.appendChild(tr);
  });
  if (!ptb.children.length) ptb.innerHTML = '<tr><td colspan="5" class="empty">网格结果为空</td></tr>';
  // 窄屏卡片：同一份 p.rows，同样可点开权重组合
  const pcb = $('paretoCards');
  if (pcb) {
    pcb.innerHTML = (p.rows || []).length ? (p.rows || []).map((r, i) =>
      `<div class="hcard" data-act="wrow" data-i="${i}" tabindex="0" role="button"`
      + ` title="点击查看第 ${i + 1} 行权重组合的 7 因子权重与完整绩效">`
      + `<div class="hc-head"><span class="hc-name">第 ${i + 1} 组权重</span>`
      + `<span class="hc-code muted">夏普</span><span class="hc-big">${numS(r.sharpe)}</span></div>`
      + '<div class="hc-tags">'
      + `<span class="hc-tag"><i>最大回撤</i>${pctS(r.maxDd, 2)}</span>`
      + `<span class="hc-tag"><i>Calmar</i>${numS(r.calmar)}</span>`
      + `<span class="hc-tag"><i>年化</i>${pctS(r.annual, 2)}</span>`
      + `<span class="hc-tag"><i>非支配</i><span class="${r.np ? 'np-yes' : 'muted'}">${r.np ? '✓ 前沿' : '—'}</span></span>`
      + '</div></div>').join('')
      : '<div class="empty">网格结果为空</div>';
  }

  const R = bt.rolling || {};
  const line = (label, x) => `${label}：夏普均值 ${numS(x?.sharpeMean)}｜最差段回撤 ${pctS(x?.ddWorst, 2)}｜正收益段 ${pctS(x?.winSegPct, 0)}`;
  $('rollSummary').innerHTML = `${line('固定权重', R.base)}<br>${line('逐窗重寻优', R.refit)}`
    + (R.refitChangedSegments != null ? `<br>重寻优实际换权重的段：${R.refitChangedSegments}/${(R.refit?.segments || []).length}` : '');
  // 分段行统一收集后同时喂给表格与窄屏卡片（两者 DOM 都在，由 CSS 决定显示哪个）
  const segs = [];
  [['固定', R.base, 'base'], ['重寻优', R.refit, 'refit']].forEach(([label, x, kind]) => {
    (x?.segments || []).forEach((sg, i) => segs.push({ label, sg, kind, i }));
  });
  const rtb = $('rollTable').querySelector('tbody');
  rtb.innerHTML = segs.length ? segs.map(({ label, sg, kind, i }) =>
    `<tr class="clickable" data-act="seg" data-kind="${kind}" data-i="${i}" tabindex="0"`
    + ` title="点击查看该段的训练窗、权重与绩效（${label}口径）">`
    + `<td class="muted">${label}</td><td>${esc(sg.testStart)} ~ ${esc(sg.testEnd)}</td>`
    + `<td class="${trendCls(sg.total)}">${pctS(sg.total, 2)}</td><td>${numS(sg.sharpe)}</td><td>${pctS(sg.maxDd, 2)}</td></tr>`
  ).join('') : '<tr><td colspan="5" class="muted">样本不足，未切出滚动段</td></tr>';
  const rcb = $('rollCards');
  if (rcb) {
    rcb.innerHTML = segs.length ? segs.map(({ label, sg, kind, i }) =>
      `<div class="hcard" data-act="seg" data-kind="${kind}" data-i="${i}" tabindex="0" role="button"`
      + ` title="点击查看该段的训练窗、权重与绩效（${label}口径）">`
      + `<div class="hc-head"><span class="hc-name">${label}口径</span>`
      + `<span class="hc-big ${trendCls(sg.total)}">${pctS(sg.total, 2)}</span></div>`
      + '<div class="hc-tags">'
      + `<span class="hc-tag"><i>夏普</i>${numS(sg.sharpe)}</span>`
      + `<span class="hc-tag"><i>回撤</i>${pctS(sg.maxDd, 2)}</span>`
      + '</div>'
      + `<div class="hc-reason">测试区间 ${esc(sg.testStart)} ~ ${esc(sg.testEnd)}</div>`
      + '</div>').join('')
      : '<div class="empty">样本不足，未切出滚动段</div>';
  }

  const ml = bt.mainLine || {};
  const box = $('mainLineBody');
  box.innerHTML = '';
  if (!(ml.mains || []).length) {
    // 动态阈值（2026-10-07）下的诚实空态：当日无题材达标就不是主线，不冒充 topN。
    const th = ml.threshold;
    const none = document.createElement('div');
    none.className = 'empty';
    none.textContent = `今日无主线题材（最强题材未达动态阈值${th ? `：涨停 ≥${Math.round(th.up_count_threshold * 10) / 10} 家且密集度 ≥${(th.density_threshold * 100).toFixed(1)}%（${th.mode === 'fallback' ? '样本不足，降级固定阈值' : `近 ${th.samples} 日分布 均值+${1}σ`}）` : ''}）`;
    box.appendChild(none);
  }
  (ml.mains || []).forEach((mn) => {
    const head = document.createElement('div');
    head.className = 'ml-head';
    head.innerHTML = `<span class="tag2 click" data-act="theme" data-theme="${esc(mn.theme)}" tabindex="0" title="查看该题材的成分股与强度">主线题材 ${esc(mn.theme)}</span>`
      + `<span>涨停 <b>${mn.themeCount}</b> 只</span>`
      + `<span>密集度 ${(mn.density * 100).toFixed(1)}%</span>`
      + `<span>强度分 <span class="ml-score">${mn.mainScore}</span></span>`
      + `<span class="muted">自动选出标的 ${mn.stockCount} 只</span>`;
    box.appendChild(head);
    if (mn.stocks?.length) {
      const wrap = document.createElement('div');
      wrap.className = 'chips';
      wrap.style.marginBottom = '10px';
      mn.stocks.forEach((st) => {
        const c = document.createElement('span');
        c.className = 'chip click';
        c.dataset.act = 'stock';
        c.dataset.code = st.code;
        c.tabIndex = 0;
        c.title = `点击查看 ${st.name} 的席位与资金详情`;
        // 仓位管理（第三步）：ATR 波动分档 + 建议仓位（数据不足 → ATR —，权重取 mid 默认）
        const atrTxt = st.atr_pct != null ? `ATR ${numS(st.atr_pct, 1)}%` : 'ATR —';
        c.innerHTML = `${esc(st.name)} <span class="${trendCls(st.changePct)}">${numS(st.changePct, 2)}%</span>`
          + ` <span class="muted">${atrTxt} / 建议仓位 ${numS(st.suggested_weight, 0)}%</span>`;
        wrap.appendChild(c);
      });
      box.appendChild(wrap);
    }
  });
  const ind = document.createElement('div');
  ind.className = 'ml-head';
  ind.innerHTML = '<span class="muted">领涨行业：</span>'
    + (ml.topIndustries || []).map((x) => `<span class="tag2">${x.name} <span class="bf-up">+${numS(x.change_pct, 2)}%</span></span>`).join('');
  box.appendChild(ind);
  const note = document.createElement('div');
  note.className = 'bf-foot';
  const mlCfg = (window.ASENT_CONFIG && window.ASENT_CONFIG.mainLine) || {};
  note.textContent = `口径：主线题材须达动态阈值（近 N 个交易日最强题材分布的 均值+σ×标准差，配置 config.json::mainLine）后再按涨停家数取前 N；标的清单取热点榜中诱因含该题材的强势股，按当日涨幅降序。`
    + `强度分 = 主线涨停家数 × 密集度（该题材涨停数 ÷ 当日全题材涨停数），与离线 Python 版 find_main_line 的「涨停家数 × 涨停密度」同形，但数据源不同，绝对量级不可直接比较。`
    + `建议仓位 = 按 ATR 波动分档（atr_pct ≤${mlCfg.atr_low_threshold ?? 3}% 低波 / >${mlCfg.atr_high_threshold ?? 8}% 高波，Wilder 平滑，周期 ${mlCfg.atr_period ?? 10} 日）；ATR 基于热点榜收盘价序列（无日内高低价，退化为收盘价波幅口径），在榜不足一个周期的标的显示 ATR — 并按中波动默认权重处理。数据截至 ${ml.tradeDate || '—'}。`;
  box.appendChild(note);
}

async function loadBacktest() {
  try {
    const res = await fetch('./data/backtest.json?_=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    BT = await res.json();
    noteLoad('backtest', true);
    renderBacktest(BT);
    // 阈值/主线就绪后按引擎口径重刷：报告（§6 档位）、趋势参考线、个股表的连板/席位列。
    // 首次渲染时 BT 尚为 null，用的是与引擎同值的默认阈值（24/44/65/80），缺失时页面仍可读、不空白。
    if (lastArc) {
      const d = displayDays(lastArc);
      renderBrief(d, lastArc);
      renderTrend(d);
      renderHotTable();
    }
  } catch (e) {
    noteLoad('backtest', false, e);
    const n = $('btNote');
    if (n) n.textContent = `回测数据未生成或加载失败（生成命令：node scripts/backtest.mjs）：${e.message}`;
    renderOfflineBar();
  }
}

// ── 公式版本对比：读 data/version-regression.json（由 scripts/version_regression.mjs 预生成）──
//
// 为什么单独一个加载器而不并进 loadBacktest：
//   两者数据源不同、失败互不影响（回测档缺失不该让版本对比也空白，反之亦然）。
//   ⚠ 本函数**只渲染**：所有数字（均分/σ/饱和/Pearson）都来自 JSON，前端绝不重算——
//   重算就等于在 UI 里再写一套公式口径，那正是本项目一直在消灭的东西。
let VREG = null;

// ── 数据健康面板（#115）──────────────────────────────────────────────────────
//
// 数据来源：data/signals-latest.json 的 health 段（由管线用 src/health.js 算好）。
//
// ⚠ 为什么前端**不自己算**健康：
//   新鲜度那一项需要交易日历（前端没有 calendar.json），补位率与字段可算但阈值
//   在 src/health.js —— 前端再实现一遍就是第二套口径。故一律读算好的结果。
//
// ⚠ 为什么单独拉 signals-latest 而不是从 archive-index 取：
//   index 里没有 health 段（它是纯元信息+摘要）。signals-latest 只有 ~16KB，
//   专门为"轻量结论"而存在——健康面板正好是这类信息。
let HEALTH = null;
// 席位属性（#1）与亏钱效应（#2）：来自 signals-latest.json 的兄弟段，与 HEALTH 同一次 fetch。
//   为 null 表示"未生成/未加载"（≠"没有资金分歧"），渲染层须显式区分。
let SEATS = null;
let PAIN = null;
// 多维市场宽度（#3）：同样来自 signals-latest.json。为 null 表示"未生成/未加载"
//   （≠"宽度均衡"）——渲染层须显式区分。
let BREADTH = null;
// 异常值/脏数据标脏（#3 本轮）：同样来自 signals-latest.json。
//   为 null 表示"未生成/未加载"（≠"数据干净"）——渲染层须显式区分。
let DIRTY = null;
// 跨源一致性互证（#2 本轮）：同样来自 signals-latest.json。
//   ⚠ 为 null 表示"未互证"（≠"两源一致"）——这两者语义相反，渲染层必须显式区分。
//     本项目铁律：没检查 ≠ 没问题。故 null 走独立样式 + 「未互证」文案，绝不借用"一致"的绿。
let XCHECK = null;
// 拐点标签（#4）：来自 signals-latest.json 的 regime 段。
//   ⚠ null = "未生成"（≠"中性"）。四态标签只描述状态，不含买卖建议。
let REGIME = null;
// 每日日报（#4）：来自 signals-latest.json 的 dailyReport 段。
let REPORT = null;
// 宽度背离告警（#3 决策）：来自 signals-latest.json 的 divergence 段。
//   ⚠ 三态：diverged=true / diverged=false（同向，已比对）/ level='unknown'（未评估）。
//     最后一种**不是**"一致"——宽度判定缺失时无从比对，渲染层必须显示"未评估"。
let DIVERGE = null;
// 双轨披露块（P2-β 渲染接线 · 框架 docs/dual_track_framework.md §三）：同源同次取。
//   ⚠ null = "账本未生成"（旁路工具未跑），**不是**"轨道一致"——渲染层显式区分。
//   asOf 是双轨账本末日：与 meta.tradeDate 不同步时如实披露（不伪装成"今日"）。
//   渲染纪律：数字只展示不重算（唯一出处 = tools/backtest/paper_dual_track.mjs），
//   轨道 B/C 一律带"风控参考，非买卖信号"的免责标注（DISCLAIMER 口径）。
let DUALTRACK = null;
// 整份 signals-latest（不只是 health 段）：数据导出（src/dataset.js）要读
//   breadth/series、seats/series、crosscheck/flagged、dirty/recent 等段。
//   让它与各面板共用**同一次 fetch 结果**，避免"导出时再现拉一次"造成两处不一致。
let SIGNALS = null;

async function loadHealth() {
  try {
    const res = await fetch('./data/signals-latest.json?_=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const s = await res.json();
    SIGNALS = s || null;
    HEALTH = s && s.health ? s.health : null;
    renderHealth(HEALTH);
    // 席位属性（#1）与亏钱效应（#2）同在 signals-latest.json 里 → 一次 fetch 全取，
    //   不为它们各开一次请求（首屏预算敏感，见 archive_split.js 分层说明）。
    SEATS = s && s.seats ? s.seats : null;
    PAIN = s && s.pain ? s.pain : null;
    renderSeats(SEATS);
    renderPain(PAIN);
    // 市场宽度（#3）同源同次取。
    BREADTH = s && s.breadth ? s.breadth : null;
    renderBreadth(BREADTH);
    // 异常值/脏数据（#3 本轮）同源同次取。
    DIRTY = s && s.dirty ? s.dirty : null;
    renderDirty(DIRTY);
    // 跨源一致性互证（#2）同源同次取。
    XCHECK = s && s.crosscheck ? s.crosscheck : null;
    renderXcheck(XCHECK);
    // 拐点标签（#4）与每日日报（#4）同源同次取。
    REGIME = s && s.regime ? s.regime : null;
    REPORT = s && s.dailyReport ? s.dailyReport : null;
    renderRegime(REGIME);
    renderDailyReport(REPORT);
    // 宽度背离告警（#3 决策）同源同次取。**独立于日报**——日报缺失时它照常显示。
    DIVERGE = s && s.divergence ? s.divergence : null;
    renderDiverge(DIVERGE);
    // 双轨披露块（P2-β 渲染接线）同源同次取；回滚横幅读 active_track 镜像
    //   （缺席 = 轨道 A 常态 = 不渲染——零 diff 纪律在渲染端的体现）。
    DUALTRACK = s && s.dualTrack ? s.dualTrack : null;
    renderDualTrack(DUALTRACK);
    renderTrackBanner(s);
    noteLoad('signals-latest', true);
    // 健康档到位后重刷离线/陈旧横幅：横幅要并进 health 的告警摘要，
    //   而横幅首次渲染发生在 ARC 就绪时（那时 HEALTH 还是 null）。
    renderOfflineBar(HEALTH);
    // 研判报告里也有一段「数据可信度」——它渲染时 HEALTH 多半还是 null（首屏已画完），
    // 故拉取成功后必须**重刷报告**，否则报告会永久缺这一段。
    // 与 loadBacktest 成功后重刷报告是同一种处理（数据异步到达 → 依赖它的 UI 要重画）。
    if (lastArc) renderBrief(displayDays(lastArc), lastArc);
  } catch (e) {
    // 拉不到时不显示面板（而不是显示"正常"）——"没检查"与"没问题"必须可区分。
    SIGNALS = null;
    noteLoad('signals-latest', false, e);
    renderHealth(null, e.message);
    renderSeats(null, e.message);
    renderPain(null, e.message);
    renderBreadth(null, e.message);
    renderDirty(null, e.message);
    renderXcheck(null, e.message);
    renderRegime(null, e.message);
    renderDailyReport(null, e.message);
    renderDiverge(null, e.message);
    renderDualTrack(null, e.message);
    renderTrackBanner(null);
  }
}

function renderHealth(h, errMsg) {
  const box = $('healthPanel');
  if (!box) return;
  // 未生成/加载失败：显式说明，且**不显示成"正常"**
  if (!h) {
    box.hidden = false;
    box.className = 'health-panel hl-unknown';
    box.innerHTML = `<div class="hl-head"><b>数据健康</b>`
      + `<span class="hl-chip unknown">未评估</span>`
      + `<span class="muted">${esc(errMsg || 'signals-latest.json 未生成或缺少 health 段')}`
      + `——这是"没检查"，不等于"正常"</span></div>`;
    return;
  }
  const lv = { ok: 'ok', warn: 'warn', fail: 'fail', unknown: 'unknown' }[h.level] || 'unknown';
  box.hidden = false;
  box.className = `health-panel hl-${lv}`;
  // 折叠策略：**异常/未知时默认展开**（那是需要看的时候），正常时默认折叠。
  //   反过来会让人错过问题——健康面板的全部价值就在于"出问题时你会看到"。
  const openAttr = (h.level === 'ok') ? '' : ' open';
  const chips = (h.items || []).map((it) =>
    `<span class="hl-chip ${esc(it.level)}" title="${esc(it.detail || '')}">${esc(it.label)}</span>`
  ).join('');
  const rows = (h.items || []).map((it) => {
    const sub = it.rows ? `<div class="hl-fields">${it.rows.map((row) => {
      const ra = row.ratioAll == null ? '—' : (row.ratioAll * 100).toFixed(0) + '%';
      const rr = row.ratioRecent == null ? '—' : (row.ratioRecent * 100).toFixed(0) + '%';
      return `<div class="hl-field ${esc(row.level)}">`
        + `<span class="hf-name">${esc(row.label)}</span>`
        + `<span class="hf-num">全档 ${row.hasAll}/${row.totalAll}（${ra}）</span>`
        + `<span class="hf-num">近${row.totalRecent}日 ${row.hasRecent}/${row.totalRecent}（${rr}）</span>`
        + `<span class="hf-affects muted">缺失影响：${esc(row.affects)}</span>`
        + `</div>`;
    }).join('')}</div>` : '';
    return `<div class="hl-item ${esc(it.level)}">`
      + `<div class="hl-item-head"><span class="hl-chip ${esc(it.level)}">${esc(it.label)}</span>`
      + `<span class="hl-detail">${esc(it.detail)}</span></div>${sub}</div>`;
  }).join('');
  box.innerHTML = `<details class="hl-fold"${openAttr}>`
    + `<summary><b>数据健康</b>`
    + `<span class="hl-chip ${lv}">${esc(h.label || lv)}</span>`
    + chips
    + `<span class="muted hl-sum">${esc(h.summary || '')}</span>`
    + `</summary>`
    + `<div class="hl-body">${rows}`
    + `<div class="hl-note muted">${esc(h.note || '')}</div>`
    + `</div></details>`;
}

// ── 席位/资金属性面板（#1）────────────────────────────────────────────────
// 回答"谁在买"：机构 / 北向 / 游资 三类的**逐日净买**。
// ⚠ 全部口径来自引擎（src/seats_daily.js），本函数只排版，不重算任何净额。
//   缺失一律显示"—"，绝不显示 0——"净买 0"（多空抵消）与"没数据"含义相反。
function renderSeats(s, errMsg) {
  const box = $('seatsPanel');
  if (!box) return;
  if (!s || !s.verdict) {
    box.hidden = false;
    box.className = 'seats-panel st-unknown';
    box.innerHTML = `<div class="st-head"><b>资金属性</b>`
      + `<span class="st-chip unknown">未评估</span>`
      + `<span class="muted">${esc(errMsg || 'signals-latest.json 缺少 seats 段')}`
      + `——这是"没数据"，不等于"资金均衡"</span></div>`;
    return;
  }
  const series = Array.isArray(s.series) ? s.series : [];
  const sm = s.summary || {};
  const v = s.verdict || {};
  // 等级色：按主导方给（机构=蓝偏稳、北向=青、游资=橙偏激、未知=灰）
  const tone = { inst: 'inst', north: 'north', hot: 'hot', unknown: 'unknown' }[v.level] || 'unknown';
  box.hidden = false;
  box.className = `seats-panel st-${tone}`;

  const fmt = (x) => (x == null ? '—' : (x > 0 ? '+' : '') + x + ' 亿');
  const cls = (x) => (x == null ? '' : x > 0 ? ' pos' : x < 0 ? ' neg' : '');

  // 逐日净买条（只有真正有数据的天才会出现——序列已在引擎侧滤掉 null 行）
  const rows = series.map((r) => `<tr class="st-row${r.dominant ? ' dom-' + esc(r.dominant) : ''}">`
    + `<td class="st-date">${esc(r.date || '')}</td>`
    + `<td class="st-num${cls(r.instNet)}">${fmt(r.instNet)}</td>`
    + `<td class="st-num${cls(r.northNet)}">${fmt(r.northNet)}</td>`
    + `<td class="st-num${cls(r.hotNet)}">${fmt(r.hotNet)}</td>`
    + `<td class="st-dom">${r.dominant ? esc({ inst: '机构', north: '北向', hot: '游资' }[r.dominant] || r.dominant) : '—'}</td>`
    + `</tr>`).join('');

  // 汇总：只在有样本时给均值，否则 —（不把 null 画成 0.00）
  const agg = (a) => (a && a.n ? `${a.mean > 0 ? '+' : ''}${a.mean}（${a.n}日）` : '—');

  box.innerHTML = `<details class="st-fold" open>`
    + `<summary><b>资金属性（谁在买）</b>`
    + `<span class="st-chip ${esc(tone)}">${esc(v.label || '未知')}</span>`
    + `<span class="muted st-sum">机构 ${esc(agg(sm.instNet))} · 北向 ${esc(agg(sm.northNet))} · 游资 ${esc(agg(sm.hotNet))}</span>`
    + `</summary>`
    + `<div class="st-body">`
    + `<table class="st-table"><thead><tr><th>日期</th><th>机构净买</th><th>北向净买</th><th>游资净买</th><th>主导</th></tr></thead>`
    + `<tbody>${rows || '<tr><td colspan="5" class="muted">暂无有席位明细的交易日</td></tr>'}</tbody></table>`
    + `<div class="st-note muted">${esc(v.reason || '')}`
    + `<br>${esc(s.seatsNote || s.note || '席位明细接口仅保留最近数日，序列自 2026-09-28 起累积。')}`
    + `<br>样本 ${sm.okRows ?? 0}/${sm.totalDays ?? '?'} 个交易日有明细（覆盖率 `
    + `${sm.coverage == null ? '—' : (sm.coverage * 100).toFixed(1) + '%'}）；缺失日为"—"，不填 0。`
    + `</div></div></details>`;
}

// ── 亏钱效应面板（#2）────────────────────────────────────────────────────
// 回答"追高的人亏没亏"。核心口径是**昨涨停今日翻绿比例**。
// ⚠ 绝不可用 hot 列表反查（hot 只含上涨股，会得出恒为 +10% 的假繁荣，见 src/pain.js 头注）。
function renderPain(p, errMsg) {
  const box = $('painPanel');
  if (!box) return;
  if (!p || !p.perf) {
    box.hidden = false;
    box.className = 'pain-panel pn-unknown';
    box.innerHTML = `<div class="pn-head"><b>亏钱效应</b>`
      + `<span class="pn-chip unknown">未评估</span>`
      + `<span class="muted">${esc(errMsg || 'signals-latest.json 缺少 pain 段（需收盘后跑 scripts/fetch_pain.mjs）')}`
      + `——这是"没数据"，不等于"无亏钱效应"</span></div>`;
    return;
  }
  const v = p.verdict || {};
  const perf = p.perf || {};
  const adv = p.advance || {};
  const tone = { severe: 'severe', weak: 'weak', normal: 'normal', strong: 'strong', unknown: 'unknown' }[v.level] || 'unknown';
  box.hidden = false;
  box.className = `pain-panel pn-${tone}`;

  const pct = (x) => (x == null ? '—' : (x * 100).toFixed(0) + '%');
  const num = (x, unit = '%') => (x == null ? '—' : (x > 0 ? '+' : '') + x + unit);

  // 关键数字块
  const kpis = [
    ['昨涨停今日均涨', num(perf.avg), 'pn-kpi-main'],
    ['中位数', num(perf.median), ''],
    ['翻绿比例', pct(perf.lossRatio), perf.lossRatio != null && perf.lossRatio > 0.6 ? 'pn-bad' : ''],
    ['再涨停', (perf.limitUpAgain ?? '—') + ' 只', ''],
    ['跌停', (perf.limitDown ?? '—') + ' 只', (perf.limitDown || 0) > 0 ? 'pn-bad' : ''],
    ['大面股', (perf.bigLoss ?? '—') + ' 只', ''],
    ['连板晋级失败', pct(adv.failRate), adv.failRate != null && adv.failRate > 0.5 ? 'pn-bad' : ''],
    // 口径区隔（2026-10-08 实录）：本卡 maxLb 是「昨日涨停名单今日达到的最高连板」
    // （追高视角），与涨停结构卡「最高连板」（当日全市场涨停股的最高连板，10-08 实例
    // 8 板 vs 6 板）样本不同、数值本可不同。曾同名并排被读者当成自相矛盾——改名区隔，
    // 与上方「昨涨停今日均涨」同款命名风格。
    ['昨涨停最高板', (adv.maxLb ?? '—') + ' 板', ''],
  ].map(([k, val, c]) => `<div class="pn-kpi ${c}"><span class="pn-k">${esc(k)}</span><span class="pn-v">${esc(val)}</span></div>`).join('');

  // 大面股名单（若有）
  const big = (p.bigLoss && p.bigLoss.list) || [];
  const bigHtml = big.length
    ? `<div class="pn-list"><span class="pn-k">大面股</span>` + big.slice(0, 6).map((x) =>
      `<span class="pn-stock">${esc(x.name || x.code)} <b class="neg">${num(x.chg)}</b></span>`).join('') + `</div>`
    : '';

  // 连板分层
  const tier = adv.byTier || {};
  const tierHtml = Object.keys(tier).length
    ? `<div class="pn-list"><span class="pn-k">连板分层</span>` + ['2', '3', '4+'].filter((k) => tier[k] && tier[k].n)
      .map((k) => `<span class="pn-stock">${k}板 ${tier[k].kept}/${tier[k].n} 晋级 <b class="${tier[k].failRate > 0.5 ? 'neg' : ''}">失败${pct(tier[k].failRate)}</b></span>`).join('') + `</div>`
    : '';

  box.innerHTML = `<details class="pn-fold" open>`
    + `<summary><b>亏钱效应（追高亏没亏）</b>`
    + `<span class="pn-chip ${esc(tone)}">${esc(v.label || '未知')}</span>`
    + `<span class="muted pn-sum">${esc(v.reason || '')}</span>`
    + `</summary>`
    + `<div class="pn-body">`
    + `<div class="pn-kpis">${kpis}</div>`
    + tierHtml + bigHtml
    + `<div class="pn-note muted">口径：以「前一交易日涨停名单」为样本，用**今日全市场真实行情**统计（含下跌股）。`
    + `翻绿比例 = 今日收跌只数 ÷ 取到行情的样本数；连板晋级失败 = 昨日 N≥2 连板今日未能再封板。`
    + `<br>⚠ 不可用热门榜（hot）反查——hot 只含上涨股，会静默丢弃下跌的一半，得出恒为 +10% 的假繁荣。`
    + `<br>样本 ${perf.n ?? 0}/${perf.universe ?? 0} 只${perf.reliable === false ? '（偏少，结论仅供参考）' : ''}。`
    + `</div></div></details>`;
}

// ── 多维市场宽度面板（#3）────────────────────────────────────────────────
// 回答"市场结构长什么样"——四个维度：站上20日线占比（趋势参与度）、创新高/新低
// 家数（两个独立极端）、破净率（估值底部宽度）。
// ⚠ 全部由**全市场真实前复权日K**算，非 hot 榜单样本（那是涨幅榜，会失真）。
// ⚠ 缺口径纪律：样本不足 / PB 源不可用 → 显示「未计算」，绝不当 0。破净率 0% 是
//   "全市场无一家破净"（极强信号），与"没抓到"含义完全相反，必须可区分。
function renderBreadth(b, errMsg) {
  const box = $('breadthPanel');
  if (!box) return;
  if (!b || !b.snapshot) {
    box.hidden = false;
    box.className = 'breadth-panel bw-unknown';
    box.innerHTML = `<div class="bw-head"><b>市场宽度</b>`
      + `<span class="bw-chip unknown">未评估</span>`
      + `<span class="muted">${esc(errMsg || 'signals-latest.json 缺少 breadth 段（需收盘后跑 scripts/fetch_breadth.mjs）')}`
      + `——这是"没数据"，不等于"宽度正常"</span></div>`;
    return;
  }
  const snap = b.snapshot || {};
  const v = b.verdict || snap.verdict || {};
  const series = Array.isArray(b.series) ? b.series : [];
  const sm = b.summary || {};
  const tone = { broad: 'broad', narrow: 'narrow', mixed: 'mixed', diverged: 'diverged', unknown: 'unknown' }[v.level] || 'unknown';
  box.hidden = false;
  box.className = `breadth-panel bw-${tone}`;

  // 缺数据一律 "—"，不画 0
  const pct = (x) => (x == null ? '—' : (x * 100).toFixed(1) + '%');
  const cnt = (o) => (o && o.den ? `${o.n}/${o.den}` : '—');

  const kpis = [
    ['站上20日线', pct(snap.aboveMa && snap.aboveMa.ratio), 'bw-kpi-main', snap.aboveMa && snap.aboveMa.den],
    ['创新高', pct(snap.newHigh && snap.newHigh.ratio), '', snap.newHigh && snap.newHigh.den],
    ['创新低', pct(snap.newLow && snap.newLow.ratio), '', snap.newLow && snap.newLow.den],
    ['破净率', pct(snap.brokenPb && snap.brokenPb.ratio), snap.brokenPb && snap.brokenPb.ratio == null ? 'bw-na' : '', snap.brokenPb && snap.brokenPb.den],
    // 口径区隔（2026-10-08 实录）：此处涨/跌是**宽度扫描样本口径**（当日有效 K 线
    // 样本，剔除停牌/陈旧），与日报主文的沪深两市口径涨跌家数（1654/3516）样本不同、
    // 数值可不同（10-08 实录 1634/3466 同日并存）——与「昨涨停最高板 vs 最高连板」
    // 同病同名不同样，标签区隔 + 底注说明，读者不再当成自相矛盾。
    ['样本内上涨', snap.updown ? snap.updown.up : '—', 'pos', null],
    ['样本内下跌', snap.updown ? snap.updown.down : '—', 'neg', null],
    ['有效样本', snap.scanned ?? '—', '', snap.requested],
    ['分化度', pct(snap.divergence), '', null],
  ].map(([k, val, c, den]) => `<div class="bw-kpi ${c}"><span class="bw-k">${esc(k)}</span>`
    + `<span class="bw-v">${esc(val)}</span>`
    + (den ? `<span class="bw-den muted">n=${esc(den)}</span>` : '') + `</div>`).join('');

  // 逐日序列（只有真正算过的天才出现——引擎侧已滤掉不可信日）
  const rows = series.slice(-10).map((r) => `<tr>`
    + `<td class="bw-date">${esc(r.date || '')}</td>`
    + `<td class="bw-num">${r.maRatio == null ? '—' : (r.maRatio * 100).toFixed(1) + '%'}</td>`
    + `<td class="bw-num">${r.newHighRatio == null ? '—' : (r.newHighRatio * 100).toFixed(1) + '%'}</td>`
    + `<td class="bw-num">${r.newLowRatio == null ? '—' : (r.newLowRatio * 100).toFixed(1) + '%'}</td>`
    + `<td class="bw-num">${r.brokenRatio == null ? '—' : (r.brokenRatio * 100).toFixed(1) + '%'}</td>`
    + `<td class="bw-updown"><span class="pos">${r.up ?? '—'}</span>/<span class="neg">${r.down ?? '—'}</span></td>`
    + `</tr>`).join('');

  box.innerHTML = `<details class="bw-fold" open>`
    + `<summary><b>市场宽度（结构）</b>`
    + `<span class="bw-chip ${esc(tone)}">${esc(v.label || '未评估')}</span>`
    + `<span class="muted bw-sum">${esc(v.detail || '')}</span>`
    + `</summary>`
    + `<div class="bw-body">`
    + `<div class="bw-kpis">${kpis}</div>`
    + (rows ? `<table class="bw-table"><thead><tr><th>日期</th><th>站上20日线</th><th>新高</th><th>新低</th><th>破净</th><th>涨/跌</th></tr></thead><tbody>${rows}</tbody></table>` : '')
    + `<div class="bw-note muted">口径：由全市场真实前复权日K计算（前复权是本口径的正确性前提——不复权时除权日的假暴跌会同时打掉均线并伪造新低）。`
    + `占比分母是当次扫描的有效样本数，不是全市场总数。`
    + `「样本内上涨/下跌」为宽度扫描样本口径（剔除停牌/陈旧后当日有效 K 线样本），与日报主文的沪深两市口径涨跌家数样本不同、数值可不同。`
    + `<br>⚠ 「未计算」出现在两类情形：① 有效样本 &lt; ${esc((snap.thresholds && snap.thresholds.MIN_SAMPLE) ?? 100)} 只；② 破净率依赖 PB 源不可用。`
    + `两者都**不填 0**——破净率 0% 是"无一家破净"（极强信号），与"没抓到"含义相反。`
    + `<br>序列 ${sm.days ?? series.length} 天有数据${sm.coverage == null ? '' : `（覆盖 ${(sm.coverage * 100).toFixed(1)}%）`}，逐日累积、历史自然生长。`
    + `<br>数据来自公开行情，不构成投资建议。`
    + `</div></div></details>`;
}

// 数据质量（#3 本轮）：异常值/脏数据标脏结果。
//   核心语义区分（本面板存在的意义）：
//     dirty（error 级）= 该字段已被**排除在情绪分之外**（原值保留，可追溯）
//     warn            = 仅"需人工复核"，**未剔除任何数据**
//   把两者渲染成同一个数字，会让人误以为数据被丢了 —— 那正是本项目最忌讳的"用失败伪装平静"的反面。
function renderDirty(d, errMsg) {
  const box = $('dirtyPanel');
  if (!box) return;
  if (!d) {
    box.hidden = false;
    box.className = 'dirty-panel dq-unknown';
    box.innerHTML = `<div class="dq-head"><b>数据质量</b>`
      + `<span class="dq-chip unknown">未评估</span>`
      + `<span class="muted">${esc(errMsg || 'signals-latest.json 缺少 dirty 段')}`
      + `——这是"没检查"，不等于"数据干净"</span></div>`;
    return;
  }
  const dirtyN = d.dirtyDays ?? 0;
  const warnN = d.warnDays ?? 0;
  const tone = dirtyN > 0 ? 'has-dirty' : (warnN > 0 ? 'has-warn' : 'clean');
  box.hidden = false;
  box.className = `dirty-panel dq-${tone}`;

  const latest = d.latest || null;
  const byField = Array.isArray(d.byField) ? d.byField : [];
  const recent = Array.isArray(d.recent) ? d.recent : [];

  // KPI：干净天数 / 需复核天数 / 已剔除因子字段数
  const cleanN = (d.totalDays ?? 0) - (d.taggedDays ?? 0);
  const kpis = [
    ['干净天数', cleanN, 'pos', d.totalDays],
    ['已剔除（error）', dirtyN, dirtyN > 0 ? 'neg' : '', d.totalDays],
    ['需复核（warn）', warnN, warnN > 0 ? 'warnc' : '', d.totalDays],
    ['涉及字段', byField.length, '', null],
  ].map(([k, val, c, den]) => `<div class="dq-kpi ${c}"><span class="dq-k">${esc(k)}</span>`
    + `<span class="dq-v">${esc(val)}</span>`
    + (den ? `<span class="dq-den muted">/${esc(den)}</span>` : '') + `</div>`).join('');

  const fieldRows = byField.map((f) => `<tr><td class="dq-field">${esc(f.field)}</td><td class="dq-num">${esc(f.days)}</td></tr>`).join('');

  const recentRows = recent.map((r) => `<tr>`
    + `<td class="dq-date">${esc(r.date || '')}</td>`
    + `<td><span class="dq-sev ${r.status === 'dirty' ? 'sev-error' : 'sev-warn'}">${r.status === 'dirty' ? '已剔除' : '需复核'}</span></td>`
    + `<td class="dq-reason">${esc((r.issues && r.issues[0] && r.issues[0].reason) || '—')}</td>`
    + `</tr>`).join('');

  box.innerHTML = `<details class="dq-fold" open>`
    + `<summary><b>数据质量（异常值/脏数据）</b>`
    + `<span class="dq-chip ${esc(tone)}">${dirtyN > 0 ? '有脏数据' : (warnN > 0 ? '有需复核项' : '干净')}</span>`
    + `<span class="muted dq-sum">校验 ${esc(d.totalDays ?? 0)} 天 · 剔除 ${dirtyN} 天 · 复核 ${warnN} 天</span>`
    + `</summary>`
    + `<div class="dq-body">`
    + `<div class="dq-kpis">${kpis}</div>`
    + (latest ? `<div class="dq-latest"><b>最新一日</b> <span class="dq-sev ${latest.status === 'dirty' ? 'sev-error' : 'sev-warn'}">${latest.status === 'dirty' ? '已剔除' : '需复核'}</span>`
      + `<div class="dq-reason">${esc((latest.issues || []).map((i) => i.reason).join('；') || '—')}</div></div>` : '')
    + (fieldRows ? `<table class="dq-table"><thead><tr><th>字段</th><th>天数</th></tr></thead><tbody>${fieldRows}</tbody></table>` : '')
    + (recentRows ? `<div class="dq-sub muted">最近留痕（最多 20 条）</div><table class="dq-table dq-recent"><thead><tr><th>日期</th><th>状态</th><th>原因</th></tr></thead><tbody>${recentRows}</tbody></table>` : '')
    + `<div class="dq-note muted">口径：单源内部校验（范围 / 单位「万-亿」/ 重复 / 逻辑一致性），由 <code>src/dirty.js</code> 唯一实现。`
    + `<br>⚠ 两类语义必须分清：<b>已剔除</b>＝该字段被排除在因子入参之外（**原值仍保留在档里**，可追溯、可人工复核）；<b>需复核</b>＝仅标记，**未剔除任何数据**。`
    + `<br>缺失一律显示「未计算」而非 0。本层**不改写任何分值** —— 剔除动作在管线内完成，此处只通报与定位。`
    + `<br>数据来自公开行情，不构成投资建议。`
    + `</div></div></details>`;
}

// ── 宽度背离告警（#3 决策：宽度不纳入情绪分）─────────────────────────────
//   决策背景：情绪分 = "钱有多凶"，宽度 = "多少票在涨"。二者同向时无信息量，
//   **背离**才是信号。故不高权重地把宽度塞进情绪分（那会让两个同义读数重复计权），
//   而是独立盯"这两个读数打架了没有"。
//   ⚠ 三态必须分清，且**未评估 ≠ 一致**：
//     · diverged=true  → 有背离（假繁荣 / 底部背离），给黄色/蓝色提示
//     · diverged=false → 同向，已比对过 → "一致"
//     · level=unknown  → **未评估**（宽度判定缺失）→ 灰态，绝不借用"一致"的绿
//   数据源：signals-latest.json 的 divergence 段（唯一实现 src/regime.js::detectDivergence）。
const DIVERGE_TONE = { 'fake-boom': 'warn', 'bottom-divergence': 'info' };

function renderDiverge(d, errMsg) {
  const box = $('divergePanel');
  if (!box) return;
  if (!d) {
    box.hidden = false;
    box.className = 'diverge-panel dv-unknown';
    box.innerHTML = `<div class="dv-head"><b>宽度背离</b><span class="dv-chip unknown">未生成</span>`
      + `<span class="muted">${esc(errMsg || 'signals-latest.json 缺少 divergence 段')}`
      + `——"未生成"不等于"两个读数一致"</span></div>`;
    return;
  }
  const lvl = d.level || 'unknown';
  const tone = lvl === 'unknown' ? 'unknown'
    : (d.diverged ? (DIVERGE_TONE[d.kind] || 'warn') : 'ok');
  box.hidden = false;
  box.className = `diverge-panel dv-${tone}`;

  const chip = lvl === 'unknown' ? '未评估' : (d.diverged ? (d.label || '背离') : '同向');
  const chipCls = lvl === 'unknown' ? 'unknown' : (d.diverged ? 'warn' : 'ok');
  // 历史稀缺度：一条天天响的告警等于没响。分母 = 真的比对过的天数（不是全档天数）。
  const H = d.history;
  let histHtml = '';
  if (H && H.checkedDays > 0) {
    const rate = H.ratePct != null ? `${H.ratePct}%` : '未计算';
    const rec = (H.recent || []).slice().reverse().map((r) => `<tr>`
      + `<td class="dv-date">${esc(r.trade_date || '')}</td>`
      + `<td><span class="dv-mini ${esc(DIVERGE_TONE[r.kind] || 'warn')}">${esc(r.label || '')}</span></td>`
      + `</tr>`).join('');
    histHtml = `<div class="dv-sub">历史背离率（仅统计"情绪分与宽度判定同时可算"的交易日）</div>`
      + `<div class="dv-hist"><span><b>${esc(H.divergedDays)}</b> / ${esc(H.checkedDays)} 天</span>`
      + `<span class="dv-rate">${esc(rate)}</span>`
      + `<span class="muted">未核对日不计入分母；分母为 0 时显示"未计算"而非 0%</span></div>`
      + (rec ? `<table class="dv-table"><thead><tr><th>日期</th><th>背离类型</th></tr></thead><tbody>${rec}</tbody></table>` : '');
  } else {
    histHtml = `<div class="dv-sub">历史背离率</div>`
      + `<div class="dv-hist muted">未计算：宽度逐日序列缺失，仅最新日可判（不是"从没背离过"）</div>`;
  }

  box.innerHTML = `<details class="dv-fold" ${lvl === 'unknown' ? '' : 'open'}>`
    + `<summary><b>宽度背离</b><span class="dv-chip ${chipCls}">${esc(chip)}</span>`
    + `<span class="muted dv-sum">情绪分 vs 宽度：${esc(d.reason || '')}</span></summary>`
    + `<div class="dv-body">`
    + `<div class="dv-main"><span class="dv-tag ${chipCls}">${esc(chip)}</span>`
    + `<span class="dv-reason">${esc(d.reason || '')}</span></div>`
    + histHtml
    + `<div class="dv-note muted">宽度<b>不参与</b>情绪分打分——两者是"多少票在涨"与"钱有多凶"，`
    + `同向时无信息量，重复计权只会稀释真正有区分度的因子；只有背离才出信号。`
    + `<br>三态须分清：有背离 / 同向（已比对）/ <b>未评估</b>（宽度判定缺失）。`
    + `"未评估"是"没核对"，<b>不等于</b>"两个读数一致"。`
    + `<br>判据唯一出处 <code>src/regime.js::detectDivergence</code>；本告警只描述状态，<b>不构成投资建议</b>。`
    + `</div></div></details>`;
}

// ── 拐点标签（#4）────────────────────────────────────────────────────────
//   用户第一眼要的答案："今天这盘是什么状态？"——冰点 / 回暖 / 高潮 / 退潮。
//   数据来自 signals-latest.json 的 regime 段（唯一实现 src/regime.js）。
//   ⚠ 渲染纪律：
//     · null → 显式显示「未生成」，**绝不默认成"中性"**（那会伪造一个结论）。
//     · 标签码 → 中文一律查 regime.labels（服务端下发的唯一出处），前端不自造。
//     · 置信度 low（判据不全）必须显式标注，不能让残缺结论看起来和完整结论一样硬。
const REGIME_TONE = { ice: 'cold', recover: 'warm', climax: 'hot', ebb: 'cool', neutral: 'flat', shift: 'cool', unknown: 'unknown' };

function renderRegime(r, errMsg) {
  const box = $('regimePanel');
  if (!box) return;
  if (!r || !r.latest) {
    box.hidden = false;
    box.className = 'regime-panel rg-unknown';
    box.innerHTML = `<div class="rg-head"><b>市场状态</b><span class="rg-chip unknown">未生成</span>`
      + `<span class="muted">${esc(errMsg || 'signals-latest.json 缺少 regime 段')}`
      + `——"未生成"不等于"中性"，故不给标签</span></div>`;
    return;
  }
  const L = r.latest || {};
  const tone = REGIME_TONE[L.key] || 'unknown';
  box.hidden = false;
  box.className = `regime-panel rg-${tone}`;

  // 主标签大字 + 关键读数
  const val = L.value != null ? esc(L.value) : '—';
  const pct = L.pct_rank != null ? esc(L.pct_rank) + '%' : '未计算';
  const conf = L.confidence === 'low' ? ' aria-label="判据不全">判据不全'
    : (L.confidence === 'mid' ? '>中等置信' : '>高置信');
  const dirTxt = { up: '上行', flat: '横盘', down: '下行' }[L.dir] || '方向未判';
  const warn = L.caution ? `<div class="rg-caution">⚠ ${esc(L.caution)}</div>` : '';

  // 近期拐点（最近 10 天标签发生变化的日子）——用户最关心的"变盘点"
  const turns = Array.isArray(r.turns) ? r.turns : [];
  const turnRows = turns.slice().reverse().map((t) => `<tr>`
    + `<td class="rg-date">${esc(t.date || '')}</td>`
    + `<td><span class="rg-mini ${esc(REGIME_TONE[regimeKeyOf(r, t.from)] || 'unknown')}">${esc(t.from)}</span></td>`
    + `<td class="rg-arrow">→</td>`
    + `<td><span class="rg-mini ${esc(REGIME_TONE[regimeKeyOf(r, t.to)] || 'unknown')}">${esc(t.to)}</span></td>`
    + `<td class="rg-num">${esc(t.value != null ? t.value : '—')}</td></tr>`).join('');

  // 分布（这个标签历史上常见吗）
  const counts = r.counts || {};
  const total = r.totalDays || 0;
  const dist = ['ice', 'recover', 'climax', 'ebb', 'neutral', 'unknown']
    .filter((k) => counts[(r.labels && r.labels[k]) || k] != null)
    .map((k) => {
      const label = (r.labels && r.labels[k]) || k;
      const n = counts[label] || 0;
      const p = total ? Math.round((n / total) * 100) : 0;
      return `<span class="rg-dist-item ${esc(REGIME_TONE[k])}">`
        + `<span class="rg-dist-label">${esc(label)}</span>`
        + `<span class="rg-dist-n">${n}</span>`
        + `<span class="rg-dist-p muted">${p}%</span></span>`;
    }).join('');

  box.innerHTML = `<details class="rg-fold" open>`
    + `<summary><b>市场状态</b>`
    + `<span class="rg-chip ${esc(tone)}">${esc(L.label || '—')}</span>`
    + `<span class="muted rg-sum">情绪分 ${val} · 分位 ${pct} · ${esc(dirTxt)}</span>`
    + `</summary>`
    + `<div class="rg-body">`
    + `<div class="rg-main">`
    + `<div class="rg-tag ${esc(tone)}"><span class="rg-tag-label">${esc(L.label || '—')}</span>`
    + `<span class="rg-tag-conf"${conf}</span></div>`
    + `<div class="rg-facts">`
    + `<span><b>${val}</b> 情绪分</span>`
    + `<span><b>${pct}</b> 历史分位</span>`
    + `<span><b>${esc(dirTxt)}</b> 近期方向</span>`
    + `<span><b>${esc(L.date || '')}</b> 交易日</span>`
    + `</div></div>`
    + warn
    + (turnRows ? `<div class="rg-sub">近期变盘（最近 10 个交易日内的标签切换）</div>`
      + `<table class="rg-table"><thead><tr><th>日期</th><th>从</th><th></th><th>到</th><th>情绪分</th></tr></thead><tbody>${turnRows}</tbody></table>` : '')
    + (dist ? `<div class="rg-sub">全档分布（${esc(total)} 个交易日）</div><div class="rg-dist">${dist}</div>` : '')
    + `<div class="rg-note muted">判据：水位（**历史分位为主**）× 方向（较 ${esc(r.rules ? r.rules.dirLookback : 3)} 个交易日前的变化）。`
    + `<br>为什么以分位为主：实测情绪分分布高度压缩（89% 的历史天数落在 40–65 之间），绝对刻度几乎起不到分类作用；分位恒能把历史铺开到 0–100。`
    + `<br>水位或方向任一不可判 → 显示「数据不足」，**绝不猜一个"中性"顶上**。`
    + `<br>阈值唯一出处 <code>src/regime.js</code>；标签只描述市场状态，<b>不构成投资建议</b>。`
    + `</div></div></details>`;
}

/** 由中文标签反查标签码（用于给"从/到"上色；查不到就返回 null，不猜） */
function regimeKeyOf(r, label) {
  const m = r && r.labels;
  if (!m) return null;
  for (const [k, v] of Object.entries(m)) if (v === label) return k;
  return null;
}

// ── 每日盘后日报（#4）──────────────────────────────────────────────────────
//   把当天的证据串成七节可读简报。它是**翻译层**：只把屏幕上已有的数字翻成人话，
//   不重算任何指标。缺失节显示「未生成＋原因」，绝不补 0 伪装成正常。
function renderDailyReport(rep, errMsg) {
  const box = $('reportPanel');
  if (!box) return;
  if (!rep) {
    box.hidden = false;
    box.className = 'report-panel rp-unknown';
    box.innerHTML = `<div class="rp-head"><b>每日日报</b><span class="rp-chip unknown">未生成</span>`
      + `<span class="muted">${esc(errMsg || 'signals-latest.json 缺少 dailyReport 段')}</span></div>`;
    return;
  }
  const secs = Array.isArray(rep.sections) ? rep.sections : [];
  const missingN = secs.filter((s) => s.missing).length;
  const tagTone = REGIME_TONE[rep.tag && rep.tag.key] || 'unknown';

  const secHtml = secs.map((s) => {
    const pts = (s.points || []).map((p) => {
      const cls = p.kind === 'caution' ? 'rp-pt warn'
        : (p.kind === 'main' ? 'rp-pt main'
          : (p.kind === 'unknown' ? 'rp-pt unknown' : 'rp-pt'));
      return `<li class="${cls}">${esc(p.text)}</li>`;
    }).join('');
    const miss = s.missing
      ? `<div class="rp-missing">未生成：${esc(s.missingReason || '原因未知')}</div>` : '';
    return `<div class="rp-sec${s.missing ? ' is-missing' : ''}">`
      + `<div class="rp-sec-title">${esc(s.title || '')}`
      + `<span class="rp-sec-lv lv-${esc(s.level || 'info')}">${esc(secLevelText(s.level))}</span></div>`
      + miss
      + (pts ? `<ul class="rp-pts">${pts}</ul>` : '')
      + `</div>`;
  }).join('');

  const caveats = Array.isArray(rep.caveats) && rep.caveats.length
    ? `<div class="rp-caveats"><b>需要注意</b><ul>${rep.caveats.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>`
    : '';

  box.hidden = false;
  box.className = `report-panel rp-${tagTone}`;
  box.innerHTML = `<details class="rp-fold" open>`
    + `<summary><b>每日日报</b>`
    + `<span class="rp-chip ${esc(tagTone)}">${esc((rep.tag && rep.tag.label) || '—')}</span>`
    + `<span class="muted rp-sum">${esc(rep.date || '')}${missingN ? ` · ${missingN} 个区块缺数据` : ''}</span>`
    + `</summary>`
    + `<div class="rp-body">`
    + `<div class="rp-headline">${esc(rep.headline || '')}</div>`
    + caveats
    + `<div class="rp-secs">${secHtml}</div>`
    + `<div class="rp-actions">`
    + `<button type="button" class="rp-btn" id="rpCopy">复制全文</button>`
    + `<button type="button" class="rp-btn" id="rpPrint">打印 / 存 PDF</button>`
    + `</div>`
    + `<div class="rp-note muted">${esc(rep.disclaimer || '')}`
    + `<br>本日报由 <code>src/daily_report.js</code> 由当日已归档数据翻译而成（不重算指标）；`
    + `缺失项一律标注「未采集 / 未计算」而非补 0。`
    + `</div></div></details>`;
  // 动作按钮（复制/打印）——用**纯文本**导出，便于粘贴到任意地方
  const copyBtn = $('rpCopy');
  if (copyBtn) copyBtn.onclick = () => copyReportText(rep, copyBtn);
  const printBtn = $('rpPrint');
  if (printBtn) printBtn.onclick = () => printReportText(rep, printBtn);
}

function secLevelText(lv) {
  return { info: '正常', ok: '正常', warn: '需注意', unknown: '未评估' }[lv] || '正常';
}

/** 把日报渲染成纯文本（复制/打印共用；唯一实现，避免两处口径不一） */
function reportToText(rep) {
  const lines = [];
  lines.push(`【每日日报】${rep.date || ''}`);
  lines.push(rep.headline || '');
  lines.push('');
  if (Array.isArray(rep.caveats) && rep.caveats.length) {
    lines.push('需要注意：');
    rep.caveats.forEach((c) => lines.push(`  · ${c}`));
    lines.push('');
  }
  (rep.sections || []).forEach((s) => {
    lines.push(s.title || '');
    if (s.missing) lines.push(`  （未生成：${s.missingReason || '原因未知'}）`);
    (s.points || []).forEach((p) => lines.push(`  - ${p.text}`));
    lines.push('');
  });
  lines.push(rep.disclaimer || '');
  return lines.join('\n');
}
function copyReportText(rep, btn) {
  const txt = reportToText(rep);
  // 反馈走既有的 flashBtn（把按钮文字临时换成结果）——不新造 toast 机制，
  //   与页面其它"已复制 ✓"的反馈保持同一种观感（少一套 UI 就少一处不一致）。
  const done = (ok) => flashBtn(btn, ok ? '已复制 ✓' : '复制失败');
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(() => done(true), () => done(fallbackCopy(txt)));
    } else done(fallbackCopy(txt));
  } catch { done(fallbackCopy(txt)); }
}
/** 返回是否成功（供按钮反馈）；独立出来便于测试与降级 */
function fallbackCopy(txt) {
  try {
    const ta = document.createElement('textarea');
    ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}
function printReportText(rep, btn) {
  try {
    const w = window.open('', '_blank');
    if (!w) { flashBtn(btn, '弹窗被拦截'); return; }
    w.document.write(`<pre style="font:13px/1.7 -apple-system,'PingFang SC',sans-serif;white-space:pre-wrap;padding:24px;max-width:900px;margin:0 auto">${esc(reportToText(rep))}</pre>`);
    w.document.close();
    w.focus(); w.print();
    flashBtn(btn, '已打开 ✓');
  } catch { flashBtn(btn, '打印失败'); }
}

// 跨源一致性互证面板（#135）
//   两个独立来源（同花顺行业 / 腾讯-申万二级）对同一交易日、同一行业口径的涨跌幅做互证。
//   核心语义（本面板存在的意义）：
//     ok       = 在**扣除系统性偏移后**，两侧仍在容差内 —— 不是"两个源数字相等"（它们本就不同口径）
//     diverge  = 存在超出容差的离群行业（可能：单位错、单源抽风、字段串位）
//     conflict = 出现"符号相反"的行业（同一天一个涨一个跌）—— 最严重，通常是数据源本身错了
//     unknown  = **没做互证**（未注入/文件缺失）—— 必须显示为"未互证"，绝不能默认放行成"一致"
function renderXcheck(x, errMsg) {
  const box = $('xcheckPanel');
  if (!box) return;
  if (!x) {
    box.hidden = false;
    box.className = 'xcheck-panel xc-unknown';
    box.innerHTML = `<div class="xc-head"><b>跨源互证</b>`
      + `<span class="xc-chip unknown">未互证</span>`
      + `<span class="muted">${esc(errMsg || 'signals-latest.json 缺少 crosscheck 段')}`
      + `——这是"没核对"，不等于"两个源一致"</span></div>`;
    return;
  }

  const st = x.status || 'unknown';
  box.hidden = false;
  box.className = `xcheck-panel xc-${esc(st)}`;

  const tag = {
    ok: ['一致', '在扣除常态偏移后两侧吻合'],
    diverge: ['有离群', '存在超出容差的行业'],
    conflict: ['有冲突', '出现符号相反的行业'],
    skip: ['样本不足', '可比行业数低于门槛，不做判定'],
    unknown: ['未互证', '未执行互证'],
  }[st] || ['未知', ''];

  // KPI：可比天数 / 可比行业（中位）/ 常态偏移 / 最大偏差 / 离群 / 冲突
  const kpis = [
    ['可比天数', x.comparableDays ?? '未计算', '', x.totalDays],
    ['可比行业(中位)', x.medianComparable ?? '未计算', '', null],
    ['常态偏移', x.offsetPp == null ? '未计算' : fmtSigned(x.offsetPp, 2) + 'pp', '', null],
    ['最大偏差', x.maxDevPp == null ? '未计算' : fmtSigned(x.maxDevPp, 2) + 'pp', '', null],
    ['离群行业', x.flaggedCount ?? 0, (x.flaggedCount > 0) ? 'warnc' : '', null],
    ['符号冲突', x.conflictCount ?? 0, (x.conflictCount > 0) ? 'neg' : '', null],
  ].map(([k, val, c, den]) => `<div class="xc-kpi ${c}"><span class="xc-k">${esc(k)}</span>`
    + `<span class="xc-v">${esc(val)}</span>`
    + (den ? `<span class="xc-den muted">/${esc(den)}</span>` : '') + `</div>`).join('');

  const rows = (Array.isArray(x.rows) ? x.rows : []).map((r) => `<tr>`
    + `<td class="xc-date">${esc(r.date || '')}</td>`
    + `<td class="xc-name">${esc(r.name || '')}</td>`
    + `<td class="xc-num">${r.primaryPct == null ? '未计算' : fmtSigned(r.primaryPct, 2)}</td>`
    + `<td class="xc-num">${r.secondaryPct == null ? '未计算' : fmtSigned(r.secondaryPct, 2)}</td>`
    + `<td class="xc-num">${r.devPp == null ? '未计算' : fmtSigned(r.devPp, 2)}</td>`
    + `<td><span class="xc-sev ${r.kind === 'conflict' ? 'sev-error' : 'sev-warn'}">${r.kind === 'conflict' ? '符号冲突' : '离群'}</span>`
    + `<span class="xc-reason muted">${esc(r.reason || '')}</span></td>`
    + `</tr>`).join('');

  box.innerHTML = `<details class="xc-fold" open>`
    + `<summary><b>跨源互证（同花顺行业 × 腾讯/申万二级）</b>`
    + `<span class="xc-chip ${esc(st)}">${esc(tag[0])}</span>`
    + `<span class="muted xc-sum">${esc(tag[1])} · 可比 ${esc(x.comparableDays ?? 0)} 天</span></summary>`
    + `<div class="xc-body">`
    + `<div class="xc-kpis">${kpis}</div>`
    + (rows ? `<div class="xc-sub muted">偏离最大的可比行业（最多 20 条）</div>`
      + `<table class="xc-table"><thead><tr><th>日期</th><th>行业</th><th>主源%</th><th>第二源%</th><th>去偏偏差</th><th>判定</th></tr></thead><tbody>${rows}</tbody></table>`
      : `<div class="xc-none muted">本次互证未发现超出容差的离群/冲突行业。</div>`)
    + `<div class="xc-note muted">口径：主源＝同花顺行业（${esc(x.primarySource || 'ths')}），第二源＝腾讯/申万二级（${esc(x.secondarySource || 'sw2')}）。两源**分类体系不同**（同花顺 ${esc(x.primaryUniverse ?? '—')} 个 vs 申万二级 ${esc(x.secondaryUniverse ?? '—')} 个），经别名表归一化后可比 ${esc(x.comparableUniverse ?? '—')} 个（覆盖率 ${x.coveragePct == null ? '未计算' : esc(x.coveragePct) + '%'}）。`
    + `<br>⚠ 两源存在**系统性偏移**（方法论差异，非抽风）：判定前先扣掉常态偏移 <b>${x.offsetPp == null ? '未计算' : esc(fmtSigned(x.offsetPp, 2)) + 'pp'}</b>，再看剩余偏差。`
    + `<br>判定规则由 <code>src/crosscheck.js</code> 唯一实现，前端不自算阈值；缺失一律显示「未计算」，未覆盖的行业＝「未核对」而非「一致」。`
    + `<br>本层<b>只做互证，不改写任何分值</b>；数据来自公开行情，不构成投资建议。`
    + `</div></div></details>`;
}

// 带符号格式化（避免 +-0.00 这种噪声）
function fmtSigned(v, d) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '未计算';
  const s = n.toFixed(d);
  const z = (0).toFixed(d);
  return (n > 0 ? '+' : '') + (s === '-' + z ? z : s);
}

// ── 双轨披露面板（P2-β 渲染接线 · 框架 docs/dual_track_framework.md §三）────────
//
// 数据源：signals-latest.json 的 dualTrack 段（src/dual_track.js 唯一搬运出处，
// 数字唯一出处 = tools/backtest/paper_dual_track.mjs——前端只展示不重算）。
//
// ⚠ 渲染纪律（与各面板同源）：
//   · null = "账本未生成"（旁路工具未跑），**不是**"轨道一致"——显式区分，绝不借绿；
//   · asOf 是双轨账本末日：与 meta.tradeDate 不同步时如实披露滞后（旁路工具每日一跑），
//     伪装成"今日"才是事故（缺失显式化原则）；
//   · 轨道 B/C 一律带"风控参考，非买卖信号"标注（DISCLAIMER 口径）；
//   · 保险账本读数（保费/保额/影子增益）为 P2 起累计——不是当日值，单位 pp。
function renderDualTrack(dt, errMsg) {
  const box = $('dualTrackPanel');
  if (!box) return;
  if (!dt || !dt.day) {
    box.hidden = false;
    box.className = 'dualtrack-panel dt-unknown';
    box.innerHTML = `<div class="dt-head"><b>双轨披露（V5.2 执行 × V5.3 参考线）</b>`
      + `<span class="dt-chip unknown">未生成</span>`
      + `<span class="muted">${esc(errMsg || 'signals-latest.json 缺少 dualTrack 段（需收盘后跑 tools/backtest/paper_dual_track.mjs）')}`
      + `——这是"账本未生成"，不等于"两条轨道一致"</span></div>`;
    return;
  }
  const day = dt.day || {};
  const A = day.trackA || {}, B = day.trackB || {}, C = day.trackC || {};
  const div = day.divergence || {};
  const led = day.ledger || {};
  const st = dt.trackState || {};
  const fb = st.activeTrack === 'A_fallback';
  // 当日收益（dayReturns：三轨当日，小数 → pp）与累计收益（cum：summary.total 面搬运）。
  //   null 位 = 账本 summary 缺席 / 该轨未产出——显示"未计算"，绝不补 0。
  const dr = day.dayReturns || {};
  const cum = dt.cum || {};
  const pp = (v, d = 2) => (v == null || !Number.isFinite(Number(v))) ? '未计算' : fmtSigned(Number(v) * 100, d) + 'pp';
  const threeLine = (obj, keys, d) => keys.map((k) => `${k}:${pp(obj && obj[k], d)}`).join(' ');
  // asOf 常显（账本口径日期）：滞后与否都要标——同日不显示也是一种"伪装成今日"
  const lag = (SIGNALS && SIGNALS.meta && SIGNALS.meta.tradeDate && dt.asOf && SIGNALS.meta.tradeDate !== dt.asOf)
    ? `（落后于档案日 ${esc(SIGNALS.meta.tradeDate)}）`
    : '';
  // 三轨仓位表：A=执行（targetPos 压 poolPos 后的实际池仓位）；B=参考线（refPos 同口径压帽）；
  //   当日/累计两列 = 用户规格「当日净值 / 累计收益」（数字唯一出处账本，本面板只搬运）
  const posRow = (name, pos, pool, daily, cumTxt, tag, note) => `<tr>`
    + `<td>${esc(name)}${tag}</td>`
    + `<td class="dt-num">${pos == null ? '未计算' : esc((pos * 100).toFixed(0)) + '%'}</td>`
    + `<td class="dt-num">${pool == null ? '未计算' : esc((pool * 100).toFixed(0)) + '%'}</td>`
    + `<td class="dt-num dt-sm">${esc(daily)}</td>`
    + `<td class="dt-num dt-sm">${esc(cumTxt)}</td>`
    + `<td class="muted">${esc(note)}</td></tr>`;
  const aPos = A.poolPos, bPos = B.poolPos;
  const shadow = C.active
    ? Object.entries(C.shadowPos || {}).map(([k, v]) => `${esc(k)}帽 ${esc((v * 100).toFixed(0))}%`).join(' · ')
    : '未激活（前一日 regime ≠ shift）';
  const biteTxt = C.active
    ? Object.entries(C.biting || {}).filter(([, v]) => v).map(([k]) => k).join('、') || '无（当日未真压到轨道 A）'
    : '—';
  const cCum = cum.trackC ? threeLine(cum.trackC, ['0.3', '0.4', '0.5'], 1) : '未计算';
  // 保险账本（P2 起累计）：premiumCum=保费（Σ A−B 日收益）/ coverageCum=保额（回撤差）/
  //   shadowCum=影子增益（Σ A−C）。三线影子同号才不算帽值过拟合（框架 §四门禁 2）。
  const sc = led.shadowCum || {};
  const scRows = ['0.3', '0.4', '0.5'].map((k) => [k, sc[k]]).filter(([, v]) => v != null);
  const ledRows = [
    ['累计保费（Σ A−B）', led.premiumCum == null ? '未计算' : fmtSigned(led.premiumCum * 100, 2) + 'pp'],
    ['累计保额（回撤差）', led.coverageCum == null ? '未计算' : fmtSigned(led.coverageCum * 100, 2) + 'pp'],
    ...(scRows.length ? scRows.map(([k, v]) => [`影子增益 C=${esc(k)}`, fmtSigned(v * 100, 2) + 'pp']) : []),
    ['影子生效日', led.activeDays == null ? '未计算' : `${esc(led.activeDays)} 天（晋升门槛分母）`],
  ].map(([k, v]) => `<tr><td>${esc(k)}</td><td class="dt-num">${esc(v)}</td></tr>`).join('');
  box.hidden = false;
  box.className = `dualtrack-panel ${fb ? 'dt-fallback' : 'dt-a'}`;
  box.innerHTML = `<details class="dt-fold" open>`
    + `<summary><b>双轨披露（V5.2 执行 × V5.3 参考线）</b>`
    + `<span class="dt-chip ${fb ? 'warn' : 'ok'}">${fb ? 'A_fallback' : '轨道 A'}</span>`
    + `<span class="muted dt-sum">账本截至 ${esc(dt.asOf || '—')}${lag} · 分歧 ${div.posGap == null ? '未计算' : esc((div.posGap * 100).toFixed(0)) + 'pp'} = 当日保费敞口</span></summary>`
    + `<div class="dt-body">`
    + `<table class="dt-table"><thead><tr><th>轨道</th><th>目标仓位</th><th>池仓位</th><th>当日</th><th>累计</th><th>口径</th></tr></thead><tbody>`
    + posRow('A · V5.2 主信号', Object.values(A.targetPos || {})[0] ?? null, aPos,
      pp(dr.A), pp(cum.trackA, 1),
      '<span class="dt-chip ok">执行</span>', '唯一执行轨道（P2 模拟资金曲线）')
    + posRow('B · V5.3 参考线', Object.values(B.refPos || {})[0] ?? null, bPos,
      pp(dr.B), pp(cum.trackB, 1),
      '<span class="dt-chip info">参考</span>', '若整份买保险今天会在哪 · 永不执行')
    + posRow('C · shift 次日帽（影子）', null, null,
      ['C0.3', 'C0.4', 'C0.5'].map((k) => `${k.slice(1)}:${pp(dr[k])}`).join(' '), cCum,
      '<span class="dt-chip info">记账</span>', shadow + (C.active ? ` · 真压：${esc(biteTxt)}` : ''))
    + `</tbody></table>`
    + `<div class="dt-sub muted">保险账本（P2 起累计 · since ${esc(led.since || '—')}）</div>`
    + `<table class="dt-table dt-ledger"><tbody>${ledRows || '<tr><td class="muted">账本未生成</td></tr>'}</tbody></table>`
    + `<div class="dt-note muted">${esc(dt.note || '')}`
    + `<br>口径：分歧 = A池仓位 − B池仓位（当日保费敞口）；帽值只引用 POSITION_BANDS（轨道 C 的 0.3/0.4/0.5 为实验扫描区间，晋升前不得收窄）。`
    + `<br>轨道 B/C 均为<b>风控参考，不是买卖信号</b>；影子晋升须过框架 §四门禁（生效日结构占比 ≥50%、三线同号、残差纪律）。`
    + `<br>数字唯一出处 tools/backtest/paper_dual_track.mjs，本面板只展示不重算。</div>`
    + `</div></details>`;
}

// ── 轨道回滚横幅（P1/P2-β）：执行面已切 A_fallback 的常驻警示 ──────────────────
//
// 数据源：signals-latest.json 的 active_track / activeTrackNote（展示镜像；事实源 =
// data/paper/track_state.json，回滚/恢复唯一通道 = scripts/rollback_track.mjs）。
// 渲染纪律：**缺席 = 轨道 A 常态 = 不渲染任何内容**（零 diff 纪律在渲染端的体现——
// 绝不写 "active_track: 'A'" 这种显式常态值）。幂等：每次调用重判，恢复后自动消失。
function renderTrackBanner(sig) {
  const box = $('trackBanner');
  if (!box) return;
  if (!(sig && sig.active_track === 'A_fallback')) {
    // A 态（或加载失败）：清空并隐藏。加载失败时宁可少一条横幅也不伪造"已回滚"。
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  box.innerHTML = `<div class="tb-inner">`
    + `<div class="tb-head"><b>⚠ 执行面已回滚：轨道 A → A_fallback（V5.2 冻结快照）</b></div>`
    + `<div class="tb-lines">${esc(sig.activeTrackNote || '（镜像缺提示文案）')}</div>`
    + `<div class="tb-lines muted">唯一事实源 data/paper/track_state.json · 回滚/恢复唯一通道 scripts/rollback_track.mjs · 恢复条件：连续 5 个交易日无异常亏损后人工审核 --restore</div>`
    + `</div>`;
}

async function loadVersionRegression() {  const foot = $('verCaution');
  try {
    const res = await fetch('./data/version-regression.json?_=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    VREG = await res.json();
    noteLoad('version-regression', true);
    renderVerCmp(VREG);
  } catch (e) {
    noteLoad('version-regression', false, e);
    if (tb) tb.querySelector('tbody').innerHTML =
      `<tr><td colspan="7" class="empty">版本回归未生成（命令：node scripts/version_regression.mjs）：${esc(e.message)}</td></tr>`;
    if (foot) foot.textContent = '';
    const s = $('verSummary');
    if (s) s.textContent = '';
    renderOfflineBar();
  }
}

function renderVerCmp(r) {
  const s = $('verSummary');
  const tb = $('verTable');
  const foot = $('verCaution');
  if (!tb) return;
  const smp = r.sample || {};
  const thr = r.satThreshold ?? 99.9;
  if (s) {
    s.innerHTML = `主样本 <b>${smp.mainDays ?? '—'}</b> 天（有次日收益 <b>${smp.withNextRet ?? '—'}</b> 天）`
      + `｜区间 ${esc(smp.dateRange?.[0] || '—')} ~ ${esc(smp.dateRange?.[1] || '—')}`
      + `｜档案共 ${smp.archiveDays ?? '—'} 天，其中 ${(smp.archiveDays ?? 0) - (smp.mainDays ?? 0)} 天缺行业/量能未纳入`
      + `｜饱和判定 s_net ≥ ${thr}`;
  }
  const keys = (r.versions || []).map((v) => v.key);
  const stats = r.stats || {};
  const tbody = tb.querySelector('tbody');
  tbody.innerHTML = '';
  keys.forEach((k) => {
    const st = stats[k] || {};
    const v = (r.versions || []).find((x) => x.key === k) || {};
    const tr = document.createElement('tr');
    // 基线/候选用不同行样式——这是本表最重要的视觉区分：
    // 候选版看起来"更漂亮"（饱和 0）不代表它该上线，必须一眼能看出哪个是当前生效的。
    tr.className = v.baseline ? 'ver-base' : (v.candidate ? 'ver-cand' : '');
    const satRate = st.n ? (st.sNetSaturated / st.n * 100) : null;
    const nm = v.normalizer === 'percentile' ? '分位映射' : v.normalizer === 'tanh5' ? 'tanh(k=5)' : esc(v.normalizer || '—');
    tr.innerHTML =
      `<td><span class="ver-key">${esc(k)}</span>`
      + (v.baseline ? '<span class="ver-badge base">基线</span>' : '')
      + (v.candidate ? '<span class="ver-badge cand">候选</span>' : '')
      + `</td>`
      + `<td class="muted">${nm}</td>`
      + `<td>${numS(st.scoreMean, 1)}</td>`
      + `<td>${numS(st.scoreStdev, 2)}</td>`
      + `<td class="${st.sNetSaturated > 0 ? 'ver-sat-bad' : 'ver-sat-ok'}">`
      + `${st.sNetSaturated ?? '—'}/${st.n ?? '—'}（${satRate == null ? '—' : satRate.toFixed(0) + '%'}）`
      + `${st.sNetMissing ? `<span class="muted"> +${st.sNetMissing} 缺</span>` : ''}</td>`
      + `<td>${numS(st.pearson, 3)}</td>`
      + `<td>${st.direction ? (st.direction.acc * 100).toFixed(1) + '%' : '—'}</td>`;
    tbody.appendChild(tr);
  });
  if (!tbody.children.length) tbody.innerHTML = '<tr><td colspan="7" class="empty">无版本数据</td></tr>';
  if (foot) {
    const cau = r.cautions || [];
    foot.innerHTML = cau.length
      ? cau.map((c) => `<div class="ver-cau">· ${esc(c)}</div>`).join('')
      : '';
  }
}

let lastFp = '';

function fingerprint(arc) {
  return [(arc.meta && arc.meta.generatedAt) || '', (arc.signals && arc.signals.tradeDate) || '',
    (arc.all_days || []).length, (arc.all_days || []).slice(-1)[0]?.emotion?.value ?? ''].join('|');
}

// ════════════════════════════════════════════════════════════════════════════
// 档案分层加载（三档按需）
//
// ── 为什么必须分层 ──────────────────────────────────────────────────────────
// archive.json 已 5.1MB（241 天），半年后十几 MB。而首屏真正要的只有**最新一天**。
// 故引擎侧把档案切成四份（src/archive_split.js 是唯一出处）：
//   archive-index.json   10.6KB  元信息 + 逐年摘要 + 最新日摘要     ← 首屏必拉
//   archive-recent.json  124KB   29 个曲线点 + 最新日完整明细        ← 开走势图/表格时拉
//   archive-YYYY.json    870KB~4.2MB  该年完整数据                  ← 抽屉回看时才拉
//   archive.json         5.1MB   完整档（脚本/审计/回测用）          ← 前端**不拉**
//
// ── 为什么"最新日摘要"不够、还得拉 recent ──────────────────────────────────
// 首屏的个股明细表 / 题材条 / 研判报告都要**当日明细**（hot/lhb_aggr/themes），
// 索引里只有标量摘要。故首屏实际上是 index + recent 两级，共约 135KB——
// 相对原来的 5.1MB 仍是 97% 的削减。
//
// ── 为什么走势图不需要年分片 ────────────────────────────────────────────────
// 走势图只画最近 15 个点，15 日窗口 ⊂ recent 的 29 个曲线点。故年分片**永不**参与首屏。
//
// ── 惰性字段（lhb）─────────────────────────────────────────────────────────
// 只有 `lhb`（原始未去重榜单）被剥离首屏：展示一律用 lhb_aggr，它只对审计有意义。
// `summary.seats` **不在此列**——研判报告的「席位分项/锁仓统计」首屏就要用，
// 提走会让那两段静默消失（见 src/lhb_codec.js 的说明）。判定标准是"首屏是否用到"，不是"大不大"。
// ════════════════════════════════════════════════════════════════════════════

const LAZY_FIELD_LAB = { lhb: '龙虎原始榜' };
const lazyWanted = new Set();   // 本次会话已按需取过的惰性字段（取过就不再提示）
// 滚动窗的请求去重槽位挂在 window 上（见下方 loadRecentArchiveShared），
// 不在此处再开一个模块级变量——两个槽位就等于两次请求，正是要修的那件事。

function loadJson(url) {
  return fetch(url + '?_=' + Date.now(), { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))));
}

/**
 * 取滚动窗（近 30 日）。并发去重：同一时刻多处调用只发一次请求。
 * 失败时 resolve(null) 而非 reject —— 首屏已由索引渲染完毕，
 * 明细拿不到不该把整页打成错误态（降级显示"需刷新"比白屏有用）。
 *
 * ⚠ 去重按调用点收敛：历史上 paper_ui.js（type=module，晚于本文件求值）也会拉这份
 *   文件，两边各去重一次就是网络上两次 204KB 请求——真浏览器实测确认过。故本文件负责
 *   建立共享入口 `window.__loadRecentArchive` 供各处复用；模拟交易台面下线后该入口
 *   仍保留（成本为零，对未来的多调用点依旧正确）。
 */
// H-2（2026-10-07）：滚动窗共享缓存的存活期。此前该 promise 成功后**永不失效**——
// 5 分钟轮询每次都新拉 index，明细却永远用首屏那份：指纹由「新 index + 旧 recent」
// 合成，错判"数据已更新"，提示与表格自相矛盾。
// 中危2（2026-10-07）修正：TTL 必须**严格小于**轮询周期 POLL_MS（5 分钟），而非相等。
// 边界机理：过期判定是严格大于（>），而时间戳记录在 resolve 成功时刻——比轮询 tick
// 晚 ε（204KB 的网络延迟）。若 TTL == POLL_MS，每个 tick 的 elapsed ≈ POLL_MS - ε，
// 永远不大于 TTL → 命中缓存，要隔一个 tick 才重拉（明细 10 分钟才刷新，index 5 分钟，
// H-2 要修的矛盾隔轮复现）。预留 30 秒安全边际盖住 ε 与定时器漂移，保证每个 tick
// 必然过期 → 重拉，与 index 同鲜。⚠ 若调整 POLL_MS，本值必须同步（保持严格小于）。
const RECENT_PROMISE_TTL_MS = 5 * 60 * 1000 - 30 * 1000;

function loadRecentArchiveShared() {
  const stale = window.__recentPromise;
  // TTL 过期 → 强制失效重拉。先清时间戳再发请求：「槽位非空 + 时间戳为空」表示
  // "刷新中"，并发调用看到即直接复用新 promise——同一时刻多处调用仍只发一次请求
  // （去重语义不变，这正是本函数存在的意义）。
  if (stale && window.__recentPromiseAt != null && Date.now() - window.__recentPromiseAt > RECENT_PROMISE_TTL_MS) {
    const staleAt = window.__recentPromiseAt;
    window.__recentPromiseAt = null;
    window.__recentPromise = fetch('./data/archive-recent.json?_=' + Date.now(), { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((d) => { window.__recentPromiseAt = Date.now(); return d; })
      .catch((e) => {
        // 刷新失败**不清旧缓存**（降级兜底）：旧明细比"无明细"有用；回滚时间戳让
        // 下次调用继续重试。但矛盾必须可见——静默沿用等于继续骗人，故必须 warn。
        window.__recentPromise = stale;
        window.__recentPromiseAt = staleAt;
        console.warn('[recent] 滚动窗 TTL 已过期但刷新失败，降级沿用旧明细（下次调用将继续重试）：', (e && e.message) || e);
        return stale;
      });
    return window.__recentPromise;
  }
  if (!window.__recentPromise) {
    window.__recentPromise = fetch('./data/archive-recent.json?_=' + Date.now(), { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((d) => { window.__recentPromiseAt = Date.now(); return d; })
      .catch((e) => {
        // 不缓存失败：清空让下一次调用能真的重试（否则一次抖动会把整页锁死在"无明细"）
        window.__recentPromise = null;
        window.__recentPromiseAt = null;
        throw e;
      });
  }
  return window.__recentPromise;
}
window.__loadRecentArchive = loadRecentArchiveShared;

// 只重刷披露块的钩子（历史上供 paper_ui.js 在标的池补全后调用；台面下线后保留，成本为零）。
window.__renderScope = renderScope;

function loadRecent() {
  // 中危5（2026-10-07）：首拉失败降级为 null 是调用方约定（按"无明细"渲染），但
  // 不能无痕——与 H-2 的过期刷新失败同口径，静默吞错 = 排障时两眼一抹黑。
  return loadRecentArchiveShared().catch((e) => {
    console.warn('[recent] 拉取失败，本次按无明细降级（下次调用自动重试）：', (e && e.message) || e);
    return null;
  });
}

/**
 * 取完整档（按年分片）。只在用户点了"回看更早交易日"时才调。
 * 返回 { days, latestReasonCodes }：days 为合并后的 all_days（新→旧按年拼接，再按
 * 日期升序），语义与旧 archive.all_days 一致；latestReasonCodes 是**最新日所属
 * 分片**的 rc 码表（上榜原因下标表，在分片顶层 meta 里）——年分片的 _sub.lhb 是
 * rc 压缩态，loadFullArchive 现算 lhb_aggr 兜底时解码用（仅随行带回，零额外请求）。
 */
async function loadFull(arc, years) {
  const want = (years && years.length) ? years : (arc.years || []);
  const parts = await Promise.all(want.map((y) => loadJson('./data/archive-' + y + '.json').catch(() => null)));
  const days = [];
  for (const p of parts) if (p && Array.isArray(p.all_days)) days.push(...p.all_days);
  days.sort((a, b) => String(a.trade_date).localeCompare(String(b.trade_date)));
  const lastDay = days[days.length - 1] || null;
  const owner = lastDay
    ? parts.find((p) => p && Array.isArray(p.all_days) && p.all_days.includes(lastDay))
    : null;
  return { days, latestReasonCodes: (owner && owner.meta && owner.meta.reasonCodes) || null };
}

/**
 * 把"索引 + 滚动窗两级"拼成一个**结构上兼容旧 archive** 的对象。
 *
 * ⚠ 语义诚实性：拼出来的 all_days 只有最近 N 天，绝不是"完整档"。
 *   故挂 `_partial: true` 与 `_backfill_from`，让任何需要完整序列的读者能自己判断。
 *   曾考虑静默拼成"看着像完整档"的对象——那是错的：报告里的"样本 N 个交易日"
 *   会从 241 静默变成 30，读者无从发现。
 */
let RECENT_CACHE = null;

function mergeArc(index, recent) {
  // 滚动窗：29 个曲线点（字段少）+ 最新日（完整明细）
  const trend = (recent && recent.days) || [];
  const latest = (recent && recent.latest) || null;
  const days = latest ? [...trend, latest] : trend.slice();
  const full = (RECENT_CACHE && RECENT_CACHE.days) || [];
  // 完整档已加载 → 它的 all_days 才是权威序列，不要再拼部分序列
  if (full.length) {
    return { ...index, signals: index.signals || recent?.signals || {}, all_days: full, _partial: false };
  }
  return {
    ...index,
    signals: index.signals || (recent && recent.signals) || {},
    all_days: days,
    _partial: true,
    _windowDays: days.length,
    _totalDays: index.totalDays,
    _fallbackNote: '首屏仅加载最近 ' + days.length + ' 个交易日的明细（当前档共 ' + index.totalDays + ' 个交易日）',
  };
}

/**
 * 惰性字段按需取。若滚动窗已含该字段的**真实值**，就地合并，避免无谓请求。
 * @returns {Promise<boolean>} 是否成功补齐
 */
async function ensureLazy(field) {
  if (!field || lazyWanted.has(field)) return true;
  const cur = displayDays(ARC);
  if (lazyValuePresent(cur, field)) { lazyWanted.add(field); return true; }
  const r = await loadRecent();
  if (!r || !r.latest) return false;
  const src = r.latest[field];
  if (src == null) return false;
  const latestDate = r.latest.trade_date;
  // 就地替换**最新日**的那一份：只改这一个 day 对象，不动数组结构。
  // 用不可变替换（而非修改原对象）是为了让 fingerprint 与"已渲染"判断保持一致。
  const next = (ARC.all_days || []).map((d) => (d.trade_date !== latestDate
    ? d
    : { ...d, [field]: src, _sub: stripSub(d._sub, field) }));
  ARC = { ...ARC, all_days: next };
  lazyWanted.add(field);
  return true;
}

function stripSub(sub, field) {
  if (!sub) return sub;
  const nxt = { ...sub };
  delete nxt[field];
  return Object.keys(nxt).length ? nxt : undefined;
}

/** 某字段在给定日内是否已有真实值（不是 null 占位、不是 _sub 待加载）。 */
function lazyValuePresent(days, field) {
  for (const d of days) {
    if (d[field] != null) return true;
  }
  return false;
}

/** 惰性字段的"展示就位"判定：字段在**本表**（龙虎榜资金视图）的展示入口已有真实值
 *  时，视为数据就位，无需再提示"未加载"（原始字段本身只是审计数据，展示层零消费）。
 *  lhb 的展示入口是聚合榜 lhb_aggr——滚动窗切片最新日现算（src/archive_split.js），
 *  完整档装载兜底补（loadFullArchive 继承/现算，2026-10-07）。aggr 与原始榜双缺
 *  （视图真的会显示空）时返回 false → 提示保留。 */
const LAZY_FIELD_READY = {
  lhb: (days) => {
    const last = days[days.length - 1] || {};
    return Array.isArray(last.lhb_aggr) || Array.isArray(last.lhb);
  },
};

/** 惰性字段的"未加载"提示 HTML（无待加载字段时返回空串）。 */
function lazyNoticeHTML() {
  const idx = INDEX_CACHE;
  const lazy = (idx && idx.lazy) || null;
  if (!lazy) return '';
  const days = displayDays(ARC);
  const pend = Object.keys(lazy).filter((k) => {
    if (lazyWanted.has(k)) return false;
    if (lazyValuePresent(days, k)) return false;
    // 展示入口已就位（如 lhb_aggr 在场）→ 本表无列依赖原始字段，提示是噪音
    const ready = LAZY_FIELD_READY[k];
    return !(ready && ready(days));
  });
  if (!pend.length) return '';
  const txt = pend.map((k) => `${LAZY_FIELD_LAB[k] || k}（${(lazy[k] / 1024).toFixed(0)}KB）`).join('、');
  return `<span class="lazy-note" title="原始榜数据位于惰性槽（不随首屏下发），当前视图未加载；显示为空是'未加载'而非'无数据'">⌛ ${txt}未加载</span>`;
}

let INDEX_CACHE = null;

// ── 区五：外围市场 · 隔夜与节后预案 ──
// 数据是独立文件 data/global.json（scripts/fetch_global.mjs 预生成）：外围在 A 股休市期间
// 照常更新，与 archive.json 节奏不同——合成一个文件会让「A股没更新」与「外围没更新」
// 互相掩盖。加载失败只影响本区，不影响其它卡片。
let GLOB = null;

function loadGlobal() {
  return fetch('./data/global.json?_=' + Date.now(), { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
    .then((g) => { GLOB_REF = g; noteLoad('global', true); renderGlobal(g); })
    .catch((e) => {
      noteLoad('global', false, e);
      const box = $('globVerdict');
      if (box) box.innerHTML = `<div class="gv neu"><div class="gv-hint">外围数据未就绪（${esc(e.message)}）——先运行 <b>node scripts/fetch_global.mjs</b> 生成 data/global.json。</div></div>`;
      renderOfflineBar();
    });
}

/** 会话/时间列：美股给「会话日 + 收盘时刻」，盘中品种给当日时间 */
function globWhen(q) {
  const t = String(q.quoteTime || '');
  const clock = t.length > 12 ? t.slice(11, 16) : (t.length >= 5 ? t.slice(0, 5) : t);
  if (q.sessionDate && clock) return q.sessionDate + ' ' + clock;
  return q.sessionDate || clock || '—';
}

function renderGlobal(g) {
  GLOB = g;
  const meta = g.meta || {};
  const w = g.watch || {};
  const sub = $('globSub');
  if (sub) {
    sub.textContent = `隔夜美股 ${meta.usSessionDate || '--'} 收盘`
      + (meta.aShareNextOpen
        ? ` · A股下次开市 ${meta.aShareNextOpen}（开市前还有 ${meta.usSessionsBeforeOpen} 个美股交易日）`
        : '');
  }

  // 结论条
  const v = w.verdict || {};
  const vbox = $('globVerdict');
  if (vbox) {
    // insufficient（判据不足）是独立色调，**不得**归入'neu'（那与"外围中性"同色，
    //   会让"没看到数据"和"看到了、是中性"在视觉上无法区分——2026-10-01 事故的教训）。
    const cls = v.key === 'positive' ? 'ok' : v.key === 'negative' ? 'bad'
      : (v.key === 'insufficient' ? 'unk' : 'neu');
    const readiness = meta.usReadiness || {};
    const notReady = readiness.ready === false;
    vbox.innerHTML = `<div class="gv ${cls}">
        <div class="gv-main">外围研判 <b>${esc(v.label || '—')}</b>
          <span class="muted">· 净倾向 ${(w.bias > 0 ? '+' : '') + w.bias}（门槛 ±${w.biasGate}）</span></div>
        <div class="gv-hint">${esc(v.hint || '')}</div>
        ${w.missingNote ? `<div class="gv-miss">⚠ ${esc(w.missingNote)}</div>` : ''}
        ${notReady ? `<div class="gv-miss">⚠ 美股档未就绪：${esc(readiness.reason || '')}`
          + `（就绪条件：${esc(readiness.readyAfterEt || '16:30 ET')}）——此刻美股涨跌幅显示「盘前无数据」，`
          + `不等于「收平 0%」。</div>` : ''}
        ${meta.aShareHoliday ? '<div class="gv-note">A 股休市中：本卡片每个工作日随隔夜外围刷新，用途就是节后开盘预案。</div>' : ''}
      </div>`;
  }

  // 触发式观测：越过阈值才输出（与研判报告的「明日观测」同一思路，不做固定清单）
  const sbox = $('globSignals');
  if (sbox) {
    const sig = w.signals || [];
    sbox.innerHTML = sig.length
      ? '<div class="bf-h2">触发式观测（越过阈值才输出；缺失项单列且不参与判定）</div>'
        // level='unknown' 是"数据缺失"哨兵，样式与 info（真·无明确方向）区分开
        + sig.map((s) => `<div class="gsig ${esc(s.level)}${s.missing ? ' is-missing' : ''}">${esc(s.text)}</div>`).join('')
      : '<div class="muted">无触发项</div>';
  }

  // 行情表（宽屏）
  const rows = g.quotes || [];
  const tb = $('globTable')?.querySelector('tbody');
  if (tb) {
    tb.innerHTML = rows.map((q) => {
      const cls = trendCls(q.chgPct);
      // 缺行情的标记要区分三种：真的没抓到 / 盘前无数据 / 无成交。
      //   旧代码只有"无行情"一种，会把"盘前"说成接口故障，误导排查方向。
      const missTag = q.state === 'preopen' ? '<span class="gtag n">盘前无数据</span>'
        : (q.state === 'no-trade' ? '<span class="gtag n">无成交</span>'
          : (q.ok ? '' : '<span class="gtag n">无行情</span>'));
      const marks = (q.role === 'a_share_proxy' ? '<span class="gtag a">A股锚</span>' : '') + missTag;
      return `<tr data-act="glob" data-key="${esc(q.key)}" tabindex="0">
        <td>${esc(q.name)}${marks}</td>
        <td class="num ${cls}">${esc(q.lastText)}</td>
        <td class="num ${cls}">${esc(q.chgPctText)}</td>
        <td class="muted gwhen">${esc(globWhen(q))}</td>
      </tr>`;
    }).join('');
  }

  // 行情卡片（窄屏）：与表格同一份数据、同一顺序
  const cl = $('globCards');
  if (cl) {
    cl.innerHTML = rows.map((q) => {
      const cls = trendCls(q.chgPct);
      const marks = q.role === 'a_share_proxy' ? '<span class="gtag a">A股锚</span>' : '';
      return `<div class="gcard" data-act="glob" data-key="${esc(q.key)}" tabindex="0">
        <div class="gc-top"><span>${esc(q.name)}${marks}</span>
          <span class="${cls}">${esc(q.chgPctText)}</span></div>
        <div class="gc-bot muted"><span>${esc(q.lastText)}</span><span>${esc(globWhen(q))}</span></div>
      </div>`;
    }).join('');
  }

  // 映射表：外围品种 → A 股板块（映射关系来自构建期下发的 anchors，前端不重写一份）
  const mbox = $('globMap');
  if (mbox) {
    mbox.innerHTML = '<div class="gmap">' + (g.anchors || []).map((a) => {
      const q = rows.find((x) => x.key === a.from);
      const cls = q ? trendCls(q.chgPct) : 'muted';
      const dir = a.sign > 0 ? '同向' : a.sign < 0 ? '反向' : '结构';
      return `<div class="gmap-row" data-act="gmap" data-from="${esc(a.from)}" tabindex="0">
        <div class="gm-l"><span>${esc(q ? q.name : a.from)}</span>
          <span class="${cls}">${esc(q ? q.chgPctText : '—')}</span></div>
        <div class="gm-mid"><span class="gtag ${a.sign > 0 ? 'u' : a.sign < 0 ? 'd' : ''}">${dir}</span></div>
        <div class="gm-r">${esc((a.aSectors || []).join(' · '))}</div>
      </div>`;
    }).join('') + '</div>';
  }

  // 假期跟踪清单
  const tbox = $('globTrack');
  if (tbox) {
    const dates = meta.usSessionDates || [];
    const wd = (d) => ['日', '一', '二', '三', '四', '五', '六'][new Date(d + 'T00:00:00Z').getUTCDay()];
    const last = meta.usSessionDate;
    tbox.innerHTML = '<div class="bf-h">假期跟踪清单</div>'
      + (dates.length
        ? `<div class="gtrk-note muted">A 股 ${esc(meta.aShareNextOpen)}（周${wd(meta.aShareNextOpen)}）开市，之前还有 ${dates.length} 个美股交易日，每场收盘后本页自动刷新：</div>
           <div class="gtrk">${dates.map((d) => `<span class="gtk${last && d <= last ? ' done' : ''}">${d.slice(5)} 周${wd(d)}</span>`).join('')}</div>
           <div class="gtrk-note muted">最近已收盘 ${esc(last || '—')}。长假期间 A50 期货全程在交易，是最贴近 A 股开盘方向的实时参考；道指金融/消费权重高，只作广度参考。</div>`
        : '<div class="muted">A 股当前非假期状态：按交易日正常跟踪。</div>');
  }

  // 口径备注
  const nbox = $('globNote');
  if (nbox) {
    const failed = meta.failed || [];
    const noSess = meta.usNoSession || [];
    nbox.innerHTML = '口径备注：' + esc(meta.note || '')
      + (failed.length ? ` <span class="bf-warn">本次未取到：${esc(failed.join('、'))}（保持缺失，不写 0）。</span>` : '')
      + (noSess.length ? ` <span class="bf-warn">本会话尚无成交：${esc(noSess.join('、'))}（显示「盘前无数据」，**不是 0%**）。</span>` : '')
      + ` 数据源 ${esc(meta.source || '')} · 最近一次尝试 ${esc(String((meta.lastAttempt || {}).outcome || ''))}。`;
  }
}

/** 外围品种详情（点行情表/卡片打开） */
function globalDetail(key) {
  if (!GLOB) return null;
  const q = (GLOB.quotes || []).find((x) => x.key === key);
  if (!q) return null;
  const numOr = (x) => (x == null ? '—' : String(x));
  const lines = [
    dwSection('行情', dwKv([
      ['最新', `<b>${esc(q.lastText)}</b>`],
      ['涨跌幅', `<span class="${trendCls(q.chgPct)}">${esc(q.chgPctText)}</span>`],
      ['行情状态', q.state === 'ok' ? '有成交（涨跌幅可采信）'
        : (q.state === 'preopen' ? '<b>盘前无数据</b>（该会话尚未开盘）'
          : (q.state === 'no-trade' ? '<b>无成交</b>（数据源为平盘占位）' : '<b>未取到</b>'))],
      ['昨收', numOr(q.prevClose)],
      ['涨跌额', q.chg == null ? '—' : `${q.chg > 0 ? '+' : ''}${q.chg}`],
      ['开 / 高 / 低', `${numOr(q.open)} / ${numOr(q.high)} / ${numOr(q.low)}`],
      ['52周高 / 低', q.hi52 == null && q.lo52 == null ? '该品种源不提供' : `${numOr(q.hi52)} / ${numOr(q.lo52)}`],
    ])),
    dwSection('时间与来源', dwKv([
      ['会话日', esc(q.sessionDate || '—')],
      ['行情时间', esc(String(q.quoteTime || '—'))],
      ['源字段涨跌幅', q.chgPctReported == null ? '源未提供' : `${q.chgPctReported}%（本页用 昨收 现算，两者不一致即为口径漂移）`],
      ['数据源代码', esc(q.code)],
    ])),
  ];
  const anchors = (GLOB.anchors || []).filter((a) => a.from === key);
  if (anchors.length) {
    lines.push(dwSection('映射到的 A 股方向', anchors.map((a) => `<div class="dw-note"><b>${esc((a.aSectors || []).join(' · '))}</b>（${a.sign > 0 ? '同向' : a.sign < 0 ? '反向' : '结构参考'}）<br>${esc(a.why)}</div>`).join('')));
  }
  if (q.note) lines.push(dwSection('口径说明', `<div class="dw-note">${esc(q.note)}</div>`));
  if (!q.ok) {
    lines.push(q.state === 'preopen'
      ? '<div class="dw-note">⚠ 该会话尚未开盘，数据源给的是**盘前占位**（昨收即最新、开/高/低全 0）。'
        + '故涨跌幅显示「盘前无数据」而非 0% —— <b>0% 是"真的没动"，这里是"还不知道"</b>，两者不可混。</div>'
      : (q.state === 'no-trade'
        ? '<div class="dw-note">⚠ 该会话无成交（数据源为平盘占位），涨跌幅不作数。</div>'
        : '<div class="dw-note">⚠ 本次未取到该品种行情（保持缺失，不写 0）——缺失与「0 波动」是两件事。</div>'));
  }
  return { title: q.name, sub: `外围品种 · ${esc(q.key)} · 会话 ${esc(q.sessionDate || '—')}`, body: lines.join('') };
}

/** 映射条目详情（点映射表打开） */
function globalMapDetail(from) {
  if (!GLOB) return null;
  const a = (GLOB.anchors || []).find((x) => x.from === from);
  if (!a) return null;
  const q = (GLOB.quotes || []).find((x) => x.key === from);
  const t = GLOB.thresholds || {};
  return {
    title: `${q ? q.name : from} → A 股`,
    sub: `映射方向 · ${a.sign > 0 ? '同向' : a.sign < 0 ? '反向' : '结构参考'}`,
    body: dwSection('对应 A 股板块', `<div class="dw-chips">${(a.aSectors || []).map((s) => `<span class="chip">${esc(s)}</span>`).join('')}</div>`)
      + dwSection('为什么这样映射', `<div class="dw-note">${esc(a.why)}</div>`)
      + dwSection('当前值', dwKv([
        ['最新', q ? esc(q.lastText) : '—'],
        ['涨跌幅', q ? `<span class="${trendCls(q.chgPct)}">${esc(q.chgPctText)}</span>` : '—'],
      ]))
      + dwSection('观测阈值', `<div class="dw-note">承压/支撑阈值定义在 src/global.js 的 WATCH_THRESHOLDS，构建期随 data/global.json 下发；本页触发式观测完全按该阈值判定。</div>`)
      + `<div class="dw-note">阈值口径：A50 期货 ±${t.a50Up}% · 费半 -${Math.abs(t.soxDown)}%/+${t.soxUp}% · 纳指 ±${t.ixicUp}% · 中国金龙 -${Math.abs(t.hxcDown)}%/+${t.hxcUp}% · 美元指数 ±${t.dxyUp}% · 离岸人民币 ±${t.rmbDep}%。</div>`,
  };
}

// 展示层过滤：历史回填天（emotion._backfill === true）只有 lhb 与 s_net，
// 六因子未采集，其 emotion.value 是 **s_net 单因子占位值、不是综合分**。
// 若混进走势图/报告，会被读成"那天情绪分只有 12 分"，严重误导。
//
// 唯一去处：把所有消费 all_days 的渲染路径统一改喂本函数的结果，
// 而不是在 15 处调用点各写一遍过滤（漏一处就是一个错误结论）。
// 完整天数（含回填天）仍在 arc.all_days 里，供分位、回测、导出使用。
function displayDays(arc) {
  const all = (arc && arc.all_days) || [];
  return all.filter((d) => !(d.emotion && d.emotion._backfill));
}

function backfillInfo(arc) {
  const all = (arc && arc.all_days) || [];
  const bf = all.filter((d) => d.emotion && d.emotion._backfill);
  if (!bf.length) return null;
  return { count: bf.length, total: all.length, from: bf[0].trade_date, to: bf[bf.length - 1].trade_date };
}

/**
 * 渲染 #loadScope —— 分层加载范围的**唯一披露点**。
 *
 * 为什么单独抽成一个函数：标的池与档案是两条独立的分档链，各自完成时刻不同。
 * 标的池补全完成时若不能单独刷新这块，用户就会一直看到"精简档"过期的说法
 * （或者反过来：只刷一次，补全后还写着"补全中"）。抽出来就可以被任一方重复调用。
 *
 * 两个通道都**必须**如实披露，因为它们都会改变屏幕上数字的含义：
 *   · archive 深度：决定"样本 N 个交易日"里的 N 是 30 还是 241
 *   · 标的池档位：决定个股的板段/最近收盘价是否已就位（板段由代码规则判定，始终可信）
 * 分档本身不是问题，"用户不知道现在是哪一档"才是。
 */
function renderScope(arc) {
  const scope = $('loadScope');
  if (!scope) return;
  const days = (arc && arc.all_days) || [];
  scope.innerHTML = (arc && arc._partial
    ? `<span class="scope-note" title="档案已按年切片，首屏只加载最近 ${days.length} 个交易日的明细；完整档共 ${arc._totalDays} 个交易日">`
      + `⚡ 分层加载：已载入最近 <b>${days.length}</b> / ${arc._totalDays} 个交易日`
      + `<button class="mini" type="button" data-act="loadfull">载入完整档</button></span>`
    : `<span class="scope-note ok">✓ 完整档：${days.length} 个交易日</span>`);
  scope.hidden = false;
}

function renderAll(arc) {
  lastArc = arc; // 供 loadBacktest 完成后按引擎口径重刷报告
  ARC = arc;     // 供个股明细表与详情抽屉使用
  // 也挂到 window（历史：曾供 paper_ui.js 重刷 #loadScope；台面下线后保留只读引用，成本为零）。
  if (typeof window !== 'undefined') window.__lastArc = arc;
  const days = displayDays(arc);
  const latest = days[days.length - 1] || {};
  const meta = arc.meta || {};

  $('tradeDate').textContent = arc.signals?.tradeDate || latest.trade_date || '--';
  const tag = $('sourceTag');
  // 小标签按新口径：离线回放 → DEMO；盘中 → LIVE（实时快照）；滞后 → STALE；否则 LIVE（收盘）
  // 优先级：DEMO > STALE > 盘中 > LIVE。滞后比相位更要紧——数据不新鲜时，
  // 无论此刻是不是盘中，展示的都是过期收盘数据，标 STALE 才不会误导。
  const tagText = meta.source === 'offline-replay' ? 'DEMO'
    : meta.stale ? 'STALE'
      : meta.phase === 'live' ? 'LIVE · 盘中'
        : meta.phase === 'pre' ? 'PRE' : 'LIVE';
  tag.textContent = tagText;
  tag.className = 'tag ' + (tagText === 'STALE' ? 'stale' : tagText.startsWith('LIVE') ? 'live' : '');
  // UTC → 北京时间（2026-10-08 实录：曾直接展示 generatedAt 原文 10:56Z，被误读成
  // 「上午 10:56 盘中快照」，实为本地 18:56 写档）。与上方 freshness 渲染的 +8h 惯例同款。
  {
    const d = meta.generatedAt ? new Date(meta.generatedAt) : null;
    $('genTime').textContent = (d && !Number.isNaN(d.getTime()))
      ? '更新 ' + new Date(d.getTime() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 16)
      : '';
  }

  // 分层加载的**诚实披露**：当前页只加载了最近 N 日明细，"样本 N 个交易日"这类
  // 会随加载深度变化的数字必须显式说明来源，否则读者会把 30 读成 241。
  // 同理，模拟器的标的池也是分档的（首屏只有代码+名称），故一并披露——
  // 分档本身不是问题，"用户不知道现在是哪一档"才是。
  renderScope(arc);

  renderAlerts(meta);
  // 离线/陈旧/降级横幅：与 #alerts 分开——#alerts 说"今天盘面如何"，
  //   本条说"你看到的数据可信到什么程度"。两者语义不同，不能混在一个容器里。
  renderOfflineBar(HEALTH);
  renderEmotion(latest);
  renderRelative(latest);
  renderMomentum(arc.signals?.momentum || {});
  renderTrend(days);
  renderThemes(latest);
  renderHotTable();
  renderBrief(days, arc);
  loadGlobal();  // 外围市场（独立数据文件，缺失不影响上述渲染）
  loadBacktest(); // 回测/帕累托/滚动/主线选股四区块（独立数据文件，缺失不影响上述渲染）
  loadVersionRegression(); // 公式版本对比（独立数据文件；缺失时卡内显示生成命令，不影响其他区块）
  loadHealth(); // 数据健康 + 资金属性 + 亏钱效应（同一份 signals-latest.json，一次 fetch）
  loadIntraday(meta); // 盘中快照（独立数据文件；仅盘中相位且有文件时显示）
  loadAiReportCard(meta); // S3-4 AI 盘中报告卡（归档基座 + live 相位实时替换）
}

// ── 盘中快照卡 ──────────────────────────────────────────────────────────────
// 口径纪律（本卡存在的全部意义）：
//   data/intraday.json 里的每个数值都是**抓取时刻的实时值**，未定盘；而情绪分 / 分位 / 因子
//   是按**收盘值**算的。两者不同尺度，绝不能互相比较。故本卡：
//     ① 只在 meta.phase === 'live' 时显示（收盘后显示会让人以为"收盘了还这么高"）；
//     ② 卡内显著标注抓取时刻与"不参与打分"；
//     ③ 不把任何快照数值喂给其它卡片。
// 文件缺失 / 相位非盘中 → 整卡隐藏（不是显示 0，0 会被读成"涨停 0 家"）。
async function loadIntraday(meta) {
  const card = $('intradayCard'), body = $('intradayBody');
  if (!card || !body) return;
  const phase = (meta || {}).phase;
  if (phase !== 'live') { card.hidden = true; return; }
  let snap = null;
  try {
    const res = await fetch('./data/intraday.json?_=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) { card.hidden = true; return; }
    snap = await res.json();
  } catch { card.hidden = true; return; }
  if (!snap || snap.kind !== 'intraday') { card.hidden = true; return; }

  const n = (v, fix = 1) => (v == null || !Number.isFinite(+v)) ? '—' : (+v).toFixed(fix);
  const i = (v) => (v == null ? '—' : String(v));
  const p = snap.pools || null, b = snap.breadth || null;
  const prev = snap.prevPools || null;
  // 与上一次快照的对比：盘中唯一有意义的"动量"证据（同一尺度下自己跟自己比，安全）
  const delta = (cur, old) => (cur == null || old == null) ? '' :
    cur > old ? ` <span class="idu-up">↑${cur - old}</span>`
      : cur < old ? ` <span class="idu-dn">↓${old - cur}</span>` : ' <span class="muted">持平</span>';

  const rows = [
    ['涨停', p ? i(p.zt) + delta(p.zt, prev && prev.zt) : '—', '触板未封（炸板）', p ? i(p.zb) + delta(p.zb, prev && prev.zb) : '—'],
    ['跌停', p ? i(p.dt) : '—', '封板率', p && p.seal_pct != null ? `<b>${n(p.seal_pct)}%</b>` + delta(p.seal_pct, prev && prev.seal_pct) : '—'],
    ['最高连板', p ? i(p.max_lb) + ' 板' : '—', '2板以上', p ? i(p.lb2) + ' 只' : '—'],
    ['上涨家数', b ? i(b.up) : '—', '下跌家数', b ? i(b.down) : '—'],
  ];

  body.innerHTML =
    `<div class="idu-head">抓取时刻 <b>${esc(snap.capturedAtBJ || '—')}</b>`
    + ` · 强势股 <b>${i(snap.hot && snap.hot.count)}</b> 只`
    + (snap.prevCapturedAtBJ ? ` · 对比 ${esc(snap.prevCapturedAtBJ)}` : '')
    + `<span class="idu-warn">本卡为盘中实时值，未定盘，不参与情绪因子与分位</span></div>`
    + `<table class="idu-tbl"><tbody>${rows.map((r) =>
      `<tr><th>${r[0]}</th><td>${r[1]}</td><th>${r[2]}</th><td>${r[3]}</td></tr>`).join('')}</tbody></table>`
    + `<div class="idu-note">口径：封板率 = 收盘涨停 ÷ 盘中触板（涨停+炸板），与盘后同一算法，但分母随盘中变化。`
    + `快照每 30 分钟刷新；情绪分 / 历史分位 / 七因子仍为上一收盘日口径（未重算），不要把本卡数值与上方分位对比。`
    + (snap.sourcesFailed && snap.sourcesFailed.length
      ? `<br>本次未取到的源：${esc(snap.sourcesFailed.join('；'))}` : '')
    + `</div>`;
  card.hidden = false;
}

// ── S3-1 即时轨展示行（轨道 A 估值 · 快照卡内独立容器）─────────────────────
// 数据源 window.__intradayLive（src/intraday_sampler.js 盘中每 60 秒采样发布，
// 'intraday-live-update' 事件驱动刷新）。口径纪律（与 loadIntraday 同族）：
//   ① 不自行判相位——本行在 #intradayCard 内，收盘/非交易时段整卡隐藏
//     （loadIntraday 的 phase !== 'live' 分支），不会出现"收盘了还跳的实时数字"；
//   ② 采样器待命（锚未加载/实时行情缺）→ 如实显示待命，绝不显示 0 或占位数；
//   ③ 午休/收盘后保留最后采样值并标注时刻——那是最后真实采样，不是"现在"；
//   ④ 估值非结算（basis 在桥数据 valuation 里如实可溯），权益是锚×仓位×指数涨幅。
function renderIntradayLive() {
  const row = $('intradayLiveRow');
  if (!row) return;
  const live = window.__intradayLive;
  if (!live || !live.stats) {
    row.innerHTML = '<span class="idu-warn">轨道A即时估值待采样（估值锚 / 实时行情未就绪）</span>';
    row.hidden = false;
    return;
  }
  const s = live.stats;
  const pct = (v) => (v == null || !Number.isFinite(+v)) ? '—' : ((+v) * 100).toFixed(2) + '%';
  const hhmm = (iso) => { try { return new Date(iso).toTimeString().slice(0, 5); } catch { return '—'; } };
  row.innerHTML =
    `<div class="idu-head"><b>轨道A即时估值</b> 权益 <b>${s.total != null ? (+s.total).toFixed(0) : '—'}</b> 元`
    + ` · 当日回撤 <b>${pct(live.drawdownDaily)}</b>（日内高点）`
    + ` · 总回撤 <b>${pct(s.drawdown)}</b>`
    + ` · 距风控档 <b>${pct(live.ddDistance)}</b>（越过为负）`
    + ` · 采样 <b>${hhmm(live.updatedAt)}</b>`
    + `<span class="idu-warn">估值非结算（昨收锚 × 仓位 × 指数实时涨幅）</span></div>`;
  row.hidden = false;
}
window.addEventListener('intraday-live-update', renderIntradayLive);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', renderIntradayLive);
else renderIntradayLive();

// ── S3-4 AI 盘中报告卡（生成器复用：src/report_card_live.js 挂 window.ReportCardLive）──
// 双态渲染，一个形态：归档基座 + 实时替换。
//   ① 归档基座：data/reports/index.json → 最新 intraday 报告信封 → cardData 投影 → 渲染。
//      与 CI/推送收到的报告同一份 JSON，盘后/非交易也可见（看报告是正当需求，与快照卡不同）；
//   ② phase === 'live' 且桥就绪 → buildLiveReport（6 源 + 桥，任一失败整体降级回 ①）；
//   ③ 降级三态沿用 S3-1：非交易显示归档口径、采样未就绪标注"实时轨待采样"不冒充、
//      午休/收盘后保留最后采样值并标注时刻。
// 数值与"距风控档"永远与报告信封同尺（同一 generateIntraday 产出，卡面零自算）。
let aiReportCardMeta = null;
let aiReportLastLiveBuild = 0;

function renderAiReportCard(d) {
  const card = $('aiReportCard'), body = $('aiReportCardBody');
  if (!card || !body || !d) return;
  const pct = (v, fix = 2) => (v == null || !Number.isFinite(+v)) ? '—' : ((+v) * 100).toFixed(fix) + '%';
  const hhmm = (iso) => { try { return String(iso || '').replace('T', ' ').slice(11, 16); } catch { return '—'; } };
  const st = { ok: 'ok', degraded: '降级', missing: '缺源' }[d.status] || d.status || '—';
  const rows = [
    ['实时权益', d.navRealtime != null ? (+d.navRealtime).toFixed(0) + ' 元' : '—', '当日回撤', pct(d.maxDrawdownDaily)],
    ['总回撤', pct(d.ddNow), '距风控档', d.distancePp != null ? (Number.isFinite(+d.distancePp) ? (+d.distancePp).toFixed(2) + 'pp（越过为负）' : '—') : '—'],
    ['当日', pct(d.pnlDaily), '累计', pct(d.pnlCumulative)],
    ['剧本命中', d.trendSwitchHits != null ? d.trendSwitchHits + ' 次' : '—', '外围', (d.overseas || []).map((q) => `${q.name} ${pct(q.chgPct)}`).join(' · ') || '—'],
  ];
  body.innerHTML =
    `<div class="idu-head">生成 <b>${hhmm(d.generatedAt)}</b> · 状态 <b>${st}</b> · 口径 <b>${esc(d.basis || '—')}</b>`
    + (d.isValuation ? '<span class="idu-warn">实时估值 · 估值非结算（昨收锚 × 仓位 × 指数实时涨幅）</span>' : '<span class="idu-warn">归档口径（CI 落库）</span>')
    + `</div>`
    + `<table class="idu-tbl"><tbody>${rows.map((r) =>
      `<tr><th>${r[0]}</th><td>${r[1]}</td><th>${r[2]}</th><td>${r[3]}</td></tr>`).join('')}</tbody></table>`
    + (d.missingNotes.length
      ? `<div class="idu-note">缺失披露 ${d.missingNotes.length} 条：${d.missingNotes.slice(0, 2).map((n) => esc(n.field)).join('；')}${d.missingNotes.length > 2 ? ' …' : ''}</div>` : '');
  card.hidden = false;
}

/** 实时替换尝试：live 相位 + 桥就绪 → buildLiveReport（60s 节流，与采样同步）。 */
async function tryLiveAiReport() {
  if (!aiReportCardMeta || aiReportCardMeta.phase !== 'live') return; // 收盘/非交易：归档卡不动
  const RCL = window.ReportCardLive;
  if (!RCL || !window.__intradayLive) { // 模块/桥未就绪 → 归档卡 + 待采样标注（不冒充）
    const body = $('aiReportCardBody');
    if (body && !body.querySelector('[data-live-pending]')) {
      body.insertAdjacentHTML('afterbegin', '<div class="idu-head" data-live-pending="1">实时轨待采样（估值锚 / 实时行情未就绪）——以下为最近一期归档报告</div>');
    }
    return;
  }
  const now = Date.now();
  if (now - aiReportLastLiveBuild < 60000) return;
  aiReportLastLiveBuild = now;
  let env = null;
  try { env = await RCL.buildLiveReport(window.__intradayLive); } catch { env = null; } // 整体降级
  const d = env ? RCL.cardData(env) : null;
  if (d) renderAiReportCard(d); // 失败（null）→ 保持归档渲染（不冒充实时）
}

async function loadAiReportCard(meta) {
  const card = $('aiReportCard'), body = $('aiReportCardBody');
  if (!card || !body) return;
  aiReportCardMeta = meta || null;
  // 归档基座：最新一期 CI 报告（fetch 失败 → 整卡隐藏，不显示空壳）
  let env = null;
  try {
    const idx = await loadJson('./data/reports/index.json?_=' + Date.now());
    const f = idx && idx.reports && idx.reports.intraday && idx.reports.intraday.file;
    if (f) env = await loadJson('./data/reports/' + f + '?_=' + Date.now());
  } catch { env = null; }
  const d = (window.ReportCardLive && env) ? window.ReportCardLive.cardData(env) : null;
  if (!d) { card.hidden = true; return; }
  renderAiReportCard(d);
  tryLiveAiReport(); // live 相位才实际替换
}
window.addEventListener('intraday-live-update', () => { tryLiveAiReport(); });

// 拉取档案并渲染全页。返回 {arc, changed, first, hhmm, degraded}；失败抛出。
// 抽成独立函数是为了让「研判报告单独刷新」能复用同一条拉取/指纹链路，
// 而不是各写一份 fetch（两份必然漂移：缓存参数、指纹口径、错误处理都会分叉）。
//
// 加载顺序（首屏 = 索引 + 滚动窗，二档共 ~135KB；对比旧的全量 5.1MB）：
//   ① archive-index.json 10.6KB —— 元信息/相位/新鲜度/逐年摘要/最新日摘要
//   ② archive-recent.json 124KB —— 最新日完整明细（表格与报告要）+ 29 个曲线点（走势图要）
//   ③（按需）archive-YYYY.json —— 抽屉回看更早交易日；④（按需）惰性字段 seats/lhb
async function pullArchive() {
  const idx = await loadJson('./data/archive-index.json');
  INDEX_CACHE = idx;
  // 滚动窗拿到之前就用索引先渲染：相位/新鲜度/情绪分/动量都在索引里，
  // 首屏第一帧不必等明细（明细慢一点只影响表格与报告，不影响"今天什么状态"）。
  const recent = await loadRecent();
  const arc = mergeArc(idx, recent);
  if (!arc.all_days || !arc.all_days.length) throw new Error('档案为空（index.latest 缺失）');
  const fp = fingerprint(arc);
  const changed = lastFp !== '' && fp !== lastFp;
  const first = lastFp === '';
  renderAll(arc); // 先渲染，成功才更新指纹——渲染失败下次轮询自动重试
  lastFp = fp;
  return { arc, changed, first, degraded: !recent, hhmm: new Date().toTimeString().slice(0, 5) };
}

async function checkUpdate(manual) {
  const btn = $('refreshBtn'), st = $('refreshState');
  if (manual && btn) { btn.classList.add('busy'); btn.textContent = '↻ 拉取中…'; }
  try {
    const { changed, first, degraded, hhmm } = await pullArchive();
    clearFatal();
    noteLoad('archive-index', true);
    if (st) {
      if (degraded) { st.textContent = hhmm + ' 明细档未取到（仅摘要）'; st.className = 'err'; }
      else if (changed) { st.textContent = hhmm + ' 数据已更新'; st.className = 'ok'; }
      else if (manual && !first) { st.textContent = hhmm + ' 已是最新'; st.className = 'ok'; }
      else { st.textContent = ''; st.className = ''; }
    }
  } catch (e) {
    // 首屏必需档拿不到 → 走错误边界，**不是把一条红字塞进 #alerts 就算完**：
    //   · 页面不能白屏，也不能继续显示上一次的残留结论（那会被当成今天的）
    //   · 必须明确说"没有数据 ≠ 今天没什么可说的"
    noteLoad('archive-index', false, e);
    if (lastFp === '') {
      $('alerts').innerHTML = '';
      renderFatal(e);
    }
    renderOfflineBar();
    if (st && manual) { st.textContent = '刷新失败: ' + e.message; st.className = 'err'; }
  } finally {
    if (btn) { btn.classList.remove('busy'); btn.textContent = '↻ 刷新'; }
  }
}

// ⚠ 与 RECENT_PROMISE_TTL_MS（滚动窗缓存存活期）耦合：TTL 必须严格小于本值
// （差 30 秒安全边际），否则轮询 tick 时缓存恰好未过期，明细隔轮才刷新（见其注释）。
const POLL_MS = 5 * 60 * 1000; // 每 5 分钟自动检查一次云端档是否更新
checkUpdate(false);
// 中危1（2026-10-07）审计：本页非 SPA（无路由/组件销毁/模块重载），经典脚本仅执行
// 一次——此轮询为页面级单例，随页面卸载由平台整体回收，无需 clearInterval。
setInterval(() => checkUpdate(false), POLL_MS);
$('refreshBtn').addEventListener('click', () => checkUpdate(true));

// ════════════════════════════════════════════════════════════════════
// 交互层：详情抽屉 + 五类详情（个股 / 题材 / 权重组合 / 滚动分段 / 交易日）
// 设计取舍：详情一律走同一个右侧抽屉（不用 alert、不新开页面、不加载额外依赖），
// 抽屉内可继续下钻（题材 → 个股），用栈记录来路并提供返回。
// ════════════════════════════════════════════════════════════════════
const drawerEl = () => $('drawer');
let dwStack = [];
let lastFocus = null;

function dwSection(h, body) {
  return `<div class="dw-sec"><div class="dw-h">${esc(h)}</div>${body}</div>`;
}
function dwKv(pairs) {
  return `<div class="dw-kv">${pairs.map(([k, v]) => `<div class="k">${esc(k)}</div><div class="v">${v}</div>`).join('')}</div>`;
}
function dwBars(rows, unit = '') {
  const max = Math.max(1, ...rows.map((r) => +r[1] || 0));
  return `<div class="dw-bars">${rows.map(([label, v]) => `
    <div>${esc(label)}</div><div class="bar"><i style="width:${((+v || 0) / max * 100).toFixed(1)}%"></i></div>
    <div class="n">${v}${unit}</div>`).join('')}</div>`;
}

function renderDrawer(v) {
  const dw = drawerEl();
  if (!dw) return;
  $('dwTitle').textContent = v.title || '';
  $('dwSub').innerHTML = v.sub || '';
  const back = dwStack.length
    ? '<button class="mini" type="button" data-act="dback" style="margin-bottom:10px">← 返回上级</button>' : '';
  $('dwBody').innerHTML = back + (v.body || '');
  $('dwBody').scrollTop = 0;
}

function openDrawer(v, push = true) {
  const dw = drawerEl();
  if (!dw) return;
  if (push && dw.classList.contains('open')) {
    dwStack.push({ title: $('dwTitle').textContent, sub: $('dwSub').innerHTML, body: $('dwBody').innerHTML.replace(/^<button[^>]*data-act="dback"[^>]*>.*?<\/button>/, '') });
  }
  if (!dw.classList.contains('open')) lastFocus = document.activeElement;
  renderDrawer(v);
  dw.classList.add('open');
  dw.setAttribute('aria-hidden', 'false');
  $('drawerMask')?.classList.add('open');
  document.body.style.overflow = 'hidden';
  $('dwClose')?.focus?.();
}

function closeDrawer() {
  const dw = drawerEl();
  if (!dw || !dw.classList.contains('open')) return;
  dw.classList.remove('open');
  dw.setAttribute('aria-hidden', 'true');
  $('drawerMask')?.classList.remove('open');
  document.body.style.overflow = '';
  dwStack = [];
  if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
}

// ── 席位渲染：买卖双侧表格 + 席位身份下钻 ──
// 席位行可点击（data-act="seat"）→ seatDetail()。之所以整行可点：用户的问题就是
// 「卖方席位能不能点」，所以买方卖方一视同仁，两侧行都挂同一个动作，只是侧别不同。
const SEAT_SIDE_LABEL = { b: '买方', s: '卖方' };

function seatRowsHtml(pairs, sum, side, code) {
  if (!pairs.length) return `<tr><td colspan="4" class="muted">无${SEAT_SIDE_LABEL[side]}席位明细</td></tr>`;
  return pairs.map(([nm, v], i) => {
    const pct = sum ? ((+v || 0) / sum * 100) : null;
    // 排序号 + 金额条形（一眼看出头部集中度），整行可点下钻
    return `<tr class="clickable" data-act="seat" data-code="${esc(code)}" data-side="${side}" data-i="${i}" tabindex="0"`
      + ` title="点击查看该席位身份信息">`
      + `<td class="seat-nm"><span class="seat-badge ${side}">${i + 1}</span>${esc(nm)}</td>`
      + `<td class="num">${(+v || 0).toFixed(0)}</td>`
      + `<td class="num">${pct == null ? '—' : pct.toFixed(1) + '%'}</td>`
      + `<td class="seat-bar"><i class="${side}" style="width:${pct == null ? 0 : Math.min(100, pct * 2).toFixed(1)}%"></i></td>`
      + '</tr>';
  }).join('');
}

// 双侧并排表：买方左、卖方右（PC 两列；窄屏由 CSS 堆叠）
function seatTable(buyRows, sellRows, code, cover) {
  const S = seatsMod();
  const bs = S.sideStats(buyRows), ss = S.sideStats(sellRows);
  const head = (label, st) => `<thead><tr><th>${label}</th><th class="num">金额(万)</th><th class="num">占比</th><th></th></tr></thead>`;
  const foot = (label, st) => st.n
    ? `<div class="dw-note">${label}席位合计 <b>${st.sum.toFixed(0)}</b> 万 · ${st.n} 席`
      + ` · 前 3 席占 ${st.top3Pct == null ? '—' : st.top3Pct.toFixed(1)}%</div>`
    : '';
  return `<div class="seat-grid">`
    + `<div class="seat-col"><div class="seat-cap buy">买方席位（前 5）</div>`
    + `<table class="dw-tb seat-tb">${head('买方席位', bs)}<tbody>${seatRowsHtml(buyRows, bs.sum, 'b', code)}</tbody></table>${foot('买方', bs)}</div>`
    + `<div class="seat-col"><div class="seat-cap sell">卖方席位（前 5）</div>`
    + `<table class="dw-tb seat-tb">${head('卖方席位', ss)}<tbody>${seatRowsHtml(sellRows, ss.sum, 's', code)}</tbody></table>${foot('卖方', ss)}</div>`
    + '</div>'
    + `<div class="dw-note">席位口径：东财龙虎榜逐票买卖前 5 席位（万元）。`
    + (sellRows.length
      ? '买卖双侧均为当日实际成交席位。'
      : '本档为<b>旧格式存档</b>（仅买方），卖方明细自席位升级后开始采集，历史天数无卖方。')
    + `席位覆盖 ${cover ?? '—'}%。点击任一行可查看席位身份。</div>`;
}

// 席位身份下钻：只输出**可从名称直接核验**的结构性事实，不做游资点名归属
function seatDetail(code, side, idx) {
  const days = displayDays(ARC);
  const last = days[days.length - 1] || {};
  const s = last.summary || {};
  const S = seatsMod();
  const pair = S.seatsOf(s.seats?.detail, code);
  const rows = (side === 's' ? pair.s : pair.b).slice().sort((a, b) => (+b[1] || 0) - (+a[1] || 0));
  const row = rows[idx];
  if (!row) return null;
  const [seatName, amount] = row;
  const id = S.seatIdentity(seatName);
  const sideLabel = SEAT_SIDE_LABEL[side] || '买方';
  const st = S.sideStats(rows);
  const share = st.sum ? (+amount || 0) / st.sum * 100 : null;

  const hot = (last.hot || []).find((h) => h.code === code) || null;
  const lhb = (last.lhb_aggr || last.lhb || []).find((l) => l.code === code) || null;
  const stockName = hot?.name || lhb?.name || code;

  // 该席位在**全市场其他上榜股**的同日出现（同一天同一席位买卖多只，是结构性事实）
  const others = [];
  const detailAll = s.seats?.detail || {};
  for (const c of Object.keys(detailAll)) {
    if (c === code) continue;
    const p = S.seatsOf(detailAll, c);
    const hitB = (p.b || []).find((x) => x[0] === seatName);
    const hitS = (p.s || []).find((x) => x[0] === seatName);
    if (hitB || hitS) {
      const nm = (last.hot || []).find((h) => h.code === c)?.name
        || (last.lhb_aggr || last.lhb || []).find((l) => l.code === c)?.name || c;
      others.push({ code: c, name: nm, buy: hitB ? hitB[1] : null, sell: hitS ? hitS[1] : null });
    }
  }

  const head = dwKv([
    ['席位全称', `<b>${esc(seatName)}</b>`],
    ['席位类型', `<b>${esc(id.typeLabel)}</b>${id.foreign ? ' <span class="seat-flag">外资券商</span>' : ''}`],
    ['券商主体', id.broker ? esc(id.broker) : '<span class="muted">—（机构专用/股通类席位无券商主体）</span>'],
    ['所在城市', id.city ? esc(id.city) : '<span class="muted">—（未从名称中识别出城市，可能是省级分公司或名称未含地名）</span>'],
    ['本侧 / 本票', `${sideLabel} · ${esc(stockName)}（${esc(code)}）`],
    ['当日本票金额', `<b>${(+amount || 0).toFixed(0)}</b> 万元`],
    ['占本侧比重', share == null ? '—' : `${share.toFixed(1)}%（该侧前 3 席占 ${st.top3Pct == null ? '—' : st.top3Pct.toFixed(1)}%）`],
    ['本侧席位数', `${st.n} 席`],
  ]);

  const typeNote = {
    inst: '机构专用席位：公募/保险/社保等机构的专用交易通道，<b>不披露具体机构</b>，只能确认"是机构在交易"。',
    north: '沪深股通席位：北向资金（外资经陆股通的集合通道），无法进一步拆分到具体境外机构。',
    prop: '券商总部/自营席位：券商自有资金或以总部名义交易的席位，通常体量较大、方向性强。',
    branch: '分公司席位：省级/地市级分公司归集席，常见于互联网开户与量化通道，<b>单个席位可能是大量散户或程序化资金的混合</b>，不代表单一主体意图。',
    sales: '证券营业部席位：传统营业部通道，可能是散户、游资或量化共用，<b>不能仅凭营业部名断定是某位游资</b>。',
    other: '未能归类到已知席位类型的名称。',
  }[id.type] || '';

  const otherSec = others.length ? dwSection(`同日该席位的其他上榜股（${others.length} 只）`,
    `<table class="dw-tb"><thead><tr><th>股票</th><th class="num">该席位买入(万)</th><th class="num">该席位卖出(万)</th></tr></thead><tbody>`
    + others.slice().sort((a, b) => ((b.buy || 0) + (b.sell || 0)) - ((a.buy || 0) + (a.sell || 0)))
      .map((o) => `<tr class="clickable" data-act="stock" data-code="${esc(o.code)}" tabindex="0">`
        + `<td>${esc(o.name)} <span class="muted">${esc(o.code)}</span></td>`
        + `<td class="num">${o.buy == null ? '—' : o.buy.toFixed(0)}</td>`
        + `<td class="num">${o.sell == null ? '—' : o.sell.toFixed(0)}</td></tr>`).join('')
    + '</tbody></table>'
    + `<div class="dw-note">同一席位同日在多只上榜股出现，说明其当日资金分散在多个标的上（结构性事实，不代表协同或关联）。</div>`)
    : '';

  const body = dwSection('席位身份（从名称可直接核验的信息）', head)
    + (typeNote ? `<div class="dw-note">${typeNote}</div>` : '')
    + otherSec
    + `<div class="dw-note">诚实边界：本页只呈现<b>可从席位名称直接读出</b>的结构性事实（券商主体、席位类型、外资属性、城市）。`
    + `市面上"某营业部=某游资大佬"的名单多数无法核验、且席位会转租换手，故本工具<b>不做</b>此类点名归属——那是猜测，不是数据。</div>`;

  return {
    title: `${seatName.length > 16 ? seatName.slice(0, 16) + '…' : seatName}`,
    sub: `${sideLabel}席位 · ${esc(stockName)}（${esc(code)}）· ${(+amount || 0).toFixed(0)} 万元 · ${esc(id.typeLabel)}`,
    body,
  };
}

// ── ① 个股详情 ──
function stockDetail(code) {
  const days = displayDays(ARC);
  const last = days[days.length - 1] || {};
  const hot = (last.hot || []).find((h) => h.code === code) || null;
  const lhb = (last.lhb_aggr || last.lhb || []).find((l) => l.code === code) || null;
  const s = last.summary || {};
  const S = seatsMod();
  const seatPair = S.seatsOf(s.seats?.detail, code);
  const buyRows = seatPair.b.slice().sort((a, b) => (+b[1] || 0) - (+a[1] || 0));
  const sellRows = seatPair.s.slice().sort((a, b) => (+b[1] || 0) - (+a[1] || 0));
  const hasDetail = buyRows.length || sellRows.length;
  const name = hot?.name || lhb?.name || code;
  const chg = hot?.change_pct ?? lhb?.change_pct ?? null;
  const reason = hot?.reason || lhb?.reason || '';
  const lb = (s.zt_lb || {})[code] ?? null;
  const isZt = (s.zt_codes || []).includes(code);
  const isNew = /无价格涨跌幅限制/.test(reason);

  const quote = [
    ['代码', `<b>${esc(code)}</b>`],
    ['名称', `<b>${esc(name)}</b>`],
    ['现价', (hot?.close ?? lhb?.close) != null ? `${hot?.close ?? lhb?.close} 元` : '—'],
    ['当日涨跌幅', `<span class="${trendCls(chg)}">${pctOf2(chg)}</span>`],
    ['换手率', (hot?.huanshou ?? lhb?.turnover_pct) != null ? `${hot?.huanshou ?? lhb?.turnover_pct}%` : '—'],
    ['涨停/连板', isZt ? `涨停${lb ? `（${lb} 连板）` : ''}` : (lb ? `${lb} 板` : '未涨停')],
    ['数据日期', esc(last.trade_date || '—')],
  ];

  const lhbSec = lhb ? dwKv([
    ['龙虎净买', `<span class="${trendCls(lhb.net_buy_wan)}">${yiOf(lhb.net_buy_wan)} 亿</span>`],
    ['买入额', `${yiOf(lhb.buy_wan)} 亿`],
    ['卖出额', `${yiOf(lhb.sell_wan)} 亿`],
    ['买卖总额', `${yiOf((lhb.buy_wan || 0) + (lhb.sell_wan || 0))} 亿`],
    // 口径透明：区间累计榜的数值是区间累计值，读者必须知道自己在看哪一个数
    ['榜单口径', lhb.caliber === 'range'
      ? '<span class="bf-warn">区间累计榜</span>（连续 N 个交易日累计值，非当日；不计入当日净买率）'
      : '当日榜（当日席位买卖，权威口径）'],
    ['上榜席位', hasDetail
      ? `${buyRows.length} 买方 / ${sellRows.length} 卖方（点击任一行查看席位身份）`
      : '无明细'],
  ]) : '<div class="dw-empty">该股当日未上龙虎榜（无资金明细）</div>';

  const seatSec = hasDetail ? dwSection('买卖双侧席位明细（东财龙虎榜口径）',
    seatTable(buyRows, sellRows, code, s.seats?.cover))
    : (lhb ? dwSection('买卖双侧席位明细（东财龙虎榜口径）',
      `<div class="dw-empty">该股无席位明细。${seatPair.hasSell === false && s.seats?.detail ? '（本档为旧格式存档，仅存买方席位，卖方明细自本次升级后开始采集）' : ''}</div>`) : '');

  const themes = Object.keys(last.themes || {}).filter((t) => reason.includes(t) && t.length >= 2);
  const themeSec = themes.length
    ? dwSection('所属题材（按诱因文本匹配）',
      `<div class="dw-chips">${themes.map((t) => `<span class="chip click" data-act="theme" data-theme="${esc(t)}" tabindex="0">${esc(t)}</span>`).join('')}</div>`)
    : '';

  const hist = days.slice(-5).map((d) => {
    const h = (d.hot || []).find((x) => x.code === code) || null;
    const l = (d.lhb_aggr || d.lhb || []).find((x) => x.code === code) || null;
    return { date: d.trade_date, chg: h?.change_pct ?? l?.change_pct ?? null, net: l?.net_buy_wan ?? null, inLhb: !!l };
  });
  const histSec = dwSection('近 5 个交易日记录',
    `<table class="dw-tb"><thead><tr><th>交易日</th><th class="num">涨跌幅</th><th class="num">龙虎净买(亿)</th><th>上榜</th></tr></thead><tbody>`
    + hist.map((x) => `<tr><td>${esc(x.date)}</td><td class="num ${trendCls(x.chg)}">${pctOf2(x.chg)}</td>`
      + `<td class="num ${trendCls(x.net)}">${x.net == null ? '—' : yiOf(x.net)}</td>`
      + `<td class="muted">${x.inLhb ? '龙虎榜' : '未上榜'}</td></tr>`).join('')
    + '</tbody></table>');

  const ml = BT?.mainLine || {};
  const inMain = (ml.mains || []).find((m) => (m.stocks || []).some((x) => x.code === code));

  const body = dwSection('行情与状态', dwKv(quote))
    + dwSection('龙虎榜资金', lhbSec)
    + seatSec
    + themeSec
    + histSec
    + (inMain ? dwSection('主线归属', `<div class="dw-kv"><div class="k">主线题材</div><div class="v"><span class="chip click" data-act="theme" data-theme="${esc(inMain.theme)}" tabindex="0">${esc(inMain.theme)}</span>（强度分 ${inMain.mainScore}，当日涨停 ${inMain.themeCount} 只）</div></div>`) : '')
    + `<div class="dw-note">诱因：${esc(reason || '—')}${isNew ? '（<b>独立新股</b>：上市首 5 日无涨跌幅限制，其资金不宜直接计入主线强度）' : ''}</div>`;

  return {
    title: `${name}　${code}`,
    sub: `当日 ${pctOf2(chg)} · 龙虎净买 ${lhb ? yiOf(lhb.net_buy_wan) + ' 亿' : '—'} · 数据 ${last.trade_date || '—'}`,
    body,
  };
}

// ── ② 题材详情 ──
function themeDetail(theme) {
  const days = displayDays(ARC);
  const last = days[days.length - 1] || {};
  const th = last.themes || {};
  const cnt = th[theme] ?? null;
  const total = Object.values(th).reduce((a, b) => a + b, 0) || 1;
  const density = cnt == null ? null : cnt / total;
  const mainScore = cnt == null ? null : Math.round(cnt * density * 100) / 100;
  const hotStocks = (last.hot || []).filter((h) => String(h.reason || '').includes(theme));
  const ztLb = last.summary?.zt_lb || {};
  const ml = (BT?.mainLine?.mains || []).find((m) => m.theme === theme) || null;

  const head = dwKv([
    ['题材', `<b>${esc(theme)}</b>`],
    ['当日涨停', cnt == null ? '—' : `${cnt} 只`],
    ['密集度', density == null ? '—' : `${(density * 100).toFixed(2)}%（该题材涨停 ÷ 当日全题材涨停）`],
    ['主线强度分', mainScore == null ? '—' : `<b>${mainScore}</b>（涨停家数 × 密集度，与引擎 selectMainLine 同式）`],
    ['是否当日主线', ml ? `是（引擎自动选出标的 ${ml.stockCount} 只）` : '否（未进入引擎主线名单）'],
    ['数据日期', esc(last.trade_date || '—')],
  ]);

  const stockSec = dwSection(`成分股（热点榜诱因含「${theme}」，按涨幅降序）`,
    hotStocks.length
      ? `<table class="dw-tb"><thead><tr><th>代码</th><th>名称</th><th class="num">涨幅</th><th class="num">连板</th></tr></thead><tbody>`
        + hotStocks.slice().sort((a, b) => (b.change_pct || 0) - (a.change_pct || 0))
          .map((h) => `<tr class="clickable" data-act="stock" data-code="${esc(h.code)}" tabindex="0">`
            + `<td>${esc(h.code)}</td><td>${esc(h.name)}</td>`
            + `<td class="num ${trendCls(h.change_pct)}">${pctOf2(h.change_pct)}</td>`
            + `<td class="num">${ztLb[h.code] ? ztLb[h.code] + '板' : '—'}</td></tr>`).join('')
        + '</tbody></table>'
      : '<div class="dw-empty">当日热点榜中没有诱因含该题材的个股（可能只贡献涨停数、未进热点榜）</div>');

  const hist5 = days.slice(-5).map((d) => [d.trade_date.slice(5), (d.themes || {})[theme] ?? 0]);
  const histSec = dwSection('近 5 个交易日涨停家数', dwBars(hist5, ' 只'));

  return {
    title: `题材　${theme}`,
    sub: cnt == null ? '当日无该题材记录' : `当日涨停 ${cnt} 只 · 密集度 ${(density * 100).toFixed(1)}% · 强度分 ${mainScore}`,
    body: dwSection('题材概况', head) + stockSec + histSec
      + '<div class="dw-note">口径：题材归属来自东财榜单诱因文本；密集度＝该题材涨停数 ÷ 当日全题材涨停数；成分股为热点榜中诱因含该题材的个股，与「主线自动选股」卡同源。</div>',
  };
}

// ── 回测完整参数与口径（策略回测卡的「查看完整参数与口径」）──
const FACTOR_LAB = { s_net: '龙虎榜净额', s_pos: '涨跌家数', s_brd: '板块涨比', s_hot: '涨停强度', s_zdt: '涨跌停对比', s_zbl: '封板质量', s_amt: '量能' };

function btDetail() {
  const m = BT?.meta || {}, P = BT?.params || {}, v52 = P.v52 || {}, th = P.thresholds || TH_DEFAULT;
  const s = BT?.series || {};
  const dates = s.dates || [];
  const base = BT?.base || {}, cur = BT?.v52 || {};
  const d = (a, b, isPct, invert) => {
    if (a == null || b == null || !Number.isFinite(+a) || !Number.isFinite(+b)) return '—';
    const diff = +b - +a;
    const good = invert ? diff < 0 : diff > 0;
    const txt = isPct ? `${(diff * 100).toFixed(2)}pp` : diff.toFixed(2);
    // 颜色按中文语境：改善用红（hl），恶化用绿（hl-dn）——与涨跌配色一致
    return `<span class="${diff === 0 ? 'muted' : good ? 'hl' : 'hl-dn'}">${diff > 0 ? '+' : ''}${txt}</span>`;
  };
  return {
    title: '策略回测 · 完整参数与口径',
    sub: `${m.days || 0} 个交易日（${dates[0] || '—'} ~ ${dates.slice(-1)[0] || '—'}）· 标的 ${(m.assets || []).join(' / ')} · 版本 ${m.formulaVersion || '—'}`,
    body: dwSection('样本与标的', dwKv([
      ['样本区间', esc(`${dates[0] || '—'} ~ ${dates.slice(-1)[0] || '—'}`)],
      ['交易日数', `${m.days || 0} 个（本样本量下年化/夏普统计意义有限）`],
      ['标的', esc((m.assets || []).join(' / '))],
      ['组合方式', '各标的独立按同规则回测 → 日收益等权合成'],
    ]))
      + dwSection('信号口径', `<div class="dw-kv"><div class="k">信号</div><div class="v">${esc(m.signal || '—')}</div></div>`
        + `<div class="dw-note">七因子权重：${Object.entries(FACTOR_LAB).map(([k, v]) => `${v}`).join(' / ')}（取值见 src/config.js）。</div>`)
      + dwSection('交易成本（按仓位变动幅度计提）', dwKv([
        ['佣金', `${(v52.comm != null ? (v52.comm * 1e4).toFixed(2) : '—')}‱（双边）`],
        ['印花税', `${(v52.stamp != null ? (v52.stamp * 1e4).toFixed(2) : '—')}‱（仅卖出）`],
        ['滑点', `${(v52.slip != null ? (v52.slip * 1e4).toFixed(2) : '—')}‱（单边）`],
        ['原始口径', esc(m.costNote || '—')],
      ]))
      + dwSection('风控与仓位约束', dwKv([
        ['最大仓位', numS(v52.maxPos, 2)],
        ['单笔止损', pctS(v52.stopLoss, 0) || '—'],
        ['动态降仓', `回撤 ≥${pctS(v52.ddTrigger, 0) || '—'} 压至 40%（0.6 倍阈值处降至 70%）`],
        ['单日仓位变动', `≤ ${numS(v52.maxPosChg, 2)}`],
      ]))
      + dwSection('阈值（收盘打分、T+1 生效）', dwKv([
        ['过热（只减不新建）', `≥ ${numS(th.overheat, 0)}`],
        ['满仓', `≥ ${numS(th.lo, 0)}`],
        ['半仓', `${numS(th.panic, 0)} ~ ${numS(th.lo, 0)}`],
        ['清仓', `≤ ${numS(th.panic, 0)}`],
        ['hi 参数', `${numS(th.hi, 0)}（保留参数，引擎 positions() 判档未使用）`],
      ]))
      + dwSection('V5.2 相对 V5 基准的变化', dwKv([
        ['年化收益', `${pctS(base.annual, 2)} → ${pctS(cur.annual, 2)}（${d(base.annual, cur.annual, true, false)}）`],
        ['最大回撤', `${pctS(base.maxDd, 2)} → ${pctS(cur.maxDd, 2)}（${d(base.maxDd, cur.maxDd, true, true)}，红=回撤变小）`],
        ['夏普', `${numS(base.sharpe)} → ${numS(cur.sharpe)}（${d(base.sharpe, cur.sharpe, false, false)}）`],
        ['空仓占比', `${pctS(base.emptyRatio, 1)} → ${pctS(cur.emptyRatio, 1)}`],
      ]))
      + dwSection('口径自检', dwKv([
        ['情绪分口径偏差', `${m.weightDrift ?? '—'}（页面权重重算 vs 存档总分，来自四舍五入）`],
        ['口径备注', esc(m.caveat || '—')],
      ]))
      + `<div class="dw-note">本面板用于管线自检与参数对比，<b>不构成投资建议</b>；样本仅 ${m.days || 0} 个交易日，年化/夏普不具统计意义。</div>`,
  };
}

// ── ③ 权重组合详情（帕累托表行）──
function weightDetail(i) {
  const rows = BT?.pareto?.rows || [];
  const r = rows[i];
  if (!r) return null;
  const bt = BT?.params?.v52 || {};
  const base = BT?.rolling?.base?.segments?.[0]?.w || null;   // 固定权重口径即基准权重
  const best = BT?.best || null;
  const isBest = !!(best && r.sharpe === best.sharpe && r.maxDd === best.maxDd);

  const wRows = Object.entries(r.w || {}).map(([k, v]) => {
    const b = base?.[k];
    const gap = (b == null) ? '' : `<span class="${v > b ? 'hl' : v < b ? 'hl-dn' : 'muted'}">${v > b ? '+' : ''}${((v - b) * 100).toFixed(2)}pp</span>`;
    return `<tr><td>${esc(FACTOR_LAB[k] || k)}</td><td class="num">${(v * 100).toFixed(2)}%</td><td class="num">${b == null ? '—' : (b * 100).toFixed(2) + '%'}</td><td class="num">${gap || '—'}</td></tr>`;
  }).join('');

  const perf = [
    ['夏普比率', numS(r.sharpe), r.sharpe >= 1 ? '好（>1）' : r.sharpe > 0 ? '一般（0~1）' : '为负——该组合在本样本不赚钱'],
    ['最大回撤', pctS(r.maxDd, 2), '越小越好'],
    ['Calmar', numS(r.calmar), '年化 ÷ 最大回撤'],
    ['年化收益', pctS(r.annual, 2), '按 242 交易日年化'],
    ['区间总收益', pctS(r.total, 2), '样本区间累计'],
    ['持仓日胜率', pctS(r.winRate, 1), '有仓位日里上涨占比'],
    ['空仓占比', pctS(r.emptyRatio, 1), '被阈值判为清仓的天数占比'],
  ].map(([k, v, note]) => `<div class="k">${esc(k)}</div><div class="v"><b>${esc(v)}</b> <span class="muted">${esc(note)}</span></div>`).join('');

  return {
    title: `权重组合 #${i + 1}`,
    sub: `夏普 ${numS(r.sharpe)} · 最大回撤 ${pctS(r.maxDd, 2)} · ${r.np ? '位于帕累托前沿（非支配）' : '被支配（有组合在夏普与回撤上均不差）'}`
      + (isBest ? ' · 同时是最优解' : ''),
    body: dwSection('7 因子权重（与基准权重对比）',
      `<table class="dw-tb"><thead><tr><th>因子</th><th class="num">本组合</th><th class="num">基准</th><th class="num">差异</th></tr></thead><tbody>${wRows}</tbody></table>`
      + `<div class="dw-note">权重均为归一化后的占比；基准＝固定权重口径（= src/config.js 权重）。</div>`)
      + dwSection('绩效明细', `<div class="dw-kv">${perf}</div>`)
      + dwSection('该组合的实盘约束（全部网格共用）', dwKv([
        ['止损', pctS(bt.stopLoss, 0) || '—'],
        ['回撤降仓', `≥${pctS(bt.ddTrigger, 0) || '—'} 压至 40%`],
        ['单日仓位变动', `≤ ${numS(bt.maxPosChg, 2)}`],
      ]))
      + '<div class="dw-note">样本仅 32 个交易日，年化/夏普的统计意义有限，仅用于管线自检与参数对比，不构成投资建议。</div>',
  };
}

// ── ④ 滚动分段详情 ──
function segDetail(kind, i) {
  const R = BT?.rolling || {};
  const seg = (R[kind]?.segments || [])[i];
  if (!seg) return null;
  const other = (R[kind === 'base' ? 'refit' : 'base']?.segments || [])[i] || null;
  const wRows = Object.entries(seg.w || {}).map(([k, v]) => {
    const o = other?.w?.[k];
    const gap = o == null ? '' : `<span class="${v > o ? 'hl' : v < o ? 'hl-dn' : 'muted'}">${v > o ? '+' : ''}${((v - o) * 100).toFixed(2)}pp</span>`;
    return `<tr><td>${esc(FACTOR_LAB[k] || k)}</td><td class="num">${(v * 100).toFixed(2)}%</td><td class="num">${o == null ? '—' : (o * 100).toFixed(2) + '%'}</td><td class="num">${gap || '—'}</td></tr>`;
  }).join('');

  return {
    title: `滚动段 ${seg.testStart} ~ ${seg.testEnd}`,
    sub: `${kind === 'base' ? '固定权重' : '逐窗重寻优'}口径 · 训练窗 ${seg.trainDays} 日 / 测试窗 ${seg.testDays} 日 · 总收益 ${pctS(seg.total, 2)}`,
    body: dwSection('该段绩效', dwKv([
      ['测试区间', esc(`${seg.testStart} ~ ${seg.testEnd}`)],
      ['训练窗 / 测试窗', `${seg.trainDays} / ${seg.testDays} 日`],
      ['区间总收益', `<span class="${trendCls(seg.total)}">${pctS(seg.total, 2)}</span>`],
      ['夏普（段内）', numS(seg.sharpe)],
      ['最大回撤（段内）', pctS(seg.maxDd, 2)],
    ]))
      + dwSection('该段权重（与另一口径对比）',
        `<table class="dw-tb"><thead><tr><th>因子</th><th class="num">${kind === 'base' ? '固定' : '重寻优'}</th><th class="num">${kind === 'base' ? '重寻优' : '固定'}</th><th class="num">差异</th></tr></thead><tbody>${wRows}</tbody></table>`
        + `<div class="dw-note">「重寻优」用该段训练窗重新做网格寻优后再评测试窗；固定口径全程用基准权重。两者若一致，说明该段重寻优没有换权重。</div>`)
      + '<div class="dw-note">段内夏普波动极大（2 段样本），单段结果不具统计意义，仅供观察管线行为。</div>',
  };
}

// ── ⑤ 交易日详情（趋势图数据点）──
function dayDetail(i) {
  const days = displayDays(ARC);
  const d = days[i];
  if (!d) return null;
  const s = d.summary || {};
  const e = d.emotion || {};
  const up = s.up_count, dn = s.down_count;
  const redPct = (up != null && dn != null && up + dn > 0) ? (up / (up + dn) * 100) : null;
  const idx = d.indexes || {};
  const th = d.themes || {};
  const top = Object.entries(th).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const tier = posTier(e.value, getThresholds());
  // 历史档的 summary 并非每天都完整（如 9-08 无涨跌家数/领涨行业）——如实说明，避免用户把「—」读成「当日为零」
  const miss = [];
  if (up == null || dn == null) miss.push('涨跌家数');
  if (s.amount_yi == null) miss.push('两市成交额');
  if (!s.top_industry) miss.push('领涨行业');

  return {
    title: `${d.trade_date} 盘面`,
    sub: `情绪分 ${nf(e.value)}（分位 ${nf(e.pct_rank)}%）${tier ? ` · 档位 ${tier.label}` : ''} · 当日龙虎净买 ${nf(s.lhb_daily_net)} 亿`,
    body: dwSection('情绪与档位', dwKv([
      ['情绪分', `<b>${nf(e.value)}</b>${e.pct_rank != null ? `（历史分位 ${e.pct_rank}%）` : ''}`],
      ['仓位档位', tier ? `<b>${esc(tier.label)}</b> → ${esc(tier.pos)}` : '—'],
      ['因子缺失', (e.missing || []).length ? `<span class="bf-warn">${esc(e.missing.join('、'))}</span>` : '无'],
    ]))
      + dwSection('涨跌与量能', dwKv([
        ['涨停 / 跌停', `${nf(s.zt_count)} / ${nf(s.dt_count)}`],
        ['封板率', s.seal_pct != null ? `${s.seal_pct}%（涨停 ${nf(s.zt_count)} ÷ 触板 ${nf(s.seal_den)} 只，炸板 ${nf(s.zb_count)} 只＝${s.zb_pct ?? '—'}%）` : (s.zbl_pct != null ? `${s.zbl_pct}%（旧档：字段名为炸板率口径）` : '—')],
        ['连板高标', s.max_lb != null ? `${s.max_lb} 板（2 板以上 ${nf(s.lb2_count)} 只）` : '—'],
        ['涨跌家数', up != null ? `${up} / ${dn}（红盘 ${redPct != null ? redPct.toFixed(0) + '%' : '—'}）` : '—'],
        ['两市成交额', s.amount_yi != null ? `${s.amount_yi} 亿` : '—'],
        // 两套口径都列出并标明用途：只显示一个数就是「读者无从判断口径」，混用往往就是这么发生的
        ['龙虎榜·当日榜', `上榜 ${nf(s.lhb_daily_stocks)} 只 · 净买 ${nf(s.lhb_daily_net)} 亿 · 成交 ${nf(s.lhb_daily_amt)} 亿（日度因子/净买率/新股扰动用此口径）`],
        ['龙虎榜·全量', `上榜 ${nf(s.lhb_stocks ?? s.lhb_count)} 只 · 净买 ${nf(s.lhb_all_net)} 亿（含 ${nf(s.lhb_range_count)} 条区间累计榜，仅诊断，勿与当日值混用）`],
        ['领涨行业', esc(s.top_industry || '—')],
      ]))
      + dwSection('指数表现', dwKv(Object.entries(idx).map(([k, v]) => [k, `<span class="${trendCls(v)}">${pctOf2(v)}</span>`])))
      + dwSection('当日题材（前 6）', top.length
        ? `<div class="dw-chips">${top.map(([t, c]) => `<span class="chip click" data-act="theme" data-theme="${esc(t)}" tabindex="0">${esc(t)} ${c}</span>`).join('')}</div>`
        : '<div class="dw-empty">无题材数据</div>')
      + (miss.length ? `<div class="dw-note">⚠ 该日存档缺 ${esc(miss.join('、'))}（历史档未回填），上方对应项显示为 —，不代表当日为零。</div>` : '')
      + '<div class="dw-note">该日数据来自存档 all_days；情绪分与档位口径同页面与回测引擎。</div>',
  };
}

// ── 惰性字段的异步开抽屉 ──────────────────────────────────────────────────
// 目前唯一的惰性字段是 `lhb`（原始榜），而个股/席位抽屉**展示层不用它**（用 lhb_aggr），
// 故这两个抽屉无需等待。保留此封装是为了"以后若真有首屏不用的字段"时有统一入口，
// 而不是在 15 个点击处各写一份"先 ensureLazy 再渲染"。
async function openStockDetail(code) {
  const v = stockDetail(code);
  if (v) openDrawer(v);
}

async function openSeatDetail(code, side, idx) {
  const v = seatDetail(code, side, idx);
  if (v) openDrawer(v);
}

/** 当前 ARC 是否还有指定惰性字段未补齐。 */
function needsLazy(field) {
  if (lazyWanted.has(field)) return false;
  const lazy = (INDEX_CACHE && INDEX_CACHE.lazy) || null;
  if (!lazy || !(field in lazy)) return false; // 该档无此字段（如历史档），无需拉
  return !lazyValuePresent(displayDays(ARC), field);
}
// needsLazy 供"以后新增惰性字段"时复用；当前唯一惰性字段 lhb 不在展示路径上，
// 故本函数暂无调用点 —— 保留而非删除，是为了让后来者一眼看到判定入口在哪。
void needsLazy;

/**
 * 从年分片最新日的惰性槽（_sub.lhb，rc 码表压缩态）现算 lhb_aggr。
 * 口径与切片侧（src/archive_split.js::buildRecent 注入 aggregateByCode）逐字同构：
 * decodeRc（码表 = 分片顶层 meta.reasonCodes，loadFull 随行带回）→ aggregateByCode
 * （src/lhb.js 纯函数，经典脚本动态 import）。2026-10-07 实测：79 条原始 → 66 条
 * 聚合，与切片侧产物**逐位一致**（tmp 验证脚本）。任何一步缺料/失败 → null，
 * 调用方如实披露，不冒充。
 */
async function aggregateLhbFromSub(day, reasonCodes) {
  try {
    const raw = Array.isArray(day && day.lhb) ? day.lhb
      : (day && day._sub && Array.isArray(day._sub.lhb)) ? day._sub.lhb : [];
    if (!raw.length || !Array.isArray(reasonCodes)) return null;
    // decodeRcRows 同款（src/archive_split.js 内联实现，逐字对齐）：rc 下标 → 明文
    // reasons。不解码直接聚合会产出 reasons:[null] → 新股标记全部失配（切片侧
    // 注释里实测红过的坑，不再踩）。
    const decoded = raw.map((l) => {
      if (!l || !Array.isArray(l.rc)) return l;
      const reasons = l.rc.map((i) => reasonCodes[i]).filter((x) => typeof x === 'string');
      const { rc, ...rest } = l;
      return { ...rest, reasons, reason: reasons[0] ?? '—' };
    });
    const { aggregateByCode } = await import('./src/lhb.js');
    return aggregateByCode(decoded);
  } catch {
    return null; // 动态 import 失败（如离线且 sw 未缓存 src/lhb.js）→ 调用方披露
  }
}

/**
 * 用户显式请求"完整档"：拉全部年份分片（几 MB），用完整 all_days 重渲染。
 *
 * 这是三档里的最后一档，**只在用户点按钮时**发生——绝不能因为"反正都拉一次"
 * 就顺手在首屏拉上，那样分层就白做了。
 */
async function loadFullArchive(btn) {
  if (btn) { btn.disabled = true; btn.textContent = '载入中…'; }
  try {
    // 修复（2026-10-07 · 龙虎榜资金栏空档）：年分片按体积纪律不存 lhb_aggr（主档
    // 241 天全存 +4.2MB 体积翻倍，只在滚动窗切片最新日现算，见 src/archive_split.js
    // 的体积纪律注），整替 all_days 会把滚动窗 latest 的 lhb_aggr 一起丢掉 →
    // 龙虎榜资金视图（hotRows 取 last.lhb_aggr || last.lhb）双空。装载侧兜底两层：
    //   ① 继承：替换前 ARC 的最后一天 = 滚动窗 latest（切片侧已现算 lhb_aggr），
    //      年分片最新日日期一致 → 直接继承，零重算零请求；
    //   ② 现算：日期不一致（滚动窗比年分片新，如盘中 recent 刚更新）→ 从 _sub.lhb
    //      现算（aggregateLhbFromSub，与切片侧同口径）。两层都落空 → 如实披露。
    const prevDays = displayDays(ARC);
    const prevLast = prevDays[prevDays.length - 1] || null;
    const inherit = (prevLast && Array.isArray(prevLast.lhb_aggr))
      ? { date: prevLast.trade_date, rows: prevLast.lhb_aggr } : null;
    const full = await loadFull(INDEX_CACHE || lastArc, (INDEX_CACHE || lastArc)?.years);
    const days = full.days;
    if (!days.length) throw new Error('分片为空');
    const last = days[days.length - 1];
    if (last && !Array.isArray(last.lhb_aggr)) {
      let rows = (inherit && inherit.date === last.trade_date) ? inherit.rows : null;
      if (!rows) rows = await aggregateLhbFromSub(last, full.latestReasonCodes);
      if (rows) {
        days[days.length - 1] = { ...last, lhb_aggr: rows };
      } else {
        const scope = $('loadScope');
        if (scope) scope.insertAdjacentHTML('beforeend', ` <span class="bf-warn">龙虎榜资金：该日原始榜缺失，无法聚合（显示为空 ≠ 无数据）</span>`);
      }
    }
    RECENT_CACHE = { days };
    const merged = mergeArc(INDEX_CACHE || lastArc, null);
    merged.all_days = days;
    merged._partial = false;
    renderAll(merged);
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = '载入失败，重试'; }
    // 失败不改数据：仍留在首屏那 30 天上的**部分视图**（诚实标注），而不是清空页面
    const scope = $('loadScope');
    if (scope) scope.insertAdjacentHTML('beforeend', ` <span class="bf-warn">完整档载入失败：${esc(e.message)}</span>`);
  }
}

// ── 事件委托：一处处理全部点击/键盘，避免逐元素绑定 ──
function fireAct(el) {
  const act = el.dataset.act;
  if (act === 'stock') { openStockDetail(el.dataset.code); return; }
  else if (act === 'seat') { openSeatDetail(el.dataset.code, el.dataset.side, +el.dataset.i); return; }
  else if (act === 'theme') openDrawer(themeDetail(el.dataset.theme));
  else if (act === 'wrow') { const v = weightDetail(+el.dataset.i); if (v) openDrawer(v); }
  else if (act === 'seg') { const v = segDetail(el.dataset.kind, +el.dataset.i); if (v) openDrawer(v); }
  else if (act === 'day') { const v = dayDetail(+el.dataset.i); if (v) openDrawer(v); }
  else if (act === 'loadfull') { loadFullArchive(el); }
  else if (act === 'retry-boot') { clearFatal(); checkUpdate(true); return; }
  else if (act === 'btmore') { const v = btDetail(); if (v) openDrawer(v); }
  else if (act === 'glob') { const v = globalDetail(el.dataset.key); if (v) openDrawer(v); }
  else if (act === 'gmap') { const v = globalMapDetail(el.dataset.from); if (v) openDrawer(v); }
  else if (act === 'btpt') {
    const dt = el.dataset.d;
    const days = displayDays(ARC);
    const i = days.findIndex((x) => x.trade_date === dt);
    const v = i >= 0 ? dayDetail(i) : null;
    if (v) { openDrawer({ ...v, sub: `净值曲线数据点 · ${v.sub}` }); return; }
    // 两种"找不到"必须分开说 —— 混成一句话会让用户按错的指引去排查：
    //   ① 在完整档里、只是当前只加载了最近 N 日 → 可一键补全（分层加载的正常代价）
    //   ② 连完整档都没有 → 回测档与存档真的不同步，得重跑回测
    const inFull = (INDEX_CACHE?.yearMeta?.length)
      ? Object.entries(INDEX_CACHE.yearMeta).some(([y, m]) => m && dt >= m.from && dt <= m.to)
      : null;
    const partial = !!(ARC._partial);
    // title 仍带「盘面」——**空态也要与命中态同名同栏目**。
    // 曾把空态 title 写成裸日期，结果读者（与守卫）无法从标题看出"这是当日盘面、
    // 只是没加载"，只能读正文才知道——标题就该承担这个信息。
    const reachable = partial && inFull !== false;
    openDrawer({
      title: `${dt || '未知日期'} 盘面`,
      sub: reachable
        ? `净值曲线数据点 · 该日暂未载入（分层加载）`
        : `净值曲线数据点 · 不在当前存档`,
      body: reachable
        ? `<div class="dw-empty">该交易日不在当前已加载的 <b>${days.length}</b> 个交易日内`
          + `（档案共 ${ARC._totalDays} 个交易日，首屏为省流量只载入最近 ${days.length} 日）。</div>`
          + `<button class="mini" type="button" data-act="loadfull">载入完整档后再看</button>`
        : '<div class="dw-empty">该日期不在当前存档 all_days 中（回测档与存档可能不同步，重跑 <b>node scripts/backtest.mjs</b> 即可对齐）。</div>',
    });
  }
  else if (act === 'brsec') {
    const sec = document.getElementById(el.dataset.t);
    if (sec) {
      sec.classList.remove('collapsed');
      if (typeof sec.scrollIntoView === 'function') sec.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  } else if (act === 'dback') {
    const prev = dwStack.pop();
    if (prev) renderDrawer(prev);
  } else if (act === 'bftoggle') {
    const sec = el.parentElement;
    if (sec && sec.classList.contains('bf-sec')) {
      sec.classList.toggle('collapsed');
      el.setAttribute('aria-expanded', sec.classList.contains('collapsed') ? 'false' : 'true');
    }
    syncBriefToggleLabel();
  }
}

document.addEventListener('click', (e) => {
  const t = e.target;
  if (!t || typeof t.closest !== 'function') return;

  const viewBtn = t.closest('#hotTabs button');
  if (viewBtn) { setHotView(viewBtn.dataset.view); return; }

  const th = t.closest('th[data-sort]');
  if (th) {
    const k = th.dataset.sort;
    HOT_STATE = { ...HOT_STATE, key: k, dir: HOT_STATE.key === k ? -HOT_STATE.dir : -1 };
    renderHotTable();
    return;
  }

  const zn = t.closest('.zn[data-zone]');
  if (zn) {
    const z = document.getElementById(zn.dataset.zone);
    if (z && typeof z.scrollIntoView === 'function') z.scrollIntoView({ block: 'start', behavior: 'smooth' });
    e.preventDefault();
    return;
  }

  // 明日跟踪项复选框（模板④）：纯屏幕交互，**不写回任何数据**。
  // 刻意不持久化——跟踪项是"当日看盘清单"，次日报告会重新生成一份新清单，
  // 隔日残留的勾选比没勾更误导（读者会以为某项已核对过，其实换了一天）。
  const todo = t.closest('#briefBody .bf-todo');
  if (todo) {
    todo.classList.toggle('done');
    todo.setAttribute('aria-checked', todo.classList.contains('done') ? 'true' : 'false');
    return;
  }

  const actEl = t.closest('[data-act]');
  if (actEl) fireAct(actEl);
});

// 抽屉自身：关闭按钮 / 遮罩
$('dwClose')?.addEventListener('click', closeDrawer);
$('drawerMask')?.addEventListener('click', closeDrawer);

// 键盘：Esc 关抽屉；Enter/Space 触发带 tabindex 的可点元素（表格行、卡片、chip、数据点）；
// PC 端另有快捷键：1-5 跳分区、/ 聚焦个股搜索（在输入框内不抢键，不影响正常打字）
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeDrawer(); closeExportMenu(); return; }
  const t = e.target;
  const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const zones = [...document.querySelectorAll('#zoneNav .zn[data-zone]')];
    // 数字键与分区一一对应（顺序即导航顺序），不写死上界——加分区时快捷键自动跟上
    const n = e.key >= '1' && e.key <= '9' ? Number(e.key) - 1 : -1;
    if (n >= 0 && zones[n]) { e.preventDefault(); zones[n].click(); return; }
    if (e.key === '/') {
      const inp = $('hotSearch');
      if (inp) {
        e.preventDefault();
        const z = document.getElementById('zone-detail');
        if (z && typeof z.scrollIntoView === 'function') z.scrollIntoView({ block: 'start', behavior: 'smooth' });
        inp.focus();
        return;
      }
    }
  }
  if (e.key !== 'Enter' && e.key !== ' ') return;
  if (!t || typeof t.closest !== 'function') return;
  // 明日跟踪项复选框：键盘 Enter/空格 与鼠标点击等价（两项共用同一个 class 切换）
  const todo = t.closest('#briefBody .bf-todo');
  if (todo) {
    e.preventDefault();
    todo.classList.toggle('done');
    todo.setAttribute('aria-checked', todo.classList.contains('done') ? 'true' : 'false');
    return;
  }
  const el = t.closest('[data-act]');
  if (el && typeof el.click === 'function') { e.preventDefault(); el.click(); }
});

// 个股表搜索（本地筛选，防抖 150ms；不请求网络）
let searchTimer = null;
$('hotSearch')?.addEventListener('input', (e) => {
  const v = e.target.value || '';
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { HOT_STATE = { ...HOT_STATE, q: v }; renderHotTable(); }, 150);
});

// 窄屏排序控件（卡片模式没有表头可点，改由此处的下拉 + 方向钮排序，与表头共用 HOT_STATE）
$('hotSortSel')?.addEventListener('change', (e) => {
  HOT_STATE = { ...HOT_STATE, key: e.target.value, dir: -1 };
  renderHotTable();
});
$('hotSortDir')?.addEventListener('click', () => {
  HOT_STATE = { ...HOT_STATE, dir: -HOT_STATE.dir };
  renderHotTable();
});

// 报告：一键折叠/展开（逐段折叠由 document 委托的 bftoggle 处理，两处不重复绑定）
$('briefToggle')?.addEventListener('click', () => {
  const secs = [...document.querySelectorAll('#briefBody .bf-sec')];
  const anyOpen = secs.some((s) => !s.classList.contains('collapsed'));
  for (const s of secs) {
    s.classList.toggle('collapsed', anyOpen);
    const h = s.querySelector('.bf-h');
    if (h) h.setAttribute('aria-expanded', anyOpen ? 'false' : 'true');
  }
  syncBriefToggleLabel();
});

// ── 报告：复制全文 / 导出文档 / 打印 ──
// 三者都消费同一份东西——**屏幕上已经渲染出来的报告 DOM**（#briefBody）。
// 刻意不重新计算任何指标：若导出另写一套字符串拼接，数字与口径迟早和屏幕漂移，
// 用户就会发现"看到的"和"导出的"对不上。这里只做格式转换（引擎见 src/report.js）。

/** 导出引擎由 index.html 的模块脚本挂到 window（app.js 是经典脚本，不能 import） */
const RPT = () => window.ReportExport || null;

/** 引擎尚未挂载时提示，而不是静默失败 */
function needRpt() {
  const r = RPT();
  if (!r) { alert('导出引擎尚未就绪（页面可能被离线打开）。请刷新后重试。'); return null; }
  return r;
}

function currentReport() {
  const r = RPT();
  if (!r) return null;
  return r.parseReport($('briefBody'));
}

/**
 * 审计闸门的「下游守卫」：报告未通过质检时，导出/复制/打印一律拒绝。
 * 原因：闸门只挡住了屏幕显示，但导出按钮读的是 #briefBody——若不禁，用户点导出
 * 仍可能拿到一份内容（这时候 #briefBody 里只有审计面板，导出来的是个空壳文档）。
 * 统一在这里拦，三个入口共享同一判据，不会各写一遍。
 * @returns {boolean} true 表示放行
 */
function guardAudited(btn) {
  const a = window.__briefAudit;
  if (a && a.pass === false) {
    flashBtn(btn, '未通过质检');
    const st = $('briefAuditState');
    if (st) { st.textContent = '报告未通过出厂质检，已阻止导出——修复后点「重试质检」'; st.className = 'err'; }
    return false;
  }
  return true;
}

/** 导出的落款信息统一在这里取，三处输出保持一致 */
function reportOpts() {
  const _dd = displayDays(ARC); const d = _dd[_dd.length - 1] || {};
  const dataDate = (ARC && ARC.meta && ARC.meta.tradeDate) || d.trade_date || '';
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const generatedAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return { dataDate, generatedAt, issueNo: briefIssueNo(), url: location.origin + location.pathname };
}

/**
 * 简报编号的期号：`〔YYYY〕第 N 号`。
 *
 * 口径说明（与报告口径同一纪律——**不编造，现算且同源**）：
 *   期号取「本档案里等于数据日期那一天的序号」，与「样本 N 个交易日」同源（都是 ARC.all_days）。
 *   取不到时返回 undefined，由导出层退化为「第 1 号」——
 *   宁可给一个明确的缺省值，也不要显示一个凭空编出来的期号。
 */
function briefIssueNo() {
  const days = displayDays(ARC);
  const d = days[days.length - 1] || {};
  const dataDate = (ARC && ARC.meta && ARC.meta.tradeDate) || d.trade_date || '';
  const i = days.findIndex((x) => x && x.trade_date === dataDate);
  return i >= 0 ? i + 1 : undefined;
}

/** 下载一个文本文件（报告/数据导出共用的同一套做法） */
function downloadText(text, filename, mime) {
  const blob = new Blob([text], { type: mime + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** 按钮反馈：短暂把按钮文案换成结果提示（比 alert 轻，不打断阅读） */
function flashBtn(btn, text, ms = 1600) {
  if (!btn) return;
  const old = btn.dataset.label || btn.textContent;
  btn.dataset.label = old;
  btn.textContent = text;
  btn.disabled = true;
  setTimeout(() => { btn.textContent = btn.dataset.label; btn.disabled = false; }, ms);
}

// ════════════════════════════════════════════════════════════════════════════
// 数据导出（CSV / Excel）—— 导出件必须与屏幕同源
//
// 核心纪律：**前端一行取数逻辑都不写**。全部走 src/dataset.js 的 DATASETS 目录，
// 前端只做三件事：把当前档位交给它、拿到文本、触发下载。
// 一旦在前端另写一套（"这个字段其实就在 ARC 里，直接 map 一下"），导出件与页面
// 就会慢慢分叉——而下载下来的表格看起来最正式，最不会被怀疑。
// ════════════════════════════════════════════════════════════════════════════
let DS = null;      // src/dataset.js（ESM 桥接）
let GLOB_REF = null; // 外围行情档（导出 global 数据集用；与 loadGlobal 同一次 fetch）

function dsMod() {
  return (typeof window !== 'undefined' && window.DatasetExport) || DS || null;
}

/** 导出上下文：与屏幕同源的那几份数据 */
function exportCtx() {
  return { archive: ARC, signals: SIGNALS, global: GLOB_REF };
}

/**
 * 导出菜单内容：把 DATASETS 目录渲染成菜单项 + 各表行数。
 * ⚠ 行数为 0 的项**不隐藏**（隐藏会让人以为"没有这个数据集"），而是禁用 +
 *   标注「暂无数据」——如实说明"这个数据集存在，只是今天没有内容"。
 */
function renderExportMenu() {
  const menu = $('expMenu');
  if (!menu) return;
  const M = dsMod();
  if (!M || typeof M.exportManifest !== 'function') {
    menu.innerHTML = `<div class="exp-empty muted">导出引擎未就绪（src/dataset.js 未加载）。</div>`;
    return;
  }
  const list = M.exportManifest(exportCtx());
  const items = list.map((it) => `<button type="button" role="menuitem" data-ds="${esc(it.id)}"`
    + `${it.empty ? ' disabled' : ''} title="${esc(it.empty ? '该数据集今天没有内容' : '导出 ' + it.label)}">`
    + `<span class="exp-lab">${esc(it.label)}</span>`
    + `<span class="exp-num muted">${it.empty ? '暂无数据' : it.count + ' 行'}</span></button>`).join('');
  menu.innerHTML = `<div class="exp-hint muted">导出件与屏幕同源（同一份档、同一套取数）。空单元格＝未计算，不等于 0。</div>`
    + items
    + `<div class="exp-sep"></div>`
    + `<button type="button" role="menuitem" data-ds="__csv"${list.every((x) => x.empty) ? ' disabled' : ''}>`
    + `<span class="exp-lab">全部导出（CSV 单表）</span><span class="exp-num muted">合并版</span></button>`
    + `<button type="button" role="menuitem" data-ds="__xls"${list.every((x) => x.empty) ? ' disabled' : ''}>`
    + `<span class="exp-lab">全部导出（Excel 多表页）</span><span class="exp-num muted">.xls</span></button>`;
}

function closeExportAllMenu() {
  const m = $('expMenu'), b = $('expBtn');
  if (m) m.hidden = true;
  if (b) b.setAttribute('aria-expanded', 'false');
}

/** CSV 里多个数据集用空行分隔 + 二级标题行拼接（单表兼容性最好）。 */
function combinedCsvText(M, ids, ctx) {
  const parts = [];
  for (const id of ids) {
    const one = M.exportAsCsv(id, ctx);
    if (!one) continue;
    parts.push(`### ${one.label}（${one.count} 行）`);
    parts.push(one.text.replace(/^\uFEFF/, ''));
  }
  return '\uFEFF' + parts.join('\r\n') + '\r\n';
}

/**
 * 执行导出。
 * @param {string} what 数据集 id，或 '__csv' / '__xls'
 * @param {HTMLElement} btn 触发按钮（用于反馈）
 */
function doExportDataset(what, btn) {
  const M = dsMod();
  if (!M) { flashBtn(btn, '导出引擎未就绪'); return; }
  if (!ARC) { flashBtn(btn, '无数据可导出'); return; }
  const ctx = exportCtx();
  try {
    if (what === '__csv') {
      const ids = M.DATASETS.map((d) => d.id);
      const text = combinedCsvText(M, ids, ctx);
      const stamp = (ARC.meta && ARC.meta.tradeDate) || '';
      downloadText(text, M.datasetFileName('sentiment-all', 'csv', stamp), 'text/csv');
      flashBtn(btn, '已导出 CSV ✓');
    } else if (what === '__xls') {
      const ids = M.DATASETS.map((d) => d.id);
      const out = M.exportAsExcel(ids, ctx);
      if (!out) { flashBtn(btn, '无数据可导出'); return; }
      downloadText(out.text, out.fileName, out.mime);
      flashBtn(btn, '已导出 Excel ✓');
    } else {
      const one = M.exportAsCsv(what, ctx);
      if (!one) { flashBtn(btn, '未知数据集'); return; }
      if (one.empty) { flashBtn(btn, '该表暂无数据'); return; }
      downloadText(one.text, one.fileName, one.mime);
      flashBtn(btn, '已导出 ✓');
    }
  } catch (e) {
    flashBtn(btn, '导出失败：' + e.message);
  }
}

if ($('expBtn') && $('expMenu')) {
  $('expBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const m = $('expMenu');
    if (!m) return;
    if (m.hidden) renderExportMenu();
    m.hidden = !m.hidden;
    e.currentTarget.setAttribute('aria-expanded', m.hidden ? 'false' : 'true');
  });
  $('expMenu').addEventListener('click', (e) => {
    const item = e.target.closest('button[data-ds]');
    if (!item || item.disabled) return;
    e.stopPropagation();
    closeExportAllMenu();
    doExportDataset(item.dataset.ds, $('expBtn'));
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest?.('.exp-wrap')) closeExportAllMenu();
  });
}

/** 复制全文：优先 Clipboard API；不可用（非 https / 旧浏览器）回退 execCommand */
async function doCopyBrief(btn) {
  const R = needRpt();
  if (!R) return;
  if (!guardAudited(btn)) return;
  const rep = currentReport();
  if (!rep || !rep.sections.length) { flashBtn(btn, '报告未就绪'); return; }
  const text = R.toPlainText(rep, reportOpts());
  const ok = await copyToClipboard(text);
  flashBtn(btn, ok ? '已复制 ✓' : '复制失败');
}

/** 剪贴板：navigator.clipboard 在 http/localhost 之外不可用，必须有兜底 */
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* 落到下面的兜底 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) {
    return false;
  }
}

/** 导出文档：html（正式可打印）/ md（知识库）/ txt（邮件记事本） */
function doExportBrief(fmt, btn) {
  const R = needRpt();
  if (!R) return;
  if (!guardAudited(btn)) return;
  const rep = currentReport();
  if (!rep || !rep.sections.length) { flashBtn(btn, '报告未就绪'); return; }
  const o = reportOpts();
  if (fmt === 'md') {
    downloadText(R.toMarkdown(rep, o), R.reportFileName(o.dataDate, 'md'), 'text/markdown');
    flashBtn(btn, '已导出 MD ✓');
  } else if (fmt === 'txt') {
    downloadText(R.toPlainText(rep, o), R.reportFileName(o.dataDate, 'txt'), 'text/plain');
    flashBtn(btn, '已导出 TXT ✓');
  } else {
    downloadText(R.toStandaloneHtml(rep, o), R.reportFileName(o.dataDate, 'html'), 'text/html');
    flashBtn(btn, '已导出文档 ✓');
  }
}

/**
 * 打印：走独立打印窗口而不是给当前页加 @media print。
 * 原因：本页是深色看板、且报告只是六个分区之一——直接打印整页要么打印出一堆用不上的卡片，
 * 要么得写一大段 print 样式去逐块隐藏。而导出引擎已经能产出**自包含的正式文档 HTML**，
 * 把它塞进隐藏 iframe 打印，版式就是「导出文档」那一版，与用户下载到的完全一致。
 */
function doPrintBrief(btn) {
  const R = needRpt();
  if (!R) return;
  if (!guardAudited(btn)) return;
  const rep = currentReport();
  if (!rep || !rep.sections.length) { flashBtn(btn, '报告未就绪'); return; }
  const html = R.toStandaloneHtml(rep, reportOpts());

  const old = $('briefPrintFrame');
  if (old) old.remove();
  const frame = document.createElement('iframe');
  frame.id = 'briefPrintFrame';
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(frame);

  const doc = frame.contentDocument || frame.contentWindow?.document;
  if (!doc) { flashBtn(btn, '打印不可用'); frame.remove(); return; }
  doc.open();
  doc.write(html);
  doc.close();

  // 等 iframe 里的文档解析完再打印；打印结束后清理（onload 在 write 后可能不触发，故双保险）
  const go = () => {
    try {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    } catch (e) {
      flashBtn(btn, '打印被拦截');
    }
    // 打印对话框是阻塞的，这里通常在用户关闭后才执行到
    setTimeout(() => frame.remove(), 60000);
  };
  if (doc.readyState === 'complete') setTimeout(go, 60);
  else frame.addEventListener('load', () => setTimeout(go, 60), { once: true });
}

/** 导出菜单开合：点按钮切换、点菜单项执行并收起、点外面也收起 */
function closeExportMenu() {
  const m = $('briefExportMenu'), b = $('briefExport');
  if (m) m.hidden = true;
  if (b) b.setAttribute('aria-expanded', 'false');
}

$('briefCopy')?.addEventListener('click', (e) => doCopyBrief(e.currentTarget));
$('briefPrint')?.addEventListener('click', (e) => doPrintBrief(e.currentTarget));
$('briefAuditRetry')?.addEventListener('click', (e) => retryBriefAudit(e.currentTarget));

// ── 研判报告单独刷新 ──────────────────────────────────────────────────────
// 与顶栏「↻ 刷新」的区别：顶栏刷新会重算整页（行情/题材/回测/模拟交易全部重渲染），
// 在只需要最新研判时成本高、且会打断用户当前的阅读位置与折叠状态。
// 本按钮**只重建报告**：重新拉 archive → 重建报告（外加报告依赖的回测档，
// 因为报告落款版本/档位阈值取自 data/backtest.json）。
// 保留折叠状态：渲染前记录已折叠段落 id，**所有**重渲染结束（含 loadBacktest 内部的
// 二次 renderBrief）之后再还原——否则先还原、后被覆盖，等于没还原（真浏览器抓到过）。
// 状态如实告知：数据有变→「已更新」；无变→「已是最新」；失败→「刷新失败」+ 原因。
async function doRefreshBrief(btn) {
  if (btn) { btn.classList.add('busy'); btn.textContent = '↻ 拉取中…'; btn.disabled = true; }
  const st = $('briefRefreshState');
  const collapsed = new Set([...document.querySelectorAll('#briefBody .bf-sec.collapsed')].map((s) => s.id));
  try {
    const { changed, first, hhmm } = await pullArchive(); // 内部 renderAll → renderBrief（第 1 次）
    // 报告依赖回测档（落款版本/档位阈值）——loadBacktest 成功后会**再调一次 renderBrief**（第 2 次），
    // 故必须等它结束再还原折叠态，否则刚还原就被覆盖。失败不回滚报告（显示为降级态）。
    try { await loadBacktest(); } catch { /* 回测档缺失不影响报告主体 */ }
    // 所有重渲染都结束，此时才还原折叠状态
    for (const id of collapsed) {
      const el = id && document.getElementById(id);
      if (el && el.classList.contains('bf-sec')) el.classList.add('collapsed');
    }
    syncBriefToggleLabel();
    // 说明：这里**不**调 window.scrollTo 还原滚动位置——只替换 #briefBody 的 innerHTML，
    // 文档高度基本不变，浏览器会自然保持视口；而 window.scrollTo 在 jsdom 下会触发
    // 「Not implemented」jsdomError，污染「运行期无 JS 异常」断言（本项目的滚动一律走
    // 元素的 scrollIntoView 并做存在性守卫，见锚点跳转）。
    if (st) {
      if (changed) { st.textContent = hhmm + ' 报告已更新'; st.className = 'ok'; }
      else if (!first) { st.textContent = hhmm + ' 已是最新'; st.className = 'ok'; }
      else { st.textContent = hhmm + ' 已生成'; st.className = 'ok'; }
    }
  } catch (e) {
    if (st) { st.textContent = '刷新失败：' + e.message; st.className = 'err'; }
  } finally {
    if (btn) { btn.classList.remove('busy'); btn.textContent = '↻ 刷新报告'; btn.disabled = false; }
  }
}
$('briefRefresh')?.addEventListener('click', (e) => doRefreshBrief(e.currentTarget));
$('briefRefresh')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doRefreshBrief(e.currentTarget); }
});

$('briefExport')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const m = $('briefExportMenu');
  if (!m) return;
  m.hidden = !m.hidden;
  e.currentTarget.setAttribute('aria-expanded', m.hidden ? 'false' : 'true');
});
$('briefExportMenu')?.addEventListener('click', (e) => {
  const item = e.target.closest('button[data-fmt]');
  if (!item) return;
  e.stopPropagation();
  closeExportMenu();
  doExportBrief(item.dataset.fmt, $('briefExport'));
});
// 点页面其他地方收起导出菜单（Esc 由主键盘处理器统一处理，见下方 closeDrawer 之前）
document.addEventListener('click', (e) => {
  if (!e.target.closest?.('.bf-exp')) closeExportMenu();
});

// 分区导航高亮 + 回到顶部（滚动节流：只在帧间计算一次）
let rafPending = false;
function onScroll() {
  if (rafPending) return;
  rafPending = true;
  const run = () => {
    rafPending = false;
    const y = window.scrollY || window.pageYOffset || 0;
    $('toTop')?.classList.toggle('show', y > 420);
    const zones = [...document.querySelectorAll('.zone')];
    let cur = zones[0]?.id || '';
    for (const z of zones) {
      if (z.getBoundingClientRect) {
        const top = z.getBoundingClientRect().top || 0;
        if (top <= 70) cur = z.id;
      }
    }
    for (const a of document.querySelectorAll('#zoneNav .zn[data-zone]')) {
      a.classList.toggle('on', a.dataset.zone === cur);
    }
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else run();
}
window.addEventListener('scroll', onScroll, { passive: true });
$('toTop')?.addEventListener('click', () => {
  if (typeof window.scrollTo === 'function') window.scrollTo({ top: 0, behavior: 'smooth' });
});
