/* ═══════════ S9 休市日历史回顾 ═══════════ */
(function () {
  const hol = (META.holidays || []).slice().sort();
  const box = $id('s9-box');
  const addDay = s => { const [y, m, d] = s.split('-').map(Number); const dt = new Date(y, m - 1, d + 1); return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0'); };
  const isWk = s => { const d = new Date(s + 'T00:00:00').getDay(); return d >= 1 && d <= 5; };

  if (!hol.length) { box.innerHTML = '<div class="sec-desc">存档中暂无已知假日记录。</div>'; return; }

  // 合并连续假日为区段
  const segs = [];
  hol.forEach(h => { const last = segs[segs.length - 1]; if (last && addDay(last.end) === h) last.end = h; else segs.push({ start: h, end: h }); });

  const dayInfo = dt => {
    const d = DAYS.find(x => x.trade_date === dt);
    if (!d) return null;
    const e = d.emotion || {}, tp = (d.themeList || [])[0] || {};
    return { emo: e.value, emoPct: e.pct_rank, net: e.lhb_daily_net, topic: tp.tag, hot: (d.summary || {}).hot_count };
  };

  const cards = segs.map(sg => {
    // 节前最后交易日
    let pre = null;
    for (const d of DAYS) if (d.trade_date < sg.start) pre = d.trade_date;
    // 节后第一个交易日: 从 end+1 推进（跳过周末与假日），若命中存档则取数据，否则为未来
    let post = addDay(sg.end);
    while (hol.includes(post) || !isWk(post)) post = addDay(post);
    const preInfo = pre ? dayInfo(pre) : null;
    const postInfo = dayInfo(post); // 不在存档 → null
    const days = Math.round((new Date(sg.end + 'T00:00:00') - new Date(sg.start + 'T00:00:00')) / 86400000) + 1;
    const chip = (label, v, clsName) => `<span style="font-size:12px">${label} <b class="num ${clsName || ''}">${v}</b></span>`;
    let inner = `<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap"><b style="color:var(--gold)">${sg.start}${days > 1 ? ' ~ ' + sg.end : ''}</b><span class="dim" style="font-size:12px">${days} 天假期 · A股休市</span></div>`;
    inner += `<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:6px">`;
    inner += preInfo
      ? `<span style="font-size:12px">节前最后交易日 <b class="num">${pre}</b>：</span>` +
        chip('情绪', preInfo.emo + '（分位 ' + preInfo.emoPct + '%）') +
        chip('净买', (preInfo.net >= 0 ? '+' : '') + preInfo.net + '亿', preInfo.net >= 0 ? 'up' : 'down') +
        chip('最热', preInfo.topic || '—')
      : '<span class="dim" style="font-size:12px">节前无存档数据（早于存档起点）</span>';
    inner += `</div>`;
    if (postInfo) {
      const diff = preInfo && preInfo.emo != null ? (postInfo.emo - preInfo.emo) : null;
      inner += `<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:4px"><span style="font-size:12px">节后首日 <b class="num">${post}</b>：</span>` +
        chip('情绪', postInfo.emo + (diff != null ? `（较节前 <span class="${cls(diff)}">${diff > 0 ? '+' : ''}${diff.toFixed(1)}</span>）` : '')) +
        chip('净买', (postInfo.net >= 0 ? '+' : '') + postInfo.net + '亿', postInfo.net >= 0 ? 'up' : 'down') + `</div>`;
    } else if (post > CUR.trade_date) {
      const wd = ['日', '一', '二', '三', '四', '五', '六'][new Date(post + 'T00:00:00').getDay()];
      inner += `<div style="margin-top:4px;font-size:12px;color:#8fb0ff">节后首个交易日 <b class="num">${post}（周${wd}）</b> · 数据待入库（每日 15:35 自动抓取）</div>`;
    }
    return `<div class="fc-card">${inner}</div>`;
  }).join('');

  box.innerHTML = cards + `<div class="sec-desc" style="margin-top:8px">📖 节后效应观察口径：长假后首日情绪常受外围与消息面放大（高开低开皆常见），建议把「节前最后交易日 + 节后首日」作为一组对照样本积累。假日清单来自系统日历校验（指数日K缺口），后续假期自动追加。</div>`;
})();
