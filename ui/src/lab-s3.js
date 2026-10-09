/* ═══════════ S3 每日复盘简报（build.js 生成 D.briefs，本模块渲染）═══════════ */
(function () {
  const briefs = D.briefs || {};
  const dates = Object.keys(briefs).sort();
  if (!dates.length) { const b = $id('s3-box'); if (b) b.innerHTML = '<div class="sec-desc">简报尚未生成（需运行 build 管道）。</div>'; return; }
  const sel = $id('s3-day');
  dates.slice().reverse().forEach(dt => { const o = document.createElement('option'); o.value = dt; o.textContent = dt; sel.appendChild(o); });

  function render() {
    const dt = sel.value;
    $id('s3-box').innerHTML = `<pre style="white-space:pre-wrap;font-family:inherit;font-size:13px;line-height:1.9;color:#d7dee9;margin:0">${briefs[dt].replace(/</g, '&lt;')}</pre>`;
  }
  sel.onchange = render;
  render();

  $id('s3-copy').onclick = async () => {
    const txt = briefs[sel.value];
    if (!txt) { LAB.toast('该期无简报内容'); return; }
    try {
      await navigator.clipboard.writeText(txt);
      LAB.toast('简报已复制到剪贴板');
    } catch (e) {
      // file:// 下 clipboard API 可能受限，降级 execCommand
      const ta = document.createElement('textarea');
      ta.value = txt; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); LAB.toast('简报已复制'); } catch (e2) { LAB.toast('复制失败，请手动选择文本'); }
      ta.remove();
    }
  };
  $id('s3-dl').onclick = () => {
    const all = dates.map(dt => briefs[dt]).join('\n\n---\n\n');
    const blob = new Blob([all], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'daily-briefs-' + LAB.ymd(new Date()) + '.md';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    LAB.toast('已下载全部 ' + dates.length + ' 期简报');
  };
})();
