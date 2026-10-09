// 数据健康校验：archive.json 结构/类型/范围检查
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validateArchive(arc) {
  const errors = [];
  if (!arc || typeof arc !== 'object') return { ok: false, errors: ['archive 不是对象'] };
  if (!arc.meta || typeof arc.meta !== 'object') errors.push('缺少 meta');
  if (!Array.isArray(arc.all_days)) {
    errors.push('all_days 非数组');
  } else {
    if (arc.all_days.length === 0) errors.push('all_days 为空');
    arc.all_days.forEach((d, i) => {
      if (!d.trade_date || !DATE_RE.test(d.trade_date)) errors.push(`all_days[${i}] trade_date 非法`);
      if (typeof d.emotion !== 'object' || (typeof d.emotion.score !== 'number' && typeof d.emotion.value !== 'number')) {
        errors.push(`all_days[${i}] 缺 emotion.score/value`);
      } else {
        const sc = d.emotion.score ?? d.emotion.value;
        if (sc < 0 || sc > 100) errors.push(`all_days[${i}] emotion 越界 ${sc}`);
      }
      if (!Array.isArray(d.hot)) errors.push(`all_days[${i}] hot 非数组`);
    });
  }
  if (!arc.signals || typeof arc.signals !== 'object') errors.push('缺少 signals');
  return { ok: errors.length === 0, errors };
}
