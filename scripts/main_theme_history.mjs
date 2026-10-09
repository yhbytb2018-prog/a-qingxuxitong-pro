// 主线历史生成（2026-10-08）：遍历 ztpool_history.json，逐日输出主线题材 + 持续性 + 轮动。
//
// ── 回放语义（无未来泄漏）────────────────────────────────────────────────────
// 第 i 日的 prevState 只含 ≤ i-1 日信息（computeMainTheme 上一日返回的 state）；
// 持续性/轮动/prev_main_theme 均由该状态链派生。ztpool_history 自 2026-09-30 起
// 积累，首日 consecutive_days=1、rotation=false、prev_main_theme=null 属预期。
//
// 用法：
//   node scripts/main_theme_history.mjs   # 配合 scripts/daily_fetch.mjs 每日自动更新
import { readFileSync, writeFileSync } from 'node:fs';
import { computeMainTheme, MAIN_THEME_RULES } from '../src/main_theme.js';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const hist = JSON.parse(readFileSync(`${ROOT}data/ztpool_history.json`, 'utf8'));
if (!Array.isArray(hist) || !hist.length) {
  console.error('data/ztpool_history.json 为空：先跑 node scripts/daily_fetch.mjs 积累数据');
  process.exit(1);
}

let state = null;
const days = [];
for (const { date, pool } of hist) {
  const { result, state: nextState } = computeMainTheme(pool || [], state, String(date));
  days.push(result);
  state = nextState;
}

const dist = days.reduce((acc, d) => {
  for (const t of d.main_themes) acc[t.strength] = (acc[t.strength] || 0) + 1;
  return acc;
}, {});
const rotationDays = days.filter((d) => d.rotation);
const payload = {
  meta: {
    generatedAt: new Date().toISOString(),
    days: days.length,
    theme_days: Object.values(dist).reduce((a, b) => a + b, 0),
    strength_dist: dist,
    rotation_days: rotationDays.length,
    rules: `src/main_theme.js（板块≥${MAIN_THEME_RULES.min_zt_count}只且连板≥${MAIN_THEME_RULES.min_lb_count}家且板块均值fund>全市场均值；${MAIN_THEME_RULES.weak_max}/${MAIN_THEME_RULES.strong_max}分级；连续≥${MAIN_THEME_RULES.continuous_min_days}天为持续主线；环比降>${MAIN_THEME_RULES.rotation_drop_ratio * 100}%且新主线出现为轮动）`,
    caliber_note: 'hybk 为东财行业口径，同一概念炒作散在多个板块，本模块会低估概念级集中度；概念合并需外部映射表（后续扩展）。阈值常量 MAIN_THEME_RULES，ztpool_history 积累满月后按实际分布复核',
  },
  days,
};
writeFileSync(`${ROOT}data/main_theme_history.json`, JSON.stringify(payload, null, 1));
console.log(`主线历史 ${days.length} 天已写入 data/main_theme_history.json`);
console.log('强度分布:', JSON.stringify(dist), '轮动日:', rotationDays.length);
console.log('\n逐日明细:');
for (const d of days) {
  const themes = d.main_themes.map((t) =>
    `${t.name}(${t.zt_count}只/${t.strength}/${t.consecutive_days}天${t.is_continuous ? '·持续' : ''})`).join(' ');
  console.log(`  ${d.date}  ${themes || '（无主线）'}${d.rotation ? '  [轮动]' : ''}${d.prev_main_theme ? `  昨日主线:${d.prev_main_theme}` : ''}`);
}
