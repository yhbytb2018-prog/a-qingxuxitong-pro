/* ═══════════ S10 · 数据互通（PC ↔ 手机 · 同步串，纯本地不经过服务器） ═══════════ */
(() => {
  const PREFIX = 'ASNT1.';
  const MAX_LEN = 2 * 1024 * 1024; // 导入串 2MB 上限（防呆）
  const QR_MAX = 2900;             // QR L 级 type40 容量 ~2953 字节，留余量
  const LABELS = { weights: 'S1 权重口径', forecasts: 'S2 预测', watchlist: 'S5 哨兵自选', notes: 'S7 复盘笔记' };
  const $ = id => document.getElementById(id);
  const box = $('s10-qrbox'), hint = $('s10-hint'), ta = $('s10-text');
  if (!ta) return; // 模块挂载点缺失时静默退出

  // ── unicode 安全 base64（escape/unescape 全端可用，含微信 XWeb）──
  const b64e = s => btoa(unescape(encodeURIComponent(s)));
  const b64d = s => decodeURIComponent(escape(atob(s)));

  // ── 本机数据快照 ──
  const snap = () => {
    const out = {};
    for (const k of Object.keys(LABELS)) {
      const v = LAB.get(k, null);
      if (v != null && (Array.isArray(v) ? v.length : Object.keys(v).length)) out[k] = v;
    }
    return out;
  };
  const countStr = data => Object.keys(data).map(k => {
    const v = data[k];
    const n = k === 'weights' ? '已存' : Array.isArray(v) ? v.length + (k === 'forecasts' ? ' 条' : ' 只') : Object.keys(v).length + ' 天';
    return LABELS[k] + ' ' + n;
  }).join(' · ') || '（本机暂无个人数据）';

  // ── 复制（clipboard API 优先，execCommand 兜底——微信 XWeb / http 场景）──
  const legacyCopy = s => {
    const t = document.createElement('textarea');
    t.value = s; t.style.cssText = 'position:fixed;opacity:0;left:-999px';
    document.body.appendChild(t); t.focus(); t.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(t); return ok;
  };
  const copyText = s => {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(s).then(() => true).catch(() => legacyCopy(s));
    }
    return Promise.resolve(legacyCopy(s));
  };

  // ── QR 渲染（qrcode-generator，typeNumber 0 自动选版）──
  const qrEl = (text, caption) => {
    box.innerHTML = '';
    try {
      const qr = qrcode(0, 'L'); qr.addData(text, 'Byte'); qr.make();
      const img = document.createElement('img');
      img.src = qr.createDataURL(4, 8); img.alt = caption; img.style.cssText = 'width:220px;height:220px;image-rendering:pixelated';
      box.appendChild(img);
      const cap = document.createElement('div');
      cap.style.cssText = 'color:#333;font-size:12px;margin-top:6px;font-weight:600';
      cap.textContent = caption; box.appendChild(cap);
      box.style.display = 'block';
      return true;
    } catch (e) { box.style.display = 'none'; return false; }
  };

  // ── 生成同步串 ──
  $('s10-exp').onclick = () => {
    const data = snap();
    if (!Object.keys(data).length) { LAB.toast('本机暂无可打包的个人数据'); return; }
    const payload = { v: 1, at: new Date().toISOString(), data };
    const str = PREFIX + b64e(JSON.stringify(payload));
    ta.value = str;
    hint.textContent = '已打包 ' + countStr(data) + ' · ' + (str.length / 1024).toFixed(1) + 'KB';
    box.style.display = 'none';
    $('s10-qr').style.display = str.length <= QR_MAX ? '' : 'none';
    LAB.toast('同步串已生成 · 复制后在另一台设备导入');
  };

  // ── 复制 ──
  $('s10-copy').onclick = () => {
    const s = ta.value.trim();
    if (!s) { LAB.toast('请先生成同步串'); return; }
    copyText(s).then(ok => LAB.toast(ok ? '已复制到剪贴板 · 去另一台设备粘贴导入' : '复制失败 · 请手动全选复制'));
  };

  // ── 导入（只写 localStorage + 刷新生效，字符串永不进 innerHTML）──
  $('s10-imp').onclick = () => {
    let s = ta.value.trim().replace(/\s+/g, '');
    if (!s) { LAB.toast('请先粘贴同步串'); return; }
    if (s.length > MAX_LEN) { LAB.toast('同步串超出大小限制'); return; }
    if (!s.startsWith(PREFIX)) { LAB.toast('格式不对：同步串应以 ' + PREFIX + ' 开头'); return; }
    let obj;
    try { obj = JSON.parse(b64d(s.slice(PREFIX.length))); } catch (e) { LAB.toast('解析失败：内容不完整或被截断'); return; }
    if (!obj || obj.v !== 1 || !obj.data || typeof obj.data !== 'object') { LAB.toast(obj && obj.v ? '版本不兼容：串版本 ' + obj.v + '，本页支持 1' : '解析失败：不是有效的同步串'); return; }
    const d = obj.data, done = [], same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    // v4.6 导入容错：权重串兼容 4 维旧版 / 7 维 v4.3 口径，逐项数字校验 + 全零拦截
    if (Array.isArray(d.weights) && (d.weights.length === 4 || d.weights.length === 7)
      && d.weights.every(x => typeof x === 'number' && isFinite(x) && x >= 0) && d.weights.reduce((a, b) => a + b, 0) > 0
      && !same(LAB.get('weights', null), d.weights)) { LAB.set('weights', d.weights); done.push(LABELS.weights); }
    if (Array.isArray(d.forecasts) && d.forecasts.length) {
      const cur = LAB.get('forecasts', []), ids = new Set(cur.map(f => f.id));
      const add = d.forecasts.filter(f => f && f.id != null && !ids.has(f.id));
      if (add.length) { LAB.set('forecasts', cur.concat(add)); done.push(LABELS.forecasts + ' +' + add.length); }
    }
    if (Array.isArray(d.watchlist) && d.watchlist.length) {
      const cur = LAB.get('watchlist', []), cs = new Set(cur.map(w => w.code));
      const add = d.watchlist.filter(w => w && w.code && !cs.has(w.code));
      if (add.length) { LAB.set('watchlist', cur.concat(add)); done.push(LABELS.watchlist + ' +' + add.length); }
    }
    if (d.notes && typeof d.notes === 'object' && !Array.isArray(d.notes)) {
      const cur = LAB.get('notes', {}); let n = 0;
      Object.keys(d.notes).forEach(k => {
        const inc = d.notes[k];
        if (inc && inc.text != null && !same(cur[k], inc)) { cur[k] = inc; n++; }
      });
      if (n) { LAB.set('notes', cur); done.push(LABELS.notes + ' +' + n); }
    }
    if (!done.length) { LAB.toast('没有需要导入的新数据（可能已存在）'); return; }
    LAB.toast('已导入 ' + done.join(' · ') + ' · 即将刷新生效…');
    setTimeout(() => location.reload(), 1400);
  };

  // ── 二维码 ──
  $('s10-qr').onclick = () => {
    const s = ta.value.trim();
    if (!s.startsWith(PREFIX)) { LAB.toast('请先生成同步串'); return; }
    if (!qrEl(s, '手机微信扫码 → 识别文本 → 复制到导入框')) LAB.toast('内容过长无法生成二维码，请直接复制');
  };
  const urlBtn = $('s10-urlqr');
  if (/^https?:$/.test(location.protocol)) { // file:// 下手机打不开，隐藏
    urlBtn.style.display = '';
    urlBtn.onclick = () => {
      if (!qrEl(location.href, '手机相机/浏览器扫码直达 · 微信内打开请点右上角「···」选浏览器')) LAB.toast('二维码生成失败');
    };
  }

  // ── 初始提示：本机现有数据 ──
  hint.textContent = '本机现有：' + countStr(snap());
})();
