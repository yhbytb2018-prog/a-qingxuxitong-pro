// 不复权 K 线 → 涨停/炸板/跌停/涨跌家数 重建（历史六因子回填的唯一判定实现）
//
// ── 为什么独立成模块（规则唯一出处纪律）────────────────────────────────────────
// 判定规则被三处消费：scripts/backfill_factors.mjs（回填）、--validate（对 33 个真实日
// 与 EM 池真值交叉验证）、test/zt_rebuild.test.mjs（合成 K 线锁规则）。若各自实现，
// 「什么是涨停」会在三处漂移出三个版本。
//
// ── 口径 ──────────────────────────────────────────────────────────────────────
// · 交易所规则：涨停价 = round(前收 × (1+幅度), 2)，收盘价与涨停价**精确相等**（不复权价）。
//   只有用不复权价才能逐位对齐交易所规则——qfq 前复权会把除权前的历史缩放，
//   33 日交叉验证实测系统性多计（低价股 9.9% 收盘落进容差），故此处不接受任何容差。
// · 涨跌幅幅度：北交所 30%；创业板(30xxxx)/科创板(68xxxx) 20%；主板 ST 5%；主板 10%。
// · 炸板 = 盘中最高价触及涨停价但收盘未封住（与东财 getTopicZBPool 同口径）。
// · 上市初期无涨跌幅限制（主板注册制/创业科创前 5 日）→ 前 5 根 K 线不判定（保守跳过）。
// · 连板数(lbc) = 向前逐日回溯「收盘涨停」的连续天数（含当日），与东财池 lbc 同口径。
// · 涨跌家数（breadth）只数沪深（口径与 EM f104/f105 一致：沪深两市合计，不含北交所）。
//
// 已知残差（如实保留，验证脚本量化）：
// · 除权除息日：涨停价基准是除权参考价而非昨日收盘 → 该日涨停的除权股会被漏判（每日约 0~3 只）。
// · ST 历史状态：名称取当前分片名，期间摘帽/戴帽的个股幅度判定会错（量级见验证报告）。
// · 板块构成：行业广度按当前同花顺 881xxx 板块清单回溯，期间新增/更名板块不在其中。
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const round2 = (v) => Math.round(v * 100) / 100;
const num = (v) => (v == null || v === '' ? null : +v);

/** 涨跌幅幅度判定（唯一出处）。code 形如 sh600000/sz300750/bj920002。 */
export function limitPctOf(code, name) {
  if (code.startsWith('bj')) return 0.30;
  if (code.startsWith('sz30') || code.startsWith('sh68')) return 0.20;
  return /ST/i.test(String(name || '')) ? 0.05 : 0.10;
}

/**
 * 单日分类。bars 为 [date, open, close, high, low, vol] 数组（不复权，数值或数字字符串）。
 * @returns {{zt:boolean, zb:boolean, dt:boolean}|null} null = 不判定（上市初期/数据缺失）
 */
export function classifyBar(bars, i, code, name) {
  if (i < 5) return null; // 上市初期无涨跌幅限制（保守跳过前 5 根）
  const close = num(bars[i][2]), high = num(bars[i][3]), prev = num(bars[i - 1][2]);
  if (close == null || high == null || prev == null || prev <= 0) return null;
  const pct = limitPctOf(code, name);
  const up = round2(prev * (1 + pct)), dn = round2(prev * (1 - pct));
  return {
    zt: Math.abs(close - up) < 1e-6,
    zb: Math.abs(high - up) < 1e-6 && Math.abs(close - up) >= 1e-6,
    dt: Math.abs(close - dn) < 1e-6,
  };
}

/** 连板数：向前回溯连续收盘涨停（含当日）。 */
export function consecutiveZt(bars, i, code, name) {
  let lbc = 0;
  for (let k = i; k >= 5; k--) {
    const c = classifyBar(bars, k, code, name);
    if (!c || !c.zt) break;
    lbc++;
  }
  return lbc;
}

/**
 * 全市场重建：扫描 data/bt_kline 分片，产出目标日期的池与涨跌家数。
 * @param {string}   dir   data/bt_kline 目录
 * @param {Set<string>} dates 目标交易日（YYYY-MM-DD）
 * @returns {Map<string, {zt:[{code,lbc}], zb:string[], dt:string[], up:number, down:number, flat:number}>}
 *          up/down/flat 只数沪深（EM f104/f105 同口径）。
 */
export function rebuildPoolsByDate(dir, dates) {
  const res = new Map();
  for (const d of dates) {
    res.set(d, { zt: [], zb: [], dt: [], up: 0, down: 0, flat: 0 });
  }
  if (!dates.size) return res;

  for (const f of readdirSync(dir).filter((x) => /^[a-z]{2}\d{6}\.json$/.test(x))) {
    let j;
    try { j = JSON.parse(readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    const code = j.c, name = j.n || '';
    const bars = j.bars || [];
    if (!bars.length) continue;
    const isHS = !code.startsWith('bj'); // 涨跌家数口径：仅沪深
    for (let i = 1; i < bars.length; i++) {
      const d = bars[i][0];
      if (!dates.has(d)) continue;
      const close = num(bars[i][2]), prev = num(bars[i - 1][2]);
      if (close != null && prev != null && isHS) {
        const r = res.get(d);
        if (close > prev) r.up++;
        else if (close < prev) r.down++;
        else r.flat++;
      }
      const c = classifyBar(bars, i, code, name);
      if (!c) continue;
      const r = res.get(d);
      if (c.zt) r.zt.push({ code: code.slice(2), lbc: consecutiveZt(bars, i, code, name) });
      else if (c.zb) r.zb.push(code.slice(2));
      if (c.dt) r.dt.push(code.slice(2));
    }
  }
  return res;
}

/** 池重建结果 → 与东财池同形态的 pools 对象（buildDay 消费形态）。 */
export function poolsOf(r) {
  if (!r) return null;
  return {
    zt: r.zt.length, zb: r.zb.length, dt: r.dt.length,
    max_lb: r.zt.length ? Math.max(...r.zt.map((x) => x.lbc)) : 0,
    lb2: r.zt.filter((x) => x.lbc >= 2).length,
    zt_codes: r.zt.map((x) => x.code),
    zt_lb: Object.fromEntries(r.zt.map((x) => [x.code, x.lbc])),
  };
}

/**
 * 行业年线缓存 → 目标日期的行业涨跌行（与 fetchBoards 日常输出同形态，供回填 industry 数组）。
 * @param {Array}  cache scripts/fetch_industry_history.mjs 产物 [{code, name, bars: [[YYYYMMDD, close]]}]
 * @param {Set<string>} dates 目标交易日 YYYY-MM-DD
 * @returns {Map<string, {rows: [{name, change_pct}], ind_up: number, ind_down: number}>}
 *   rows 按 change_pct 降序（与 fetchBoards 一致，top/bottom_industry 直接可取）。
 *   前收 = 该板块自身序列的前一个交易日收盘（与 fetchBoards 同判据）。
 */
export function industryRowsFromCache(cache, dates) {
  const ymdOf = (d) => d.replace(/-/g, '');
  const targets = new Set([...dates].map(ymdOf));
  const dateByYmd = new Map([...dates].map((d) => [ymdOf(d), d]));
  const res = new Map();
  for (const d of dates) res.set(d, { rows: [], ind_up: 0, ind_down: 0 });
  for (const b of cache || []) {
    const bars = (b.bars || []).slice().sort((x, y) => (x[0] < y[0] ? -1 : 1));
    for (let i = 1; i < bars.length; i++) {
      const ymd = bars[i][0];
      if (!targets.has(ymd)) continue;
      const date = dateByYmd.get(ymd);
      const pre = +bars[i - 1][1], close = +bars[i][1];
      if (!pre || !Number.isFinite(close)) continue;
      const change_pct = Math.round((close / pre - 1) * 10000) / 100;
      const r = res.get(date);
      if (!r) continue;
      r.rows.push({ name: b.name, change_pct });
      if (change_pct > 0) r.ind_up++;
      else if (change_pct < 0) r.ind_down++;
    }
  }
  for (const r of res.values()) r.rows.sort((a, b) => b.change_pct - a.change_pct);
  return res;
}
