/* ═══════════ S4 题材族谱演化树 ═══════════ */
(function () {
  // ── 数据准备 ──
  const topicStocks = new Map(); // tag -> Map(code -> {name, date, chg})
  const dayTagCount = new Map(); // date -> Map(tag -> count)（来自 topics 榜）
  DAYS.forEach(d => {
    const m = new Map();
    (d.themeList || []).forEach(t => m.set(t.tag, t.count));
    dayTagCount.set(d.trade_date, m);
    (d.hot || []).forEach(s => (s.reason || '').split('+').forEach(t => {
      t = t.trim(); if (!t) return;
      let mp = topicStocks.get(t); if (!mp) { mp = new Map(); topicStocks.set(t, mp); }
      mp.set(s.code, { name: s.name, date: d.trade_date, chg: s.change_pct });
    }));
  });
  const RN = 10; // 近10日
  const recent = DAYS.slice(-RN), prev5 = DAYS.slice(-RN - 5, -5), last5 = DAYS.slice(-5);
  const sumTag = days => { const m = new Map(); days.forEach(d => (d.themeList || []).forEach(t => m.set(t.tag, (m.get(t.tag) || 0) + t.count))); return m; };
  const rSum = sumTag(recent), pSum = sumTag(DAYS.slice(-RN - 5, -RN)), l5Sum = sumTag(last5);
  // 节点：近10日强度 TOP12
  const nodes = [...rSum.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([tag, cnt]) => ({ tag, recent: cnt, momentum: cnt - (pSum.get(tag) || 0), last5: l5Sum.get(tag) || 0 }));
  const inSet = new Set(nodes.map(n => n.tag));
  // 共现边（全存档期内同日同时在题材榜 TOP15）
  const co = new Map();
  DAYS.forEach(d => {
    const tags = (d.themeList || []).slice(0, 15).map(t => t.tag).filter(t => inSet.has(t));
    tags.forEach((a, i) => tags.slice(i + 1).forEach(b => {
      const k = a < b ? a + '||' + b : b + '||' + a;
      co.set(k, (co.get(k) || 0) + 1);
    }));
  });

  // ── 布局：TOP3 内环，其余外环 ──
  const W = 1200, H = 560, CX = 620, CY = 285, R1 = 105, R2 = 218;
  nodes.forEach((n, i) => {
    if (i < 3) { const a = -Math.PI / 2 + i * (2 * Math.PI / 3); n.x = CX + R1 * Math.cos(a); n.y = CY + R1 * Math.sin(a); n.inner = true; }
    else { const j = i - 3, m = Math.max(nodes.length - 3, 1); const a = -Math.PI / 2 + j * (2 * Math.PI / m); n.x = CX + R2 * Math.cos(a); n.y = CY + R2 * Math.sin(a); n.inner = false; }
    n.r = 10 + Math.min(16, Math.sqrt(n.recent) * 2.2);
  });

  function draw(selected) {
    const host = $id('svg-gene'); host.innerHTML = '';
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}` });
    // 中心说明
    svg.appendChild(el('text', { x: CX, y: CY - 8, fill: FAINT, 'font-size': 11, 'text-anchor': 'middle' }, '题材共现拓扑'));
    svg.appendChild(el('text', { x: CX, y: CY + 10, fill: FAINT, 'font-size': 10, 'text-anchor': 'middle' }, '近' + RN + '日 · 连线=同日同榜'));
    // 边
    [...co.entries()].filter(([, v]) => v >= 3).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
      const [a, b] = k.split('||');
      const na = nodes.find(n => n.tag === a), nb = nodes.find(n => n.tag === b);
      if (!na || !nb) return;
      const sel = selected === a || selected === b;
      svg.appendChild(el('line', { x1: na.x, y1: na.y, x2: nb.x, y2: nb.y, stroke: sel ? GOLD : '#2a3550', 'stroke-width': Math.min(5, 0.8 + v * 0.5), opacity: sel ? 0.9 : Math.min(0.65, 0.25 + v * 0.08) }));
      const mx = (na.x + nb.x) / 2, my = (na.y + nb.y) / 2;
      const t = el('text', { x: mx, y: my - 3, fill: sel ? GOLD : FAINT, 'font-size': 9.5, 'text-anchor': 'middle', opacity: sel ? 1 : 0.55 }, v + '天');
      t.appendChild(el('title', {}, a + ' × ' + b + '\n同日共现 ' + v + ' 天'));
      svg.appendChild(t);
    });
    // 节点
    nodes.forEach(n => {
      const momC = n.momentum > 0 ? UP : n.momentum < 0 ? DOWN : '#8a94a6';
      const sel = selected === n.tag;
      const g = el('circle', { cx: n.x, cy: n.y, r: n.r + (sel ? 3 : 0), fill: sel ? 'rgba(232,176,75,.25)' : 'rgba(18,23,34,.9)', stroke: momC, 'stroke-width': sel ? 3 : 2, class: 'pickable' });
      g.appendChild(el('title', {}, `${n.tag}\n近${RN}日 ${n.recent} 只次 · 近5日 ${n.last5} 只\n动量 ${n.momentum > 0 ? '+' : ''}${n.momentum}（${n.momentum > 0 ? '升温' : n.momentum < 0 ? '降温' : '持平'}）\n点击查看族谱详情`));
      g.onclick = () => { detail(n.tag); draw(n.tag); };
      svg.appendChild(g);
      const tl = el('text', { x: n.x, y: n.y + 4, fill: '#d7dee9', 'font-size': 10.5, 'font-weight': '700', 'text-anchor': 'middle', class: 'pickable' }, n.tag.length > 5 ? n.tag.slice(0, 5) : n.tag);
      // v4.9.7: onclick 不能走 el() attrs（setAttribute 会把函数转成字符串变无效内联处理器，
      // 标签叠在圆心上吞掉点击 → 用户点节点中心无响应）; 必须属性赋值
      tl.onclick = () => { detail(n.tag); draw(n.tag); };
      svg.appendChild(tl);
      // 动量角标
      svg.appendChild(el('text', { x: n.x + n.r + 5, y: n.y - n.r + 2, fill: momC, 'font-size': 10, 'font-weight': '700' }, n.momentum > 0 ? '▲' : n.momentum < 0 ? '▼' : '▶'));
    });
    // 图例
    svg.appendChild(el('text', { x: 20, y: 22, fill: UP, 'font-size': 11 }, '▲ 升温（近5日只数 > 前5日）'));
    svg.appendChild(el('text', { x: 20, y: 40, fill: DOWN, 'font-size': 11 }, '▼ 降温 · 线宽=共现天数（≥3 天才连线）'));
    svg.appendChild(el('text', { x: 20, y: 58, fill: FAINT, 'font-size': 11 }, '节点大小=近10日强度 · 内环=强度TOP3'));
    host.appendChild(svg);
  }

  function detail(tag) {
    const box = $id('s4-detail');
    const n = nodes.find(x => x.tag === tag) || { recent: 0, momentum: 0, last5: 0 };
    // 30 日出现序列
    const series = DAYS.map(d => (dayTagCount.get(d.trade_date) || {}).has(tag) ? (dayTagCount.get(d.trade_date).get(tag) || 0) : 0);
    const days = series.filter(v => v > 0).length;
    // 关联股：最近出现优先
    const stocks = [...(topicStocks.get(tag) || new Map()).entries()]
      .map(([code, v]) => ({ code, ...v })).sort((a, b) => a.date < b.date ? 1 : -1).slice(0, 10);
    let mini = '';
    {
      const Wd = 560, Ht = 90, B = 18, stepX = Wd / DAYS.length, max = Math.max(...series, 1);
      const Y = v => Ht - B - v / max * (Ht - B - 8);
      let s = `<svg viewBox="0 0 ${Wd} ${Ht}" style="width:100%;max-width:560px">`;
      s += `<line x1="0" y1="${Ht - B}" x2="${Wd}" y2="${Ht - B}" stroke="${LINE}"/>`;
      series.forEach((v, i) => {
        if (v > 0) s += `<rect x="${i * stepX + stepX * 0.15}" y="${Y(v)}" width="${stepX * 0.7}" height="${Ht - B - Y(v)}" fill="${i >= DAYS.length - 5 ? GOLD : UP}" opacity=".85"/>`;
        if (i % 5 === 0) s += `<text x="${i * stepX}" y="${Ht - 5}" fill="${FAINT}" font-size="8.5" text-anchor="middle">${DAYS[i].trade_date.slice(5)}</text>`;
      });
      s += '</svg>';
      mini = s;
    }
    box.innerHTML = `
      <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">
        <b style="font-size:16px;color:var(--gold)">${tag}</b>
        <span class="num" style="font-size:12.5px">30日在榜 <b>${days}</b> 天 · 近${RN}日 <b>${n.recent}</b> 只次 · 近5日 <b>${n.last5}</b> 只</span>
        <span class="num" style="font-size:12.5px;color:${n.momentum > 0 ? UP : n.momentum < 0 ? DOWN : '#8a94a6'}">动量 ${n.momentum > 0 ? '+' : ''}${n.momentum}（${n.momentum > 0 ? '升温' : n.momentum < 0 ? '降温' : '持平'}）</span>
      </div>
      <div style="margin:6px 0 4px;font-size:11.5px;color:var(--faint)">30日出现只数（金柱=最近5日）</div>
      ${mini}
      <div style="margin-top:6px;font-size:12px;color:#c6cfdd;font-weight:700">族谱关联股（最近出现优先，点击看个股画像）</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:5px">${stocks.length ? stocks.map(s => `<span class="tag pickable" style="cursor:pointer;padding:3px 9px" data-code="${s.code}">${s.name} <span class="num ${cls(s.chg)}" style="font-size:11px">${pct(s.chg)}</span> <span class="num dim" style="font-size:10.5px">${s.date.slice(5)}</span></span>`).join('') : '<span class="dim">暂无</span>'}</div>`;
    box.querySelectorAll('[data-code]').forEach(t => t.onclick = () => _openStock(t.dataset.code));
  }

  draw(nodes[0] && nodes[0].tag);
  if (nodes[0]) detail(nodes[0].tag);
})();
