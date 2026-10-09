// ② 真实 API 冒烟测：六源真打（不 mock），断言 HTTP 200 + 非空 + 字段齐全 + 不崩。
//
// 为什么必须真打：源悄悄改字段（改名/改结构/加风控）是本项目最大的数据风险——
// 管道的容灾会「保留上次快照并标记失败」，表现为页面数据慢慢变旧而非报错，
// 等人发现往往已经晚了好几天。冒烟的任务是**每天主动摸一遍每个源的门**：
//   · 挂了/改了 → 第一时间红，CI 拦下主跑（needs 关系），不污染生产档；
//   · 顺带产出 data/smoke-latest.json（每源延迟/样本量/关键字段证据），留档可查。
//
// 六源（与 src/sources.js 生产抓取同一实现——冒烟与生产不得两套抓法）：
//   1. getharden 同花顺强势股（兼交易日探测）
//   2. 东财龙虎榜 RPT_DAILYBILLBOARD_DETAILSNEW
//   3. 同花顺行业 881xxx（板块列表 + 日K）
//   4. 腾讯三大指数 qt.gtimg.cn
//   5. 东财涨跌停/炸板池 push2ex
//   6. 同花顺大盘日K（两市成交额 Map）
//
// 纪律：
//   · 每源独立计时/独立捕获失败，一个源挂不拖累其他源的检测；
//   · 断言「结构」不 断言「数值」——数值随行情变，结构（字段名/类型/非空下限）才是源契约；
//   · LhbNotPublishedError（当日未公布）在盘后早跑是正常现象，按「暂未公布」报告不算挂。
//
// 用法：node scripts/smoke_sources.mjs   （任一源硬失败 → exit 1，CI 拦主跑）
import dns from 'node:dns';
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fetchHot, fetchLhb, fetchBoards, fetchIndexes, fetchPools, fetchAmountMap, LhbNotPublishedError,
} from '../src/sources.js';

// IPv4 优先（探针实测：默认 verbatim 会间歇 UND_ERR_SOCKET，误判「源不可用」）
dns.setDefaultResultOrder('ipv4first');

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'data', 'smoke-latest.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const record = (id, label, ms, ok, checks, error) => {
  results.push({ id, label, ok, latencyMs: Math.round(ms), checks, error: error ? String(error.message || error) : null });
  const mark = ok ? '✓' : '✗';
  console.log(`${mark} [${id}] ${label} (${Math.round(ms)}ms)`);
  for (const c of checks) console.log(`    ${c.ok ? '·' : '×'} ${c.name}${c.detail ? ': ' + c.detail : ''}`);
  if (error) console.log(`    错误: ${String(error.message || error).slice(0, 160)}`);
};

const guard = async (id, label, fn) => {
  const t0 = Date.now();
  try {
    const checks = await fn();
    const ok = checks.every((c) => c.ok);
    record(id, label, Date.now() - t0, ok, checks, null);
    return ok;
  } catch (e) {
    record(id, label, Date.now() - t0, false, [], e);
    return false;
  }
};
const ck = (name, ok, detail) => ({ name, ok: !!ok, detail: detail != null ? String(detail) : null });

// ── 交易日探测：getharden 返回的是「最近一个有数据的交易日」（周末跑 = 周五）──
let tradeDate = null;
let probeOk = false;
await guard('s1', '同花顺强势股 getharden', async () => {
  const rows = await fetchHot();
  tradeDate = rows[0] && rows[0].date;
  return [
    ck('HTTP 200 且 errocode=0（fetchHot 内建校验）', true),
    ck('data 非空数组', Array.isArray(rows) && rows.length > 0, `${rows.length} 条`),
    ck('交易日探测成功', !!tradeDate && /^\d{4}-\d{2}-\d{2}$/.test(tradeDate), tradeDate),
    ck('样本字段齐全（code/name/reason/date）', rows.slice(0, 50).every((r) =>
      typeof r.code === 'string' && /^\d{6}$/.test(r.code) && r.name && r.reason && r.date),
      `抽查前 ${Math.min(50, rows.length)} 条`),
  ];
}).then((ok) => { probeOk = ok; });

// getharden 本身挂了就没有交易日锚点，后续源用 archive 末日兜底（冒烟仍继续逐源摸门）
if (!tradeDate) {
  try {
    const arc = JSON.parse((await import('node:fs')).readFileSync(path.join(ROOT, 'data', 'archive.json'), 'utf8'));
    tradeDate = arc.all_days[arc.all_days.length - 1].trade_date;
    console.log(`⚠ getharden 未给出交易日，回退档案末日: ${tradeDate}`);
  } catch (e) { console.log('⚠ 无交易日锚点且无档案兜底——后续源断言将退化'); }
}
console.log(`—— 冒烟交易日锚点: ${tradeDate} ——\n`);

// ── 源2: 东财龙虎榜 ──
let lhbSoftSkip = false;
await guard('s2', '东财龙虎榜 RPT_DAILYBILLBOARD', async () => {
  let rows;
  try {
    rows = await fetchLhb(tradeDate);
  } catch (e) {
    if (e instanceof LhbNotPublishedError) {
      lhbSoftSkip = true;
      return [ck('当日未公布（盘后早跑正常态，非源故障）', true, tradeDate)];
    }
    throw e;
  }
  return [
    ck('HTTP 200（fetchLhb 内建）', true),
    ck('result.data 非空', rows.length > 0, `${rows.length} 条（≤5 页分页）`),
    ck('字段齐全（SECURITY_CODE/SECURITY_NAME_ABBR/TRADE_DATE）', rows.slice(0, 30).every((r) =>
      r.SECURITY_CODE && r.SECURITY_NAME_ABBR && r.TRADE_DATE), `抽查前 ${Math.min(30, rows.length)} 条`),
    ck('净额字段存在（BILLBOARD_NET_AMT/NET_BS_AMT）', rows.slice(0, 30).every((r) =>
      r.BILLBOARD_NET_AMT != null && r.NET_BS_AMT != null)),
  ];
});

// ── 源3: 同花顺行业 881xxx（列表 + 日K，4 路并发约 10-30s，只跑一次但字段断言完整）──
await guard('s3', '同花顺行业 881xxx 日K', async () => {
  const rows = await fetchBoards(tradeDate);
  return [
    ck('HTTP 200（fetchBoards 内建）', true),
    ck('板块数 ≥ 50', rows.length >= 50, `${rows.length} 个`),
    ck('字段齐全（name/change_pct 数值）', rows.every((r) => typeof r.name === 'string' && typeof r.change_pct === 'number' && Number.isFinite(r.change_pct))),
    ck('涨跌幅范围合法（|chg| ≤ 15%）', rows.every((r) => Math.abs(r.change_pct) <= 15), `极值 ${Math.min(...rows.map((r) => r.change_pct)).toFixed(2)} ~ ${Math.max(...rows.map((r) => r.change_pct)).toFixed(2)}`),
  ];
});

// ── 源4: 腾讯三大指数 ──
await guard('s4', '腾讯三大指数 qt.gtimg.cn', async () => {
  const idx = await fetchIndexes(tradeDate);
  const keys = Object.keys(idx);
  return [
    ck('HTTP 200（fetchIndexes 内建）', true),
    ck('三大指数齐全', keys.includes('上证指数') && keys.includes('深证成指') && keys.includes('创业板指'), keys.join('/')),
    ck('涨跌幅为数值', Object.values(idx).every((v) => typeof v === 'number' && Number.isFinite(v))),
  ];
});

// ── 源5: 东财涨跌停/炸板池 ──
await guard('s5', '东财涨跌停/炸板池 push2ex', async () => {
  const pools = await fetchPools(tradeDate);
  const has = (k) => pools[k] != null;
  return [
    ck('HTTP 200（fetchPools 内建重试）', true),
    ck('三池键存在（zt/dt/zb）', has('zt') && has('dt') && has('zb'), `zt=${pools.zt} dt=${pools.dt} zb=${pools.zb}`),
    ck('涨停池样本非空', pools.zt > 0, `${pools.zt} 家`), // 交易日涨停为 0 视为异常（结构信号）
    ck('计数为非负整数', ['zt', 'dt', 'zb'].every((k) => pools[k] == null || (Number.isInteger(pools[k]) && pools[k] >= 0))),
  ];
});

// ── 源6: 同花顺大盘日K → 成交额表 ──
let amountAnchor = null; // 主源锚点值（s6 顺产，对账 step 白嫖，s6 崩则保持 null）
await guard('s6', '同花顺大盘日K（两市成交额）', async () => {
  const anchor = (tradeDate || '').replace(/-/g, '');
  // 截断防护（2026-10-08 病因B）：同花顺年线间歇截断 → fetchAmountMap 内部腾讯实时
  //   两市兜底当日值（比值+区间护栏内建），锚点覆盖断言在截断日也能靠真值通过。
  const m = await fetchAmountMap({ anchor }); // ⚠ 返回普通对象 {YYYYMMDD: 亿}（非 Map，实测契约）
  const keys = Object.keys(m).sort();
  const latest = keys[keys.length - 1];
  const vals = keys.map((k) => m[k]);
  // 样本量降级为 warn（不拦构建）：当日值 + 两市护栏才是硬判据；样本不足时
  //   MA20/分位缺料走 missing 中性（宁缺勿假），不该用「样本量」把整条 CI 拦死。
  if (keys.length < 200) console.log(`    ⚠ [s6] 样本量 ${keys.length} 天 < 200——MA20/分位将走中性，不拦构建`);
  // 锚点值落盘（跨源对账 2026-10-08）：主源锚点日成交额优先，退化取最新日；
  // s6 崩则保持 null（对账 step 读到 null 自动跳过——s6 硬失败时守卫先说话，
  // 对账不重复告警）。
  const anchorVal = m[anchor] ?? m[latest] ?? null;
  amountAnchor = anchorVal != null
    ? { date: m[anchor] != null ? anchor : (latest || null), amountYi: anchorVal } : null;
  return [
    ck('HTTP 200（fetchAmountMap 内建）', true),
    ck('覆盖到冒烟锚点交易日', latest >= anchor, `最新 ${latest} vs 锚点 ${anchor}`),
    ck('成交额数值合理（1000~80000 亿）', vals.every((v) => v > 1000 && v < 80000), `区间 ${Math.min(...vals).toFixed(0)} ~ ${Math.max(...vals).toFixed(0)} 亿`),
  ];
});

// ── 汇总落盘 ──
const hard = results.filter((r) => !r.ok);
const soft = results.filter((r) => r.ok && lhbSoftSkip && r.id === 's2');
const report = {
  generatedAt: new Date().toISOString(),
  tradeDateAnchored: tradeDate,
  allOk: hard.length === 0,
  hardFail: hard.map((r) => r.id),
  lhbNotPublished: lhbSoftSkip,
  // 主源锚点值（跨源对账 2026-10-08）：s6 顺产的锚点交易日两市成交额（亿）——
  //   对账 step 用它 vs 东财备源互核，差值超阈值建 issue（纯观测不拦 build）。
  //   null = s6 未产出（对账 step 自动跳过，守卫先说话不重复告警）。
  amountAnchor,
  note: '冒烟与生产同源实现（src/sources.js）。任一硬失败 → CI needs 关系拦下主跑，不污染生产档。软失败（当日未公布）不算源故障。',
  sources: results,
};
mkdirSync(path.dirname(OUT), { recursive: true });
// writeJsonStable：剥时间戳后内容未变则跳过（冒烟含毫秒时延字段，天然每次都变——
// 此处接线只为统一出口；真正受益的是 universe / version-regression 这类确定性产物）
const { writeJsonStable } = await import('../src/lhb_codec.js');
const w = writeJsonStable(OUT, report, { readFileSync, writeFileSync, renameSync, unlinkSync, log: '[smoke]' });
if (w.skipped) console.log('[smoke] 报告内容未变（剥时间戳后），跳过写盘');

console.log(`\n[smoke] ${results.length - hard.length}/${results.length} 源通过${lhbSoftSkip ? '（LHB 当日未公布按软态计）' : ''}`);
if (hard.length) {
  console.log('[smoke] 硬失败: ' + hard.map((r) => r.id + ' ' + r.label).join(' | '));
  process.exit(1);
}
process.exit(0);
