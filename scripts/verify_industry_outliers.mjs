// 行业离群 warn（OUTLIER_INDUSTRY / COUNTER_INDEX）跨源自动核验 + 自动销案。
//
// 背景：src/dirty.js 的 OUTLIER_INDUSTRY 与 COUNTER_INDEX 都是 WARN——「数值孤立」
//   与「主题集中」「系统性波动下的链条式逆势轮动」在数值形态上无法可靠区分
//   （见 dirty.js 内两条规则的演进注释；COUNTER_INDEX 于 2026-10-05 因 2026-03-03
//   能源链逆势大涨跨源核验 Δ=0.00 实锤而降级），故只标不剔除、交人工复核。
//   代价是真实行情的离群会重复报，久了会被忽略。本脚本把「复核」自动化：
//
//   ① 扫全档，收集所有未被销案的 OUTLIER_INDUSTRY / COUNTER_INDEX 告警；
//   ② 逐条去**同花顺行业指数（881xxx）**拉该日历史日K，独立复算当日涨跌幅；
//   ③ 复算值与档案值在容差内 → confirmed-real（自动销案，写入 data/industry_outlier_review.json）；
//      超容差 → data-error（**不销案**，exit 1 报警——这是真采集异常，须查数据源）。
//
// 纪律：
//   · 销案 = 只停重复告警，不动任何数值（档案原值照旧保留）；
//   · 已存在的台账条目**不覆盖**（人工写的证据链优先）；新增用 --refresh 才重写；
//   · 拉不到数据（源不可用/行业无映射）→ 计入 errors 并 exit 1，绝不当成"核验通过"
//     （缺失禁当真值，与 #6 探针同一条纪律）。
//
// 用法：node scripts/verify_industry_outliers.mjs [--refresh] [--dry]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { atomicWriteJSON } from '../src/fsutil.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeArchive } from '../src/lhb_codec.js';
import { validateDay } from '../src/dirty.js';
import { confirmedSet, mergeEntries, reviewKey, validateLedger, VERDICTS } from '../src/outlier_review.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LEDGER = path.join(ROOT, 'data', 'industry_outlier_review.json');
const ARCHIVE = path.join(ROOT, 'data', 'archive.json');
const args = process.argv.slice(2);
const REFRESH = args.includes('--refresh');
const DRY = args.includes('--dry');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36';
const TOLERANCE = 0.05; // 百分点

// ── 同花顺行业名 → 881xxx 映射（GBK 页面）────────────────────────────────────
async function fetchIndustryMap() {
  const res = await fetch('https://q.10jqka.com.cn/thshy/', {
    headers: { 'User-Agent': UA, Referer: 'https://q.10jqka.com.cn/' },
  });
  const html = new TextDecoder('gbk').decode(Buffer.from(await res.arrayBuffer()));
  const map = new Map();
  const re = /thshy\/detail\/code\/(88\d+)\/"[^>]*>([^<]+)</g;
  let m;
  while ((m = re.exec(html))) {
    const name = m[2].trim();
    if (name && !map.has(name)) map.set(name, m[1]);
  }
  return map;
}

// ── 同花顺行业指数某年日K（rows: [date, open, high, low, close, vol, amount, ...]）──
async function fetchYearRows(code, year) {
  const url = `https://d.10jqka.com.cn/v6/line/bk_${code}/01/${year}.js`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://q.10jqka.com.cn/' } });
  const txt = await res.text();
  const m = txt.match(/^[^(]*\((.*)\)\s*;?\s*$/s);
  const json = JSON.parse(m ? m[1] : txt);
  return String(json.data || '').split(';').filter(Boolean).map((r) => r.split(','));
}

/** 复算 ymd（YYYYMMDD）当日涨跌幅 = close_t/close_{t-1} - 1。前一日缺失返回 null。 */
function pctOn(rows, ymd) {
  const i = rows.findIndex((r) => r[0] === ymd);
  if (i < 1) return null;
  const c = parseFloat(rows[i][4]);
  const pc = parseFloat(rows[i - 1][4]);
  if (!Number.isFinite(c) || !Number.isFinite(pc) || pc === 0) return null;
  return Math.round((c / pc - 1) * 1e6) / 1e4; // 百分比，2 位小数
}

// ── ① 扫全档收集未销案的离群告警 ─────────────────────────────────────────────
const ledger = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : { kind: 'industry-outlier-review', version: 1, entries: [] };
const ledgerCheck = validateLedger(ledger);
if (!ledgerCheck.ok) {
  console.error(`[verify] 台账结构异常，拒绝在坏台账上继续：\n  ${ledgerCheck.errors.join('\n  ')}`);
  process.exit(1);
}
const already = confirmedSet(ledger);

const arch = decodeArchive(JSON.parse(readFileSync(ARCHIVE, 'utf8')));
const days = (arch.all_days || []).filter((d) => d && d.trade_date);
const pending = [];
for (const d of days) {
  const r = validateDay(d, { reviewedOutliers: already }); // 已销案的不再进入待核验队列
  for (const it of r.issues || []) {
    if (it.rule !== 'OUTLIER_INDUSTRY' && it.rule !== 'COUNTER_INDEX') continue;
    const mm = /行业「([^」]+)」([\d.-]+)%/.exec(it.reason || '');
    pending.push({
      date: d.trade_date,
      industry: mm ? mm[1] : null,
      changePct: mm ? parseFloat(mm[2]) : null,
      reason: it.reason,
    });
  }
}
console.log(`[verify] 档案 ${days.length} 天 | 已销案 ${already.size} 条 | 本次待核验 ${pending.length} 条`);
if (!pending.length) {
  console.log('[verify] 无待核验离群告警（全部已销案或本档无行业明细）。');
  process.exit(0);
}

// ── ② 逐条跨源复算 ──────────────────────────────────────────────────────────
let indMap;
try {
  indMap = await fetchIndustryMap();
} catch (e) {
  console.error(`[verify] 同花顺行业映射拉取失败（源不可用，拒绝判定）：${e.message}`);
  process.exit(1);
}
console.log(`[verify] 同花顺行业映射 ${indMap.size} 个`);

const rowCache = new Map();
const newEntries = [];
const errors = [];
const today = new Date().toISOString().slice(0, 10);

for (const p of pending) {
  const code = indMap.get(p.industry);
  if (!code) { errors.push(`${p.date} ${p.industry}: 同花顺映射缺失，无法核验`); continue; }
  const year = p.date.slice(0, 4);
  const key = `${code}|${year}`;
  try {
    if (!rowCache.has(key)) rowCache.set(key, await fetchYearRows(code, year));
  } catch (e) {
    errors.push(`${p.date} ${p.industry}: 日K 拉取失败 ${e.message}`);
    continue;
  }
  const rows = rowCache.get(key);
  const rec = pctOn(rows, p.date.replace(/-/g, ''));
  if (rec == null) { errors.push(`${p.date} ${p.industry}: 该日/前一日 K 线缺失，无法复算`); continue; }
  const delta = Math.round(Math.abs(rec - p.changePct) * 1e4) / 1e4;
  const ok = delta <= TOLERANCE;
  console.log(`${ok ? '✓' : '✗'} ${p.date} ${p.industry}: 档案 ${p.changePct}% | 同花顺复算 ${rec}% | Δ${delta}pp`);
  if (!ok) errors.push(`${p.date} ${p.industry}: 复算 ${rec}% 与档案 ${p.changePct}% 相差 ${delta}pp > 容差 ${TOLERANCE}——疑采集异常，不做销案`);
  const k = reviewKey(p.date, p.industry);
  if (!REFRESH && already.has(k)) continue; // 已销案且在案（--refresh 才重写）
  newEntries.push({
    date: p.date, industry: p.industry, changePct: p.changePct, nearestGap: null,
    verdict: ok ? VERDICTS.REAL : VERDICTS.ERROR,
    method: 'cross-source',
    evidence: {
      source: `同花顺行业指数 ${code} ${p.industry}（d.10jqka.com.cn 日K）`,
      code, recomputed: rec, delta,
      detail: `本日收盘/前收复算涨跌幅 ${rec}%，与档案 ${p.changePct}% 相差 ${delta}pp（容差 ${TOLERANCE}pp）。`,
    },
    reviewedAt: today,
    note: ok ? '自动跨源核验：真实行情（脚本 verify_industry_outliers.mjs）。' : '自动跨源核验：复算不一致，待人工排查数据源。',
  });
}

// ── ③ 落盘（幂等合并）──────────────────────────────────────────────────────
if (newEntries.length && !DRY) {
  const next = mergeEntries(ledger, newEntries);
  atomicWriteJSON(LEDGER, JSON.stringify(next, null, 2) + '\n');
  console.log(`[verify] 台账已更新：新增/更新 ${newEntries.length} 条（共 ${next.entries.length} 条）`);
} else {
  console.log(`[verify] 无台账变更${DRY ? '（--dry 演练）' : ''}。`);
}

if (errors.length) {
  console.error(`\n[verify] ✗ ${errors.length} 条未能确认为真实行情（**不销案**）：`);
  errors.forEach((e) => console.error(`  · ${e}`));
  process.exit(1);
}
console.log(`\n[verify] ✅ 全部 ${pending.length} 条跨源复算一致，已销案。`);
