// 全局配置加载器——数据唯一事实源：仓库根 config.json（schemaVersion 2 起，参数唯一住所
// = config.json 的 params.live / params.train；顶层另有 live 的双写镜像，供前端直读扁平层）。
//
// ── 演进史（两个约束的合流，2026-10-02）─────────────────────────────────────
//   · #142 抽 JSON：同一批数值曾散落多处（本文件对象字面量、前端手抄兜底、审计脚本正则），
//     任何一处单独改动都会造成「报告说 A、算的是 B」。JSON 化后 Node / 前端 / 守卫脚本
//     全部只读 config.json 一份文本。
//   · 过拟合防线：params.live 生产口径**递归冻结**，改动唯一通道 =
//     scripts/promote_params.mjs（样本外 20% 门禁 + params_changelog.json 留痕
//     who/when/why/验证结果）；params.train 为实验区，寻优锚点（scripts/backtest.mjs）
//     已切至 train。手改 params.live 不留痕 → test/params_governance.test.mjs 红。
//   · 双写镜像：JSON 顶层 weights / lookback / backtest.{thresholds,costs,rolling,maxPos,
//     stopLoss,ddTrigger,maxPosChg} / momentumRecent / momentumPrev 是 live 的**同一份值**
//     的扁平表述——前端（index.html 内联 module 桥挂 window.ASENT_CONFIG、check_frontend
//     平铺 JSON 后交 alerts 消费）读扁平层，Node 侧读 params.live，两边逐位相等
//     （守卫：test/params_governance.test.mjs 的镜像断言）。
//   · 兼容层：config.weights / config.backtest.* 等旧路径是 live 的**同一引用**（非拷贝），
//     守卫测试断言 === —— 不存在第二份口径。
//
// manualHolidays 已降级为兜底，不再是主口径——交易日判定由 src/calendar.js +
// data/calendar.json 承担（上证指数日K反推）；本数组只在日历文件缺失/覆盖范围之外时参与
// 兜底。漏登记会把休市日误判为交易日 → 反复回退/误报滞后，须随新公告更新 config.json
//（来源与完整说明见该文件 _about/_paramsNote）。
//
// 校验原则：配置错误必须**快速失败**（启动即 throw），绝不带病运行——权重和≠1、阈值乱序、
// 缺必需键、params 双套结构残缺都在这里拦截，而不是等到算出错误分数后由下游守卫兜出来。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(__dirname, '..', 'config.json'), 'utf8'));

// ── 结构校验（错误宁可启动炸，不许带病算分）─────────────────────────────────
if (!(cfg.formulaVersion && typeof cfg.formulaVersion === 'string')) {
  throw new Error('[config] formulaVersion 缺失或非字符串');
}
if (!cfg.params || !cfg.params.live || !cfg.params.train) {
  throw new Error('[config] params.live / params.train 缺失（参数唯一住所，不得省略）');
}
const BLOCKS = ['weights', 'thresholds', 'stops', 'lookback', 'costModel'];
for (const side of ['live', 'train']) {
  for (const b of BLOCKS) {
    if (!cfg.params[side][b] || typeof cfg.params[side][b] !== 'object') {
      throw new Error(`[config] params.${side}.${b} 缺失`);
    }
  }
  // 键集合一致（实验区只许改值不许改结构；结构漂移会让晋升快照失真）
  for (const b of BLOCKS) {
    const kl = Object.keys(cfg.params.live[b]).sort();
    const kt = Object.keys(cfg.params.train[b]).sort();
    if (JSON.stringify(kl) !== JSON.stringify(kt)) {
      throw new Error(`[config] params.${b} 键集合 live 与 train 不一致: ${kl} vs ${kt}`);
    }
  }
  const wsum = Object.values(cfg.params[side].weights).reduce((a, b) => a + (+b || 0), 0);
  if (Math.abs(wsum - 1) > 1e-9) {
    throw new Error(`[config] params.${side}.weights 权重和必须为 1, 实际 ${wsum}`);
  }
  const th = ['panic', 'hi', 'lo', 'overheat'].map((k) => +cfg.params[side].thresholds[k]);
  if (th.some((v) => !Number.isFinite(v)) || !(th[0] < th[1] && th[1] < th[2] && th[2] < th[3])) {
    throw new Error(`[config] params.${side}.thresholds 必须为升序四档 panic < hi < lo < overheat`);
  }
}
if (typeof cfg.params.live.costModel.priceLimit?.enabled !== 'boolean') {
  throw new Error('[config] params.live.costModel.priceLimit.enabled 必须为布尔（涨跌停约束占位）');
}
if (!Array.isArray(cfg.manualHolidays) || cfg.manualHolidays.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d))) {
  throw new Error('[config] manualHolidays 必须为 YYYY-MM-DD 数组');
}
// 主线识别动态阈值（2026-10-07）：块缺失不炸（引擎有 fixedFallback 语义兜底），
// 但**给了就必须给对**——数字类型与下界不符直接启动失败，绝不带病运行。
if (cfg.mainLine != null) {
  if (typeof cfg.mainLine !== 'object' || Array.isArray(cfg.mainLine)) {
    throw new Error('[config] mainLine 必须为对象');
  }
  const ML_NUMS = [
    ['lookback_days', 1], ['sigma_multiplier', 0], ['min_sample_days', 1],
  ];
  for (const [k, min] of ML_NUMS) {
    const v = cfg.mainLine[k];
    if (!Number.isFinite(+v) || +v < min) {
      throw new Error(`[config] mainLine.${k} 必须为 ≥${min} 的有限数，实际 ${v}`);
    }
  }
  if (+cfg.mainLine.min_sample_days > +cfg.mainLine.lookback_days) {
    throw new Error('[config] mainLine.min_sample_days 不得大于 lookback_days（降级线永远不可达）');
  }
  const fb = cfg.mainLine.fixedFallback;
  if (fb == null || typeof fb !== 'object'
    || !Number.isFinite(+fb.up_count_threshold) || +fb.up_count_threshold < 0
    || !Number.isFinite(+fb.density_threshold) || +fb.density_threshold < 0 || +fb.density_threshold > 1) {
    throw new Error('[config] mainLine.fixedFallback 必须含 up_count_threshold≥0 与 density_threshold∈[0,1]');
  }
  // 总阀门（第二步，同日）：缺键不炸（引擎有默认语义），但给了就必须给对。
  if (cfg.mainLine.market_weak_volume_ratio != null
    && (!Number.isFinite(+cfg.mainLine.market_weak_volume_ratio) || +cfg.mainLine.market_weak_volume_ratio <= 0)) {
    throw new Error('[config] mainLine.market_weak_volume_ratio 必须为 >0 的有限数');
  }
  if (cfg.mainLine.market_weak_index_below_ma != null && typeof cfg.mainLine.market_weak_index_below_ma !== 'boolean') {
    throw new Error('[config] mainLine.market_weak_index_below_ma 必须为布尔');
  }
  const ML_GATE = ['sentiment_old_dragon_drop', 'sentiment_rise_pct', 'weak_mode_threshold_boost', 'dragon_retreat_density_boost'];
  for (const k of ML_GATE) {
    if (cfg.mainLine[k] != null && !Number.isFinite(+cfg.mainLine[k])) {
      throw new Error(`[config] mainLine.${k} 必须为有限数`);
    }
  }
  if (cfg.mainLine.weak_mode_max_output != null
    && (!Number.isInteger(+cfg.mainLine.weak_mode_max_output) || +cfg.mainLine.weak_mode_max_output < 1)) {
    throw new Error('[config] mainLine.weak_mode_max_output 必须为 ≥1 的整数');
  }
  // 仓位管理（第三步，同日）：ATR 波动分档与建议权重。缺键不炸（引擎有默认 15/10/5），
  // 给了就必须给对。分档区间 low ≤ high 是数学硬约束（否则 mid 区间为空）；
  // 权重递减（低波动 ≥ 中 ≥ 高）是风控惯例但非数学错误，不加校验、由配置者自担。
  if (cfg.mainLine.atr_period != null
    && (!Number.isInteger(+cfg.mainLine.atr_period) || +cfg.mainLine.atr_period < 1)) {
    throw new Error('[config] mainLine.atr_period 必须为 ≥1 的整数');
  }
  if (cfg.mainLine.atr_low_threshold != null && !Number.isFinite(+cfg.mainLine.atr_low_threshold)) {
    throw new Error('[config] mainLine.atr_low_threshold 必须为有限数');
  }
  if (cfg.mainLine.atr_high_threshold != null && !Number.isFinite(+cfg.mainLine.atr_high_threshold)) {
    throw new Error('[config] mainLine.atr_high_threshold 必须为有限数');
  }
  if (cfg.mainLine.atr_low_threshold != null && cfg.mainLine.atr_high_threshold != null
    && +cfg.mainLine.atr_low_threshold > +cfg.mainLine.atr_high_threshold) {
    throw new Error('[config] mainLine.atr_low_threshold 不得大于 atr_high_threshold（mid 区间为空）');
  }
  for (const k of ['weight_low_vol', 'weight_mid_vol', 'weight_high_vol']) {
    if (cfg.mainLine[k] != null && (!Number.isFinite(+cfg.mainLine[k]) || +cfg.mainLine[k] < 0)) {
      throw new Error(`[config] mainLine.${k} 必须为 ≥0 的有限数`);
    }
  }
}

// ── 冻结与组装 ──────────────────────────────────────────────────────────────
const __freeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object') __freeze(v);
  return Object.freeze(o);
};
const LIVE = __freeze(cfg.params.live); // 生产口径（递归冻结：改它只能走 promote 门禁）
const TRAIN = cfg.params.train;         // 实验区（可改；晋升须过样本外 20% 门禁）

// 导出：JSON 全量 + 冻结双套 + 兼容层覆盖为 live 同一引用。
// 注意：兼容层与 JSON 顶层扁平层逐位同值（镜像不漂移由 test/params_governance.test.mjs
// 锁定），故薄壳不会成为第二份口径——「导出 === config.json」在值层面依然成立。
const out = { ...cfg };
out.params = { live: LIVE, train: TRAIN, governance: cfg.params.governance };
out.weights = LIVE.weights;
out.lookback = LIVE.lookback;
out.backtest = {
  ...cfg.backtest,
  thresholds: LIVE.thresholds,
  costs: LIVE.costModel,
  rolling: LIVE.lookback.rolling,
  maxPos: LIVE.stops.maxPos, stopLoss: LIVE.stops.stopLoss,
  ddTrigger: LIVE.stops.ddTrigger, maxPosChg: LIVE.stops.maxPosChg,
};
out.momentumRecent = LIVE.lookback.momentumRecent;
out.momentumPrev = LIVE.lookback.momentumPrev;
// 主线识别动态阈值（可缺省：引擎缺配置时按 fixedFallback 语义处理，见 src/backtest.js）
out.mainLine = cfg.mainLine || {
  lookback_days: 60, sigma_multiplier: 1.0, min_sample_days: 20,
  fixedFallback: { up_count_threshold: 6, density_threshold: 0.1 },
};

export default out;
