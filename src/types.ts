// 交接单 × 罐存复核账：领域类型定义

/** 油品（一种油品对应一个储罐，读数按品号记录） */
export interface Product {
  code: string;
  name: string;
  price: number;
}

/** 单条油品交接行：泵码销量 / 本班次起止罐存读数（L） */
export interface HandoverLine {
  code: string;
  /** 泵码起数 */
  pumpStart: number;
  /** 泵码止数 */
  pumpEnd: number;
  /** 本班起始罐存读数（手工量罐） */
  tankStart: number;
  /** 本班结束罐存读数（手工量罐） */
  tankEnd: number;
  /** 本班次内配送入库量 */
  delivery: number;
}

export type ShiftName = "早班" | "中班" | "晚班";
export type ReviewStatus = "approved" | "pending" | "rejected";
export type RecordSource = "online" | "backfill";

export const STATUS_TEXT: Record<ReviewStatus, string> = {
  pending: "待复核",
  approved: "复核通过",
  rejected: "复核驳回"
};

/** 交接单（服务端权威记录） */
export interface Handover {
  id: string;
  /** 自然键：日期#班次，同一班次只允许一张交接单 */
  natKey: string;
  date: string;
  shift: ShiftName;
  operator: string;
  /** 现金收入（元） */
  cash: number;
  /** 电子支付（元） */
  digital: number;
  lines: HandoverLine[];
  notes: string;
  status: ReviewStatus;
  /** 离线补录标记：断网时录入、早班同步后并入复核账 */
  source: RecordSource;
  /** 乐观锁版本，每次写入 +1，用于两名值班员并发提交冲突检测 */
  version: number;
  createdAt: string;
  updatedAt: string;
  /** 首次提交的客户端事务号，重复补录幂等去重 */
  firstSubmitId: string;
}

/** 表单输入（新建 / 编辑 / 冲突处理共用） */
export interface HandoverInput {
  date: string;
  shift: ShiftName;
  operator: string;
  cash: number;
  digital: number;
  lines: HandoverLine[];
  notes: string;
  source: RecordSource;
}

/** 单油品行的派生结果 */
export interface LineDerived {
  code: string;
  pumpSales: number;
  tankSales: number;
  volumeVariance: number;
  delivery: number;
  /** 应接续的上一通过班次结束读数；null = 无上游或链已断开 */
  baselineEnd: number | null;
}

/** 一张交接单的派生结果（增量重算引擎的缓存单位） */
export interface Derived {
  id: string;
  lines: LineDerived[];
  /** 泵码销量合计 */
  pumpSalesTotal: number;
  /** 罐存销量合计 */
  tankSalesTotal: number;
  /** 量罐差异合计 */
  volumeVariance: number;
  /** 当班收入 = 现金 + 电子支付 */
  revenue: number;
  /** 收款差异 = 现金+电子 - 泵码销量×单价（正长款、负短款） */
  paymentVariance: number;
  /** 各班次自有输入的签名（现金/电子/读数变化即变化） */
  ownSig: string;
  /** 上一通过班次传来的起始罐存签名（上游变化即变化） */
  baselineSig: string;
  /** 上游是否存在未通过班次（起始罐存链断开） */
  chainBroken: boolean;
  /** 计算时引用的上游交接单 id（最近一张复核通过的班次） */
  baselineId: string | null;
  /** 本次是否命中上次缓存（保留上次结果） */
  cached: boolean;
}

export interface LedgerTotals {
  /** 总收入：只统计复核通过的班次（销量在通过前暂不计入） */
  revenue: number;
  approvedSales: number;
  approvedCount: number;
  pendingCount: number;
  conflictCount: number;
  /** 待复核列表最前面那张：它通过后会接续起始罐存 */
  nextApproveId: string | null;
}

/** 写入动作的 WAL 类型 */
export type WalActionType = "submit" | "approve" | "reject";

export interface WalEntry {
  txnId: string;
  action: WalActionType;
  natKey: string;
  /** submit 时的输入快照 */
  input?: HandoverInput;
  /** 乐观锁基版本：冲突时检测 */
  baseVersion: number;
  /** 强制覆盖（后到者选择保留自己的输入） */
  force: boolean;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  time: string;
  text: string;
  kind: "info" | "success" | "warn" | "error";
}

/** 断网箱里的一条写入（写入失败从断点继续） */
export interface OutboxItem {
  txnId: string;
  action: WalActionType;
  natKey: string;
  input?: HandoverInput;
  baseVersion: number;
  force: boolean;
  state: "queued" | "sending" | "conflict" | "done" | "failed";
  attempts: number;
  lastError: string;
  createdAt: string;
}

/** 两名值班员并发提交时后到者看到的冲突 */
export interface ConflictInfo {
  /** 冲突对应的 outbox 事务 */
  txnId: string;
  natKey: string;
  /** 先到者（服务端当前版本） */
  server: Handover;
  /** 后到者保留的输入 */
  incoming: HandoverInput;
  baseVersion: number;
}

export interface Notice {
  id: string;
  kind: "info" | "success" | "warn" | "error";
  text: string;
}

/** 服务端返回 */
export type SaveResult =
  | { ok: true; record: Handover; duplicate: boolean }
  | { ok: false; error: "offline" | "conflict"; server?: Handover };
