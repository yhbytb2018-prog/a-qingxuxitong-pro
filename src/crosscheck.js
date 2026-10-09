// 跨源一致性互证（东财/腾讯 vs 同花顺）—— 纯函数，零依赖
//
// ════════════════════════════════════════════════════════════════════════════
// 守的事故（用户 #2 系统升级）：**单源静默抽风**
//
//   本项目行业涨跌幅长期只有**一个源**（同花顺 881xxx 日K，见 src/sources.js fetchBoards）。
//   单源的问题不是"偶尔错"，而是**错了没人知道**：
//     · 源侧改版/限流/半截响应 → 某几个行业返回明显失真的值 → 直接进 s_* 因子与"主线题材"
//     · 页面照样渲染、报告照样生成，**没有任何一处会说不一致**
//   2026-08-18 那次"种植业与林业 9.36% 而指数只动 0.5%"就是靠人工查证才发现是**真实轮动**，
//   反过来也说明：**没有第二源，根本分不清"真轮动"与"源抽风"**。这条需求就是把"分不清"变成"可判定"。
//
// ── 设计原则 ────────────────────────────────────────────────────────────────
//   ① **两源独立取值**，各自保留原始值；只在**归一化后的共同行业**上比（口径可比才比）
//   ② 差异分级（agreement / diverge / conflict），**不自动改数**——只标记 + 报警
//   ③ **覆盖率显式化**：两源分类体系不同（同花顺 90 个 vs 申万二级 100 个），
//      能比只是子集。`coverage` 如实披露"比了几个"，**不得让未比的部分看起来像"已核对一致"**
//   ④ 未取到第二源时 status='unknown'，**绝不写成 ok**（没检查 ≠ 没问题，本项目铁律）
//   ⑤ 阈值唯一出处（DIVERGENCE_RULES），与 src/dirty.js 的分工：
//      dirty.js 管**单源内部**异常（范围/单位/重复/逻辑）；本模块管**跨源交叉**验证。
// ════════════════════════════════════════════════════════════════════════════

/**
 * 分歧判据（阈值唯一出处，冻结）。
 *
 * 定标依据（2026-09-30 实测，同花顺 90 行业 vs 申万二级 100 板块，名称精确匹配 40 个）：
 *   |Δ| 中位数 0.37pp、最大 1.55pp。
 *   → 这 40 个"同名"行业其实是**两套不同指数**（成分与加权都不同），
 *     0.4~1.5pp 的差是**方法论差异的正常表现**，不是抽风。
 *   故"分歧"阈值必须显著高于该正常带，否则天天报警＝噪声，等于没有告警（本项目 #3 刚踩过同类坑）。
 */
export const DIVERGENCE_RULES = Object.freeze({
  // 绝对差阈值（百分点）。两源对同一行业的涨跌幅之差超过它才进入"需关注"。
  ABS_DIVERGE: 2.5,
  // **相对差只在"有量级"的行业上才用**（关键：近乎持平的两个值做比值毫无意义）。
  // 实测教训：0.29% vs 1.84% 的比值是 6.3 倍，看着"严重背离"，其实两边都是"基本不动"，
  //   拿它报警会一天报 32 条 → 告警被噪声淹没（等于没有告警）。
  // 故先要求**两源至少一边有量级**（≥MAGNITUDE_FLOOR），才进入相对判据。
  MAGNITUDE_FLOOR: 1.0,
  // 相对差异阈值：在满足量级前提下，min(|a|,|b|) 作分母；超过即视为可疑。
  REL_DIVERGE: 0.8,
  // 方向相反（一正一负）且两边幅度都超过此值 → 升级为 conflict（比"差多少"更硬：连符号都不一致）
  OPPOSITE_MIN_ABS: 1.0,
  // 覆盖率下限：能比对的共同行业少于此数，则不下"整体一致"结论（样本不足）。
  MIN_COMPARABLE: 8,
  // 冲突条数达到此数 → 判定该日"跨源不一致"，写 staleReason 并推送。
  CONFLICT_ALARM_COUNT: 3,
});

/** 分级（与 SEVERITY 同构：越靠后越严重）。 */
export const XCHECK_LEVEL = Object.freeze({
  UNKNOWN: 'unknown',     // 没拿到第二源 → 没检查
  SKIP: 'skip',           // 拿到但可比样本不足 → 不下结论
  OK: 'ok',               // 可比样本足够且无冲突
  DIVERGE: 'diverge',     // 有超阈值差异
  CONFLICT: 'conflict',   // 有方向相反或冲突条数越线
});

/**
 * 数值收紧（与 src/dirty.js 的 num 同款：拒 +[]===0 / +''===0 / +null===0 陷阱）。
 * 两源字段都是"数字字符串或数字"，故只接受 number / 数字字符串。
 */
export function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;      // 数组/对象/null/undefined/布尔 一律 null
  const s = v.trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// ── 别名表：把**申万二级**板块名映射到**同花顺行业**名 ────────────────────────
//
// ⚠ 为什么必须有这张表：两源分类体系不同，精确同名只有 40/90。
//   若不归一化，其余 50 个行业永远"不可比"→ 覆盖率掉到 44%，互证形同虚设。
//
// ⚠ 表的纪律：
//   · **只做名称归一，不做数值换算**。不在这里"加权平均"或"挑一个"——那是第二套口径。
//   · 一对一优先；确实一对多（如同花顺"钢铁"对应申万"普钢+特钢Ⅱ+冶钢原料"）时，
//     右侧写成数组，比对时取**同日同名多板块的幅度中位数**——仍是"两个独立观测点"，
//     只是把申万侧的多个二级行业合并成一个可比对象，**不引入任何权重假设**。
//   · 表里每个映射都可由两源当日真实名称复核（守卫 B21 会逐条验）。
export const SW2THS_ALIAS = Object.freeze({
  // 完全同名（保留在表里以便守卫统一校验，且防止上游改名后静默失配）
  生物制品: '生物制品', 医疗服务: '医疗服务', 化学制药: '化学制药', 农产品加工: '农产品加工',
  小家电: '小家电', 贵金属: '贵金属', 燃气Ⅱ: '燃气', 中药Ⅱ: '中药', 医疗器械: '医疗器械',
  工程机械: '工程机械', 农化制品: '农化制品', 风电设备: '风电设备', 医药商业: '医药商业',
  电池: '电池', 造纸: '造纸', 化学原料: '化学原料', 厨卫电器: '厨卫电器', 化学制品: '化学制品',
  化学纤维: '化学纤维', 电力: '电力', 综合Ⅱ: '综合', 电机Ⅱ: '电机', 电网设备: '电网设备',
  炼化及贸易: '石油加工贸易', 贸易Ⅱ: '贸易', 工业金属: '工业金属', 多元金融: '多元金融',
  证券Ⅱ: '证券', 物流: '物流', 环境治理: '环境治理', 家居用品: '家居用品', 能源金属: '能源金属',
  汽车零部件: '汽车零部件', 光伏设备: '光伏设备', 养殖业: '养殖业', 轨交设备Ⅱ: '轨交设备',
  旅游及景区: '旅游及酒店', 汽车服务: '汽车服务及其他', 包装印刷: '包装印刷', 影视院线: '影视院线',
  游戏Ⅱ: '游戏', 光学光电子: '光学光电子', 黑色家电: '黑色家电', 服装家纺: '服装家纺',
  教育: '教育', 通信设备: '通信设备', 小金属: '小金属', 纺织制造: '纺织制造',
  计算机设备: '计算机设备', 自动化设备: '自动化设备', 白色家电: '白色家电',

  // 名称不同但同一主体（或明确的一级归口）
  种植业: '种植业与林业', 渔业: '养殖业', 饲料: '农产品加工',
  航空机场: '机场航运', 航运港口: '港口航运', 铁路公路: '公路铁路运输',
  商用车: '汽车整车', 乘用车: '汽车整车', 摩托车及其他: '汽车服务及其他',
  白酒Ⅱ: '白酒', 非白酒: '饮料制造', 饮料乳品: '饮料制造',
  休闲食品: '食品加工制造', 食品加工: '食品加工制造', 调味发酵品Ⅱ: '食品加工制造',
  国有大型银行Ⅱ: '银行', 股份制银行Ⅱ: '银行', 城商行Ⅱ: '银行', 农商行Ⅱ: '银行',
  保险Ⅱ: '保险', 房地产开发: '房地产', 房屋建设Ⅱ: '建筑装饰', 基础建设: '建筑装饰',
  专业工程: '建筑装饰', 装修装饰Ⅱ: '建筑装饰', 水泥: '建筑材料', 装修建材: '建筑材料',
  普钢: '钢铁', 特钢Ⅱ: '钢铁', 冶钢原料: '钢铁',
  煤炭开采: '煤炭开采加工', 焦炭Ⅱ: '煤炭开采加工', 油服工程: '油气开采及服务',
  酒店餐饮: '旅游及酒店', 化妆品: '美容护理', 个护用品: '美容护理', 饰品: '美容护理',
  动物保健Ⅱ: '化学制药', 一般零售: '零售', 专业连锁Ⅱ: '零售', 数字媒体: '文化传媒',
  出版: '文化传媒', 文娱用品: '文化传媒', 专业服务: '其他社会服务', 家电零部件Ⅱ: '白色家电',
  航空装备Ⅱ: '军工装备', 航海装备Ⅱ: '军工装备', 航天装备Ⅱ: '军工装备', 地面兵装Ⅱ: '军工装备',
});

/**
 * 把一个源侧的名称归一化成**可比键**（同花顺行业名）。
 * 未收录的名称返回 null —— 显式表示"该板块不参与互证"，**不猜、不兜底成同名**。
 */
export function normalizeName(name) {
  const s = String(name ?? '').trim();
  if (!s) return null;
  return SW2THS_ALIAS[s] ?? null;   // 不在表里 → 不可比（诚实，而不是默认同名）
}

/**
 * **主源侧**的归一化：主源（同花顺行业）的名字**本身就是可比键**。
 *
 * ⚠ 为什么必须与 normalizeName 分开（本轮实测踩到的坑）：
 *   别名表 `SW2THS_ALIAS` 的方向是「**申万二级 → 同花顺行业**」，是给**第二源**用的。
 *   若主源也用它归一化，那么同花顺独有的名字（白酒/银行/钢铁/煤炭开采加工/半导体…）
 *   因为不在表的**左键**上，会被判成"不可比"→ 可比数从 9 掉到 4 → 直接掉进 skip。
 *   即：**拿第二源的字典去查主源**，等于人为把覆盖率砍掉一半。
 *   故主源只做"清洗 + 非空"，不查表（它就是 canonical 定义本身）。
 */
export function normalizePrimaryName(name) {
  const s = String(name ?? '').trim();
  return s || null;
}

/**
 * 跨源比对。
 *
 * ── 为什么必须**先扣掉当日系统性偏移**再判差异（本轮实测定标的核心）─────────────
 * 2026-09-30 实测：72 个可比行业里 **52 个** primary < secondary，均值偏移 −0.296pp。
 *   这不是"源抽风"，而是**两套指数的构造差异**（成分股范围 / 加权方式不同 → 恒定偏一点）。
 *   若不做去偏，判定就变成"只要两套指数本来就不同，就天天报警"——告警恒亮＝没有告警。
 *
 * 故本函数的口径是：
 *   ① 先算**当日偏移** offset = median(primary − secondary)（稳健：中位数不受个别离群影响）
 *   ② 判差异用 `dev = (primary − secondary) − offset` —— **偏离常态关系的程度**
 *   ③ offset 本身如实披露在结果里（它是有信息量的：方法论差异有多大）
 *   ④ 只有 `dev` 超阈值/异号才报。这样抓到的是"**今天这个行业脱离了它与第二源的常态关系**"，
 *      也就是"可能源侧失真"，而不是"两个指数本来就不一样"。
 *
 * ⚠ 这是"用数据自身定标"，不是"把差异抹掉"：offset 原样输出、每行 dev 原样输出，
 *   人工复核时既能看到原始两值，也能看到扣除常态后的偏离。
 *
 * @param {Array<{name:string, change_pct:any}>} primary   主源（同花顺）行业涨幅
 * @param {Array<{name:string, change_pct:any}>} secondary 第二源（申万二级）板块涨幅
 * @param {object} [opts]
 * @param {object} [opts.rules]  覆盖 DIVERGENCE_RULES（单测用；生产不传）
 * @param {string} [opts.date]   交易日（仅用于结果回显）
 * @param {string} [opts.primaryName/secondaryName] 源名（用于回显与告警文案）
 * @param {boolean} [opts.debias=true] 是否扣除当日系统性偏移（单测可关掉以验证原始判据）
 * @returns {object} 一致性结论
 */
export function crossCheck(primary, secondary, opts = {}) {
  const R = { ...DIVERGENCE_RULES, ...(opts.rules || {}) };
  const date = opts.date ?? null;
  const primaryName = opts.primaryName || '同花顺行业(881xxx)';
  const secondaryName = opts.secondaryName || '申万二级(腾讯)';

  const pList = Array.isArray(primary) ? primary : null;
  const sList = Array.isArray(secondary) ? secondary : null;

  // ── 未拿到某一源 → unknown（**绝不写 ok**：没检查≠没问题） ──
  if (!pList || !pList.length || !sList || !sList.length) {
    return {
      date, status: XCHECK_LEVEL.UNKNOWN,
      primaryName, secondaryName,
      primaryCount: pList ? pList.length : 0,
      secondaryCount: sList ? sList.length : 0,
      comparable: 0, coverage: null,
      divergeCount: 0, conflictCount: 0, maxAbsDiff: null, medianAbsDiff: null,
      rows: [],
      note: '未取到可比的两源数据（至少一源为空/缺失）——这是"没检查"，不等于"两源一致"',
    };
  }

  // 主源：名字**即**可比键（不查表，见 normalizePrimaryName 注）
  const prim = new Map();
  for (const it of pList) {
    const key = normalizePrimaryName(it && it.name);
    const v = num(it && it.change_pct);
    if (key && v != null) prim.set(key, { raw: it.name, value: v });
  }

  // 第二源：先查别名表归一到主源口径（未收录 → 不可比）；同一可比键可能对应多个
  //   申万二级板块 → 收集后取中位数（不引入权重假设）
  const secBuckets = new Map();
  for (const it of sList) {
    const key = normalizeName(it && it.name);
    const v = num(it && it.change_pct);
    if (!key || v == null) continue;
    if (!secBuckets.has(key)) secBuckets.set(key, []);
    secBuckets.get(key).push(v);
  }

  const median = (a) => {
    const s = a.slice().sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  // ── 第 1 趟：配对（只做配对，不判定） ──
  const pairs = [];
  for (const [key, p] of prim) {
    const bucket = secBuckets.get(key);
    if (!bucket || !bucket.length) continue;                 // 第二源没有对应板块 → 不可比
    pairs.push({ key, primaryRaw: p.raw, pv: p.value, sv: median(bucket), samples: bucket.length });
  }

  // ── 当日系统性偏移（方法论差异）：中位数，稳健，不受个别离群影响 ──
  const debias = opts.debias !== false;
  const offsetRaw = pairs.length ? median(pairs.map((x) => x.pv - x.sv)) : 0;
  const offset = debias ? round2(offsetRaw) : 0;

  // ── 第 2 趟：用**扣掉常态偏移后**的偏离度判定 ──
  const rows = [];
  for (const x of pairs) {
    const rawDiff = x.pv - x.sv;
    const dev = round2(rawDiff - offset);          // 偏离常态关系的程度（判定依据）
    const absDev = Math.abs(dev);
    // 相对判据的**量级前置条件**：**两边都**要有量级，比值才有意义。
    //   实测教训（2026-09-30）：小家电 0.29% vs 1.84%，比值 5.3 倍看着"严重背离"，
    //   本质是**分母太小**被放大——0.29% 与 1.84% 都是"基本不动"，不该报警。
    //   若只要求"较大一边有量级"，则所有近持平行业都会因小分母而被误报（本轮实测 4 条全是此类）。
    //   故要求 min(|a|,|b|) ≥ MAGNITUDE_FLOOR：只有两源都真的动了，比值差异才有信息量。
    const minAbs = Math.min(Math.abs(x.pv), Math.abs(x.sv));
    const relMeasurable = minAbs >= R.MAGNITUDE_FLOOR;
    const rel = minAbs > 0 ? absDev / minAbs : (absDev > 0 ? Infinity : 0);
    const relBreach = relMeasurable && rel > R.REL_DIVERGE;

    // 方向相反判据也用 dev：常态偏移已扣，故"dev 与两源同号且对立"才是真冲突
    const opposite = (x.pv > 0 && x.sv < 0) || (x.pv < 0 && x.sv > 0);
    const oppositeStrong = opposite
      && Math.abs(x.pv) >= R.OPPOSITE_MIN_ABS && Math.abs(x.sv) >= R.OPPOSITE_MIN_ABS;

    let level = XCHECK_LEVEL.OK;
    if (oppositeStrong) level = XCHECK_LEVEL.CONFLICT;
    else if (absDev > R.ABS_DIVERGE || relBreach) level = XCHECK_LEVEL.DIVERGE;

    rows.push({
      industry: x.key, primaryRaw: x.primaryRaw,
      primary: round2(x.pv), secondary: round2(x.sv),
      secondarySamples: x.samples,
      diff: round2(rawDiff),          // 原始差（保留，便于人工复核）
      dev,                            // 扣掉常态偏移后的偏离（判定依据）
      absDiff: round2(absDev),        // ← 兼容旧字段名：语义为 |dev|
      rel: Number.isFinite(rel) ? round2(rel) : null,
      relMeasurable,
      level,
    });
  }

  const comparable = rows.length;
  const conflicted = rows.filter((r) => r.level === XCHECK_LEVEL.CONFLICT);
  const diverged = rows.filter((r) => r.level === XCHECK_LEVEL.DIVERGE);
  const diffs = rows.map((r) => r.absDiff).sort((a, b) => a - b);

  // 覆盖率：能比 / 主源行业数（**如实披露**，避免"只比了 40% 却像全查过"）
  const coverage = pList.length ? round4(comparable / pList.length) : null;

  let status;
  if (comparable < R.MIN_COMPARABLE) status = XCHECK_LEVEL.SKIP;             // 样本不足，不下结论
  else if (conflicted.length >= R.CONFLICT_ALARM_COUNT) status = XCHECK_LEVEL.CONFLICT;
  else if (conflicted.length || diverged.length) status = XCHECK_LEVEL.DIVERGE;
  else status = XCHECK_LEVEL.OK;

  // 最严重的若干行，供告警/面板展示（按严重度再按差幅）
  const rank = { conflict: 0, diverge: 1, ok: 2 };
  const flagged = rows
    .filter((r) => r.level !== XCHECK_LEVEL.OK)
    .sort((a, b) => (rank[a.level] - rank[b.level]) || (b.absDiff - a.absDiff))
    .slice(0, 10);

  const staleReason = buildStaleReason({ status, conflicted, diverged, comparable, coverage, R, date });

  return {
    date, status,
    primaryName, secondaryName,
    primaryCount: pList.length,
    secondaryCount: sList.length,
    comparable,
    coverage,
    offset,                 // 当日两源系统性偏移（方法论差异），中位数；判定前已扣除
    offsetRaw: round2(offsetRaw),
    debiased: debias,
    divergeCount: diverged.length,
    conflictCount: conflicted.length,
    maxAbsDiff: diffs.length ? diffs[diffs.length - 1] : null,
    medianAbsDiff: diffs.length ? (diffs.length % 2 ? diffs[(diffs.length - 1) / 2]
      : round2((diffs[diffs.length / 2 - 1] + diffs[diffs.length / 2]) / 2)) : null,
    flagged,
    rows,
    staleReason,
    note: noteOf(status, comparable, coverage, R, offset),
  };
}

function round2(v) { return Math.round(v * 100) / 100; }
function round4(v) { return Math.round(v * 10000) / 10000; }

function noteOf(status, comparable, coverage, R, offset) {
  const cov = coverage == null ? '未知' : (coverage * 100).toFixed(1) + '%';
  const off = (offset == null) ? '' : `；当日两源常态偏移 ${offset > 0 ? '+' : ''}${offset}pp（已扣除）`;
  switch (status) {
    case XCHECK_LEVEL.UNKNOWN:
      return '未取到可比的两源数据 —— 这是"没检查"，不等于"两源一致"';
    case XCHECK_LEVEL.SKIP:
      return `可比行业仅 ${comparable} 个（低于下限 ${R.MIN_COMPARABLE}），样本不足，不下"一致"结论`;
    case XCHECK_LEVEL.OK:
      return `可比的 ${comparable} 个行业两源一致（覆盖率 ${cov}${off}；未覆盖部分**未核对**，不等于没问题）`;
    case XCHECK_LEVEL.DIVERGE:
      return `可比的 ${comparable} 个行业中发现偏离常态关系的离群（覆盖率 ${cov}${off}）——需人工复核是否源侧失真`;
    case XCHECK_LEVEL.CONFLICT:
      return `可比的 ${comparable} 个行业中出现方向相反/多条冲突（覆盖率 ${cov}${off}）——高度疑似源侧失真`;
    default:
      return '';
  }
}

function buildStaleReason({ status, conflicted, diverged, comparable, coverage, R, date }) {
  if (status === XCHECK_LEVEL.UNKNOWN) return 'cross-source: 未取到第二源，未做互证';
  if (status === XCHECK_LEVEL.SKIP) return `cross-source: 可比样本 ${comparable} < ${R.MIN_COMPARABLE}，未下结论`;
  if (status === XCHECK_LEVEL.CONFLICT) {
    const names = conflicted.slice(0, 3).map((r) => `${r.industry}(${r.primary}% vs ${r.secondary}%)`).join('、');
    return `cross-source: ${conflicted.length} 条方向相反（${names}），疑似源侧失真${date ? ' @' + date : ''}`;
  }
  if (status === XCHECK_LEVEL.DIVERGE) {
    const names = diverged.slice(0, 3).map((r) => `${r.industry}(${r.primary}% vs ${r.secondary}%)`).join('、');
    return `cross-source: ${diverged.length} 条超阈值差异（${names}）`;
  }
  return null;   // OK 不写 staleReason
}

/**
 * 全档汇总：把逐日 crossCheck 结果压成一张"源的稳定度"画像。
 * 用于数据质量面板与 CI 守卫（例如"全档不得有 conflict"）。
 */
export function summarizeCrossCheck(perDay) {
  const list = Array.isArray(perDay) ? perDay.filter(Boolean) : [];
  const byStatus = {};
  for (const d of list) byStatus[d.status] = (byStatus[d.status] || 0) + 1;
  const comparable = list.reduce((a, d) => a + (d.comparable || 0), 0);
  const conflicts = list.reduce((a, d) => a + (d.conflictCount || 0), 0);
  const diverges = list.reduce((a, d) => a + (d.divergeCount || 0), 0);
  const covs = list.map((d) => d.coverage).filter((v) => typeof v === 'number');
  return {
    days: list.length,
    byStatus,
    comparableTotal: comparable,
    conflictTotal: conflicts,
    divergeTotal: diverges,
    avgCoverage: covs.length ? round4(covs.reduce((a, b) => a + b, 0) / covs.length) : null,
    // 有冲突的那几天（供人工复核入口，与 #41 人工纠错通道衔接）
    conflictDates: list.filter((d) => d.status === XCHECK_LEVEL.CONFLICT).map((d) => d.date),
    unknownDates: list.filter((d) => d.status === XCHECK_LEVEL.UNKNOWN).map((d) => d.date),
  };
}
