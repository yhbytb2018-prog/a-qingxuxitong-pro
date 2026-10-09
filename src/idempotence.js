// 幂等 + 防重复抓（#1）
//
// ── 解决什么问题 ────────────────────────────────────────────────────────────
//
// 抓取层的幂等只做到了"同一份原始数据重算两次得同一结果"（各回填脚本的 signature 判据），
// 但**管线自身**没有这一层。于是三类重复劳动每轮都在发生：
//
//   ① 待重算的资产集合是**全档**（241 天），而不是"真正会变的那几天"。
//      真正会变的只有两天：当日（新抓）+ 上一交易日（龙虎榜/席位晚间分批披露，须补抓）。
//      其余 239 天重算 100% 是恒等变换——但代价是实打实的（每次运行多花数十秒 + 无谓写盘）。
//
//   ② 抓取没有"凭据"概念。同一交易日跑两次 live，两次都发全套网络请求；
//      失败一次再跑还是发全套——这正是用户点名的"重复抓"。
//      应该问的是"我手上这份数据凭什么可信、够不够新"，而不是"我跑第几次了"。
//
//   ③ 派生指标会随**档案长度**漂移（旧的分位实现就是：新抓一天会改所有历史日的分位），
//      于是"抓取层没变"不等于"落盘内容没变"，幂等在最外层被打破。
//      —— 这一点由 src/sources.js 的 `windowedPctRank` 修掉（分位只看到 T 日为止）。
//      本模块负责**验证**它真的做到了：`archiveDigest` 是逐日深指纹，一旦某历史日
//      在追加新天后发生漂移，指纹立刻变化，而不是靠人去比 4MB 的 JSON。
//
// ── 设计纪律 ────────────────────────────────────────────────────────────────
//
//   · **纯函数、零依赖**：不读盘、不发请求、不 import 业务模块。所有 IO 由调用方
//     （scripts/need_rebuild.mjs）注入。这样它可以被单测逐条锁死，也能被前端复用。
//   · **指纹的"无变化"必须有样本**：样本天数不足 MIN_BASELINE_DAYS 时一律判 `insufficient`，
//     绝不因为"没抽到不同的天"就宣布"幂等"——没检查 ≠ 没问题。
//   · **恒等判据是"取值相同"而非"串相同"**：JSON 键序、数字 1 与 1.0、
//     对象字段增删都会被串比较误判。故 `deepEqual` 走结构化比较，逐个数值/字符串/
//     布尔/数组元素/对象键比，且**键集合必须一致**（多一个键 = 数据变了，不是"等价"）。
//   · **不造假**：判不出来就返回 `unknown` 并给出原因，绝不给一个乐观的默认值。
//     前端/CI 拿到 unknown 时应当按"需要重算"处理（保守方向），而不是按"不用重算"。

// BJ 时区换算取自 src/time.js——零依赖纯函数叶子模块，不破坏本模块"零业务依赖"纪律。
import { bjDate, bjTime } from './time.js';

// ── 阈值（唯一出处）─────────────────────────────────────────────────────────

export const IDEMPOTENCE_LIMITS = {
  /** 判"历史天是否漂移"至少要能抽到多少天样本。低于此值 → insufficient，
   *  不宣布幂等（宁可多算一次，不可漏掉漂移）。取 10：少于 10 天的档案
   *  本身还在冷启动期，任何结论都没有统计意义。 */
  MIN_BASELINE_DAYS: 10,
  /** 指纹里逐日深比较的字段白名单。只比这些字段，**不**比 generatedAt 之类的
   *  时间戳（它们每次运行必然不同，比了会让指纹恒变、判据永远失效）。 */
  DIGEST_FIELDS: ['trade_date', 'emotion', 'summary', 'indexes', 'themes'],
};

/** 抓取层的"凭据"策略：什么情况下允许跳过重复抓取。
 *  语义刻意做成**保守**——默认全部重抓，只有明确满足条件才省。
 *  理由：多抓一次只是花时间，少抓一次会产生"数据看着正常但其实是旧的"这种
 *  最危险的失败（本项目铁律：没检查 ≠ 没问题 / 缺失显式化）。 */
export const FETCH_POLICY = {
  /** 同一交易日已成功抓取且**已定稿**（收盘后披露完毕）→ 不再抓。
   *  龙虎榜 18:30 首抓 / 21:00 补抓，故"定稿时刻"取 21:00（北京时间）。 */
  FINALIZED_HOUR: 21,
  /** 已定稿的交易日，其席位明细若覆盖率已达此值 → 不再补抓（取优逻辑由 runLive 负责）。
   *  取 100：席位是"锁仓口径"的原料，少一票就少一份证据，不值得为省一次请求降级。 */
  SEAT_COVER_ENOUGH: 100,
};

// ── 深比较（结构化，不走 JSON 串）─────────────────────────────────────────

/** 数值感知的"同值"判定：1 与 1.0 同值；'1' 与 1 **不同值**（类型不同即不同）。
 *  NaN 视为同值（NaN 与 NaN 在数据语境下都是"算不出来"，不因它反复判"变了"）。 */
function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    return a === b;
  }
  return false;
}

/**
 * 结构化深比较。返回 true 表示"取值等价"。
 *
 * 与 `JSON.stringify(a) === JSON.stringify(b)` 的关键差别：
 *   · 键序无关（{a:1,b:2} 与 {b:2,a:1} 等价）；
 *   · 数字 1 与 1.0 等价（JSON 串里也是 "1"，但反过来 1 与 "1" 在 JSON 串里
 *     是 `1` 与 `"1"`，不同——这里同样判不同，因为类型不同确实是不同的数据）；
 *   · 数组必须长度相同且逐位等价（不能把 [1,2] 与 [1,2,undefined] 判等）；
 *   · 对象**键集合必须一致**：少一个键不是"缺省"，是数据变了。
 */
export function deepEqual(a, b) {
  if (sameValue(a, b)) return true;
  if (a == null || b == null) return false; // 一处是 null/undefined，另一处不是 → 不等
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length) return false;
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i]) return false;      // 键集合不同 → 数据变了
      if (!deepEqual(a[ka[i]], b[kb[i]])) return false;
    }
    return true;
  }
  return false;
}

// ── 逐日指纹 ────────────────────────────────────────────────────────────────

/** 单日指纹：只取 DIGEST_FIELDS 里的字段，结构化深比较用。
 *  刻意**不**包含任何时间戳字段（meta.generatedAt / freshness 等）——
 *  它们每次运行必然不同，是"运行时刻"而非"数据内容"。把它们混进指纹，
 *  指纹就恒变，整个判据退化成摆设（这是本项目最容易犯的"守卫看似存在实则失效"）。 */
export function dayFingerprint(day) {
  const fp = {};
  if (!day || typeof day !== 'object') return fp;
  for (const f of IDEMPOTENCE_LIMITS.DIGEST_FIELDS) {
    if (f in day) fp[f] = f === 'trade_date' ? day[f] : stripVolatile(day[f]);
  }
  return fp;
}

/** 剔除指纹字段内部的易变子字段（递归）。
 *  当前剔除：`emotion._legacy`（重算时按"有无原始数据"打标，属推导过程留痕，
 *  不影响任何数值）；`summary.industry_relative` 保留（它是**派生指标**——
 *  恰恰是"追加新天后会不会漂移"最需要守住的那一类，剔了就等于不查）。
 *  ⚠ 新增剔除项必须在此写清楚"为什么它不是数据内容"——否则很容易变成
 *  把真正的漂移一起屏蔽掉（那比不做指纹更糟：给人"已验证幂等"的错觉）。 */
const VOLATILE_KEYS = new Set(['_legacy']);
function stripVolatile(v) {
  if (Array.isArray(v)) return v.map(stripVolatile);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) {
      if (VOLATILE_KEYS.has(k)) continue;
      o[k] = stripVolatile(val);
    }
    return o;
  }
  return v;
}

// ── 幂等判定：追加新天后，历史天有没有漂移 ────────────────────────────────

/**
 * 判定"重算后历史部分是否逐日未变"。这是幂等性的**实证**判据，
 * 而不是"我调用了那个号称幂等的函数"。
 *
 * @param {object[]} before 重算前的 all_days
 * @param {object[]} after  重算后的 all_days
 * @param {object}  [opts]
 * @param {number}  [opts.minBaseline] 最少需要的可比天数
 * @returns {{status:'unchanged'|'changed'|'insufficient'|'unknown', checkedDays:number,
 *            drifted:string[], added:string[], removed:string[], reason:string}}
 */
export function digestCompare(before, after, opts = {}) {
  const minBase = Number.isFinite(+opts.minBaseline) ? +opts.minBaseline : IDEMPOTENCE_LIMITS.MIN_BASELINE_DAYS;
  const A = Array.isArray(before) ? before : null;
  const B = Array.isArray(after) ? after : null;
  if (!A || !B) {
    return { status: 'unknown', checkedDays: 0, drifted: [], added: [], removed: [], reason: '入参不是数组，无法比较' };
  }
  const mapA = new Map(A.filter((d) => d && d.trade_date).map((d) => [d.trade_date, d]));
  const mapB = new Map(B.filter((d) => d && d.trade_date).map((d) => [d.trade_date, d]));

  const added = [...mapB.keys()].filter((k) => !mapA.has(k)).sort();
  const removed = [...mapA.keys()].filter((k) => !mapB.has(k)).sort();

  // 只比较**两侧都有**的天（新增/删除的天单独列出，不混进"漂移"——
  // 追加新天是正常行为，把它算成"漂移"会让判据在每次正常运行时都报红，进而被忽略）。
  const common = [...mapA.keys()].filter((k) => mapB.has(k)).sort();
  if (common.length < minBase) {
    return {
      status: 'insufficient', checkedDays: common.length, drifted: [], added, removed,
      reason: `可比历史天仅 ${common.length} 天（< ${minBase}），不足以判定幂等；按"需重算"处理`,
    };
  }
  const drifted = common.filter((k) => !deepEqual(dayFingerprint(mapA.get(k)), dayFingerprint(mapB.get(k))));
  return {
    status: drifted.length ? 'changed' : 'unchanged',
    checkedDays: common.length,
    drifted,
    added,
    removed,
    reason: drifted.length
      ? `${drifted.length} 个历史日的取值发生变化（前视偏差/口径漂移的症状）：${drifted.slice(0, 5).join('、')}${drifted.length > 5 ? ' …' : ''}`
      : `${common.length} 个历史日逐字段未变${added.length ? `；新增 ${added.length} 天（${added.join('、')}）` : ''}`,
  };
}

// ── 抓取凭据：这一天的数据"够不够新、凭什么可信" ─────────────────────────

/**
 * 判定某个交易日是否需要重抓。
 *
 * 输入是**已落盘的证据**（不是"这是第几次运行"）：
 *   · hasDay       —— 档案里有没有这一天
 *   · lhbStocks    —— 该天龙虎榜上榜个股数（0/null = 没抓到或未公布）
 *   · seatCover    —— 席位明细覆盖率（%）
 *   · now          —— 当前时刻（北京时间 Date）
 *   · finalizedAt  —— 该日的"定稿时刻"（默认当日 21:00 北京时间）
 *
 * 返回 { need: boolean, reason: string, kind: 'fetch'|'refetch'|'skip' }。
 *   kind 用于日志区分"首次抓"与"补抓"，不参与判定逻辑。
 */
export function needFetch(day, opts = {}) {
  const hasDay = !!day;
  const lhb = day && day.summary ? day.summary.lhb_stocks : null;
  const cover = day && day.summary && day.summary.seats ? day.summary.seats.cover : null;
  const nowIn = opts.now;
  const now = nowIn instanceof Date && !Number.isNaN(nowIn.getTime()) ? nowIn : null;
  if (!now) {
    return { need: true, kind: hasDay ? 'refetch' : 'fetch', reason: '当前时刻不可用，无法判断是否已定稿 → 保守重抓' };
  }
  const finHour = Number.isFinite(+opts.finalizedHour) ? +opts.finalizedHour : FETCH_POLICY.FINALIZED_HOUR;
  const dateStr = (day && day.trade_date) || opts.tradeDate || null;
  const finalized = isPastFinalized(dateStr, now, finHour);

  if (!hasDay) {
    return { need: true, kind: 'fetch', reason: `${dateStr || '该日'}不在档案中 → 抓取` };
  }
  if (!finalized) {
    return { need: true, kind: 'refetch', reason: `${dateStr} 尚未过定稿时刻（当日 ${finHour}:00 北京时间）→ 龙虎榜/席位可能仍在分批披露，重抓` };
  }
  // 已定稿：龙虎榜必须有量。没有量说明当日根本没抓到（接口失败/未公布）→ 必须重抓，
  // 不能因为"档案里有这一天"就认为数据齐全（有壳无内容是最危险的假象）。
  const nLhb = Number.isFinite(+lhb) ? +lhb : null;
  if (nLhb == null || nLhb <= 0) {
    return { need: true, kind: 'refetch', reason: `${dateStr} 已定稿但龙虎榜上榜数为 ${lhb == null ? '未知' : nLhb} → 该日数据不完整，重抓` };
  }
  const nCover = Number.isFinite(+cover) ? +cover : null;
  if (nCover == null || nCover < FETCH_POLICY.SEAT_COVER_ENOUGH) {
    return { need: true, kind: 'refetch', reason: `${dateStr} 席位覆盖率 ${nCover == null ? '未知' : nCover + '%'} < ${FETCH_POLICY.SEAT_COVER_ENOUGH}% → 补抓（席位是锁仓口径原料，宁可多抓）` };
  }
  return { need: false, kind: 'skip', reason: `${dateStr} 已定稿：龙虎榜 ${nLhb} 条、席位覆盖 ${nCover}% → 无需重复抓取` };
}

/** 该日期是否已过"定稿时刻"。比较用的是**北京时间的日历日 + 小时**，
 *  不用 UTC 直接比——archive 的 trade_date 是北京日期，混用 UTC 会在
 *  晚间 21:00~24:00（北京时间）这段把"当天"错算成"昨天"，正是补抓窗口。 */
function isPastFinalized(dateStr, now, finHour) {
  if (!dateStr) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) return false;
  // 北京时间 = UTC+8，固定偏移（中国无夏令时）。换算统一走 src/time.js（全仓唯一
  // 出处，不依赖宿主时区）。
  const today = bjDate(now);
  if (dateStr < today) return true;      // 过去的日子必然已定稿
  if (dateStr > today) return false;     // 未来的日子没定稿一说
  return Number(bjTime(now).slice(0, 2)) >= finHour; // 同一天：看是否过了定稿小时
}

// ── 重算范围：把"全档重算"缩到"真正会变的那几天" ───────────────────────────

/**
 * 算出真正需要重算的日子。
 *
 * 依据（都是**已落盘的证据**，不是猜测）：
 *   ① 当日：新抓 → 必然重算。
 *   ② 上一交易日：龙虎榜/席位晚间分批披露，且席位接口只保留最近数日
 *      （src/seats_daily.js 头注），故每轮都要补。判定同样是"凭据"而非"日期差"：
 *      席位覆盖未满 / 缺卖方明细 → 重算。
 *   ③ 其余历史天：**默认不动**。
 *      这一条的正确性依赖"分位只看到 T 日为止"（src/sources.js 的 windowedPctRank）
 *      —— 若分位仍依赖全档，削减重算范围就会让历史分位停在旧值。故本模块与
 *      那个实现是**一对**，拆开任一个，另一个就不成立。改动其一时必须同时复核另一个，
 *      并由 test/idempotence.test.mjs 的"追加新天不改历史分位"断言守住。
 *
 * ⚠ 返回的是**建议**，不是命令。调用方若判定口径整体变更（公式版本切换、
 *   阈值重标定），必须显式传 `force: true` 走全档重算，不能指望本函数猜出来。
 *
 * @returns {{dates:string[], full:boolean, reason:string}}
 */
export function computeRecomputeScope(days, opts = {}) {
  const list = Array.isArray(days) ? days.filter((d) => d && d.trade_date) : [];
  if (opts.force) return { dates: list.map((d) => d.trade_date), full: true, reason: '调用方声明口径变更，全档重算' };
  if (!list.length) return { dates: [], full: false, reason: '空档，无需重算' };
  const sorted = list.slice().sort((a, b) => (a.trade_date < b.trade_date ? -1 : 1));
  const latest = sorted[sorted.length - 1].trade_date;
  const dates = new Set([latest]);
  const reasons = [`当日 ${latest}（新抓/最新）`];

  // 上一交易日：用**档案顺序**取，不用"自然日前一天"——长假后的前一交易日可能是 7 天前。
  //   这与 formula_versions.nextRetOf 的同款纪律一致（那里也是按真实交易日相邻取次日）。
  if (sorted.length >= 2) {
    const prev = sorted[sorted.length - 2];
    const cover = prev.summary && prev.summary.seats ? numOf(prev.summary.seats.cover) : null;
    const detail = prev.summary && prev.summary.seats ? prev.summary.seats.detail : null;
    const noSellSide = detail && Object.values(detail).some((v) => Array.isArray(v));
    if (cover == null || cover < FETCH_POLICY.SEAT_COVER_ENOUGH || !detail || noSellSide) {
      dates.add(prev.trade_date);
      reasons.push(`上一交易日 ${prev.trade_date}（席位覆盖 ${cover == null ? '未知' : cover + '%'}，明细${!detail ? '缺' : noSellSide ? '为旧格式（仅买方）' : '完整'}）`);
    }
  }
  const arr = [...dates].sort();
  return {
    dates: arr,
    full: false,
    reason: `${arr.length} 天需重算：${reasons.join('；')}。其余 ${sorted.length - arr.length} 天依赖"分位只看到 T 日为止"保持恒定，不动。`,
  };
}

const numOf = (v) => (v == null || v === '' || typeof v === 'boolean' ? null : (Number.isFinite(+v) ? +v : null));
