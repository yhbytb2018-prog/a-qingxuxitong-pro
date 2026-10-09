/* ═══════════ S11 情绪区间回测报表（v4.3.1 → v4.6 增强）═══════════
   统计不同情绪区间下，大盘/题材/打板接力（昨日涨停指数）的未来盈亏概率。
   口径：区间按当日情绪值 5 档划分；大盘=上证涨跌幅连乘；题材=当日 TOP3 题材成员股按
   存档收盘价计未来收益；打板接力=昨日涨停指数(883994)次日涨跌幅（情绪当日的涨停组合
   在次日的真实赚钱效应）。异常交易日可勾选剔除（meta.abnormalDays 人工维护）。
   v4.6 增强：①疑似黑天鹅预筛阈值可配置（情绪跳变 Δ / 赚钱效应），候选逐条勾选后
   「写入本地标记」（localStorage s11_abn_local，与 meta.abnormalDays 合并生效，可清除）；
   ②分层子集回测（情绪分位高位/冰点/中部、连板高位/低位、主线集中/散乱），样本 <10 天标红。 */
(function () {
  const BUCKETS = [
    { name: '冰点 0-20', lo: 0, hi: 20, c: '#2fbf8f' },
    { name: '低温 20-40', lo: 20, hi: 40, c: '#4a9e7f' },
    { name: '中性 40-60', lo: 40, hi: 60, c: '#8a94a6' },
    { name: '高温 60-80', lo: 60, hi: 80, c: '#c98a4b' },
    { name: '过热 80-100', lo: 80, hi: 100, c: '#ff5a5a' }
  ];
  const KS = [1, 3, 5];
  // v4.7 位置条件: 情绪值在近 10 日窗口（含当日）内的分位（≥70=位置高 / ≤30=位置低）
  // ——同一情绪分, 处于市场高位（持续亢奋/高位骤冷）与冰点低位（持续阴跌/反弹初焱）分开统计胜率
  function posRank(i) {
    const d = days[i];
    if (!d || !d.emotion || d.emotion.value == null) return null;
    const win = [];
    for (let j = Math.max(0, i - 9); j <= i; j++) {
      const x = days[j] && days[j].emotion ? days[j].emotion.value : null;
      if (x == null) return null;
      win.push(x);
    }
    return Math.round(win.filter(x => x <= d.emotion.value).length / win.length * 100);
  }
  // v4.6 分层子集 + v4.7 扩展（对"情绪当日"作筛选；max_lb 为 null 的补位日不归入板位分层）
  // f 可接收 (d, i)：i 为存档索引，位置交叉档需要它
  const LAYERS = [
    { k: 'all', name: '全部交易日', f: () => true },
    { k: 'hot', name: '情绪高位期（分位≥80）', f: d => d.emotion && d.emotion.pct_rank != null && d.emotion.pct_rank >= 80 },
    { k: 'ice', name: '情绪冰点（≤20）', f: d => d.emotion && d.emotion.value != null && d.emotion.value <= 20 },
    { k: 'mid', name: '情绪中部（20-80）', f: d => d.emotion && d.emotion.value != null && d.emotion.value > 20 && d.emotion.value < 80 },
    { k: 'lbhigh', name: '高位板（最高≥5板）', f: d => d.summary && d.summary.max_lb != null && d.summary.max_lb >= 5 },
    { k: 'lbmid', name: '中位板（最高3-4板）', f: d => d.summary && d.summary.max_lb != null && d.summary.max_lb >= 3 && d.summary.max_lb <= 4 },
    { k: 'lblow', name: '低位板（最高≤2板）', f: d => d.summary && d.summary.max_lb != null && d.summary.max_lb <= 2 },
    { k: 'lonely', name: '单兵假主线（最热≤2只）', f: d => d.themeList && d.themeList[0] && d.themeList[0].count != null && d.themeList[0].count <= 2 },
    { k: 'conc', name: '主线集中（集中度≥30%）', f: d => d.emotion && d.emotion.topic_conc != null && d.emotion.topic_conc >= 30 },
    { k: 'scatter', name: '题材散乱（集中度<30%）', f: d => d.emotion && d.emotion.topic_conc != null && d.emotion.topic_conc < 30 },
    { k: 'xhh', name: '高温×位置高（持续亢奋）', f: (d, i) => { if (!d.emotion || d.emotion.value == null) return false; const pr = posRank(i); return pr != null && d.emotion.value >= 60 && pr >= 70; } },
    { k: 'xhl', name: '高温×位置低（冰点初焱）', f: (d, i) => { if (!d.emotion || d.emotion.value == null) return false; const pr = posRank(i); return pr != null && d.emotion.value >= 60 && pr <= 30; } },
    { k: 'xll', name: '冰点×位置低（持续阴跌）', f: (d, i) => { if (!d.emotion || d.emotion.value == null) return false; const pr = posRank(i); return pr != null && d.emotion.value <= 40 && pr <= 30; } },
    { k: 'xlh', name: '冰点×位置高（高位骤冷）', f: (d, i) => { if (!d.emotion || d.emotion.value == null) return false; const pr = posRank(i); return pr != null && d.emotion.value <= 40 && pr >= 70; } }
  ];
  // v4.6 可配置阈值（持久化本机；默认与 v4.5 相同：跳变 15 分 / 赚钱效应 -3%）
  let TH = Object.assign({ jump: 15, yzt: -3 }, LAB.get('s11_th', {}));
  const metaAbn = () => (META.abnormalDays || []);
  const localAbn = () => LAB.get('s11_abn_local', []);
  const abnAll = () => Array.from(new Set([...metaAbn(), ...localAbn()]));

  const days = DAYS;
  const shSeq = days.map(d => { const v = (d.indexes || {})['上证指数']; return v == null ? null : v; });
  const stockMap = {};
  Object.entries(D.stocks || {}).forEach(([code, st]) => {
    const m = new Map(); (st.closes || []).forEach(([dt, c]) => m.set(dt, c)); stockMap[code] = m;
  });

  function shFwd(i, k) {
    if (shSeq[i] == null) return null;
    let prod = 1;
    for (let j = i + 1; j <= i + k; j++) { if (shSeq[j] == null) return null; prod *= 1 + shSeq[j] / 100; }
    return (prod - 1) * 100;
  }
  function topicFwd(i, k) {
    const d = days[i];
    const tags = (d.themeList || []).slice(0, 3).map(t => t.tag);
    if (!tags.length || !days[i + k]) return [];
    const rets = [];
    (d.hot || []).forEach(h => {
      const rs = (h.reason || '').split(/[+＋]/).map(t => t.trim());
      if (!tags.some(t => rs.includes(t))) return;
      const m = stockMap[h.code]; if (!m) return;
      const c0 = m.get(d.trade_date); if (!c0) return;
      const c1 = m.get(days[i + k].trade_date); if (!c1) return;
      rets.push((c1 / c0 - 1) * 100);
    });
    return rets;
  }
  // 打板接力: day i 的涨停组合在 day i+1 的表现 = days[i+1].summary.yzt_chg
  function yztNext(i) {
    const nx = days[i + 1];
    if (!nx || !nx.summary || nx.summary.yzt_chg == null) return null;
    return nx.summary.yzt_chg;
  }

  // v4.6 疑似黑天鹅候选（阈值可配）：情绪单日跳变 |Δ|≥TH.jump 分 或 打板赚钱效应 ≤TH.yzt%
  function suspectDays() {
    const out = [];
    days.forEach((d, i) => {
      if (abnAll().includes(d.trade_date)) return;
      const v = d.emotion ? d.emotion.value : null;
      const p = i > 0 && days[i - 1].emotion ? days[i - 1].emotion.value : null;
      const yz = d.summary ? d.summary.yzt_chg : null;
      const why = [];
      if (v != null && p != null && Math.abs(v - p) >= TH.jump) why.push('情绪跳变' + (v - p > 0 ? '+' : '') + (v - p).toFixed(1));
      if (yz != null && yz <= TH.yzt) why.push('赚钱效应' + yz + '%');
      if (why.length) out.push({ date: d.trade_date, why: why.join('·') });
    });
    return out;
  }

  // 汇总（excludeAbnormal: 剔除 meta.abnormalDays+本地标记；layerFn: v4.6 分层子集过滤）
  function compute(excludeAbnormal, layerFn) {
    const acc = {};
    BUCKETS.forEach(b => { acc[b.name] = {}; KS.forEach(k => acc[b.name][k] = { shN: 0, shWin: 0, shSum: 0, tpN: 0, tpWin: 0, tpSum: 0, yzN: 0, yzWin: 0, yzSum: 0 }); });
    let excluded = 0, layerN = 0;
    days.forEach((d, i) => {
      if (layerFn && !layerFn(d, i)) return;
      layerN++;
      if (excludeAbnormal && abnAll().includes(d.trade_date)) { excluded++; return; }
      const v = d.emotion ? d.emotion.value : null;
      if (v == null) return;
      const b = BUCKETS.find(x => v >= x.lo && v < x.hi) || BUCKETS[BUCKETS.length - 1];
      KS.forEach(k => {
        const a = acc[b.name][k];
        const sr = shFwd(i, k);
        if (sr != null) { a.shN++; a.shSum += sr; if (sr > 0) a.shWin++; }
        topicFwd(i, k).forEach(r => { a.tpN++; a.tpSum += r; if (r > 0) a.tpWin++; });
        if (k === 1) {
          const yr = yztNext(i);
          if (yr != null) { a.yzN++; a.yzSum += yr; if (yr > 0) a.yzWin++; }
        }
      });
    });
    return { acc, excluded, layerN };
  }

  const cell = (a, kind) => {
    const N = a[kind + 'N'], W = a[kind + 'Win'], S = a[kind + 'Sum'];
    if (!N) return '<span class="dim">—</span>';
    const win = Math.round(W / N * 100), avg = S / N;
    const col = avg > 0.05 ? 'up' : (avg < -0.05 ? 'down' : 'dim');
    const nSt = N < 10 ? 'color:#ff5a5a;font-weight:700' : '';
    return `<b class="num ${col}">${win}%</b><span class="dim" style="font-size:10.5px;${nSt}"> (${N}样本${N < 10 ? '⚠' : ''})</span><br><span class="num ${col}" style="font-size:11px">均值 ${avg > 0 ? '+' : ''}${avg.toFixed(2)}%</span>`;
  };

  // 渲染
  let curLayer = 'all';
  function render(exclude) {
    const layer = LAYERS.find(l => l.k === curLayer) || LAYERS[0];
    const computed = compute(exclude, layer.f);
    const acc = computed.acc;
    const cell0 = (a, kind) => cell(a, kind);
    const tbl = (kind, title, note, ks) => `
      <h4 style="margin:14px 0 6px">${title}</h4>
      <div class="dim" style="font-size:11.5px;margin-bottom:6px">${note}</div>
      <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12.5px">
        <thead><tr>${['', ...ks.map(k => `未来 <b>${k}</b> 日`)].map(h => `<th style="padding:6px 8px;border-bottom:1px solid #212a3a;text-align:center">${h}</th>`).join('')}</tr></thead>
        <tbody>${BUCKETS.map(b => `<tr>
          <td style="padding:7px 8px;border-bottom:1px solid #171e2c;color:${b.c};font-weight:700;white-space:nowrap">${b.name}</td>
          ${ks.map(k => `<td style="padding:7px 8px;border-bottom:1px solid #171e2c;text-align:center">${cell0(acc[b.name][k], kind)}</td>`).join('')}
        </tr>`).join('')}</tbody>
      </table></div>`;
    // 打板接力表（单列: 次日）
    const yzTbl = `
      <h4 style="margin:14px 0 6px">🎯 打板接力（昨日涨停指数 883994 次日表现）</h4>
      <div class="dim" style="font-size:11.5px;margin-bottom:6px">口径: 当日情绪区间下买入涨停股, 次日平均盈亏（同花顺昨涨停指数, 成分每日重置）。衡量短线资金接力容错率。</div>
      <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12.5px">
        <thead><tr><th style="padding:6px 8px;border-bottom:1px solid #212a3a;text-align:left">情绪区间</th><th style="padding:6px 8px;border-bottom:1px solid #212a3a;text-align:center">次日</th></tr></thead>
        <tbody>${BUCKETS.map(b => `<tr>
          <td style="padding:7px 8px;border-bottom:1px solid #171e2c;color:${b.c};font-weight:700">${b.name}</td>
          <td style="padding:7px 8px;border-bottom:1px solid #171e2c;text-align:center">${cell0(acc[b.name][1], 'yz')}</td>
        </tr>`).join('')}</tbody>
      </table></div>`;

    const totalSh = KS.reduce((s, k) => s + acc['中性 40-60'][k].shN, 0);
    const totalTp = KS.reduce((s, k) => s + acc['中性 40-60'][k].tpN, 0);
    const totalYz = acc['中性 40-60'][1].yzN;
    // v4.6 疑似黑天鹅候选（阈值可配 + 勾选写入本地标记）
    const abn = abnAll();
    const cand = suspectDays();
    const candHtml = !cand.length
      ? `<div class="dim" style="font-size:11.5px;margin-bottom:8px">🔎 疑似黑天鹅候选：无（阈值 跳变≥${TH.jump} 分 / 赚钱效应≤${TH.yzt}%）</div>`
      : `<div class="dim" style="font-size:11.5px;margin:0 0 6px">🔎 疑似黑天鹅候选（阈值 跳变≥<b>${TH.jump}</b> 分 / 赚钱效应≤<b>${TH.yzt}%</b> 可在上方调整）——勾选后点「写入本地标记」加入剔除名单：</div>
      <div style="display:flex;gap:10px 16px;flex-wrap:wrap;margin-bottom:8px;font-size:12px">${cand.map(c => `
        <label style="cursor:pointer;display:flex;align-items:center;gap:5px"><input type="checkbox" class="s11-cand" value="${c.date}" style="cursor:pointer">
        <span style="color:#c9a04e">${c.date.slice(5)}（${c.why}）</span></label>`).join('')}</div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
        <button class="btn mini gold" id="s11-write">✍️ 写入本地标记</button>
        <button class="btn mini" id="s11-clear">清除本地标记（${localAbn().length}）</button>
        <span class="dim" style="font-size:11px">当前剔除名单：meta ${metaAbn().length} 天 + 本地 ${localAbn().length} 天（本地标记仅存本机, meta 由 build 管道维护）</span>
      </div>`;
    $id('s11-body').innerHTML =
      `<div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
        <label style="font-size:12.5px;cursor:pointer;display:flex;align-items:center;gap:6px">
          <input type="checkbox" id="s11-excl" ${exclude ? 'checked' : ''} style="cursor:pointer">
          剔除异常交易日${abn.length ? '（名单 ' + abn.length + ' 天' + (abn.length <= 8 ? '：' + abn.map(x => x.slice(5)).join('·') : '') + '）' : ''}</label>
        <span style="font-size:12.5px;display:flex;align-items:center;gap:6px">分层回测
          <select id="s11-layer" style="min-width:230px" title="位置交叉档口径：位置 = 情绪值在近 10 日窗口内的分位（≥70 位置高 / ≤30 位置低）——同一情绪分在不同市场位置分开统计">${LAYERS.map(l => `<option value="${l.k}" ${l.k === curLayer ? 'selected' : ''}>${l.name}（${days.filter(l.f).length} 天）</option>`).join('')}</select></span>
        <span style="font-size:12.5px;display:flex;align-items:center;gap:4px">预筛阈值: 跳变≥<input type="number" id="s11-th-jump" value="${TH.jump}" min="1" max="50" step="1" style="width:58px;background:var(--panel2);border:1px solid var(--line);border-radius:6px;color:var(--fg);padding:3px 6px">分 · 赚钱效应≤<input type="number" id="s11-th-yzt" value="${TH.yzt}" min="-20" max="0" step="0.5" style="width:58px;background:var(--panel2);border:1px solid var(--line);border-radius:6px;color:var(--fg);padding:3px 6px">%</span>
        ${computed.excluded ? `<span class="dim" style="font-size:11.5px">已剔除 ${computed.excluded} 天</span>` : ''}
        ${layer.k !== 'all' && computed.layerN < 10 ? `<span style="font-size:11.5px;color:#ff5a5a;font-weight:700">⚠ 该分层仅 ${computed.layerN} 天（<10）, 结果不可靠</span>` : ''}
      </div>` +
      candHtml +
      `<div class="kpi" style="margin-bottom:10px"><div class="lab">样本覆盖</div><div class="val num">${computed.layerN}<small style="font-size:12px;color:var(--dim)"> 交易日（${layer.name}）</small></div><div class="sub">大盘 ${totalSh}+ · 题材个股 ${totalTp}+ · 打板接力 ${totalYz}（随存档增长自动更新）</div></div>` +
      tbl('sh', '📊 大盘（上证指数）未来盈亏概率', '口径: 区间内每个交易日, 上证指数其后 1/3/5 交易日涨跌幅连乘。胜率=上涨占比 · 均值=算术平均。', KS) +
      tbl('tp', '🔥 题材（当日 TOP3 热门题材成员股）未来盈亏概率', '口径: 每日 topics 词频前 3 题材的强势股成员, 按个股存档收盘价计其后 1/3/5 交易日收益。', KS) +
      yzTbl +
      `<div class="warn" style="margin-top:10px">⚠ 回测基于历史存档统计（样本量见括号内数字，<span style="color:#ff5a5a">红色 = 少于 10 天，仅供参考</span>；建议 ≥60 个交易日再固化规则），不构成投资建议；补位期（池数据缺失日）情绪值由中性因子构成，区间归属略有偏移。分层子集把样本切得更细，红色警告会更频繁出现——这是特性不是缺陷。<b>v4.7 位置交叉</b>：位置 = 情绪值在近 10 日窗口内的分位（≥70 高 / ≤30 低）——同一情绪分在「持续亢奋 / 冰点初焱 / 持续阴跌 / 高位骤冷」四种位置下后续胜率截然不同，尤其「冰点×位置高」（高位跳水后骤冷）是典型风险象限。</div>`;
    const noteEl = $id('s11-note');
    if (noteEl) noteEl.textContent = '存档 ' + days.length + ' 个交易日 · 区间 5 档 × 前瞻 1/3/5 日 + 打板接力 · ' + (exclude ? '已剔除异常日' : '全样本') + ' · ' + layer.name;
    // 事件绑定
    const cb = $id('s11-excl');
    if (cb) cb.onchange = () => render(cb.checked);
    const layerSel = $id('s11-layer');
    if (layerSel) layerSel.onchange = () => { curLayer = layerSel.value; render(exclude); };
    ['s11-th-jump', 's11-th-yzt'].forEach((id, idx) => {
      const inp = $id(id); if (!inp) return;
      inp.onchange = () => {
        const v = parseFloat(inp.value);
        if (isNaN(v)) { inp.value = idx === 0 ? TH.jump : TH.yzt; return; }
        if (idx === 0) TH.jump = Math.max(1, Math.min(50, v)); else TH.yzt = Math.max(-20, Math.min(0, v));
        LAB.set('s11_th', TH);
        LAB.toast('预筛阈值已更新并保存（本机）');
        render(exclude);
      };
    });
    const wbtn = $id('s11-write');
    if (wbtn) wbtn.onclick = () => {
      const picked = Array.from(document.querySelectorAll('.s11-cand:checked')).map(x => x.value);
      if (!picked.length) { LAB.toast('请先勾选候选日'); return; }
      const merged = Array.from(new Set([...localAbn(), ...picked]));
      LAB.set('s11_abn_local', merged);
      LAB.toast('已写入本地标记 ' + picked.length + ' 天（与 meta 合并生效）');
      render(exclude);
    };
    const cbtn = $id('s11-clear');
    if (cbtn) cbtn.onclick = () => {
      LAB.set('s11_abn_local', []);
      LAB.toast('本地标记已清除（meta 标记不受影响）');
      render(exclude);
    };
  }
  render(false);
})();
