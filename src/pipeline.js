// 管道编排：抓取(或离线回放) -> 引擎计算 -> 校验 -> 写出 archive.json
//
// 引擎拆分（2026-10-05 批次3 4.1）：
//   · 纯计算引擎已迁至 src/engine/——recalc.js（全档重算）、enrich.js（题材去噪+动量）、
//     write.js（存档写盘+切片生成），函数体逐字搬移、零语义改动；
//   · 本文件保留**编排层**：runOffline / runLive / main / refreshMetaOnly /
//     refreshUniverseOnly / fallbackArchive / mergeNewDays / extractArchive；
//   · 下方对引擎模块 re-export，16 个既有调用方（9 scripts + 7 tests）import 路径零改动。
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import config from './config.js';
import { fetchLive, LhbNotPublishedError, applyLhb, fetchLhb, fetchSeats } from './sources.js';
import { todayBeijing, isTradingDay } from './util.js';
import { resolveHolidays } from './calendar.js';
import { applyFreshnessMeta, applyPhaseMeta, freshnessKey } from './freshness.js';
import { buildReasonCodes, encodeArchive, decodeArchive } from './lhb_codec.js';
// 运维告警（降维预埋 · 2026-10-02）：拦截器（freshness/lastAttempt/imputed/missing/dataQuality）
// 的坏事实 → 结构化事件 → 落盘 + 可选企微推送（OPS_WEBHOOK 环境变量，未配置则零打扰）。
import { opsEventsFromArchive, writeOpsAlerts, pushOpsAlerts } from './opsalerts.js';
import { computeRecomputeScope, needFetch } from './idempotence.js';
import { recalcAll } from './engine/recalc.js';
import { enrich } from './engine/enrich.js';
import { writeArchive, writeShards } from './engine/write.js';
import { atomicWriteJSON } from './fsutil.js';

// 引擎 re-export（兼容层）：新代码请直接 import './engine/*.js'
export { recalcAll } from './engine/recalc.js';
export { enrich } from './engine/enrich.js';
export { writeArchive, writeShards } from './engine/write.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

// 从页面 HTML 抽取内嵌 JSON（平衡花括号）
export function extractArchive(html) {
  const start = html.indexOf('{"meta"');
  if (start < 0) throw new Error('未找到内嵌 JSON');
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\' && inStr) { esc = true; continue; }
    if (ch === '"' && !inStr) inStr = true;
    else if (ch === '"' && inStr) inStr = false;
    else if (!inStr) {
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
  }
  return JSON.parse(html.slice(start, end));
}

// 离线回放：从已有页面快照重建
export function runOffline(snapshotPath) {
  // 快照缺失时给出可行动的指引，而不是抛裸 ENOENT 栈（裸跑 node src/pipeline.js
  // 的默认模式就是 offline——新接手的人第一次跑就该知道往哪走）。
  if (!existsSync(snapshotPath)) {
    console.error(`[offline] 缺快照文件：${snapshotPath}`);
    console.error('[offline] 离线回放需先用 scripts/snapshot_intraday.mjs 保存快照页（SNAPSHOT 环境变量可指定路径）；');
    console.error('[offline] 生产运行请用 MODE=live node src/pipeline.js（非交易日会自动跳过抓取）。');
    process.exit(1);
  }
  const html = readFileSync(snapshotPath, 'utf8');
  const arc = extractArchive(html);
  const allDays = arc.all_days || [];
  const { out, momObj } = enrich(allDays);
  recalcAll(out); // 统一公式重算（无原始数据的种子天自动 legacy 保留）
  const latest = out[out.length - 1];
  const archive = {
    meta: {
      generatedAt: new Date().toISOString(),
      formulaVersion: config.formulaVersion,
      source: 'offline-replay',
      note: '离线回放：情绪分沿用快照，题材已去噪。生产环境请跑 live 模式。',
    },
    all_days: out,
    signals: {
      version: config.formulaVersion,
      momentum: momObj,
      latestEmotion: latest.emotion,
      imputedRatioLatest: latest.emotion?.imputedRatio ?? 0,
      tradeDate: latest.trade_date,
    },
  };
  return archive;
}

/**
 * 把新抓交易日合并进历史（就地更新 history）：
 *  - 同日已存在 → 替换；席位明细取覆盖率更高的一份（防新抓批次倒退）
 *  - 新天涨跌家数缺失而旧档有值 → 用旧档回填，防重跑降级
 * 返回 {replaced, appended, breadthFilled}，便于测试与日志。
 *
 * 注：此函数曾被 8853a17 引入的 `old is not defined` 打挂（引用未声明变量），
 * 导致 runLive 每次重跑当日数据都抛 ReferenceError → 整体回退 → meta.stale 恒为 true。
 * 抽为纯函数以便回归测试守护。
 */
export function mergeNewDays(history, newDays) {
  let replaced = 0, appended = 0, breadthFilled = 0;
  for (const nd of newDays) {
    const i = history.findIndex((d) => d.trade_date === nd.trade_date);
    if (i >= 0) {
      const old = history[i];
      const oldSeats = old.summary?.seats, newSeats = nd.summary?.seats;
      const oldBetter = oldSeats && newSeats && oldSeats.detail && !newSeats.detail && oldSeats.cover > newSeats.cover;
      if (oldSeats && oldBetter) {
        nd.summary = nd.summary || {};
        nd.summary.seats = oldSeats;
      }
      // 涨跌家数偶发抓取失败：新天缺失而旧档有值则回填，防重跑降级
      if (old.summary?.up_count != null && nd.summary?.up_count == null) {
        nd.summary = nd.summary || {};
        for (const k of ['up_count', 'down_count', 'flat_count']) nd.summary[k] = old.summary[k];
        breadthFilled++;
        console.log('[merge-breadth]', nd.trade_date, '回填涨跌家数', old.summary.up_count, '/', old.summary.down_count);
      }
      history[i] = nd;
      replaced++;
    } else {
      history.push(nd);
      appended++;
    }
  }
  return { replaced, appended, breadthFilled };
}

// 线上模式：抓取真实数据，合并进已存档历史 → 全档重算分位
// fetchLive 返回 { newDays:[day], tradeDate }，day 结构与快照一致
export async function runLive() {
  const { newDays, tradeDate } = await fetchLive();
  // 载入历史（冷启动用快照种子）
  let history = [];
  const dataPath = path.join(DATA_DIR, 'archive.json');
  if (existsSync(dataPath)) {
    // 读回来必须 decode：主档是码表压缩态，reasons 被换成了下标数组。
    // 直接喂给 caliberFromDay 会让 isRangeBoard 拿不到中文原文而静默失配——
    // 表现就是「区间榜被当成当日榜」，区间累计值混进日度因子。
    try { history = decodeArchive(JSON.parse(readFileSync(dataPath, 'utf8'))).all_days || []; } catch { history = []; }
  }
  if (!history.length) {
    history = runOffline(path.join(ROOT, 'snapshot.html')).all_days || [];
  }
  const merged = mergeNewDays(history, newDays);
  console.log('[merge] 替换', merged.replaced, '| 新增', merged.appended,
    '| 涨跌家数回填', merged.breadthFilled);
  history.sort((a, b) => (a.trade_date < b.trade_date ? -1 : 1));

  // 龙虎榜晚间分批披露：重抓上一交易日 lhb 刷原始数据（行业/涨跌停池收盘即定死，无需补抓）
  //
  // ★ #134b：抓取前先问"手上这份数据凭什么可信、够不够新"（needFetch 的凭据判据），
  //   而不是无条件重抓。已定稿（当日北京 ≥21:00）+ 龙虎榜有量 + 席位覆盖 100% → 跳过。
  //   ⚠ 判据刻意保守：任何一项不确定/缺失都倾向"重抓"（多抓一次只是花时间，
  //     少抓一次会产生"数据看着正常但其实是旧的"——本项目最危险的失败）。
  //   实测：长假后首个交易日那晚，上一交易日通常已定稿满覆盖 → 省下 1 次 lhb + 1 次 seats 请求。
  const prevDays = history.filter((d) => d.trade_date < tradeDate).slice(-1);
  let skippedFetch = 0;
  for (const day of prevDays) {
    const prem = needFetch(day, { now: new Date(), tradeDate: day.trade_date });
    if (!prem.need) {
      skippedFetch++;
      console.log('[refresh-lhb]', day.trade_date, '按凭据跳过重抓：', prem.reason);
      continue;
    }
    try {
      const lhbRaw = await fetchLhb(day.trade_date);
      applyLhb(day, lhbRaw);
      console.log('[refresh-lhb]', day.trade_date, '补抓成功, 榜单', lhbRaw.length, '条');
    } catch (e) {
      if (e instanceof LhbNotPublishedError) console.log('[refresh-lhb]', day.trade_date, '未公布，跳过');
      else console.error('[refresh-lhb]', day.trade_date, '失败:', e.message);
    }
    // 席位明细同样晚间分批发布：上一交易日覆盖率不满、缺逐票明细（锁仓口径原料），
    // 或明细仍是**旧格式（仅买方，无卖侧）**则补抓（取优）。第三项是本次买卖双侧升级后的关键：
    // 旧档 detail 是买方数组（真值判断为真），若不加这条，历史天数永远不会补上卖方明细。
    if (Array.isArray(day.lhb_aggr) && day.lhb_aggr.length) {
      const oldCover = day.summary?.seats?.cover ?? 0;
      const oldDetail = day.summary?.seats?.detail;
      const noSellSide = oldDetail && Object.values(oldDetail).some((v) => Array.isArray(v));
      if (oldCover < 100 || !oldDetail || noSellSide) {
        try {
          const seats = await fetchSeats(day.trade_date, day.lhb_aggr.map((l) => ({ code: l.code, name: l.name, net_buy_wan: l.net_buy_wan })));
          const newHasSell = seats.detail && Object.values(seats.detail).some((v) => v && !Array.isArray(v) && (v.s || []).length);
          if (seats.cover > oldCover || !oldDetail || newHasSell) {
            day.summary = day.summary || {};
            day.summary.seats = seats;
            console.log('[refresh-seats]', day.trade_date, '补抓席位 cover', oldCover, '→', seats.cover + '%');
          }
        } catch (e) { console.error('[refresh-seats]', day.trade_date, '失败:', e.message); }
      }
    }
  }

  // ★ #134b：重算范围从"全档 241 天"缩到"真正会变的那几天"。
  //   依据是**已落盘的证据**（当日新抓 + 上一交易日席位凭据不足），不是日期差。
  //   正确性前提：本管线无跨日前视依赖（见 src/engine/recalc.js 的 recalcAll 头注），由
  //   test/pipeline_scope.test.mjs 用真档案证明"带 scope 与全档重算逐字段相同"。
  //   ⚠ 若将来引入任何"依赖未来天或档案总长度"的派生指标，必须同时修改此处
  //     （改回全档）——否则历史天会停在旧值，且**不会有任何报错**。
  const rescope = computeRecomputeScope(history);
  console.log('[rescan]', rescope.full ? '全档' : '增量', rescope.dates.length + '/' + history.length, '天：', rescope.dates.join('、') || '（无）');
  console.log('[rescan]', rescope.reason);

  recalcAll(history, { scope: rescope });
  const { out, momObj } = enrich(history);
  const latest = out[out.length - 1];
  const archive = {
    meta: {
      generatedAt: new Date().toISOString(),
      formulaVersion: config.formulaVersion,
      source: 'live',
      tradeDate,
    },
    all_days: out,
    signals: {
      version: config.formulaVersion,
      momentum: momObj,
      latestEmotion: latest.emotion,
      imputedRatioLatest: latest.emotion?.imputedRatio ?? 0,
      tradeDate: latest.trade_date,
    },
  };
  return archive;
}

// 主入口
export async function main() {
  const mode = process.env.MODE || 'offline';
  const dataPath = path.join(DATA_DIR, 'archive.json');
  const now = new Date();

  // 非交易日：live 模式不抓数据，但仍刷新 meta 的新鲜度判定（自愈可能粘着的旧标记）
  const today = todayBeijing();
  if (mode === 'live' && !isTradingDay(today, resolveHolidays())) {
    console.log('[skip]', today, '非交易日，保留上次数据');
    refreshMetaOnly(dataPath, now, { outcome: 'non-trading-day', reason: `${today} 非交易日` });
    // 标的池是**日期敏感**的派生物：active（近 30 交易日）与 quoteFresh（== 最新交易日）
    // 都会随时间推移而变化。非交易日不重建，长假 7 天后池子仍宣称「当日有价 66 只」——
    // 用户按它下单会拿到 9 天前的陈旧价，而界面上的日期徽章是对的、只有池子标签在说谎。
    // 重建本身零成本（纯读主档 + 纯函数推导，不发网络请求），故这里无条件刷新。
    refreshUniverseOnly(today);
    return null;
  }

  let archive;
  let attempt;
  if (mode === 'live') {
    try {
      archive = await runLive();
      attempt = { outcome: 'ok', reason: null };
    } catch (e) {
      if (e instanceof LhbNotPublishedError) {
        console.log('[skip]', e.message, '· 等待龙虎榜公布，保留上次数据');
        console.log('::warning::本次未抓取：' + e.message + '（保留上次数据；18:30 首抓 / 21:00 补抓）');
        refreshMetaOnly(dataPath, now, { outcome: 'skipped', reason: e.message });
        return null;
      }
      console.error('[live] 抓取失败，回退:', e.message);
      console.log('::warning::live 抓取失败，本次写入回退档（meta.lastAttempt.outcome=failed）：' + e.message);
      archive = fallbackArchive(dataPath, e.message);
      attempt = { outcome: 'failed', reason: e.message };
    }
  } else {
    archive = runOffline(process.env.SNAPSHOT || path.join(ROOT, 'snapshot.html'));
    attempt = { outcome: 'offline-replay', reason: null };
  }
  applyFreshness(archive, now, attempt);
  const res = writeArchive(archive, dataPath);
  console.log('写入', res.path, '| 交易日', archive.signals.tradeDate,
    '| 新晋', archive.signals.momentum.fresh.length,
    '| 退潮', archive.signals.momentum.fading.length,
    '| 补位比', archive.signals.imputedRatioLatest,
    '| 情绪分', archive.signals.latestEmotion?.value ?? archive.signals.latestEmotion?.score);
  console.log('[freshness]', archive.meta.freshness.state, '| stale =', archive.meta.stale,
    archive.meta.staleReason ? '| ' + archive.meta.staleReason : '| 数据为最新已收盘会话');
  // ── 运维告警挂钩（拦截器 → 事件 → 落盘 + 可选推送）─────────────────────────
  // 纪律：告警链路自身任何失败都不得影响主管道（双保险：这里 try-catch，模块内部也不抛）。
  // 落盘无条件执行（0 条也写「体检通过」档）——CI 提交步骤依赖文件存在，且每次体检留痕可查。
  try {
    const opsEvents = opsEventsFromArchive(archive, { warnImputedRatio: config.healthWarnImputedRatio });
    writeOpsAlerts(opsEvents, path.join(ROOT, 'data', 'ops-alerts-latest.json'));
    if (opsEvents.length) {
      const pushed = await pushOpsAlerts(opsEvents, {});
      const bySev = opsEvents.reduce((a, e) => ({ ...a, [e.severity]: (a[e.severity] || 0) + 1 }), {});
      console.log('[ops-alert]', opsEvents.length, '条', JSON.stringify(bySev),
        pushed.pushed ? `→ 已推送 ${pushed.pushed} 条` : pushed.error ? `→ 推送失败（${pushed.error}，已落盘可查）` : '→ 未配置 OPS_WEBHOOK，仅落盘');
    } else {
      console.log('[ops-alert] 体检通过，0 条事件（已落盘留痕）');
    }
  } catch (e) {
    console.log('[ops-alert] 评估失败（不影响主管道）:', e.message);
  }
  return archive;
}

// 把新鲜度判定写进 meta（成功/回退/跳过三条路径统一口径）。
// stale 不再表示「上次尝试失败」，而是「存档交易日落后于最近已收盘交易日且已过预期更新时刻」，
// 由 assessFreshness 按交易日历算；抓取是否成功另记于 meta.lastAttempt。
//
// 相位（phase）与新鲜度（state）正交，必须一起写：前者说「现在市场在什么阶段」，
// 后者说「存档是不是最新已收盘会话」。盘中跑快照时 phase=live 而 state 仍指上一收盘日——
// 两者同时出现才是准确的，缺一个读者就会误读「实时数据 vs 收盘分位」。
function applyFreshness(archive, now, attempt) {
  archive.meta = archive.meta || {};
  const tradeDate = archive.meta.tradeDate
    || archive.signals?.tradeDate
    || (archive.all_days || []).slice(-1)[0]?.trade_date
    || null;
  applyFreshnessMeta(archive.meta, tradeDate, now, resolveHolidays(), attempt);
  applyPhaseMeta(archive.meta, now, resolveHolidays());
  return archive;
}

// 只刷新存档 meta 的判定字段（不碰数据）。用于「跳过 / 非交易日」：
// 这些路径没有新数据，但新鲜度判定必须跟着时间走，否则旧标记会一直粘着页面。
function refreshMetaOnly(dataPath, now, attempt) {
  if (!existsSync(dataPath)) return null;
  let a;
  try { a = decodeArchive(JSON.parse(readFileSync(dataPath, 'utf8'))); } catch { return null; }
  const before = freshnessKey(a.meta);
  const f = applyFreshness(a, now, attempt).meta.freshness;
  if (freshnessKey(a.meta) === before) {
    console.log('[freshness] meta 未变化 |', f.state);
    return a;
  }
  // 刷新 meta 也必须走压缩写盘，否则会把刚压好的主档「解压」回中文原文（体积翻数倍）。
  // 这里重新编码是幂等的：entries 已带 rc 时 encodeDay 原样返回。
  // H-4（2026-10-07）：原子替换——裸写 meta 刷新（全档重编码）中途被杀会留半截主档，
  // 读取端 catch 会静默回退旧快照，损坏被降级成"旧但合法"。
  atomicWriteJSON(dataPath, JSON.stringify(encodeArchive(a, buildReasonCodes(a.all_days))));
  // 切片必须跟着刷新：首屏读的是 archive-index.json 的 meta（相位/新鲜度），
  // 只更新主档会让页面顶部的相位标签与 STALE 标记停在旧值上——而这两者恰恰是
  // 「数据是否可信」的唯一提示，过期比没有更危险。
  if (path.basename(dataPath) === 'archive.json') {
    try { writeShards(a); } catch (e) { console.error('[split] 切片刷新失败:', e.message); }
  }
  console.log('[freshness] meta 已刷新 |', f.state, '| stale =', a.meta.stale,
    a.meta.staleReason ? '| ' + a.meta.staleReason : '');
  return a;
}

/**
 * 非交易日也重建标的池。
 *
 * 为什么必须做：池子里有两个**随时间漂移**的字段——
 *   · active     = 最近 30 个交易日内出现过（窗口在滑）
 *   · quoteFresh = asOf === 主档最新交易日
 * 平时这两个字段由管道每交易日重建，看不出问题；但**长假期间管道整段跳过**，
 * 于是 7 天国庆后池子仍写着「当日有价 66 只 · 活跃 N 只」，而实际上所有价都已陈旧。
 * 界面上的行情徽章取的是实时价（真话），池子标签却是 9 天前算的（假话）——两者矛盾时用户会信错的。
 *
 * 为什么不干脆不在非交易日 tag 上「今日」：报价新鲜度是**数据属性**，不是渲染属性。
 * 让 UI 去减日期差就是第二套口径；正确做法是让数据本身跟着日历走。
 *
 * 实现：读主档 → 纯函数重算 → 写盘（紧凑）。零网络请求，失败只告警不影响主档。
 */
function refreshUniverseOnly(today) {
  const script = path.join(ROOT, 'scripts', 'fetch_universe.mjs');
  if (!existsSync(script)) return null;
  try {
    // 用子进程跑，保证与 CI / 本地手动执行**同一条代码路径**（绝不在此重写一份池子构建逻辑）。
    const r = spawnSync(process.execPath, [script], { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) {
      console.log('::warning::非交易日标的池重建失败：' + (r.stderr || r.stdout || '').trim().split('\n').slice(-2).join(' '));
      return null;
    }
    const tail = (r.stdout || '').trim().split('\n').slice(-1)[0];
    console.log('[universe] 非交易日已按日历重建标的池 |', today, '|', tail);
    return tail;
  } catch (e) {
    console.log('::warning::非交易日标的池重建异常：' + e.message);
    return null;
  }
}

// 回退：优先用已提交的真实 archive.json（记录原因），否则用快照演示数据。
// 注：这里的 stale=true 只是保守默认值，随后 applyFreshness 会按日历重算——
// 若回退档的数据本就是最新已收盘会话，不该继续误报滞后。
function fallbackArchive(dataPath, reason) {
  const mark = (a) => {
    a.meta = a.meta || {};
    a.meta.stale = true;
    if (reason) a.meta.fallbackReason = reason;
    return a;
  };
  if (existsSync(dataPath)) {
    return mark(decodeArchive(JSON.parse(readFileSync(dataPath, 'utf8'))));
  }
  return mark(runOffline(process.env.SNAPSHOT || path.join(ROOT, 'snapshot.html')));
}

// 直接运行时执行（用 pathToFileURL 比较：Windows 下 argv[1] 是 C:\… 而 import.meta.url 是 file:///C:/…，
// 直接拼 'file://' + argv[1] 恒不相等 → 本地直跑会静默什么都不做）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
