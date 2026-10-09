// sources.js — 多源实时抓取（移植自 sjc19950404/a-sentiment fetch-daily.js 已验证接口）
// 数据源:
//   1. 同花顺强势股 zx.10jqka.com.cn/event/api/getharden（兼交易日探测: data[0].date）
//   2. 同花顺强势股行情补全 qt.gtimg.cn（getharden 2026-09-28 起不再返回 close/zhangfu/huanshou）
//   3. 东财龙虎榜 datacenter-web.eastmoney.com RPT_DAILYBILLBOARD_DETAILSNEW
//   4. 同花顺行业 881xxx 日K（thshy 列表 + d.10jqka.com.cn/v6/line/48_CODE）
//   5. 腾讯指数 qt.gtimg.cn（三大指数涨跌幅）
//   6. 东财涨跌停/炸板池 push2ex.eastmoney.com getTopic{ZT,ZB,DT}Pool
//   7. 同花顺大盘日K zs_1A0001/zs_399001（两市成交额）
//   8. 东财全市场涨跌家数 push2.eastmoney.com ulist.np f104/f105/f106
// 情绪公式统一走 sentiment.js computeSentiment（唯一实现，勿在别处手搓公式）
// 输出 day 对象结构与快照一致: {trade_date,lhb,hot,topics,industry,indexes,summary,emotion,lhb_aggr}

import config from './config.js';
import { computeSentiment } from './sentiment.js';
import { normalizeRecord, summarizeCalibers, mergeDuplicateRecords } from './lhb.js';
import { isAggregateSeatRow } from './seats.js';
import { computeRelative } from './relative.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r2 = (v) => Math.round(v * 100) / 100;
const r1 = (v) => Math.round(v * 10) / 10;
// 缺失保持 null，绝不落成 0：0 是合法行情值（一字板换手可真为 0），
// 一旦把"没取到"写成 0，前端既看不出数据缺失，下游的 ?? 兜底也会失效（0 不是 null）。
const num2 = (v) => {
  // ⚠ 不能用 `!Number.isFinite(+v)` 单独判定：`+'' === 0`、`+[] === 0`、`+null === 0`
  //   都是"有限数"，会把空串/空数组/布尔当成真值 0 混进统计量。本项目已四次踩同一坑。
  //   故先拒类型与空值，再判有限性。
  if (v == null || v === '') return null;
  const t = typeof v;
  if (t !== 'number' && t !== 'string') return null;
  const n = +v;
  return Number.isFinite(n) ? r2(n) : null;
};

// 龙虎榜未公布 → 优雅跳过（不报错、不回退）
class LhbNotPublishedError extends Error {
  constructor(date) { super('龙虎榜未公布: ' + date); this.name = 'LhbNotPublishedError'; this.date = date; }
}

async function fetchText(url, opts = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' @ ' + url.slice(0, 80));
  return r;
}
async function fetchGBK(url, opts) {
  const buf = await (await fetchText(url, opts)).arrayBuffer();
  return new TextDecoder('gbk').decode(buf);
}
async function fetchJSON(url, opts) {
  return (await fetchText(url, opts)).json();
}

// 源1: 同花顺强势股（兼交易日探测）
async function fetchHot() {
  let lastErr;
  for (let att = 0; att < 3; att++) {
    try {
      const j = await fetchJSON('https://zx.10jqka.com.cn/event/api/getharden', {
        headers: { Referer: 'https://zx.10jqka.com.cn/' },
      });
      if (j.errocode === 0 && Array.isArray(j.data) && j.data.length) return j.data;
      lastErr = new Error('getharden 返回异常 errocode=' + j.errocode);
    } catch (e) { lastErr = e; }
    await sleep(800);
  }
  throw new Error('getharden 强势股接口连续失败: ' + lastErr.message);
}

// 腾讯行情代码前缀。历史上只判 sh/sz，把北交所（9/8/4 段）整段丢掉 —— 榜单里一旦出现北交所标的，
// 它就拿不到任何行情字段（close/涨跌幅/换手），前端只能显示成 0。
// 各段位均已实测：沪市 6xxxxx(A)/900xxx(B) → sh；深市 0xxxxx・3xxxxx(A)/200xxx(B) → sz；
// 北交所 92xxxx・4xxxxx・8xxxxx → bj（错误前缀如 bj900939/bj200011 会返回 v_pv_none_match）。
export function quoteSymbol(code) {
  const c = String(code ?? '').trim();
  if (!/^\d{6}$/.test(c)) return null;
  if (c[0] === '6' || c.startsWith('900')) return 'sh' + c;
  if (c[0] === '0' || c[0] === '3' || c[0] === '2') return 'sz' + c;
  if (c[0] === '4' || c[0] === '8' || c.startsWith('92')) return 'bj' + c;
  return null;
}

// 源2辅助: 腾讯批量行情（60只/批）补全强势股 close/涨跌幅/换手
async function fetchHotQuotes(codes) {
  const out = {};
  const sym = quoteSymbol;
  for (let i = 0; i < codes.length; i += 60) {
    const batch = codes.slice(i, i + 60).map(sym).filter(Boolean);
    if (!batch.length) continue;
    try {
      const txt = await fetchGBK('https://qt.gtimg.cn/q=' + batch.join(','));
      for (const m of txt.matchAll(/v_(?:sh|sz|bj)(\d{6})="([^"]*)"/g)) {
        const f = m[2].split('~');
        const close = parseFloat(f[3]), pre = parseFloat(f[4]), chg = parseFloat(f[32]), hs = parseFloat(f[38]);
        if (isNaN(close) || close <= 0) continue;
        out[m[1]] = {
          close,
          change_pct: !isNaN(chg) ? chg : (pre > 0 ? r2((close / pre - 1) * 100) : 0),
          huanshou: isNaN(hs) ? 0 : hs,
        };
      }
    } catch (e) { /* 单批失败容错 */ }
    await sleep(300);
  }
  return out;
}
async function enrichHotQuotes(hotRaw) {
  const codes = [...new Set(hotRaw.map((x) => x.code).filter(Boolean))];
  let qm = {};
  try { qm = await fetchHotQuotes(codes); } catch (e) { return hotRaw; }
  hotRaw.forEach((x) => {
    const q = qm[x.code];
    if (q) { x.close = q.close; x.zhangfu = q.change_pct; x.huanshou = q.huanshou; }
  });
  return hotRaw;
}

// 源3: 东财龙虎榜（分页全量；第1页无 result = 当日未公布）
export async function fetchLhb(date) {
  const out = []; let page = 1;
  while (page <= 5) {
    const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?pageSize=200&pageNumber=' + page +
      '&reportName=RPT_DAILYBILLBOARD_DETAILSNEW&columns=ALL&filter=(TRADE_DATE%3D%27' + date + '%27)';
    const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://data.eastmoney.com/' } });
    const j = await r.json();
    if (!j.success || !j.result) {
      if (page === 1 && !j.result) throw new LhbNotPublishedError(date);
      throw new Error('龙虎榜接口失败: ' + (j.message || 'empty'));
    }
    out.push(...j.result.data);
    if (out.length >= j.result.count) break;
    page++; await sleep(300);
  }
  return out;
}

// 源4: 881xxx 行业日K
export async function fetchBoards(date) {
  const html = await fetchGBK('https://q.10jqka.com.cn/thshy/', { headers: {} });
  const re = /thshy\/detail\/code\/(88\d{4})\/" target="_blank">([^<]+)</g;
  let m; const boards = []; const seen = new Set();
  while ((m = re.exec(html))) if (!seen.has(m[1])) { seen.add(m[1]); boards.push({ code: m[1], name: m[2].trim() }); }
  if (boards.length < 50) throw new Error('板块列表异常: ' + boards.length);
  const ymdNum = date.replace(/-/g, '');
  const year = date.slice(0, 4);
  const rows = []; let fail = 0;
  // 4 路并发（worker 内限速），90 个行业 30s → ~10s
  const WORKERS = 4;
  let cursor = 0;
  async function boardWorker() {
    while (cursor < boards.length) {
      const { code, name } = boards[cursor++];
      let got = null;
      for (let att = 0; att < 2 && !got; att++) {
        try {
          const t = await (await fetch('http://d.10jqka.com.cn/v6/line/48_' + code + '/01/' + year + '.js',
            { headers: { 'User-Agent': UA, Referer: 'https://q.10jqka.com.cn/' } })).text();
          const s = t.slice(t.indexOf('(') + 1, t.lastIndexOf(')'));
          const obj = JSON.parse(s);
          const ks = (obj.data || '').split(';').filter(Boolean).map((l) => l.split(','));
          const idx = ks.findIndex((k) => k[0] === ymdNum);
          if (idx > 0) got = { close: +ks[idx][4], pre: +ks[idx - 1][4] };
        } catch (e) { await sleep(500); }
      }
      if (got && got.close && got.pre) rows.push({ name, change_pct: r2((got.close / got.pre - 1) * 100) });
      else fail++;
      await sleep(150);
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, () => boardWorker()));
  if (rows.length < 50) throw new Error('行业日K 成功过少: ' + rows.length + '/' + boards.length);
  return rows.sort((a, b) => b.change_pct - a.change_pct);
}

// 源4b: 第二行业源（腾讯/申万二级）—— 给「跨源一致性互证」（src/crosscheck.js）用。
//
// ⚠ 为什么要第二个源：行业涨跌幅原本只有同花顺一个源（见上方 fetchBoards）。
//   单源的问题是"错了没人知道"——页面照渲染、报告照生成，没有任何一处会说不一致。
//   2026-08-18「种植业与林业 9.36%」那次只能靠人工查证才发现是**真实轮动**，
//   反过来正说明：**没有第二源就分不清"真轮动"与"源抽风"**。
//
// ⚠ 口径差异必须显式化：本源是**申万二级行业**（100 个），与主源**同花顺行业**（90 个）
//   分类体系不同 → 归一化后才能比对（别名表在 src/crosscheck.js）。同名 ≠ 同一指数，
//   故本函数只负责"如实取回原始值"，任何"跨源合并/加权"一律不在数据层做。
//
// ⚠ 只能取到**当下**（接口不接日期参数）→ 仅对"最新交易日"有效。历史日无法回溯互证，
//   故调用方须把 date 与"实际取数时刻"一并落盘（见 scripts/fetch_crosscheck.mjs），
//   不得把"昨天取的值"记成"今天两源一致"。
export async function fetchSecondIndustry() {
  let lastErr;
  for (let att = 0; att < 3; att++) {
    try {
      const j = await fetchJSON(
        'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/mktHs/rank?l=120&p=1&t=01/averatio&o=0',
        { headers: { Referer: 'https://gu.qq.com/' } });
      const list = j && j.data;
      if (Array.isArray(list) && list.length >= 50) {
        return list
          // s 字段：bd_name=板块名, bd_zdf=涨跌幅(%)。只保留能解析出数值的行（缺失不落 0）
          .map((x) => ({ name: String(x.bd_name || '').trim(), change_pct: num2(x.bd_zdf) }))
          .filter((x) => x.name && x.change_pct != null);
      }
      lastErr = new Error('mktHs/rank 返回异常 len=' + (Array.isArray(list) ? list.length : 'n/a'));
    } catch (e) { lastErr = e; }
    await sleep(600);
  }
  throw new Error('第二行业源（腾讯/申万二级）连续失败: ' + (lastErr ? lastErr.message : 'unknown'));
}

// 源5: 腾讯三大指数
export async function fetchIndexes(date) {  for (let att = 0; att < 3; att++) {
    try {
      const txt = await fetchGBK('https://qt.gtimg.cn/q=sh000001,sz399001,sz399006');
      const idx = {}; let ok = false;
      for (const m of txt.matchAll(/v_(sh|sz)\d+="([^"]*)"/g)) {
        const f = m[2].split('~');
        const name = f[1];
        const ymdNum = (f[30] || '').replace(/\D/g, '');
        const ymd = ymdNum.length >= 8 ? ymdNum.slice(0, 4) + '-' + ymdNum.slice(4, 6) + '-' + ymdNum.slice(6, 8) : '';
        if (!ymd || ymd !== date) continue;
        const chg = parseFloat(f[32]);
        if (!isNaN(chg)) { idx[name] = r2(chg); ok = true; }
      }
      if (ok) return idx;
    } catch (e) { /* 重试 */ }
    await sleep(600);
  }
  return null;
}

// 源6: 东财涨跌停/炸板池
async function fetchPools(date) {
  const ymd = date.replace(/-/g, '');
  const base = 'ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=500';
  const apis = [
    ['getTopicZTPool', 'zt', 'fbt%3Aasc'],
    ['getTopicZBPool', 'zb', 'fbt%3Aasc'],
    ['getTopicDTPool', 'dt', 'fund%3Aasc'],
  ];
  const out = { zt: null, zb: null, dt: null, max_lb: null, lb2: null, zt_codes: null, zt_lb: null, dt_detail: null, zb_detail: null };
  let any = false;
  for (const [api, key, sort] of apis) {
    for (let att = 0; att < 3; att++) {
      try {
        const j = await fetchJSON('https://push2ex.eastmoney.com/' + api + '?' + base + '&sort=' + sort + '&date=' + ymd,
          { headers: { Referer: 'https://quote.eastmoney.com/' } });
        const pool = j && j.data && Array.isArray(j.data.pool) ? j.data.pool : null;
        if (pool && pool.length) { out[key] = pool.length; any = true; }
        else out[key] = (pool ? 0 : null);
        if (api === 'getTopicZTPool' && pool && pool.length) {
          out.max_lb = Math.max(...pool.map((p) => p.lbc || 1));
          out.lb2 = pool.filter((p) => (p.lbc || 1) >= 2).length;
          out.zt_codes = pool.map((p) => p.c);
          out.zt_lb = {}; pool.forEach((p) => { out.zt_lb[p.c] = p.lbc || 1; });
        }
        if (api === 'getTopicDTPool' && pool) {
          out.dt_detail = pool.map((p) => ({ c: p.c, fba: p.fba || 0, amount: p.amount || 0, days: p.days || 0 }));
        }
        if (api === 'getTopicZBPool' && pool) {
          out.zb_detail = pool.map((p) => ({ c: p.c, amount: p.amount || 0 }));
        }
        break; // 成功即跳出重试
      } catch (e) { if (att === 2) console.error('[pools]', api, '连续失败:', e.message); }
      await sleep(600);
    }
  }
  return any ? out : null;
}

// 源8: 东财全市场涨跌家数（沪深合计；f104=涨 f105=跌 f106=平）
async function fetchBreadth() {
  for (let att = 0; att < 3; att++) {
    try {
      const j = await fetchJSON('https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=1.000001,0.399001&fields=f104,f105,f106&ut=fa5fd1943c7b386f172d6893dbfba10b',
        { headers: { Referer: 'https://quote.eastmoney.com/' } });
      const diff = j && j.data && Array.isArray(j.data.diff) ? j.data.diff : null;
      if (!diff || !diff.length) throw new Error('breadth empty');
      let up = 0, down = 0, flat = 0, ok = false;
      for (const d of diff) {
        if (d.f104 != null && d.f105 != null) { up += d.f104; down += d.f105; flat += d.f106 || 0; ok = true; }
      }
      if (ok) return { up, down, flat };
      throw new Error('breadth fields missing');
    } catch (e) { if (att === 2) console.error('[breadth] 连续失败:', e.message); }
    await sleep(600);
  }
  return null;
}

// 源7: 同花顺大盘日K → 两市成交额 Map（YYYYMMDD → 亿）
// 市级有效性（2026-10-08 二次事故实录）：单市「在场但脏」护栏。此前 `a>0 && b>0`
// 只防「缺失」（09-29：深证 bar 未出 → 该日不收），防不住「bar 已出但成交额字段是
// 极小脏值」（10-08 20 时实录：399001 当日 bar 成交额 ≈0.01 亿级，>0 判定穿透 →
// map[20261008]=8301 几乎纯沪市冒充两市 → s_amt=12.5 二次污染，仅隔 28 分钟重跑
// 即复现）。两市体量恒同数量级（沪/深日额比长期 0.9~1.1，极端亦 >0.2），比值护栏
// 不依赖绝对量级假设——未来市场缩量到地量（单市千二百亿）也不误杀。
// 纯函数导出，供主路与腾讯兜底共用同一判定（两处口径必须一致），并供单测锁定。
export function validMarketPair(a, b) {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  return lo > 0 && hi > 0 && lo >= hi * 0.2;
}
export async function fetchAmountMap({ anchor } = {}) {
  // 分指数抓取，合并时要求两市同日都有值——防单市缺数据被当全市（2026-09-29 事故：深证延迟只出上证 6617 亿）
  const byCode = {};
  const years = [2025, 2026];
  for (const code of ['zs_1A0001', 'zs_399001']) {
    const m = {};
    for (const year of years) {
      try {
        const t = await (await fetch('https://d.10jqka.com.cn/v6/line/' + code + '/01/' + year + '.js',
          { headers: { 'User-Agent': UA, Referer: 'https://q.10jqka.com.cn/' } })).text();
        const obj = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
        (obj.data || '').split(';').filter(Boolean).forEach((l) => {
          const c = l.split(',');
          if (c.length >= 7 && +c[6] > 0) m[c[0]] = (+c[6]) / 1e8;
        });
      } catch (e) { /* 单年失败容错 */ }
      await sleep(300);
    }
    byCode[code] = m;
  }
  const map = {};
  const dates = new Set([...Object.keys(byCode.zs_1A0001), ...Object.keys(byCode.zs_399001)]);
  for (const dt of dates) {
    const a = byCode.zs_1A0001[dt], b = byCode.zs_399001[dt];
    if (validMarketPair(a, b)) map[dt] = a + b; // 单市缺/脏 → 该日不收，交由兜底/missing 处理
  }
  // 截断防护（2026-10-08 病因B，第三批）：同花顺年线接口间歇性返回截断序列
  //   （当晚实录两形态：截到 20251231 缺 9 个月 / 截到 0930 缺当日；前后直连又全好，
  //   CDN 节点数据不同步），CI 18:30/21:00 两班 smoke 两连挂（60s run 级重试救不了
  //   小时级劣化）。原兜底散装挂在 fetchLive（缺当日才补），smoke / backfill_factors
  //   直接调本函数无防护——此处下沉为唯一出入口：调用方传 anchor（期望覆盖的
  //   交易日 YYYYMMDD），序列最新键 < anchor 即截断 → 腾讯实时两市补当日。
  //   备源不选东财 push2his：本机实测 3/3 TLS 断连不可达，无法本地验证的源不进生产。
  //   腾讯源自身带两市比值护栏（validMarketPair）+ 合理区间护栏，单市缺/脏拒收。
  const sorted = Object.keys(map).sort();
  const latest = sorted[sorted.length - 1];
  if (anchor && (!sorted.length || latest < anchor)) {
    console.warn(`[amount] 同花顺序列未覆盖锚点（最新 ${latest ?? '空'} < 锚点 ${anchor}）→ 腾讯实时两市兜底当日值`);
    const fb = await fetchAmountTencentFallback(anchor);
    if (fb && fb[anchor] != null) {
      map[anchor] = fb[anchor];
      console.warn(`[amount] 腾讯兜底成功：${anchor} = ${fb[anchor]} 亿`);
    } else {
      console.warn('[amount] 腾讯兜底也未取得当日值——当日成交额走 missing 中性（宁缺勿假）');
    }
  }
  return Object.keys(map).length ? map : null;
}

// 源7b(备): 腾讯指数实时成交额（万元→亿），同花顺日K当日延迟时兜底
async function fetchAmountTencentFallback(ymd) {
  for (let att = 0; att < 3; att++) {
    try {
      const t = await (await fetch('https://qt.gtimg.cn/q=sh000001,sz399001&r=' + Date.now(),
        { headers: { 'User-Agent': UA } })).text();
      // 两市各自解析到有效值才返回（2026-10-08 事故：深证行缺失/解析失败时旧逻辑
      // any=true 即收，只加了沪市 8301 亿——单市冒充两市混入两市口径序列（近 20 日均
      // ≈1.8 万亿，比值 0.46）→ s_amt=12.5 反向拖低情绪分 ~5 分并污染分位/判档。
      // 与主路 fetchAmountMap 的「两市同日都有值」约束对齐，任一市缺失 → null 走
      // missing，宁缺毋假。09-29 主路单市事故只修了主路，兜底漏配，本处补齐）。
      let sh = 0, sz = 0;
      for (const p of t.split(';')) {
        if (!p.includes('~')) continue;
        const amt = +p.split('~')[37]; // f[37]=成交额(万元)；f[38] 盘后为 0，勿用
        if (!(Number.isFinite(amt) && amt > 0)) continue;
        if (p.includes('sh000001')) sh = amt / 1e4;
        else if (p.includes('sz399001')) sz = amt / 1e4;
      }
      const sum = sh + sz;
      // 市级有效性用与主路同一判定（validMarketPair）：单市缺或「在场但脏」都拒收
      if (validMarketPair(sh, sz) && sum > 3000 && sum < 90000) return { [ymd]: r1(sum) }; // 两市额合理区间护栏
    } catch (e) { /* 重试 */ }
    await sleep(500);
  }
  return null;
}

// 口径守卫（纯函数，供单测）：当日两市成交额 vs 近 20 日均比值异常的二道防线。
// 主修在 fetchAmountTencentFallback（两市各自有效），此处兜「主路/兜底本身被污染」
// 的残余风险。判脏条件：比值 < 0.7 且非长假后首日（与前一有效交易日自然日差
// ≤ 3 天——长假后首日常见真缩量，放行不误杀；10-08 长假首日 gap 8 天即豁免，
// 该场景由主修兜住）。返回 null（放行）或拦截原因（供 warn 与 _missing 留痕）。
export function amountCaliberGuard(amountYi, amountMap, ymd) {
  if (amountYi == null || !amountMap) return null;
  const prior = Object.keys(amountMap).filter((k) => k < ymd && amountMap[k] > 0).sort();
  if (prior.length < 10) return null; // 均值样本不足（与 buildDay amt_ma 的 ≥10 门槛同口径）
  const ma = prior.slice(-20).reduce((a, k) => a + amountMap[k], 0) / Math.min(prior.length, 20);
  if (!(ma > 0) || amountYi / ma >= 0.7) return null;
  const iso = (k) => `${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6, 8)}`;
  const gap = (Date.parse(iso(ymd)) - Date.parse(iso(prior[prior.length - 1]))) / 86400e3;
  return gap <= 3
    ? `当日 ${r1(amountYi)}亿 < 0.7×近20日均 ${r1(ma)}亿（前有效日 ${prior[prior.length - 1]}，gap ${gap} 天），单市冒充两市特征，判脏丢弃`
    : null;
}

// day 组装（七因子 + 题材原始计数）
//
// 东财龙虎榜同一次披露里混装两类榜单，字段语义并不相同：
//   ① 当日榜（"日涨幅偏离值达7%"、"日换手率达20%"、"日振幅达15%"、"无价格涨跌幅限制"等）
//      —— 席位买卖与净额都是"当日"口径，BILLBOARD_DEAL_AMT == BUY_AMT + SELL_AMT；
//   ② 区间累计榜（"连续3/10个交易日涨跌幅偏离值累计达X%"、"非S证券连续三个交易日…"）
//      —— 统计的是整个区间的累计值，且 BILLBOARD_BUY_AMT 被填成区间累计成交额
//      （实测 2026-09-30 近岸蛋白 688137 的 10 日榜：BUY == SELL == ACCUM_AMOUNT == 116.97 亿、净额 0）。
// 两类不加区分地相加会得出量级错误的"上榜总成交"——2026-09-30 实测：全部 84 条未去重合计 511.1 亿，
// 而当日榜去重后仅 136.5 亿（3.7 倍差），净买率因此被稀释成 2.4%（真实 5~6%）。
// 故此处把两类分开：存全量供追溯，另出"当日榜去重"口径供报告使用。
// lhb 原始数据 → 聚合结构（buildDay 与 applyLhb 补抓共用）
// 口径判别、同票去重、双口径汇总全部收敛在 src/lhb.js —— 此处只做装配，不再自行相加，
// 避免「少了带口径后缀的那一刻」把区间累计榜混进当日口径（2026-09-30 曾因此把 136.5 亿算成 511.1 亿）。
//
// 装配顺序（不可颠倒）：normalizeRecord → mergeDuplicateRecords → summarizeCalibers
//   · mergeDuplicateRecords 消灭「同票同口径逐字段完全相同」的重复披露（2026-08-14 蓝盾光电实测：
//     两条净额都是 37382.3 万，只有上榜原因不同）。放在装配层而不是只在汇总层，是因为
//     **lhb 原始数组本身就是下游入口**：picks / paper / lhbfilter / fetch_universe / 连板回测
//     都直接遍历它，任何 `reduce(净买)` 都会把同一只票算两遍。
//   · summarizeCalibers 自己也会再合并一次（幂等），作为"调用方忘了合并"的兜底。
function buildLhbPart(lhbRaw) {
  const normalized = lhbRaw.map(normalizeRecord);
  const lhb = mergeDuplicateRecords(normalized).sort((a, b) => b.net_buy_wan - a.net_buy_wan);
  const c = summarizeCalibers(lhb);
  // 合并留痕的「原始条数」必须取**合并前**的 normalized.length。
  //   注意：summarizeCalibers(lhb) 收到的已是合并后数组，它的 raw_records 只能看到合并后条数，
  //   拿它当"东财原始披露条数"会把 merged_away 恒算成 0（守卫 `raw − 合并 = count` 也就恒成立，
  //   变成一条永远通过的废断言）。故此处显式用 normalized.length 覆盖。
  const rawCount = normalized.length;
  const mergedAway = rawCount - lhb.length;
  return {
    lhb,
    lhb_aggr: c.all_aggr,
    lhb_daily_aggr: c.daily_aggr,
    // 全量口径（含区间累计榜）：仅诊断用，禁止喂给日度因子或净买率
    all_net_yi: c.all_net_yi, net_pos: c.all_pos, net_neg: c.all_neg,
    // 当日榜口径（权威）：日度因子 / 净买率 / 新股扰动一律用它
    daily_net_yi: c.daily_net_yi, daily_amt_yi: c.daily_amt_yi,
    // 当日榜 · 剔除新股（喂 s_net 的唯一口径）：新股首日无涨跌幅限制、换手极高，
    // 其净买衡量的是打新出货承接，不是存量资金的进攻意愿（2026-09-30 实测虚增情绪分 4.20 分）
    daily_ex_new_net_yi: c.daily_ex_new_net_yi, daily_new_net_yi: c.daily_new_net_yi,
    daily_new_ratio: c.daily_new_ratio, daily_new_stocks: c.daily_new_stocks,
    daily_new_count: c.daily_new_count,
    range_count: c.range_records,
    // 合并留痕：raw 条数 vs 合并后条数，供审计核对「同票多榜重复披露」的规模
    raw_count: rawCount, merged_away: mergedAway,
  };
}

// 龙虎榜晚间分批披露：把重抓的 lhb 刷进已有 day（仅原始数据层，emotion 由 recalcAll 统一重算）
export function applyLhb(day, lhbRaw) {
  const p = buildLhbPart(lhbRaw);
  day.lhb = p.lhb;
  day.lhb_aggr = p.lhb_aggr;
  day.lhb_daily_aggr = p.lhb_daily_aggr;
  const s = day.summary = day.summary || {};
  s.lhb_count = p.lhb.length;        // 合并后的记录条数（不是东财原始披露条数）
  s.lhb_raw_count = p.raw_count;     // 东财原始披露条数（同票多榜会 > lhb_count）
  s.lhb_merged_away = p.merged_away; // 被合并掉的重复条数
  s.lhb_stocks = p.lhb_aggr.length;
  s.lhb_all_net = p.all_net_yi;      // 全量口径（含区间累计榜）——仅诊断
  s.net_pos = p.net_pos;
  s.net_neg = p.net_neg;
  s.lhb_daily_stocks = p.lhb_daily_aggr.length;
  s.lhb_daily_net = p.daily_net_yi;  // 当日榜口径（权威）
  s.lhb_daily_amt = p.daily_amt_yi;
  s.lhb_range_count = p.range_count;
  // 新股口径（s_net 已自动剔除）：补抓后同样刷新，避免明细更新而剔除结果留在旧值
  s.lhb_daily_ex_new_net = p.daily_ex_new_net_yi;
  s.lhb_new_net = p.daily_new_net_yi;
  s.lhb_new_ratio = p.daily_new_ratio;
  s.lhb_new_count = p.daily_new_count;
  s.lhb_new_stocks = p.daily_new_stocks;
  if (day.emotion) day.emotion.lhb_daily_net = p.daily_net_yi;
  return day;
}

// 源9: 东财席位明细（RPT_BILLBOARD_DAILYDETAILSBUY/SELL）→ 资金属性拆分/买方集中度
// 分类: 机构专用=inst; 沪股通/深股通=north; 其余营业部=hot(游资)
export function classifySeat(name) {
  const s = String(name || '');
  if (s.includes('机构专用')) return 'inst';
  if (s.includes('沪股通') || s.includes('深股通')) return 'north';
  return 'hot';
}

// 席位明细接口在部分票（尤其区间累计榜）里会混入「自然人/中小投资者/机构/其他自然人」
// 这类**投资者结构汇总行**——它们不是席位，金额与整票成交额同阶，计入会把游资买入虚增、
// 并把买方集中度的分母放大（2026-09-30 实测：游资买入虚增 192.77 亿、集中度 44.5%→18.7%）。
// 判据与净化集中在 src/seats.js::isAggregateSeatRow，此处只做调用，不再另写一份判别式。


async function fetchSeatRows(reportName, date, code, sortCol) {
  for (let att = 0; att < 2; att++) {
    try {
      const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=' + reportName +
        '&columns=ALL&filter=(TRADE_DATE%3D%27' + date + '%27)(SECURITY_CODE%3D%22' + code + '%22)' +
        '&pageSize=50&pageNumber=1&sortColumns=' + sortCol + '&sortTypes=-1&source=WEB&client=WEB';
      const j = await (await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://data.eastmoney.com/' } })).json();
      return (j.result && j.result.data) || [];
    } catch (e) { await sleep(400); }
  }
  return null; // 请求级失败（区别于"未发布"空数组）
}

// 抓全部榜单股的席位明细并聚合。cover=成功覆盖率（%）；席位明细分批发布，未发布视作无数据
// 附加: buy_top3_pct=全市场买方头部3席位集中度（前3席位买入÷全部买方买入）;
//       detail=逐票**买卖双侧**席位明细，供锁仓/新进资金跨日比对与"席位身份"下钻。
//
// detail 结构（v2，买卖双侧）：
//   { code: { b: [[席位名, 金额万元], ...], s: [[席位名, 金额万元], ...] } }
// 旧结构（v1，仅买方）是 { code: [[席位名, 金额万元], ...] }。
// 前端必须两种都能读——存量存档不会因为这次改动而重算，历史天数仍是 v1 形态。
// 之所以补上卖侧：龙虎榜本来就是"买卖各前 5 席位"，只存买方等于把对手盘结构整块丢掉，
// 用户点开个股只能看到"谁在买"，看不到"谁在卖"，而砸盘方往往才是判断接力的关键。
export async function fetchSeats(date, aggr) {
  const agg = { inst_buy: 0, inst_sell: 0, north_buy: 0, north_sell: 0, hot_buy: 0, hot_sell: 0, cover: 0, conc_top: [], buy_top3_pct: null, detail: {} };
  const concAll = [];
  const seatBuy = {}; // 席位名 -> 买入合计（元），全市场跨票聚合
  let buyAll = 0;
  let got = 0;
  for (const a of aggr) {
    const [buyRows, sellRows] = await Promise.all([
      fetchSeatRows('RPT_BILLBOARD_DAILYDETAILSBUY', date, a.code, 'BUY'),
      fetchSeatRows('RPT_BILLBOARD_DAILYDETAILSSELL', date, a.code, 'SELL'),
    ]);
    if (buyRows == null && sellRows == null) continue;
    // 净化：剔除「自然人/中小投资者/机构/其他自然人」类投资者结构汇总行（非席位）。
    // 不剔除会让游资买入虚增、并稀释全市场买方集中度（详见 isAggregateSeatRow 注释）。
    const cleanBuy = (buyRows || []).filter((r) => !isAggregateSeatRow(r.OPERATEDEPT_NAME));
    const cleanSell = (sellRows || []).filter((r) => !isAggregateSeatRow(r.OPERATEDEPT_NAME));
    got++;
    for (const r of cleanBuy) {
      agg[classifySeat(r.OPERATEDEPT_NAME) + '_buy'] += (r.BUY || 0) / 1e8;
      const nm = String(r.OPERATEDEPT_NAME || ''), buy = r.BUY || 0;
      seatBuy[nm] = (seatBuy[nm] || 0) + buy;
      buyAll += buy;
    }
    for (const r of cleanSell) agg[classifySeat(r.OPERATEDEPT_NAME) + '_sell'] += (r.SELL || 0) / 1e8;
    // 买方集中度：前三席位买入占该票榜上买入的比重
    if (cleanBuy.length >= 3) {
      const buys = cleanBuy.map((r) => r.BUY || 0).sort((x, y) => y - x);
      const tot = buys.reduce((x, y) => x + y, 0);
      if (tot > 0) concAll.push([a.name, r1(buys.slice(0, 3).reduce((x, y) => x + y, 0) / tot * 100)]);
    }
    // 逐票买卖双侧席位明细（[席位名, 金额万元]，各侧均按金额降序）
    const toPairs = (rows, col) => (rows || [])
      .map((r) => [String(r.OPERATEDEPT_NAME || ''), Math.round((r[col] || 0) / 1e4)])
      .filter(([nm, v]) => nm && v > 0)
      .sort((x, y) => y[1] - x[1]);
    const b = toPairs(cleanBuy, 'BUY'), s2 = toPairs(cleanSell, 'SELL');
    if (b.length || s2.length) agg.detail[a.code] = { b, s: s2 };
    await sleep(120);
  }
  agg.cover = aggr.length ? r2((got / aggr.length) * 100) : 0;
  agg.conc_top = concAll.sort((x, y) => y[1] - x[1]).slice(0, 5);
  if (buyAll > 0) {
    const tops = Object.entries(seatBuy).sort((x, y) => y[1] - x[1]).slice(0, 3);
    agg.buy_top3_pct = r1(tops.reduce((s, [, v]) => s + v, 0) / buyAll * 100);
  }
  for (const k of ['inst_buy', 'inst_sell', 'north_buy', 'north_sell', 'hot_buy', 'hot_sell']) agg[k] = r2(agg[k]);
  // 样本口径留痕：aggr 传进来的是「全部上榜个股」（含区间累计榜个股），故分项之和 ≠ 当日榜净买。
  // 报告端必须把这两个数摆明白，否则读者会拿分项之和去对当日榜净买，误判为数据错误。
  agg.universe = 'all_listed';       // 口径标记：全部上榜个股（含区间累计榜）
  agg.universe_n = got;              // 实际取到明细的个股数
  agg.universe_total = aggr.length;  // 请求的个股数
  return agg;
}

function buildDay(date, lhbRaw, hotRaw, industry, indexes, pools, amountYi, amountMap, breadth, seats) {
  const {
    lhb, lhb_aggr, lhb_daily_aggr, all_net_yi, net_pos, net_neg,
    daily_net_yi, daily_amt_yi, range_count,
    daily_ex_new_net_yi, daily_new_net_yi, daily_new_ratio, daily_new_stocks, daily_new_count,
    raw_count, merged_away,
  } = buildLhbPart(lhbRaw);

  const hot = hotRaw.map((x) => ({
    code: x.code, name: x.name, reason: x.reason || '',
    close: x.close > 0 ? r2(+x.close) : null,
    change_pct: num2(x.zhangfu),
    huanshou: num2(x.huanshou),
  }));
  // 行情兜底：腾讯行情没覆盖到的票（代码段未收录 / 该批请求失败），若同日龙虎榜明细里有它的行情就借过来，
  // 并标注来源。同一天同一只票的收盘价/涨跌幅两个源应当一致，故可安全互备。
  const lhbByCode = new Map((lhb_aggr || []).map((r) => [r.code, r]));
  hot.forEach((h) => {
    if (h.close != null) return;
    const l = lhbByCode.get(h.code);
    if (!l || l.close == null) return;
    h.close = l.close;
    h.change_pct = l.change_pct ?? null;
    h.huanshou = l.turnover_pct ?? null;
    h.quote_src = 'lhb';
  });
  const freq = {};
  hot.forEach((h) => (h.reason || '').split(/[+＋]/).forEach((w) => { w = w.trim(); if (w) freq[w] = (freq[w] || 0) + 1; }));
  const topics = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([tag, count]) => ({ tag, count }));

  const ind_up = industry.filter((i) => i.change_pct > 0).length;
  const ind_down = industry.filter((i) => i.change_pct < 0).length;

  const missing = [];
  // 强势股行情补全缺口：数据源未覆盖该代码段 → 该票 close/涨跌幅/换手留空（前端显「—」而非 0）
  const hot_quote_missing = hot.filter((h) => h.close == null).length;
  if (hot_quote_missing) missing.push(`hot_quotes(${hot_quote_missing})`);
  const zt = pools ? pools.zt : null, dt = pools ? pools.dt : null, zb = pools ? pools.zb : null;
  if (zt == null || dt == null || zb == null) missing.push('pools');
  // 封板率（市场通用口径）= 收盘涨停 ÷ 盘中触及过涨停（涨停 + 炸板）。
  // 分母是「触板个股」，不是「收盘涨停个股」；这是各行情软件「封板率」的通用算法。
  // ⚠ 历史坑：本字段旧名 zbl_pct、旧式 zb/(zb+zt)，但存储值一直是 zt/(zt+zb)。
  //   即**数值算对了（封板率），字段名却是炸板率**，导致报告把 81.3% 渲染成「炸板率 18.8%」。
  //   见 scripts/audit_lhb_caliber.mjs 的口径守卫；此处同时保留 zbl_pct 旧名做兼容。
  const seal_pct = (zt != null && zb != null && (zb + zt) > 0) ? r1((zt / (zb + zt)) * 100) : null;
  // 炸板率 = 100 − 封板率（同一分母，二者互补，不再各自现算以免漂移）
  const zb_pct = seal_pct != null ? r1(100 - seal_pct) : null;
  const zbl_pct = zb_pct; // 兼容旧字段名（语义=炸板率，与旧报告渲染一致）
  const ymdNum = date.replace(/-/g, '');
  let amount_yi = amountYi != null ? r1(amountYi) : null;
  const amtGuardHit = amountCaliberGuard(amount_yi, amountMap, ymdNum);
  if (amtGuardHit) {
    console.warn(`[amount] 口径守卫拦截 ${date}: ${amtGuardHit}`);
    amount_yi = null; // 判脏丢弃走 missing（s_amt 中性 50 + summary._missing 留痕）
  }
  if (amount_yi == null) missing.push('amount');
  const histAmts = amountMap ? Object.keys(amountMap).filter((k) => k < ymdNum && amountMap[k] > 0).sort().slice(-20) : [];
  const amt_ma = histAmts.length >= 10 ? histAmts.reduce((a, k) => a + amountMap[k], 0) / histAmts.length : null;

  // 七因子：统一走 sentiment.js computeSentiment（唯一公式实现）
  // 净额入参必须是「当日榜」口径：区间累计榜是区间累计值，混进来会让日度因子把三天累计当成一天
  // （实测 2026-09-08 当日榜 -0.11 亿 vs 全量 +13.42 亿 → s_net 从 48.9 被抬到 99.5 并 tanh 饱和）。
  // 并必须剔除新股/无涨跌幅限制标的：s_net=tanh(x/5)*50+50 在 5 亿量级近饱和，
  // 一笔新股净买即可把因子从「转弱」推到「接近满分」（2026-09-30：力勤资源 +5.04 亿，
  // 含新股 s_net 95.7 vs 剔除后 74.6，情绪分虚高 4.20 分并跨过 65 分满仓档位线）。
  const pos_ratio_v = (net_pos + net_neg) > 0 ? net_pos / (net_pos + net_neg) : null;
  const sent = computeSentiment({
    netBuy: daily_net_yi,
    newStockNet: daily_new_net_yi || 0,
    newStockRatio: daily_new_ratio ?? null,
    upCount: breadth ? breadth.up : null,
    downCount: breadth ? breadth.down : null,
    posRatio: pos_ratio_v,
    industryUp: ind_up,
    industryTotal: industry.length,
    limitUp: zt, limitDown: dt, brokenCount: zb,
    amount: amount_yi, amountMA20: amt_ma,
  }, config.weights);
  const FKEY = { s_net20: 's_net', s_pos10: 's_pos', s_brd20: 's_brd', s_hot10: 's_hot', s_zdt15: 's_zdt', s_zbl10: 's_zbl', s_amt15: 's_amt' };
  const facPlain = {};
  for (const [wk, pk] of Object.entries(FKEY)) facPlain[pk] = sent.factors[wk];
  const value = sent.score;
  const imputedRatio = sent.imputedRatio;
  const factorMissing = sent.missing;

  const summary = {
    // lhb_count 是**合并后**的记录条数（下游恒等式 `区间条数 = lhb_count − 当日榜记录数` 依赖它）
    lhb_count: lhb.length, lhb_stocks: lhb_aggr.length,
    // 东财原始披露条数与被合并掉的重复条数（同票多榜会重复披露，留痕供审计核对）
    lhb_raw_count: raw_count, lhb_merged_away: merged_away,
    // 全量口径（含「连续N个交易日」区间累计榜）：仅诊断，以及「上榜个股数」这类外部可核对的家数
    lhb_all_net: all_net_yi, net_pos, net_neg,
    // 当日榜口径（权威）：报告展示、日度因子、净买率、新股扰动全部同源
    lhb_daily_stocks: lhb_daily_aggr.length, lhb_daily_net: daily_net_yi,
    lhb_daily_amt: daily_amt_yi, lhb_range_count: range_count,
    // 新股口径：s_net 已自动剔除，这三个字段是证据链（报告不再自行现算）
    lhb_daily_ex_new_net: daily_ex_new_net_yi, lhb_new_net: daily_new_net_yi,
    lhb_new_ratio: daily_new_ratio, lhb_new_count: daily_new_count,
    lhb_new_stocks: daily_new_stocks,
    up_count: breadth ? breadth.up : null, down_count: breadth ? breadth.down : null, flat_count: breadth ? breadth.flat : null,
    breadth_scope: '沪深两市A股（不含北交所/ST口径与各平台统计或有出入）',
    hot_count: hot.length, topic_kinds: Object.keys(freq).length,
    hot_quote_missing,
    ind_count: industry.length, ind_up, ind_down,
    top_industry: industry[0] ? industry[0].name : null,
    bottom_industry: industry[industry.length - 1] ? industry[industry.length - 1].name : null,
    // 封板率/炸板率：分母同为「盘中触板个股数」= 收盘涨停 + 炸板，二者互补
    zt_count: zt, dt_count: dt, zb_count: zb,
    seal_pct,                 // 封板率 = zt/(zt+zb) ×100，市场通用口径
    zb_pct,                   // 炸板率 = 100 − seal_pct
    seal_den: (zt != null && zb != null) ? zt + zb : null, // 分母（触板个股），供报告如实披露口径
    zbl_pct,                  // [兼容] 旧字段名；语义=炸板率
    max_lb: pools ? pools.max_lb : null, lb2_count: pools ? pools.lb2 : null,
    zt_codes: pools ? (pools.zt_codes || null) : null,
    zt_lb: pools ? (pools.zt_lb || null) : null,
    amount_yi,
  };
  if (seats) summary.seats = seats;
  // 板块相对强弱：口径唯一实现在 src/relative.js；此处只负责**挂上去**。
  // 无行业明细的日子（历史回填天）返回 null —— 报告/前端必须显示「未计算」而非 0。
  const industry_relative = computeRelative({ trade_date: date, industry, indexes });
  if (industry_relative) summary.industry_relative = industry_relative;
  if (missing.length) summary._missing = missing;

  const emotion = {
    value, ...facPlain,
    factors: facPlain,
    // 因子入参同源留痕：这里存的是喂给 s_net20 的**剔新股后**当日榜净额
    // （口径守卫会按它反算校验 s_net，并核对 netRaw − newStockNet == netExNew）
    lhb_daily_net: daily_net_yi, pos_ratio: pos_ratio_v != null ? r1(pos_ratio_v * 100) : null,
    newStock: sent.newStock,
    up_ratio: industry.length ? r1((ind_up / industry.length) * 100) : null,
    hot_count: hot.length,
    topic_conc: r1(topics.length ? (topics[0].count / (hot.length || 1)) * 100 : 0),
    top_topic: topics.length ? topics[0].tag : '—',
    pct_rank: null, net_daily_pct_rank: null, industryCount: industry.length,
    imputedRatio, missing: factorMissing,
  };
  return { trade_date: date, lhb, hot, topics, industry, summary, indexes, emotion, lhb_aggr };
}

// ── 分位窗口（#1）────────────────────────────────────────────────────────────
//
// ⚠ 这是本项目**唯一**的分位口径出处。历史上这里是「全档秩」——
//   `vals` 取的是**整份档案**（含 T 日之后的所有天），于是：
//     · 2025-10-09（首日，无任何历史可比）被算成 52.1 分位——"中位偏上"，
//       而任何只看历史的窗口下它只能是 0。这是纯粹的**未来信息泄漏**；
//     · 2026-09-30（最新日）被算成 94.2，去掉未来后是 76.3，虚高 17.9 分位点；
//     · 全档实测：与无前视口径的差异 max 52.1、p50 6.1、均值 8.6 分位点。
//   后果不是"分数不好看"，而是**科学性问题**：分位是"今天在历史上排第几"的陈述，
//   用未来数据算等于用后验分布给先验问题打分——回测与实盘的可用性全部失效。
//
// 修正后的口径（唯一）：**只用到 T 日为止（含 T 日）的最近 RANK_WINDOW 个有效样本**。
//   · 含 T 日**本身**：分位是"当日值在历史窗口中的位置"，当日必须在窗口内，否则
//     "今天创新高"永远显示不出 100。这与 formula_versions 里"归一历史不含当日"是
//     **两个不同的东西**——那里算的是"当日相对于**过去**的位置"（分位映射的原料），
//     这里算的是"当日**在含自身窗口**里的位置"。两者都在同一批数据上，不得混用，
//     故各自持有独立的窗口常量与注释（见 src/formula_versions.js 的 NET_HIST_WINDOW）。
//   · 不足 RANK_MIN 个有效样本 → 返回 null（显示"未计算"）。
//     **绝不**退化成"用更短的窗口凑合"或"填 50 冒充中位"——缺失必须显式化。
//     代价是档案最前面 RANK_MIN-1 天没有分位（如实披露，而不是编一个数字）。
//
// 窗口长度 60：与 NET_HIST_WINDOW 同值同理由（约一个季度，覆盖一段完整情绪周期
// 又能跟上量级漂移）。两者独立，不得互相 import —— 一个是"含当日"、一个是"不含当日"，
// 共用常量会让未来某次调整其中一处时静默污染另一处。
// 值的出处（2026-10-02 起）：config.lookback.rankWindow / rankMin（lookback 集中块，
// live 冻结口径）——本处只做引用，不再是字面量定义点；NET_HIST_WINDOW 仍在
// formula_versions.js 独立持有，不受 config 影响。
export const RANK_WINDOW = config.lookback.rankWindow;
export const RANK_MIN = config.lookback.rankMin;

/** 分位：`vals[i]` 在「以 i 结尾的最近 window 个有效样本」中的位置 ×100。
 *  · 有效样本 = 通过 `num` 加固的数（拒 null/''/布尔/数组/对象），null 不进窗口也不进分母。
 *  · 平值取**首次出现位置**（与旧实现 `indexOf` 语义逐位一致，避免"改了前视偏差
 *    顺带改了平值口径"这种混合变更——真要改平值口径必须另开一项、单独验证）。
 *  · 窗口内样本数 < min → null。 */
export function windowedPctRank(vals, i, window = RANK_WINDOW, min = RANK_MIN) {
  const cur = num2(vals[i]);
  if (cur === null) return null;
  const win = [];
  for (let j = Math.max(0, i - window + 1); j <= i; j++) {
    const v = num2(vals[j]);
    if (v !== null) win.push(v);
  }
  if (win.length < min) return null;
  const s = win.slice().sort((a, b) => a - b);
  // 平值取**首个**出现位置 —— 与旧实现 `indexOf` 语义逐位一致。
  // 用「≤ cur 的个数」会是另一种平值口径（并列中位）；换口径必须单独开一项、
  // 单独验证，不能混在"修前视偏差"这一项里顺带改掉（否则回归差异无法归因）。
  const pos = s.indexOf(cur);
  if (pos < 0) return null; // 防御性：cur 必然在 win 内，不可达则不猜
  return r1((pos / Math.max(s.length - 1, 1)) * 100);
}

/**
 * 全档分位重算（**无前视**）。每个交易日的分位只依赖该日及之前的数据。
 *
 * 幂等性（#1 的另一半要求）：本函数逐日独立、只看"到该日为止"的窗口，
 * 因此
 *   · 追加新的一天**不会**改变任何历史日的分位（旧实现会：新值进入分母/排序 ⇒
 *     同一个历史日的 pct_rank 会随"后来抓了多少天"而漂移，重建档两次得两个答案）；
 *   · 同一天重复调用结果恒定 → 归档 diff 稳定，不会每次运行都产生噪音提交。
 * 这两点是"防重复抓 + 幂等"在**派生指标**这一层的体现：即使抓取层省了网络请求，
 * 只要重算出的数不一样，落盘就还是不幂等。
 */
export function recalcRanks(days) {
  // 分位口径与因子入参一致：净额分位按「当日榜」净额排（用全量口径排会让区间累计值参与分位）
  const vs = days.map((d) => (d.emotion ? d.emotion.value : null));
  const ns = days.map((d) => (d.emotion ? d.emotion.lhb_daily_net : null));
  days.forEach((d, i) => {
    if (!d.emotion) return;
    d.emotion.pct_rank = windowedPctRank(vs, i);
    d.emotion.net_daily_pct_rank = windowedPctRank(ns, i);
  });
  return days;
}

// 实时抓取：返回最新交易日 day（与快照同结构）
export async function fetchLive() {
  const hotRaw = await fetchHot();
  const date = hotRaw[0].date;
  const lhbRaw = await fetchLhb(date);
  const hotEnriched = await enrichHotQuotes(hotRaw);
  const [industry, indexes, pools, amountMap, breadth] = await Promise.all([
    fetchBoards(date),
    fetchIndexes(date),
    fetchPools(date),
    // 截断防护下沉（2026-10-08 病因B）：锚点当日值缺失/序列截断时 fetchAmountMap
    //   内部走腾讯实时两市兜底——原散装兜底（此处 if 补齐）与 smoke 直调路径分裂，
    //   收敛为唯一出处后主路/冒烟/回填同一行为。
    fetchAmountMap({ anchor: date.replace(/-/g, '') }),
    fetchBreadth(),
  ]);
  const amountYi = amountMap ? (amountMap[date.replace(/-/g, '')] || null) : null;
  const day = buildDay(date, lhbRaw, hotEnriched, industry, indexes, pools, amountYi, amountMap, breadth,
    await fetchSeats(date, buildLhbPart(lhbRaw).lhb_aggr.map((l) => ({ code: l.code, name: l.name, net_buy_wan: l.net_buy_wan }))));
  return { newDays: [day], tradeDate: date };
}

export { LhbNotPublishedError };
// 盘中轻量快照（scripts/snapshot_intraday.mjs）需要的三个「实时可得」源：
//   强势股（同花顺，兼交易日探测）/ 涨跌停池（东财 push2ex，盘中实时）/ 涨跌家数（东财 push2，盘中实时）。
//   日K、席位明细、行业板块等在盘中意义不大或代价过高，快照不抓。
export { fetchHot, fetchPools, fetchBreadth };
// fetchLhb/fetchBoards/fetchIndexes/fetchAmountMap 的导出已上移到各自定义处
// （② 冒烟测 scripts/smoke_sources.mjs 与生产同一实现逐源真打，只加导出不改实现）。
