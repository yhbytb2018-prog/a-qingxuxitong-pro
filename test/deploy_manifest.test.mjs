// ★ 部署面一致性守卫（中危4，2026-10-07）──────────────────────────────────────
// deploy-pages.yml 头注自述设计要点①："三处同源须同步改：sw.js SHELL_ASSETS /
// 本文件 paths / cp 组装清单——缺一处 = 离线外壳缺资产或部署不触发"。
// 但这此前只是**人肉纪律**（H-1 正是漏了三处被人肉补齐的实录）。本守卫把三方
// 面临界关系变成断言，与 test/offline.test.mjs ⑤（sw.js ↔ offline.js）、
// test/seats_parity.test.mjs（降级副本 ↔ 主模块）同一族"防分叉"守卫。
// CI 两处门禁（daily.yml / merge-staging-to-main.yml 的 node --test）都会跑本文件。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');
const html = read('index.html');
const sw = read('sw.js');
const yml = read('.github/workflows/deploy-pages.yml');

// ── 三方清单提取 ─────────────────────────────────────────────────────────────
// ① index.html 的页面引用面：<script src>/<link href> + 内联 module 的 import ... from './src/…'
const pageRefs = new Set();
for (const m of html.matchAll(/(?:src|href)="(\.\/[^"?#]+)"/g)) pageRefs.add(m[1]);
for (const m of html.matchAll(/from\s+'(\.\/src\/[^']+)'/g)) pageRefs.add(m[1]);

// ② sw.js SHELL_ASSETS（离线外壳面）
const shellAssets = new Set();
{
  const seg = sw.match(/const SHELL_ASSETS = \[([\s\S]*?)\];/);
  assert.ok(seg, 'sw.js 必须有 SHELL_ASSETS 数组');
  for (const m of seg[1].matchAll(/'([^']+)'/g)) shellAssets.add(m[1]);
}

// ③ deploy-pages.yml：paths 触发白名单 + cp 组装清单
const paths = new Set();
for (const m of yml.matchAll(/^\s+-\s+'([^']+)'\s*$/gm)) paths.add(m[1]);
const cpFiles = new Set();
for (const line of yml.matchAll(/^\s+cp\s+.*$/gm)) {
  const toks = line[0].trim().split(/\s+/).slice(1).filter((t) => t !== '-r');
  for (const t of toks) {
    if (t === 'site/' || t === 'site/src/' || t === 'site/data/') continue;
    if (t === 'data/.') { cpFiles.add('data/**'); continue; } // cp -r data/. site/data/ ⇔ paths 的 'data/**'
    cpFiles.add(t);
  }
}
assert.ok(cpFiles.size > 10, `cp 清单解析异常（只解析到 ${cpFiles.size} 个文件）`);
assert.ok(paths.has('data/**'), 'paths 必须含 data/**');

const pageModules = [...pageRefs].filter((p) => p.startsWith('./src/'));

test('★ 部署面解析自检（防止守卫本身静默失效）', () => {
  // 解析器对已知事实的最小验证：页面引用面、外壳面、部署面都非空且形态正确
  assert.ok(pageModules.length >= 5, `index.html 的 src 模块引用应 ≥5 个，实得 ${pageModules.length}`);
  assert.ok([...shellAssets].every((p) => p.startsWith('./')), 'SHELL_ASSETS 应为 ./ 相对路径');
  assert.ok(cpFiles.has('app.js') && cpFiles.has('index.html') && cpFiles.has('src/lhb.js'),
    'cp 清单应含根外壳文件与 src/lhb.js（app.js 动态 import 的对象）');
});

test('★ 页面引用的每个文件必须被部署（漏一个 = 线上 404 / 模块树崩溃）', () => {
  const missing = [...pageRefs].filter((p) => p !== './' && !cpFiles.has(p.replace(/^\.\//, '')));
  assert.deepEqual(missing, [], 'index.html 引用但 cp 清单没部署的文件（模拟台面下线的 paper_ui.js 及其依赖不在此列——页面已不加载）');
});

test('★ SW 离线外壳的每个资产必须被部署（H-1 教训：SW 缓存 404 → catch(null) 静默漏）', () => {
  const missing = [...shellAssets]
    .filter((p) => p !== './' && p !== './index.html')
    .filter((p) => !cpFiles.has(p.replace(/^\.\//, '')));
  assert.deepEqual(missing, [], 'SHELL_ASSETS 含但未部署的文件——离线外壳将静默缺资产');
});

test('★ 部署的每个文件必须在 paths 触发白名单（漏一个 = 改了文件但部署不触发，线上停留旧版）', () => {
  const missing = [...cpFiles].filter((f) => !paths.has(f));
  assert.deepEqual(missing, [], 'cp 清单含但 paths 白名单没有的文件——该文件的变更不会触发部署');
});

test('★ 页面加载的 src 模块必须在 SW 离线外壳里（离线可用的完整性）', () => {
  const missing = pageModules.filter((m) => !shellAssets.has(m));
  assert.deepEqual(missing, [], 'index.html 引用但 SHELL_ASSETS 没有的模块——离线时 cache-first 兜底会用 HTML 顶替 JS（H-1 根因）');
});

test('★ 守卫提示：未来新增模块的同步流程（文档性断言，不检查行为）', () => {
  // paper_ui.js 在 cp 清单里但页面已不加载（台面下线，index.html 注释自述）——
  // 这是刻意保留的历史包袱：断言它**不**在页面引用面，若哪天它回来了（或被删了），
  // 本守卫提醒维护者重审其 5 个未部署依赖（alert_log/alerts/lhb_codec/picks/paper_review）。
  assert.ok(!pageRefs.has('./paper_ui.js') || cpFiles.has('src/alert_log.js'),
    'paper_ui.js 若重新被页面加载，其 import 依赖必须同步部署（src/alert_log.js 等 5 个）');
});
