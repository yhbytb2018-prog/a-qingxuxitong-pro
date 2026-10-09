#!/usr/bin/env node
// 抓取外围市场行情 → data/global.json
//
// 为什么单独一个脚本、而不并进 src/pipeline.js：
//   pipeline 在非交易日会整段跳过（A 股休市就不抓）。而外围数据**恰恰必须**在休市期间
//   更新——长假后预案靠的就是假期里积累的那几个美股交易日的方向。所以这里独立成步，
//   在 CI 里每个工作日都跑，与 A 股是否开市无关。
//
// 用法：node scripts/fetch_global.mjs
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJSON } from '../src/fsutil.js';
import config from '../src/config.js';
import { buildGlobalSnapshot, evaluateGlobalWatch, SINA_URL, SINA_CODES, usSessionReadiness } from '../src/global.js';
import { nextSession } from '../src/freshness.js';
import { todayBeijing, isTradingDay, fetchWithRetry } from '../src/util.js';
import { resolveHolidays } from '../src/calendar.js';
import { decodeArchive } from '../src/lhb_codec.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36';
const ARCHIVE = new URL('../data/archive.json', import.meta.url);
const OUT = new URL('../data/global.json', import.meta.url);
// ⚠ OUT 是 URL 对象：readFileSync(URL) 官方支持；但 atomicWriteJSON 只收字符串路径——
//   H-4 原子写改造（10-07 78f1376）把 writeFileSync(OUT) 换成 atomicWriteJSON(OUT) 后，
//   URL 被当相对路径拼接 → Windows 下 ENOENT 崩、CI 04:40 美股班实录挂掉。
//   写入一律 fileURLToPath(OUT)（10-08 修复），读取保持 URL。

const shiftDay = (dateStr, n) => {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** 带退避的抓取（重试已收敛至 util.fetchWithRetry，全仓唯一实现）。
 *  GBK 解码——新浪仍以 GBK 返回，按 utf-8 解会成乱码——放进 opts.read，解码失败同样计入重试范围。 */
async function fetchSina(retries = 3) {
  return fetchWithRetry(SINA_URL + SINA_CODES, {
    headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn' },
    timeout: 15000,
    read: async (r) => new TextDecoder('gbk').decode(await r.arrayBuffer()),
  }, retries, 1200);
}

/** 读 A 股存档当前交易日：外围快照要对齐它，才能算「假期里还攒了几个美股交易日」 */
function readTradeDate() {
  try {
    return decodeArchive(JSON.parse(readFileSync(ARCHIVE, 'utf8')))?.meta?.tradeDate || null;
  } catch { return null; }
}

/** [from, to] 内的工作日列表（YYYY-MM-DD）——美股无假期落在国庆窗口内，工作日即交易日 */
function listWeekdays(from, to) {
  const out = [];
  if (!from || !to || from > to) return out;
  for (let d = from; d <= to; d = shiftDay(d, 1)) {
    const w = new Date(d + 'T00:00:00Z').getUTCDay();
    if (w !== 0 && w !== 6) out.push(d);
  }
  return out;
}

/** 内容指纹：排除 generatedAt（每次都变），否则每次运行都产生无意义提交 */
function contentKey(s) {
  return JSON.stringify({
    u: s?.meta?.usSessionDate, t: s?.meta?.aShareTradeDate, o: s?.meta?.aShareNextOpen,
    h: s?.meta?.aShareHoliday, d: s?.meta?.usSessionDates, f: s?.meta?.failed, r: s?.rmb, w: s?.watch,
    q: (s?.quotes || []).map((x) => [x.key, x.last, x.prevClose, x.quoteTime, x.ok]),
  });
}

async function main() {
  // 写入前确保 data/ 目录存在（CI 全新 checkout 时可能未创建 → atomicWriteJSON ENOENT）。
  // 放在开头，主路径与容灾路径（保留上次快照）两处 atomicWriteJSON 都被覆盖。
  const outPath = fileURLToPath(OUT);
  const outDir = path.dirname(outPath);
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  const tradeDate = readTradeDate();
  const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;

  // ── 抓取时机自检（2026-10-01 事故的第二重成因）────────────────────────────
  //   事故回放：脚本在北京 21:10 跑（= 美东 09:10），美股 09:30 才开盘 → 抓到盘前占位，
  //   last==prevClose、open/high/low 全 0 → 被当成"当日收平 0%"渲染给用户。
  //   根因不是计算，是**在错误时刻取数**：再准的口径也救不回盘前的空数据。
  //   处理分两层：
  //     ① 行情层（src/global.js inferQuoteState）：未成交一律 state=preopen、chgPct=null，
  //        从源头杜绝"0%" —— 这一层与运行时刻无关，是**硬防线**；
  //     ② 时刻层（本节）：若此刻美股档未就绪，明确告知"美股档暂不可采信"，
  //        并在快照 meta 里留痕，让前端/守卫都能看见。
  //   注意：**不因为美股没收盘就整个跳过抓取** —— A50/汇率/商品是连续交易，
  //   它们才是长假期间的方向主锚（A50 权重最高），停抓反而丢失关键信息。
  const now = new Date();
  const readiness = usSessionReadiness(now);
  if (!readiness.ready) {
    console.warn(`⚠ 美股档未就绪（${readiness.reason}）——本次仍抓取，但美股那一档按"无数据"处理`);
  }

  let raw;
  try {
    raw = await fetchSina();
  } catch (e) {
    // 容灾：抓不到就保留上次快照，只把「本次尝试失败」写进去让页面看得见。
    // 外围不是关键路径，不能因为它把整条 CI 拖挂。
    console.warn('⚠ 外围抓取失败（保留上次快照）:', e.message);
    if (prev) {
      prev.meta = prev.meta || {};
      prev.meta.lastAttempt = { at: new Date().toISOString(), outcome: 'failed', reason: e.message };
      atomicWriteJSON(fileURLToPath(OUT), JSON.stringify(prev, null, 2) + '\n');
    }
    return;
  }

  const holidays = resolveHolidays() || [];
  const today = todayBeijing();
  const nextOpen = tradeDate ? nextSession(tradeDate, holidays) : null;

  const snap = buildGlobalSnapshot({ raw, generatedAt: now.toISOString(), aShareTradeDate: tradeDate });
  snap.meta.aShareNextOpen = nextOpen;
  snap.meta.aShareHoliday = !isTradingDay(today, holidays); // 今天 A 股是否休市
  // A 股开市前**还剩**几个美股交易日：(today 与 tradeDate+1 取较晚者, nextOpen-1) 内的工作日。
  // 例：今天 10-01、tradeDate 09-30、nextOpen 10-08 → 10-01/02/05/06/07 共 5 个
  //（10-07 那场收盘在 10-08 04:00 北京，仍早于 A 股 09:30 开盘，算得进来）。
  const from = tradeDate ? (shiftDay(tradeDate, 1) > today ? shiftDay(tradeDate, 1) : today) : today;
  snap.meta.usSessionDates = nextOpen ? listWeekdays(from, shiftDay(nextOpen, -1)) : [];
  snap.meta.usSessionsBeforeOpen = snap.meta.usSessionDates.length;
  snap.meta.lastAttempt = { at: now.toISOString(), outcome: 'ok', reason: null };
  snap.watch = evaluateGlobalWatch(snap); // 用补齐了日历字段的 meta 重评估

  if (prev && contentKey(prev) === contentKey(snap)) {
    console.log(`无变化（${snap.meta.okCount}/${snap.meta.quoteCount} 个品种，美股会话 ${snap.meta.usSessionDate}），跳过写入`);
    return;
  }

  atomicWriteJSON(fileURLToPath(OUT), JSON.stringify(snap, null, 2) + '\n');
  console.log(`已写入 data/global.json：${snap.meta.okCount}/${snap.meta.quoteCount} 个品种`);
  console.log(`  美股会话 ${snap.meta.usSessionDate} · A股存档 ${tradeDate} · 下次开市 ${nextOpen}（开市前还有 ${snap.meta.usSessionsBeforeOpen} 个美股交易日）`);
  console.log(`  美股档就绪：${snap.meta.usReadiness.ready ? '是' : '否'}（${snap.meta.usReadiness.reason}）`);
  if (snap.meta.usNoSession.length) {
    console.warn(`  ⚠ 美股本会话无成交（已标"盘前无数据"，不写 0）：${snap.meta.usNoSession.join(', ')}`);
  }
  console.log(`  外围研判 ${snap.watch.verdict.label}（bias ${snap.watch.bias}）`);
  for (const s of snap.watch.signals) console.log(`   [${s.level}] ${s.text}`);
  if (snap.watch.missingNote) console.warn(`  ⚠ ${snap.watch.missingNote}`);
  if (snap.meta.failed.length) console.warn(`  ⚠ 未取到：${snap.meta.failed.join(', ')}（保持 null，不写 0）`);
}

main().catch((e) => {
  console.error('外围抓取异常:', e);
  process.exit(1);
});
