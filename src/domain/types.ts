// 加油站班次交接 / 罐存复核账 —— 领域类型

export type ShiftName = "早班" | "中班" | "晚班";

/** 班次在一天内的先后顺序，交接链按 日期+班次 排序 */
export const SHIFT_ORDER: Record<ShiftName, number> = {
  早班: 0,
  中班: 1,
  晚班: 2
};

export type ReviewStatus = "pending" | "approved";

export const STATUS_LABEL: Record<ReviewStatus, string> = {
  pending: "待复核",
  approved: "已复核"
};

/** 一张交接单（同一日期+班次+油品 唯一） */
export interface HandoverInput {
  handoverId: string;
  /** 幂等键：断网补录重试、重复补录都凭它只算一次 */
  idempotencyKey: string;
  fuel: string; // 油品编码，如 92
  date: string; // YYYY-MM-DD
  shift: ShiftName;
  meterStart: number; // 接班流量计读数 L
  meterEnd: number; // 交班流量计读数 L
  tankEnd: number; // 交班实测罐存 L
  delivery: number; // 本班入库 L
  cash: number; // 现金收入（元）
  digital: number; // 电子支付（元）
  notes?: string;
  status: ReviewStatus;
  version: number; // 乐观锁版本
}

/** 油品配置与锚点（上日晚班交班后的基准读数/罐存） */
export interface FuelConfig {
  code: string;
  name: string;
  price: number; // 单价 元/L
  baseMeter: number; // 锚点流量计读数
  baseTank: number; // 锚点实测罐存
}

/** 复核账里一行（一张交接单 + 两套口径的计算结果） */
export interface LedgerRow extends HandoverInput {
  fuelName: string;
  price: number;
  orderKey: string;
  /** 工作账：按交接链连续推算（待复核也参与） */
  flow: number; // 本班销量（流量计差值）
  meterJump: number | null; // 接班读数与上一班交班读数不一致的差值
  trialOpen: number; // 工作账起始罐存（上一班实测罐存）
  bookClose: number; // 工作账账面罐存 = 起始 + 入库 - 销量
  tankDiff: number; // 罐存差异 = 实测 - 账面
  revenue: number; // 本班收入 = 现金 + 电子支付
  expectedRevenue: number; // 应收 = 销量 × 单价
  moneyDiff: number; // 收入差异 = 实收 - 应收
  /** 正式账：仅已复核单据参与；待复核班次为 null */
  officialFlow: number | null;
  officialOpen: number | null;
  officialBookClose: number | null;
  officialTankDiff: number | null;
  officialRevenue: number | null;
  /** 本行本次是否命中缓存（true=保留上次结果，false=受影响重算） */
  reused: boolean;
}

export interface FuelSummary {
  code: string;
  name: string;
  officialFlow: number; // 已复核销量
  pendingFlow: number; // 待复核销量
  officialRevenue: number; // 已复核收入
  pendingRevenue: number; // 待复核收入
  /** 正式账当前罐存（最近一张已复核单的实测罐存，无则锚点） */
  officialTank: number | null;
  /** 工作账当前罐存（最近一张单的实测罐存） */
  trialTank: number | null;
}

export interface LedgerTotals {
  officialRevenue: number;
  pendingRevenue: number;
  officialFlow: number;
  pendingFlow: number;
  pendingCount: number;
  approvedCount: number;
}

export interface CachedRow {
  sig: string;
  row: LedgerRow;
}

export interface LedgerResult {
  rows: LedgerRow[];
  totals: LedgerTotals;
  perFuel: Record<string, FuelSummary>;
  cache: Map<string, CachedRow>;
  generatedAt: number;
}
