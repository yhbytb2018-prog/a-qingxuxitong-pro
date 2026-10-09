// 离线看盘：Service Worker 的策略判定（纯函数部分）。
//
// ── 为什么策略要抽成纯函数 ────────────────────────────────────────────────────
// Service Worker 内部的逻辑在测试里**很难真跑**（需要 SW 运行环境）。若把
// "哪些文件走缓存优先、哪些走网络优先"直接写在 sw.js 的 if/else 里，就只能靠
// 读源码"看起来对"。而这条策略恰恰是最容易写错、错了最难发现的：
//   · 把数据文件也做成缓存优先 → 用户永远看到旧数据（最严重，且页面看不出异常）
//   · 把外壳也做成网络优先 → 断网时连页面骨架都起不来，离线看盘完全失效
// 故策略集中在本模块，sw.js 只做"读 URL → 问策略 → 执行"。策略本身可单测。
//
// ── 两条截然不同的策略 ────────────────────────────────────────────────────────
//   shell（外壳：HTML/JS/CSS/SW 自身）→ **预缓存 + 缓存优先**
//     外壳版本由 CACHE_VERSION 显式控制；断网时必须能起来，所以缓存优先。
//     代价：改了 app.js 不 bump 版本会看到旧的。故 CACHE_VERSION 是唯一开关，
//     且运行时用 self.skipWaiting() + clients.claim() 让新 SW 立刻接管。
//   data（data/*.json）→ **网络优先 + 回退缓存**（network-first）
//     A 股数据一天一变，缓存优先会让"今天打开看到昨天的"成为常态。
//     断网时回退到最近一次成功缓存的那一份，并在页面上显式标注「离线」。
//     绝不因离线就用空数据——宁可显示旧数据 + 明确标注。

export const CACHE_VERSION = 'v2';
export const SHELL_CACHE = `aspro-shell-${CACHE_VERSION}`;
export const DATA_CACHE = `aspro-data-${CACHE_VERSION}`;

/**
 * 预缓存外壳清单。
 *
 * ⚠ 必须显式列出：SW 的 fetch 拦截只在**页面已经受控之后**才生效，首次访问时
 *   若不在 install 里主动 cache.addAll，断网重开会白屏。故这里不能偷懒。
 * ⚠ 刻意**不含** data/*.json：数据文件太大（主档 4.6MB）且时效敏感，
 *   让它们在首次真正请求时按需入缓存（见 DATA_PREFETCH 的轻量清单）。
 */
export const SHELL_ASSETS = Object.freeze([
  './',
  './index.html',
  './app.js',
  './style.css',
  './src/report.js',
  './src/report_audit.js',
  './src/seats.js',
  './src/paper.js',
  './src/quote.js',
  './src/intraday_live.js',
  './src/intraday_sampler.js',
  './src/ai_report.js',
  './src/lhbfilter.js',
  './src/lhb.js',
  './src/report_card_live.js',
  // H-1（2026-10-07）：导出引擎 / 双轨披露 / 错误边界——index.html 内联 module 引用，
  // 但此前不在预缓存里：SW 的 cache-first 兜底会把 JS 请求落到 index.html（HTML 顶替
  // JS 响应），离线时这三块能力静默失效。与 sw.js / deploy-pages.yml（paths + cp）同步改。
  './src/dataset.js',
  './src/dual_track.js',
  './src/error_boundary.js',
]);

/**
 * 首屏之后主动预取的轻量数据档（断网时"看得起来"的最小集合）。
 * 只挑小文件：index 12KB + signals 23KB + recent 247KB ≈ 282KB。
 * 年分片（数百 KB ~ 4MB）不预取——它们只在用户主动回看时才需要。
 */
export const DATA_PREFETCH = Object.freeze([
  './data/archive-index.json',
  './data/signals-latest.json',
  './data/archive-recent.json',
]);

/** URL → 分类。返回 'shell' | 'data' | 'other'。 */
export function classifyRequest(rawUrl) {
  let p;
  try {
    p = new URL(String(rawUrl), 'http://localhost/').pathname;
  } catch {
    return 'other';
  }
  if (/\/data\/.*\.json$/.test(p)) return 'data';
  if (/\.(?:html|js|mjs|css|svg|png|jpg|jpeg|webp|ico|woff2?)$/.test(p)) return 'shell';
  if (p === '/' || /\/$/.test(p)) return 'shell';
  return 'other';
}

/**
 * 策略判定。
 * @returns {{kind:'shell'|'data'|'other', strategy:'cache-first'|'network-first'|'passthrough', cacheName:string|null, allowOffline:boolean}}
 *
 * ⚠ **只处理 GET**。POST 等一律 passthrough：SW 缓存 POST 响应是错误且危险的
 *   （同一 URL 不同 body 会互相覆盖）。
 * ⚠ 跨域请求（如腾讯行情 qt.gtimg.cn）一律 passthrough：本项目对行情源的态度是
 *   "要么拿到真实价、要么明确说拿不到"，绝不用缓存价冒充实时价去给模拟盘成交。
 */
export function strategyFor(method, rawUrl, opts = {}) {
  const m = String(method || 'GET').toUpperCase();
  if (m !== 'GET') {
    return { kind: 'other', strategy: 'passthrough', cacheName: null, allowOffline: false };
  }
  if (opts.crossOrigin) {
    return { kind: 'other', strategy: 'passthrough', cacheName: null, allowOffline: false };
  }
  const kind = classifyRequest(rawUrl);
  if (kind === 'data') {
    return { kind, strategy: 'network-first', cacheName: DATA_CACHE, allowOffline: true };
  }
  if (kind === 'shell') {
    return { kind, strategy: 'cache-first', cacheName: SHELL_CACHE, allowOffline: true };
  }
  return { kind, strategy: 'passthrough', cacheName: null, allowOffline: false };
}

/** 去掉缓存键上的 `?_=时间戳`（前端为防缓存加了它，会让同一文件占多份缓存）。 */
export function cacheKeyOf(rawUrl) {
  try {
    const u = new URL(String(rawUrl), 'http://localhost/');
    u.search = '';
    return u.pathname;
  } catch {
    return String(rawUrl || '').split('?')[0];
  }
}

/** 旧版本缓存名 → 需要删除的一批（activate 时清理）。 */
export function staleCaches(allNames, keep = [SHELL_CACHE, DATA_CACHE]) {
  const names = Array.isArray(allNames) ? allNames : [];
  const keepSet = new Set(keep);
  return names.filter((n) => /^aspro-(?:shell|data)-/.test(n) && !keepSet.has(n));
}

/**
 * 离线回退时，页面该显示什么"数据日期"。
 *
 * ⚠ 这是离线看盘最容易骗人的地方：缓存里的 index 带着 tradeDate，若直接显示它
 *   而不说明"这是缓存"，读者会以为行情是当下的。故一并返回 cacheAge 语义。
 */
export function offlineFallbackInfo(cachedIndex, frame = {}) {
  const meta = (cachedIndex && cachedIndex.meta) || {};
  const tradeDate = meta.tradeDate || (cachedIndex && cachedIndex.latestDate) || null;
  return {
    offline: true,
    tradeDate,
    generatedAt: meta.generatedAt || null,
    since: frame.offlineSince || null,
    // 给页面的一句话，必须包含"不再更新"这层语义
    note: tradeDate
      ? `离线模式：展示 ${tradeDate} 收盘口径的缓存数据，不会再自动更新。`
      : '离线模式：没有可用的缓存数据。',
  };
}

/**
 * 判断两份 index 是否"同一档"——用于决定离线时是否要提示"有更新"。
 * 只看 tradeDate 与生成时刻：比整个对象哈希便宜，且这两个字段任一变化都意味着
 * 数据真的更了（generatedAt 变了但 tradeDate 没变＝同一天的补抓，也值得提示）。
 */
export function sameSnapshot(a, b) {
  const ka = [(a && a.meta && a.meta.tradeDate) || a?.latestDate || '',
    (a && a.meta && a.meta.generatedAt) || ''].join('|');
  const kb = [(b && b.meta && b.meta.tradeDate) || b?.latestDate || '',
    (b && b.meta && b.meta.generatedAt) || ''].join('|');
  return ka === kb;
}

/** Service Worker 是否可注册（环境能力判定，便于在 jsdom/旧浏览器里安全跳过）。 */
export function canRegister(env) {
  const e = env || {};
  return !!(e.serviceWorker && e.serviceWorker.register);
}
