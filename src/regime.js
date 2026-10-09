// 拐点/异动检测引擎（#4）—— 冰点 / 回暖 / 高潮 / 退潮
//
// ── 为什么需要这一层 ────────────────────────────────────────────────────────
// 现状：屏幕上有 7 个因子、情绪分、宽度判定、亏钱效应、席位属性、主力题材——
//   全是**孤立指标**。用户第一眼的问题是「今天这盘是什么状态？该进攻还是该躲？」
//   而回答它需要把指标**合起来读**：情绪分高 + 宽度窄 = 假繁荣；情绪分低 + 亏钱
//   效应极端 = 冰点（往往是机会）；情绪分高 + 亏钱效应也高 = 高潮（往往是风险）。
//   本项目已有的事实：
//     · 2026-09-24 情绪分 60.2（中性）→ 2026-09-28 32.1（pct 1.7）→ 2026-09-29 75.9
//       （pct 93.2）：两天内从"冰点"直接弹到"接近过热"——**这是拐点**，但屏幕上看不出来。
//
// ── 设计原则（与本项目一贯纪律对齐）─────────────────────────────────────────
//   • **阈值唯一出处**：全部温度/边距常量集中在 REGIME_RULES，下游不得写死数字。
//   • **缺失显式化**：unknown ≠ ok。任何判据的输入缺失 → 该判据返回 null，
//     标签退化为「数据不足」而不是猜一个。绝不把"没采集"当"中性"。
//   • **纯函数 + 无 IO**：输入是已算好的素材（情绪序列/宽度/亏钱/席位），
//     本模块**不重算任何指标**——只做"合读 + 分类"。这是职责边界。
//   • **标签是描述，不是建议**：输出只回答"现在是什么状态"，不给买卖动作。
//     动作由 src/picks.js / src/alerts.js 依据档位单独给（避免两处各说一套）。
//
// ── 四态定义（为什么是这四个）──────────────────────────────────────────────
//   用两个正交轴分类，而不是一个"温度"轴：
//     纵轴 = 情绪分绝对水位（低 / 中 / 高）—— 现在多热
//     横轴 = 情绪分**方向**（上 / 平 / 下）—— 比前几天更热还是更冷
//   只有"水位 × 方向"合起来才有拐点语义：
//     冰点 = 水位低 + 方向平/下   （在底部磨，未见反转信号）
//     回暖 = 水位低/中 + 方向上   （从底部抬起来 —— 拐点）
//     高潮 = 水位高 + 方向上/平   （烫手，接力风险最大）
//     退潮 = 水位高/中 + 方向下   （从高位掉下来 —— 拐点）
//   高+下 与 低+上 是两个方向的**拐点**，正是本项目最有价值的信号。

// ── 阈值唯一出处 ──────────────────────────────────────────────────────────

export const REGIME_RULES = {
  // ⚠⚠ 实测抓出的**重大设计缺陷**（第一版阈值拍脑袋，全档核验后推翻，勿回退）
  //
  //   第一版用 40 / 65 作绝对水位分界（照搬 src/picks.js 的档位阈值）。全档 241 天
  //   实测分布：
  //     min=29.9  p10=40.9  p25=52.2  p50=59.8  p75=60.8  p90=61.5  max=85.6
  //     → **215/241 天（89%）落在 [40, 65) 区间**。即绝对分界几乎不起分类作用：
  //       它把 89% 的历史判成同一个"中位"，无论那天实际是冰冷还是火热。
  //   根因：本模型的情绪分是**多因子加权 + clamp** 出来的，分布高度压缩在 50-62
  //   的窄带里 —— 绝对刻度与"市场冷热"严重脱节。这是**这个模型的性质**，不是异常。
  //
  //   结论：绝对水位只保留为**辅助交叉验证**（用于披露"两把尺子读数是否一致"），
  //   真正的 level 判定必须走**历史分位**（相对自身历史的位置），因为分位天然
  //   对分布形状免疫、恒能把 241 天铺开到 0-100。
  //
  //   故 level 判定 = 以分位为主判据；分位缺失时才退化为绝对水位（并标低 confidence）。
  //   下面这两个绝对阈值**不作为主判据**，只用于 `levelCheck` 的交叉披露。
  LEVEL_LOW_ABS: 40,
  LEVEL_HIGH_ABS: 65,
  // 方向判据：用「相对 N 日前的情绪分变化」而不是斜率回归——样本短、稳健优先
  DIR_LOOKBACK: 3,   // 与 3 个交易日前比
  // ⚠ 方向阈值同样受"分布压缩"影响：241 天里 p25→p75 只有 8.6 分跨度，
  //   故 8 分的绝对变化其实已相当显著（超过 p25-p75 全域跨度）。取 6 更贴合实际尺度。
  DIR_UP: 6,
  DIR_DOWN: -6,
  // 分位判据（**主判据**）
  PCT_LOW: 30,
  PCT_HIGH: 70,
  // 方向证据的**最少历史天数**：不足则方向判 null（不猜）
  MIN_HISTORY: 3,
  // ── 背离判据（综合分 vs 宽度）───────────────────────────────────────────
  //   本项目已决策：宽度**不纳入**情绪分，而做"背离告警"。判据在此唯一出处。
  //   情绪分高位（分位 >= PCT_HIGH）而宽度判定为"收窄" → 假繁荣嫌疑；
  //   情绪分低位（分位 < PCT_LOW）而宽度"扩张" → 底部背离（少见但重要）。
  DIVERGENCE_PCT: 70,
  // ── 情绪过热/冰点的"极端"确认（需多项证据同时成立，防单指标误判）──────────
  SEAL_PCT_WEAK: 70,   // 封板率低于此值说明高位承接变差
  ICE_PCT_RANK_MAX: 10, // 分位 < 10 视为"位于历史底部区域"（冰点佐证）
};

// 四态标签（唯一出处；下游只引用不得自造字符串）
export const REGIME_LABELS = {
  ICE: { key: 'ice', label: '冰点', level: 'low', dir: 'flat' },
  RECOVER: { key: 'recover', label: '回暖', level: 'low', dir: 'up' },
  CLIMAX: { key: 'climax', label: '高潮', level: 'high', dir: 'up' },
  EBB: { key: 'ebb', label: '退潮', level: 'high', dir: 'down' },
  NEUTRAL: { key: 'neutral', label: '中性', level: 'mid', dir: 'flat' },
  UNKNOWN: { key: 'unknown', label: '数据不足', level: null, dir: null },
  // V5.3（2026-10-05 拍板）：新增「切换期」——信号矛盾时的保守档。
  //   设计纪律：这不是第六个"水位×方向"格子，而是**矛盾的显式出口**——
  //   判据互相打架时，宁可承认"看不清"并保守控仓，也不硬给一个方向性标签。
  //   level/dir 置 null：矛盾中无单一水位/方向可言（读取端不得对 shift 推导 level）。
  SHIFT: { key: 'shift', label: '切换期', level: null, dir: null },
};

// ── 数值加固（与 src/dirty.js::num 同款：拒 +[]===0 / +''===0 / +null===0）──
export function num(v) {
  if (v == null || v === '') return null;
  const t = typeof v;
  if (t !== 'number' && t !== 'string') return null;
  const n = +v;
  return Number.isFinite(n) ? n : null;
}
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

// ── ① 水位判定（分位为主判据，绝对水位为交叉验证）────────────────────────
//
//   ⚠ 实测抓出的设计缺陷（两版迭代，必须记录，防回退）：
//     · 第一版：只用**绝对水位**（< 40 / >= 65）。全档 241 天核验发现，情绪分分布
//       被 clamp 压在 50-62 窄带（p25=52.2 / p50=59.8 / p75=60.8），**89% 的天数
//       落在 [40,65)** → 绝对分界几乎不分类，把绝大多数历史都判成"中位"。
//     · 第二版曾试图"两个都用 + 取更极端的一侧"，实测更糟：绝对水位与分位在
//       33.8%（75/222）的天数上不一致（mid|high 45 天、mid|low 30 天），
//       "取更极端"会把大量中位日硬拽成高/低位，等于用一把**已知失真的尺子**
//       去覆盖一把**好用的尺子**。
//     · 定稿：**分位为唯一主判据**（分位天然免疫分布形状，恒把 241 天铺开到 0-100）；
//       绝对水位只用于 `levelCheck` 披露"两把尺子读数是否一致"，**不参与分类**。
//       分位缺失时才退化为绝对水位，并强制标 low confidence。
export function levelOf(score, pctRank, opts = {}) {
  const R = { ...REGIME_RULES, ...(opts.rules || {}) };
  const v = num(score);
  const p = num(pctRank);
  if (v === null && p === null) {
    return { level: null, byScore: null, byPct: null, agree: null, primary: null, note: '情绪分与分位均缺失' };
  }
  // 绝对水位（仅交叉验证用）
  const byScore = (v === null) ? null
    : (v < R.LEVEL_LOW_ABS ? 'low' : (v >= R.LEVEL_HIGH_ABS ? 'high' : 'mid'));
  // 分位水位（主判据）
  const byPct = (p === null) ? null
    : (p < R.PCT_LOW ? 'low' : (p >= R.PCT_HIGH ? 'high' : 'mid'));

  if (byPct !== null) {
    return {
      level: byPct, byScore, byPct, primary: 'pct',
      agree: byScore === null ? null : (byScore === byPct),
      note: (byScore !== null && byScore !== byPct)
        ? `历史分位判「${byPct}」（${p}%）而绝对水位判「${byScore}」（情绪分 ${v}）不一致；因情绪分分布高度压缩（实测 89% 天数落在 40-65），以分位为准`
        : null,
    };
  }
  // 分位缺失 → 退化到绝对水位，标记 primary 让调用方降 confidence
  return {
    level: byScore, byScore, byPct: null, primary: 'abs', agree: null,
    note: '历史分位缺失（样本不足），退化为绝对水位判定，可信度较低',
  };
}

// ── ② 方向判定 ────────────────────────────────────────────────────────────
//   输入最近的情绪分序列（升序，末位为当日）。返回 { dir, delta, lookback, reason }
//   dir ∈ 'up' | 'flat' | 'down' | null
//   ⚠ 样本不足 MIN_HISTORY → dir = null（明确"判不出"，绝不默认 flat——
//     flat 是"确认平"，与"没数据"是两回事）
export function directionOf(values, opts = {}) {
  const R = { ...REGIME_RULES, ...(opts.rules || {}) };
  const seq = (Array.isArray(values) ? values : []).map((v) => num(v)).filter((v) => v !== null);
  if (seq.length < R.MIN_HISTORY) {
    return { dir: null, delta: null, lookback: R.DIR_LOOKBACK, reason: `情绪分历史仅 ${seq.length} 天，不足 ${R.MIN_HISTORY} 天，方向不可判` };
  }
  const cur = seq[seq.length - 1];
  const idx = Math.max(0, seq.length - 1 - R.DIR_LOOKBACK);
  const base = seq[idx];
  const delta = r1(cur - base);
  const usedLookback = seq.length - 1 - idx;
  let dir;
  if (delta >= R.DIR_UP) dir = 'up';
  else if (delta <= R.DIR_DOWN) dir = 'down';
  else dir = 'flat';
  return {
    dir, delta, lookback: usedLookback,
    reason: `较 ${usedLookback} 个交易日前 ${delta >= 0 ? '+' : ''}${delta} 分`,
  };
}

// ── ③ 四态分类（核心）─────────────────────────────────────────────────────
//
// ctx = {
//   score,                    // 当日情绪分
//   pctRank,                  // 当日情绪分历史分位（可 null）
//   history: [.., score],     // 情绪分序列（升序，**含**当日；用于方向）
//   breadthVerdict,           // { level, label } —— 来自 breadth 模块（可 null）
//   painVerdict,              // { level, label, reason } —— 亏钱效应（可 null）
//   seatsVerdict,             // { level, label } —— 席位属性（可 null）
//   sealPct,                  // 封板率（可 null）
//   ztCount, dtCount,         // 涨停/跌停（可 null，用于极端确认）
// }
//
// 返回 {
//   key, label, level, dir,
//   confidence: 'high'|'mid'|'low',
//   evidence: [{ metric, value, reading }],   // 每条证据的原文读数（供日报直接引用）
//   caution: string|null,                     // 需要注意的反向证据（不隐藏矛盾）
//   unknownReasons: string[],                 // 判不出的原因（缺失显式化）
// }
export function classifyRegime(ctx = {}, opts = {}) {
  const R = { ...REGIME_RULES, ...(opts.rules || {}) };
  const unknownReasons = [];
  const score = num(ctx.score);
  const levelInfo = levelOf(score, ctx.pctRank, opts);
  const level = levelInfo.level;
  if (level === null) unknownReasons.push('当日情绪分与分位均缺失');
  if (levelInfo.agree === false) unknownReasons.push(levelInfo.note);

  const dirInfo = directionOf(ctx.history, opts);
  if (dirInfo.dir === null) unknownReasons.push(dirInfo.reason);
  const dir = dirInfo.dir;

  // 两条判据都缺 → 明确 unknown，不猜
  if (level === null && dir === null) {
    return {
      key: REGIME_LABELS.UNKNOWN.key, label: REGIME_LABELS.UNKNOWN.label,
      level: null, dir: null, confidence: 'low',
      evidence: [], caution: null, unknownReasons,
      shifted: false, shiftReasons: [],
      detail: '判据不足，无法给出状态标签。',
    };
  }
  // ★ 只有水位、完全没有方向（历史不足）→ 也不能给"中性/高潮"这种**有方向的结论**。
  //   实测抓出：首日（2025-10-09）曾因 level=mid 被判"中性"，但那天没有任何历史，
  //   "中性"是一个**方向性判断**（= 不涨不跌），用 0 天历史得出它是伪造结论。
  //   故：无方向 → 一律 UNKNOWN（可附"仅知水位"的提示），绝不假装判出了状态。
  if (dir === null) {
    return {
      key: REGIME_LABELS.UNKNOWN.key, label: REGIME_LABELS.UNKNOWN.label,
      level, dir: null, confidence: 'low',
      evidence: score !== null ? [{ metric: '情绪分', value: score, reading: `${score}（水位${({ low: '偏低', mid: '居中', high: '偏高' })[level] || '未知'}）` }] : [],
      caution: null,
      unknownReasons: [...unknownReasons, '方向不可判（历史不足），状态标签需要"水位 × 方向"两个维度，故不给结论'],
      shifted: false, shiftReasons: [],
      detail: `情绪分水位${({ low: '偏低', mid: '居中', high: '偏高' })[level] || '未知'}，但历史不足无法判方向，状态标签需要"水位 × 方向"两个维度。`,
    };
  }

  // 证据组装（读数一律取原值，不改写）
  const evidence = [];
  if (score !== null) evidence.push({ metric: '情绪分', value: score, reading: `${score}` });
  if (ctx.pctRank != null) evidence.push({ metric: '情绪分历史分位', value: num(ctx.pctRank), reading: `${num(ctx.pctRank)}%` });
  evidence.push({ metric: '方向', value: dirInfo.delta, reading: dirInfo.reason });
  if (ctx.breadthVerdict && ctx.breadthVerdict.label) {
    evidence.push({ metric: '市场宽度', value: null, reading: `${ctx.breadthVerdict.label}（${ctx.breadthVerdict.detail || ctx.breadthVerdict.level || ''}）` });
  }
  if (ctx.painVerdict && ctx.painVerdict.label) {
    evidence.push({ metric: '亏钱效应', value: null, reading: `${ctx.painVerdict.label}（${ctx.painVerdict.reason || ''}）` });
  }
  if (ctx.seatsVerdict && ctx.seatsVerdict.label) {
    evidence.push({ metric: '资金属性', value: null, reading: `${ctx.seatsVerdict.label}` });
  }

  // ── 分类：水位 × 方向 ─────────────────────────────────────────────────
  let key;
  let confidence = 'high';
  // 主判据用的是绝对水位（分位缺失）→ 尺子本身不可靠，置信度封顶 low
  const lvlShaky = levelInfo.primary === 'abs';
  if (lvlShaky) confidence = 'low';
  if (level === 'high') {
    key = (dir === 'down') ? 'ebb' : 'climax';   // high+down=退潮；high+up/flat=高潮
  } else if (level === 'low') {
    key = (dir === 'up') ? 'recover' : 'ice';    // low+up=回暖；low+flat/down=冰点
  } else { // mid
    // 中位区：只有当方向明确时才给拐点标签，否则一律"中性"
    if (dir === 'up') { key = 'recover'; }
    else if (dir === 'down') { key = 'ebb'; }
    else { key = 'neutral'; }
    if (!lvlShaky && confidence === 'high') confidence = 'mid';
  }
  const meta = REGIME_LABELS[key.toUpperCase()] || REGIME_LABELS.UNKNOWN;
  const modelKey = meta.key || key;
  const outEvidence = evidence;

  // ── 极端确认 / 反向证据（不隐藏矛盾）──────────────────────────────────
  let caution = null;
  const seal = num(ctx.sealPct);
  // ⚠ 用 `|| null` 归一：缺失时 painVerdict 为 undefined，若直接与 null 比较会漏判
  //   （实测踩过：冰点 caution 因 `undefined === null` 为 false 而永不触发）。
  const painLevel = (ctx.painVerdict && ctx.painVerdict.level) || null;
  const weakSeal = seal !== null && seal < R.SEAL_PCT_WEAK;
  const painBad = painLevel === 'warn' || painLevel === 'danger';
  if (key === 'climax') {
    // 高潮但亏钱效应已在恶化 / 封板率弱 → 这是"高潮末段"的典型特征，必须说出来
    if (weakSeal || painBad) {
      caution = `高位但${weakSeal ? `封板率仅 ${seal}%（< ${R.SEAL_PCT_WEAK}%）` : ''}${weakSeal && painBad ? '、' : ''}${painBad ? `亏钱效应${ctx.painVerdict.label}` : ''}，承接在变差，属"高潮末段"特征`;
    }
  } else if (key === 'ice') {
    // 冰点但封板率反而高 / 亏钱效应不差 → 可能是"缩量惜售"而非"恐慌"
    const strongSeal = seal !== null && seal >= R.SEAL_PCT_WEAK;
    if (strongSeal && (painLevel === 'ok' || painLevel === null)) {
      caution = `低位但封板率 ${seal}% 尚可，可能是缩量惜售而非恐慌抛售，需再看一日确认`;
    }
  }
  if (key === 'recover' || key === 'ebb') {
    caution = (confidence === 'mid' && lvlShaky)
      ? '方向判据成立，但绝对水位与历史分位读数不一致，拐点强度待确认'
      : null;
  }

  // ── ★ 矛盾覆盖 → 切换期（V5.3，2026-10-05 拍板）─────────────────────────
  //   规则（V5.3 需求：信号矛盾直接判【切换期】，保守控仓）——满足任一强矛盾，
  //   主标签被覆盖为 shift：
  //     A. 水位×宽度背离成立（假繁荣 / 底部背离）——判据调 detectDivergence
  //        （同文件唯一出处，不重写第二把尺子）；背离 = 情绪说热、宽度说冷（或反），
  //        状态本身就是"两把尺子打架"。
  //     B. 高潮末段特征（封板率弱 / 亏钱效应 warn|danger）——高潮里的承接恶化。
  //   ⚠ 刻意**不**触发（防切换期泛滥、稀释标签信息量）：
  //     · 双尺子（分位 vs 绝对水位）读数分歧——已解释的建模取舍，实测 33.8% 天
  //       不一致，若算矛盾会让三分之一个月都成"切换期"；它按原口径在第二节披露。
  //     · 冰点缩量惜售——弱矛盾（"再看一日"级别），保持 caution 不升格。
  //   shift 语义：不预测拐点，只承认"当下判据打架"；仓位端保守处理（见
  //   src/position_policy.js）。confidence 封顶 mid——矛盾本身可以很确凿，
  //       但结论是"方向不明"，不给 high。
  const shiftReasons = [];
  const div = detectDivergence({
    score, pctRank: num(ctx.pctRank), breadthVerdict: ctx.breadthVerdict,
  }, opts);
  if (div.diverged) shiftReasons.push(`水位×宽度背离：${div.label}（${div.reason}）`);
  if (key === 'climax' && (weakSeal || painBad)) shiftReasons.push('高潮末段特征：高位承接变差');
  let shifted = false;
  if (shiftReasons.length && key !== 'unknown') {
    shifted = true;
    if (caution) shiftReasons.unshift(caution); // 原主标签下的 caution 一并保留（矛盾证据不丢）
    caution = shiftReasons.join('；');
  }
  const finalKey = shifted ? REGIME_LABELS.SHIFT.key : modelKey;
  const finalMeta = shifted ? REGIME_LABELS.SHIFT : meta;
  if (shifted && confidence === 'high') confidence = 'mid';

  return {
    key: finalKey, label: finalMeta.label, level: shifted ? null : level, dir: shifted ? null : dir, confidence,
    evidence: outEvidence, caution, unknownReasons,
    shifted, shiftReasons: shifted ? shiftReasons : [],
    levelCheck: { byScore: levelInfo.byScore, byPct: levelInfo.byPct, agree: levelInfo.agree, primary: levelInfo.primary, note: levelInfo.note },
    detail: shifted
      ? `${buildDetail(meta, level, dir, dirInfo)}，但判据矛盾 → 覆盖为「切换期」（保守控仓，不预测拐点）`
      : buildDetail(meta, level, dir, dirInfo),
  };
}

function buildDetail(meta, level, dir, dirInfo) {
  const lv = { low: '低位', mid: '中位', high: '高位' }[level] || '水位未知';
  const dr = { up: '上行', flat: '横盘', down: '下行' }[dir] || '方向未知';
  if (meta.key === 'unknown') return '判据不足，无法给出状态标签。';
  return `情绪分${lv}、近期${dr}（${dirInfo.reason || '—'}）→ ${meta.label}`;
}

// ── ④ 综合分 vs 宽度背离告警（独立输出，与标签并列）───────────────────────
//
//   已决策：宽度**不纳入**情绪分。理由：宽度是"多少票在涨"，情绪分是"钱有多凶"，
//   两者同向时无信息量；**背离时**才是信号。故此处只做背离检测，不改情绪分。
//
//   返回 { diverged: bool, kind, level, label, reason } | { diverged:false, ... }
export function detectDivergence(ctx = {}, opts = {}) {
  const R = { ...REGIME_RULES, ...(opts.rules || {}) };
  const score = num(ctx.score);
  const pct = num(ctx.pctRank);
  const bv = ctx.breadthVerdict;
  const bLevel = bv && bv.level ? String(bv.level) : null;
  // 主判据 = 历史分位（与 levelOf 同源，避免两处各用一把尺子）
  const level = (pct !== null)
    ? (pct < R.PCT_LOW ? 'low' : (pct >= R.PCT_HIGH ? 'high' : 'mid'))
    : (score === null ? null : (score < R.LEVEL_LOW_ABS ? 'low' : (score >= R.LEVEL_HIGH_ABS ? 'high' : 'mid')));
  const pctTxt = pct !== null ? `分位 ${pct}%` : (score !== null ? `情绪分 ${score}` : '情绪分缺失');
  if (level === null) {
    return { diverged: false, kind: null, level: 'unknown', label: '无法判定', reason: '情绪分缺失，无法比对宽度' };
  }
  if (!bLevel) {
    return { diverged: false, kind: null, level: 'unknown', label: '未评估', reason: '宽度判定缺失，不做背离判断（缺失不等于一致）' };
  }
  const narrow = bLevel === 'narrow' || bLevel === 'very_narrow';
  const wide = bLevel === 'broad' || bLevel === 'very_broad';
  // 假繁荣：钱凶（情绪高位）但只有少数票在涨（宽度窄）
  if (level === 'high' && narrow) {
    return {
      diverged: true, kind: 'fake-boom', level: 'warn', label: '假繁荣嫌疑',
      reason: `${pctTxt}（高位）但宽度「${bv.label}」，涨势集中在少数票，赚钱面未同步扩散`,
    };
  }
  // 底部背离：情绪冷（低位）但广泛在涨（宽度扩张）—— 少见，往往是底部反转前兆
  if (level === 'low' && wide) {
    return {
      diverged: true, kind: 'bottom-divergence', level: 'info', label: '底部背离',
      reason: `${pctTxt}（低位）但宽度「${bv.label}」，涨幅面已先于情绪扩散，关注反转能否延续`,
    };
  }
  return {
    diverged: false, kind: null, level: 'ok', label: '同向',
    reason: `${pctTxt} 与宽度「${bv.label}」方向一致，无背离`,
  };
}

// ── ⑤ 组装 signals-latest 的 divergence 区块（两条写盘路径共用）───────────
//
//   与 buildRegimeBlock 同源同理：唯一出处放这里，pipeline.js 与 split_archive.mjs
//   只注入调用，不各自重写（否则切片 --check 报形态分裂）。
//
//   为什么独立成段：regime 回答"今天什么状态"，背离回答"这个状态可信吗"。
//   两者读者不同、失败域也不同——日报生成失败不该把背离一起带走。
//
//   days    —— 主档 day 数组（升序）
//   breadth —— breadth 段（{ verdict: { level, label } }），缺失即"未评估"
//   返回 { diverged, kind, level, label, reason, ref, checked } | null
export function buildDivergenceBlock(days, breadth) {
  const list = Array.isArray(days) ? days : [];
  if (!list.length) return null;
  const last = list[list.length - 1] || {};
  const bv = (breadth && breadth.verdict) ? breadth.verdict : null;
  const raw = detectDivergence({
    score: last.emotion ? last.emotion.value : null,
    pctRank: last.emotion ? last.emotion.pct_rank : null,
    breadthVerdict: bv,
  });
  // 全档"背离天数"计数：让读者知道这条告警**稀不稀罕**。
  //   稀罕的告警才值得看；天天响的告警等于没响（本项目对"恒不触发"与"恒触发"同样警惕）。
  //   ⚠ 逐日必须用**截至当日**的宽度判定（前视锁窗同一纪律）；宽度序列不存在时
  //     只能给出"最新日可判、历史不可判"，此时 historyChecked=false，不伪造计数。
  const histRaw = (breadth && Array.isArray(breadth.series))
    ? breadth.series
    : ((breadth && Array.isArray(breadth.daily)) ? breadth.daily : null);
  let history = null;
  if (histRaw && histRaw.length) {
    const byDate = new Map();
    // 宽度序列有两种形态（历史遗留）：
    //   · buildBreadthSeries 产出 { date, verdict: 'narrow'|'broad'|... }（verdict 是字符串）
    //   · 早期/手工注入形态 { trade_date, verdict: { level, label } }
    //   两种都要能读，否则"宽度序列在，却统计出 0 天核对过"——静默失真的经典坑。
    histRaw.forEach((r) => {
      if (!r) return;
      const d = r.trade_date || r.date;
      if (!d) return;
      byDate.set(d, r);
    });
    let checked = 0; const hits = [];
    list.forEach((d) => {
      const row = byDate.get(d.trade_date);
      if (!row) return;                      // 该日无宽度判定 → 未核对，不计入分母
      const rv = row.verdict;
      const v = (rv && typeof rv === 'object')
        ? rv
        : (rv ? { level: rv, label: null } : (row.level ? { level: row.level, label: row.label } : null));
      if (!v || !v.level) return;
      const r = detectDivergence({
        score: d.emotion ? d.emotion.value : null,
        pctRank: d.emotion ? d.emotion.pct_rank : null,
        breadthVerdict: v,
      });
      if (r.level === 'unknown') return;     // 未评估 ≠ 同向
      checked++;
      if (r.diverged) hits.push({ trade_date: d.trade_date, kind: r.kind, label: r.label });
    });
    history = {
      checkedDays: checked,
      divergedDays: hits.length,
      // 分母为 0 时必须为 null（不是 0%）——"没核对过"和"核对过但一次没背离"是两回事
      ratePct: checked ? Math.round((hits.length / checked) * 1000) / 10 : null,
      recent: hits.slice(-8),
    };
  }
  return {
    ...raw,
    ref: 'src/regime.js::detectDivergence',
    history,
    historyNote: history
      ? '历史背离率只在"当日情绪分与宽度判定同时可算"的交易日上统计（未核对日不计入分母）；'
        + '分母为 0 时显示"未计算"而非 0%。'
      : '历史背离率未计算：宽度逐日序列缺失（仅最新日可判）。',
  };
}

// ── ⑥ 组装 signals-latest 的 regime 区块（两条写盘路径共用，唯一出处）──────
//
//   ⚠ 为什么必须共用：本项目有两条写盘路径（src/pipeline.js::writeShards 与
//     scripts/split_archive.mjs），二者产出的 signals-latest.json 必须**逐字段一致**，
//     否则切片 --check 会报分裂。故区块组装逻辑放这里，两处只调用不重写。
//
//   days —— 主档 day 数组（升序）。每项读 emotion.value / emotion.pct_rank /
//           summary.seal_pct。缺失即 null（不填 0）。
//   返回 { latest, series, counts, recent, rules }
export function buildRegimeBlock(days) {
  const list = Array.isArray(days) ? days : [];
  if (!list.length) return null;
  // 序列只取最近 REGIME_SERIES_DAYS 天（体积纪律：逐日标签约 100B/天，90 天约 9KB）
  const SERIES_DAYS = 90;
  const tail = list.slice(-SERIES_DAYS);
  const series = classifySeries(tail.map((d) => ({
    trade_date: d.trade_date,
    value: d.emotion ? d.emotion.value : null,
    pct_rank: d.emotion ? d.emotion.pct_rank : null,
    seal_pct: d.summary ? d.summary.seal_pct : null,
  })));
  const last = list[list.length - 1];
  const lastLabel = series.length ? series[series.length - 1] : null;
  // 全档分布（用于"这个标签历史上常见吗"）——不在序列窗口内也算，故对全档重跑
  const allSeries = (list.length > SERIES_DAYS)
    ? classifySeries(list.map((d) => ({
      trade_date: d.trade_date,
      value: d.emotion ? d.emotion.value : null,
      pct_rank: d.emotion ? d.emotion.pct_rank : null,
      seal_pct: d.summary ? d.summary.seal_pct : null,
    })))
    : series;
  const counts = {};
  allSeries.forEach((s) => { counts[s.label] = (counts[s.label] || 0) + 1; });

  return {
    // 最新一日完整判定（含证据与 caution，供前端首屏大字）
    latest: lastLabel ? {
      ...lastLabel,
      date: last.trade_date,
      detail: null,   // detail 由 classifyRegime 给；此处简要标签已够首屏
    } : null,
    // ★ 序列压缩（体积纪律）：逐日只保留 [date, value, pct, key] 四元组，
    //   其余字段（level/dir/confidence/caution）由 key + 阈值**在读取端可推导**。
    //   ⚠ 为什么不逐日存 label/level/dir/confidence/caution：实测 day 90 天时
    //     regime 段飙到 14.4KB（占轻量档 1/3），而其中 90% 是重复的短串。
    //     本项目的既定做法是**码表化**（见 lhb_codec.js 的 rc 码表），此处同源：
    //     key 本身即标签码（'ice'/'recover'/'climax'/'ebb'/'neutral'/'unknown'）。
    //     前端要显示中文标签 → 查 REGIME_LABELS（同一份唯一出处），不各自写死。
    //   字段：s = series 的紧凑形式 [date, value, pct_rank, key]
    seriesCompact: series.map((s) => [s.trade_date, s.value, s.pct_rank, s.key]),
    seriesFields: ['trade_date', 'value', 'pct_rank', 'key'],
    seriesWindow: series.length,
    counts,
    totalDays: allSeries.length,
    // 近期拐点（最近 window 天里标签发生变化的日子）——用户最关心的"变盘点"
    turns: detectTurns(allSeries, 10),
    rules: {
      levelLowAbs: REGIME_RULES.LEVEL_LOW_ABS,
      levelHighAbs: REGIME_RULES.LEVEL_HIGH_ABS,
      pctLow: REGIME_RULES.PCT_LOW,
      pctHigh: REGIME_RULES.PCT_HIGH,
      dirLookback: REGIME_RULES.DIR_LOOKBACK,
      dirUp: REGIME_RULES.DIR_UP,
      dirDown: REGIME_RULES.DIR_DOWN,
    },
    // 标签码 → 中文（唯一出处，前端不得自造）
    labels: Object.fromEntries(Object.values(REGIME_LABELS).map((x) => [x.key, x.label])),
    note: '标签 = 水位（历史分位为主判据）× 方向（较 3 个交易日前变化）；'
      + '水位与方向任一不可判则显示"数据不足"。历史分位为主判据，因实测情绪分分布高度压缩（89% 天数落在 40-65）。'
      + '判据矛盾（水位×宽度背离 / 高潮末段承接变差）时覆盖为「切换期」（V5.3）。'
      + '标签只描述市场状态，不含买卖建议。',
  };
}

// 近 window 天内标签变化的日期（拐点）
function detectTurns(series, window) {
  const out = [];
  if (!Array.isArray(series) || series.length < 2) return out;
  const start = Math.max(1, series.length - window);
  for (let i = start; i < series.length; i++) {
    const prev = series[i - 1], cur = series[i];
    if (prev.label && cur.label && prev.label !== cur.label) {
      out.push({ date: cur.trade_date, from: prev.label, to: cur.label, value: cur.value });
    }
  }
  return out;
}

// ── ⑦ 序列批量标注（供日报/走势图用）────────────────────────────────────
//   days: 升序日数组，每项含 { trade_date, value }；逐日按"截至当日"的历史算标签。
//   ⚠ 严禁前视：第 i 天只能用 days[0..i]（与 #1 分位锁窗同一纪律）。
export function classifySeries(days, ctxByDate = {}, opts = {}) {
  const list = Array.isArray(days) ? days : [];
  const out = [];
  const hist = [];
  list.forEach((d) => {
    const v = num(d && (d.value ?? d.score));
    if (v !== null) hist.push(v);
    const ctx = Object.assign({}, ctxByDate[d && d.trade_date] || {}, {
      score: v,
      history: hist.slice(),   // 截至当日（含）—— 绝不含未来
      pctRank: num(d && d.pct_rank),
      sealPct: num(d && d.seal_pct),
    });
    const r = classifyRegime(ctx, opts);
    out.push({
      trade_date: d && d.trade_date,
      value: v,
      pct_rank: num(d && d.pct_rank),
      key: r.key, label: r.label, level: r.level, dir: r.dir,
      confidence: r.confidence, caution: r.caution || null,
    });
  });
  return out;
}
