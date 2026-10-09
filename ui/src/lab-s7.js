/* ═══════════ S7 数据锚定复盘笔记 ═══════════ */
(function () {
  let NOTES = LAB.get('notes', {}); // { 'YYYY-MM-DD': {text, updatedAt} }
  const save = () => LAB.set('notes', NOTES);
  const sel = $id('s7-day');

  function fillSel() {
    sel.innerHTML = '';
    DAYS.slice().reverse().forEach(d => {
      const o = document.createElement('option');
      o.value = d.trade_date;
      o.textContent = d.trade_date + (NOTES[d.trade_date] ? '  📝' : '');
      sel.appendChild(o);
    });
  }

  function loadDay() {
    const d = sel.value;
    const rec = NOTES[d];
    $id('s7-text').value = rec ? rec.text : '';
    $id('s7-hint').textContent = rec ? '上次保存 ' + LAB.fmtDT(rec.updatedAt) : '该日暂无笔记';
  }

  $id('s7-anchor').onclick = () => {
    const d = DAYS.find(x => x.trade_date === sel.value);
    if (!d) return;
    const e = d.emotion || {}, s = d.summary || {}, tp = (d.themeList || [])[0] || {};
    const line = `\n> 📌 [${d.trade_date}] 情绪 ${e.value ?? '—'}（分位 ${e.pct_rank ?? '—'}%）· 净买 ${e.lhb_daily_net == null ? '—' : (e.lhb_daily_net >= 0 ? '+' : '') + e.lhb_daily_net + '亿'} · 最热 ${tp.tag || e.top_topic || '—'} ${tp.count != null ? tp.count + '只' : ''} · 上榜 ${s.lhb_stocks ?? '—'}只\n`;
    const ta = $id('s7-text');
    ta.value += line;
    LAB.toast('已锚定 ' + d.trade_date + ' 快照');
  };

  $id('s7-save').onclick = () => {
    const d = sel.value;
    const t = $id('s7-text').value.trim();
    if (t) NOTES[d] = { text: t, updatedAt: Date.now() };
    else delete NOTES[d];
    save();
    LAB.toast(t ? '笔记已保存（仅存本机浏览器）' : '已清空该日笔记');
    fillSel(); sel.value = d; loadDay(); renderTL();
  };

  $id('s7-export').onclick = () => {
    const keys = Object.keys(NOTES).sort();
    if (!keys.length) { LAB.toast('还没有任何笔记'); return; }
    let md = '# 复盘笔记导出（' + LAB.ymd(new Date()) + '）\n\n共 ' + keys.length + ' 个交易日 · 导出自 A股市场情绪系统 · S7 数据锚定笔记\n';
    keys.forEach(k => {
      const d = DAYS.find(x => x.trade_date === k), e = (d || {}).emotion || {};
      md += `\n---\n\n## ${k}　情绪 ${e.value ?? '—'} · 净买 ${e.lhb_daily_net == null ? '—' : (e.lhb_daily_net >= 0 ? '+' : '') + e.lhb_daily_net + '亿'}\n\n${NOTES[k].text}\n`;
    });
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'sentiment-notes-' + LAB.ymd(new Date()) + '.md';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    LAB.toast('已导出 ' + keys.length + ' 天笔记 (Markdown)');
  };

  function renderTL() {
    const host = $id('s7-timeline');
    const keys = Object.keys(NOTES).sort().reverse();
    if (!keys.length) { host.innerHTML = '<div class="sec-desc">暂无笔记。从上方选择日期开始写——建议每天收盘后 3 句话: 今天发生了什么 / 情绪在周期何处 / 明天盯什么。</div>'; return; }
    host.innerHTML = keys.map(k => {
      const d = DAYS.find(x => x.trade_date === k), e = (d || {}).emotion || {};
      return `<div class="note-item">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <b class="num">${k}</b>
          <span class="num" style="font-size:12px">情绪 <b style="color:${e.value >= 60 ? UP : e.value <= 40 ? DOWN : '#d7dee9'}">${e.value ?? '—'}</b></span>
          <span class="num" style="font-size:12px">净买 <span class="${e.lhb_daily_net >= 0 ? 'up' : 'down'}">${e.lhb_daily_net == null ? '—' : (e.lhb_daily_net >= 0 ? '+' : '') + e.lhb_daily_net + '亿'}</span></span>
          <span class="dim" style="font-size:11px;margin-left:auto">保存于 ${LAB.fmtDT(NOTES[k].updatedAt)}</span>
          <span class="btn mini" data-edit="${k}">编辑</span>
          <span class="btn mini danger" data-del="${k}">删除</span>
        </div>
        <pre>${NOTES[k].text.replace(/</g, '&lt;')}</pre>
      </div>`;
    }).join('');
    host.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => { sel.value = b.dataset.edit; loadDay(); window.scrollTo({ top: $id('s7-text').getBoundingClientRect().top + window.scrollY - 120, behavior: 'smooth' }); });
    host.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
      delete NOTES[b.dataset.del]; save(); fillSel(); loadDay(); renderTL(); LAB.toast('已删除');
    });
  }

  fillSel(); loadDay(); renderTL();
})();
