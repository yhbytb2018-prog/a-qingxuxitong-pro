// 每日盘后日报生成器（#4）
//
// ── 职责边界（关键）────────────────────────────────────────────────────────
//   本模块是**纯渲染器**：输入是已经算好的素材（signals-latest.json 的各个区块），
//   输出是一份**结构化的日报数据**（分节 + 要点 + 出处）。
//   它**不重算任何指标**——情绪分来自 computeSentiment、宽度来自 breadth.js、
//   亏钱效应来自 pain.js、席位来自 seats_daily.js、标签来自 regime.js。
//   这里是唯一的"翻译层"：把数字翻译成人话，且**只翻译屏幕上已有的东西**。
//
// ── 为什么不做成 HTML 字符串 ────────────────────────────────────────────────
//   因为前端要能逐节折叠、导出、打印、被审计。返回结构化数据让前端自由渲染，
//   也便于测试（断言"第 3 节讲了什么"而不是"HTML 里有没有某个字符串"）。
//
// ── 纪律 ──────────────────────────────────────────────────────────────────
//   • **缺失显式化**：拿不到的项写 `missing: true` + 原因，**绝不编造**，
//     也不输出"0"或"平稳"这类伪装成正常的措辞。
//   • **只引用不改写**：所有读数来自入参，本模块不做任何四舍五入以外的加工
//     （round 只在显示层做，且必须标注单位）。
//   • **不构成投资建议**：措辞只描述状态与风险，不给买卖动作。

import { classifyRegime, detectDivergence, num } from './regime.js';
import { positionLine, DISCLAIMER as POSITION_DISCLAIMER } from './position_policy.js';

// 显示层舍入（唯一出处；不改动源数据）
export const DISPLAY = { pct1: 1, score1: 1 };

const f1 = (v) => { const n = num(v); return n === null ? null : Math.round(n * 10) / 10; };
const f2 = (v) => { const n = num(v); return n === null ? null : Math.round(n * 100) / 100; };
const yen = (v) => { const n = num(v); return n === null ? null : `${Math.round(n).toLocaleString('zh-CN')} 元`; };

// ── 主入口 ────────────────────────────────────────────────────────────────
//
// signals —— signals-latest.json 的内容（或其子集）
// 返回 { date, headline, tag, divergence, sections: [...], caveats: [...], sources: {...} }
//
// sections 每项：{ id, title, level: 'info'|'warn'|'ok'|'unknown', points: [...], missing: bool, missingReason }
export function buildDailyReport(signals = {}) {
  const S = signals || {};
  const latest = S.latest || {};
  const date = latest.trade_date || (S.meta && S.meta.tradeDate) || null;

  // ── ① 状态标签（regime）─────────────────────────────────────────────────
  //   封板率可能放在 latest.seal_pct 或 summary.seal_pct，两种都试（缺失即 null，不猜）。
  const sealPct = num(latest.seal_pct ?? (S.summary && S.summary.seal_pct));
  const regFull = classifyRegime({
    score: latest.value,
    pctRank: latest.pct_rank,
    history: (S.regimeSeries || []).map((x) => (x && (x.value ?? x.score))),
    breadthVerdict: S.breadth && S.breadth.verdict,
    painVerdict: S.pain && S.pain.verdict,
    seatsVerdict: S.seats && S.seats.verdict,
    sealPct,
  });

  // ── ② 背离（综合分 vs 宽度）────────────────────────────────────────────
  //   ⚠ 优先用调用方传入的 divergence 段（signals-latest 的独立段落，唯一出处
  //     src/regime.js::buildDivergenceBlock）；未传时才退回本地 detectDivergence。
  //     为什么优先用它：同一份数据在"宽度背离面板"与"日报"里必须是同一条结论，
  //     若两处各自调一次，将来改判据就会漏改一处 → 面板说背离、日报说同向。
  const div = (S.divergence && typeof S.divergence === 'object')
    ? S.divergence
    : detectDivergence({
      score: latest.value,
      pctRank: latest.pct_rank,
      breadthVerdict: S.breadth && S.breadth.verdict,
    });

  const sections = [];
  const caveats = [];

  // ── 节 1：市场状态 ──────────────────────────────────────────────────────
  sections.push(buildRegimeSection(regFull, div));

  // ── 节 2：情绪与分位 ────────────────────────────────────────────────────
  sections.push(buildSentimentSection(latest, regFull));

  // ── 节 3：涨跌与连板结构 ────────────────────────────────────────────────
  sections.push(buildBreadthSection(latest, S.breadth, S));

  // ── 节 4：亏钱效应 / 接力 ───────────────────────────────────────────────
  sections.push(buildPainSection(S.pain));

  // ── 节 5：资金与席位属性 ────────────────────────────────────────────────
  sections.push(buildSeatsSection(S.seats));

  // ── 节 6：题材与相对强弱 ────────────────────────────────────────────────
  sections.push(buildThemeSection(latest, S.relative));

  // ── 节 7：数据质量与告警 ────────────────────────────────────────────────
  sections.push(buildQualitySection(S));

  // ── 节 8：舆情参考（LLM 试点，V5.3 P2）─────────────────────────────────
  //   刻意放最后且 title 自带"参考"：±5 修正不进交易信号（原分不动），读者
  //   须先看完七个量价/结构节再看这条软信息——试点定位，权重天然最低。
  sections.push(buildLlmSection(S.llm));

  // 汇总 caveats（从各节与 regime 收集，集中给用户看）
  if (regFull.caution) caveats.push(regFull.caution);
  if (div.diverged) caveats.push(`${div.label}：${div.reason}`);
  // ⚠ 只把**真正的判据缺口**（拿不到数据 / 维度缺失）计入 caveats。
  //   水位双尺子读数是**已解释的建模取舍**（分位为主、绝对刻度仅交叉验证），
  //   它已经在"情绪与分位"节里如实披露，不应混进"缺口"清单——
  //   否则用户会误以为数据有问题，而实际是**尺度差异**。缺口的定义要严：
  //   "缺"指拿不到，不指"与另一把尺子读数不同"。
  (regFull.unknownReasons || [])
    .filter((r) => !/不一致.*以分位为准|退化为绝对水位/.test(r))
    .forEach((r) => caveats.push(`判据缺口：${r}`));

  const missingCount = sections.filter((s) => s.missing).length;

  return {
    date,
    // 一句话结论（供首屏大字）
    headline: buildHeadline(regFull, div, date, missingCount),
    tag: { key: regFull.key, label: regFull.label, level: regFull.level, dir: regFull.dir, confidence: regFull.confidence },
    divergence: div,
    sections,
    caveats,
    // 出处：报告里的每个数字从哪来（可追溯，配合 #40 数据血缘）
    sources: {
      regime: 'src/regime.js（本模块判据）',
      position: 'src/position_policy.js（仓位区间唯一出处）',
      sentiment: 'src/formula_versions.js + src/sentiment.js',
      breadth: 'src/breadth.js',
      pain: 'src/pain.js',
      seats: 'src/seats_daily.js',
      relative: 'src/relative.js',
      dirty: 'src/dirty.js',
      health: 'src/health.js',
      llm: 'src/llm_sentiment.js + scripts/fetch_llm_sentiment.mjs（data/llm-sentiment-latest.json）',
    },
    // 免责与口径声明（报告尾部固定输出）
    disclaimer: '本日报只描述市场状态与风险特征，不构成投资建议；所有读数来自当日已归档数据，缺失项一律标注"未采集/未计算"而非补 0。'
      + POSITION_DISCLAIMER,
  };
}

// ── 节构造器 ──────────────────────────────────────────────────────────────

function buildRegimeSection(reg, div) {
  const pts = [];
  if (reg.key === 'unknown') {
    return {
      id: 'regime', title: '一、市场状态判定', level: 'unknown', missing: true,
      missingReason: (reg.unknownReasons || []).join('；') || '判据不足',
      points: ['状态标签需"水位 × 方向"两个维度，当前判据不足，不给结论（不猜）。', '状态不明 → 无仓位区间意见；按保守档（0%~20%）处理，见风控说明。'],
    };
  }
  // V5.3 前置块：状态 → 推荐仓位区间（position_policy 唯一出处；shift 为强制降仓档）
  const pos = positionLine(reg.key);
  if (pos) pts.push({ text: pos.text, kind: 'main' });
  pts.push({ text: reg.detail, kind: 'main' });
  (reg.evidence || []).forEach((e) => pts.push({ text: `${e.metric}：${e.reading}`, kind: 'evidence' }));
  if (reg.caution) pts.push({ text: `⚠ ${reg.caution}`, kind: 'caution' });
  return {
    id: 'regime', title: '一、市场状态判定',
    level: reg.caution ? 'warn' : 'info',
    missing: false, points: pts,
    tag: reg.label, confidence: reg.confidence,
    levelCheck: reg.levelCheck || null,
    position: pos ? { range: pos.range, force: pos.force, tone: pos.band.tone } : null,
  };
}

function buildSentimentSection(latest, reg) {
  const v = f1(latest.value);
  const pct = f1(latest.pct_rank);
  const npct = f1(latest.net_daily_pct_rank);
  const pts = [];
  if (v === null) {
    return { id: 'sentiment', title: '二、情绪与分位', level: 'unknown', missing: true, missingReason: '情绪分未计算', points: [] };
  }
  pts.push({ text: `情绪分 ${v}${pct !== null ? `，历史分位 ${pct}%` : '（分位未计算）'}`, kind: 'main' });
  if (npct !== null) pts.push({ text: `龙虎榜净买分位 ${npct}%`, kind: 'evidence' });
  // 因子明细（有则列，缺失的显式跳过，不填 0）
  const fac = latest.factors || {};
  const facTxt = Object.entries(fac)
    .filter(([, x]) => num(x) !== null)
    .map(([k, x]) => `${k} ${f1(x)}`)
    .join(' · ');
  if (facTxt) pts.push({ text: `因子：${facTxt}`, kind: 'evidence' });
  if (latest.imputedRatio != null && num(latest.imputedRatio) > 0) {
    pts.push({ text: `代理补位比例 ${f1(latest.imputedRatio * 100)}%（该比例越高，分数越依赖代理值）`, kind: 'caution' });
  }
  if (Array.isArray(latest.missing) && latest.missing.length) {
    pts.push({ text: `缺失因子：${latest.missing.join('、')}（已走缺失通道，未填 0）`, kind: 'caution' });
  }
  if (reg.levelCheck && reg.levelCheck.agree === false) {
    pts.push({ text: `⚠ 水位判据分歧：${reg.levelCheck.note}`, kind: 'caution' });
  }
  return { id: 'sentiment', title: '二、情绪与分位', level: 'info', missing: false, points: pts };
}

function buildBreadthSection(latest, breadth, S = {}) {
  const up = num(latest.up_count), down = num(latest.down_count);
  const flat = num(latest.flat_count);
  const zt = num(latest.zt_count), dt = num(latest.dt_count), zb = num(latest.zb_count);
  const seal = num(latest.seal_pct);
  const pts = [];
  const missingBits = [];
  // 指数表现（市场背景，档案 indexes 直读——此前数据在档但报告从不显示，读者只能外看行情）
  const idx = (latest.indexes && typeof latest.indexes === 'object') ? latest.indexes : null;
  if (idx) {
    const parts = Object.entries(idx)
      .map(([k, v]) => [k, num(v)]).filter(([, v]) => v !== null)
      .map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${f1(v)}%`);
    if (parts.length) pts.push({ text: `指数：${parts.join(' · ')}`, kind: 'evidence' });
  }
  if (up !== null && down !== null) {
    // 合计 = up+down+flat（真实样本量；不含平盘的旧写法 5123 会与全市场口径对比时放大差异）
    pts.push({ text: `涨 ${up} / 跌 ${down}${flat !== null ? ` / 平 ${flat}` : ''}（样本 ${up + down + (flat ?? 0)}）`, kind: 'main' });
  } else missingBits.push('涨跌家数');
  // 两市成交额（档案 amount_yi 直读；增量对照前日——量能是「中性震荡 vs 修复」判读的关键输入）
  const amt = num(latest.amount_yi);
  if (amt !== null) {
    const prev = num(S.amountPrevYi);
    const delta = prev !== null ? Math.round(amt - prev) : null;
    pts.push({ text: `两市成交额 ${Math.round(amt)} 亿${delta !== null ? `（较前一日 ${delta >= 0 ? '+' : ''}${delta} 亿）` : ''}`, kind: 'evidence' });
  }
  if (zt !== null || dt !== null) {
    pts.push({ text: `涨停 ${zt ?? '未采集'} / 跌停 ${dt ?? '未采集'}${zb !== null ? ` / 炸板 ${zb}` : ''}`, kind: 'evidence' });
  } else missingBits.push('涨停跌停');
  if (seal !== null) pts.push({ text: `封板率 ${f1(seal)}%`, kind: 'evidence' });
  const bv = breadth && breadth.verdict;
  if (bv && bv.label) pts.push({ text: `市场宽度：${bv.label}${bv.detail ? `（${bv.detail}）` : ''}`, kind: 'main' });
  else missingBits.push('市场宽度');
  // 宽度序列（近几日的趋势）
  const bs = breadth && breadth.summary;
  if (bs && bs.latest && bs.latest.maRatio != null) {
    pts.push({ text: `站上 20 日线占比 ${f1(num(bs.latest.maRatio) * 100)}%`, kind: 'evidence' });
  }
  // ── 固定口径披露（复盘对比纪律）────────────────────────────────────────
  //   涨跌家数/涨停跌停的样本范围必须写明：各平台「全市场口径」（含北交所/ST）
  //   数值系统性更高，不写口径会被当成数据错误。⚠ 值本身不改——全档 241 天的
  //   s_pos 分位与 pct_rank 都在本口径上计算，改数即口径漂移。
  if (up !== null || zt !== null) {
    const scope = latest.breadth_scope || '沪深两市A股（不含北交所/ST）';
    const pool = latest.pools_caliber === 'kline-rebuild' ? 'K线重建（触板未封口径）' : '东财池';
    pts.push({ text: `口径：${scope}；涨停/跌停为${pool}同范围。与含北交所/ST 的全市场口径数值更高，属样本范围差异`, kind: 'evidence' });
  }
  if (!pts.length) {
    return { id: 'breadth', title: '三、涨跌与连板结构', level: 'unknown', missing: true, missingReason: '当日无涨跌/连板数据', points: [] };
  }
  return {
    id: 'breadth', title: '三、涨跌与连板结构',
    level: missingBits.length ? 'warn' : 'info',
    missing: false,
    points: pts.concat(missingBits.length ? [{ text: `未采集：${missingBits.join('、')}`, kind: 'caution' }] : []),
  };
}

function buildPainSection(pain) {
  if (!pain || !pain.verdict) {
    return { id: 'pain', title: '四、亏钱效应 / 接力', level: 'unknown', missing: true, missingReason: '需外部真实行情，未注入', points: [] };
  }
  const pts = [];
  const p = pain.perf || {}, a = pain.advance || {};
  if (pain.verdict.label) pts.push({ text: `${pain.verdict.label}：${pain.verdict.reason || ''}`, kind: 'main' });
  if (p.n) {
    pts.push({ text: `昨涨停今日均涨 ${f1(p.avg)}%、中位 ${f1(p.median)}%、翻绿比例 ${f1(num(p.lossRatio) * 100)}%`, kind: 'evidence' });
    if (p.limitUpAgain != null) pts.push({ text: `其中再涨停 ${p.limitUpAgain} 只、跌停 ${p.limitDown ?? 0} 只`, kind: 'evidence' });
  }
  if (a.n) pts.push({ text: `连板晋级：${a.kept}/${a.n} 成功（失败率 ${f1(num(a.failRate) * 100)}%）`, kind: 'evidence' });
  if (pain.bigLoss && pain.bigLoss.n) {
    const names = (pain.bigLoss.list || []).slice(0, 4).map((x) => `${x.name || x.code} ${f1(x.chg)}%`).join('、');
    pts.push({ text: `大面 ${pain.bigLoss.n} 只：${names}`, kind: 'caution' });
  }
  if (p.reliable === false) pts.push({ text: '⚠ 该项样本不足，可靠性低', kind: 'caution' });
  return { id: 'pain', title: '四、亏钱效应 / 接力', level: (pain.verdict.level === 'warn' || pain.verdict.level === 'danger') ? 'warn' : 'info', missing: false, points: pts };
}

function buildSeatsSection(seats) {
  if (!seats || !seats.verdict) {
    return { id: 'seats', title: '五、资金与席位属性', level: 'unknown', missing: true, missingReason: '席位明细仅保留最近数日，未累积到当日', points: [] };
  }
  const pts = [];
  const sm = seats.summary || {};
  if (seats.verdict.label) pts.push({ text: `${seats.verdict.label}`, kind: 'main' });
  if (seats.verdict.reason) pts.push({ text: seats.verdict.reason, kind: 'evidence' });
  const parts = [];
  if (sm.instNet && sm.instNet.last != null) parts.push(`机构 ${f1(sm.instNet.last)} 亿`);
  if (sm.northNet && sm.northNet.last != null) parts.push(`北向 ${f1(sm.northNet.last)} 亿`);
  if (sm.hotNet && sm.hotNet.last != null) parts.push(`游资 ${f1(sm.hotNet.last)} 亿`);
  if (parts.length) pts.push({ text: `当日净买：${parts.join(' / ')}`, kind: 'evidence' });
  if (sm.totalRows != null) pts.push({ text: `席位序列累计 ${sm.totalRows} 个交易日（覆盖 ${f1(num(sm.coverage || 0) * 100)}%）`, kind: 'evidence' });
  return { id: 'seats', title: '五、资金与席位属性', level: 'info', missing: false, points: pts };
}

function buildThemeSection(latest, relative) {
  const pts = [];
  const mt = latest.main_theme;
  if (mt && mt.name) {
    pts.push({ text: `主力题材「${mt.name}」净买 ${f2(mt.main_yi)} 亿，占当日龙虎榜净买 ${f1(mt.pct)}%`, kind: 'main' });
  }
  const rel = latest.industry_relative || relative;
  if (rel) {
    const vs = rel.vsIndex || rel.vsMedian;
    if (vs && vs.attack && vs.attack.length) {
      const top = vs.attack.slice(0, 4).map((x) => `${x.name} ${f1(x.change_pct)}%（超额 ${f1(x.excess)}）`).join('、');
      pts.push({ text: `进攻方向（相对${vs.baseLabel || '基准'}）：${top}`, kind: 'evidence' });
    }
    if (vs && vs.defense && vs.defense.length) {
      const bot = vs.defense.slice(0, 4).map((x) => `${x.name} ${f1(x.change_pct)}%`).join('、');
      pts.push({ text: `承压方向：${bot}`, kind: 'evidence' });
    }
    if (rel.degraded) pts.push({ text: `⚠ 相对强弱已降级：${rel.degradedReason || '行业明细不足'}`, kind: 'caution' });
  }
  if (!pts.length) {
    return { id: 'theme', title: '六、题材与相对强弱', level: 'unknown', missing: true, missingReason: '无行业明细，相对强弱未计算', points: [] };
  }
  return { id: 'theme', title: '六、题材与相对强弱', level: 'info', missing: false, points: pts };
}

function buildQualitySection(S) {
  const pts = [];
  let level = 'ok';
  const d = S.dirty;
  if (d) {
    if (d.dirtyDays > 0) { pts.push({ text: `⚠ 全档有 ${d.dirtyDays} 天存在必剔级脏数据（已从因子入参剔除，原值保留可追溯）`, kind: 'caution' }); level = 'warn'; }
    else if (d.warnDays > 0) { pts.push({ text: `全档 ${d.warnDays} 天存在需人工复核的告警项（只标记、不剔除）`, kind: 'caution' }); level = 'warn'; }
    else { pts.push({ text: `全档 ${d.totalDays} 天校验通过，无脏数据`, kind: 'ok' }); }
    // 告警复核闭环（scripts/review_alerts.mjs 的 day.review 留痕 → 档案聚合下发）：
    //   已复核的 WARN 若全部跨源互证通过，读者不必再"人工复核"——结论在此披露，
    //   与「需人工复核」那句并排放，语义分层：告警仍在（只标记不剔除的纪律），
    //   但数值真实性已由独立第二源确认。
    const rv = d.review;
    if (rv && rv.checked > 0) {
      if (rv.verified > 0) pts.push({ text: `告警复核：${rv.verified}/${rv.checked} 条已跨源互证销案（板块页采集 vs 年线重算两源一致，孤立源于主题级行情，数据保留）`, kind: 'evidence' });
      if (rv.mismatch > 0) pts.push({ text: `⚠ 告警复核：${rv.mismatch} 条两源数值不符，维持告警需人工深查`, kind: 'caution' });
    }
    if (d.recent && d.recent.length) {
      const r0 = d.recent[d.recent.length - 1];
      if (r0.issues && r0.issues.length) {
        // 留痕行带上复核状态：已销案的告警不再以"待复核"口吻呈现（避免读者重复劳动）
        const suffix = r0.reviewVerdict === 'verified' ? '——已复核销案（跨源互证通过）'
          : r0.reviewVerdict === 'mismatch' ? '——复核未通过（两源不符，维持告警）' : '';
        pts.push({ text: `最近留痕 ${r0.date}：${r0.issues.map((i) => i.reason).join('；')}${suffix}`, kind: 'evidence' });
      }
    }
  } else {
    pts.push({ text: '数据质量未评估', kind: 'unknown' });
    level = 'unknown';
  }
  if (S.health && S.health.summary) {
    // health.summary 自身可能已带「数据健康：」前缀（或"近 N 日数据健康：…"中缀）→ 去重，
    //   避免"数据健康：近 20 日数据健康：…"（实测踩过：只剥行首前缀剥不掉中缀）。
    const hs = String(S.health.summary).replace(/数据健康[：:]\s*/, '');
    pts.push({ text: `数据健康：${hs}`, kind: 'evidence' });
  }
  const xc = S.crosscheck;
  if (xc && xc.verdict) {
    pts.push({ text: `跨源互证：${xc.verdict.label || xc.verdict.level}`, kind: 'evidence' });
  } else {
    pts.push({ text: '跨源互证：未进行（缺失不等于一致）', kind: 'unknown' });
    if (level === 'ok') level = 'unknown';
  }
  const meta = S.meta || {};
  if (meta.stale) { pts.push({ text: `⚠ 数据过期：${meta.staleReason || '未说明'}`, kind: 'caution' }); level = 'warn'; }
  if (meta.freshness && meta.freshness.state && meta.freshness.state !== 'fresh') {
    pts.push({ text: `新鲜度状态：${meta.freshness.state}`, kind: 'caution' });
  }
  return { id: 'quality', title: '七、数据质量与告警', level, missing: false, points: pts };
}

// ── 节 8：舆情参考（LLM 试点）─────────────────────────────────────────────
//   刻意做成「参考」节而非信号节：±5 修正不进交易链路（原分不动），
//   未生成时 missing=true（与其他节同款显式缺失，不冒充"舆情中性"）。
function buildLlmSection(llm) {
  if (!llm) {
    return {
      id: 'llm', title: '八、舆情参考（LLM 试点）', level: 'unknown', missing: true,
      // 字段名与其余六节统一为 missingReason——前端 renderDailyReport 读的就是它
      //   （读 missingNote 会显示"原因未知"，字段名对不上=前端与后端不同步的隐性形态）。
      missingReason: '未生成（需收盘后跑 scripts/fetch_llm_sentiment.mjs；未跑 ≠ 舆情中性）',
    };
  }
  const pts = [];
  // 主读数：原始分 → 参考分（生效时）；不生效时只给原分与原因
  if (llm.effective) {
    pts.push({ text: `参考修正分：${llm.original} → ${llm.modified}（${llm.adj > 0 ? '+' : ''}${llm.adj}，±5 分上限内）`, kind: 'evidence' });
  } else {
    pts.push({ text: `参考修正分：不生效（${llm.effectNote}）`, kind: 'info' });
  }
  if (llm.sentimentRaw != null) {
    pts.push({ text: `LLM 舆情读数：${llm.sentimentRaw}（-1~1）${llm.confidence != null ? `，置信度 ${llm.confidence}` : ''}`, kind: 'evidence' });
  }
  if (llm.reason) pts.push({ text: `依据：${llm.reason}`, kind: 'evidence' });
  if (Array.isArray(llm.events) && llm.events.length) {
    pts.push({ text: `事件抽取：${llm.events.map((e) => `${e.type || '?'}（${e.target || '整体'}，${e.tone || '?'}）`).join('；')}`, kind: 'evidence' });
  }
  pts.push({ text: `证据日期 ${llm.asOfDate}｜模型 ${llm.model || '未留痕'}`, kind: 'info' });
  pts.push({ text: '口径：原分不动、仅参考；不独立生成买卖信号，观望区/反向一律不生效（P2 试点）', kind: 'info' });
  // level：生效且方向向下 → warn（提示风险）；其余 info（试点信息位，不上告警色）
  const level = llm.effective && llm.direction === 'bearish' ? 'warn' : 'info';
  return { id: 'llm', title: '八、舆情参考（LLM 试点）', level, missing: false, points: pts };
}

// ── 首屏一句话结论 ────────────────────────────────────────────────────────
function buildHeadline(reg, div, date, missingCount) {
  const d = date ? `${date} ` : '';
  if (reg.key === 'unknown') return `${d}数据不足，无法给出市场状态判断。`;
  // V5.3 简报格式：【市场状态判定】状态｜推荐仓位区间，情绪得分在第二节展开
  const pos = positionLine(reg.key);
  let s = `${d}市场状态：${reg.label}${pos ? `｜推荐仓位区间 ${pos.range}` : ''}`;
  if (pos && pos.force) s += '（强制降仓）';
  if (reg.confidence === 'low') s += '（判据不全，仅供参考）';
  if (div.diverged) s += `；${div.label}`;
  if (missingCount > 0) s += `（${missingCount} 个区块缺数据）`;
  return s;
}
