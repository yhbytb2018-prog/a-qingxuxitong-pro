#!/usr/bin/env node
// ── AI 报告 Markdown 导出（data/reports/*.json → 同名 .md）────────────────
//
// 用途：把 build_ai_report.mjs 产出的报告 JSON 渲染成 GitHub 直接可读的
//   Markdown，随 data/reports/ 一起提交（见 daily.yml 三个 git add 点）。
//
// 用法：
//   node scripts/export_reports_md.mjs            # 转换全部报告（跳过 index/push_state）
//   node scripts/export_reports_md.mjs --dry      # 只打印将写出的文件，不落盘
//
// 纪律：只读 data/reports/、只写 data/reports/；不做任何数值计算——
//   缺失 null 一律渲染为 —（与 push_text.js 渲染纪律一致），不补 0。
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'data', 'reports');
const DRY = process.argv.includes('--dry');

const dash = (v) => (v == null || v === '' ? '—' : v);
const pct = (v, digits = 2) => (v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(digits)}%`);
const num = (v, digits = 4) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(digits));
const fmtPct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);

const TYPE_LABEL = {
  pre_market: '盘前AI报告',
  intraday: '盘中AI报告',
  post_market: '盘后AI报告',
  weekly: '周度AI报告',
};
// 导出的 .md 用中文文件名（GitHub 直接可读）；JSON 原档文件名不变。
const mdName = (rep) => `${TYPE_LABEL[rep.report_type] ?? 'AI报告'}_${rep.date ?? '未知日期'}.md`;
const STATUS_LABEL = { ok: '✅ 完整', degraded: '⚠️ 降级', missing: '❌ 缺失' };

function table(rows) {
  if (!rows.length) return null;
  const head = `| ${rows[0].map((c) => dash(c)).join(' | ')} |`;
  const sep = `| ${rows[0].map(() => '---').join(' | ')} |`;
  return [head, sep, ...rows.slice(1).map((r) => `| ${r.map((c) => dash(c)).join(' | ')} |`)].join('\n');
}

function renderOverseas(list) {
  const rows = (list || []).map((q) => [q?.name ?? q?.key, pct(q?.chgPct), q?.state]);
  return table([['品种', '涨跌幅', '状态'], ...rows]);
}

function renderPayload(type, p) {
  if (!p) return '';
  const out = [];
  const add = (h, body) => { if (body) out.push(`### ${h}\n\n${body}\n`); };

  add('双轨账本', table([
    ['指标', '数值'],
    ['当日收益', pct(p.pnl_daily)],
    ['累计收益', pct(p.pnl_cumulative)],
    ['当日最大回撤', p.max_drawdown_daily == null ? '—' : pct(-p.max_drawdown_daily)],
    ['前一日净值', num(p.prev_nav, 4)],
    ['换向命中', dash(p.trend_switch_hits)],
    ['成本率', p.cost_ratio == null ? '—（归档轨无成交明细）' : pct(p.cost_ratio)],
    ['平均滑点', pct(p.slippage_avg)],
    ['滑点口径', p.slippage_source === 'assumed_constant' ? '假设常量（归档轨）' : dash(p.slippage_source)],
  ]));

  add('情绪周期 / 仓位', p.regime || p.positions ? [
    p.regime ? `- 市场状态：**${dash(p.regime.label)}**（${dash(p.regime.key)}），建议仓位 ${dash(p.regime.position_range)}` : null,
    p.positions ? [
      '- 目标仓位：' + Object.entries(p.positions.targetPos || {}).map(([k, v]) => `${k} ${fmtPct(v)}`).join(' / '),
      p.positions.poolPos != null ? `- 推荐池上限：${fmtPct(p.positions.poolPos)}` : null,
    ].filter(Boolean).join('\n') : null,
  ].filter(Boolean).join('\n') : null);

  add('隔夜环境', p.overnight_exposure ? [
    p.overnight_exposure.us_close ? `- 美股：道指 ${pct(p.overnight_exposure.us_close.dji)} / 标普 ${pct(p.overnight_exposure.us_close.spx)} / 纳指 ${pct(p.overnight_exposure.us_close.ixic)}` : null,
    p.overnight_exposure.cn_overnight ? `- 中国资产隔夜：HXC ${pct(p.overnight_exposure.cn_overnight.hxc)} / FXI ${pct(p.overnight_exposure.cn_overnight.fxi)}` : null,
    p.overnight_exposure.cnh_chgPct != null ? `- 离岸人民币：${pct(p.overnight_exposure.cnh_chgPct)}` : null,
    p.overnight_exposure.a50_chgPct != null ? `- A50 期货：${pct(p.overnight_exposure.a50_chgPct)}` : null,
  ].filter(Boolean).join('\n') : null);

  const ov = renderOverseas(p.overseas);
  if (ov) add('外围行情', ov);

  const sim = p.simulation_stock;
  if (sim?.sentiment_cycle) {
    const sc = sim.sentiment_cycle;
    add('模拟选股 · 情绪周期', [
      `- 周期相位：**${dash(sc.phase_label ?? sc.phase)}**（${dash(sc.regime_raw)}）`,
      `- 涨停 ${dash(sc.limit_up_count)} 家 · 最高连板 ${dash(sc.highest_chain)} 板 · 炸板率 ${pct(sc.broken_limit_ratio)}`,
      sc.yesterday_chain_performance != null ? `- 昨连板今日平均表现：${pct(sc.yesterday_chain_performance)}` : null,
      ...(sc.warning_signals || []).map((w) => `- ⚠️ ${w}`),
    ].filter(Boolean).join('\n'));
  }
  if (sim?.pick) {
    const pk = sim.pick;
    add('模拟选股 · 候选', [
      `- 推荐标的：**${dash(pk.name ?? pk.code)}**`,
      pk.reason ? `- 入选理由：${dash(pk.reason)}` : null,
    ].filter(Boolean).join('\n'));
  }

  if (p.circuit_breaker) {
    const cb = p.circuit_breaker;
    add('风控 / 熔断', table([
      ['项目', '状态'],
      ['回撤档位', dash(cb.dd_tier)],
      ['硬止损触发', cb.hard_stop_triggered == null ? '—' : (cb.hard_stop_triggered ? '是' : '否')],
      ['风控事件数', dash(cb.risk_events)],
      ['备注', dash(cb.note)],
    ]));
  }

  if (Array.isArray(p.grid_triggers) && p.grid_triggers.length) {
    add('网格触发', table([['档位', '方向', '仓位'], ...p.grid_triggers.map((g) => [g.level ?? g.step, g.action ?? g.side, fmtPct(g.pos ?? g.position)])]));
  }
  if (Array.isArray(p.events_today) && p.events_today.length) {
    add('今日事件', p.events_today.map((e) => `- ${typeof e === 'string' ? e : JSON.stringify(e)}`).join('\n'));
  }
  return out.join('\n');
}

function render(rep) {
  const title = TYPE_LABEL[rep.report_type] ?? 'AI 报告';
  const lines = [];
  lines.push(`# ${title}（${dash(rep.date)}）`);
  lines.push('');
  lines.push([
    `**状态**：${STATUS_LABEL[rep.status] ?? dash(rep.status)}`,
    `**轨**：${dash(rep.track)}`,
    `**触发**：${dash(rep.trigger)}`,
    `**数据完整度**：${pct(rep.data_completeness, 0)}`,
    `**生成时间**：${dash(rep.generated_at)}`,
  ].join(' · '));
  lines.push('');

  const body = renderPayload(rep.report_type, rep.payload);
  if (body) lines.push(body);

  if (Array.isArray(rep.missing_notes) && rep.missing_notes.length) {
    lines.push(`### 缺失说明\n`);
    lines.push(rep.missing_notes.map((m) => {
      if (typeof m === 'string') return `- ${m}`;
      if (m && typeof m === 'object') {
        const ref = m.ref ? `（参考：${m.ref}）` : '';
        return `- **${dash(m.field)}**：${dash(m.reason)}${ref}`;
      }
      return `- ${JSON.stringify(m)}`;
    }).join('\n'));
    lines.push('');
  }
  if (rep.disclaimer) {
    lines.push(`---\n\n> ${rep.disclaimer}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ── 主流程 ──────────────────────────────────────────────────────────────
if (!existsSync(DIR)) {
  console.log('data/reports/ 不存在，无报告可转换');
  process.exit(0);
}
const SKIP = new Set(['index.json', 'push_state.json']);
let n = 0;
for (const f of readdirSync(DIR).sort()) {
  if (extname(f) !== '.json' || SKIP.has(f)) continue;
  const src = join(DIR, f);
  let rep;
  try {
    rep = JSON.parse(readFileSync(src, 'utf8'));
  } catch {
    console.error(`跳过（非合法 JSON）：${f}`);
    continue;
  }
  if (!rep || typeof rep !== 'object' || !rep.report_type) continue; // 非报告档
  const out = join(DIR, mdName(rep));
  if (DRY) {
    console.log(`[dry] ${out}`);
  } else {
    writeFileSync(out, render(rep), 'utf8');
    console.log(`写出 ${out}`);
  }
  n++;
}
console.log(`共 ${n} 份报告${DRY ? '（dry 预览，未落盘）' : '已转换为 Markdown'}`);
