// ── #139 探针：股指期货升贴水 + 期权隐含波动率 ────────────────────────────────
//
// 为什么要先探：fqkline 被 WAF 拦是教训 —— 期权/期指接口更容易被风控。
//   **拉不到就明说「该因子不可用」，绝不编数**。本脚本只做连通性与可算性判定，
//   不做任何"拉不到就用别的值顶替"的兜底（那正是本项目最忌讳的"把失败伪装成正常"）。
//
// 判定标准（两级，缺一不可）：
//   ① 连通性：HTTP 200 **且** 返回体能解析出数值。HTTP 200 但解析不出 = 不可用。
//   ② 可算性：升贴水需要「期货价 + 现货价」两端；隐波需要「期权链 + 期货价」
//      并用 Black-76 反解，收敛率 ≥95% 且数值落在合理区间，才算可用。
//
// ── 实测结论（2026-10-02）────────────────────────────────────────────────
//   期指升贴水：**可用**
//     · 期货：新浪 hq.sinajs.cn/list=nf_IF0,nf_IC0,nf_IH0（GBK，字段 [2]=最新）
//     · 现货：腾讯 qt.gtimg.cn/q=sh000300,sh000905,sh000016
//     · 实测 IF 当月 4278 − 沪深300 4357.62 = 贴水 −79.62 点（−1.827%）
//     · 注意：新浪期货返回的"日期"字段布局不固定，**不要**用它判日期；
//       日期以现货端（腾讯 f[30]）为准。
//   期权隐波：**可用（需自算）**
//     · 中金所 http://www.cffex.com.cn/quote_IO.txt —— 纯文本期权链（236 行，含 IO/MO）
//       列：instrument,position,volume,lastprice,updown,bprice,bamount,sprice,samount
//       **没有隐波列** → 必须自己做 Black-76 反解（IO 为欧式、标的为期货），
//       故本项不是"取数"而是"计算"，属因子构建而非数据抓取。
//     · ⚠ 真实陷阱（本次探针抓出，务必保留）：**深度实值认沽**的 bprice/sprice
//       会报出低于内在价值的价格（IO2610-P-4350 内在 72，报价仅 50.2）。
//       低于内在价值在无套利下不可能 → 该批报价字段不是真盘口。
//       处理：以 lastprice 交叉校验，两者都低于内在价值才跳过（**绝不硬算一个假 IV**）。
//     · 剔除坏报价后收敛率 100%（35/35），IV 微笑形态正确（平值最低、两翼抬升）。
//
// 用法: node scripts/probe_options_futures.mjs
import dns from 'node:dns';

// IPv4 优先：既有探针实测 breadth 源在默认 verbatim 下 UND_ERR_SOCKET，
// ipv4first 后恢复。所有探针统一用这个设置，避免把"DNS 路由问题"误判成"源不可用"。
dns.setDefaultResultOrder('ipv4first');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 数值加固：拒绝 空串/数组/对象/布尔（+[]===0 陷阱），并把 '-' '--' 之类占位符判为缺失。
// 与 src/dirty.js::num 同款纪律，此处本地实现（探针脚本不依赖业务模块）。
function num(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t || t === '-' || t === '--' || t === 'null') return null;
  const n = +t;
  return Number.isFinite(n) ? n : null;
}

// ── Black-76（欧式期权，标的为期货）──────────────────────────────────────
// IO 期权是欧式、标的为沪深300期货，故用 Black-76 而非 Black-Scholes（后者需 S 与 q）。
// 标准正态 CDF 用 Abramowitz-Stegun 近似（精度 ~1e-7），足够隐波反解用。
function erf(x) {
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
const ncdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
const npdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

function black76(F, K, T, r, sigma, type) {
  const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  const disc = Math.exp(-r * T);
  return type === 'C'
    ? disc * (F * ncdf(d1) - K * ncdf(d2))
    : disc * (K * ncdf(-d2) - F * ncdf(-d1));
}
function vega(F, K, T, r, sigma) {
  const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * T) / (sigma * Math.sqrt(T));
  return Math.exp(-r * T) * F * npdf(d1) * Math.sqrt(T);
}
// 反解 IV：牛顿法 + 二分兜底（牛顿对深度虚值会跳出正 sigma 域）
function impliedVol(price, F, K, T, r, type) {
  const intrinsic = (type === 'C' ? Math.max(0, F - K) : Math.max(0, K - F)) * Math.exp(-r * T);
  if (!(price > intrinsic + 1e-9)) return null; // 低于内在价值 → 该报价不可用（不是"算不出"）
  let s = 0.25;
  for (let i = 0; i < 60; i++) {
    const diff = black76(F, K, T, r, s, type) - price;
    if (Math.abs(diff) < 1e-6) return s;
    const v = vega(F, K, T, r, s);
    if (!(Math.abs(v) > 1e-8)) break;
    s = s - diff / v;
    if (!(s > 0) || s > 5) { s = 0.25; break; }
  }
  let lo = 0.001, hi = 3.0;
  const f = (x) => black76(F, K, T, r, x, type) - price;
  if (f(lo) * f(hi) > 0) return null;
  for (let i = 0; i < 100; i++) { const mid = (lo + hi) / 2; if (f(lo) * f(mid) <= 0) hi = mid; else lo = mid; }
  return (lo + hi) / 2;
}

// ── 连通性探针（候选端点）────────────────────────────────────────────────
const TARGETS = [
  { name: '期指·新浪 IF/IC/IH 当月连续', kind: 'basis', url: 'https://hq.sinajs.cn/list=nf_IF0,nf_IC0,nf_IH0',
    headers: { Referer: 'https://finance.sina.com.cn/' }, gbk: true,
    parse: (t) => { const o = {}; for (const m of t.matchAll(/hq_str_nf_(I[FCH]0)="([^"]*)"/g)) { const f = m[2].split(','); const last = num(f[2]); if (last != null) o[m[1]] = last; } return Object.keys(o).length ? o : null; } },
  { name: '期指·东财 沪深300期指(IF当月)', kind: 'basis', url: 'https://push2.eastmoney.com/api/qt/stock/get?secid=8.040120&fields=f43,f58,f60&ut=fa5fd1943c7b386f172d6893dbfba10b',
    headers: { Referer: 'https://quote.eastmoney.com/' },
    parse: (j) => { const d = j && j.data; if (!d || num(d.f43) == null) return null; return { IF: num(d.f43) }; } },
  { name: '期指·同花顺 qihuo', kind: 'basis', url: 'https://d.10jqka.com.cn/v6/line/qh_IF0/01/2026.js',
    headers: { Referer: 'https://q.10jqka.com.cn/' }, parse: (t) => (t && t.length > 20 ? { bytes: t.length } : null) },
  { name: '现货·腾讯 沪深300/中证500/上证50', kind: 'basis', url: 'https://qt.gtimg.cn/q=sh000300,sh000905,sh000016',
    gbk: true, parse: (t) => { const o = {}; for (const m of t.matchAll(/v_(sh\d+)="([^"]*)"/g)) { const f = m[2].split('~'); if (num(f[3]) != null) o[f[1]] = num(f[3]); } return Object.keys(o).length ? o : null; } },
  { name: '期权·中金所 IO/MO 期权链', kind: 'iv', url: 'http://www.cffex.com.cn/quote_IO.txt',
    headers: { Referer: 'http://www.cffex.com.cn/' },
    parse: (t) => { if (!t || t.length < 100) return null; const n = t.trim().split('\n').length - 1; return n > 0 ? { contracts: n } : null; } },
  { name: '期权·新浪 CON_OP 单合约', kind: 'iv', url: 'https://hq.sinajs.cn/list=CON_OP_10004517',
    headers: { Referer: 'https://finance.sina.com.cn/' }, gbk: true,
    parse: (t) => { const m = t.match(/="([^"]*)"/); if (!m || m[1].split(',').length < 10) return null; return { fields: m[1].split(',').length }; } },
  { name: '期权·东财 期权列表', kind: 'iv', url: 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=5&fltt=2&fs=m:10&fields=f12,f14,f2,f330&ut=fa5fd1943c7b386f172d6893dbfba10b',
    headers: { Referer: 'https://quote.eastmoney.com/' },
    parse: (j) => { const l = j && j.data && j.data.diff; return Array.isArray(l) && l.length ? { n: l.length } : null; } },
];

async function probe(t) {
  for (let att = 0; att < 2; att++) {
    const t0 = Date.now();
    try {
      const r = await fetch(t.url, { headers: { 'User-Agent': UA, ...(t.headers || {}) } });
      const ms = Date.now() - t0;
      if (!r.ok) return `HTTP ${r.status} ${ms}ms`;
      let parsed;
      if (t.gbk) parsed = t.parse(new TextDecoder('gbk').decode(Buffer.from(await r.arrayBuffer())));
      else { const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch { /* 文本 */ } parsed = t.parse(j != null ? j : txt); }
      return parsed
        ? `HTTP 200 ${ms}ms | ✓ 可解析 | ${JSON.stringify(parsed).slice(0, 200)}`
        : `HTTP 200 ${ms}ms | ✗ 返回体解析不出数值（HTTP 200 ≠ 可用）`;
    } catch (e) {
      const code = e.cause?.code || e.name || '';
      if (att === 0) { await sleep(600); continue; }
      return `FAIL ${Date.now() - t0}ms | ${e.message}${code ? ' [' + code + ']' : ''}`;
    }
  }
}

// ── 可算性验证：升贴水 ───────────────────────────────────────────────────
async function checkBasis() {
  const futTxt = new TextDecoder('gbk').decode(Buffer.from(await (await fetch(
    'https://hq.sinajs.cn/list=nf_IF0,nf_IC0,nf_IH0', { headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' } })).arrayBuffer()));
  const fut = {};
  for (const m of futTxt.matchAll(/hq_str_nf_(I[FCH]0)="([^"]*)"/g)) { const f = m[2].split(','); fut[m[1]] = { last: num(f[2]), pre: num(f[3]) }; }
  const spotTxt = new TextDecoder('gbk').decode(Buffer.from(await (await fetch(
    'https://qt.gtimg.cn/q=sh000300,sh000905,sh000016', { headers: { 'User-Agent': UA } })).arrayBuffer()));
  const spot = {};
  for (const m of spotTxt.matchAll(/v_(sh\d+)="([^"]*)"/g)) { const f = m[2].split('~'); spot[f[1]] = { last: num(f[3]), date: (f[30] || '').slice(0, 8) }; }
  const pairs = [['IF0', '沪深300'], ['IC0', '中证500'], ['IH0', '上证50']];
  const out = [];
  for (const [fk, sk] of pairs) {
    const F = fut[fk]?.last, S = spot[sk]?.last;
    if (F == null || S == null) { out.push({ fut: fk, spot: sk, ok: false, why: '缺一端' }); continue; }
    const b = F - S;
    out.push({ fut: fk, spot: sk, futLast: F, spotLast: S, basis: +b.toFixed(2), basisPct: +(b / S * 100).toFixed(3), ok: true });
  }
  return { out, spotDate: spot['沪深300']?.date || null };
}

// ── 可算性验证：隐波 ─────────────────────────────────────────────────────
async function checkIV() {
  const futTxt = new TextDecoder('gbk').decode(Buffer.from(await (await fetch(
    'https://hq.sinajs.cn/list=nf_IF0', { headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' } })).arrayBuffer()));
  const F = num(futTxt.match(/="([^"]*)"/)[1].split(',')[2]);
  const io = await (await fetch('http://www.cffex.com.cn/quote_IO.txt', { headers: { 'User-Agent': UA, Referer: 'http://www.cffex.com.cn/' } })).text();
  const rows = io.trim().split('\n').slice(1).map((l) => l.split(','))
    .map((r) => ({ instrument: r[0], volume: num(r[2]), last: num(r[3]), bprice: num(r[5]), sprice: num(r[7]) }));
  // 取最近的 IO 月份（按合约名排序后的第一个）
  const months = [...new Set(rows.map((r) => (r.instrument.match(/^IO(\d{4})/) || [])[1]).filter(Boolean))].sort();
  const mon = months[0];
  const near = rows.filter((r) => r.instrument.startsWith('IO' + mon + '-'));
  const r = 0.018; // 无风险利率 1.8%
  // T：到期日为当月第三个周五。用合约月份推算，避免硬编码具体日期。
  const yy = 2000 + +mon.slice(0, 2), mm = +mon.slice(2, 4);
  let thirdFri = 0, cnt = 0;
  for (let d = 1; d <= 31; d++) {
    const dt = new Date(Date.UTC(yy, mm - 1, d));
    if (dt.getUTCMonth() !== mm - 1) break;
    if (dt.getUTCDay() === 5) { cnt++; if (cnt === 3) { thirdFri = d; break; } }
  }
  const expiry = Date.UTC(yy, mm - 1, thirdFri);
  const today = Date.UTC(2026, 9, 2);
  const T = (expiry - today) / 86400000 / 365;

  const ivs = []; let tried = 0, skippedBid = 0;
  for (const o of near) {
    const m = o.instrument.match(/^IO\d{4}-([CP])-(\d+)$/);
    if (!m) continue;
    const type = m[1], K = +m[2];
    const intrinsic = (type === 'C' ? Math.max(0, F - K) : Math.max(0, K - F)) * Math.exp(-r * T);
    const mid = (o.bprice > 0 && o.sprice > 0) ? (o.bprice + o.sprice) / 2 : null;
    // ⚠ 本行是本探针最重要的发现：深度实值认沽的 mid 会低于内在价值 → 换 last，仍低则跳过
    let px = (mid != null && mid > intrinsic + 1e-9) ? mid : ((o.last != null && o.last > intrinsic + 1e-9) ? o.last : null);
    if (px == null) { skippedBid++; continue; }
    tried++;
    const iv = impliedVol(px, F, K, T, r, type);
    if (iv != null) ivs.push({ K, type, iv });
  }
  ivs.sort((a, b) => Math.abs(a.K - F) - Math.abs(b.K - F));
  const atmK = ivs[0]?.K;
  const atm = ivs.filter((x) => x.K === atmK).map((x) => x.iv);
  const atmIV = atm.length ? atm.reduce((a, b) => a + b, 0) / atm.length : null;
  return { F, mon, T: +T.toFixed(4), contracts: near.length, tried, skippedBid, solved: ivs.length,
    convRate: tried ? ivs.length / tried : 0, atmK, atmIV };
}

// ── 主流程 ───────────────────────────────────────────────────────────────
console.log(`node ${process.version} | DNS 解析顺序: ${dns.getDefaultResultOrder()} (IPv4 优先)\n`);
const results = { basis: [], iv: [] };
for (const t of TARGETS) {
  const line = await probe(t);
  const ok = line.includes('✓ 可解析');
  results[t.kind].push({ name: t.name, ok });
  console.log(`${ok ? '✓' : '✗'} [${t.kind}] ${t.name}\n      ${line}\n`);
  await sleep(400);
}

console.log('═'.repeat(74));
console.log('【连通性判定】');
const sum = (k) => results[k].filter((r) => r.ok).length;
console.log(`  期指升贴水：${sum('basis') ? `连通（${sum('basis')}/${results.basis.length} 端点可取数）` : '全部不可用'}`);
console.log(`  期权隐波：  ${sum('iv') ? `连通（${sum('iv')}/${results.iv.length} 端点可取数）` : '全部不可用'}`);

console.log('\n【可算性判定 · 期指升贴水】');
try {
  const b = await checkBasis();
  for (const x of b.out) {
    if (x.ok) console.log(`  ✓ ${x.fut} ${x.futLast} − ${x.spot} ${x.spotLast} = ${x.basis} 点（${x.basisPct}%）`);
    else console.log(`  ✗ ${x.fut} vs ${x.spot}：${x.why}`);
  }
  console.log(`  → 现货日期 ${b.spotDate || 'n/a'} | 升贴水=${b.out.some((x) => x.ok) ? '可用' : '不可用 —— 该因子不纳入'}`);
} catch (e) { console.log(`  ✗ 计算失败：${e.message} → 判定不可用`); }

console.log('\n【可算性判定 · 期权隐波（Black-76 反解）】');
try {
  const v = await checkIV();
  console.log(`  IF 当月 ${v.F} | 合约月 ${v.mon} | T=${v.T} 年 | 该月合约 ${v.contracts} 个`);
  console.log(`  ⚠ 因报价低于内在价值而跳过 ${v.skippedBid} 个（深度实值认沽，源报价字段陷阱）`);
  console.log(`  尝试反解 ${v.tried} 个 · 收敛 ${v.solved} 个 · 收敛率 ${(v.convRate * 100).toFixed(0)}%`);
  console.log(`  ATM K=${v.atmK} · ATM IV=${v.atmIV != null ? (v.atmIV * 100).toFixed(2) + '%' : 'n/a'}`);
  const pass = v.convRate >= 0.95 && v.atmIV != null && v.atmIV > 0.05 && v.atmIV < 0.80;
  console.log(`  → 隐波=${pass ? '可用（需自算 Black-76，非取数）' : '不可用 —— 该因子不纳入'}`);
} catch (e) { console.log(`  ✗ 计算失败：${e.message} → 判定不可用`); }

console.log('═'.repeat(74));
console.log('注：HTTP 200 但解析不出数值一律计为不可用。探针只报连通性与可算性，不做任何编数兜底。');
