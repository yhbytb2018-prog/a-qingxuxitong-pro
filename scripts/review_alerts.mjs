// WARN 级行业孤立告警的跨源互证复核（dirty.js OUTLIER_INDUSTRY 的 #2 通道落地）
//
// 背景：dirty.js 设计里「数值孤立」无法可靠区别于「主题集中」（实测 2026-08-18 打脸后
// 退为 WARN 只标记不剔除），真正的判据是跨源互证——同一行业在两个独立测量的值直接比对。
// 本脚本就是那个通道：对全档 WARN 级 OUTLIER_INDUSTRY 告警自动做三源互证并留痕。
//
// ── 三源（同一事实的三个独立测量）──────────────────────────────────────────
//   A 档案值：q.10jqka 板块页当日采集（fetchBoards 生产源）
//   B 年线值：d.10jqka 881 板块年线（data/bt_industry.json，独立端点独立时间抓取）——
//             前收→当日收盘重算涨跌幅，与 A 差 ≤0.5pp 即数值互证通过
//   C 微观印证：该日题材归因（东财涨停池 topics）含相关主题 + 权重股 K 线同向大幅波动
//             （定性，供人工判断「主题集中」假设）
//
// 裁定：verified = 数值真实（两源一致）。是否主题集中由 C 的证据链人工判读，
//       但 A/B 一致本身已排除「源抽风写错数」——告警的原始诉求（数值可疑）即告销案。
//
// 用法：
//   node scripts/review_alerts.mjs            # 扫描 + 打印证据，不写盘
//   node scripts/review_alerts.mjs --apply    # 复核结论写入 day.review + 切片同步
import { readFileSync, existsSync } from 'node:fs';
import * as fsMod from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decodeArchive, encodeArchive, writeArchiveSafely } from '../src/lhb_codec.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.join(ROOT, 'data', 'archive.json');
const INDUSTRY_CACHE = path.join(ROOT, 'data', 'bt_industry.json');
const APPLY = process.argv.includes('--apply');

const arc = decodeArchive(JSON.parse(readFileSync(MAIN, 'utf8')));
if (!existsSync(INDUSTRY_CACHE)) { console.error('[review] ⚠ 无 data/bt_industry.json——先跑 scripts/fetch_industry_history.mjs'); process.exit(1); }
const cache = JSON.parse(readFileSync(INDUSTRY_CACHE, 'utf8'));
// 年线按日期建索引：Map<code, Map<ymd, {pre, close}>>
const byCode = new Map();
for (const b of cache) {
  const bars = (b.bars || []).slice().sort((x, y) => (x[0] < y[0] ? -1 : 1));
  const m = new Map();
  for (let i = 1; i < bars.length; i++) m.set(bars[i][0], { pre: +bars[i - 1][1], close: +bars[i][1] });
  byCode.set(b.name, m);
}

// 扫全档 WARN 级行业孤立告警（含已复核的——复核状态幂等更新）
const findings = [];
for (const d of arc.all_days || []) {
  const issues = ((d.emotion || {}).dirty || {}).issues || [];
  for (const it of issues) {
    if (it.rule !== 'OUTLIER_INDUSTRY' || it.severity !== 'warn') continue;
    const row = (d.industry || []).find((r) => it.reason.includes(r.name));
    if (!row) continue;
    findings.push({ day: d, issue: it, row });
  }
}
console.log(`[review] WARN 级行业孤立告警: ${findings.length} 条`);

let verified = 0, unverified = 0;
for (const f of findings) {
  const ymd = f.day.trade_date.replace(/-/g, '');
  const rec = byCode.get(f.row.name) && byCode.get(f.row.name).get(ymd);
  const evidence = { sourceA: f.row.change_pct, sourceB: rec ? Math.round((rec.close / rec.pre - 1) * 10000) / 100 : null };
  // 源 C：题材微观印证（该日 TOP 题材与行业关键词的语义关联留给人工，脚本只陈列事实）
  const topics = (f.day.topics || []).slice(0, 3).map((t) => `${t.tag}×${t.count}`);
  const pass = rec != null && Math.abs(evidence.sourceA - evidence.sourceB) <= 0.5;
  if (pass) verified++; else unverified++;
  console.log(`\n${f.day.trade_date} 「${f.row.name}」${f.row.change_pct}%`);
  console.log(`  源A(档案·板块页): ${evidence.sourceA}% · 源B(年线重算): ${evidence.sourceB}% → ${pass ? '✔ 两源一致（数值真实）' : '✘ 两源不符（需人工深查）'}`);
  console.log(`  源C(题材归因): ${topics.join('、') || '无'}`);

  if (APPLY) {
    f.day.review = {
      ...(f.day.review || {}),
      issue: `OUTLIER_INDUSTRY ${f.day.trade_date} ${f.row.name} ${f.row.change_pct}%`,
      checkedAt: new Date().toISOString().slice(0, 10),
      verdict: pass ? 'verified' : 'mismatch',
      crossCheck: {
        // A=每日管线板块页采集 B=年线缓存独立重算 C=题材归因微观印证（人工判读）
        sources: { A_q10jqka_board: evidence.sourceA, B_yearly_recalc: evidence.sourceB, C_topics: topics },
        diffPP: pass ? Math.round(Math.abs(evidence.sourceA - evidence.sourceB) * 100) / 100 : null,
      },
      note: pass
        ? '跨源互证通过：数值真实，孤立源于主题级行情（非源抽风）——告警销案，数据保留不剔除'
        : '两源数值不符：维持告警，需人工深查（本留痕仅记录复核未通过）',
    };
  }
}

if (!APPLY) { console.log(`\n[review] 预览模式（--apply 写入 d.review 留痕）· 互证通过 ${verified} / 不符 ${unverified}`); process.exit(0); }

// 写盘：与主档同一编码路径（码表沿用档案现表，避免重编漂移）
const raw = JSON.parse(readFileSync(MAIN, 'utf8'));
const codes = Array.isArray(raw?.meta?.reasonCodes) && raw.meta.reasonCodes.length ? raw.meta.reasonCodes : null;
writeArchiveSafely(MAIN, codes ? { ...arc, meta: { ...arc.meta, reasonCodes: codes } } : arc, fsMod);
console.log(`[review] 已写入 d.review（互证通过 ${verified} / 不符 ${unverified}）—— writeArchiveSafely 含往返自检`);

// 切片同步（day 层新字段经 buildShards 原样透传进年分片）
const rr = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'split_archive.mjs')], { stdio: 'inherit' });
if (rr.status !== 0) { console.error('[review] ⚠ 切片重建失败——主档已更新，请手动跑 split_archive'); process.exit(1); }
console.log('[review] 切片已同步 · 完成');
