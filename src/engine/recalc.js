// 引擎：全档情绪重算（从 src/pipeline.js 拆出，2026-10-05 批次3 4.1）。
//
// 拆分纪律：函数体**逐字搬移**、零语义改动——recalcAll 的 scope 幂等语义由
// test/pipeline_scope.test.mjs 用真档案深比较锁死，搬移本身不得引入任何行为差异。
// src/pipeline.js 对本模块 re-export，16 个既有调用方（9 scripts + 7 tests）
// import 路径零改动；新代码请直接 import './engine/recalc.js'。
import config from '../config.js';
import { computeSentiment } from '../sentiment.js';
import { caliberFromDay } from '../lhb.js';
import { recalcRanks } from '../sources.js';
import { computeRelative } from '../relative.js';
import { validateDay, sanitizeForFactors } from '../dirty.js';
import { BACKFILL_FLAG } from '../backfill.js';
// 行业离群「销案」台账（data/industry_outlier_review.json）**不进本引擎**：
//   ⚠ 判脏/因子入参必须只依赖客观数据（见下方「判脏不得注入销案台账」注）。台账是
//   告警复核记录，其写入方与去重消费方是 scripts/verify_industry_outliers.mjs；
//   销案的落点是 day.review（scripts/review_alerts.mjs → signals dirty.recent[].reviewVerdict）。
//   本模块的任何一处都不得再 import confirmedSet/validateLedger —— 一旦让台账参与
//   档案判定，"存档可重现" 就依赖一份可变的人工台账，且销案会从可审计退化为静默消失。
//   （自 origin/main 合入：原文在 src/pipeline.js，判脏体搬至本模块后注释随行。）

// ── 供 recalcAll 使用的小工具（模块级，不在 forEach 里重复创建）────────────
const r1s = (v) => (v == null || !Number.isFinite(+v) ? null : Math.round(v * 10) / 10);

/** 与 src/dirty.js 的 num() 同款加固：拒 null/''/布尔/数组/对象（+[]===0 陷阱）。
 *  用于读取**存档里已有的值**做一致性比对——若不过这道闸，空数组会被当成 0，
 *  从而把"字段缺失"误判成"值不一致"，凭空造出一条待复核记录。 */
const numOf = (v) => {
  if (v == null || v === '') return null;
  const t = typeof v;
  if (t !== 'number' && t !== 'string') return null;
  const n = +v;
  return Number.isFinite(n) ? n : null;
};

/**
 * 这一天是不是「只有回填数据」的形态？
 *
 * 判据与 src/backfill.js::buildBackfillDay 写下的形态一一对应：
 *   · buildBackfillDay 不采集行业（ind_count: 0）与涨跌家数（无 up_count），
 *     故回填天的特征就是"没有行业明细、也没有涨跌家数"。
 *   · 用 `ind_count` 判 0/缺失而不是"数组为空"：档里 industry 是裁剪形态，
 *     历史天可能连字段都没有；用 count 与 hasRaw 判据同源，不另立一套。
 *
 * ⚠ 判据必须**保守**：只要这天有行业或涨跌家数，就不标回填——宁可漏标（那天被
 *   当作真情绪分参与回测，是可复核的偏差），也不能误标（真数据被前端过滤掉，
 *   用户看不到，且**没有任何提示**）。这是"缺失显式化"在相反方向的同一条纪律。
 */
function isBackfillShaped(s) {
  if (!s) return false;
  const indCount = s.ind_count;
  const hasIndustry = indCount != null && Number.isFinite(+indCount) && +indCount > 0;
  const hasBreadth = s.up_count != null && s.down_count != null;
  if (hasIndustry || hasBreadth) return false;
  // 还没抓到龙虎榜原料的天也不是"回填天"——它是"空天"，两者语义不同
  // （空天连 s_net 都没有，回填天至少有 s_net）。不把它标成回填，避免混淆。
  return s.lhb_daily_net != null || s.lhb_all_net != null;
}

// 全档情绪重算：统一公式（computeSentiment）重跑所有交易日，再重算分位。
// 历史天缺原始数据的因子走 proxy（posRatio/行业涨比），完全无原始数据的种子天标记 _legacy 保留原值。
//
// ── ★ #134b：接入幂等（`scope`）——从"每轮全档 241 天"缩到"真正会变的那几天" ──────
//
//   背景：本函数原本对每一天都完整重跑（标脏校验 + 因子 + 派生字段）。实测 241 天里
//   真正会变的只有 1~2 天（当日 + 上一交易日，见 src/idempotence.js::computeRecomputeScope）。
//   其余 239 天重算 100% 是恒等变换，但代价实打实（每次多花数十秒）。
//
//   ⚠ 为什么"跳过"是**安全**的（这条是本项成立的前提，不得想当然）：
//     本函数内的每一处跨日依赖都只**向后看**（依赖索引 < i 的日）：
//       · amountMA20：只取 `j < i` 的历史（见下方 hist 循环）；
//       · 分位：windowedPctRank 只看"到 i 为止"的窗口（src/sources.js，已由
//         test/idempotence.test.mjs 的"追加新天不改历史分位"+真档案截断实证锁死）；
//       · computeRelative：逐日独立，只读当日 summary。
//     没有任何一处依赖"未来某天"或"档案总长度"。故 i 日的结果**只取决于 [0..i]**，
//     跳过与它无关的其他天不改变它。
//
//   ⚠ 但**分位与相对强弱两段仍对全档跑**（不跳过）——它们是"薄"操作且同样是派生指标：
//     · 分位：本就逐日独立，全档跑只是 O(n·window)，实测毫秒级；
//       若只对 scope 内跑，反而要额外证明"两套调用路径结果一致"，得不偿失。
//     · computeRelative：同理，逐日独立、极轻。
//     结论：**重的是因子那段（标脏/校验/七因子/诊断字段），轻的是派生两段**。
//     scope 只跳过前者，后者照旧全跑 —— 这样"省"与"正确"同时拿到，
//     且不必为后者额外论证（它们本来就是 per-day 无状态）。
//
//   ⚠ scope 为 null/未传 → 行为与旧版**逐位一致**（全档重算）。
//     调用方若判定口径整体变更（公式版本切换/阈值重标定），必须显式传
//     `{ scope: { full: true } }`，或干脆不传 scope。
//
//   正确性由 test/pipeline_scope.test.mjs 用**真档案**证明：
//     带 scope 的重算结果与全档重算结果**逐字段深比较必须相同**（否则说明存在
//     未被识别的跨日依赖，此时必须停止缩小范围）。
export function recalcAll(days, opts = {}) {
  const scope = opts.scope || null;
  // 需要**完整重算因子段**的日期集合；scope 为空 = 全档（旧行为）。
  const scopedDates = (scope && !scope.full && Array.isArray(scope.dates))
    ? new Set(scope.dates)
    : null;
  const amts = days.map((d) => (d.summary && d.summary.amount_yi != null) ? d.summary.amount_yi : null);
  days.forEach((d, i) => {
    // scope 命中判定：只跳过**因子段**；分位/相对两段在循环外照旧全跑。
    if (scopedDates && !scopedDates.has(d.trade_date)) return;
    const s = d.summary || {};
    const hasRaw = (s.ind_count > 0 || s.lhb_daily_net != null || s.lhb_all_net != null);
    if (!hasRaw) { if (d.emotion) d.emotion._legacy = true; return; }

    // ── #3 脏数据标脏 ─────────────────────────────────────────────────────
    //   纪律：脏字段的**原始值保留在档里**（可追溯/可人工复核），只是不喂给
    //   computeSentiment —— 让因子走它既有的 missing/proxy 通道（那是一条已测试的
    //   "缺失显式化"路径），而不是被脏值污染后算出一个"看起来正常"的分数。
    //
    // ⚠ 时序纪律（本层最易踩的坑）：标脏必须发生在 caliberFromDay **之后**。
    //   caliberFromDay 会从原始记录**重写** s.lhb_daily_net / s.lhb_new_net 等字段。
    //   若在它之前校验，看到的是上一轮的旧值 → 漏标本轮新出现的脏值。
    //   故校验点统一放在"档内字段已定稿"之后（见下方 vres）。
    // 双口径统一从原始记录现算（每票一笔，取 |净额| 最大者），杜绝各自相加时把区间累计榜混进当日口径。
    // 权威口径 lhb_daily_net 喂日度因子；lhb_all_net 只作诊断留痕，两者不共用任何中间量。
    const c = caliberFromDay(d);
    if (c.total_records) {
      s.lhb_count = c.total_records;
      // 重复披露留痕：raw_records 为东财原始条数，merged_away 为被合并掉的同票同值重复条数。
      // 存量老数据还没这两个字段 → 只在现算能给出时写入，避免把历史天伪造出 0。
      if (c.raw_records != null) s.lhb_raw_count = c.raw_records;
      if (c.merged_away != null) s.lhb_merged_away = c.merged_away;
      s.lhb_stocks = c.all_stocks;
      s.lhb_all_net = c.all_net_yi;
      s.net_pos = c.all_pos;
      s.net_neg = c.all_neg;
      s.lhb_daily_stocks = c.daily_stocks;
      s.lhb_daily_net = c.daily_net_yi;
      s.lhb_daily_amt = c.daily_amt_yi;
      s.lhb_range_count = c.range_records;
      // 新股口径：由 src/lhb.js 唯一产出（当日榜去重行 → 分离新股净买）。
      // 这三个字段是「s_net 已自动剔新股」的证据链，报告与回测都读它们，不再各自现算。
      s.lhb_daily_ex_new_net = c.daily_ex_new_net_yi;
      s.lhb_new_net = c.daily_new_net_yi;
      s.lhb_new_ratio = c.daily_new_ratio;
      s.lhb_new_count = c.daily_new_count;
      s.lhb_new_stocks = c.daily_new_stocks;
      if (d.emotion) d.emotion.lhb_daily_net = c.daily_net_yi;
    }
    // 字段定稿后校验 + 把脏字段从因子入参里摘掉
    //
    // ⚠ 判脏**不得注入销案台账**（2026-10-04 合流修正；实测缺陷，勿回退）：
    //   本处曾写作 `validateDay(d, { reviewedOutliers: REVIEWED_OUTLIERS })`，后果三重：
    //     ① 违背口径承诺 —— src/outlier_review.js 与 README 同款表述：「销案只停重复
    //        告警，**不动任何数值、不改 dirty/干净判定**」；
    //     ② 命中销案的天 dirty 留痕被**整条抹掉**（status=ok → 下方 delete），
    //        销案从"转为可审计的 suppressed 记录"退化为**静默消失**（信息丢失）；
    //     ③ 档案不再是 recalcAll 的**不动点** —— 审计「全档逐日 status 存档与现算一致」
    //        的现算走 `validateAll(days)`（不注台账），与注台账的存档口径打架；
    //        幂等守卫 test/pipeline_scope.test.mjs 同样必红（实测：2026-01-21/23/26、
    //        02-10、08-18 五天的 warn 留痕被抹，缩范围重算与全档重算结果不再相同）。
    //   故定稿：**档案只存原始判定** —— 「存档可重现」不得依赖一份可变的人工台账。
    //   销案的落点是 day.review（scripts/review_alerts.mjs，前端经 signals-latest
    //   的 dirty.recent[].reviewVerdict 展示）；跨源核验台账 data/industry_outlier_review.json
    //   仍是 scripts/verify_industry_outliers.mjs 的输入与去重依据。两条链路互不越界。
    //   （自 origin/main 合入：判脏体自 src/pipeline.js 搬至本模块，注释随行。）
    const vres = validateDay(d);
    const { cleaned, dropped } = sanitizeForFactors(d, vres);

    const netBuy = cleaned.netBuy ?? null;
    // 新股净买：优先用上面刚算出的当日榜分离结果；明细缺失的天回退为 0（不阻断，但不虚构数值）
    const newStockNet = cleaned.newStockNet ?? 0;
    // amount MA20：取当日之前最近 20 个有值交易日
    const hist = [];
    for (let j = i - 1; j >= 0 && hist.length < 20; j--) if (amts[j] != null) hist.unshift(amts[j]);
    const ma = hist.length >= 10 ? hist.reduce((a, b) => a + b, 0) / hist.length : null;
    const sent = computeSentiment({
      netBuy,
      newStockNet,
      newStockRatio: cleaned.newStockRatio ?? null,
      upCount: cleaned.upCount ?? null,
      downCount: cleaned.downCount ?? null,
      posRatio: cleaned.posRatio ?? null,
      industryUp: cleaned.industryUp ?? null,
      industryTotal: cleaned.industryTotal ?? null,
      limitUp: cleaned.limitUp ?? null,
      limitDown: cleaned.limitDown ?? null,
      brokenCount: cleaned.brokenCount ?? null,
      amount: cleaned.amount ?? null,
      amountMA20: ma,
    }, config.weights);
    const FKEY = { s_net20: 's_net', s_pos10: 's_pos', s_brd20: 's_brd', s_hot10: 's_hot', s_zdt15: 's_zdt', s_zbl10: 's_zbl', s_amt15: 's_amt' };
    const facPlain = {};
    for (const [wk, pk] of Object.entries(FKEY)) facPlain[pk] = sent.factors[wk];
    // ⚠ 诊断字段的**凭据**必须在覆写 emotion 之前抓取。
    //   下方 `d.emotion = { ...d.emotion, ... }` 会用一份新对象替换旧对象；
    //   而 hot_count / industryCount 这两个"是否曾经采集过"的凭据就存在旧对象里，
    //   覆写之后再读只会读到 undefined（实测踩过：hot_count 被自己的凭据判据挡掉，
    //   导致最新日的 hot_count/topic_conc/top_topic 整组蒸发）。
    //   教训与 #3 标脏的"时序纪律"同源：**先取证、再改写**。
    //   取证用 `!= null`（`0` 是合法凭据——"真抓到 0 只强势股"是可能且必须保留的事实），
    //   但拒 undefined/''/null（那才是"从没采集过"）。
    const priorHotCount = (d.emotion && d.emotion.hot_count != null && d.emotion.hot_count !== '') ? d.emotion.hot_count : null;
    const priorIndustryCount = (d.emotion && d.emotion.industryCount != null && d.emotion.industryCount !== '') ? d.emotion.industryCount : null;
    d.emotion = {
      ...d.emotion,
      value: sent.score,
      ...facPlain,
      factors: facPlain,
      imputedRatio: sent.imputedRatio,
      missing: sent.missing,
      newStock: sent.newStock,
      // ── 回填标记（BACKFILL_FLAG）由**本重算路径统一裁定** ──────────────────
      //   ⚠ 这是一处真实的漂移源，实测抓出来的（scripts/need_rebuild.mjs --verify 报 241/241 天变）：
      //     旧档里有 208 天带 `emotion._backfill = true`（历史龙虎榜回填天），而本函数
      //     只重建**数值因子**、从不写这个标记；一旦经 recalcAll 重算，标记即被静默抹掉。
      //     后果不是"少个字段"，而是**判定翻转**：回测/前端都靠它排除"只有 s_net、
      //     其余六因子未采集"的假情绪分天。标记丢了 → 208 天的假分混进回测样本，
      //     每个指标一起失真，而且没有任何报错。
      //   故在此按**原料可得性**重新裁定，与 src/backfill.js 的 buildBackfillDay 同判据：
      //     回填天 = 无行业明细（ind_count 缺失/为 0）且无涨跌家数（up_count 缺失）。
      //     这正是 buildBackfillDay 写下的形态（ind_count: 0，无 up_count）。
      //   注意判据用 `hasRaw` 而非"字段存在与否"：hasRaw 已经区分了"有原始数据"与
      //     "有壳无内容"，两者是同一件事的两个说法，不应各写一遍。
      ...(isBackfillShaped(s) ? { [BACKFILL_FLAG]: true } : {}),
      // #3 标脏留痕：本日被剔除的因子入参 + 校验状态。
      //   只写"有情况"的天（干净天不写字段），避免给 241 天全加上噪声字段。
      //   形态：{ status, dropped: ['netBuy', ...], issues: [{field,rule,severity,reason}] }
      //   报告与前端据此说"今天哪个因子被跳过了"，而不是让用户猜。
      ...(vres.status === 'ok' ? {} : {
        dirty: {
          status: vres.status,
          dropped: dropped.slice(),
          fields: [...vres.dirtyFields],
          issues: vres.issues.map((x) => ({ field: x.field, rule: x.rule, severity: x.severity, reason: x.reason })),
        },
      }),
    };
    // ⚠ 干净天必须**清掉旧 dirty**（实测抓出的陈旧留痕 bug）：上方 `...d.emotion`
    //   展开会保留旧键，而 dirty 只在"有情况"时写入、从不在变干净时删除——
    //   阈值重标定（如 INDUSTRY_CHANGE_ABS_MAX 12→15）后，原本判脏的天经重算
    //   已是 vres.status='ok'，但旧 ERROR 留痕永久残留，面板永远显示"剔除 2 天"，
    //   与真实因子状态（s_brd 已恢复真实值）自相矛盾。数据质量面板必须与
    //   当前口径一致，而不是与历史口径一致。
    if (vres.status === 'ok') delete d.emotion.dirty;
    // 回填标记双向裁定（见上方 ⚠ 注）：原料已齐的天必须移除旧标记，防止
    // 「七因子真分天」被前端/回测当假分天永久过滤。isBackfillShaped 为本文件私有判据。
    if (!isBackfillShaped(s)) delete d.emotion[BACKFILL_FLAG];
    // ── 诊断字段由重算路径刷新（防"算过就不管"的静默陈旧）──────────────────
    //   实测抓出的第二处漂移：`emotion.pos_ratio / up_ratio / hot_count / topic_conc /
    //   top_topic` 只在**实时抓取**（src/sources.js buildDay）时写入，
    //   recalcAll 不碰它们。于是经重算路径回写后，最新一天这五个字段整组消失——
    //   它们是留痕/证据链（守卫按 pos_ratio 反算校验 s_pos 用的就是 pos_ratio），
    //   丢了之后守卫虽不报错、但**证据链断了一环**。
    //
    //   ⚠ 但"补字段"有一个**不可逆的伪造风险**，故必须与真实抓取严格区分：
    //     历史天（回填/早期）的档里 `hot` 是**裁剪后的空壳**（buildBackfillDay 直接写
    //     `hot: []`），hot_count 则从未写入过。若按"用档里现成数据重建"去补，
    //     就会用空壳算出 `hot_count = 0` 并落盘 —— 那是**把"未采集"伪造成"今天有 0 只
    //     强势股"**，恰恰违反本项目铁律（缺失显式化：unknown ≠ 0）。
    //     实测验证过这个陷阱：第一版补字段把首日补成 hot_count=0，而真实值是"未采集"。
    //   故补字段必须带**证据门槛**：只有当原料在档里是**真值**时才补，否则**保持缺失**。
    //     · pos_ratio：net_pos/net_neg 是正式链路的真值（回填天也有）→ 可补
    //     · hot_count / topic_conc / top_topic：**只有**当日真实抓过 hot 才有意义 →
    //       以 `emotion.hot_count` 曾存在或 `summary.hot_count` 存在为凭据，否则跳过
    //     · up_ratio：需 industry 明细 + ind_up，两者齐备才补
    //
    //   ⚠⚠ 第三处发现（**不是漂移，是既有数据不可复现**）——
    //     实测枚举了四种可能口径，**没有任何一种能从存档数据反推出 pos_ratio**：
    //       全部记录笔数比 1/33、每股一笔(|额|最大) 5/33、金额比 5/33、去重行数比 1/33。
    //     即：存档里的 `emotion.pos_ratio` 与当天存档的 `summary.net_pos/net_neg`
    //     **不自洽**（例：2026-08-14 存 52.7，而 net_pos=33/net_neg=34 → 49.25）。
    //     它大概是某次已废弃口径的遗留产物，但**原始输入已不可考**。
    //     处置（关键，别改成"顺手覆盖"）：
    //       · 若直接把重算值写进去 → 30 个历史日的 `pos_ratio` 会被静默改写，
    //         而这 30 天正是回填期数据，**没人能判断哪个才是对的**。那是拿一次
    //         "修复"去掩盖一次"数据完整性问题"，且不可逆（原值没了）。
    //       · 故：**现存的存疑值原样保留**，只在重算值与之不一致时打留痕
    //         `pos_ratio_inconsistent`，交给报告/人工复核。这是"缺失显式化"的延伸：
    //         **不一致也要显式化**，不能靠覆盖来消灭症状。
    //       · 只在原本没有该字段时**补**（补的是可复现值，有据可依）。
    if (s.net_pos != null && s.net_neg != null && (s.net_pos + s.net_neg) > 0) {
      const recomputed = r1s((s.net_pos / (s.net_pos + s.net_neg)) * 100);
      const stored = (d.emotion && d.emotion.pos_ratio != null) ? numOf(d.emotion.pos_ratio) : null;
      if (stored == null) {
        d.emotion.pos_ratio = recomputed;
      } else if (recomputed != null && Math.abs(stored - recomputed) > 0.05) {
        // 保留原值 + 留痕。留痕里同时给出"存档值"与"由存档输入重算的值"，
        // 复核者不必自己去翻 net_pos/net_neg 就能判断。
        d.emotion.pos_ratio_stale = {
          stored,
          recomputed,
          inputs: { net_pos: s.net_pos, net_neg: s.net_neg },
          note: '存档 pos_ratio 与由 summary.net_pos/net_neg 重算的值不一致，且原口径不可复现；'
            + '原值已保留未改写，此处仅留痕待人工复核。',
        };
      }
    }
    if (Array.isArray(d.industry) && d.industry.length && s.ind_up != null) {
      d.emotion.up_ratio = r1s((s.ind_up / d.industry.length) * 100);
    }
    // 强势股相关三字段：凭据 = 这一天**确实抓过**热榜（priorHotCount 非 null）。
    //   这是唯一能区分"真 0 只"与"未采集"的信息；绝不看 d.hot.length 反推
    //   （回填天的 d.hot 是空壳，反推会得出"今天有 0 只强势股"的伪造结论）。
    if (priorHotCount != null && Array.isArray(d.hot)) {
      d.emotion.hot_count = d.hot.length;
      const top = Array.isArray(d.topics) && d.topics.length ? d.topics[0] : null;
      if (top && top.count != null) {
        d.emotion.topic_conc = r1s((top.count / (d.hot.length || 1)) * 100);
      }
      if (top && top.tag != null) d.emotion.top_topic = top.tag;
    }
    // ── 重算路径必须与在线抓取**同字段集**：industryCount 是 buildDay 写的诊断字段，
    //   重算路径漏写会让它整组消失（实测：最新日 industryCount 丢失）。
    //   ⚠ 只在**真抓到行业明细**时写（ind_count > 0）。回填天 buildDay 从未运行过，
    //     给它补一个 industryCount: 0 等于**把"未采集"伪造成"采集到 0 个行业"**——
    //     正是本项目反复禁止的那件事。判据取 ind_count > 0，不用"字段是否存在"，
    //     但一旦这天曾经有过真值（priorIndustryCount），本轮的 0 就是"真的掉到 0"，
    //     此时**保留真值 0** 而不是删字段（否则会把一次真实退化伪装成"未采集"）。
    if (priorIndustryCount != null && !(s.ind_count > 0)) {
      d.emotion.industryCount = 0;
    } else if (s.ind_count != null && Number.isFinite(+s.ind_count) && +s.ind_count > 0) {
      d.emotion.industryCount = +s.ind_count;
    } else {
      delete d.emotion.industryCount;
    }
  });
  // ── 以下两段**刻意对全档跑**（即使 scope 只覆盖 1~2 天）──────────────────
  //   理由见函数头注：它们都是逐日无状态的薄操作（分位只看截至当日的窗口、
  //   相对强弱只读当日 summary），全档跑是毫秒级，且避免"两条调用路径"的分叉风险。
  //   真正重的是上面的因子段（标脏/校验/七因子/诊断字段），那一段已被 scope 跳过。
  //
  // 板块相对强弱：与情绪分一样属于**派生指标**，必须在每次写档时重算——
  // 否则新增口径（如换基准、改 topN）对存量天永不生效，只能靠手工回填。
  // 口径唯一实现在 src/relative.js；此处只负责调用与挂载。
  // 无行业明细的历史天（208/241）返回 null → 不写字段，报告/前端显示「未计算」。
  days.forEach((d) => {
    if (!d.summary) return;
    const rel = computeRelative(d);
    if (rel) d.summary.industry_relative = rel;
    else delete d.summary.industry_relative;
  });
  recalcRanks(days);
}
