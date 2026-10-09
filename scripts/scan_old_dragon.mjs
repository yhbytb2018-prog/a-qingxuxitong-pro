// 老龙头逐日扫描（2026-10-08）：遍历 ztpool_history.json，输出每日首板反抽老龙头候选。
//
// ── 逐日回放语义（无未来泄漏）────────────────────────────────────────────────
// 第 i 日的判定只用 ≤ i-1 日的信息：
// · absenceDays：今日 pool 中各 code 距「最后一次出现在涨停池」的交易日索引差
//   （lastSeen 截至 i-1 日维护；无记录 → 条件②不满足，保守排除）
// · dragonPool：外部 data/dragon_pool.json（若存在，按 peak_date ≤ 当日过滤）；
//   否则 deriveDragonPool(hist.slice(0, i)) 从涨停池历史派生——peak_date 为首次
//   lbc≥5 之日、peak_height 为该波最大连板。当日新增龙头不可能是候选（lbc==1 矛盾）。
//
// 用法：
//   node scripts/scan_old_dragon.mjs   # 配合 scripts/emotion_history.mjs --fetch-latest 每日积累
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { identifyOldDragons, deriveDragonPool, OLD_DRAGON_RULES } from '../src/old_dragon.js';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const data = (f) => `${ROOT}data/${f}`;

// 1. 涨停池历史
const hist = JSON.parse(readFileSync(data('ztpool_history.json'), 'utf8'));
if (!Array.isArray(hist) || !hist.length) {
  console.error('data/ztpool_history.json 为空：先跑 node scripts/emotion_history.mjs --fetch-latest 积累数据');
  process.exit(1);
}

// 2. 龙头池来源：外部文件优先，否则从涨停池历史逐日派生
const hasExternal = existsSync(data('dragon_pool.json'));
let externalDragons = [];
if (hasExternal) {
  externalDragons = JSON.parse(readFileSync(data('dragon_pool.json'), 'utf8'));
  if (!Array.isArray(externalDragons)) externalDragons = [];
}
const dragonSource = hasExternal ? 'data/dragon_pool.json（外部）' : 'ztpool_history.json 派生（首次 lbc≥5，波内取最大连板）';

// 3. 逐日扫描
const lastSeen = new Map(); // code -> 最后出现的历史索引（截至昨日）
const days = [];
for (let i = 0; i < hist.length; i++) {
  const { date, pool } = hist[i];
  // 3a. absenceDays（截至昨日的 lastSeen）
  const absenceDays = {};
  for (const s of pool || []) {
    if (s && s.c != null && lastSeen.has(String(s.c))) absenceDays[String(s.c)] = i - lastSeen.get(String(s.c));
  }
  // 3b. 龙头池快照（截至昨日，无未来泄漏）
  const dragons = hasExternal
    ? externalDragons.filter((d) => d && String(d.peak_date) <= String(date))
    : deriveDragonPool(hist.slice(0, i));
  // 3c. 判定
  days.push(identifyOldDragons(pool || [], dragons, absenceDays, String(date)));
  // 3d. 更新 lastSeen（今日所有出现过的票）
  for (const s of pool || []) {
    if (s && s.c != null) lastSeen.set(String(s.c), i);
  }
}

// 4. 落盘 + 摘要
const totalCandidates = days.reduce((n, d) => n + d.old_dragons.length, 0);
const hitDays = days.filter((d) => d.old_dragons.length);
const payload = {
  meta: {
    generatedAt: new Date().toISOString(),
    days: days.length,
    candidate_days: hitDays.length,
    candidates_total: totalCandidates,
    dragon_source: dragonSource,
    rules: `src/old_dragon.js（历史≥${OLD_DRAGON_RULES.dragon_min_lbc}板 + 冷却≥${OLD_DRAGON_RULES.min_absence_days}交易日 + 首板lbc=1 + 硬板zbc=0 + fund>当日均值）`,
    caliber_note: 'ztpool_history 自 2026-09-30 起积累（接口历史不可回补），冷却期≥10日意味着首批候选最早出现在数据积累第 11 个交易日起；days_since_peak = 距最后出现在涨停池的交易日数',
  },
  days,
};
writeFileSync(data('old_dragon_history.json'), JSON.stringify(payload, null, 1));
console.log(`老龙头扫描 ${days.length} 天已写入 data/old_dragon_history.json`);
console.log(`龙头池来源: ${dragonSource}`);
console.log(`命中 ${hitDays.length} 天 / 候选 ${totalCandidates} 只`);
if (hitDays.length) {
  console.log('\n命中明细:');
  for (const d of hitDays) {
    for (const x of d.old_dragons) {
      console.log(`  ${d.date}  ${x.code} ${x.name}  第一波${x.first_wave_height}板 冷却${x.days_since_peak}日 fund=${Math.round(x.fund / 1e8 * 100) / 100}亿`);
    }
  }
} else {
  console.log('\n（暂无候选：数据积累不足 11 个交易日，或期间无满足五条件的首板反抽）');
}
