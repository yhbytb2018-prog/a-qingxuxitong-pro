// 盘中轻量快照 —— 每 30 分钟跑一次，只更新「当前快照」，**绝不重算分位与因子**。
//
// 为什么需要它（以及为什么它必须是"轻量"的）：
//   盘后管道（18:30 首抓 / 21:00 补抓）跑的是完整链路：龙虎榜 + 席位明细 + 行业日K +
//   全市场标的池 + 情绪因子 + 分位重算，耗时数分钟且有严格的口径约束（分位必须基于
//   **同一个收盘口径的样本**才有统计意义）。盘中把它跑一遍会：
//     ① 把盘中未定盘的涨跌家数写进因子输入 → 情绪分在盘中反复跳变，分位失去意义；
//     ② 龙虎榜盘中根本没发布，必然抛 LhbNotPublishedError；
//     ③ 反复写盘产生大量无意义提交。
//
//   所以本脚本只做一件事：**抓三个盘中真实可得、且不参与打分的量**，写进独立的
//   data/intraday.json，并在 meta 里明确标注这是盘中快照而非收盘口径。
//
// 抓什么 / 不抓什么（判据是"盘中是否真实可得"+"是否会被误当成收盘值"）：
//   抓：hot（同花顺强势股，兼交易日探测）、pools（东财涨跌停/炸板池，盘中实时）、
//       breadth（东财涨跌家数，盘中实时）。三者都是**当下时点的快照**，语义天然与时间绑定。
//   不抓：lhb / seats / industry / indexes / amount 日序列 —— 盘中或未发布、或不是当日值，
//         抓回来只会制造"看起来是当日收盘值"的假数据。
//
// 三态校验（缺一不可，宁可什么都不写也不写错）：
//   ① 相位必须是 live（非交易日 / 开盘前 / 收盘后，本脚本直接跳过，交给盘后管道）；
//   ② 强势股接口返回的 date 必须等于北京当日（跨日 / 陈旧数据 → 跳过）；
//   ③ 三个源至少要有一个成功（全失败 → 只更新 lastAttempt，不覆盖上一次成功的快照，
//      否则一次网络抖动会把页面上已有的盘中止盈/涨停数据抹成空白）。
//
// 用法：
//   node scripts/snapshot_intraday.mjs            抓取并写盘（相位非 live 时自动跳过）
//   node scripts/snapshot_intraday.mjs --dry      只抓不写
//   node scripts/snapshot_intraday.mjs --force    忽略相位判定（测试用）
//   node scripts/snapshot_intraday.mjs --at <iso> 按指定时刻判定相位（测试用）
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { atomicWriteJSON } from '../src/fsutil.js';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../src/config.js';
import { resolveHolidays } from '../src/calendar.js';
import { fetchHot, fetchPools, fetchBreadth } from '../src/sources.js';
import { marketPhase, bjDate, bjTime } from '../src/freshness.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'intraday.json');
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const FORCE = argv.includes('--force');
const ai = argv.indexOf('--at');
const now = ai >= 0 ? new Date(argv[ai + 1]) : new Date();

// 快照版本：字段增删时递增，便于下游判断能读到什么（老快照缺新字段时不冒充完整）
export const SNAPSHOT_VERSION = 1;

const log = (...a) => console.log('[intraday]', ...a);

// ── ① 相位闸门 ────────────────────────────────────────────────────────────────
const ph = marketPhase(now, resolveHolidays());
if (ph.phase !== 'live' && !FORCE) {
  log(`相位 ${ph.phase}（北京 ${ph.bjDate} ${ph.bjTime}，${ph.isTradingDay ? '交易日' : '非交易日'}）→ 非盘中，跳过。`);
  log('盘后数据由 18:30 / 21:00 的完整管道负责，本脚本不重复做。');
  process.exit(0);
}
log(`相位 ${FORCE && ph.phase !== 'live' ? ph.phase + '（--force 强制）' : ph.phase}，北京 ${ph.bjDate} ${ph.bjTime}`);

// ── ② 抓取三个盘中源（互不阻塞：各自 try，全失败才算失败）────────────────────
const [hotR, poolsR, breadthR] = await Promise.allSettled([fetchHot(), fetchPools(ph.bjDate), fetchBreadth()]);

const hot = hotR.status === 'fulfilled' ? hotR.value : null;
const pools = poolsR.status === 'fulfilled' ? poolsR.value : null;
const breadth = breadthR.status === 'fulfilled' ? breadthR.value : null;

const errs = [];
if (!hot) errs.push('hot: ' + String(hotR.reason?.message || hotR.reason));
if (!pools) errs.push('pools: ' + String(poolsR.reason?.message || poolsR.reason));
if (!breadth) errs.push('breadth: ' + String(breadthR.reason?.message || breadthR.reason));
for (const e of errs) log('源失败 →', e);

// ── ③ 交易日核验：强势股返回的 date 必须等于北京当日 ──────────────────────────
// 为什么必须核：该接口在非交易日 / 数据源未切换时会**返回上一交易日的数据**（不报错）。
// 若不核验就落盘，会把昨天的强势股当成今天的盘中快照——这是比"抓失败"更危险的静默错。
let hotDate = null;
if (hot && hot.length) hotDate = hot[0].date || null;
if (hotDate && hotDate !== ph.bjDate) {
  log(`强势股返回交易日 ${hotDate} ≠ 北京当日 ${ph.bjDate} → 数据源尚未切换到当日，跳过落盘。`);
  process.exit(0);
}

const anyOk = !!(hot || pools || breadth);
if (!anyOk) {
  log('三个源全部失败 → 本次不覆盖已有快照（避免网络抖动把页面刷成空白）。');
}

// ── ④ 组装快照（只放「当下时点」语义明确的量，并逐项标注探测时点）──────────
const snapshot = {
  version: SNAPSHOT_VERSION,
  kind: 'intraday',                        // 与 archive.json 的收盘口径明确区分
  tradeDate: ph.bjDate,
  capturedAt: now.toISOString(),
  capturedAtBJ: `${ph.bjDate} ${ph.bjTime}`,
  phase: ph.phase,
  // 口径纪律：本文件里的任何数值都**不得**喂给情绪因子或分位。
  //   下方 breadth/pools 是盘中实时值，而分位是按收盘值算的——两者不同尺度。
  caliberNote: '盘中快照：数值为抓取时刻的实时值，未定盘；禁止用于情绪因子/分位/回测（那些一律用收盘口径的 archive.json）。',
  hot: hot ? {
    count: hot.length,
    srcDate: hotDate,
    // 只留报告要用的字段，控制文件体积（<200KB）
    rows: hot.slice(0, 200).map((x) => ({
      code: x.code, name: x.name, reason: x.reason || '',
      close: x.close != null ? +x.close : null,
      change_pct: x.zhangfu != null ? +x.zhangfu : null,
      huanshou: x.huanshou != null ? +x.huanshou : null,
    })),
  } : null,
  pools: pools ? {
    zt: pools.zt, zb: pools.zb, dt: pools.dt,
    max_lb: pools.max_lb, lb2: pools.lb2,
    zt_codes: pools.zt_codes || null,
    // 盘中封板率：分母同样是"触板个股"（涨停 + 炸板），与收盘口径同一算法
    seal_pct: (pools.zt != null && pools.zb != null && (pools.zt + pools.zb) > 0)
      ? Math.round((pools.zt / (pools.zt + pools.zb)) * 1000) / 10 : null,
  } : null,
  breadth: breadth ? { up: breadth.up, down: breadth.down, flat: breadth.flat } : null,
  sourcesFailed: errs.length ? errs : [],
};

// ── ⑤ 写盘（保留上一次成功的快照供对比，但只保留最近一次，不做历史堆积）────
let prev = null;
if (existsSync(OUT)) { try { prev = JSON.parse(readFileSync(OUT, 'utf8')); } catch { prev = null; } }

if (!anyOk) {
  // 全失败：只更新 failed 留痕，不覆盖成功的快照内容
  if (prev) {
    prev.lastFailedAt = now.toISOString();
    prev.sourcesFailed = errs;
    if (!DRY) atomicWriteJSON(OUT, JSON.stringify(prev, null, 2));
    log('已仅追加失败留痕，保留上次成功快照（' + (prev.capturedAtBJ || '?') + '）。');
  } else {
    log('无历史快照且本次全失败 → 不生成文件。');
  }
  process.exit(0);
}

// 与上一次成功快照的差异（供页面显示"距上次快照涨跌停数变化"这类盘中动量的朴素证据）
snapshot.prevCapturedAtBJ = prev && prev.pools ? (prev.capturedAtBJ || null) : null;
snapshot.prevPools = prev && prev.pools ? { zt: prev.pools.zt, zb: prev.pools.zb, seal_pct: prev.pools.seal_pct } : null;

log(`抓取完成：强势股 ${snapshot.hot ? snapshot.hot.count : '—'} 只 · 涨停 ${pools?.zt ?? '—'} / 炸板 ${pools?.zb ?? '—'}`
  + ` / 跌停 ${pools?.dt ?? '—'} · 涨跌家数 ${breadth ? `${breadth.up}/${breadth.down}` : '—'}`);
if (snapshot.pools?.seal_pct != null) log(`盘中封板率 ${snapshot.pools.seal_pct}%（分母=触板个股 ${pools.zt + pools.zb}）`);

if (DRY) { log('（--dry：仅预览，未写盘）'); process.exit(0); }
mkdirSync(dirname(OUT), { recursive: true });
atomicWriteJSON(OUT, JSON.stringify(snapshot, null, 2));
log('已写回', OUT, `（${(JSON.stringify(snapshot).length / 1024).toFixed(1)} KB）`);
