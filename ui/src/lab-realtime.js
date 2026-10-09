/* ═══════════ 实时条（JSONP 轮询 · file:// 可用 · 零代理 · 多源容错）═══════════
   主力源（稳定）: 腾讯指数 qt.gtimg.cn + 腾讯市场状态 marketStat + 东财涨停池 push2ex(带date)
   增强源（容错）: 东财涨跌家数 push2（多候选轮换，失败自动隐藏该段，不影响主体） */
(function () {
  const bar = $id('rt-bar');
  if (!bar) return;
  let seq = 0, timer = null, statOpen = null; // statOpen: true=开市 false=休市 null=未知
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ── 跨域加载（file:// 下唯一可靠方案）──
  // 模式 A: 回调式 JSONP（东财: 返回 cb({...})）
  function jsonp(url, cbParam) {
    return new Promise((resolve, reject) => {
      const name = '_asentRtCb' + (++seq);
      const s = document.createElement('script');
      const done = fn => { try { fn(); } catch (e) {} try { delete window[name]; } catch (e) { window[name] = undefined; } s.remove(); clearTimeout(tmo); };
      const tmo = setTimeout(() => done(() => reject(new Error('timeout'))), 9000);
      window[name] = data => done(() => resolve(data));
      s.onerror = () => done(() => reject(new Error('network')));
      s.referrerPolicy = 'no-referrer';
      s.src = url + (url.includes('?') ? '&' : '?') + cbParam + '=' + name + '&_=' + Date.now();
      document.head.appendChild(s);
    });
  }
  // 模式 B: 变量捕获式（腾讯 qt.gtimg.cn: 忽略 callback 参数, 返回 var v_xxx="..." 裸赋值）
  function jsonpVar(url, varNames) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      const done = fn => { try { fn(); } catch (e) {} s.remove(); clearTimeout(tmo); };
      const tmo = setTimeout(() => done(() => reject(new Error('timeout'))), 9000);
      s.onload = () => done(() => {
        const out = {};
        varNames.forEach(n => { try { out[n] = window[n]; } catch (e) {} });
        resolve(out);
      });
      s.onerror = () => done(() => reject(new Error('network')));
      s.referrerPolicy = 'no-referrer';
      s.src = url + (url.includes('?') ? '&' : '?') + '_=' + Date.now();
      document.head.appendChild(s);
    });
  }

  // ── 数据源 ──
  async function fetchIdx() {
    const res = await jsonpVar('https://qt.gtimg.cn/q=sh000001,sz399001,sz399006', ['v_sh000001', 'v_sz399001', 'v_sz399006']);
    const out = {};
    Object.values(res).forEach(raw => {
      const f = String(raw || '').split('~');
      if (f.length > 32 && f[3]) out[f[2]] = { name: f[1], px: +f[3], chg: +f[31], pct: +f[32], time: f[30] };
    });
    if (!Object.keys(out).length) throw new Error('idx parse fail');
    return out;
  }
  async function fetchStat() {
    try {
      const res = await jsonpVar('https://qt.gtimg.cn/q=marketStat', ['v_marketStat']);
      const m = String(res.v_marketStat || '').match(/^([^|]*)\|/);
      if (!m) return null;
      const parts = String(res.v_marketStat).split('|');
      const sh = parts.find(p => p.indexOf('SH_') === 0) || '';
      const seg = sh.split('_');
      return { status: seg[1], reason: seg[2] || '', time: parts[0] || '' };
    } catch (e) { return null; }
  }
  async function fetchBreadth() {
    // v4.9.17: 沪深双 secid 相加——旧版只查 1.000001（沪市单市, 9/30 实锤显示 1223/1065, 全市场应为 2567/2824）
    const candidates = [
      'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=1.000001,0.399001&fields=f104,f105,f106'
    ];
    for (const u of candidates) {
      try {
        const d = await jsonp(u, 'cb');
        const arr = d && d.data && Array.isArray(d.data.diff) ? d.data.diff : null;
        if (arr && arr.length >= 2) {
          let up = 0, down = 0, ok = true;
          for (const it of arr) {
            if (it.f104 == null || it.f105 == null || (it.f104 + it.f105) <= 0) { ok = false; break; }
            up += it.f104; down += it.f105;
          }
          if (ok) return { up: Math.round(up), down: Math.round(down) };
        }
      } catch (e) { /* 换下一个候选 */ }
    }
    return null;
  }
  async function fetchZTPool() {
    const dt = CUR.trade_date.replace(/-/g, '');
    try {
      const d = await jsonp('https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=5&sort=fbt%3Aasc&date=' + dt, 'cb');
      if (!d || !d.data || !d.data.pool) return null;
      const pool = d.data.pool || [];
      const qd = String(d.data.qdate || '');
      return { count: d.data.tc != null ? d.data.tc : pool.length, date: qd.length === 8 ? qd.slice(4, 6) + '-' + qd.slice(6) : '', top: pool.slice(0, 3).map(p => p.n) };
    } catch (e) { return null; }
  }
  // v4.9: 跌停池（盘中情绪分涨跌停结构维用; 失败静默——该维自动降权重）
  async function fetchDTPool() {
    const dt = CUR.trade_date.replace(/-/g, '');
    try {
      const d = await jsonp('https://push2ex.eastmoney.com/getTopicDTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=5&sort=fund%3Aasc&date=' + dt, 'cb');
      if (!d || !d.data || !d.data.pool) return null;
      return { count: d.data.tc != null ? d.data.tc : d.data.pool.length };
    } catch (e) { return null; }
  }

  // ── 交易时段（本地规则兜底；marketStat 优先）──
  function localSession() {
    const n = new Date(), day = n.getDay();
    if (day === 0 || day === 6) return false;
    const hm = n.getHours() * 100 + n.getMinutes();
    return (hm >= 915 && hm <= 1135) || (hm >= 1255 && hm <= 1505);
  }
  const isOpen = () => statOpen === true || (statOpen == null && localSession());

  function fmtIdx(o) {
    if (!o) return '<span class="dim">—</span>';
    const c = o.pct > 0 ? 'up' : o.pct < 0 ? 'down' : '';
    return `<b class="num">${o.px.toFixed(2)}</b> <span class="num ${c}" style="font-weight:700">${o.pct > 0 ? '+' : ''}${o.pct.toFixed(2)}%</span>`;
  }

  // 分通道渲染: 各数据源独立补充，互不阻塞（谁先到谁先显示）
  const state = { idx: null, stat: null, breadth: null, zt: null, dt: null };
  const setMsg = t => { const s = bar.querySelector('#rt-status'); if (s) s.innerHTML = t; };

  function renderAll() {
    const { idx, stat, breadth, zt } = state;
    if (!idx) return; // 主通道未到，保持「连接中」
    const segs = [];
    if (stat && stat.status !== 'open') segs.push(`<span class="gold" style="font-weight:700">🏮 ${esc(stat.reason) || '休市'}</span>`);
    segs.push(`<span>上证 ${fmtIdx(idx['000001'])}</span>`, `<span>深成 ${fmtIdx(idx['399001'])}</span>`, `<span>创业板 ${fmtIdx(idx['399006'])}</span>`);
    if (breadth) segs.push(`<span>涨/跌 <span class="up num">${breadth.up}</span>/<span class="down num">${breadth.down}</span></span>`);
    if (zt) segs.push(`<span>涨停 <b class="up num">${zt.count}</b><span class="dim" style="font-size:10.5px">（${esc(zt.date)}）</span></span>` +
      (zt.top && zt.top.length ? `<span class="dim" style="font-size:11px">前排: ${zt.top.map(esc).join('·')}</span>` : ''));
    // v4.9 盘中情绪（实时估值）: 指数40 + 广度35 + 涨跌停25——与收盘七因子口径不同, 显式标注「估值」
    const sc = isOpen() ? intradayScore() : null;
    if (sc != null) segs.push(`<span>盘中情绪 <b class="num ${sc >= 60 ? 'up' : sc <= 40 ? 'down' : ''}" style="font-size:15px" title="盘中实时估值 = 指数涨跌(40%) + 涨跌家数(35%) + 涨跌停结构(25%)。与收盘七因子口径不同, 仅供盘中参考, 不可与收盘情绪分直接对比。"> ${sc}</b><span class="dim" style="font-size:10px"> 估值</span></span>`);
    const dataEl = bar.querySelector('#rt-data');
    if (dataEl) dataEl.innerHTML = segs.join('');
    const open = isOpen();
    setMsg(`<span class="${open ? 'up' : 'dim'}">● ${open ? '实时' : esc(stat && stat.reason ? stat.reason : '盘外快照')}</span> · <span class="num dim" style="font-size:11px">${timeStr()}</span>`);
  }
  function timeStr() {
    const t = (state.idx && (state.idx['000001'] || {}).time) || '';
    return t.length >= 14 ? t.replace(/^(\d{8})(\d{2})(\d{2})(\d{2}).*/, (m, d, h, mi, se) => d.slice(4, 6) + '-' + d.slice(6) + ' ' + h + ':' + mi + ':' + se) : new Date().toTimeString().slice(0, 8);
  }

  // ── v4.9 盘中情绪分（实时估值）: 指数40 + 广度35 + 涨跌停25（缺维自动降权重, 不硬凑）──
  function intradayScore() {
    const cl = v => Math.max(0, Math.min(100, v));
    const idxs = state.idx ? [state.idx['000001'], state.idx['399001'], state.idx['399006']].filter(Boolean) : [];
    if (!idxs.length) return null;
    const avg = idxs.reduce((a, o) => a + o.pct, 0) / idxs.length;
    const parts = [[cl(50 + avg * 16.7), 40]]; // 三指数均涨跌 ±3% → 0/100
    if (state.breadth && (state.breadth.up + state.breadth.down) > 0) {
      parts.push([state.breadth.up / (state.breadth.up + state.breadth.down) * 100, 35]);
    }
    if (state.zt && state.dt) { // 涨跌停结构与收盘 s_zdt 同公式
      const zt = state.zt.count || 0, dtc = state.dt.count || 0;
      parts.push([cl((zt + 2) / (zt + dtc + 4) * 100), 25]);
    }
    const w = parts.reduce((a, p) => a + p[1], 0);
    return Math.round(parts.reduce((a, p) => a + p[0] * p[1], 0) / w);
  }

  function refresh() {
    // 分通道 fire-and-forget: 各源独立渲染先到先显示；并发无害（渲染幂等）
    fetchIdx().then(d => { state.idx = d; renderAll(); }).catch(() => {
      if (!state.idx) setMsg('<span class="down">实时接口不可达</span> · <span class="dim">稍后自动重试</span>');
    });
    fetchStat().then(d => { state.stat = d; if (d) statOpen = d.status === 'open'; renderAll(); }).catch(() => {});
    fetchBreadth().then(d => { state.breadth = d; renderAll(); }).catch(() => {});
    fetchZTPool().then(d => { state.zt = d; renderAll(); }).catch(() => {});
    fetchDTPool().then(d => { state.dt = d; renderAll(); }).catch(() => {});
  }

  // ── v4.9 分时段轮询: 开盘/收盘前后 8s · 盘中 30s · 午休/盘外停（交易所状态说开市则 30s 兜底）──
  // 原固定 30s setInterval → 递归 setTimeout 链, 每次重算时段间隔
  function pollMs() {
    if (statOpen === false) return 0;
    const n = new Date(), hm = n.getHours() * 100 + n.getMinutes(), day = n.getDay();
    if (day === 0 || day === 6) return 0;
    if ((hm >= 915 && hm <= 935) || (hm >= 1445 && hm <= 1505)) return 8000;  // 竞价+开盘 20 分钟 / 尾盘竞价前后
    if ((hm > 935 && hm <= 1135) || (hm > 1255 && hm < 1445)) return 30000;  // 盘中常规
    return statOpen === true ? 30000 : 0;                                     // 午休/盘外停
  }
  function schedule() {
    if (timer) { clearTimeout(timer); timer = null; }
    const ms = pollMs();
    if (!ms) return;
    timer = setTimeout(() => { if (!document.hidden) refresh(); schedule(); }, ms);
  }
  // v4.9.6: 看门狗只在轮询链已停(timer=null)时补启——否则整分钟对齐会把
  // 尚未到期的链上定时器 clearTimeout 重排, 30s 链被打成 60s 稳态(0929 实测复现)
  function startStop() { if (!timer) schedule(); }

  $id('rt-refresh').onclick = () => { refresh(); LAB.toast('正在拉取实时快照…'); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); startStop(); } });

  refresh();
  startStop();
  setInterval(startStop, 60000); // 每分钟检查开闭市状态，跨开盘/收盘边界自动启停

  /* ── v4.4 前端实时增强: 全市场快照 → 量能拆分 + 行业/题材内部涨跌比 ──
     push2 clist JSONP 分页; 盘后/休市返回最近收盘快照与存档日一致;
     全链路静默容错: 失败保持占位符, 不影响主体（与上方增强源同模式） */
  /* ── v4.8.7 量能拆分：上涨/下跌股票的成交额（原 push2 全市场快照已不可用）
     改为腾讯批量行情逐股汇总：全市场 ~5400 只 → 90 批（并行度 3 约 10 秒）
     仅在开市时段执行（收盘后快照与存档日重复，无增量价值）；失败静默降级不影响主体 */
  const ALL_MKT = (() => {
    const out = [];
    const push = (pre, from, to) => { for (let i = from; i <= to; i++) out.push(pre + String(i).padStart(6, '0')); };
    // 号段实测有效率: 沪主板 42% / 科创 61% / 深主板 54% / 创业板 71%（空号属正常，A股代码不连续）
    push('sh', 600000, 603999); push('sh', 605000, 605600);   // 沪主板
    push('sh', 688000, 688999);                                // 科创板
    push('sz', 1, 2999);                                       // 深主板（含原中小板）
    push('sz', 300000, 301999);                                // 创业板
    return out;
  })();
  async function fetchAmtSplit() {
    let upAmt = 0, downAmt = 0, up = 0, down = 0, got = 0;
    const batches = [];
    for (let i = 0; i < ALL_MKT.length; i += 60) batches.push(ALL_MKT.slice(i, i + 60));
    const CONC = 3;
    for (let i = 0; i < batches.length; i += CONC) {
      const grp = batches.slice(i, i + CONC);
      const res = await Promise.all(grp.map(async b => {
        try {
          const r = await jsonpVar('https://qt.gtimg.cn/q=' + b.join(','), b.map(s => 'v_' + s));
          return r;
        } catch (e) { return null; }
      }));
      res.forEach(r => {
        if (!r) return;
        Object.values(r).forEach(raw => {
          const f = String(raw || '').split('~');
          if (f.length < 38) return;
          const chg = parseFloat(f[32]), amtWan = parseFloat(f[37]);
          if (!isFinite(chg) || !isFinite(amtWan) || amtWan <= 0) return;
          got++;
          if (chg > 0) { up++; upAmt += amtWan * 1e4; } else if (chg < 0) { down++; downAmt += amtWan * 1e4; }
        });
      });
      if (i + CONC < batches.length) await new Promise(r => setTimeout(r, 100));
    }
    if (got < 1000) throw new Error('amt split incomplete: ' + got);
    return { upAmt, downAmt, up, down, got };
  }
  async function fetchMkt() {
    const res = await jsonpVar('https://qt.gtimg.cn/q=sh000001,sz399001', ['v_sh000001', 'v_sz399001']);
    let amtWan = 0, ok = false;
    Object.values(res).forEach(raw => {
      const f = String(raw || '').split('~');
      const v = parseFloat(f[37]);
      if (f.length > 37 && isFinite(v) && v > 0) { amtWan += v; ok = true; }
    });
    if (!ok) throw new Error('amount source unavailable');
    const out = { amountYi: amtWan / 1e4, ind: new Map(), upAmt: null, downAmt: null, at: Date.now() };
    if (isOpen()) {  // 仅开市时段做逐股汇总
      try {
        const sp = await fetchAmtSplit();
        out.upAmt = sp.upAmt; out.downAmt = sp.downAmt; out.up = sp.up; out.down = sp.down; out.got = sp.got;
      } catch (e) { /* 汇总失败保持 null → fillV44 不渲染该段 */ }
    }
    return out;
  }
  /* ── v4.8.7 实时增强换源（原 push2.eastmoney.com 全系被限流 → HTTP 000）
     新组合: 东财 datacenter-web（板块成分股映射, 支持 JSONP 回调）
           + 腾讯 qt.gtimg.cn（个股批量行情, 变量式注入）
     匹配策略: 题材名精确匹配东财板块库 + 样本量校验（≥20 只才算真板块）
     未匹配的题材不硬凑，明确标注「事件驱动型标签」并加悬停说明，绝不误导 */

  // 腾讯批量行情: 一次最多 60 只（URL 长度与限流平衡），返回 {code: changePct}
  function symOf(code) {
    return code.startsWith('6') ? 'sh' + code : (code.startsWith('8') || code.startsWith('4')) ? 'bj' + code : 'sz' + code;
  }
  async function txBatch(codes) {
    const out = {};
    for (let i = 0; i < codes.length; i += 60) {
      const batch = codes.slice(i, i + 60);
      const names = batch.map(c => 'v_' + symOf(c));
      try {
        const res = await jsonpVar('https://qt.gtimg.cn/q=' + batch.map(symOf).join(','), names);
        Object.values(res).forEach(raw => {
          const f = String(raw || '').split('~');
          if (f.length > 32 && f[2]) out[f[2]] = parseFloat(f[32]);
        });
      } catch (e) { /* 单批失败不中断后续 */ }
      if (i + 60 < codes.length) await new Promise(r => setTimeout(r, 120));
    }
    return out;
  }

  // 已知东财无对应标准板块的事件驱动型题材名（用于精准标注而非含糊占位）
  const EVENT_TAG_HINT = '该题材是「事件驱动型标签」（如同花顺按当日新闻/公告聚合），东财标准板块库里没有对应条目，因此无法统计内部涨跌比。';
  const BOARD_TAG_HINT = '该题材对应东财标准概念板块，统计其全部成分股当日涨跌（含下跌成员），用于甄别「指数涨但题材内部塌方」的假繁荣。';

  async function fillTopics() {
    const tds = [...document.querySelectorAll('td.v44bd[data-topic]')];
    if (!tds.length) return;
    for (const td of tds) {
      const tag = td.getAttribute('data-topic') || '';
      if (!tag) continue;
      try {
        // 1) 精确匹配东财板块（filter 用双引号等值，避免 111 页式的模糊过度匹配）
        const enc = encodeURIComponent('"' + tag + '"');
        const cl = await jsonp('https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_F10_CORETHEME_BOARDTYPE&columns=SECURITY_CODE&filter=(BOARD_NAME=' + enc + ')&pageSize=500&pageNumber=1', 'callback');
        const rows = (cl && cl.success && cl.result && Array.isArray(cl.result.data)) ? cl.result.data : [];
        const codes = rows.map(r => r.SECURITY_CODE).filter(Boolean);
        // 2) 样本量校验: 少于 20 只视为「无有效板块」而非硬凑
        if (codes.length >= 20) {
          const q = await txBatch(codes);
          const vals = codes.map(c => q[c]).filter(v => isFinite(v));
          if (vals.length >= 20) {
            const ups = vals.filter(v => v > 0).length;
            const ratio = Math.round(ups / vals.length * 100);
            const color = ratio >= 60 ? '#ff8a8a' : ratio < 40 ? '#6ea86e' : '#c6cfdd';
            td.innerHTML = '<span class="num" style="color:' + color + ';font-weight:700">' + ratio + '%</span>' +
              '<span class="dim" style="font-size:9.5px;display:block">' + vals.length + '只' + (ratio < 40 ? ' · 独涨' : '') + '</span>';
            td.title = BOARD_TAG_HINT + '（本题材匹配到 ' + vals.length + ' 只成分股，' + ups + ' 只上涨）';
            td.dataset.v44src = 'board';
          }
        } else {
          // 3) 无对应板块 → 明确标注 + 悬停说明
          td.innerHTML = '<span class="dim" style="font-size:10px;cursor:help">事件型 · 无板块</span>';
          td.title = EVENT_TAG_HINT;
          td.dataset.v44src = 'event';
        }
      } catch (e) {
        // 单题材失败: 保持占位但给出可重试说明，不静默留 — 让人困惑
        td.innerHTML = '<span class="dim" style="font-size:10px;cursor:help">暂无</span>';
        td.title = '实时行情源暂时不可用，页面刷新后会自动重试。';
      }
      await new Promise(r => setTimeout(r, 120));
    }
  }
  function fillV44(m) {
    if (!m) return;
    const yi = v => (v / 1e8).toFixed(0);
    const amtSub = document.querySelector('#kpi-amt .sub');
    if (amtSub && m.upAmt != null && m.downAmt != null) {
      const kill = m.downAmt > m.upAmt * 1.5 ? ' · <b style="color:#6ea86e">放量杀跌</b>' : '';
      const counts = (m.up != null && m.down != null) ? '（' + m.up + '涨 / ' + m.down + '跌）' : '';
      amtSub.innerHTML += ' · 上涨股 ¥' + yi(m.upAmt) + '亿 / 下跌股 ¥' + yi(m.downAmt) + '亿' + counts + kill;
    }
    const indSub = document.querySelector('#kpi-ind .sub');
    if (indSub && m.ind && m.ind.size) {
      const rows = [...m.ind.entries()].map(([n, v]) => ({ n, r: v.u / v.t })).filter(x => x.r >= 0).sort((a, b) => b.r - a.r);
      if (rows.length) indSub.innerHTML += ' · 内部涨跌比 最强 ' + esc(rows[0].n) + ' ' + Math.round(rows[0].r * 100) + '% / 最弱 ' + esc(rows[rows.length - 1].n) + ' ' + Math.round(rows[rows.length - 1].r * 100) + '%';
    }
  }
  setTimeout(() => {
    // 两条链路彼此独立：量能取不到不再阻断题材内部涨跌比（原实现串在 then 里，前置失败导致题材永远空）
    fetchMkt().then(m => { window.__v44mkt = m; fillV44(m); }).catch(() => {});
    fillTopics().catch(() => {});
  }, 1500);
  window.__testFillV44 = fillV44; // 测试钩子（供探针验证休市时的渲染分支）
})();
