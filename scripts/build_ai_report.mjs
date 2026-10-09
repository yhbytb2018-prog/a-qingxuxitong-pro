#!/usr/bin/env node
// ── AI 报告生成入口（S1 归档轨 + S2 调度闸门 · daily.yml 挂点）────────────
//
// 用途：读六源真实数据档 → 调 src/ai_report.js 纯函数 → 落盘 data/reports/。
//
// 用法：
//   node scripts/build_ai_report.mjs                        # 盘后（默认）
//   node scripts/build_ai_report.mjs --type pre_market      # 盘前（非交易日自动跳过）
//   node scripts/build_ai_report.mjs --type intraday        # 盘中（相位非 live 自动跳过）
//   node scripts/build_ai_report.mjs --type weekly          # 周报（非本周最后交易日自动跳过，
//                                                          #   week-start 自动取本周一）
//   node scripts/build_ai_report.mjs --type weekly --week-start 2026-09-28
//   node scripts/build_ai_report.mjs --sample               # 标记为首屏示例（index.json is_sample）
//   node scripts/build_ai_report.mjs --type intraday --trigger event:circuit_breaker
//
// 纪律：与 src/ai_report.js 同源同律——只读 data/、只写 data/reports/、
//   缺失 null 不补 0；脚本自身不做任何数值计算（生成器纯函数的唯一入口）。
//   闸门跳过 = 正常退出（exit 0），不是错误——CI 步骤不因"今天不该出报告"变红。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { atomicWriteJSON } from '../src/fsutil.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateContract } from '../src/contract.js';
import { bjDate } from '../src/freshness.js';
import { gatePreMarket, gateIntraday, gateWeekly } from '../src/ai_report_push.js';
import {
  buildInput, generatePreMarket, generateIntraday, generatePostMarket, generateWeekly,
  buildSimulationStock, isoWeekStart,
} from '../src/ai_report.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'data', 'reports');
const INDEX_FILE = join(OUT_DIR, 'index.json');

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
};
const has = (name) => process.argv.includes(`--${name}`);

const TYPE = arg('type') || 'post_market';
const WEEK_START = arg('week-start') || null;
const IS_SAMPLE = has('sample');
// 模拟选股层开关（S1.5）：CLI --sim 强制开，或 env SIMULATION_MODE=true。
//   env 由 daily.yml 顶层注入（默认 'true'，可被 GitHub 仓库 Variables 的
//   SIMULATION_MODE 覆盖——回测期间想临时关掉，改仓库变量即可，不动 workflow）。
const WITH_SIM = has('sim') || process.env.SIMULATION_MODE === 'true';
const FORCE = has('force');  // 跳过调度闸门（示例重生成/维护用；同 snapshot_intraday.mjs --force 惯例）

// 模拟选股缺失披露（信封级汇总；字段级缺失由 null + pool_basis/phase_source 承载）
const SIM_MISSING_NOTE = {
  field: 'simulation_stock.candidate_pool[].themes/fundamentals(八字段)/个股级主力资金',
  reason: '系统无基本面选股模块与个股级题材/主力资金数据源；基本面键 null 占位（决议 8），接数据源后直接填充不改 schema',
  ref: 'docs/ai_report_module_design.md#9.3',
};

const read = (rel) => {
  const p = join(ROOT, rel);
  if (!existsSync(p)) return null; // 缺档 = null（missing 语义，生成器自行披露）
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
};

const input = buildInput({
  dualTrack: read('data/paper/dual_track_latest.json'),
  dualTrackDays: read('data/paper/dual_track.json')?.days ?? null,
  signals: read('data/signals-latest.json'),
  global: read('data/global.json'),
  backtest: read('data/backtest.json'),
  opsAlerts: read('data/ops-alerts-latest.json'),
  intraday: read('data/intraday.json'),
});

// ── 调度闸门（S2 · 判据唯一出处 src/ai_report_push.js）：跳过即正常退出 ──
//   --force 旁路（示例重生成/维护）：闸门管的是"此刻该不该出新报告"，
//   不该管"能不能重建历史示例"——两回事，一个开关分开。
if (!FORCE) {
  if (TYPE === 'pre_market') {
    const g = gatePreMarket();
    console.log(`[ai-report] ${g.reason}`);
    if (!g.ok) process.exit(0);
  }
  if (TYPE === 'intraday') {
    const g = gateIntraday();
    console.log(`[ai-report] ${g.reason}`);
    if (!g.ok) process.exit(0);
  }
  if (TYPE === 'weekly') {
    const closed = read('data/calendar.json')?.closed ?? [];
    const g = gateWeekly(input.tradeDate, closed);
    console.log(`[ai-report] ${g.reason}`);
    if (!g.ok) process.exit(0);
  }
}
// 周报 week-start：显式指定优先，否则自动取 tradeDate 所在 ISO 周的周一
const weekStart = WEEK_START || (TYPE === 'weekly' ? isoWeekStart(input.tradeDate) : null);

const opts = { generatedAt: new Date().toISOString(), generatedBy: 'ci' };
if (WITH_SIM) {
  // paper_universe.symbols 注入名称映射（code→{name, appearances}）；缺档则名称 null（不造数）
  const simOpts = { nameMap: read('data/paper_universe.json')?.symbols ?? null };
  if (TYPE === 'intraday') {
    // 盘中候选股联查（S2）：hot 强势榜的 change_pct 注入 → 候选池逐股 intraday_chg。
    // 只认**北京当日**快照（intraday.tradeDate 对得上才注入）——昨日的陈旧榜宁缺毋假，
    // 盘前/盘后报告不注入（intraday_chg 恒 null，非盘中语义）。
    const intra = read('data/intraday.json');
    if (intra && Array.isArray(intra.hot?.rows) && intra.tradeDate === bjDate(new Date())) {
      simOpts.intradayHot = Object.fromEntries(
        intra.hot.rows.filter((r) => r && r.code).map((r) => [r.code, Number.isFinite(r.change_pct) ? r.change_pct : null]),
      );
    }
  }
  opts.simulationStock = buildSimulationStock(input, simOpts);
}
const generators = {
  pre_market: () => generatePreMarket(input, opts),
  intraday: () => generateIntraday(input, { ...opts, trigger: arg('trigger') || 'schedule' }),
  post_market: () => generatePostMarket(input, opts),
  weekly: () => generateWeekly(input, { ...opts, weekStart: weekStart || input.tradeDate }),
};
const gen = generators[TYPE];
if (!gen) { console.error(`[ai-report] 未知 --type: ${TYPE}（enum: ${Object.keys(generators).join('|')}）`); process.exit(1); }

const report = gen();
if (!report.date) { console.error('[ai-report] tradeDate 缺失（dual_track/signals 均无日期）——不落盘'); process.exit(1); }

// 落盘前契约门禁：坏档不进提交（与 check_contract 同纪律）
const schema = JSON.parse(readFileSync(join(ROOT, 'schemas', 'ai-report.schema.json'), 'utf8'));
const errs = validateContract(report, schema);
if (errs.length) {
  console.error('[ai-report] 契约违例，拒绝落盘：');
  for (const e of errs) console.error(`  ${e.path}: ${e.expect}（got ${e.got}）${e.hint || ''}`);
  process.exit(1);
}
if (WITH_SIM) report.missing_notes.push(SIM_MISSING_NOTE);

const file = `${TYPE}_${report.date}.json`;
mkdirSync(OUT_DIR, { recursive: true });
atomicWriteJSON(join(OUT_DIR, file), JSON.stringify(report, null, 1) + '\n');

// index.json：各类型最新一期索引（首屏示例标记）
const index = existsSync(INDEX_FILE) ? JSON.parse(readFileSync(INDEX_FILE, 'utf8')) : { schema_version: '1.0', reports: {} };
index.generatedAt = report.generated_at;
index.reports[TYPE] = { date: report.date, file, is_sample: Boolean(IS_SAMPLE) || Boolean(index.reports[TYPE]?.is_sample) };
if (IS_SAMPLE) index.sampleNote = `首屏示例：首次打开页面时显示 ${report.date} 报告（docs/ai_report_module_design.md §3.4）`;
atomicWriteJSON(INDEX_FILE, JSON.stringify(index, null, 1) + '\n');

console.log(`[ai-report] ${TYPE} ${report.date} → data/reports/${file}（status=${report.status}，${report.missing_notes.length} 条缺失披露，${IS_SAMPLE ? '首屏示例 ' : ''}契约通过）`);
