/* ═══════════ S1 情绪权重实验室（v4.3 七因子） ═══════════ */
(function () {
  const SUBS = [
    { k: 'net', name: '龙虎榜净买分', key: 's_net', w: 20 },
    { k: 'pos', name: '净买家数比', key: 's_pos', w: 10 },
    { k: 'brd', name: '行业广度', key: 's_brd', w: 20 },
    { k: 'hot', name: '题材热度', key: 's_hot', w: 10 },
    { k: 'zdt', name: '涨跌停对比', key: 's_zdt', w: 15 },
    { k: 'zbl', name: '封板质量', key: 's_zbl', w: 10 },
    { k: 'amt', name: '量能', key: 's_amt', w: 15 }
  ];
  const OFFICIAL_W = [20, 10, 20, 10, 15, 10, 15];
  const PRESETS = [
    { name: '官方口径 v4.3', w: [20, 10, 20, 10, 15, 10, 15] },
    { name: '旧版 v4（4因子）', w: [35, 25, 25, 15, 0, 0, 0] },
    { name: '去行业因子', w: [25, 12, 0, 12, 20, 13, 18] },
    { name: '纯资金流', w: [40, 15, 0, 10, 15, 10, 10] },
    { name: '情绪温度计', w: [15, 15, 20, 15, 20, 10, 5] }
  ];
  const official = DAYS.map(d => d.emotion ? d.emotion.value : 50);
  const subVals = DAYS.map(d => { const e = d.emotion || {}; return SUBS.map(s => e[s.key] == null ? 50 : e[s.key]); });
  const isCustomSaved = !!LAB.get('weights', null);
  let W = LAB.get('weights', null) || OFFICIAL_W.slice();
  if (W.length !== SUBS.length) W = OFFICIAL_W.slice(); // 旧版 4 维存档迁移

  // ── 滑块 UI ──
  const box = $id('s1-sliders');
  box.innerHTML = SUBS.map((s, i) => `
    <div class="lab-slider"><label>${s.name}</label>
      <input type="range" min="0" max="100" step="5" value="${W[i]}" data-i="${i}">
      <span class="wv" id="s1-wv-${i}">${W[i]}%</span></div>`).join('');
  $id('s1-presets').innerHTML = PRESETS.map((p, i) => `<button class="chip" data-pi="${i}">${p.name}</button>`).join('');

  function calc(w) {
    const sum = w.reduce((a, b) => a + b, 0);
    if (!sum) return null;
    return DAYS.map((_, i) => {
      let v = 0; for (let j = 0; j < SUBS.length; j++) v += subVals[i][j] * w[j];
      return Math.max(0, Math.min(100, +(v / sum).toFixed(1)));
    });
  }

  function sameAs(a, b) { return a.every((v, i) => v === b[i]); }

  function draw(custom) {
    const host = $id('svg-lab-emotion'); host.innerHTML = '';
    if (!custom) { host.innerHTML = '<div class="dim" style="font-size:12.5px;padding:20px 0">全部权重为 0，无法计算——请至少保留一个非零权重。</div>'; return; }
    const Wd = 1200, H = 320, L = 52, R = 70, T = 16, B = 30;
    const n = DAYS.length, stepX = (Wd - L - R) / Math.max(n - 1, 1);
    const Y = v => T + (100 - v) / 100 * (H - T - B), X = i => L + i * stepX;
    const svg = el('svg', { viewBox: `0 0 ${Wd} ${H}` });
    [0, 25, 50, 75, 100].forEach(v => {
      svg.appendChild(el('line', { x1: L, y1: Y(v), x2: Wd - R, y2: Y(v), stroke: v === 50 ? LINE : '#171e2c', 'stroke-width': 1, 'stroke-dasharray': v === 50 ? '5,5' : '' }));
      svg.appendChild(el('text', { x: L - 8, y: Y(v) + 4, fill: FAINT, 'font-size': 10.5, 'text-anchor': 'end' }, v));
    });
    // 自定义面积
    let area = `M ${X(0)} ${Y(custom[0])}`;
    custom.forEach((v, i) => area += ` L ${X(i)} ${Y(v)}`);
    area += ` L ${X(n - 1)} ${H - B} L ${X(0)} ${H - B} Z`;
    svg.appendChild(el('path', { d: area, fill: 'rgba(232,176,75,.07)' }));
    // 官方线（灰虚）
    let ol = ''; official.forEach((v, i) => ol += (i ? ' L ' : 'M ') + X(i) + ' ' + Y(v));
    svg.appendChild(el('path', { d: ol, fill: 'none', stroke: '#5a6478', 'stroke-width': 1.6, 'stroke-dasharray': '5,4', opacity: .9 }));
    // 自定义线（金）
    let cl2 = ''; custom.forEach((v, i) => cl2 += (i ? ' L ' : 'M ') + X(i) + ' ' + Y(v));
    svg.appendChild(el('path', { d: cl2, fill: 'none', stroke: GOLD, 'stroke-width': 2.2 }));
    // 差异最大日
    let mi = 0, mv = -1;
    custom.forEach((v, i) => { const d = Math.abs(v - official[i]); if (d > mv) { mv = d; mi = i; } });
    if (mv >= 3) {
      svg.appendChild(el('circle', { cx: X(mi), cy: Y(custom[mi]), r: 4.5, fill: 'none', stroke: GOLD, 'stroke-width': 1.5 }));
      const above = custom[mi] >= official[mi];
      svg.appendChild(el('text', { x: X(mi), y: above ? Y(custom[mi]) - 10 : Y(custom[mi]) + 18, fill: GOLD, 'font-size': 10.5, 'text-anchor': 'middle', 'font-weight': '700' }, `分歧 ${above ? '+' : '-'}${mv.toFixed(1)} (${DAYS[mi].trade_date.slice(5)})`));
    }
    // 末点标注
    svg.appendChild(el('circle', { cx: X(n - 1), cy: Y(custom[n - 1]), r: 3.2, fill: GOLD }));
    svg.appendChild(el('text', { x: X(n - 1) + 8, y: Y(custom[n - 1]) + 4, fill: GOLD, 'font-size': 11.5, 'font-weight': '700' }, '我的 ' + custom[n - 1].toFixed(1)));
    svg.appendChild(el('circle', { cx: X(n - 1), cy: Y(official[n - 1]), r: 3.2, fill: '#5a6478' }));
    const offAbove = official[n - 1] >= custom[n - 1];
    svg.appendChild(el('text', { x: X(n - 1) + 8, y: Y(official[n - 1]) + (offAbove ? -6 : 14), fill: '#8a94a6', 'font-size': 11 }, '官方 ' + official[n - 1].toFixed(1)));
    // x 轴
    DAYS.forEach((d, i) => { if (i % 5 === 0 || i === n - 1) svg.appendChild(el('text', { x: X(i), y: H - 8, fill: FAINT, 'font-size': 10, 'text-anchor': 'middle' }, d.trade_date.slice(5))); });
    svg.appendChild(el('text', { x: L, y: T - 4, fill: '#8a94a6', 'font-size': 10.5 }, '── 官方口径（灰虚线）'));
    svg.appendChild(el('text', { x: L + 150, y: T - 4, fill: GOLD, 'font-size': 10.5 }, '── 我的口径（金线）'));
    host.appendChild(svg);
  }

  function render() {
    const custom = calc(W);
    const sum = W.reduce((a, b) => a + b, 0);
    $id('s1-sum').textContent = sum;
    SUBS.forEach((s, i) => { $id('s1-wv-' + i).textContent = W[i] + '%'; });
    draw(custom);
    const diffEl = $id('s1-diff');
    if (!custom) { diffEl.textContent = ''; return; }
    const curDiff = +(custom[custom.length - 1] - official[official.length - 1]).toFixed(1);
    let mi = 0, mv = -1;
    custom.forEach((v, i) => { const d = Math.abs(v - official[i]); if (d > mv) { mv = d; mi = i; } });
    const r = LAB.pearson(custom, official);
    const avgDiff = (custom.reduce((a, v, i) => a + (v - official[i]), 0) / custom.length).toFixed(1);
    const modeTxt = sameAs(W, OFFICIAL_W) ? '官方口径' : (isCustomSaved && sameAs(W, LAB.get('weights', [])) ? '我的口径（已保存）' : '临时口径（未保存）');
    diffEl.innerHTML = `当前使用 <b class="gold">${modeTxt}</b> · 最新日: 我的 <b class="num">${custom[custom.length - 1]}</b> vs 官方 <b class="num">${official[official.length - 1]}</b>（<span class="${cls(curDiff)}">${curDiff > 0 ? '+' : ''}${curDiff}</span>） · 全档均值差 ${avgDiff > 0 ? '+' : ''}${avgDiff} · 最大分歧 ${DAYS[mi].trade_date}（${mv.toFixed(1)} 分） · 曲线相关系数 ${r}`;
  }

  box.querySelectorAll('input[type=range]').forEach(r => r.oninput = () => {
    W[+r.dataset.i] = +r.value;
    $id('s1-presets').querySelectorAll('.chip').forEach(c => c.classList.remove('on'));
    render();
  });
  $id('s1-presets').querySelectorAll('.chip').forEach(c => c.onclick = () => {
    W = PRESETS[+c.dataset.pi].w.slice();
    box.querySelectorAll('input[type=range]').forEach(r => r.value = W[+r.dataset.i]);
    $id('s1-presets').querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === c));
    render();
  });
  $id('s1-save').onclick = () => { LAB.set('weights', W); LAB.toast('权重口径已保存（本机）· 下次打开自动应用'); render(); };
  $id('s1-reset').onclick = () => {
    W = OFFICIAL_W.slice();
    box.querySelectorAll('input[type=range]').forEach(r => r.value = W[+r.dataset.i]);
    $id('s1-presets').querySelectorAll('.chip').forEach(x => x.classList.remove('on'));
    render();
  };
  // 初始高亮匹配的预设
  PRESETS.forEach((p, i) => { if (sameAs(W, p.w)) $id('s1-presets').querySelector(`[data-pi="${i}"]`)?.classList.add('on'); });
  render();

  /* ═══ v4.6 批量权重扫描：随机采样 ~200 组 + 官方/预设 → 方向胜率 / IC / 回撤 ═══
     目的：检验权重稳健性、缓解过拟合——看「哪类因子结构方向性更好」而非固化单点权重。
     口径：方向胜率 = 情绪≥60 看多 / ≤40 看空 vs 次日上证涨跌（中性 40-60 跳过）；
     IC = 情绪值与次日上证收益 pearson（LAB.pearson）；回撤 = 看多日次日收益累计权益曲线最大回撤。 */
  const SCAN_N = 200;
  const shScan = DAYS.map(d => { const v = (d.indexes || {})['上证指数']; return v == null ? null : v; });
  const FACT_ABBR = ['净', '家', '广', '题', '涨', '封', '量'];
  const wLabel = w => SUBS.map((s, i) => FACT_ABBR[i] + w[i]).join('·');

  function scanMetrics(w) {
    const series = calc(w); if (!series) return null;
    const n = series.length;
    let dirN = 0, dirW = 0, icA = [], icB = [], eq = 1, peak = 1, mdd = 0, longN = 0, longSum = 0;
    for (let i = 0; i < n - 1; i++) {
      const r = shScan[i + 1]; if (r == null) continue;
      icA.push(series[i]); icB.push(r);
      const v = series[i];
      if (v >= 60) { // 看多策略权益曲线
        longN++; longSum += r; eq *= 1 + r / 100;
        if (eq > peak) peak = eq;
        const dd = (peak - eq) / peak; if (dd > mdd) mdd = dd;
      }
      if (v >= 60 || v <= 40) { dirN++; if ((v >= 60 && r > 0) || (v <= 40 && r < 0)) dirW++; }
    }
    return {
      dirN, dirRate: dirN ? Math.round(dirW / dirN * 100) : null,
      ic: LAB.pearson(icA, icB),
      longN, cumRet: longN ? (eq - 1) * 100 : null, avgLong: longN ? longSum / longN : null,
      mdd: mdd * 100
    };
  }

  function randGroup() {
    for (;;) {
      const raw = SUBS.map(() => Math.random() * 100);
      const tot = raw.reduce((a, b) => a + b, 0);
      if (tot < 25) continue; // 避免过度退化（权重几乎全押单一因子也保留，仅防全零）
      return raw.map(v => Math.round(v / tot * 100));
    }
  }

  function runScan() {
    const groups = [{ name: '官方口径 v4.3', w: OFFICIAL_W.slice() }];
    PRESETS.forEach(p => { if (p.name !== '官方口径 v4.3') groups.push({ name: '预设·' + p.name, w: p.w.slice() }); });
    for (let t = 0; t < SCAN_N; t++) groups.push({ name: '随机 #' + (t + 1), w: randGroup() });
    return groups.map(g => { const m = scanMetrics(g.w); return m ? Object.assign({ name: g.name, w: g.w }, m) : null; }).filter(Boolean).sort((a, b) => b.ic - a.ic);
  }

  const scanTd = (extra) => `<td style="padding:6px 8px;border-bottom:1px solid #171e2c;${extra || ''}">`;
  $id('s1-scan').onclick = () => {
    const rows = runScan();
    const off = rows.find(r => r.name === '官方口径 v4.3');
    const offRank = rows.indexOf(off) + 1;
    const top = rows.slice(0, 10);
    const meanAll = (rows.reduce((s, r) => s + r.ic, 0) / rows.length);
    const meanTop = (top.reduce((s, r) => s + r.ic, 0) / top.length);
    const better = rows.filter(r => r.name !== '官方口径 v4.3' && r.ic >= off.ic + 0.05).length;
    const dirCell = r => r.dirRate == null ? '<span class="dim">—</span>' : `<b class="num ${r.dirRate >= 55 ? 'up' : (r.dirRate <= 45 ? 'down' : '')}">${r.dirRate}%</b><span class="dim" style="font-size:10.5px"> (${r.dirN})</span>`;
    const icCell = r => `<b class="num ${r.ic >= 0.15 ? 'up' : (r.ic <= -0.15 ? 'down' : '')}">${r.ic > 0 ? '+' : ''}${r.ic.toFixed(3)}</b>`;
    const longCell = r => r.cumRet == null ? '<span class="dim">—</span>' : `<span class="num ${r.cumRet > 0 ? 'up' : 'down'}">${r.cumRet > 0 ? '+' : ''}${r.cumRet.toFixed(1)}%</span><span class="dim" style="font-size:10.5px"> (${r.longN}日·均${r.avgLong > 0 ? '+' : ''}${r.avgLong.toFixed(2)}%)</span>`;
    const rowHtml = (r, rank, isOff) => `<tr${isOff ? ' style="background:rgba(232,176,75,.07)"' : ''}>
        ${scanTd('text-align:center;white-space:nowrap')}${rank}</td>
        ${scanTd('white-space:nowrap')}${isOff ? '<b class="gold">官方口径 v4.3</b>' : (r.name.indexOf('预设') === 0 ? r.name.slice(3) : '<span class="dim">' + r.name + '</span>')}</td>
        ${scanTd('white-space:nowrap;font-size:11.5px')}<span class="num">${wLabel(r.w)}</span>${sameAs(r.w, W) ? ' <b class="gold">←当前</b>' : ''}</td>
        ${scanTd('text-align:center;white-space:nowrap')}${dirCell(r)}</td>
        ${scanTd('text-align:center;white-space:nowrap')}${icCell(r)}</td>
        ${scanTd('text-align:center;white-space:nowrap')}${longCell(r)}</td>
        ${scanTd('text-align:center;white-space:nowrap')}${r.cumRet == null ? '<span class="dim">—</span>' : `<span class="num">${r.mdd.toFixed(1)}%</span>`}</td>
      </tr>`;
    const tbl = `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12.5px">
      <thead><tr>${['#', '组合', '权重 净·家·广·题·涨·封·量', '方向胜率', 'IC', '看多累计', '回撤'].map((h, i) => `<th style="padding:6px 8px;border-bottom:1px solid #212a3a;text-align:${i < 3 ? 'left' : 'center'};white-space:nowrap">${h}</th>`).join('')}</tr></thead>
      <tbody>${top.map((r, i) => rowHtml(r, i + 1, r.name === '官方口径 v4.3')).join('')}${offRank > 10 ? rowHtml(off, offRank, true) : ''}</tbody>
    </table></div>
    <div class="dim" style="font-size:11px;margin-top:6px">口径：方向胜率 = 情绪≥60 看多 / ≤40 看空 vs 次日上证（括号内为样本天数）· IC = 情绪值与次日上证收益相关系数 · 看多累计 = 情绪≥60 日次日收益连乘 · 回撤 = 该权益曲线最大回撤。权重为归一后整数，实际按比例归一。</div>`;
    $id('s1-scan-hint').innerHTML = `共扫描 <b class="num">${rows.length}</b> 组（${SCAN_N} 随机 + 官方 + ${PRESETS.length - 1} 预设）· 官方 IC 排名 <b class="num">${offRank}/${rows.length}</b> · IC≥官方+0.05 的随机组 <b class="num">${better}</b> 组`;
    $id('s1-scan-body').innerHTML =
      `<div class="kpi" style="margin-bottom:10px"><div class="lab">扫描概览</div><div class="val num">${(meanTop - meanAll >= 0 ? '+' : '')}${(meanTop - meanAll).toFixed(3)}<small style="font-size:12px;color:var(--dim)"> TOP10 IC − 全体均值</small></div><div class="sub">TOP10 IC 均值 ${meanTop > 0 ? '+' : ''}${meanTop.toFixed(3)} · 全体 ${meanAll > 0 ? '+' : ''}${meanAll.toFixed(3)} · 差距越小 = 因子结构本身方向性弱，权重微调意义不大</div></div>` +
      tbl +
      `<div class="warn" style="margin-top:10px">⚠ 过拟合警示：当前存档仅 ${DAYS.length} 个交易日，不足以支撑精细排名——IC 差距 &lt;0.1 的组合无实质差异；各组合胜率/回撤均在同一段样本内评估，勿外推未来。样本 ≥60 个交易日前，本表只用于观察「哪类因子结构方向性更好」（如资金流 vs 广度主导），不要据此固化权重或切换口径。</div>`;
  };
})();
