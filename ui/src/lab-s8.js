/* ═══════════ S8 个股资金画像（弹窗增强）═══════════ */
(function () {
  const orig = window._openStock;
  if (!orig) return;
  window._openStock = function (code) {
    orig(code);
    try { appendProfile(code); } catch (e) { /* 画像失败不影响原弹窗 */ }
  };

  function appendProfile(code) {
    const host = $id('m-body');
    if (!host) return;
    // 收集档案
    const lhb = []; // 升序
    DAYS.forEach(d => d.lhb.forEach(s => { if (s.code === code) lhb.push({ date: d.trade_date, net: s.net_buy_wan || 0, chg: s.change_pct, reason: s.reason || '' }); }));
    const hotRecs = [];
    DAYS.forEach(d => (d.hot || []).forEach(s => { if (s.code === code) hotRecs.push({ date: d.trade_date, chg: s.change_pct, reason: s.reason || '' }); }));
    if (!lhb.length && !hotRecs.length) return; // 无档案不加画像
    const totalNet = lhb.reduce((a, r) => a + r.net, 0);
    const bestDay = lhb.slice().sort((a, b) => b.chg - a.chg)[0];
    const worstDay = lhb.slice().sort((a, b) => a.chg - b.chg)[0];
    const avgChg = lhb.length ? lhb.reduce((a, r) => a + r.chg, 0) / lhb.length : 0;
    // 题材频次
    const tagCnt = new Map();
    hotRecs.forEach(r => (r.reason || '').split('+').forEach(t => { t = t.trim(); if (t) tagCnt.set(t, (tagCnt.get(t) || 0) + 1); }));
    const topTags = [...tagCnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    // 连续上榜
    let consec = 0;
    for (let i = DAYS.length - 1; i >= 0; i--) { const dd = DAYS[i].trade_date; if (lhb.some(r => r.date === dd)) consec++; else break; }

    // 净买累计曲线 + 单次净买柱
    let netSvg = '';
    if (lhb.length) {
      const Wd = 660, Ht = 150, L = 50, R = 14, T = 10, B = 22;
      const stepX = (Wd - L - R) / Math.max(lhb.length - 1, 1);
      let acc = 0;
      const accs = lhb.map(r => (acc += r.net));
      const mn = Math.min(...accs, 0), mx = Math.max(...accs, 1);
      const Y = v => T + (1 - (v - mn) / ((mx - mn) || 1)) * (Ht - T - B);
      const maxNet = Math.max(...lhb.map(r => Math.abs(r.net)), 1);
      const Y2 = v => { const mid = (T + Ht - B) / 2; return mid - (v / maxNet) * ((Ht - T - B) / 2 - 4); };
      let s = `<svg viewBox="0 0 ${Wd} ${Ht}" style="width:100%">`;
      s += `<line x1="${L}" y1="${Y(0)}" x2="${Wd - R}" y2="${Y(0)}" stroke="${LINE}" stroke-dasharray="4,4"/>`;
      // 单次净买柱
      lhb.forEach((r, i) => {
        const x = L + i * stepX, y0 = Y2(0), y1 = Y2(r.net);
        s += `<rect x="${x - stepX * 0.28}" y="${Math.min(y0, y1)}" width="${stepX * 0.56}" height="${Math.max(1.5, Math.abs(y1 - y0))}" fill="${r.net >= 0 ? UP : DOWN}" opacity=".55"/>`;
      });
      // 累计线
      let pl = ''; accs.forEach((v, i) => pl += (i ? ' L ' : 'M ') + (L + i * stepX) + ' ' + Y(v));
      s += `<path d="${pl}" fill="none" stroke="${GOLD}" stroke-width="2"/>`;
      accs.forEach((v, i) => {
        s += `<circle cx="${L + i * stepX}" cy="${Y(v)}" r="2.4" fill="${GOLD}"><title>${lhb[i].date}\n当次净买 ${fmtW(lhb[i].net)}\n累计 ${fmtW(v)}</title></circle>`;
      });
      s += `<text x="${L + (lhb.length - 1) * stepX}" y="${Y(accs[accs.length - 1]) - 7}" fill="${GOLD}" font-size="10.5" font-weight="700" text-anchor="end">累计 ${fmtW(accs[accs.length - 1])}</text>`;
      lhb.forEach((r, i) => { if (lhb.length <= 8 || i % 2 === 0 || i === lhb.length - 1) s += `<text x="${L + i * stepX}" y="${Ht - 6}" fill="${FAINT}" font-size="8.5" text-anchor="middle">${r.date.slice(5)}</text>`; });
      s += '</svg>';
      netSvg = s;
    }

    // ── 统计研判（融合自 8666 系统: 趋势/位置/榜上资金/题材热度 4 维打分）──
    // v4.8.8: 趋势/位置两维的 closes 来源升级——先取 D.stocks（页面注入K线池），不足时异步取
    // 全市场分片库（v4.8 · 5500+只），分片到位后就地更新 verdict → 绝大多数个股恢复 4 维口径
    function kdCloses(cl) {
      const out = [];
      const lastPx = cl.length ? cl[cl.length - 1] : null;
      if (lastPx == null) return out;
      // 趋势: 现价 vs MA20 + 近20日动量
      if (cl.length >= 21) {
        const ma20 = cl.slice(-20).reduce((a, b) => a + b, 0) / 20;
        const mom20 = (cl[cl.length - 1] / cl[cl.length - 21] - 1) * 100;
        let sc = 50 + (lastPx > ma20 ? 25 : -25) + Math.max(-25, Math.min(25, mom20 * 2.5));
        out.push({ name: '趋势', score: Math.round(Math.max(0, Math.min(100, sc))), text: `现价¥${lastPx.toFixed(2)} ${lastPx > ma20 ? '在' : '跌破'}20日均线（¥${ma20.toFixed(2)}）· 近20日 ${mom20 >= 0 ? '+' : ''}${mom20.toFixed(1)}%` });
      }
      // 位置: 近60日高低区间分位
      if (cl.length >= 30) {
        const win = cl.slice(-60);
        const mn = Math.min(...win), mx = Math.max(...win);
        const posPct = mx > mn ? Math.round((lastPx - mn) / (mx - mn) * 100) : 50;
        out.push({ name: '位置', score: posPct, text: `近${win.length}日区间 ¥${mn.toFixed(2)}~¥${mx.toFixed(2)} · 处于 ${posPct}% 分位（高位注意回撤风险）` });
      }
      return out;
    }
    const fundDims = [];
    if (lhb.length) {
      const sc = Math.max(0, Math.min(100, (lhb.length >= 3 ? 75 : lhb.length === 2 ? 60 : 45) + (totalNet >= 0 ? 20 : -10)));
      fundDims.push({ name: '榜上资金', score: sc, text: `存档期上榜 ${lhb.length} 次 · 净买累计 ${(totalNet >= 0 ? '+' : '') + fmtW(totalNet)}` });
    }
    const hotDims = [];
    if (hotRecs.length) {
      const curTags = new Set();
      (CUR.themeList || []).forEach(t => curTags.add(t.tag));
      const overlap = topTags.filter(([t]) => curTags.has(t)).length;
      const sc = Math.max(0, Math.min(100, (hotRecs.length >= 3 ? 80 : hotRecs.length === 2 ? 60 : 40) + overlap * 10));
      hotDims.push({ name: '题材热度', score: sc, text: `强势股 ${hotRecs.length} 次 · 主基因 ${topTags.slice(0, 2).map(([t, c]) => t + '×' + c).join(' / ') || '—'}${overlap ? ` · 与当前热门题材重合 ${overlap} 个` : ''}` });
    }
    // verdict: 缺维重归一化（note = 数据源/口径标注）
    const KW = { '趋势': 35, '位置': 25, '榜上资金': 20, '题材热度': 20 };
    function verdictHtmlOf(ds, note) {
      if (ds.length < 2) return '';
      const wSum = ds.reduce((a, d2) => a + KW[d2.name], 0);
      const comp = Math.round(ds.reduce((a, d2) => a + d2.score * KW[d2.name], 0) / wSum);
      const vd = comp >= 60 ? '偏多' : comp <= 40 ? '偏空' : '中性';
      const vc = vd === '偏多' ? 'var(--up)' : vd === '偏空' ? 'var(--down)' : '#d7dee9';
      return `
      <h4 style="font-size:13px;color:var(--gold);margin:12px 0 6px">📊 统计研判 <span style="font-size:10.5px;color:var(--faint);font-weight:400">纯统计复盘 · 非预测 · 不构成投资建议</span></h4>
      <div style="border:1px solid #2a3550;border-radius:10px;padding:9px 12px;background:rgba(14,19,32,.5)">
        <div style="display:flex;align-items:baseline;gap:9px;margin-bottom:5px"><span style="font-size:16px;font-weight:800;color:${vc}">${vd}</span><span class="num" style="font-size:11.5px;color:var(--dim)">综合 ${comp} 分${note ? ` <span style="color:var(--faint);font-weight:400">· ${note}</span>` : ''}</span></div>
        ${ds.map(d2 => `<div style="font-size:12px;margin:3px 0;line-height:1.5"><b style="color:#8fa3c8;display:inline-block;width:60px">${d2.name}</b>${d2.text}<span class="num" style="font-size:10.5px;color:var(--dim)">（${d2.score}分）</span></div>`).join('')}
      </div>`;
    }
    const st = D.stocks[code] || {};
    const closes = (st.closes || []).map(x => Array.isArray(x) ? x[1] : x).filter(v => v != null);
    const dims = kdCloses(closes).concat(fundDims, hotDims);
    const srcNote = closes.length >= 30 ? '' : closes.length >= 21 ? '存量K线不足30日 · 三维口径' : 'K线池外 · ' + (lhb.length && hotRecs.length ? '资金+热度两维' : '单维') + '口径';
    const verdictHtml = verdictHtmlOf(dims, srcNote);

    const box = document.createElement('div');
    box.style.cssText = 'margin-top:14px;border-top:1px dashed #2a3550;padding-top:10px';
    box.innerHTML = `
      <h4 style="font-size:13px;color:var(--gold);margin:0 0 8px">🧬 资金画像（S8 · 龙虎榜口径）</h4>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px">
        <span class="tag" style="padding:3px 9px">存档期上榜 <b class="num">${lhb.length}</b> 次</span>
        ${consec >= 2 ? `<span class="tag hot" style="padding:3px 9px">当前连续 <b class="num">${consec}</b> 日</span>` : ''}
        <span class="tag" style="padding:3px 9px">累计净买 <b class="num ${cls(totalNet)}">${lhb.length ? (totalNet >= 0 ? '+' : '') + fmtW(totalNet) : '—'}</b></span>
        <span class="tag" style="padding:3px 9px">上榜日均涨幅 <b class="num ${cls(avgChg)}">${lhb.length ? pct(avgChg) : '—'}</b></span>
        ${bestDay ? `<span class="tag" style="padding:3px 9px">最佳 <b class="num up">${bestDay.date.slice(5)} ${pct(bestDay.chg)}</b></span>` : ''}
        ${worstDay && worstDay !== bestDay ? `<span class="tag" style="padding:3px 9px">最差 <b class="num down">${worstDay.date.slice(5)} ${pct(worstDay.chg)}</b></span>` : ''}
      </div>
      ${lhb.length ? `<div style="font-size:11.5px;color:var(--faint);margin-bottom:2px">每次净买（柱 · 红=净买/绿=净卖）与累计资金线（金）</div>${netSvg}` : '<div class="dim" style="font-size:12px">存档期未上龙虎榜（仅强势股归因记录）</div>'}
      ${topTags.length ? `<div style="margin-top:8px;font-size:12px"><b style="color:#c6cfdd">题材基因：</b>${topTags.map(([t, c]) => `<span class="tag${c >= 2 ? ' hot' : ''}">${t} ×${c}</span>`).join('')}</div>` : ''}
      ${hotRecs.length ? `<div style="margin-top:5px;font-size:11.5px;color:var(--dim)">强势股记录 ${hotRecs.length} 次 · 最近 ${hotRecs[0].date}（当日 ${pct(hotRecs[0].chg)}）</div>` : ''}
      <div data-s8-verdict="${code}">${verdictHtml}</div>`;
    host.appendChild(box);

    // v4.8.8: closes 不足 30 日（趋势或位置维缺失）→ 异步取全市场分片库补齐，就地更新 verdict
    // 分片库仅沪深（sh/sz 前缀）；6 开头→sh、0/3 开头→sz，北交所码（4/8/9 开头）库里没有直接跳过
    if (closes.length < 30 && typeof window.__klineShard === 'function') {
      const sc6 = /^6/.test(code) ? 'sh' + code : /^[03]/.test(code) ? 'sz' + code : null;
      if (sc6) {
        window.__klineShard(sc6).then(v => {
          if (!box.isConnected) return; // 弹窗已切换/关闭，丢弃过期回调
          const vb = box.querySelector('[data-s8-verdict]');
          if (!vb || vb.getAttribute('data-s8-verdict') !== code) return;
          const cl2 = ((v && v.bars) || []).map(b => Array.isArray(b) ? b[2] : b).filter(x => x != null);
          if (cl2.length < 21) return; // 分片也缺数据 → 保留当前口径
          const dims2 = kdCloses(cl2).concat(fundDims, hotDims);
          const html2 = verdictHtmlOf(dims2, cl2.length >= 30 ? 'K线 · 全市场分片库' : 'K线 · 全市场分片库（仅' + cl2.length + '日）');
          if (html2) vb.innerHTML = html2;
        }).catch(() => { /* 分片不可达（离线 file:// / 退市无数据）→ 保留当前口径 */ });
      }
    }
  }
})();
