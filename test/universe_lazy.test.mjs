// universe_lazy：标的池分档（精简池 / 完整池）的结构契约
//
// ── 为什么必须有这个测试 ─────────────────────────────────────────────────────
// 分档能省 920KB，但它的**安全性依赖一个很容易被后人破坏的前提**：
//   精简池只提供"代码 → 名称"这一件硬依赖，其余字段一律不提供；
//   而所有"可下单性判定"所需的字段，要么由纯函数按代码推导，要么来自完整池。
//
// 一旦有人往精简池里塞 active / quoteFresh / limitPct 这类字段，会出两种事故：
//   · 往精简池塞 active/quoteFresh：这两个字段**随时间漂移**，首屏拿到的是生成日那天的值。
//     长假 7 天后页面还写着"当日有价 101 只"，而价早就是 9 天前的了 —— 看着对，其实过期。
//   · 往精简池塞 limitPct/boardLabel：这是**代码规则的副本**。规则改了（比如北交所
//     涨跌幅调整），副本不会跟着改，于是前端按副本判定涨跌停 → 规则失配。
//     这正是本项目"口径唯一出处"纪律要防的事。
//
// 所以这里的断言不是"体积小"（体积由 check_frontend 守），而是**字段集合收敛**。
// 另一个关键是"覆盖完整"：精简池漏一只票，那只票在持仓/待成交/台账里就没名字。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardOf, limitPctOf, isStName } from '../src/paper.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LITE = join(ROOT, 'data', 'paper_universe-lite.json');
const FULL = join(ROOT, 'data', 'paper_universe.json');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const haveFiles = existsSync(LITE) && existsSync(FULL);

test('精简池：只含 code + name（多一个字段就多一分"过期副本"风险）', { skip: !haveFiles }, () => {
  const lite = readJson(LITE);
  assert.ok(lite.symbols.length > 3000, `只数异常：${lite.symbols.length}`);
  const extra = new Set();
  for (const r of lite.symbols) for (const k of Object.keys(r)) if (k !== 'code' && k !== 'name') extra.add(k);
  assert.deepEqual([...extra], [], `精简池出现了越界字段：${[...extra].join(',')}`);
});

test('精简池：不含随时间漂移的字段（active/quoteFresh/asOf 等，过期了看不出来）', { skip: !haveFiles }, () => {
  const lite = readJson(LITE);
  const keys = new Set();
  for (const r of lite.symbols) for (const k of Object.keys(r)) keys.add(k);
  const drift = ['active', 'quoteFresh', 'lastSeen', 'appearances', 'asOf', 'last', 'changePct', 'huanshou']
    .filter((k) => keys.has(k));
  assert.deepEqual(drift, [], `精简池出现了会随时间漂移的字段：${drift.join(',')}`);
});

test('精简池：不含代码规则的副本（板段/幅度/ST/tradable）', { skip: !haveFiles }, () => {
  const lite = readJson(LITE);
  const keys = new Set();
  for (const r of lite.symbols) for (const k of Object.keys(r)) keys.add(k);
  const copies = ['board', 'boardLabel', 'limitPct', 'st', 'tradable', 'srcs', 'reasonIdx', 'reason']
    .filter((k) => keys.has(k));
  assert.deepEqual(copies, [],
    `精简池出现了规则副本（应由 boardOf/limitPctOf/isStName 推导）：${copies.join(',')}`);
});

test('精简池：覆盖完整池全部代码（漏一只＝那只票在持仓表里没有名字）', { skip: !haveFiles }, () => {
  const lite = readJson(LITE);
  const full = readJson(FULL);
  const liteCodes = new Set(lite.symbols.map((r) => r.code));
  const missing = Object.values(full.symbols).filter((r) => !liteCodes.has(r.code)).map((r) => r.code);
  assert.deepEqual(missing, [], `精简池漏了 ${missing.length} 只：${missing.slice(0, 5).join(',')}`);
});

test('精简池：名称与完整池逐只一致（不能出现"精简池里名字不同"）', { skip: !haveFiles }, () => {
  const lite = readJson(LITE);
  const full = readJson(FULL);
  const liteMap = new Map(lite.symbols.map((r) => [r.code, r.name]));
  const diff = [];
  for (const r of Object.values(full.symbols)) {
    if (liteMap.get(r.code) !== r.name) diff.push(`${r.code}: ${liteMap.get(r.code)} vs ${r.name}`);
  }
  assert.deepEqual(diff, [], `名称不一致 ${diff.length} 只：${diff.slice(0, 5).join(' | ')}`);
});

test('精简池：显著小于完整池（否则分档没有意义）', { skip: !haveFiles }, () => {
  const liteB = Buffer.byteLength(readFileSync(LITE));
  const fullB = Buffer.byteLength(readFileSync(FULL));
  assert.ok(liteB < fullB * 0.2, `精简池 ${(liteB / 1024).toFixed(1)}KB 未低于完整池的 20%（${(fullB / 1024).toFixed(1)}KB）`);
});

test('完整池：board/boardLabel/tradable/limitPct/st 与代码规则逐只一致', { skip: !haveFiles }, () => {
  // 完整池里存了这些字段（因为导出/人工核验要用），故它们**必须**与规则同源。
  // 这条是"副本不许漂移"的正向守卫：规则改了而池没重跑，这里就会红。
  const full = readJson(FULL);
  const rows = Object.values(full.symbols);
  const bad = [];
  for (const r of rows) {
    const b = boardOf(r.code);
    if (b.board !== r.board || b.label !== r.boardLabel || b.tradable !== r.tradable) {
      bad.push(`${r.code} board: ${r.board}/${b.board} label: ${r.boardLabel}/${b.label}`);
      continue;
    }
    const lp = limitPctOf(r.code, r.name);
    if (lp !== r.limitPct) bad.push(`${r.code} limitPct: ${r.limitPct} vs ${lp}`);
    else if (isStName(r.name) !== r.st) bad.push(`${r.code} st: ${r.st} vs ${isStName(r.name)}`);
  }
  assert.deepEqual(bad, [], `${bad.length}/${rows.length} 只与规则不一致：${bad.slice(0, 3).join(' | ')}`);
});

test('完整池：reason 码表可完整解回（reasonIdx → meta.reasonCodes）', { skip: !haveFiles }, () => {
  const full = readJson(FULL);
  const rows = Object.values(full.symbols);
  if (!Array.isArray(full.meta?.reasonCodes)) {
    // 未压缩的存量文件是允许的（前端会原样使用）
    assert.ok(rows.some((r) => typeof r.reason === 'string'), '既无码表又无明文字段，字段名被改坏了');
    return;
  }
  const table = full.meta.reasonCodes;
  const bad = [];
  for (const r of rows) {
    if (r.reasonIdx == null) continue;
    if (!(r.reasonIdx >= 0 && r.reasonIdx < table.length)) { bad.push(`${r.code} idx=${r.reasonIdx} 越界`); continue; }
    if (typeof table[r.reasonIdx] !== 'string' || !table[r.reasonIdx]) bad.push(`${r.code} 表项非字符串`);
  }
  assert.deepEqual(bad, [], `${bad.length} 条越界/坏表项：${bad.slice(0, 3).join(' | ')}`);
});

test('完整池：excluded 也走同一套码表（两处编码不一致会让 where 静默丢字段）', { skip: !haveFiles }, () => {
  const full = readJson(FULL);
  const ex = Object.values(full.excluded || {});
  if (!ex.length) return;
  const withIdx = ex.filter((r) => r.reasonIdx != null).length;
  const withStr = ex.filter((r) => typeof r.reason === 'string').length;
  assert.ok(withIdx === 0 || withStr === 0, `excluded 里既有 reasonIdx(${withIdx}) 又有 reason(${withStr})，编码混用`);
});
