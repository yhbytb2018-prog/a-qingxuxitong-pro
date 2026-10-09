// 数据源连通性探针：诊断各上游接口可达性（尤其 IPv4/IPv6 路由差异）
// 用法: node scripts/probe_sources.mjs
import dns from 'node:dns';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TARGETS = [
  {
    name: 'breadth 涨跌家数(东财 push2 ulist.np)',
    url: 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=1.000001,0.399001&fields=f104,f105,f106&ut=fa5fd1943c7b386f172d6893dbfba10b',
    headers: { Referer: 'https://quote.eastmoney.com/' },
    check: (j) => { const d = j?.data?.diff; return d?.[0] ? `diff=${d.length} 涨${d[0].f104} 跌${d[0].f105} 平${d[0].f106}` : 'NO_DIFF'; },
    json: true,
  },
  {
    name: '涨停池(东财 push2ex)',
    url: 'https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=500&sort=fbt%3Aasc&date=20260929',
    headers: { Referer: 'https://quote.eastmoney.com/' },
    check: (j) => `涨停下家数=${j?.data?.tc ?? 'null'}`,
    json: true,
  },
  {
    name: '腾讯指数行情(qt.gtimg.cn)',
    url: 'https://qt.gtimg.cn/q=sh000001,sz399001,sz399006',
    gbk: true,
    check: (t) => { const m = t.match(/v_sh000001="[^"]*"/); return m ? m[0].slice(0, 60) : 'NO_MATCH'; },
  },
  {
    name: '同花顺行业列表(q.10jqka.com.cn)',
    url: 'https://q.10jqka.com.cn/thshy/',
    headers: { Referer: 'https://q.10jqka.com.cn/' },
    gbk: true,
    check: (t) => `html ${t.length}B 板块链接=${(t.match(/881\d{3}/g) || []).length}`,
  },
  {
    name: '同花顺强势股(zx.10jqka.com.cn)',
    url: 'https://zx.10jqka.com.cn/event/api/getharden',
    headers: { Referer: 'https://zx.10jqka.com.cn/' },
    check: (j) => `数据条数=${(j?.data || []).length}`,
    json: true,
  },
  {
    name: '东财龙虎榜(datacenter-web)',
    url: 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_DAILYBILLBOARD_DETAILSNEW&columns=ALL&pageSize=5&pageNumber=1&sortColumns=SECURITY_CODE&sortTypes=1&filter=(TRADE_DATE%3D%272026-09-29%27)',
    headers: { Referer: 'https://data.eastmoney.com/' },
    check: (j) => `榜单条数=${(j?.result?.data || []).length}`,
    json: true,
  },
];

async function fetchOnce(t) {
  const r = await fetch(t.url, { headers: { 'User-Agent': UA, ...(t.headers || {}) } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  if (t.gbk) {
    const buf = Buffer.from(await r.arrayBuffer());
    return t.check(new TextDecoder('gbk').decode(buf));
  }
  const j = await r.json();
  return t.check(j);
}

async function probe(tag) {
  console.log(`\n===== ${tag} =====`);
  for (const t of TARGETS) {
    let line = '';
    for (let att = 0; att < 2; att++) {
      const t0 = Date.now();
      try {
        const detail = await fetchOnce(t);
        line = `HTTP 200 ${Date.now() - t0}ms | ${detail}`;
        break;
      } catch (e) {
        const code = e.cause?.code || e.name || '';
        line = `FAIL ${Date.now() - t0}ms | ${e.message}${code ? ' [' + code + ']' : ''}`;
        if (att === 0) await sleep(500);
      }
    }
    console.log(`  ${line.startsWith('HTTP') ? '✓' : '✗'} ${t.name}\n      ${line}`);
  }
}

console.log(`node ${process.version} | 默认 DNS 解析顺序: ${dns.getDefaultResultOrder()}`);
await probe('默认解析顺序（Node fetch 现状）');
dns.setDefaultResultOrder('ipv4first');
console.log(`\n>>> setDefaultResultOrder('ipv4first') | 现在: ${dns.getDefaultResultOrder()}`);
await probe('强制 IPv4 优先后');
