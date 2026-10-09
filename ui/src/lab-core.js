/* ═══════════ 实验室公共 ═══════════ */
const LAB = (() => {
  const NSP = 'asent.v3.';
  const get = (k, def) => {
    try {
      const v = localStorage.getItem(NSP + k);
      if (v == null) return def;
      const p = JSON.parse(v);
      return p == null ? def : p; // 防坏值 "null"/"undefined" 导致调用方 FCS=null 崩溃
    } catch (e) { return def; }
  };
  const set = (k, v) => { try { localStorage.setItem(NSP + k, JSON.stringify(v)); } catch (e) {} };
  let toastT = null;
  const toast = msg => {
    let t = $id('lab-toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; t.id = 'lab-toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('on');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 1800);
  };
  const idxOf = {};
  DAYS.forEach((d, i) => idxOf[d.trade_date] = i);
  // 存档内第 n 个交易日后的日期（超出返回 null）
  const nextTrade = (date, n) => { const i = idxOf[date]; return i == null ? null : (DAYS[i + n] ? DAYS[i + n].trade_date : null); };
  const fmtDT = ts => { try { return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } };
  const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const pearson = (a, b) => {
    const n = a.length; if (!n) return 0;
    const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
    let nu = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) { nu += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return (da && db) ? +(nu / Math.sqrt(da * db)).toFixed(3) : 0;
  };
  return { get, set, toast, idxOf, nextTrade, fmtDT, ymd, pearson };
})();
