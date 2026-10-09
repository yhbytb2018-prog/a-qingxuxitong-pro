// 版本回归的统计工具 —— 从 scripts/version_regression.mjs 抽出为独立模块。
//
// 为什么必须抽出来：脚本是「有副作用的入口」（读档案、写 JSON），测试直接 import 它会
// 连带执行整个流程。统计逻辑本身是纯函数，抽到这里后可被单测独立验证
// （pearson 对常数序列返回 null 而不是 NaN 这类边界，只有单测能覆盖到）。
//
// 口径纪律：scripts/version_regression.mjs 与 test/formula_version.test.mjs 必须
// **共用这一份实现**，不得各写一份——否则统计口径会漂移，回归报告与守卫说的不是一回事。

export function mean(a) {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
}

export function stdev(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

// Pearson 相关（线性）。常数序列的方差为 0，相关性无定义 → 返回 null（而不是 NaN，
// 否则 NaN 会静默污染下游的均值/排序与报告文案）。
export function pearson(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 3) return null;
  const mx = mean(x), my = mean(y);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = x[i] - mx, b = y[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

// 秩变换（平均秩，处理并列）—— Spearman 用
export function ranks(a) {
  const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
  const r = new Array(a.length).fill(0);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

// Spearman 秩相关：对异常值稳健。情绪分与次日涨跌的关系未必线性
// （tanh 归一本身就压平了两端），故秩相关比线性相关更贴切，两个都报。
export function spearman(x, y) {
  if (x.length < 3 || y.length < 3) return null;
  return pearson(ranks(x), ranks(y));
}

// 方向准确率：情绪分 ≥ 中位数 视为「看多」，次日涨为对；反之视为「看空」，次日跌为对。
//
// 为什么用中位数分档而不是固定阈值（如 V5.2 的 65/24）：
//   33 天样本里若用绝对阈值，会出现"全部落在同一档"——准确率退化成"当日涨跌占比"，
//   没有任何信息量。中位数保证样本被对半分，准确率才有判别力。
//   代价是它衡量的是"排序能力"而非"档位命中率"，故报告里必须写清这一点。
export function directionAccuracy(scores, rets) {
  const n = Math.min(scores.length, rets.length);
  if (n < 3) return null;
  const sorted = [...scores.slice(0, n)].sort((a, b) => a - b);
  const med = sorted.length % 2 ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  let hit = 0, tot = 0;
  for (let i = 0; i < n; i++) {
    if (scores[i] === med) continue; // 与中位数并列的天无法判方向，排除
    const bullish = scores[i] > med;
    const up = rets[i] > 0;
    if (bullish === up) hit++;
    tot++;
  }
  return tot ? { acc: hit / tot, hit, total: tot, median: med } : null;
}

// 两版分数的平移量：衡量新版是否只是整体平移（而不是改变排序）。
//   meanDiff     —— 平均偏移（正 = 新版更高）
//   maxAbsDiff   —— 单日最大绝对偏移
//   changedDays  —— 偏移超过 0.05 分的天数（四舍五入精度内视为未变）
export function scoreShift(a, b) {
  const n = Math.min(a.length, b.length);
  const diffs = [];
  for (let i = 0; i < n; i++) diffs.push(a[i] - b[i]);
  if (!diffs.length) return { meanDiff: null, maxAbsDiff: null, changedDays: 0 };
  return {
    meanDiff: mean(diffs),
    maxAbsDiff: Math.max(...diffs.map(Math.abs)),
    changedDays: diffs.filter((d) => Math.abs(d) > 0.05).length,
  };
}
