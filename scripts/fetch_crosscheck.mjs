// 跨源一致性互证：抓第二行业源（腾讯/申万二级），与档案里的主源（同花顺行业）比对，
// 产出 data/crosscheck-latest.json。
//
// ── 这个脚本解决什么 ────────────────────────────────────────────────────────
// 行业涨跌幅原本只有**一个源**（同花顺 881xxx，见 src/sources.js fetchBoards）。单源的问题
// 不是"偶尔错"，而是**错了没人知道**：源侧改版/限流/半截响应 → 某些行业值明显失真 →
// 直接进 s_* 因子与"主线题材"，页面照渲染、报告照生成，全链路没有一处会说不一致。
// 本脚本用第二个独立源交叉验证，把"分不清真轮动与源抽风"变成**可判定**。
//
// ── 为什么只对最新日有效 ────────────────────────────────────────────────────
// 第二源接口**不接受日期参数**，只能取到"当下"（当前交易日的板块涨幅）。
// 故无法对历史日回溯互证 —— 脚本会把「比对的是哪一天」与「实际取数时刻」一并落盘，
// 绝不把"昨天取的值"记成"今天两源一致"（记错一天就是伪造证据）。
//
// 用法：
//   node scripts/fetch_crosscheck.mjs            # 用档案最后一天作当天
//   node scripts/fetch_crosscheck.mjs --date 2026-09-30
//   node scripts/fetch_crosscheck.mjs --dry      # 只打印不写盘
//   node scripts/fetch_crosscheck.mjs --check    # CI：只校验已有结果文件的自洽性（不联网）
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { atomicWriteJSON } from '../src/fsutil.js';
import { decodeArchive } from '../src/lhb_codec.js';
import { fetchSecondIndustry } from '../src/sources.js';
import { crossCheck, summarizeCrossCheck, DIVERGENCE_RULES, XCHECK_LEVEL } from '../src/crosscheck.js';

const FILE = 'data/archive.json';
const OUT = 'data/crosscheck-latest.json';
const DRY = process.argv.includes('--dry');
const CHECK = process.argv.includes('--check');
const argOf = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };

if (CHECK) {
  // 离线自洽检查（CI 用；不联网，故不会因第二源限流而红）
  if (!existsSync(OUT)) {
    console.log('[crosscheck] 结果文件不存在（首次运行前可接受）：' + OUT);
    process.exit(0);
  }
  const r = JSON.parse(readFileSync(OUT, 'utf8'));
  const bad = [];
  if (!r || typeof r !== 'object') bad.push('结果不是对象');
  else {
    if (!r.asOfDate) bad.push('缺 asOfDate（比对的是哪一天）');
    if (!r.fetchedAt) bad.push('缺 fetchedAt（实际取数时刻）—— 否则无法判断证据新鲜度');
    if (!r.status) bad.push('缺 status');
    if (r.status && !Object.values(XCHECK_LEVEL).includes(r.status)) bad.push('status 非法: ' + r.status);
    if (r.status === XCHECK_LEVEL.OK && r.conflictCount > 0) bad.push('status=ok 却有 conflict');
    if (r.status === XCHECK_LEVEL.UNKNOWN && /一致/.test(String(r.note || ''))) {
      bad.push('unknown 态文案不得说"一致"（没检查≠没问题）');
    }
    if (Array.isArray(r.rows) && r.rows.length && r.coverage == null) {
      bad.push('有可比行却无 coverage（覆盖率必须披露）');
    }
  }
  if (bad.length) { console.error('[crosscheck] 自洽检查失败:\n  - ' + bad.join('\n  - ')); process.exit(1); }
  console.log(`[crosscheck] ✓ 自洽：status=${r.status} · 可比 ${r.comparable} · 偏移 ${r.offset}pp · 冲突 ${r.conflictCount}`);
  process.exit(0);
}

const a = decodeArchive(JSON.parse(readFileSync(FILE, 'utf8')));
const days = (a.all_days || []).filter((d) => d && d.trade_date);
if (!days.length) { console.error('[crosscheck] 档案为空'); process.exit(1); }
const wantDate = argOf('--date');
const last = wantDate ? days.find((d) => d.trade_date === wantDate) : days[days.length - 1];
if (!last) { console.error('[crosscheck] 档案里找不到 ' + wantDate); process.exit(1); }

const primary = Array.isArray(last.industry) ? last.industry : [];
if (!primary.length) {
  // 主源都没有 → 无法互证；如实写 unknown，不写"一致"
  const res = crossCheck(primary, null, { date: last.trade_date });
  const out = {
    kind: 'crosscheck-latest', version: 1,
    asOfDate: last.trade_date, fetchedAt: new Date().toISOString(),
    rules: DIVERGENCE_RULES, ...res,
  };
  if (!DRY) atomicWriteJSON(OUT, JSON.stringify(out, null, 2));
  console.log(`[crosscheck] 主源无行业数据 → ${res.status}（不写"一致"）`);
  process.exit(0);
}

let secondary = null; let fetchErr = null;
try {
  secondary = await fetchSecondIndustry();
} catch (e) { fetchErr = e.message; }

// ⚠ 取不到第二源时 **status=unknown**（没检查≠没问题），并保留错误原因供排查。
//   绝不因为"抓失败"就跳过写盘 —— 面板需要看到"今天没互证"这件事实。
const res = fetchErr
  ? { ...crossCheck(primary, null, { date: last.trade_date }), fetchError: fetchErr }
  : crossCheck(primary, secondary, { date: last.trade_date });

const out = {
  kind: 'crosscheck-latest', version: 1,
  asOfDate: last.trade_date,
  fetchedAt: new Date().toISOString(),
  primaryCount: res.primaryCount,
  secondaryCount: res.secondaryCount,
  rules: DIVERGENCE_RULES,
  ...res,
};

console.log(`[crosscheck] 比对日 ${out.asOfDate} · ${res.primaryName} vs ${res.secondaryName}`);
console.log(`[crosscheck] 可比 ${res.comparable}/${res.primaryCount} (${res.coverage == null ? 'n/a' : (res.coverage * 100).toFixed(1) + '%'})`
  + ` · 常态偏移 ${res.offset}pp · 离群 ${res.divergeCount} · 冲突 ${res.conflictCount}`);
console.log(`[crosscheck] 结论 ${res.status}：${res.note}`);
for (const f of (res.flagged || []).slice(0, 8)) {
  console.log(`   · ${f.industry}  主 ${f.primary}% vs 次 ${f.secondary}%  (偏离 ${f.dev}pp)  ${f.level}`);
}
if (fetchErr) console.log(`[crosscheck] ⚠ 第二源抓取失败：${fetchErr}`);

if (DRY) { console.log('[crosscheck] --dry：未写盘'); process.exit(0); }
atomicWriteJSON(OUT, JSON.stringify(out, null, 2));
console.log('[crosscheck] 写出 ' + OUT);
