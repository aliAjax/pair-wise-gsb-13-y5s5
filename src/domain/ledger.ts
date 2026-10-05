// 复核账引擎：交接单 + 罐存串成两条账（工作账 / 正式账）
//
// 背景：交接员断网时补录交接单，早班数据同步后，若全部重算会把罐存和收入算乱。
// 规则：
// 1. 工作账按 (日期, 班次) 交接链连续推算；
// 2. 每张单据的结果带签名，签名不变则直接复用上次结果（其他班次保留上次结果），
//    只有其输入（现金/电子支付/罐存读数/流量/入库等）或上游锚点变化时才重算；
// 3. 正式账只串已复核单据 —— 复核通过前，该班销量暂不计入总收入与起始罐存。

import {
  SHIFT_ORDER,
  type CachedRow,
  type FuelConfig,
  type HandoverInput,
  type LedgerResult,
  type LedgerRow,
  type LedgerTotals
} from "./types";

/** 参与本行工作账计算的输入签名：自身读数/收款 + 上游锚点 */
function trialSignature(h: HandoverInput, prevTankEnd: number, prevMeterEnd: number): string {
  return [
    h.fuel,
    h.meterStart,
    h.meterEnd,
    h.tankEnd,
    h.delivery,
    h.cash,
    h.digital,
    prevTankEnd.toFixed(3),
    prevMeterEnd.toFixed(3)
  ].join("|");
}

/** 参与本行正式账计算的签名：仅已复核单会进入，上游同样只取已复核 */
function officialSignature(
  h: HandoverInput,
  prev: { tankEnd: number; meterEnd: number } | null
): string {
  return [
    h.handoverId,
    h.status,
    h.fuel,
    h.meterStart,
    h.meterEnd,
    h.tankEnd,
    h.delivery,
    h.cash,
    h.digital,
    prev ? `${prev.tankEnd.toFixed(3)}:${prev.meterEnd.toFixed(3)}` : "anchor"
  ].join("|");
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function blankTotals(): LedgerTotals {
  return {
    officialRevenue: 0,
    pendingRevenue: 0,
    officialFlow: 0,
    pendingFlow: 0,
    pendingCount: 0,
    approvedCount: 0
  };
}

/**
 * 计算复核账。
 * @param inputs 全部交接单（含待复核、重复补录应先在仓储层去重）
 * @param configs 油品配置（锚点、单价）
 * @param previous 上次计算留下的行级缓存；签名命中则保留上次结果
 */
export function buildLedger(
  inputs: HandoverInput[],
  configs: FuelConfig[],
  previous?: Map<string, CachedRow>
): LedgerResult {
  const configMap = new Map(configs.map((c) => [c.code, c]));
  const totals = blankTotals();
  const perFuel: LedgerResult["perFuel"] = {};
  const cache = new Map<string, CachedRow>();

  // 按油品分组，组内按日期+班次排序串链
  const byFuel = new Map<string, HandoverInput[]>();
  for (const h of inputs) {
    const list = byFuel.get(h.fuel) ?? [];
    list.push(h);
    byFuel.set(h.fuel, list);
  }

  const rows: LedgerRow[] = [];

  // 汇总需要覆盖所有配置过的油品（即便暂无单据）
  for (const fuel of configs.map((c) => c.code)) {
    perFuel[fuel] = {
      code: fuel,
      name: configMap.get(fuel)?.name ?? fuel,
      officialFlow: 0,
      pendingFlow: 0,
      officialRevenue: 0,
      pendingRevenue: 0,
      officialTank: null,
      trialTank: null
    };
  }

  for (const [fuelCode, list] of byFuel) {
    const config = configMap.get(fuelCode);
    if (!config) continue; // 未配置油品跳过，避免脏数据污染账面
    const chain = [...list].sort(
      (a, b) =>
        a.date.localeCompare(b.date) || SHIFT_ORDER[a.shift] - SHIFT_ORDER[b.shift]
    );

    // 工作账锚点：随链滚动
    let trialTank = config.baseTank;
    let trialMeter = config.baseMeter;
    // 正式账锚点：只被已复核单推进
    let officialPrev: { tankEnd: number; meterEnd: number } | null = null;

    for (const h of chain) {
      const cached = previous?.get(h.handoverId);
      const sigTrial = trialSignature(h, trialTank, trialMeter);
      const sigOfficial = officialSignature(h, officialPrev);
      const sig = `${h.version}#${sigTrial}#${sigOfficial}`;

      let row: LedgerRow;
      let reused = false;
      if (cached && cached.sig === sig) {
        // 输入与上游锚点均未变：保留上次结果，不重算
        row = cached.row;
        reused = true;
      } else {
        const flow = round3(h.meterEnd - h.meterStart);
        const meterJump = round3(h.meterStart - trialMeter);
        const trialOpen = trialTank;
        const bookClose = round3(trialOpen + h.delivery - flow);
        const tankDiff = round3(h.tankEnd - bookClose);
        const revenue = round3(h.cash + h.digital);
        const expectedRevenue = round3(flow * config.price);
        const moneyDiff = round3(revenue - expectedRevenue);

        let officialFlow: number | null = null;
        let officialOpen: number | null = null;
        let officialBookClose: number | null = null;
        let officialTankDiff: number | null = null;
        let officialRevenue: number | null = null;

        if (h.status === "approved") {
          officialFlow = flow;
          officialOpen = officialPrev ? officialPrev.tankEnd : config.baseTank;
          officialBookClose = round3(officialOpen + h.delivery - flow);
          officialTankDiff = round3(h.tankEnd - officialBookClose);
          officialRevenue = revenue;
        }

        row = {
          ...h,
          fuelName: config.name,
          price: config.price,
          orderKey: `${h.date}-${String(SHIFT_ORDER[h.shift]).padStart(2, "0")}`,
          flow,
          meterJump: Math.abs(meterJump) < 1e-6 ? 0 : meterJump,
          trialOpen,
          bookClose,
          tankDiff,
          revenue,
          expectedRevenue,
          moneyDiff,
          officialFlow,
          officialOpen,
          officialBookClose,
          officialTankDiff,
          officialRevenue,
          reused
        };
      }
      // 以本次是否命中缓存为准（命中时旧行对象里可能还留着上次的 false）
      row.reused = reused;

      cache.set(h.handoverId, { sig, row });
      rows.push(row);

      // —— 推进工作账锚点（实测罐存为准；读数异常时仍以交班读数续接） ——
      trialTank = h.tankEnd;
      trialMeter = h.meterEnd;
      if (perFuel[fuelCode]) {
        perFuel[fuelCode].trialTank = h.tankEnd;
      }

      // —— 推进正式账锚点与汇总：只有已复核才计入 ——
      if (h.status === "approved") {
        officialPrev = { tankEnd: h.tankEnd, meterEnd: h.meterEnd };
        totals.officialRevenue += row.officialRevenue ?? 0;
        totals.officialFlow += row.officialFlow ?? 0;
        totals.approvedCount += 1;
        const summary = perFuel[fuelCode];
        if (summary) {
          summary.officialRevenue += row.officialRevenue ?? 0;
          summary.officialFlow += row.officialFlow ?? 0;
          summary.officialTank = h.tankEnd;
        }
      } else {
        totals.pendingRevenue += row.revenue;
        totals.pendingFlow += row.flow;
        totals.pendingCount += 1;
        const summary = perFuel[fuelCode];
        if (summary) {
          summary.pendingRevenue += row.revenue;
          summary.pendingFlow += row.flow;
        }
      }
    }

    const summary = perFuel[fuelCode];
    if (summary && summary.officialTank === null) summary.officialTank = config.baseTank;
  }

  rows.sort(
    (a, b) => b.date.localeCompare(a.date) || SHIFT_ORDER[b.shift] - SHIFT_ORDER[a.shift]
  );

  totals.officialRevenue = round3(totals.officialRevenue);
  totals.pendingRevenue = round3(totals.pendingRevenue);
  totals.officialFlow = round3(totals.officialFlow);
  totals.pendingFlow = round3(totals.pendingFlow);

  return { rows, totals, perFuel, cache, generatedAt: Date.now() };
}
