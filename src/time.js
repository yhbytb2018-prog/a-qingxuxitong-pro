// 北京时区（BJ，UTC+8）换算的唯一出处。
//
// 收敛背景：BJ 换算此前在 6 处各自手算（freshness.js / util.js / idempotence.js /
// need_rebuild.mjs / fetch_calendar.mjs / app.js），写法互不一致（toISOString 切片、
// 手拼年月日、replace('Z','+08:00')），改一处漏一处。现全部收敛到本模块——
// 零依赖叶子模块，可被 src/ 任意层与 scripts/ 直接引用，无循环依赖风险。
//
// 纪律：除本模块外，全仓不得再出现 `8 * 3600 * 1000` / `28800` / `Asia/Shanghai` 等
// 时区换算字面量。豁免三处：app.js、paper_ui.js 与 ui/template.html 属浏览器展示层，
// 无法 import 本模块；src/global.js 的美东时区是另一套语义（含 DST），不在此收敛范围。
// 中国无夏令时，UTC+8 固定偏移，换算不依赖宿主机时区。

export const BJ_OFFSET_MS = 8 * 3600 * 1000;

/** 北京时区日期 YYYY-MM-DD */
export function bjDate(now = new Date()) {
  return new Date(now.getTime() + BJ_OFFSET_MS).toISOString().slice(0, 10);
}

/** 北京时区时刻 HH:MM（两段式比较可当字符串用） */
export function bjTime(now = new Date()) {
  return new Date(now.getTime() + BJ_OFFSET_MS).toISOString().slice(11, 16);
}

/** 北京时区完整时刻戳：ISO 8601 带显式 +08:00 偏移（落盘留痕字段用，可读且免时区歧义） */
export function bjStamp(now = new Date()) {
  return new Date(now.getTime() + BJ_OFFSET_MS).toISOString().replace('Z', '+08:00');
}

/** 北京墙上时刻（YYYY-MM-DD + HH:MM）→ 绝对时间戳（epoch 毫秒数，与 Date.parse 同型）。
 *  注意返回的是**数值**不是 Date——旧 atBH/atBJ 语义即数值，freshness.publishDeadline
 *  的返回值会进 JSON 落盘（数值序列化为 epoch ms），改 Date 会造成线上数据格式漂移。
 *  收编背景：freshness.js 私有 atBJ 与 need_rebuild.mjs 的 Date.UTC(…)-8h 原是同一
 *  语义的两份手写实现，现统一到此处。 */
export function bjInstant(dateStr, hhmm) {
  return Date.parse(`${dateStr}T${hhmm}:00+08:00`);
}
