/* ═══ lab-kline v4.8: 全市场K线库（仓库分片 + IndexedDB 缓存 + 任意A股蜡烛图）═══ */
(function () {
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const todayStr = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

  // ── IndexedDB（分片当日缓存；file:// 等无 IDB 环境自动降级直连）──
  let _dbP = null;
  function idb() {
    if (_dbP) return _dbP;
    _dbP = new Promise(resolve => {
      try {
        if (!window.indexedDB) return resolve(null);
        const rq = indexedDB.open('asent-kline', 1);
        rq.onupgradeneeded = () => rq.result.createObjectStore('shards', { keyPath: 'c' });
        rq.onsuccess = () => resolve(rq.result);
        rq.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
    return _dbP;
  }
  function idbGet(code) {
    return idb().then(db => new Promise((resolve, reject) => {
      if (!db) return reject(new Error('no idb'));
      const rq = db.transaction('shards').objectStore('shards').get(code);
      rq.onsuccess = () => resolve(rq.result || null); rq.onerror = () => reject(rq.error);
    }));
  }
  function idbPut(val) {
    return idb().then(db => new Promise((resolve, reject) => {
      if (!db) return reject(new Error('no idb'));
      const rq = db.transaction('shards', 'readwrite').objectStore('shards').put(val);
      rq.onsuccess = resolve; rq.onerror = () => reject(rq.error);
    }));
  }

  // ── 清单懒加载（localStorage 当日缓存；file:// 拉取失败静默降级）──
  let _list = null, _listP = null;
  function getList() {
    if (_list) return Promise.resolve(_list);
    if (_listP) return _listP;
    _listP = (async () => {
      if (location.protocol === 'file:') { _list = { codes: [], offline: true, day: todayStr() }; _s6Touch('fail'); return _list; } // file:// 下 fetch 必被 CORS 拦截，直接降级不产生噪音
      try {
        const cached = JSON.parse(localStorage.getItem('asent.v48.klist') || 'null');
        if (cached && cached.day === todayStr() && cached.codes && cached.codes.length) { _list = cached; _s6Touch('ok'); return _list; }
      } catch (e) {}
      try {
        const res = await fetch('kline/_list.json');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const j = await res.json();
        _list = { codes: j.codes || [], generatedAt: j.generatedAt || '', day: todayStr() };
        try { localStorage.setItem('asent.v48.klist', JSON.stringify(_list)); } catch (e) {}
        _s6Touch('ok');
      } catch (e) {
        _list = { codes: [], offline: true, day: todayStr() };
        _s6Touch('fail');
      }
      return _list;
    })();
    return _listP;
  }

  // ── 分片获取（IndexedDB 当日缓存 → Pages 静态分片）──
  async function getShard(code) {
    if (location.protocol === 'file:') throw new Error('本地 file:// 环境不支持K线拉取（线上可用）');
    try { const v = await idbGet(code); if (v && v.day === todayStr() && v.bars && v.bars.length) return v; } catch (e) {}
    const res = await fetch('kline/' + code + '.json');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    if (!j || !Array.isArray(j.bars) || !j.bars.length) throw new Error('空分片');
    const val = { c: j.c || code, n: j.n || '', bars: j.bars, day: todayStr() };
    try { await idbPut(val); } catch (e) {}
    return val;
  }

  // ── 蜡烛图 SVG（红涨绿跌 · MA5/MA10 · 量带 · 右侧价轴）──
  function candleSVG(bars, n) {
    const pts = bars.slice(-n);
    if (pts.length < 3) return '<div class="dim" style="padding:30px;text-align:center">数据不足</div>';
    const W = 800, H = 360, L = 10, R = W - 70;
    const PA = { t: 14, b: 250 }, VA = { t: 266, b: 336 };
    const highs = pts.map(p => p[3]), lows = pts.map(p => p[4]);
    let mn = Math.min.apply(null, lows), mx = Math.max.apply(null, highs);
    const pad = (mx - mn) * 0.05 || mx * 0.01; mn -= pad; mx += pad;
    const stepX = (R - L) / pts.length, cw = Math.max(stepX * 0.62, 1.5);
    const y = v => PA.t + (mx - v) / (mx - mn) * (PA.b - PA.t);
    const ma = k => pts.map((_, i) => { if (i < k - 1) return null; let s = 0; for (let j = i - k + 1; j <= i; j++) s += pts[j][2]; return s / k; });
    const ma5 = ma(5), ma10 = ma(10);
    const maPath = arr => { let d = '', started = false; arr.forEach((v, i) => { if (v == null) return; d += (started ? 'L' : 'M') + (L + stepX * (i + 0.5)).toFixed(1) + ',' + y(v).toFixed(1); started = true; }); return d; };
    let grid = '';
    for (let g = 0; g <= 4; g++) {
      const yy = PA.t + (PA.b - PA.t) * g / 4;
      grid += `<line x1="${L}" y1="${yy}" x2="${R}" y2="${yy}" stroke="#1c2434" stroke-width="1"/><text x="${R + 6}" y="${yy + 4}" fill="#5a6a80" font-size="10">${(mx - (mx - mn) * g / 4).toFixed(2)}</text>`;
    }
    for (let g = 0; g <= 2; g++) { const yy = VA.t + (VA.b - VA.t) * g / 2; grid += `<line x1="${L}" y1="${yy}" x2="${R}" y2="${yy}" stroke="#1c2434" stroke-width="1"/>`; }
    let candles = '', vols = '', labels = '';
    const vmax = Math.max.apply(null, pts.map(p => p[5])) || 1;
    const lblEvery = Math.ceil(pts.length / 6);
    pts.forEach((b, i) => {
      const cx = L + stepX * (i + 0.5), up = b[2] >= b[1], col = up ? '#ff5a5a' : '#2fbf8f';
      const yO = y(b[1]), yC = y(b[2]), top = Math.min(yO, yC), hgt = Math.max(Math.abs(yC - yO), 1);
      candles += `<line x1="${cx.toFixed(1)}" y1="${y(b[3]).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${y(b[4]).toFixed(1)}" stroke="${col}" stroke-width="1"/><rect x="${(cx - cw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${cw.toFixed(1)}" height="${hgt.toFixed(1)}" fill="${up ? '#12151d' : col}" stroke="${col}" stroke-width="1"/>`;
      const vh = (b[5] / vmax) * (VA.b - VA.t);
      vols += `<rect x="${(cx - cw / 2).toFixed(1)}" y="${(VA.b - vh).toFixed(1)}" width="${cw.toFixed(1)}" height="${vh.toFixed(1)}" fill="${col}" opacity="0.55"/>`;
      if (i % lblEvery === 0) labels += `<text x="${cx.toFixed(0)}" y="${H - 4}" fill="#5a6a80" font-size="10" text-anchor="middle">${b[0].slice(5)}</text>`;
    });
    const last = pts[pts.length - 1];
    return `<svg class="km-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
      ${grid}${candles}${vols}
      <path d="${maPath(ma5)}" fill="none" stroke="#c9a04e" stroke-width="1.2"/>
      <path d="${maPath(ma10)}" fill="none" stroke="#7aa2f7" stroke-width="1.2"/>
      <text x="${R + 6}" y="${(y(last[2]) + 4).toFixed(1)}" fill="#e8edf5" font-size="11" font-weight="700">${last[2].toFixed(2)}</text>
      ${labels}
      <text x="${L}" y="${VA.t - 6}" fill="#5a6a80" font-size="10">成交量</text>
      <text x="${L + 64}" y="12" fill="#c9a04e" font-size="10">MA5</text><text x="${L + 100}" y="12" fill="#7aa2f7" font-size="10">MA10</text>
    </svg>`;
  }

  // ── v4.9.8 实时快照（腾讯行情 JSONP · 与 rt 条同源）──
  function qtQuote(code) {
    return new Promise((resolve, reject) => {
      if (location.protocol === 'file:') return reject(new Error('file:// 环境不可用'));
      const m = /^(sh|sz|bj)?(\d{6})$/.exec(String(code)) || [];
      if (!m[2]) return reject(new Error('代码格式无法识别: ' + code));
      const market = m[1] || (m[2][0] === '6' ? 'sh' : 'sz');   // 兼容 sh600519 / 600519 两种入参
      const vname = 'v_' + market + m[2];
      const s = document.createElement('script');
      const fail = e => { clearTimeout(t); delete window[vname]; s.remove(); reject(e); };
      const t = setTimeout(() => fail(new Error('timeout')), 8000);
      s.onload = () => {
        clearTimeout(t);
        const raw = window[vname]; s.remove(); delete window[vname];
        if (!raw || typeof raw !== 'string') return reject(new Error('空响应'));
        const f = raw.split('~');
        const num = i => { const v = parseFloat(f[i]); return isFinite(v) ? v : null; };
        const q = {
          name: f[1] || '', price: num(3), prevClose: num(4), open: num(5),
          time: f[30] || '', chg: num(31), chgPct: num(32), high: num(33), low: num(34),
          amountWan: num(37), turnover: num(38), pe: num(39), amp: num(43),
          floatCap: num(44), cap: num(45), pb: num(46), zt: num(47), dt: num(48), volRatio: num(49)
        };
        q.price != null ? resolve(q) : reject(new Error('字段缺失'));
      };
      s.onerror = () => fail(new Error('加载失败'));
      s.src = 'https://qt.gtimg.cn/q=' + market + m[2];
      document.head.appendChild(s);
    });
  }
  const qtHTML = q => {
    const up = '#ff5a5a', dn = '#2fbf8f', cc = v => v >= 0 ? up : dn;
    const f2 = v => v == null ? '—' : v.toFixed(2), f0 = v => v == null ? '—' : v.toFixed(0);
    const cell = (k, v, color) => `<div style="padding:5px 10px;border-right:1px solid #1c2434;border-bottom:1px solid #1c2434"><div style="font-size:10.5px;color:#5a6a80">${k}</div><div class="num" style="font-size:13px;font-weight:700;${color ? 'color:' + color : ''}">${v}</div></div>`;
    const tstr = (q.time || '').replace(/^(\d{8})(\d{2})(\d{2})(\d{2}).*$/, '$2:$3:$4');
    return `<div style="display:grid;grid-template-columns:repeat(5,1fr);border:1px solid #1c2434;border-radius:8px;overflow:hidden;font-size:12px">
      ${cell('现价 ' + tstr, f2(q.price), q.chgPct >= 0 ? up : dn)}
      ${cell('涨跌幅', (q.chgPct >= 0 ? '+' : '') + f2(q.chgPct) + '%', cc(q.chgPct))}
      ${cell('今开 / 昨收', f2(q.open) + ' / ' + f2(q.prevClose))}
      ${cell('最高 / 最低', f2(q.high) + ' / ' + f2(q.low))}
      ${cell('振幅', f2(q.amp) + '%')}
      ${cell('成交额', q.amountWan == null ? '—' : (q.amountWan / 10000).toFixed(2) + ' 亿')}
      ${cell('换手率', f2(q.turnover) + '%')}
      ${cell('量比', f2(q.volRatio))}
      ${cell('PE(TTM) / PB', f2(q.pe) + ' / ' + f2(q.pb))}
      ${cell('总市值(亿)', f0(q.cap))}
      ${cell('涨停价', f2(q.zt), up)}
      ${cell('跌停价', f2(q.dt), dn)}
      ${cell('流通市值(亿)', f0(q.floatCap))}
      ${cell('数据源', '腾讯行情 · 实时')}
    </div>`;
  };

  // ── v4.9.8 技术统计（本地 K 线计算 · 零网络）──
  function kstatHTML(bars) {
    const closes = bars.map(b => b[2]), c = closes[closes.length - 1], n = closes.length;
    const ret = k => { const i = n - 1 - k; return i >= 0 ? (c / closes[i] - 1) * 100 : null; };
    const ma = k => { if (n < k) return null; let s = 0; for (let i = n - k; i < n; i++) s += closes[i]; return s / k; };
    const r5 = ret(5), r20 = ret(20), r60 = ret(60);
    const span = Math.min(60, n);
    const hi60 = Math.max.apply(null, bars.slice(-span).map(b => b[3]));
    const lo60 = Math.min.apply(null, bars.slice(-span).map(b => b[4]));
    const hiAll = Math.max.apply(null, bars.map(b => b[3])), loAll = Math.min.apply(null, bars.map(b => b[4]));
    const pos = (c - loAll) / ((hiAll - loAll) || 1) * 100;
    const avgV = (a, b) => { let s = 0, cnt = 0; for (let i = Math.max(0, a); i < Math.min(n, b); i++) { s += bars[i][5]; cnt++; } return cnt ? s / cnt : 0; };
    const v5 = avgV(n - 5, n), v20 = avgV(n - 20, n - 5);
    const vr = v20 ? v5 / v20 : null;
    const up = '#ff5a5a', dn = '#2fbf8f';
    const chip = (k, v, color) => `<div style="padding:5px 10px;border-right:1px solid #1c2434;border-bottom:1px solid #1c2434"><div style="font-size:10.5px;color:#5a6a80">${k}</div><div class="num" style="font-size:13px;font-weight:700;${color ? 'color:' + color : ''}">${v}</div></div>`;
    const pctTxt = v => v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
    const f2v = v => v.toFixed(2);
    const maTxt = k => { const m = ma(k); return m == null ? '—' : f2v(m) + (c >= m ? ' ▲上方' : ' ▼下方'); };
    return `<div style="display:grid;grid-template-columns:repeat(5,1fr);border:1px solid #1c2434;border-radius:8px;overflow:hidden;font-size:12px;margin-top:10px">
      ${chip('近5日', pctTxt(r5), r5 >= 0 ? up : dn)}
      ${chip('近20日', pctTxt(r20), r20 >= 0 ? up : dn)}
      ${chip('近60日', pctTxt(r60), r60 >= 0 ? up : dn)}
      ${chip('MA5', maTxt(5), ma(5) != null && c >= ma(5) ? up : dn)}
      ${chip('MA10', maTxt(10), ma(10) != null && c >= ma(10) ? up : dn)}
      ${chip('MA20', maTxt(20), ma(20) != null && c >= ma(20) ? up : dn)}
      ${chip('60日高/低', f2v(hi60) + ' / ' + f2v(lo60))}
      ${chip('距60日高点', ((c / hi60 - 1) * 100).toFixed(2) + '%', c / hi60 - 1 >= -0.03 ? up : '')}
      ${chip('量能 5日/20日', vr == null ? '—' : vr.toFixed(2) + ' 倍' + (vr >= 1.2 ? ' 放量' : vr <= 0.8 ? ' 缩量' : ''), vr >= 1.2 ? up : vr <= 0.8 ? dn : '')}
      ${chip('全档区间分位', pos.toFixed(0) + '%')}
    </div>`;
  }

  // ── v4.9.9 对比分析：归一化叠加个股 vs 基准（指数走 ifzq 直连(CORS *) / 个股优先本地分片）──
  const BENCH_IDX = { sh000001: '上证指数', sz399001: '深证成指', sz399006: '创业板指' };
  function normCode(s) {
    s = String(s || '').trim().toLowerCase();
    const m = /^(sh|sz|bj)?(\d{6})$/.exec(s);
    if (!m) return null;
    // 注意括号优先级：m[1] || (...) 必须先合并前缀再拼数字，否则带前缀入参会丢数字
    const mk = m[1] || (m[2][0] === '6' ? 'sh' : (m[2][0] === '0' || m[2][0] === '3') ? 'sz' : 'bj');
    return mk + m[2];
  }
  async function fetchBench(bcode, need) {
    try {
      const v = await getShard(bcode);   // 个股优先走本地分片（离线快）
      if (v.bars && v.bars.length >= Math.min(need, 30)) return { code: bcode, label: v.n || bcode, pts: v.bars.map(b => [b[0], b[2]]) };
    } catch (e) {}
    const res = await fetch('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + bcode + ',day,,,' + Math.min(640, need + 40) + ',qfq');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const d = j && j.data && j.data[bcode];
    const arr = (d && (d.qfqday || d.day)) || null;
    if (!arr || !arr.length) throw new Error('无数据');
    return { code: bcode, label: BENCH_IDX[bcode] || bcode, pts: arr.map(r => [r[0], parseFloat(r[2])]) };
  }
  function cmpHTML(stockBars, bench, win) {
    const s = stockBars.slice(-win);
    const bmap = new Map(bench.pts.map(p => [p[0], p[1]]));
    const pts = [];
    s.forEach(b => { const bv = bmap.get(b[0]); if (bv != null) pts.push([b[0], b[2], bv]); });
    if (pts.length < 3) return '<div class="dim" style="padding:8px 0;font-size:12px">基准与个股日期对齐不足（基准可能停牌/无数据），无法对比。</div>';
    const s0 = pts[0][1], b0 = pts[0][2];
    const sn = pts.map(p => p[1] / s0 * 100), bn = pts.map(p => p[2] / b0 * 100);
    const mn = Math.min.apply(null, sn.concat(bn)), mx = Math.max.apply(null, sn.concat(bn));
    const pad = (mx - mn) * 0.08 || 1; const lo = mn - pad, hi = mx + pad;
    const W = 800, H = 210, L = 10, R = W - 64, T = 10, B = H - 22;
    const X = i => L + (R - L) * i / (pts.length - 1);
    const Y = v => T + (hi - v) / (hi - lo) * (B - T);
    const path = a => a.map((v, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ',' + Y(v).toFixed(1)).join('');
    let grid = '';
    for (let g = 0; g <= 3; g++) {
      const yy = T + (B - T) * g / 3, val = hi - (hi - lo) * g / 3;
      grid += `<line x1="${L}" y1="${yy.toFixed(1)}" x2="${R}" y2="${yy.toFixed(1)}" stroke="#1c2434"/><text x="${R + 6}" y="${(yy + 4).toFixed(1)}" fill="#5a6a80" font-size="10">${val.toFixed(1)}</text>`;
    }
    const lblEvery = Math.ceil(pts.length / 6);
    let labels = '';
    pts.forEach((p, i) => { if (i % lblEvery === 0 || i === pts.length - 1) labels += `<text x="${X(i).toFixed(0)}" y="${H - 6}" fill="#5a6a80" font-size="10" text-anchor="middle">${p[0].slice(5)}</text>`; });
    const sRet = (sn[sn.length - 1] / 100 - 1) * 100, bRet = (bn[bn.length - 1] / 100 - 1) * 100, exc = sRet - bRet;
    let winDays = 0, tot = 0;
    for (let i = 1; i < pts.length; i++) {
      const rs = pts[i][1] / pts[i - 1][1] - 1, rb = pts[i][2] / pts[i - 1][2] - 1;
      if (isFinite(rs) && isFinite(rb)) { tot++; if (rs >= rb) winDays++; }
    }
    const c = v => v >= 0 ? '#ff5a5a' : '#2fbf8f';
    const pc = v => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
    const chip = (k, v, col) => `<div style="padding:5px 10px;border-right:1px solid #1c2434;border-bottom:1px solid #1c2434"><div style="font-size:10.5px;color:#5a6a80">${k}</div><div class="num" style="font-size:13px;font-weight:700;${col ? 'color:' + col : ''}">${v}</div></div>`;
    return `<svg class="km-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="margin-top:8px">
      ${grid}
      <path d="${path(bn)}" fill="none" stroke="#8a94a6" stroke-width="1.4" stroke-dasharray="4,3"/>
      <path d="${path(sn)}" fill="none" stroke="#5b8cff" stroke-width="2"/>
      ${labels}
      <text x="${L}" y="10" fill="#5b8cff" font-size="10">■ 个股（起点=100）</text>
      <text x="${L + 130}" y="10" fill="#8a94a6" font-size="10">--- ${esc(bench.label)}（基准）</text>
    </svg>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);border:1px solid #1c2434;border-radius:8px;overflow:hidden;font-size:12px;margin-top:6px">
      ${chip('个股区间涨幅', pc(sRet), c(sRet))}
      ${chip(esc(bench.label) + '同区间', pc(bRet), c(bRet))}
      ${chip('相对超额', (exc >= 0 ? '+' : '') + exc.toFixed(2) + ' pt', c(exc))}
      ${chip('日度跑赢基准', winDays + '/' + tot + ' 天')}
    </div>`;
  }

  // ── 任意A股K线弹窗 ──
  window._openKline = async function (code, nameHint) {
    let mask = document.getElementById('kmodal-mask');
    if (!mask) {
      mask = document.createElement('div');
      mask.id = 'kmodal-mask';
      mask.innerHTML = '<div id="kmodal"></div>';
      document.body.appendChild(mask);
      mask.addEventListener('click', e => { if (e.target === mask) mask.classList.remove('on'); });
    }
    const box = mask.querySelector('#kmodal');
    const show = html => { box.innerHTML = html; mask.classList.add('on'); };
    const closeBtn = `onclick="document.getElementById('kmodal-mask').classList.remove('on')"`;
    show(`<div class="km-head"><b>${esc(nameHint || code)}</b><span class="c num">${esc(code)}</span><div class="km-rng" style="margin-left:auto"></div><span class="km-close" ${closeBtn}>✕</span></div><div class="dim" style="padding:36px 0;text-align:center">拉取K线分片…</div>`);
    try {
      const v = await getShard(code);
      const name = nameHint || v.n || '';
      let cur = 60;
      let qtHtml = null, qtDone = false;
      let benchCode = 'sh000001', benchP = null, benchBusy = false, benchErrMsg = null, benchCustom = false;
      const note = `<div style="margin-top:10px;font-size:11px;color:var(--faint);line-height:1.7">ℹ 该股存档期内（近 31 个交易日）未上龙虎榜、未进入同花顺强势股，故无档案类内容（上榜历史/题材归因仅覆盖存档个股）。此处提供实时快照 + 本地K线技术统计作为补充；若该股日后上榜，将自动获得完整档案。</div>`;
      async function loadBench() {
        benchBusy = true; benchErrMsg = null; render();
        try { benchP = await fetchBench(benchCode, Math.min(640, cur + 40)); }
        catch (e) { benchP = null; benchErrMsg = e.message || '拉取失败'; }
        benchBusy = false; render();
      }
      const benchCtl = () => `<div style="display:flex;align-items:center;gap:8px;margin-top:4px;flex-wrap:wrap">
        <span style="font-size:11.5px;color:#5a6a80">对比基准</span>
        <select id="km-bench" style="background:#12151d;color:#c6cfdd;border:1px solid #1c2434;border-radius:6px;padding:3px 8px;font-size:12px">
          ${Object.entries(BENCH_IDX).map(([k, v]) => `<option value="${k}" ${k === benchCode ? 'selected' : ''}>${v}</option>`).join('')}
          <option value="_custom" ${benchCustom ? 'selected' : ''}>自选个股…</option>
        </select>
        <input id="km-bench-in" placeholder="如 sh600519 或 000001" value="${benchCustom ? esc(benchCode) : ''}" style="display:${benchCustom ? 'inline-block' : 'none'};background:#12151d;color:#c6cfdd;border:1px solid #1c2434;border-radius:6px;padding:3px 8px;font-size:12px;width:150px">
        <button id="km-bench-go" style="background:#1b2436;color:#c6cfdd;border:1px solid #1c2434;border-radius:6px;padding:3px 12px;font-size:12px;cursor:pointer">对比</button>
        <span id="km-bench-st" class="dim" style="font-size:11px">${benchBusy ? '基准拉取中…' : benchErrMsg ? '基准不可达：' + esc(benchErrMsg) : ''}</span>
      </div>`;
      const render = () => {
        const bars = v.bars, last = bars[bars.length - 1], prev = bars.length > 1 ? bars[bars.length - 2] : null;
        const chg = prev ? (last[2] / prev[2] - 1) * 100 : null;
        const qtSec = qtHtml == null
          ? `<div class="dim" id="km-qtw" style="padding:6px 0;font-size:12px">${qtDone ? '实时快照不可达（网络受限或离线，不影响K线与技术统计）' : '实时快照拉取中（腾讯行情）…'}</div>`
          : qtHtml;
        const cmpSec = benchP
          ? cmpHTML(bars, benchP, cur)
          : `<div class="dim" style="padding:8px 0;font-size:12px">${benchBusy ? '基准K线拉取中…' : benchErrMsg ? '请更换基准或稍后重试' : ''}</div>`;
        show(`<div class="km-head"><b>${esc(name || code)}</b><span class="c num">${esc(code)}</span>
          <span style="font-size:17px;font-weight:700">${last[2].toFixed(2)}</span>
          ${chg != null ? `<span style="color:${chg >= 0 ? '#ff5a5a' : '#2fbf8f'};font-weight:700">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</span>` : ''}
          <div class="km-rng" style="margin-left:auto">${[60, 120, 250].map(r => `<button class="${r === cur ? 'on' : ''}" data-r="${r}">${r}日</button>`).join('')}</div>
          <span class="km-close" ${closeBtn}>✕</span></div>
          ${candleSVG(bars, cur)}
          ${kstatHTML(bars)}
          <div style="margin-top:12px;font-size:12px;font-weight:700;color:#c6cfdd">对比分析</div>
          ${benchCtl()}
          ${cmpSec}
          <div style="margin-top:12px;font-size:12px;font-weight:700;color:#c6cfdd">实时快照</div>
          ${qtSec}
          ${note}
          <div class="km-meta"><span>📅 ${bars.length} 根 · ${bars[0][0]} ~ ${last[0]}</span><span>💾 IndexedDB 当日缓存</span><span>腾讯前复权日K · 仓库分片</span></div>`);
        box.querySelectorAll('.km-rng button').forEach(b => { b.onclick = () => { cur = +b.dataset.r; render(); }; });
        const sel = box.querySelector('#km-bench'), inp = box.querySelector('#km-bench-in'), go = box.querySelector('#km-bench-go');
        if (sel) sel.onchange = () => {
          if (sel.value === '_custom') { benchCustom = true; render(); const i2 = box.querySelector('#km-bench-in'); if (i2) i2.focus(); }
          else { benchCustom = false; benchCode = sel.value; loadBench(); }
        };
        if (go) go.onclick = () => {
          const nc = normCode(benchCustom ? (inp ? inp.value : '') : benchCode);
          if (!nc) { box.querySelector('#km-bench-st').textContent = '代码格式无法识别（示例：600519 / sh600519）'; return; }
          benchCode = nc; loadBench();
        };
        if (inp) inp.onkeydown = e => { if (e.key === 'Enter') go.click(); };
      };
      render();
      loadBench();
      qtQuote(code).then(q => { qtHtml = qtHTML(q); const w = box.querySelector('#km-qtw'); if (w) w.outerHTML = qtHtml; })
        .catch(() => { qtDone = true; const w = box.querySelector('#km-qtw'); if (w) w.textContent = '实时快照不可达（网络受限或离线，不影响K线与技术统计）'; });
    } catch (e) {
      show(`<div class="km-head"><b>${esc(nameHint || code)}</b><span class="km-close" ${closeBtn}>✕</span></div><div class="dim" style="padding:36px 0;text-align:center">K线分片不可达（${esc(e.message)}）——离线模式或该代码无数据</div>`);
    }
  };

  // ── 搜索扩展接口（全局搜索调用）──
  window.__klineSearch = async function (q) {
    const l = await getList();
    if (!l.codes.length) return [];
    const out = [];
    for (const it of l.codes) {
      if (it.c.indexOf(q) >= 0 || it.n.toLowerCase().indexOf(q) >= 0) { out.push(it); if (out.length >= 10) break; }
    }
    return out;
  };

  // ── 对内扩展接口（v4.8.8: S8 统计研判 / S6 健康面板按需取用分片库）──
  // __klineShard(code) → Promise<{c,n,bars,day}>，bars=[[日期,开,收,高,低,量],...]，收盘价取 b[2]（file:// 下 reject）
  // __klineList() → Promise<{codes:[{c,n}],generatedAt,day,offline?}>（file:// 下返回 offline 空清单）
  window.__klineShard = getShard;
  window.__klineList = getList;

  // ── S6 健康面板异步状态行（清单就绪后插入）──
  function _s6Touch(st) {
    const el = document.getElementById('s6-list');
    if (!el || el.dataset.klineRow) return;
    el.dataset.klineRow = '1';
    const div = document.createElement('div');
    div.className = 'hl-row';
    div.innerHTML = `<div style="min-width:0"><div style="font-size:13px;font-weight:700;color:#c6cfdd">全市场K线库 <span class="dim" style="font-weight:400;font-size:11px">v4.8 · 仓库分片 + IndexedDB 当日缓存</span></div><div style="font-size:12px;color:var(--dim);margin-top:2px;line-height:1.6">${_list.codes.length} 只沪深A股 · 每股 ≤640 日K（前复权）· 清单 ${_list.generatedAt || '—'} · 全档数据留存 git 仓库</div></div><span class="hl-st ${st === 'ok' ? 'hl-ok' : 'hl-warn'}">${st === 'ok' ? '✓ 就绪' : '⚠ 不可达'}</span>`;
    el.insertBefore(div, el.firstChild);
  }

  getList();
})();
