import { chainCompare, ownSignature, priceOf, round2 } from "../domain";
import type {
  Derived,
  Handover,
  HandoverLine,
  LedgerTotals,
  LineDerived,
  Product,
  ReviewStatus
} from "../types";

/**
 * 交接单 × 罐存 复核账引擎（纯函数，可单测）
 *
 * 规则：
 *  - 同一日期#班次只有一张交接单参与计算（重复补录在写入层幂等去重）
 *  - 每个班次的派生结果按 [本班输入签名 + 上游起始罐存签名] 缓存：
 *    现金/电子支付/读数变化 → ownSig 变化，本班重算；
 *    上游复核班次读数变化或复核状态推进 → baselineSig 变化，受影响班次重算；
 *    两个签名都没变的班次直接保留上次结果。
 *  - 销量与收入只有在“复核通过”后才计入总收入，并作为后续班次的起始罐存；
 *    通过前的班次会把罐存链标为断开，后续班次起始罐存不予接续。
 */

interface CacheEntry {
  ownSig: string;
  baselineSig: string;
  derived: Derived;
}

export type ReconcileCache = Record<string, CacheEntry>;

function lineOf(lines: HandoverLine[], code: string): HandoverLine {
  return lines.find((l) => l.code === code) ?? {
    code,
    pumpStart: 0,
    pumpEnd: 0,
    tankStart: 0,
    tankEnd: 0,
    delivery: 0
  };
}

/** 该班次引用的起始罐存：只从最近一张“复核通过”的班次取结束读数 */
function baselineSource(
  record: Handover,
  previous: Handover | undefined,
  lastApproved: Handover | null,
  products: Product[]
): { baselineId: string | null; ends: (number | null)[]; broken: boolean; sig: string } {
  // 罐存链上的第一张单子：没有上游，起始罐存以本班量罐读数为准
  if (!previous) {
    return { baselineId: null, ends: products.map(() => null), broken: false, sig: "baseline:none" };
  }
  const broken = lastApproved === null || lastApproved.id !== previous.id;
  if (!lastApproved) {
    return { baselineId: null, ends: products.map(() => null), broken: true, sig: "baseline:gap:root" };
  }
  const ends = products.map((p) => lineOf(lastApproved.lines, p.code).tankEnd);
  // 只依赖上一通过班次的实际结束读数：现金/电子支付/备注变化不重算下游，读数变化才会
  const sig = `baseline:${lastApproved.id}:${ends.join("|")}`;
  return {
    baselineId: lastApproved.id,
    ends: broken ? products.map(() => null) : ends,
    broken,
    sig
  };
}

function computeDerived(
  record: Handover,
  previous: Handover | undefined,
  lastApproved: Handover | null,
  cached: boolean,
  products: Product[]
): Derived {
  const base = baselineSource(record, previous, lastApproved, products);

  const lines: LineDerived[] = products.map((p) => {
    const l = lineOf(record.lines, p.code);
    const pumpSales = round2(l.pumpEnd - l.pumpStart);
    const tankSales = round2(l.tankStart + l.delivery - l.tankEnd);
    return {
      code: p.code,
      pumpSales,
      tankSales,
      delivery: l.delivery,
      // 差异口径与收款一致：账（罐存销量）− 实（泵码销量），正为溢余、负为损耗
      volumeVariance: round2(tankSales - pumpSales),
      // 应接续的起始罐存（来自上一通过班次）；null 表示无上游或链已断开
      baselineEnd: base.ends.find((_, i) => products[i].code === p.code) ?? null
    };
  });

  const pumpSalesTotal = round2(lines.reduce((s, l) => s + l.pumpSales, 0));
  const tankSalesTotal = round2(lines.reduce((s, l) => s + l.tankSales, 0));
  // 应收按品逐笔取整汇总（与现金/电子实收口径一致）
  const expectedCash = round2(
    lines.reduce((s, l) => s + Math.round(l.pumpSales * priceOf(l.code)), 0)
  );

  return {
    id: record.id,
    lines,
    pumpSalesTotal,
    tankSalesTotal,
    volumeVariance: round2(tankSalesTotal - pumpSalesTotal),
    revenue: round2(record.cash + record.digital),
    paymentVariance: round2(record.cash + record.digital - expectedCash),
    ownSig: ownSignature(record),
    baselineSig: base.sig,
    chainBroken: base.broken,
    baselineId: base.baselineId,
    cached
  };
}

export interface ReconcileResult {
  /** 按罐存链顺序排列的派生结果（与 records 排序后一一对应） */
  derived: Derived[];
  /** 本次实际重算（未命中缓存）的班次 id */
  recomputedIds: string[];
  cache: ReconcileCache;
  totals: LedgerTotals;
  /** 每个 natKey 对应的记录 id（重复补录只会有一张生效） */
  byNatKey: Map<string, Handover>;
}

export function reconcile(recordsInput: Handover[], prevCache: ReconcileCache, products: Product[]): ReconcileResult {
  // 同一自然键只保留一张（后写覆盖由服务端保证，这里再兜底去重）
  const byNatKey = new Map<string, Handover>();
  for (const r of recordsInput) {
    const exist = byNatKey.get(r.natKey);
    if (!exist || exist.version < r.version) byNatKey.set(r.natKey, r);
  }
  const records = [...byNatKey.values()].sort(chainCompare);

  const cache: ReconcileCache = {};
  const derived: Derived[] = [];
  const recomputedIds: string[] = [];
  let lastApproved: Handover | null = null;
  let previous: Handover | undefined;

  let revenue = 0;
  let approvedSales = 0;
  let approvedCount = 0;
  let nextApproveId: string | null = null;
  let seenUnapproved = false;

  for (const record of records) {
    const ownSig = ownSignature(record);
    const base = baselineSource(record, previous, lastApproved, products);
    const cachedEntry = prevCache[record.id];
    const hit = !!cachedEntry && cachedEntry.ownSig === ownSig && cachedEntry.baselineSig === base.sig;

    let d: Derived;
    if (hit) {
      d = { ...cachedEntry!.derived, cached: true };
    } else {
      d = computeDerived(record, previous, lastApproved, false, products);
      recomputedIds.push(record.id);
    }
    cache[record.id] = { ownSig, baselineSig: base.sig, derived: d };
    derived.push(d);

    if (record.status === ("approved" satisfies ReviewStatus)) {
      approvedCount += 1;
      // 通过状态必须沿链连续：一旦前面出现过未通过班次，后面的通过单不接续起始罐存
      if (!seenUnapproved) {
        revenue += d.revenue;
        approvedSales += d.pumpSalesTotal;
        lastApproved = record;
      } else if (!nextApproveId) {
        nextApproveId = record.id;
      }
    } else {
      // 待复核/驳回：销量暂不计入，并把后面的罐存链标记为断开
      seenUnapproved = true;
      if (!nextApproveId) nextApproveId = record.id;
    }

    previous = record;
  }

  return {
    derived,
    recomputedIds,
    cache,
    totals: {
      revenue: round2(revenue),
      approvedSales: round2(approvedSales),
      approvedCount,
      pendingCount: records.length - approvedCount,
      conflictCount: 0,
      nextApproveId
    },
    byNatKey
  };
}
