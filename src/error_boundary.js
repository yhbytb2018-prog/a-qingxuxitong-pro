// 前端错误边界 + 数据新鲜度横幅：让"页面出问题"变成一句可读的话，而不是白屏。
//
// ── 为什么单独一个模块（而不是散在 app.js 里几个 try/catch）────────────────────
// 本项目最忌讳的是"用失败伪装平静"：加载失败时如果什么都不显示，读者看到的空白
// 会被理解成"今天没什么可说的"。反过来，一有失败就整页中断，读者又拿不到任何
// 已有数据。两者都错。故需要一套**分级**策略：
//
//   fatal    首屏必需的档（archive-index）拿不到 → 无法渲染任何结论
//            → 显示全页错误卡，明确说"没数据 ≠ 数据正常"，并给出重试与自查步骤
//   degraded 非必需档（回测 / 外围 / signals-latest / 版本对比）拿不到
//            → **保留其它区块**，只把对应卡片标成"未加载"，整页不中断
//   stale    档拿到了，但按交易日历判定已滞后（freshness.state === 'behind'）
//            → 数据能用但过期，必须挂一条常驻横幅，明确"这是哪一天的数据"
//
// 三者互斥且优先级 fatal > stale > degraded（陈旧比缺一块更要紧：它不会自己好）。
//
// ── 纯函数 ────────────────────────────────────────────────────────────────────
// 不碰 DOM、不看时钟（nowFrame 由调用方传入），故可在 Node 侧用固定时刻单测。
// 时钟是最容易写出"今天过、明天挂"的测试的东西，一律外部注入。

/** 分级常量（唯一出处，前端与守卫都读它）。 */
export const LEVEL = Object.freeze({
  OK: 'ok',
  DEGRADED: 'degraded',
  STALE: 'stale',
  FATAL: 'fatal',
  UNKNOWN: 'unknown',
});

export const LEVEL_LABEL = Object.freeze({
  ok: '正常',
  degraded: '部分降级',
  stale: '数据陈旧',
  fatal: '加载失败',
  unknown: '未评估',
});

/** 各档的严重度排序（数字越大越严重），用于取最严重的一档。 */
const SEVERITY = Object.freeze({ ok: 0, unknown: 1, degraded: 2, stale: 3, fatal: 4 });

/** 该档位是否必须挂在顶部常驻横幅（而不是缩在卡片里）。 */
export function needsBanner(level) {
  return level === LEVEL.FATAL || level === LEVEL.STALE;
}

/**
 * 判定一次加载失败属于哪一级。
 *
 * 关键规则：只有**首屏必需档**失败才是 fatal；其余一律 degraded。
 * 这条规则如果写反（把所有失败都当 fatal），一次外围行情源抖动就会让整页白屏——
 * 而那正是用户投诉里最常见的场景。
 */
export const REQUIRED_ON_BOOT = Object.freeze(['archive-index']);

export function classifyLoadError(what, err) {
  const key = String(what || '');
  const msg = (err && err.message) ? String(err.message) : String(err || '未知错误');
  const required = REQUIRED_ON_BOOT.includes(key);
  return {
    level: required ? LEVEL.FATAL : LEVEL.DEGRADED,
    what: key,
    message: msg,
    required,
    // 给用户的自查路径要**具体**（"请重试"不是指引，是敷衍）
    hint: required
      ? '首屏档案（archive-index.json）是唯一必需档：请确认它已生成并部署（重跑 node scripts/split_archive.mjs），或点击「↻ 刷新」重试。'
      : '该区块依赖独立数据文件，缺失只影响本卡，其它区块照常可用。',
  };
}

/**
 * 汇总多次加载结果，得到页面级档位。
 * @param {{what:string, ok:boolean, error?:Error, required?:boolean}[]} results
 */
export function classifyLoadResults(results) {
  const list = Array.isArray(results) ? results : [];
  const failed = list.filter((r) => r && r.ok === false);
  if (!failed.length) return { level: LEVEL.OK, failed: [], items: [] };
  const items = failed.map((r) => classifyLoadError(r.what, r.error));
  const worst = items.reduce((a, b) =>
    (SEVERITY[b.level] > SEVERITY[a.level] ? b : a), items[0]);
  return { level: worst.level, failed: failed.map((r) => r.what), items };
}

/**
 * 挂起 clock：SW 离线回退时，页面时间戳会停在"离线那一刻"，与真实时间脱节。
 * 若不用它校正，"更新时间 14:32"这句话在 3 小时后仍显示 14:32，读者无从察觉。
 */
export function nowFrame(now = new Date(), opts = {}) {
  const t = now instanceof Date ? now : new Date(now);
  const valid = !Number.isNaN(t.getTime());
  return {
    iso: valid ? t.toISOString() : null,
    // 本地展示串（YYYY-MM-DD HH:MM）。刻意用本地时区——读者对齐的是自己手表。
    local: valid ? t.toISOString().replace('T', ' ').slice(0, 16) : null,
    offline: !!opts.offline,
    offlineSince: opts.offlineSince || null,
  };
}

/**
 * 生成顶部横幅模型。
 * @param {object} meta 存档 meta（读 tradeDate / stale / staleReason / freshness / phase / phaseNote）
 * @param {object|null} health signals-latest.health（读 level / items）
 * @param {object} frame nowFrame() 的结果
 * @param {{level?:string, failed?:string[], items?:object[]}} loadState classifyLoadResults 的结果
 * @returns {{show:boolean, level:string, chips:object[], lines:string[], actions:string[]}}
 *
 * ⚠ 未知态（meta 缺 tradeDate / 未加载）决不算 ok —— 本项目铁律：没检查 ≠ 没问题。
 */
export function staleBannerModel(meta = {}, health = null, frame = {}, loadState = {}) {
  const m = meta || {};
  const f = m.freshness || null;
  const ls = loadState || {};
  const lsLevel = ls.level || LEVEL.OK;

  // 1) 加载失败优先（fatal 直接占满横幅）
  if (lsLevel === LEVEL.FATAL) {
    const it = (ls.items || []).find((x) => x.level === LEVEL.FATAL) || {};
    return {
      show: true,
      level: LEVEL.FATAL,
      chips: [{ kind: 'fatal', text: '加载失败' }],
      lines: [
        it.message ? `无法加载必需数据：${it.message}` : '无法加载必需数据。',
        '页面**没有**可用结论 —— 空白不等于「今天没什么可说的」。',
        it.hint || '',
      ].filter(Boolean),
      actions: ['重试'],
    };
  }

  const chips = [];
  const lines = [];

  // 2) 陈旧（freshness.behind）
  const behind = f && Number.isFinite(+f.behindSessions) ? +f.behindSessions : 0;
  const isStale = !!m.stale || (f && f.state === 'behind');
  const unknownFresh = !m.tradeDate || !f;

  if (isStale) {
    chips.push({ kind: 'stale', text: '数据陈旧' });
    lines.push(m.staleReason || `存档落后 ${behind} 个交易日（最近已收盘交易日 ${f.latestClosed || '未知'}）。`);
    if (f && f.publishDeadline) {
      lines.push(`预期更新时刻 ${String(f.publishDeadline).replace('T', ' ').slice(0, 16)}（UTC）。`);
    }
  } else if (unknownFresh) {
    chips.push({ kind: 'unknown', text: '新鲜度未评估' });
    lines.push('没有新鲜度判定结果 —— 这是「没检查」，不等于「数据是最新的」。');
  } else if (f && f.state === 'pending') {
    // pending 是**正常等待**（数据还没到发布时间），不该报警，但要说清楚
    chips.push({ kind: 'pending', text: '等待更新' });
    lines.push('数据尚未到发布时间，属正常等待（非故障）。');
  } else if (f && f.state === 'fresh') {
    chips.push({ kind: 'fresh', text: '数据最新' });
  }

  // 3) 部分降级
  if (lsLevel === LEVEL.DEGRADED) {
    chips.push({ kind: 'degraded', text: '部分区块未加载' });
    lines.push(`未加载：${(ls.failed || []).join('、') || '未知区块'}（只影响对应卡片，其它区块照常可用）。`);
  }

  // 4) 相位提示（盘中/开盘前）——与新鲜度正交，必须同时出现
  if (m.phase && m.phase !== 'closed') {
    chips.push({ kind: 'phase-' + m.phase, text: m.phase === 'live' ? '盘中' : '开盘前' });
  }

  // 5) 离线（SW 回退）
  if (frame && frame.offline) {
    chips.push({ kind: 'offline', text: '离线' });
    lines.push(`当前处于离线状态，展示的是最近一次成功缓存的数据（缓存时刻 ${frame.offlineSince || '未知'}）。`
      + '行情不会自动更新，请勿据此下单。');
  }

  // 6) 健康面板的告警摘要（只在非正常时并入，避免与面板重复刷屏）
  if (health && health.level && health.level !== 'ok' && health.items) {
    const bad = health.items.filter((i) => i.level && i.level !== 'ok');
    if (bad.length) lines.push(`数据健康：${bad.map((i) => i.label).join('、')} 需关注（详见「数据健康」面板）。`);
  }

  // 展示条件：只有在"有话说"时才挂横幅。全 ok / fresh 时不占屏幕——
  // 常驻横幅会训练用户忽略它，真出事时反而看不见。
  const show = chips.some((c) => !/^(fresh)$/.test(c.kind)) || !!frame.offline;
  const level = isStale ? LEVEL.STALE
    : (lsLevel === LEVEL.DEGRADED ? LEVEL.DEGRADED
      : (unknownFresh ? LEVEL.UNKNOWN : LEVEL.OK));

  return {
    show,
    level,
    chips,
    lines: lines.filter(Boolean),
    actions: isStale ? ['刷新', '查看数据健康'] : ['刷新'],
  };
}

/**
 * window.onerror / unhandledrejection 的兜底文案模型。
 *
 * ⚠ 只负责"说什么"，不负责"怎么恢复"：真正的恢复动作（重载、降级渲染）由调用方
 *   决定——把决策塞进纯函数会让它无法单测"故障时页面在哪个状态"。
 */
export function runtimeErrorModel(err, frame = {}) {
  const msg = (err && err.message) ? String(err.message)
    : (typeof err === 'string' ? err : '未知运行期错误');
  const stack = (err && err.stack) ? String(err.stack).split('\n').slice(0, 4).join('\n') : '';
  return {
    title: '页面运行出错',
    level: LEVEL.DEGRADED, // 已渲染的内容仍在，不该整页清空
    message: msg,
    stack,
    frame,
    lines: [
      '页面已渲染的部分仍然可用；出错的是后续某一步渲染。',
      '若内容明显不完整，请点「↻ 刷新」重载数据。',
      '本条错误不改变任何已展示数值的口径。',
    ],
  };
}

/**
 * 把错误模型渲染成一段 HTML 字符串（纯字符串拼装，无 DOM 依赖 —— 便于单测，
 * 也让"渲染什么"这件事可被守卫断言）。
 */
export function renderBannerHtml(model, esc = (s) => String(s == null ? '' : s)) {
  const b = model || {};
  if (!b.show) return '';
  const chips = (b.chips || []).map((c) =>
    `<span class="ob-chip ${esc(c.kind)}">${esc(c.text)}</span>`).join('');
  const lines = (b.lines || []).map((l) => `<div class="ob-line">${esc(l)}</div>`).join('');
  return `<div class="ob-inner ob-${esc(b.level || 'unknown')}">`
    + `<div class="ob-head">${chips}</div>`
    + `<div class="ob-lines">${lines}</div>`
    + `<div class="ob-note">数据仅供参考，不构成投资建议。</div>`
    + `</div>`;
}

/**
 * 致命错误的整页替代内容。
 *
 * 存在的意义就是**不要白屏**：白屏是"看起来像没数据"的最坏形式——它连
 * "这儿本该有东西、只是加载失败"这层信息都没有。
 */
export function renderFatalHtml(info, esc = (s) => String(s == null ? '' : s)) {
  const i = info || {};
  return `<div class="fatal-card">`
    + `<div class="fc-title">⚠ 首屏数据加载失败</div>`
    + `<div class="fc-msg">${esc(i.message || '未知错误')}</div>`
    + `<div class="fc-hint">${esc(i.hint || '')}</div>`
    + `<div class="fc-note">页面**没有**显示任何结论 —— 这是「没有数据」，不是「今天没什么可说的」。`
    + `请不要把空白理解成任何行情含义。本系统所有内容仅供参考，不构成投资建议。</div>`
    + `<button class="mini primary" type="button" data-act="retry-boot">重试加载</button>`
    + `</div>`;
}
