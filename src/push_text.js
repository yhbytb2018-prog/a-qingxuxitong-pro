// ── 推送文本渲染 · 纯函数层（零 Node 依赖，2026-10-07 抽取）────────────────
//
// 从 src/ai_report_push.js 抽出：PUSH_CONSTS + renderPushText + 行内格式助手。
//   动机：Cloudflare Worker 推送代理（决议 2 的「复制 → 云端推送」）与页面
//   即时轨都要渲染推送文案，而 ai_report_push.js import 了 node:fs/crypto/path
//   ——静态依赖会整棵进 bundle。本模块**零 import**，Node/Worker/浏览器三端
//   通用；Node 侧由 ai_report_push.js re-export，既有 import 路径零改动。
//
// 渲染纪律：缺失用 — 而非 0（与报告 null 纪律一致）；四类各一版 + 通用尾注。
export const PUSH_CONSTS = {
  STATE_TTL_MS: 30 * 86400 * 1000, // 指纹记忆 30 天（对齐 scripts/alert_channel.mjs SEEN_TTL）
  STATE_CAP: 400,                  // 状态文件条目上限（防无限增长）
  MSG_CAP: 2000,                   // 企微 text ~2048 字节，留余量
  FRESH_WINDOW_MS: 15 * 60 * 1000, // --latest 新鲜度窗口：只推"本次运行刚生成"的报告
  WEBHOOK_ENV: 'OPS_WEBHOOK',      // 复用现有运维通道 secret
  // 盘前"数据截至"附注阈值（自然日）：gap>3 才附"假期无更新"。周末 gap=3 不附——
  // 每周一都带"假期"字样是周性噪音，且"数据截至 X 收盘"基础行已消歧（2026-10-07
  // 用户提议 >1 天附注，按噪音权衡定 3，一行可改；调 1 即恢复用户原提议）。
  STALE_NOTE_GAP_DAYS: 3,
};

const pct = (v, digits = 2) => (v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(digits)}%`);
const txt = (v) => (v == null ? '—' : String(v));
const overseas = (p, key) => pct((p.overseas || []).find((q) => q && q.key === key)?.chgPct);
const simLine = (p) => {
  const sim = p.simulation_stock;
  if (!sim?.sentiment_cycle) return null;
  const sc = sim.sentiment_cycle;
  const phase = sc.phase_label ?? sc.phase;
  return `情绪周期: ${phase}(${sc.regime_raw ?? '—'}) · 建议仓位: ${sim.position_suggestion ?? '—'} · 候选池 ${sim.candidate_pool?.length ?? 0} 只`;
};

/**
 * 报告 → 企微 text 消息（简版；完整 JSON/页面视图不进推送）。
 * 四类各自的行集 + 通用尾注（缺失披露数与数据状态）。
 */
export function renderPushText(report) {
  const p = report?.payload || {};
  const lines = [];
  switch (report?.report_type) {
    case 'pre_market':
      lines.push(`【AI 报告 · 盘前】${report.date}`);
      { // 数据截至标注（2026-10-07 拍板）：盘前报告恒为**前一交易日收盘口径**，
        // 头部日期即数据日期，但读者易误读为"生成当日"。恒加一行点破；间隔超
        // 3 个自然日（节后首日/小长假）再附"假期无更新"——A 股休市期间情绪面
        // 数据本来就不产生，不是漏抓。间隔按自然日近似（UTC 日界，仅作标注用）。
        const dataDay = Date.parse(`${report.date}T00:00:00Z`);
        const genDay = Date.parse(report.generated_at);
        const gap = Number.isFinite(dataDay) && Number.isFinite(genDay)
          ? Math.floor((genDay - dataDay) / 86400000) : null;
        lines.push(`数据截至 ${txt(report.date)} 收盘${gap != null && gap > PUSH_CONSTS.STALE_NOTE_GAP_DAYS ? `（距生成 ${gap} 天，假期无更新）` : ''}`);
      }
      { const s = simLine(p); if (s) lines.push(s); }
      lines.push(`前日盈亏 ${pct(p.pnl_daily)} · 累计 ${pct(p.pnl_cumulative)} · 前日净值 ${p.prev_nav != null ? p.prev_nav.toFixed(4) : '—'}`);
      lines.push(`隔夜: A50 ${overseas(p, 'a50')} · 费半 ${overseas(p, 'sox')} · 净敞口分歧 ${txt(p.overnight_exposure?.posGap)}`);
      { // S3-5 外围收盘全景（overnight_exposure 扩展段，聚合一行不逐条罗列）：
        // 任一在场才推（数据源挂/老档无此段 → 整行省略，不留一排 — 的噪音行）。
        const oe = p.overnight_exposure || {};
        const us = oe.us_close || {}, cn = oe.cn_overnight || {};
        if ([us.dji, us.spx, us.ixic, cn.hxc, cn.fxi, oe.cnh_chgPct].some((v) => v != null)) {
          lines.push(`外围收盘: 道 ${pct(us.dji)} · 标普 ${pct(us.spx)} · 纳指 ${pct(us.ixic)}`
            + ` · 金龙 ${pct(cn.hxc)} · FXI ${pct(cn.fxi)} · 离岸人民币 ${pct(oe.cnh_chgPct)}`);
        }
      }
      lines.push(`最高连板 ${txt(p.simulation_stock?.sentiment_cycle?.highest_chain)} · 炸板率 ${pct(p.simulation_stock?.sentiment_cycle?.broken_limit_ratio)}`);
      break;
    case 'intraday':
      lines.push(`【AI 报告 · 盘中】${report.date}${report.trigger !== 'schedule' ? ` · ${report.trigger}` : ''}`);
      { const s = simLine(p); if (s) lines.push(s); }
      lines.push(`运行回撤 ${pct(p.drawdown_vs_threshold?.dd_now)} · 距 DD 档位 ${p.drawdown_vs_threshold?.distance_pp != null ? `${p.drawdown_vs_threshold.distance_pp}pp` : '—'}（${p.drawdown_vs_threshold?.basis ?? '—'}）`);
      lines.push(`昨收口径: 当日 ${pct(p.pnl_daily)} · 累计 ${pct(p.pnl_cumulative)} · A50 ${overseas(p, 'a50')}`);
      { const hot = (p.simulation_stock?.candidate_pool || []).filter((c) => c.intraday_chg != null)
          .slice(0, 3).map((c) => `${c.name ?? c.code} ${pct(c.intraday_chg)}`).join(' · ');
        if (hot) lines.push(`候选池盘中(强势榜在列): ${hot}`); }
      break;
    case 'post_market':
      lines.push(`【AI 报告 · 盘后】${report.date}`);
      lines.push(`当日盈亏 ${pct(p.pnl_daily)} · 累计 ${pct(p.pnl_cumulative)} · 收盘回撤 ${pct(p.close_drawdown)}`);
      if (p.market_context) lines.push(`市场: 涨跌 ${txt(p.market_context.up_down)} · 涨停/跌停 ${txt(p.market_context.zt_dt)} · 亏钱效应 ${txt(p.market_context.pain)}`);
      if (p.backtest_deviation) lines.push(`vs 回测 v52: delta ${pct(p.backtest_deviation.delta)}`);
      { const s = simLine(p); if (s) lines.push(s); }
      break;
    case 'weekly':
      lines.push(`【AI 报告 · 周报】截至 ${report.date}`);
      lines.push(`周收益 ${pct(p.week_return)} · 周最大回撤 ${pct(p.max_drawdown_week)} · 盈利日占比 ${pct(p.profit_trade_ratio)}`);
      lines.push(`趋势切换 ${txt(p.trend_switch_hits)} 次 · 胜率 ${p.win_rate != null ? pct(p.win_rate) : '—（剧本口径，绑定缺席则 null）'}`);
      if (p.trend_switch_effect?.shadow_note) lines.push(p.trend_switch_effect.shadow_note);
      break;
    default:
      lines.push(`【AI 报告 · ${txt(report?.report_type)}】${txt(report?.date)}`);
  }
  // MA20 降级红警（2026-10-08 推送前校验 ①）：量能因子走中性 50 → 推送里显式
  //   标红，一眼识别「降级版」（当日成交额缺或量能历史不足；判据唯一出处
  //   ai_report.js envelope 的 ma20_degraded）。企微 text 消息不支持
  //   markdown <font color>，用 🔴 emoji 替代；文案短促不挤占 MSG_CAP。
  if (p.ma20_degraded) lines.push('🔴 MA20 降级版：量能因子按中性 50 计（当日成交额缺或量能历史不足）');
  const degraded = report?.status && report.status !== 'ok' ? ` · 数据状态 ${report.status}` : '';
  lines.push(`缺失披露 ${report?.missing_notes?.length ?? 0} 项${degraded}（完整版见页面 · 不构成投资建议）`);
  let text = lines.join('\n');
  if (text.length > PUSH_CONSTS.MSG_CAP) text = `${text.slice(0, PUSH_CONSTS.MSG_CAP - 20)}\n…（超长截断）`;
  return text;
}
