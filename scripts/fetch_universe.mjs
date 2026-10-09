// 构建模拟器可交易标的池：data/paper_universe.json
//
// 为什么需要单独一份：Archive 里只有「当日上榜/当日热点」的票（约 110 只），
// 且只有收盘价没有板段/ST 标记。前端下单必须先做规则校验（整手、涨跌停幅度、
// 是否可交易），校验需要这些静态属性。把它们在下单时现算，等于把交易规则
// 散进 UI —— 所以在这里一次性构建成数据文件。
//
// 口径说明：
//   · 标的来源＝存档里出现过真实收盘价的票（hot / lhb），这是「真实」的边界：
//     模拟器只允许交易本系统真实拿到过行情的票，不提供「全市场任意代码」入口，
//     因为那会让价格来源变得不可核验。
//   · 每票记录最近一次真实的收盘价与日期（asOf），并用「最近 30 个交易日是否出现过」
//     区分活跃/历史标的——历史标的仍可卖出（持仓必须能平），但买入会提示行情陈旧。
//   · ST 幅度按名称当次出现时判定，记在 st 字段；不做历史 ST 变更回溯（存档无该信息）。

import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { boardOf, isStName, limitPctOf, PAPER_VERSION } from '../src/paper.js';
import { decodeArchive, encodeStrField, writeJsonStable } from '../src/lhb_codec.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ARCHIVE = path.join(ROOT, 'data', 'archive.json');
const OUT = path.join(ROOT, 'data', 'paper_universe.json');
// 精简池：只含【代码 + 名称】，供首屏使用。
// 为什么单出一份：完整池 1059KB 是首屏最重的请求（比滚动窗还大 5 倍），
// 但其中首屏**真正需要**的只有「代码 → 名称」——账户持仓、待成交、台账、推荐都要显示股票名，
// 缺了整页只剩光秃秃的代码。板段/ST/涨跌停幅度是纯函数可推导的（boardOf/limitPctOf/isStName），
// 最近收盘价/换手/来源只影响输入框旁一行提示，都能延后到用户真输入代码时再要。
// 实测 1059.1KB → 约 62KB（省 94%），首屏总字节因此从 1300KB 降到 ~320KB。
const OUT_LITE = path.join(ROOT, 'data', 'paper_universe-lite.json');

const ACTIVE_DAYS = 30; // 最近 N 个交易日内出现过 → 活跃

const arc = decodeArchive(JSON.parse(readFileSync(ARCHIVE, 'utf8')));
const days = arc.all_days || [];
if (!days.length) {
  console.error('archive.json 无 all_days，无法构建标的池');
  process.exit(1);
}

const allDates = days.map((d) => d.trade_date);
const recentDates = new Set(allDates.slice(-ACTIVE_DAYS));
const lastDate = allDates[allDates.length - 1];

/** code → 标的记录（后出现的覆盖先出现的，保持「最近一次」语义） */
const uni = new Map();
const seenDates = new Map(); // code → Set(date)
const excluded = new Map();  // code → { name, label, n } 被排除的非股票品种

function touch(code, name, price, changePct, date, src, extra = {}) {
  if (!code || price == null || !Number.isFinite(+price) || +price <= 0) return;
  if (!/^\d{6}$/.test(code)) return;
  const b = boardOf(code);
  // 非股票品种（可转债/基金/B股）单独统计，不混进标的池——混进去会让「可交易」这个
  // 字段变成需要前端二次判断的东西，而交易规则必须在下单前就是确定的
  if (!b.tradable) {
    const e = excluded.get(code) || { code, name, label: b.label, board: b.board, n: 0 };
    e.n += 1;
    excluded.set(code, e);
    return;
  }
  const prev = uni.get(code) || null;
  const dates = seenDates.get(code) || new Set();
  dates.add(date);
  seenDates.set(code, dates);
  const st = isStName(name);
  uni.set(code, {
    code,
    name: name || prev?.name || '',
    board: b.board,
    boardLabel: b.label,
    tradable: b.tradable,
    st,
    limitPct: limitPctOf(code, name),   // 0.10 / 0.20 / 0.30 / 0.05
    last: +price,                        // 最近一次真实收盘价
    asOf: date,
    changePct: changePct != null ? +changePct : (prev?.asOf === date ? prev.changePct : null),
    srcs: [...new Set([...(prev?.srcs || []), src])],
    appearances: dates.size,
    active: false,                       // 下面统一算
    ...extra,
  });
}

for (const d of days) {
  for (const h of d.hot || []) touch(h.code, h.name, h.close, h.change_pct, d.trade_date, 'hot', { huanshou: h.huanshou ?? null, reason: h.reason || '' });
  for (const l of d.lhb || []) touch(l.code, l.name, l.close, l.change_pct, d.trade_date, 'lhb', { reason: l.reason || '' });
}

const list = [...uni.values()].map((x) => {
  const dates = seenDates.get(x.code) || new Set();
  const active = [...dates].some((dt) => recentDates.has(dt));
  const isLastDay = x.asOf === lastDate;
  return {
    ...x,
    active,
    // 只在最近一个交易日有真实报价 → 可以用来下单；否则价格陈旧，只允许卖出
    quoteFresh: isLastDay,
    lastSeen: [...dates].sort().pop(),
  };
}).sort((a, b) => (a.lastSeen === b.lastSeen ? a.code.localeCompare(b.code) : (a.lastSeen < b.lastSeen ? 1 : -1)));

// 校验：入池的每条都必须能判定板段与幅度；一个都不许漏
const bad = list.filter((x) => !x.tradable || x.limitPct == null || !x.board);
if (bad.length) {
  console.error(`标的池有 ${bad.length} 条无法判定板段/幅度：`, bad.slice(0, 5).map((x) => `${x.code}(${x.name})`).join(' '));
  process.exit(1);
}

const exList = [...excluded.values()].sort((a, b) => b.n - a.n);
const exByLabel = {};
for (const e of exList) exByLabel[e.label] = (exByLabel[e.label] || 0) + 1;

// reason 字段压缩：3558 条里唯一值只有 663 个（实测 242KB → 约 12KB）。
// 该字段**前端从不读取**（只导出时顺带写入），但保留它对人工核验标的来源有用，故压而不删。
// 用码表：`{reason:'X'}` → `{reasonIdx:25}`，表存 meta.reasonCodes。
const rc = encodeStrField(list, 'reason');
const exRc = encodeStrField(exList, 'reason');

const out = {
  meta: {
    generatedAt: new Date().toISOString(),
    version: PAPER_VERSION,
    lastTradeDate: lastDate,
    source: 'data/archive.json（真实行情存档）',
    activeWindow: ACTIVE_DAYS,
    total: list.length,
    active: list.filter((x) => x.active).length,
    fresh: list.filter((x) => x.quoteFresh).length,
    excludedCount: exList.length,
    excluded: exByLabel,
    note: '标的池仅含本系统真实抓到过往收盘价的证券；价格来源可逐条核验。模拟器不提供全市场任意代码下单。'
      + `可转债/基金/B股等非股票品种 ${exList.length} 只已排除（交易制度不同），不在池内。`
      + `标的 reason 字段已按码表压缩（reasonIdx → meta.reasonCodes），前端不读该字段。`,
    reasonCodes: rc.table,
    reasonEncoding: 'idx-v1',
  },
  boards: {
    shb: '沪市主板 ±10%', szb: '深市主板 ±10%', gem: '创业板 ±20%',
    star: '科创板 ±20%', bj: '北交所 ±30%', st: 'ST/*ST ±5%',
  },
  symbols: Object.fromEntries(rc.rows.map((x) => [x.code, x])),
  excluded: Object.fromEntries(exRc.rows.map((e) => [e.code, e])),
};

// 紧凑写盘：缩进 1 会白吃压缩收益（实测 1.6MB 里约 20% 是空白）
// writeJsonStable：剥掉 generatedAt 后内容未变则跳过——非交易日每天重跑不再产生纯时间戳 diff
const text = JSON.stringify(out);
const wFull = writeJsonStable(OUT, out, { readFileSync, writeFileSync, renameSync, unlinkSync, compact: true, log: '[universe]' });

// ───────────── 精简池（首屏用） ─────────────
// 只留 code + name，其余一律不写。**刻意不写板段/幅度**：它们由 boardOf/limitPctOf 纯函数推导，
// 前端本来就不读池里的副本（实测前端 0 处引用 board/limitPct），写进去纯属体积浪费。
// active/quoteFresh 是「随时间漂移」的字段，只在完整池里表达——精简池没有它就没有说谎的机会。
const lite = {
  meta: {
    generatedAt: out.meta.generatedAt,
    version: out.meta.version,
    lastTradeDate: lastDate,
    kind: 'paper_universe-lite',
    total: list.length,
    note: '首屏精简池：仅 code + name。板段/ST/涨跌停幅度由 src/paper.js 的 boardOf/limitPctOf/isStName '
      + '按代码规则推导，无需数据副本；最近收盘价/换手/来源见 data/paper_universe.json（按需载入）。',
  },
  symbols: list.map((x) => ({ code: x.code, name: x.name })),
};
const liteText = JSON.stringify(lite);
const wLite = writeJsonStable(OUT_LITE, lite, { readFileSync, writeFileSync, renameSync, unlinkSync, compact: true, log: '[universe-lite]' });

console.log(`标的池${wFull.skipped ? '内容未变，跳过写盘' : '已写出'}：${path.relative(ROOT, OUT)}（${(Buffer.byteLength(text) / 1024).toFixed(1)}KB）`);
console.log(`  精简池${wLite.skipped ? '内容未变，跳过写盘' : '已写出'}：${path.relative(ROOT, OUT_LITE)}（${(Buffer.byteLength(liteText) / 1024).toFixed(1)}KB · 仅 code+name · 省 ${(100 - Buffer.byteLength(liteText) / Buffer.byteLength(text) * 100).toFixed(1)}%）`);
console.log(`  最近交易日 ${lastDate} · 合计 ${out.meta.total} 只 · 活跃 ${out.meta.active} 只 · 当日有价 ${out.meta.fresh} 只`);
const byBoard = {};
for (const x of list) {
  const k = x.st ? 'ST' : x.board;
  byBoard[k] = (byBoard[k] || 0) + 1;
}
console.log('  板段分布：', Object.entries(byBoard).map(([k, v]) => `${k}=${v}`).join(' '));
console.log('  已排除（非股票）：', Object.entries(exByLabel).map(([k, v]) => `${k}=${v}`).join(' '));
console.log('  样例：', list.slice(0, 3).map((x) => `${x.code} ${x.name} ${x.last} 元 ${x.boardLabel}${x.st ? '(ST)' : ''} ±${(x.limitPct * 100).toFixed(0)}%`).join(' | '));
