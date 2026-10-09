// Service Worker：离线看盘。
//
// 目标只有一个：**断网时能看上一档**——把"打不开页面看上涨了还是跌了"变成
// "看到的是最近一次成功缓存的数据，并且页面明确告诉我这是哪一档"。
//
// ⚠ 本文件不做策略决策：所有"哪些走缓存优先、哪些走网络优先"的判定都在
//   src/offline.js（纯函数、可单测）。这里只负责"读 URL → 问策略 → 执行"。
//   分层的理由见 src/offline.js 顶部注释（SW 逻辑在测试里真跑不起来）。
//
// ⚠ 刻意**不在 SW 里 import 模块**：经典 Service Worker（非 module worker）在
//   部分浏览器（尤其较旧的移动端 WebView）不支持 importScripts 加载 ESM。
//   故把需要的那几个常量与方法**内联复制**在这里，并在 CI 守卫里断言两边一致
//   （scripts/check_offline_sync.mjs）——复制能保证兼容性，守卫能保证不分叉。
//   这是全项目唯一一处刻意的代码重复，理由与看门狗都在注释里。

// 版本号语义：SW 更新由「本文件字节变化」触发（浏览器对主脚本做 byte-diff），版本号
// 只命名缓存、不参与触发——源文件保持 'v2'（test/offline.test.mjs 断言本行与
// src/offline.js 一致）。部署链（deploy-pages.yml）会在产物上注入 commit hash（如
// 'v2-95a5fbc'）保证每次部署字节必变：install 必重跑、外壳全量重 add，activate 按
// /^aspro-(?:shell|data)-/ 前缀清掉旧版本名（任意版本串兼容）。
const CACHE_VERSION = 'v2';
const SHELL_CACHE = `aspro-shell-${CACHE_VERSION}`;
const DATA_CACHE = `aspro-data-${CACHE_VERSION}`;

const SHELL_ASSETS = [
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
  // H-1（2026-10-07）：同 src/offline.js 的 SHELL_ASSETS——本文件是其内联副本，
  // test/offline.test.mjs ⑤ 断言两边逐项一致，必须同步改。
  './src/dataset.js',
  './src/dual_track.js',
  './src/error_boundary.js',
];

const DATA_PREFETCH = [
  './data/archive-index.json',
  './data/signals-latest.json',
  './data/archive-recent.json',
];

function classifyRequest(rawUrl) {
  let p;
  try {
    p = new URL(String(rawUrl), self.location.origin).pathname;
  } catch {
    return 'other';
  }
  if (/\/data\/.*\.json$/.test(p)) return 'data';
  if (/\.(?:html|js|mjs|css|svg|png|jpg|jpeg|webp|ico|woff2?)$/.test(p)) return 'shell';
  if (p === '/' || /\/$/.test(p)) return 'shell';
  return 'other';
}

function cacheKeyOf(rawUrl) {
  try {
    const u = new URL(String(rawUrl), self.location.origin);
    u.search = '';
    return u.pathname;
  } catch {
    return String(rawUrl || '').split('?')[0];
  }
}

function strategyFor(method, rawUrl, opts) {
  const o = opts || {};
  const m = String(method || 'GET').toUpperCase();
  if (m !== 'GET') return { kind: 'other', strategy: 'passthrough', cacheName: null, allowOffline: false };
  if (o.crossOrigin) return { kind: 'other', strategy: 'passthrough', cacheName: null, allowOffline: false };
  const kind = classifyRequest(rawUrl);
  if (kind === 'data') return { kind, strategy: 'network-first', cacheName: DATA_CACHE, allowOffline: true };
  if (kind === 'shell') return { kind, strategy: 'cache-first', cacheName: SHELL_CACHE, allowOffline: true };
  return { kind, strategy: 'passthrough', cacheName: null, allowOffline: false };
}

function staleCaches(allNames, keep) {
  const names = Array.isArray(allNames) ? allNames : [];
  const keepSet = new Set(keep || [SHELL_CACHE, DATA_CACHE]);
  return names.filter((n) => /^aspro-(?:shell|data)-/.test(n) && !keepSet.has(n));
}

// ── install：预缓存外壳（断网可启动的前提），并预取三个轻量数据档 ──────────────
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    // 逐个 add：一个文件 404 不该让整次安装失败（addAll 是原子的，会全盘放弃）。
    // 中危5（2026-10-07）：catch 后打 warn——容错语义保留（SW 照常安装、下次部署重试），
    // 但"该资产离线不可用"必须可诊断（SW 日志在 devtools → Application → Service Workers），
    // 不能静默降级。最常见的失败根因（SHELL_ASSETS 漏部署）已由 test/deploy_manifest.test.mjs
    // 前置拦截，这里兜的是运行时网络抖动/瞬时 5xx。
    await Promise.all(SHELL_ASSETS.map((u) =>
      shell.add(new Request(u, { cache: 'reload' })).catch((e) => console.warn('[sw] 外壳预缓存失败（该资产离线不可用，下次部署重试）：', u, (e && e.message) || e))));
    const data = await caches.open(DATA_CACHE);
    await Promise.all(DATA_PREFETCH.map((u) =>
      data.add(new Request(u, { cache: 'reload' })).catch((e) => console.warn('[sw] 数据档预取失败（断网回退将缺该档，下次部署重试）：', u, (e && e.message) || e))));
    // 立刻接管，不必等所有标签页关闭（否则用户要刷两次才拿到新外壳）
    await self.skipWaiting();
  })());
});

// ── activate：清掉旧版本缓存 ─────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(staleCaches(names).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

// ── fetch：按策略处理 ────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const req = event.request;
  let url;
  try { url = new URL(req.url); } catch { return; }
  const crossOrigin = url.origin !== self.location.origin;
  const st = strategyFor(req.method, req.url, { crossOrigin });
  if (st.strategy === 'passthrough') return; // 交给浏览器默认行为

  event.respondWith((async () => {
    const cache = await caches.open(st.cacheName);
    const key = cacheKeyOf(req.url);

    if (st.strategy === 'cache-first') {
      const hit = await cache.match(key);
      if (hit) {
        // 后台静默更新（stale-while-revalidate）：外壳用旧版先跑，下次访问即新版
        event.waitUntil((async () => {
          try {
            const fresh = await fetch(req, { cache: 'reload' });
            if (fresh && fresh.ok) await cache.put(key, fresh.clone());
          } catch { /* 离线：保持旧外壳，正是缓存优先的意义 */ }
        })());
        return hit;
      }
      try {
        const res = await fetch(req);
        if (res && res.ok) await cache.put(key, res.clone());
        return res;
      } catch (e) {
        // 外壳兜底：请求的是带路径的深链接时回 index.html（单页应用行为）
        const idx = await cache.match('/index.html') || await cache.match('./index.html');
        if (idx) return idx;
        throw e;
      }
    }

    // network-first（数据）：先要新的；拿不到才回退缓存
    try {
      const res = await fetch(req);
      if (res && res.ok) {
        await cache.put(key, res.clone());
        // 告知页面"这次是从网络拿的" —— 页面据此清掉离线标记
        notifyClients({ type: 'data-online', key });
      }
      return res;
    } catch (e) {
      const hit = await cache.match(key);
      if (hit) {
        notifyClients({ type: 'data-offline', key });
        return hit;
      }
      throw e; // 无缓存可用：如实失败，绝不造一个空 JSON 冒充数据
    }
  })());
});

async function notifyClients(msg) {
  try {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) c.postMessage(msg);
  } catch { /* 通知是尽力而为，不影响响应 */ }
}

// ── message：允许页面主动触发"更新并接管" ────────────────────────────────────
self.addEventListener('message', (event) => {
  const d = event.data || {};
  if (d.type === 'skip-waiting') { self.skipWaiting(); return; }
  if (d.type === 'prefetch') {
    event.waitUntil((async () => {
      const data = await caches.open(DATA_CACHE);
      await Promise.all(DATA_PREFETCH.map((u) => data.add(new Request(u, { cache: 'reload' })).catch((e) => console.warn('[sw] 数据档预取失败（断网回退将缺该档，下次部署重试）：', u, (e && e.message) || e))));
    })());
  }
});
