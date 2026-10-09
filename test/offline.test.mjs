// 离线看盘单测（策略层）+ sw.js 与 src/offline.js 的一致性守卫
//
// 本文件要守住的四件事：
//   ① 数据档是 **network-first** —— 写成 cache-first 会让人永远看到旧数据，
//      而页面看不出任何异常（最危险的错法）
//   ② 外壳是 **cache-first** —— 写成 network-first 会断网时连骨架都起不来，
//      离线看盘完全失效
//   ③ 跨域 / 非 GET 一律 passthrough —— 绝不用缓存价冒充实时价给模拟盘成交
//   ④ sw.js 里内联的那几个常量与方法**必须与 src/offline.js 一致** ——
//      SW 是经典 worker 不能 import ESM，只能复制；复制会分叉，所以必须有守卫
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  CACHE_VERSION, SHELL_CACHE, DATA_CACHE, SHELL_ASSETS, DATA_PREFETCH,
  classifyRequest, strategyFor, cacheKeyOf, staleCaches,
  offlineFallbackInfo, sameSnapshot, canRegister,
} from '../src/offline.js';
import { classifyRequest as _unusedCheck } from '../src/offline.js';

const ROOT = resolve(process.cwd());
const swSrc = readFileSync(join(ROOT, 'sw.js'), 'utf8');

// ════════════════════════════════════════════════════════════════════════════
// ① 策略判定
// ════════════════════════════════════════════════════════════════════════════
test('classifyRequest: data / shell / other 三分类', () => {
  assert.equal(classifyRequest('./data/archive-index.json'), 'data');
  assert.equal(classifyRequest('/data/archive-2026.json?a=1'), 'data');
  assert.equal(classifyRequest('./index.html'), 'shell');
  assert.equal(classifyRequest('./app.js'), 'shell');
  assert.equal(classifyRequest('./style.css'), 'shell');
  assert.equal(classifyRequest('./src/report.js'), 'shell');
  assert.equal(classifyRequest('/'), 'shell');
  assert.equal(classifyRequest('./'), 'shell');
  assert.equal(classifyRequest('https://qt.gtimg.cn/q=sh600519'), 'other');
});

test('★ 数据档必须 network-first（cache-first 会让人永远看到旧数据且无感）', () => {
  const st = strategyFor('GET', './data/archive-index.json');
  assert.equal(st.kind, 'data');
  assert.equal(st.strategy, 'network-first');
  assert.equal(st.cacheName, DATA_CACHE);
  assert.equal(st.allowOffline, true);
});

test('★ 外壳必须 cache-first（network-first 会让断网时连骨架都起不来）', () => {
  for (const u of ['./index.html', './app.js', './style.css', './']) {
    const st = strategyFor('GET', u);
    assert.equal(st.strategy, 'cache-first', `${u} 应为 cache-first`);
    assert.equal(st.cacheName, SHELL_CACHE);
  }
});

test('★ 非 GET 一律 passthrough（SW 缓存 POST 会让不同 body 互相覆盖）', () => {
  for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const st = strategyFor(m, './data/archive-index.json');
    assert.equal(st.strategy, 'passthrough', `${m} 必须直通`);
    assert.equal(st.cacheName, null);
  }
});

test('★ 跨域一律 passthrough（绝不用缓存价冒充实时价给模拟盘成交）', () => {
  const st = strategyFor('GET', 'https://qt.gtimg.cn/q=sh600519', { crossOrigin: true });
  assert.equal(st.strategy, 'passthrough');
  assert.equal(st.allowOffline, false);
});

test('strategyFor: 未知路径直通（不猜、不缓存）', () => {
  assert.equal(strategyFor('GET', './favicon.ico.zip').strategy, 'passthrough');
  assert.equal(strategyFor('GET', '/api/x').strategy, 'passthrough');
});

// ════════════════════════════════════════════════════════════════════════════
// ② 缓存键
// ════════════════════════════════════════════════════════════════════════════
test('★ cacheKeyOf: 去掉 ?_=时间戳（否则同一文件会占几十份缓存）', () => {
  assert.equal(cacheKeyOf('./data/archive-index.json?_=1759380000000'), '/data/archive-index.json');
  assert.equal(cacheKeyOf('./app.js?_=1'), '/app.js');
  assert.equal(cacheKeyOf('./index.html'), '/index.html');
  // 同一文件不同时间戳 → 同一个键
  assert.equal(cacheKeyOf('./data/x.json?_=1'), cacheKeyOf('./data/x.json?_=2'));
});

// ════════════════════════════════════════════════════════════════════════════
// ③ 旧缓存清理
// ════════════════════════════════════════════════════════════════════════════
test('staleCaches: 只清 aspro-* 的旧版本，不动当前版本与别人的缓存', () => {
  const names = [
    SHELL_CACHE, DATA_CACHE,
    'aspro-shell-v0', 'aspro-data-v0',
    'some-other-app-cache', 'workbox-precache',
  ];
  assert.deepEqual(staleCaches(names).sort(), ['aspro-data-v0', 'aspro-shell-v0']);
});

test('staleCaches: 版本升级后旧版必被识别（跨版本不残留）', () => {
  const old = ['aspro-shell-v0', 'aspro-data-v0'];
  const now = staleCaches([...old, SHELL_CACHE, DATA_CACHE]);
  assert.equal(now.length, 2, 'v0 两份都要清');
  assert.ok(!now.includes(SHELL_CACHE));
});

// ════════════════════════════════════════════════════════════════════════════
// ④ 离线回退信息
// ════════════════════════════════════════════════════════════════════════════
test('★ offlineFallbackInfo: 必须写明"不会再自动更新"（否则旧数据会被当成当下行情）', () => {
  const info = offlineFallbackInfo(
    { meta: { tradeDate: '2026-09-30', generatedAt: '2026-09-30T13:13:24Z' }, latestDate: '2026-09-30' },
    { offlineSince: '2026-10-02T01:00:00Z' },
  );
  assert.equal(info.offline, true);
  assert.equal(info.tradeDate, '2026-09-30');
  assert.ok(/2026-09-30/.test(info.note));
  assert.ok(/不会再自动更新/.test(info.note));
});

test('offlineFallbackInfo: 无缓存数据时如实说"没有"，不编一个日期', () => {
  const info = offlineFallbackInfo(null, {});
  assert.equal(info.tradeDate, null);
  assert.ok(/没有可用的缓存数据/.test(info.note));
});

test('sameSnapshot: 同一天同一次生成 → true；任一变化 → false', () => {
  const a = { meta: { tradeDate: '2026-09-30', generatedAt: 'T1' } };
  assert.equal(sameSnapshot(a, { meta: { tradeDate: '2026-09-30', generatedAt: 'T1' } }), true);
  assert.equal(sameSnapshot(a, { meta: { tradeDate: '2026-09-30', generatedAt: 'T2' } }), false, '同一天补抓也算变化');
  assert.equal(sameSnapshot(a, { meta: { tradeDate: '2026-10-09', generatedAt: 'T1' } }), false);
  assert.equal(sameSnapshot(a, { latestDate: '2026-09-30' }), false, 'generatedAt 缺失也算不同');
});

test('canRegister: 无 serviceWorker 的环境返回 false（jsdom/旧浏览器安全跳过）', () => {
  assert.equal(canRegister({}), false);
  assert.equal(canRegister({ serviceWorker: {} }), false);
  assert.equal(canRegister({ serviceWorker: { register: () => {} } }), true);
  assert.equal(canRegister(null), false);
});

// ════════════════════════════════════════════════════════════════════════════
// ⑤ ★ sw.js ↔ src/offline.js 一致性守卫
//    sw.js 是经典 worker（不能 import ESM），常量与函数只能内联复制。
//    复制能保证浏览器兼容性，但**会分叉** —— 这个守卫就是防分叉的那道闸。
//    没有它，"改了一边忘了另一边"会表现为"生产环境策略与单测不一致"，
//    而那是最难查的一类问题（单测全绿，线上行为不同）。
// ════════════════════════════════════════════════════════════════════════════
test('★ sw.js 内联了 CACHE_VERSION 且与 src/offline.js 一致', () => {
  const m = swSrc.match(/const CACHE_VERSION\s*=\s*'([^']+)'/);
  assert.ok(m, 'sw.js 必须内联 CACHE_VERSION');
  assert.equal(m[1], CACHE_VERSION, 'CACHE_VERSION 分叉：sw.js 与 src/offline.js 必须同步改');
});

test('★ sw.js 的缓存名前缀与 offline.js 一致', () => {
  assert.ok(swSrc.includes(`\`aspro-shell-\${CACHE_VERSION}\``), 'sw.js 必须用同一模板拼 SHELL_CACHE');
  assert.ok(swSrc.includes(`\`aspro-data-\${CACHE_VERSION}\``), 'sw.js 必须用同一模板拼 DATA_CACHE');
  assert.ok(SHELL_CACHE.startsWith('aspro-shell-'));
  assert.ok(DATA_CACHE.startsWith('aspro-data-'));
});

test('★ sw.js 的 SHELL_ASSETS / DATA_PREFETCH 逐项与 offline.js 一致', () => {
  const grab = (name) => {
    const m = swSrc.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
    assert.ok(m, `sw.js 缺 ${name}`);
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  };
  assert.deepEqual(grab('SHELL_ASSETS'), [...SHELL_ASSETS], 'SHELL_ASSETS 分叉');
  assert.deepEqual(grab('DATA_PREFETCH'), [...DATA_PREFETCH], 'DATA_PREFETCH 分叉');
});

test('★ sw.js 的策略分支与 strategyFor 的语义一致（数据 network-first / 外壳 cache-first）', () => {
  // 只验"顺序与关键词"：sw.js 里必须是 network-first 分支真的去 fetch 再回退 cache，
  // cache-first 分支真的先 match 再 fetch。纯文本断言做不到 100% 精确，
  // 但足以抓住"两个分支被写反"这个致命错法。
  const body = swSrc.slice(swSrc.indexOf("self.addEventListener('fetch'"));
  const cfAt = body.indexOf("st.strategy === 'cache-first'");
  const nfAt = body.indexOf('// network-first（数据）');
  assert.ok(cfAt > 0 && nfAt > 0, 'sw.js 必须显式区分两种策略');
  // cache-first 段里应先 match
  const cfSeg = body.slice(cfAt, nfAt);
  assert.ok(cfSeg.indexOf('cache.match') < cfSeg.indexOf('fetch(req)'),
    'cache-first 段必须先查缓存再回源');
  // network-first 段里应先 fetch
  const nfSeg = body.slice(nfAt);
  assert.ok(nfSeg.indexOf('await fetch(req)') < nfSeg.indexOf('cache.match'),
    'network-first 段必须先回源再回退缓存');
});

test('★ sw.js 不得缓存非 GET 与跨域请求（passthrough 分支必须在）', () => {
  assert.ok(/strategy\s*===\s*'passthrough'/.test(swSrc), 'sw.js 缺 passthrough 分支');
  assert.ok(/crossOrigin/.test(swSrc), 'sw.js 缺跨域判定');
  assert.ok(/m !== 'GET'/.test(swSrc), 'sw.js 缺非 GET 判定');
});

test('★ sw.js 的 cacheKeyOf 必须同样剥掉查询串（否则缓存键与 offline.js 不一致）', () => {
  const m = swSrc.match(/function cacheKeyOf\(rawUrl\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, 'sw.js 缺 cacheKeyOf');
  assert.ok(/u\.search = ''/.test(m[1]), 'sw.js 的 cacheKeyOf 必须清空 search');
});

test('★ sw.js 的 staleCaches 正则与 offline.js 一致', () => {
  const m = swSrc.match(/function staleCaches\([\s\S]*?\/\^aspro-\([^)]+\)[^/]*\//);
  assert.ok(m, 'sw.js 缺 staleCaches 的 aspro- 前缀正则');
  assert.ok(/aspro-/.test(m[0]));
  // offline.js 侧同样要是这个前缀
  assert.deepEqual(staleCaches(['aspro-shell-vX', 'other']), ['aspro-shell-vX']);
});

test('★ install 必须预缓存外壳（否则首次访问后断网重开会白屏）', () => {
  assert.ok(/self\.addEventListener\('install'/.test(swSrc));
  const inst = swSrc.slice(swSrc.indexOf("addEventListener('install'"));
  assert.ok(/shell\.add|SHELL_ASSETS/.test(inst.slice(0, 900)), 'install 必须 cache.addAll/add 外壳');
  assert.ok(/skipWaiting/.test(inst.slice(0, 1200)), 'install 后应 skipWaiting，避免用户要刷两次');
});

test('★ activate 必须清旧缓存 + clients.claim', () => {
  const act = swSrc.slice(swSrc.indexOf("addEventListener('activate'"));
  assert.ok(/caches\.keys\(\)/.test(act.slice(0, 500)));
  assert.ok(/staleCaches/.test(act.slice(0, 500)));
  assert.ok(/clients\.claim/.test(act.slice(0, 700)));
});

test('★ 回退不到缓存时必须如实失败（不得造一个空 JSON 冒充数据）', () => {
  const body = swSrc.slice(swSrc.indexOf("self.addEventListener('fetch'"));
  assert.ok(/throw e;/.test(body) || /throw err;/.test(body),
    '数据档无缓存可用时必须抛错，不能返回一个 {} 让页面当成"今天没数据"');
  // 反向：不得出现"返回空 JSON"这种写法
  assert.ok(!/new Response\(\s*['"]\{\}['"]/.test(body), '绝不能伪造空 JSON');
  assert.ok(!/new Response\(JSON\.stringify\(\{\}\)/.test(body), '绝不能伪造空 JSON');
});

test('★ 离线的数据档不得被"成功"标记（否则页面会以为数据是新的）', () => {
  const body = swSrc.slice(swSrc.indexOf("self.addEventListener('fetch'"));
  assert.ok(/data-offline/.test(body), '回退缓存时必须通知页面进入离线态');
  assert.ok(/data-online/.test(body), '从网络取到时必须通知页面退出离线态');
});
