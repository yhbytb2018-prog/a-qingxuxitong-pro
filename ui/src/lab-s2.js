/* ═══════════ S2 预测追踪器 ═══════════ */
(function () {
  let FCS = LAB.get('forecasts', []);
  let dir = 'up';

  $id('s2-dir').querySelectorAll('.dirbtn').forEach(b => b.onclick = () => {
    dir = b.dataset.v;
    $id('s2-dir').querySelectorAll('.dirbtn').forEach(x => x.classList.toggle('on', x === b));
  });
  $id('s2-dir').querySelector('[data-v="up"]').classList.add('on');

  const save = () => LAB.set('forecasts', FCS);
  const DIRC = { up: ['上行 ▲', 'up'], down: ['下行 ▼', 'down'], flat: ['震荡 ▶', 'flat'] };

  function settleOne(f) {
    if (f.status !== 'pending' || !f.targetDate) return f;
    const i = LAB.idxOf[f.targetDate];
    if (i == null) return f; // 未来数据未到
    const actual = DAYS[i].emotion ? DAYS[i].emotion.value : null;
    if (actual == null) return f;
    const diff = +(actual - f.baseValue).toFixed(1);
    let hit;
    if (f.dir === 'up') hit = diff > 0;
    else if (f.dir === 'down') hit = diff < 0;
    else hit = Math.abs(diff) <= 2;
    return { ...f, status: hit ? 'hit' : 'miss', settledValue: actual, settledDiff: diff, settledAt: Date.now() };
  }

  function settleAll() {
    let changed = false;
    FCS = FCS.map(f => { const nf = settleOne(f); if (nf !== f) changed = true; return nf; });
    if (changed) { save(); LAB.toast('有预测到期，已自动结算'); }
  }

  $id('s2-add').onclick = () => {
    const hz = +$id('s2-hz').value;
    const target = LAB.nextTrade(CUR.trade_date, hz);
    FCS.unshift({
      id: Date.now(), createdAt: CUR.trade_date, dir,
      baseValue: CUR.emotion ? CUR.emotion.value : 50,
      horizon: hz, targetDate: target,
      reason: $id('s2-reason').value.trim(),
      status: 'pending'
    });
    save();
    $id('s2-reason').value = '';
    LAB.toast(target ? '已立字为据 · ' + target + ' 到期自动结算' : '已记录 · 数据积累到位后自动结算');
    render();
  };

  function renderKpis() {
    const done = FCS.filter(f => f.status !== 'pending');
    const hits = done.filter(f => f.status === 'hit');
    const rate = done.length ? (hits.length / done.length * 100).toFixed(0) + '%' : '—';
    const dirRate = d => { const dd = done.filter(f => f.dir === d); return dd.length ? (dd.filter(f => f.status === 'hit').length / dd.length * 100).toFixed(0) + '%(' + dd.length + ')' : '—'; };
    const pend = FCS.filter(f => f.status === 'pending').length;
    $id('s2-kpis').innerHTML = `
      <div class="kpi"><div class="lab">待结算</div><div class="val num">${pend}</div><div class="sub">数据到位自动判卷</div></div>
      <div class="kpi k-gold"><div class="lab">已结算</div><div class="val num gold">${done.length}</div><div class="sub">命中 ${hits.length} / 打脸 ${done.length - hits.length}</div></div>
      <div class="kpi ${done.length && hits.length / done.length >= 0.5 ? 'k-up' : 'k-down'}"><div class="lab">总胜率</div><div class="val num">${rate}</div><div class="sub">诚实记录 · 不许改口</div></div>
      <div class="kpi"><div class="lab">分方向胜率</div><div class="val" style="font-size:16px"><span class="up">上行 ${dirRate('up')}</span> <span class="down">下行 ${dirRate('down')}</span></div><div class="sub">震荡 ${dirRate('flat')}</div></div>`;
  }

  function renderList() {
    const host = $id('s2-list');
    if (!FCS.length) { host.innerHTML = '<div class="sec-desc">还没有记录。选方向 → 写理由 → 立字为据。判断只能从「现在」开始写，到期自动结算——先写下来，防止事后诸葛亮。</div>'; return; }
    const pend = FCS.filter(f => f.status === 'pending');
    const done = FCS.filter(f => f.status !== 'pending').sort((a, b) => (b.settledAt || 0) - (a.settledAt || 0));
    const card = f => {
      const [dt, dc] = DIRC[f.dir] || ['?', ''];
      const stBadge = f.status === 'pending'
        ? `<span class="fc-st pending">待结算</span>`
        : f.status === 'hit'
          ? `<span class="fc-st hit">✅ 命中</span>`
          : `<span class="fc-st miss">❌ 打脸</span>`;
      const resultLine = f.status === 'pending'
        ? `基线 <b class="num">${f.baseValue}</b> → 目标日 <b class="num">${f.targetDate || '待数据'}</b>（${f.horizon} 个交易日后）`
        : `基线 <b class="num">${f.baseValue}</b> → 实际 <b class="num">${f.settledValue}</b>（<span class="${cls(f.settledDiff)}">${f.settledDiff > 0 ? '+' : ''}${f.settledDiff}</span>）`;
      return `<div class="fc-card">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <b class="${dc}">${dt}</b>
          <span class="num dim" style="font-size:12px">${f.createdAt} → ${f.targetDate || '?'}</span>
          ${stBadge}
          <span class="btn mini danger" style="margin-left:auto" data-del="${f.id}">删除</span>
        </div>
        <div style="margin-top:5px;font-size:12.5px">${resultLine}</div>
        ${f.reason ? `<div class="dim" style="font-size:12px;margin-top:3px">理由: ${f.reason.replace(/</g, '&lt;')}</div>` : ''}
      </div>`;
    };
    host.innerHTML =
      (pend.length ? `<div style="font-size:12px;color:#8fb0ff;margin:6px 0">⏳ 待结算（${pend.length}）</div>` + pend.map(card).join('') : '') +
      (done.length ? `<div style="font-size:12px;color:var(--dim);margin:10px 0 6px">📋 已结算（${done.length}）</div>` + done.map(card).join('') : '');
    host.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
      FCS = FCS.filter(f => f.id !== +b.dataset.del);
      save(); render(); LAB.toast('已删除');
    });
  }

  function render() { settleAll(); renderKpis(); renderList(); }
  render();
})();
