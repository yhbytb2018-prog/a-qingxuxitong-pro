/**
 * 数据血统表 TypeScript 接口 —— factor_lineage.json 的类型契约。
 *
 * 用途：任何消费 factor_lineage.json 的代码（未来的 S6 血统面板、口径审计脚本、
 * 外部工具）都必须按本接口取数，字段名漂移会在类型层被拦截。
 * 本文件是纯类型声明（项目运行时为纯 JS，无构建依赖）；.d.ts 由
 * test/factor_lineage.test.mjs 做结构性守卫（七因子齐全、权重与 config 一致）。
 */

/** 因子数据的来源链描述（分子或分母） */
export interface LineageSource {
  /** 从原始接口到入参的完整加工链（含去重/剔除/求和步骤与代码出处） */
  chain: string;
  /** 上游数据源端点（接口 URL 或存档字段） */
  sourceEndpoint: string;
}

/** 单个情绪因子的血统条目 */
export interface FactorLineage {
  /** 加权键名（与 src/config.js#weights 的键一一对应） */
  id: FactorId;
  /** 存档/前端展示键名（无档位后缀） */
  displayKey: string;
  /** 中文标签 */
  label: string;
  /** 该因子权重（必须等于 config.weights[id]） */
  weight: number;
  /** 计算公式（人类可读，含版本分支说明） */
  formula: string;
  /** 分子来源链 */
  numerator: LineageSource;
  /** 分母来源链（无量纲因子则为归一基准的说明） */
  denominator: LineageSource;
  /** 时间对齐口径：T日/T−1及以前；必须显式声明防前视约束 */
  timeAlignment: string;
  /** 缺失策略：代理指标 → 中性50显式标记；禁止静默 */
  missingPolicy: string;
  /** 熔断/扰动拦截规则（无则显式写「无」并说明原因） */
  circuitBreaker: string;
  /** 审计留痕字段（存档中可核对的证据链路径） */
  evidenceFields: string[];
}

/** 派生指标（非加权因子，但同样需要口径唯一出处） */
export interface DerivedIndicator {
  id: 'pct_rank' | 'net_daily_pct_rank' | string;
  label: string;
  formula: string;
  source: string;
  timeAlignment: string;
  /** 防前视证明的测试出处 */
  noLookaheadProof?: string;
}

/** 七因子 id 字面量（与 config.weights 键一致） */
export type FactorId =
  | 's_net20'
  | 's_pos10'
  | 's_brd20'
  | 's_hot10'
  | 's_zdt15'
  | 's_zbl10'
  | 's_amt15';

/** 血统表顶层结构 */
export interface FactorLineageDoc {
  meta: {
    formulaVersion: string;
    generatedNote: string;
    weightsSource: string;
    missingPolicyGlobal: string;
    dirtyPolicy: string;
  };
  factors: FactorLineage[];
  derivedIndicators: DerivedIndicator[];
  composition: {
    formula: string;
    rounding: string;
    missingDisclosure: string;
  };
}
