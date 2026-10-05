import type { HandoverInput, HandoverLine, Product, ShiftName } from "./types";

export const PRODUCTS: Product[] = [
  { code: "92", name: "92#汽油", price: 7.65 },
  { code: "95", name: "95#汽油", price: 8.18 },
  { code: "0", name: "0#柴油", price: 7.32 }
];

export const SHIFTS: ShiftName[] = ["早班", "中班", "晚班"];
export const SHIFT_INDEX: Record<ShiftName, number> = { 早班: 0, 中班: 1, 晚班: 2 };

export const OPERATORS = ["张伟", "李娜", "王强", "赵敏"];

/** 量罐差异容忍值（L），超过则标“有差异” */
export const VOLUME_TOLERANCE = 20;
/** 收款差异容忍值（元） */
export const PAYMENT_TOLERANCE = 10;

export function natKeyOf(date: string, shift: ShiftName): string {
  return `${date}#${shift}`;
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function money(n: number): string {
  return `¥${round2(n).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function liters(n: number): string {
  return `${round2(n).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} L`;
}

export function uid(prefix = "id"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/** 按 日期升序、班次升序 排列（罐存链顺序） */
export function chainCompare(a: { date: string; shift: ShiftName }, b: { date: string; shift: ShiftName }): number {
  return a.date.localeCompare(b.date) || SHIFT_INDEX[a.shift] - SHIFT_INDEX[b.shift];
}

export function blankLines(): HandoverLine[] {
  return PRODUCTS.map((p) => ({
    code: p.code,
    pumpStart: 0,
    pumpEnd: 0,
    tankStart: 0,
    tankEnd: 0,
    delivery: 0
  }));
}

export function blankInput(): HandoverInput {
  return {
    date: new Date().toISOString().slice(0, 10),
    shift: "早班",
    operator: OPERATORS[0],
    cash: 0,
    digital: 0,
    lines: blankLines(),
    notes: "",
    source: "online"
  };
}

/** 本班次自有输入签名：现金、电子支付、泵码/罐存读数任一变化都会改变 */
export function ownSignature(input: Pick<HandoverInput, "cash" | "digital" | "lines">): string {
  const lines = input.lines
    .map((l) => [l.code, l.pumpStart, l.pumpEnd, l.tankStart, l.tankEnd, l.delivery].join(":"))
    .join("|");
  return `own:${input.cash}:${input.digital}:${lines}`;
}

/** 判断两次输入是否为同一套业务数字（备注差异不触发重算/不重置复核） */
export function sameNumbers(a: HandoverInput, b: HandoverInput): boolean {
  if (a.cash !== b.cash || a.digital !== b.digital || a.lines.length !== b.lines.length) return false;
  return a.lines.every((la, i) => {
    const lb = b.lines[i];
    return (
      la.code === lb.code &&
      la.pumpStart === lb.pumpStart &&
      la.pumpEnd === lb.pumpEnd &&
      la.tankStart === lb.tankStart &&
      la.tankEnd === lb.tankEnd &&
      la.delivery === lb.delivery
    );
  });
}

export function priceOf(code: string): number {
  return PRODUCTS.find((p) => p.code === code)?.price ?? 0;
}

/** 表单校验，返回错误信息（通过返回 null） */
export function validateInput(input: HandoverInput): string | null {
  if (!input.date) return "请选择交接日期";
  if (!input.operator.trim()) return "请填写值班员";
  if (input.cash < 0 || input.digital < 0) return "现金与电子支付不能为负";
  for (const l of input.lines) {
    if (l.pumpEnd < l.pumpStart) return `${l.code}# 泵码止数不能小于起数`;
    if (l.tankEnd < 0 || l.tankStart < 0 || l.delivery < 0) return `${l.code}# 罐存读数不能为负`;
  }
  return null;
}
