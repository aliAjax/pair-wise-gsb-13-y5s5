import type { Handover, HandoverInput, HandoverLine, ReviewStatus } from "../types";

// 演示账期：2026-10-03 三个班 + 10-04 三个班 + 10-05 早班
const DATES_SHIFTS: { date: string; shift: Handover["shift"] }[] = [
  { date: "2026-10-03", shift: "早班" },
  { date: "2026-10-03", shift: "中班" },
  { date: "2026-10-03", shift: "晚班" },
  { date: "2026-10-04", shift: "早班" },
  { date: "2026-10-04", shift: "中班" },
  { date: "2026-10-04", shift: "晚班" },
  { date: "2026-10-05", shift: "早班" }
];

const OPERATORS = ["张伟", "李娜", "王强", "赵敏", "张伟", "李娜", "王强"];

/** 每品：初始罐存、本班配送、泵码销量、罐存销量（晚班 92# 故意差 100L） */
interface ProductPlan {
  init: number;
  delivery: number[];
  pump: number[];
  tank: number[];
  price: number;
}

const PLAN: Record<string, ProductPlan> = {
  "92": {
    init: 18000,
    delivery: [0, 0, 12000, 0, 0, 0, 0],
    pump: [2360, 1980, 2240, 2110, 1870, 2460, 1955],
    tank: [2360, 1980, 2240, 2110, 1870, 2360, 1955],
    price: 7.65
  },
  "95": {
    init: 12000,
    delivery: [0, 0, 0, 0, 0, 0, 0],
    pump: [1240, 1080, 1320, 1190, 1050, 1380, 1120],
    tank: [1240, 1080, 1320, 1190, 1050, 1380, 1120],
    price: 8.18
  },
  "0": {
    init: 9000,
    delivery: [0, 0, 0, 0, 15000, 0, 0],
    pump: [860, 720, 910, 780, 690, 940, 760],
    tank: [860, 720, 910, 780, 690, 940, 760],
    price: 7.32
  }
};

function buildLines(idx: number): HandoverLine[] {
  return Object.entries(PLAN).map(([code, p]) => {
    const pumpStart = p.pump.slice(0, idx).reduce((a, b) => a + b, 0);
    const pumpSales = p.pump[idx];
    const tankEnd =
      p.init + p.delivery.slice(0, idx + 1).reduce((a, b) => a + b, 0) -
      p.tank.slice(0, idx + 1).reduce((a, b) => a + b, 0);
    const tankStart =
      p.init + p.delivery.slice(0, idx).reduce((a, b) => a + b, 0) -
      p.tank.slice(0, idx).reduce((a, b) => a + b, 0);
    return {
      code,
      pumpStart,
      pumpEnd: pumpStart + pumpSales,
      tankStart,
      tankEnd,
      delivery: p.delivery[idx]
    };
  });
}

/** idx=3（10-04 早班）埋一笔 80 元短款；其余班账款相符 */
function moneyFor(idx: number, lines: HandoverLine[]): { cash: number; digital: number } {
  // 逐品按销量取整收款，避免取整噪音造成“假差异”
  const expected = lines.reduce((s, l) => {
    const sales = l.pumpEnd - l.pumpStart;
    return s + Math.round(sales * (PLAN[l.code]?.price ?? 0));
  }, 0);
  const actual = idx === 3 ? expected - 80 : expected;
  const cash = Math.round(actual * 0.28);
  return { cash, digital: actual - cash };
}

export function seedRecords(): Handover[] {
  return DATES_SHIFTS.map((ds, idx) => {
    const lines = buildLines(idx);
    const { cash, digital } = moneyFor(idx, lines);
    const status: ReviewStatus = idx < 4 ? "approved" : "pending";
    const iso = (hour: number) =>
      new Date(`${ds.date}T${String(hour).padStart(2, "0")}:05:00`).toISOString();
    const startHour = ds.shift === "早班" ? 6 : ds.shift === "中班" ? 14 : 22;
    const notes =
      idx === 3
        ? "对账少 80 元，站长核查中"
        : idx === 5
          ? "92# 量罐比泵码少 100L，待复核"
          : status === "approved"
            ? "账实一致"
            : "断网补录，等待早班同步复核";
    return {
      id: `seed-${idx + 1}`,
      natKey: `${ds.date}#${ds.shift}`,
      date: ds.date,
      shift: ds.shift,
      operator: OPERATORS[idx],
      cash,
      digital,
      lines,
      notes,
      status,
      source: idx >= 4 ? "backfill" : "online",
      version: 1,
      createdAt: iso(startHour),
      updatedAt: iso(startHour + 1),
      firstSubmitId: `seed-txn-${idx + 1}`
    };
  });
}

/** 模拟“另一名值班员”在同一班次先提交的数据（并发冲突演示） */
export function peerInput(base: HandoverInput): HandoverInput {
  return {
    ...base,
    operator: OPERATORS[1],
    cash: Math.max(0, Math.round(base.cash + 150)),
    digital: Math.max(0, base.digital - 150),
    lines: base.lines.map((l) => ({ ...l, tankEnd: Math.max(0, l.tankEnd - 30) })),
    notes: "另一名值班员的交接读数（先到）",
    source: "online"
  };
}
