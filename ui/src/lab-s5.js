/* ═══════════ S5 自选股情绪哨兵 ═══════════ */
(function () {
  let WL = LAB.get('watchlist', []); // [{code, addedAt}]
  const save = () => LAB.set('watchlist', WL);

  // 股票池（用于 datalist 与名称解析）
  const pool = new Map();
  DAYS.forEach(d => {
    d.lhb.forEach(s => { if (!pool.has(s.code)) pool.set(s.code, s.name); });
    (d.hot || []).forEach(s => { if (!pool.has(s.code)) pool.set(s.code, s.name); });
  });
  Object.entries(D.stocks || {}).forEach(([c, st]) => { if (!pool.has(c) && st.name) pool.set(c, st.name); });
  $id('s5-dl').innerHTML = [...pool.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([c, n]) => `<option value="${c}">${n}</option>`).join('');

  const resolveName = code => {
    if (D.stocks[code] && D.stocks[code].name) return D.stocks[code].name;
    for (let i = DAYS.length - 1; i >= 0; i--) {
      const d = DAYS[i];
      const r = d.lhb.find(s => s.code === code) || (d.hot || []).find(s => s.code === code);
      if (r) return r.name;
    }
    return code;
  };

  function timeline(code) {
    const recs = [];
    DAYS.forEach(d => d.lhb.forEach(s => { if (s.code === code) recs.push({ date: d.trade_date, net: s.net_buy_wan || 0, chg: s.change_pct }); }));
    return recs;
  }
  function lastHot(code) {
    for (let i = DAYS.length - 1; i >= 0; i--) {
      const r = (DAYS[i].hot || []).find(s => s.code === code);
      if (r) return { date: DAYS[i].trade_date, reason: r.reason || '' };
    }
    return null;
  }
  function pxInfo(code) {
    const cl = (D.stocks[code] || {}).closes || [];
    if (!cl.length) return null;
    const last = cl[cl.length - 1], first = cl[0];
    return { px: last[1], pxDate: last[0], range: (last[1] / first[1] - 1) * 100, n: cl.length };
  }
  function alerts(code) {
    const out = [];
    const tl = timeline(code);
    if (tl.length) {
      const ago = LAB.idxOf[CUR.trade_date] - LAB.idxOf[tl[tl.length - 1].date];
      if (ago === 0) out.push(['🔔 今日新上榜', 'hot']);
      let consec = 0;
      for (let i = DAYS.length - 1; i >= 0; i--) { if (tl.some(r => r.date === DAYS[i].trade_date)) consec++; else break; }
      if (consec >= 2) out.push(['🔥 连续 ' + consec + ' 日在榜', 'hot']);
      if (ago >= 3) out.push(['💤 已 ' + ago + ' 个交易日未上榜', 'dim']);
      const totalNet = tl.reduce((a, r) => a + r.net, 0);
      if (totalNet <= -10000) out.push(['💧 存档期累计净卖 ' + fmtW(totalNet), 'dn']);
      else if (totalNet >= 10000) out.push(['💰 存档期累计净买 +' + fmtW(totalNet), 'up']);
    } else {
      out.push(['😴 存档期未上过龙虎榜', 'dim']);
    }
    const p = pxInfo(code);
    if (p && p.range <= -10) out.push(['📉 ' + p.n + '日区间 ' + p.range.toFixed(1) + '%', 'dn']);
    else if (p && p.range >= 15) out.push(['🚀 ' + p.n + '日区间 +' + p.range.toFixed(1) + '%', 'up']);
    return out;
  }

  function addStock() {
    const raw = $id('s5-input').value.trim();
    if (!raw) return;
    let code = null;
    if (pool.has(raw)) code = raw;
    else {
      const byName = [...pool.entries()].filter(([, n]) => n === raw);
      if (byName.length) code = byName[0][0];
      else {
        const fuzzy = [...pool.entries()].filter(([, n]) => n.includes(raw));
        if (fuzzy.length === 1) code = fuzzy[0][0];
        else if (fuzzy.length > 1) { LAB.toast('「' + raw + '」匹配 ' + fuzzy.length + ' 只（' + fuzzy.slice(0, 3).map(f => f[1]).join('、') + '…），请输入完整名称或代码'); return; }
      }
    }
    if (!code) { LAB.toast('未找到「' + raw + '」— 输入 6 位代码或完整名称'); return; }
    if (WL.some(w => w.code === code)) { LAB.toast('已在哨兵名单中'); return; }
    WL.unshift({ code, addedAt: Date.now() });
    save(); $id('s5-input').value = '';
    LAB.toast('哨兵已上岗: ' + resolveName(code));
    render();
  }
  $id('s5-add').onclick = addStock;
  $id('s5-input').addEventListener('keydown', e => { if (e.key === 'Enter') addStock(); });

  /* ── v4.9.15: 每张自选股卡片内嵌「市场位置 + 个股信号 + 仓位依据」 ──
     市场判定复用 Tab6 暴露的 window.__mktState（缺失时本地兜底重算，与 Tab6 同规则） */
  function stripTags(s){return String(s||'').replace(/<[^>]+>/g,'');}
  function getMktState(){
    const E=CUR.emotion||{};
    let MS=window.__mktState;
    if(!MS){
      const vals=DAYS.map(d=>d.emotion&&d.emotion.value).filter(v=>v!=null);
      const ref=vals.length>3?vals[vals.length-4]:vals[0];
      const d3=(E.value||0)-(ref!=null?ref:(E.value||0));
      const recentHot=DAYS.slice(-6,-1).some(x=>x.emotion&&x.emotion.value>65);
      const v=E.value==null?50:E.value;
      const st=v<30?'ice':v>65?'hot':d3>=4?'rec':(d3<=-4&&recentHot)?'ret':'neu';
      MS={st,name:{ice:'❄ 冰点区',rec:'📈 回升期',neu:'➖ 中性区',hot:'🔥 偏热区',ret:'🌧 退潮期'}[st],play:[],warns:[],d3};
    }
    return MS;
  }
  function spark(vals){ // 近 5 点迷你折线（涨红跌绿）
    const w=96,h=24,p=3;
    if(!vals||vals.length<2)return '';
    const mn=Math.min(...vals),mx=Math.max(...vals),rg=(mx-mn)||1;
    const pts=vals.map((v,i)=>(p+i*(w-2*p)/(vals.length-1)).toFixed(1)+','+(h-p-(v-mn)/rg*(h-2*p)).toFixed(1)).join(' ');
    const col=vals[vals.length-1]>=vals[0]?'#ff5a5a':'#2fbf8f';
    return `<svg width="${w}" height="${h}" style="vertical-align:middle" aria-label="近5日走势"><polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round"/></svg>`;
  }
  function trend5(code){ // 个股近 5 日收盘走势
    const cl=(D.stocks[code]||{}).closes||[];
    if(cl.length<2)return null;
    const l5=cl.slice(-5);
    return {vals:l5.map(c=>c[1]),chg:(l5[l5.length-1][1]/l5[0][1]-1)*100};
  }
  // v4.9.16: 个股级冷热状态（与市场五状态区分开）——近5日动量 + 近5日是否触板
  function stockState(code,t5,lastLhb){
    const cl=(D.stocks[code]||{}).closes||[];
    let chg=t5?t5.chg:null;
    if(chg==null&&lastLhb&&lastLhb.chg!=null)chg=lastLhb.chg; // 无K线时用上榜当日涨幅兜底
    let lim=false;
    for(let i=Math.max(1,cl.length-5);i<cl.length;i++){ if(cl[i][1]/cl[i-1][1]>=1.095){lim=true;break;} }
    if(lim||(chg!=null&&chg>=10))return {k:'hot',n:'🔥 热门股',why:lim?'近5日触板':'近5日动量强'};
    if(chg!=null&&chg>=3)return {k:'up',n:'📈 走强',why:'近5日动量偏强'};
    if(chg!=null&&chg<=-10)return {k:'ice',n:'❄ 冰点股',why:'近5日大跌'};
    if(chg!=null&&chg<=-3)return {k:'dn',n:'🌧 走弱',why:'近5日回落'};
    if(chg!=null)return {k:'neu',n:'➖ 中性股',why:'近5日波动不大'};
    return {k:'na',n:'缺档',why:'价数据不足'};
  }
  const STK_COL={hot:'var(--up)',up:'var(--up)',dn:'var(--down)',ice:'var(--down)',neu:'var(--txt)',na:'var(--dim)'};
  // 个股仓位依据：市场状态 + 近3日方向 → 叠加该股状态/资金/走势信号
  function stockBasis(MS,dirTxt,lastNet,t5,stk){
    const mkt='<b style="color:var(--gold)">'+MS.name+'</b>（近3日'+dirTxt+'）';
    const me=stk&&stk.k!=='na'?stk.n+'、':'';
    const money=lastNet==null?'存档期未上榜':(lastNet>=0?'最近上榜<span class="up">净买 '+(lastNet>=0?'+':'')+fmtW(lastNet)+'</span>':'最近上榜<span class="down">净卖 '+fmtW(lastNet)+'</span>');
    const trd=t5==null?'':('，近5日'+(t5>=0?'<span class="up">+'+t5.toFixed(1)+'%</span>':'<span class="down">'+t5.toFixed(1)+'%</span>'));
    const bear=MS.st==='ice'||MS.st==='ret';
    const coolWord=MS.st==='ice'?'冰点期':'退潮期';
    let advice;
    if(bear){
      if(lastNet!=null&&lastNet<0)advice=mkt+'，该股'+me+money+' → '+coolWord+'资金在撤，反弹减仓、不补';
      else if(lastNet!=null&&lastNet>0)advice=mkt+'，但该股'+me+money+' → 逆势有资金，轻仓跟踪、快进快出';
      else advice=mkt+'，该股'+me+money+' → '+coolWord+'先看不动，等情绪回升再上仓位';
    }else if(MS.st==='hot'){
      if(t5!=null&&t5>=10)advice=mkt+'，该股'+me+money+trd+'已大涨 → 谨防高位分歧，只守龙头不追高';
      else if(lastNet!=null&&lastNet>0)advice=mkt+'，该股'+me+money+' → 资金+情绪共振可持有，跌破5日线减';
      else advice=mkt+'，该股'+me+money+' → 无资金认证观望为主，等上榜/放量再加';
    }else{ // 回升 / 中性
      if(lastNet!=null&&lastNet>0&&(t5==null||t5>0))advice=mkt+'，该股'+me+money+' → 资金与走势同向，可持有跟随';
      else if(lastNet!=null&&lastNet<0)advice=mkt+'，该股'+me+money+' → 等资金回流再介入';
      else advice=mkt+'，该股'+me+money+' → 中性市按兵不动，盯上榜信号';
    }
    return advice;
  }
  function renderCardExtra(code,tl){
    const MS=getMktState(),E=CUR.emotion||{},S=CUR.summary||{};
    const d3=MS.d3||0;
    const dirTxt=d3>0.5?'上行':(d3<-0.5?'下行':'走平');
    const dirCls=d3>0.5?'up':(d3<-0.5?'down':'');
    // ① 状态位置: 五状态标签一行, 当前态高亮并带实际情绪分值, 其余带分数区间
    const seq=[['ice','❄ 冰点','&lt;30'],['rec','📈 回升','30~65↑'],['neu','➖ 中性','45~55'],['hot','🔥 偏热','&gt;65'],['ret','🌧 退潮','拐点↓']];
    const tags=seq.map(([k,lab,rng])=>{
      const on=k===MS.st;
      return '<span style="display:inline-flex;align-items:center;gap:3px;padding:2px 8px;border-radius:14px;border:1.5px solid '+(on?'#e8b04b':'var(--line)')+';color:'+(on?'var(--gold)':'var(--faint)')+';font-size:10.5px;font-weight:'+(on?'700':'400')+';background:'+(on?'rgba(232,176,75,.08)':'transparent')+'">'+lab
        +(on?' <b class="num" style="font-size:11px">'+(E.value!=null?E.value:'—')+'分</b>':' <span class="num" style="font-size:9.5px">'+rng+'</span>')+'</span>';
    }).join('<span style="color:var(--faint);margin:0 1px">·</span>');
    // ② 指标行: 炸板率(市场) + 该股最近净买 + 该股近5日趋势折线
    const zbl=S.zbl_pct;
    const lastLhb=tl.length?tl[tl.length-1]:null;
    const t5=trend5(code);
    const stk=stockState(code,t5,lastLhb);
    const cell=(v,k,c)=>'<div style="flex:1;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:6px 4px;text-align:center"><div class="num" style="font-size:13.5px;font-weight:700;color:'+(c||'var(--txt)')+'">'+v+'</div><div style="font-size:10px;color:var(--dim)">'+k+'</div></div>';
    const cells='<div style="display:flex;gap:6px;margin:7px 0">'
      +cell((zbl!=null?zbl+'%':'—'),'炸板率'+((Number(zbl)||0)>30?' ⚠':''),(Number(zbl)||0)>30?'var(--gold)':null)
      +cell(lastLhb?((lastLhb.net>=0?'+':'')+fmtW(lastLhb.net)):'—',lastLhb?'净买 '+lastLhb.date.slice(5):'净买(未上榜)',lastLhb?(lastLhb.net>=0?'var(--up)':'var(--down)'):null)
      +'<div style="flex:1.4;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:4px 6px;text-align:center"><div>'+(t5?spark(t5.vals):'<span class="dim" style="font-size:11px">—</span>')+'</div><div style="font-size:10px;color:var(--dim)">'+(t5?'近5日 <span class="'+(t5.chg>=0?'up':'down')+'">'+(t5.chg>=0?'+':'')+t5.chg.toFixed(1)+'%</span>':'价走势缺档')+'</div></div>'
      +'</div>';
    // ③ 仓位依据（含个股状态）
    const basis=stockBasis(MS,dirTxt,lastLhb?lastLhb.net:null,t5?t5.chg:null,stk);
    const warns=MS.warns&&MS.warns.length?'<div style="margin-top:4px;color:var(--gold);font-size:10.5px">⚠ '+MS.warns.map(stripTags).join('；')+'</div>':'';
    // 个股状态标签（v4.9.16: 与市场五状态分开显示）
    const stkTag='<span style="display:inline-flex;align-items:center;gap:5px;padding:2px 10px;border-radius:14px;border:1.5px solid '+STK_COL[stk.k]+';color:'+STK_COL[stk.k]+';font-size:11px;font-weight:700">'+stk.n+'</span>'
      +'<span style="font-size:10px;color:var(--dim)">'+stk.why+(t5?' · 近5日 '+(t5.chg>=0?'+':'')+t5.chg.toFixed(1)+'%':'')+'</span>';
    return '<div style="margin-top:8px;border-top:1px dashed var(--line);padding-top:7px">'
      +'<div style="font-size:10px;color:var(--dim);margin-bottom:4px">📍 市场位置（当前大盘整体所处状态）· '+CUR.trade_date+'</div>'
      +'<div style="display:flex;flex-wrap:wrap;gap:3px;align-items:center">'+tags+'</div>'
      +'<div style="font-size:10px;color:var(--dim);margin:6px 0 3px">🏷 该股状态（按这只股自己的近 5 日动量/触板判定）</div>'
      +'<div style="display:flex;flex-wrap:wrap;gap:5px;align-items:center">'+stkTag+'</div>'
      +cells
      +'<div style="font-size:11px;line-height:1.65;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:6px 9px"><b style="color:var(--gold);font-size:10.5px">📋 仓位依据</b>　'+basis+'</div>'
      +warns
      +'</div>';
  }

  function render() {
    const host = $id('s5-cards');
    $id('s5-empty').textContent = WL.length ? '' : '名单为空。添加方式: 输入代码/名称（支持联想），或在龙虎榜表格点行看详情后记下代码。哨兵监控内容: 上榜动静 / 连板节奏 / 资金累计 / 区间强弱。';
    host.innerHTML = WL.map(w => {
      const code = w.code, name = resolveName(code);
      const tl = timeline(code), p = pxInfo(code), h = lastHot(code);
      const totalNet = tl.reduce((a, r) => a + r.net, 0);
      const lastLhb = tl[tl.length - 1];
      const al = alerts(code).map(([t, k]) => `<span class="alert-tag tag ${k === 'hot' ? 'hot' : ''}" style="${k === 'up' ? 'color:#ff8a8a;border-color:rgba(255,90,90,.4)' : k === 'dn' ? 'color:#5fd8b4;border-color:rgba(47,191,143,.4)' : ''}">${t}</span>`).join(' ');
      return `<div class="wl-card">
        <span class="x" data-del="${code}" title="移除哨兵">✕</span>
        <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap">
          <b style="font-size:14.5px">${name}</b><span class="code num">${code}</span>
          ${p ? `<span class="num" style="font-weight:700">¥${p.px.toFixed(2)}</span><span class="num ${cls(p.range)}" style="font-size:12px">${p.range > 0 ? '+' : ''}${p.range.toFixed(1)}%<span class="dim">（${p.n}日）</span></span>` : ''}
        </div>
        <div style="margin-top:5px;font-size:12.5px" class="num">
          上榜 <b>${tl.length}</b> 次 · 累计净买 <span class="${cls(totalNet)}" style="font-weight:700">${tl.length ? (totalNet >= 0 ? '+' : '') + fmtW(totalNet) : '—'}</span>
          ${lastLhb ? ` · 最近 <b>${lastLhb.date.slice(5)}</b> 当次 <span class="${cls(lastLhb.net)}">${lastLhb.net >= 0 ? '+' : ''}${fmtW(lastLhb.net)}</span>` : ''}
        </div>
        ${h ? `<div style="margin-top:4px;font-size:12px">题材 <span class="dim">${h.date.slice(5)}:</span> ${(h.reason || '—').split('+').slice(0, 4).map(t => `<span class="tag">${t.trim()}</span>`).join('')}</div>` : ''}
        <div style="margin-top:6px">${al}</div>
        ${renderCardExtra(code, tl)}
      </div>`;
    }).join('');
    host.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
      WL = WL.filter(w => w.code !== b.dataset.del);
      save(); render(); LAB.toast('哨兵已撤岗');
    });
  }
  render();
})();
