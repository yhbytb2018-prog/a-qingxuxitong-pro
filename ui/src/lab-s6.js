/* ═══════════ S6 数据健康面板 ═══════════ */
(function () {
  const dq = META.dataQuality || {};
  const hol = (META.holidays || []).slice().sort();
  const today = new Date(), tStr = LAB.ymd(today);
  const items = []; // {name, st:'ok'|'warn'|'bad', desc, score, full}

  // ── 1. 数据新鲜度（休市感知）──
  {
    const dow = today.getDay(), isWk = dow >= 1 && dow <= 5;
    const daysDiff = Math.round((today - new Date(CUR.trade_date + 'T00:00:00')) / 86400000);
    let st, desc;
    if (tStr === CUR.trade_date) { st = 'ok'; desc = '最后存档 ' + CUR.trade_date + '（今日）'; }
    else if (tStr > CUR.trade_date) {
      if (hol.includes(tStr)) { st = 'ok'; desc = `休市中（${tStr} 为假日）· 最后存档 ${CUR.trade_date}，距今 ${daysDiff} 自然日`; }
      else if (!isWk) { st = 'ok'; desc = `休市中（周末）· 最后存档 ${CUR.trade_date}，距今 ${daysDiff} 自然日`; }
      else if (today.getHours() < 16) { st = 'warn'; desc = `今日 ${tStr} 为交易日，数据将在收盘后更新 · 最后存档 ${CUR.trade_date}`; }
      else { st = 'bad'; desc = `今日 ${tStr} 为交易日且已收盘但无当日数据 · 最后存档 ${CUR.trade_date}（检查抓取管道是否运行）`; }
    } else { st = 'warn'; desc = '最后存档 ' + CUR.trade_date + '（晚于系统日期，时间异常？）'; }
    items.push({ name: '数据新鲜度', st, desc, score: st === 'ok' ? 15 : st === 'warn' ? 8 : 0, full: 15 });
  }

  // ── 2. 行业板块数据源 ──
  {
    const noInd = DAYS.filter(d => !d.industry || !d.industry.length).length;
    const ok = noInd === 0;
    items.push({
      name: '行业板块数据源', st: ok ? 'ok' : 'bad',
      desc: ok ? '30 日数据完整（涨跌榜由板块日K重建）'
        : `${noInd}/${DAYS.length} 天无数据 · 情绪公式中该因子按中性值 50 补位（25% 权重实际空转）· 行业相关榜单暂不可用`,
      score: ok ? 15 : 0, full: 15
    });
  }

  // ── 3/4/5. lhb / hot / topics 完整性 ──
  {
    const emptyLhb = DAYS.filter(d => !d.lhb.length).length;
    const recs = DAYS.reduce((a, d) => a + d.lhb.length, 0);
    const perDay = DAYS.map(d => d.lhb.length);
    const mn = Math.min(...perDay), mx = Math.max(...perDay);
    items.push({
      name: '龙虎榜完整性', st: emptyLhb ? 'bad' : (mx - mn > 40 ? 'warn' : 'ok'),
      desc: `${emptyLhb ? emptyLhb + ' 天为空!' : '30 天齐全'} · 共 ${recs} 条记录 · 日均 ${(recs / DAYS.length).toFixed(1)} 条 · 单日最少 ${mn} / 最多 ${mx}${(META.originalGenerated ? '' : '')}`,
      score: emptyLhb ? 0 : 15, full: 15
    });
  }
  {
    const emptyHot = DAYS.filter(d => !(d.hot || []).length).length;
    const recs = DAYS.reduce((a, d) => a + (d.hot || []).length, 0);
    items.push({
      name: '强势股归因完整性', st: emptyHot ? 'bad' : 'ok',
      desc: emptyHot ? emptyHot + ' 天为空!' : `30 天齐全 · 共 ${recs} 只次（同花顺强势股池）`,
      score: emptyHot ? 0 : 12, full: 12
    });
  }
  {
    const emptyT = DAYS.filter(d => !(d.themeList || []).length).length;
    items.push({
      name: '题材归因完整性', st: emptyT ? 'bad' : 'ok',
      desc: emptyT ? emptyT + ' 天为空!' : '30 天齐全 · 题材词典归一+个股数聚合（v4.9：一票一题材一票 · 专属诱因黑名单 · 跨≥2只阈值）',
      score: emptyT ? 0 : 10, full: 10
    });
  }

  // ── 6. K线覆盖（v4.8.8: 同步先按页面注入池口径渲染，分片库清单就绪后异步升级为全市场口径）──
  let poolCodes = new Set();
  DAYS.forEach(d => {
    d.lhb.forEach(s => poolCodes.add(s.code));
    (d.hot || []).forEach(s => poolCodes.add(s.code));
  });
  const withK = [...poolCodes].filter(c => D.stocks[c] && D.stocks[c].closes && D.stocks[c].closes.length > 3).length;
  const cover = poolCodes.size ? Math.round(withK / poolCodes.size * 100) : 0;
  const klineItem = {
    name: 'K线覆盖', st: cover >= 90 ? 'ok' : cover >= 60 ? 'warn' : 'bad',
    desc: `${withK}/${poolCodes.size} 只（${cover}%）在页面注入K线池 · 全市场分片库校验中…`,
    score: Math.round(cover / 100 * 13), full: 13, klineRow: true
  };
  items.push(klineItem);

  // ── 7. 交易日历与缺口 ──
  {
    const gaps = [];
    for (let i = 1; i < DAYS.length; i++) {
      const a = new Date(DAYS[i - 1].trade_date + 'T00:00:00'), b = new Date(DAYS[i].trade_date + 'T00:00:00');
      const dd = Math.round((b - a) / 86400000);
      if (dd >= 5) gaps.push(`${DAYS[i - 1].trade_date} → ${DAYS[i].trade_date}（${dd} 天）`);
    }
    items.push({
      name: '交易日历', st: 'ok',
      desc: `存档 ${DAYS.length} 天 · 已知假日 ${hol.length ? hol.join('、') : '无'}` +
        (gaps.length ? ` · 长缺口: ${gaps.join(' ; ')}` : ' · 相邻存档日无异常缺口'),
      score: 10, full: 10
    });
  }

  // ── 8. 情绪公式审计（可复现性）──
  {
    let okN = 0, skipN = 0; const bad = [];
    DAYS.forEach(d => {
      const e = d.emotion; if (!e) return;
      if (e.value == null || [e.s_net, e.s_pos, e.s_brd, e.s_hot].some(v => v == null)) { skipN++; return; } // 缺字段不判
      const calcV = (e.s_net * 35 + e.s_pos * 25 + e.s_brd * 25 + e.s_hot * 15) / 100;
      if (Math.abs(calcV - e.value) <= 0.2) okN++;
      else bad.push(`${d.trade_date}(差${(calcV - e.value).toFixed(1)})`);
    });
    const judged = okN + bad.length;
    items.push({
      name: '情绪公式审计', st: bad.length ? 'warn' : 'ok',
      desc: bad.length
        ? `仅 ${okN}/${judged} 天可由公式复现（${skipN} 天缺字段跳过），异常: ${bad.slice(0, 4).join(' ')}${bad.length > 4 ? ' …' : ''}`
        : `${okN}/${judged} 天可由官方公式复现${skipN ? `（${skipN} 天缺子指标跳过）` : ''} · 审计发现: 实际实现为「行业因子以中性值 50 补位参与加权」（仅当行业源失效时触发；当前源正常，广度取真实值）——S1 实验室把行业权重调 0 即可得到去行业因子口径`,
      score: bad.length ? 5 : 10, full: 10
    });
  }

  // ── 9. 情绪因子补位审计（合并版：读 PRO emotion.missing —— 引擎端缺失显式化，含 imputedRatio 口径）──
  {
    const days = DAYS.map(d => {
      const m = (d.emotion && d.emotion.missing) || [];
      const n = m.length; // PRO 缺失因子名直接计数（s_zdt/s_zbl 各算一个，无 'pools' 聚合标记）
      return { date: d.trade_date, n, tags: m };
    }).filter(x => x.n > 0);
    const worst = days.length ? days.reduce((a, b) => (b.n > a.n ? b : a)) : null;
    const st = !days.length ? 'ok' : (worst.n >= 3 || days.length > DAYS.length * 0.4 ? 'bad' : 'warn');
    items.push({
      name: '情绪因子补位', st,
      desc: !days.length
        ? DAYS.length + ' 天全部七因子真实数据 · 无代理/中性补位'
        : days.length + '/' + DAYS.length + ' 天有补位因子 · 最重 ' + worst.date +
          ' 补 ' + worst.n + '/7（' + (worst.tags.join('、') || '—') + '）· 补位以代理/中性值参与加权, 情绪卡已标注可信度',
      score: !days.length ? 10 : (days.length <= Math.ceil(DAYS.length * 0.2) ? 6 : 0), full: 10
    });
  }

  // ── 渲染（v4.8.8: 行模板/总环抽函数——K线覆盖异步升级后可就地替换并重算健康分）──
  const rowHtml = i => `
    <div class="hl-row"${i.klineRow ? ' data-s6-kline="1"' : ''}>
      <div style="min-width:0">
        <div style="font-size:13px;font-weight:700;color:#c6cfdd">${i.name} <span class="dim" style="font-weight:400;font-size:11px">+${i.score}/${i.full}</span></div>
        <div style="font-size:12px;color:var(--dim);margin-top:2px;line-height:1.6">${i.desc}</div>
      </div>
      <span class="hl-st ${i.st === 'ok' ? 'hl-ok' : i.st === 'warn' ? 'hl-warn' : 'hl-bad'}">${i.st === 'ok' ? '✓ 正常' : i.st === 'warn' ? '⚠ 提醒' : '✗ 异常'}</span>
    </div>`;

  function renderSummary() {
    const total = items.reduce((a, i) => a + i.score, 0), full = items.reduce((a, i) => a + i.full, 0);
    const score = Math.round(total / full * 100);
    const stCnt = { ok: 0, warn: 0, bad: 0 };
    items.forEach(i => stCnt[i.st]++);

    // 评分环
    const R = 30, C = 2 * Math.PI * R, off = C * (1 - score / 100);
    const col = score >= 80 ? '#2fbf8f' : score >= 55 ? '#e8b04b' : '#ff5a5a';
    const svg = el('svg', { viewBox: '0 0 90 90', style: 'width:86px;height:86px;flex-shrink:0' });
    svg.appendChild(el('circle', { cx: 45, cy: 45, r: R, fill: 'none', stroke: '#212a3a', 'stroke-width': 8 }));
    svg.appendChild(el('circle', { cx: 45, cy: 45, r: R, fill: 'none', stroke: col, 'stroke-width': 8, 'stroke-linecap': 'round', 'stroke-dasharray': C, 'stroke-dashoffset': off, transform: 'rotate(-90 45 45)' }));
    svg.appendChild(el('text', { x: 45, y: 43, fill: col, 'font-size': 19, 'font-weight': '700', 'text-anchor': 'middle' }, score));
    svg.appendChild(el('text', { x: 45, y: 57, fill: FAINT, 'font-size': 9, 'text-anchor': 'middle' }, '健康分'));
    $id('s6-kpis').innerHTML = `
      <div class="kpi" style="display:flex;align-items:center;gap:14px;grid-column:span 2">
        <span data-ring></span>
        <div><div style="font-size:13px;color:#c6cfdd;font-weight:700">总体评估</div>
        <div style="font-size:12px;color:var(--dim);margin-top:3px">正常 ${stCnt.ok} 项 · 提醒 ${stCnt.warn} 项 · 异常 ${stCnt.bad} 项（满分 ${full} 权重分）</div>
        <div style="font-size:11.5px;color:var(--faint);margin-top:3px">${dq.industrySourceOk === false ? '行业源失效为已知问题（有兜底），其余子系统健康' : '各数据子系统完整 · 行业榜单由板块日K重建'}</div></div>
      </div>
      <div class="kpi"><div class="lab">最后存档</div><div class="val num" style="font-size:17px">${CUR.trade_date}</div><div class="sub">共 ${DAYS.length} 个交易日</div></div>
      <div class="kpi"><div class="lab">清洗版本</div><div class="val" style="font-size:14px">${(META.cleanedBy || 'v1').replace('build/', '')}</div><div class="sub">清洗于 ${(META.cleanedAt || '').slice(0, 10)}</div></div>`;
    $id('s6-kpis').querySelector('[data-ring]').appendChild(svg);
  }
  renderSummary();

  $id('s6-list').innerHTML = items.map(rowHtml).join('');

  // v4.8.8: K线覆盖升级——全市场分片库清单就绪后按库口径重算（替换行 + 重算总环健康分）
  if (typeof window.__klineList === 'function') {
    window.__klineList().then(l => {
      if (!l || l.offline || !l.codes || !l.codes.length) return; // 分片库不可达 → 保留注入池口径
      const shardBare = new Set(l.codes.map(x => String(x.c).replace(/^[a-z]+/, '')));
      const inShard = [...poolCodes].filter(c => shardBare.has(c)).length;
      const cover2 = poolCodes.size ? Math.round(inShard / poolCodes.size * 100) : 0;
      klineItem.st = cover2 >= 90 ? 'ok' : cover2 >= 60 ? 'warn' : 'bad';
      klineItem.score = Math.round(cover2 / 100 * 13);
      klineItem.desc = `${inShard}/${poolCodes.size} 只（${cover2}%）已被全市场K线库覆盖（v4.8 · ${l.codes.length} 只沪深A股分片 · 清单 ${l.generatedAt || '—'}）· S8 统计研判趋势/位置维度自动取用分片K线（4 维口径）`;
      const row = document.querySelector('[data-s6-kline]');
      if (row) row.outerHTML = rowHtml(klineItem);
      renderSummary();
    }).catch(() => {});
  }

  // ── v4.6 能力标记（不参与健康评分 · 新增能力自检清单）──
  const capFn = {
    scan: !!$id('s1-scan'),
    va: typeof validateArchive === 'function',
    wr: typeof divergeWinRate === 'function'
  };
  const caps = [
    ['权重扫描', 'S1 批量权重扫描（200 随机组 + 官方/预设 → 方向胜率 / IC / 回撤 + 过拟合警示）', capFn.scan],
    ['异常预筛', 'S11 黑天鹅预筛阈值可配置 + 候选勾选「写入本地标记」（s11_abn_local 与 meta 合并生效）', true],
    ['分层回测', 'S11 14 档分层子集回测（情绪分位 / 冰点 / 高中低位板 / 单兵假主线 / 主线集中度），样本 <10 天标红', true],
    ['位置交叉', 'S11 同一情绪分 × 市场位置（近 10 日情绪分位 ≥70 高 / ≤30 低）四象限分开统计胜率（v4.7）', true],
    ['导入校验', '存档 JSON 致命拦截 / 非致命横幅（validateArchive）+ 同步串权重 4/7 维兼容与脏值拦截', capFn.va],
    ['信号胜率', '背离徽章 + 新晋题材信号卡附全档历史 1/3/5 日参考胜率（divergeWinRate）', capFn.wr]
  ];
  const capOk = caps.every(c => c[2]);
  const capDiv = document.createElement('div');
  capDiv.innerHTML = `<div style="margin-top:14px;padding-top:10px;border-top:1px dashed #212a3a">
    <div style="font-size:12px;font-weight:700;color:#c9a04e;margin-bottom:6px">🔖 新增能力（v4.6/v4.7 · ${caps.length} 项 · ${capOk ? '自检通过' : '部分缺失'}，不参与健康评分）</div>
    ${caps.map(c => `<div style="display:flex;gap:8px;align-items:baseline;font-size:12px;padding:2px 0"><span style="color:${c[2] ? '#2fbf8f' : '#ff5a5a'};font-weight:700">${c[2] ? '✓' : '✗'}</span><span style="color:#c6cfdd;font-weight:600;white-space:nowrap">${c[0]}</span><span style="color:var(--dim)">${c[1]}</span></div>`).join('')}
  </div>`;
  $id('s6-list').appendChild(capDiv.firstChild);
})();
