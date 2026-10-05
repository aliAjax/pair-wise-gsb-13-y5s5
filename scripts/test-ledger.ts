/* eslint-disable no-console */
// 端到端自检：node 环境用内存 localStorage 垫片，直接驱动 Pinia store。
import { createPinia, setActivePinia } from "pinia";
import { useHandoverStore } from "../src/store/handoverStore";
import type { HandoverDraft } from "../src/store/handoverStore";

// ---- localStorage 垫片 ----
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  get size() { return this.m.size; }
  keys() { return [...this.m.keys()]; }
}
const storage = new MemStorage();
(globalThis as any).localStorage = storage;

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}`, extra ?? "");
  }
}

function draft(partial: Partial<HandoverDraft> & { fuel: string; date: string; shift: HandoverDraft["shift"] }): HandoverDraft {
  return {
    handoverId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    operator: "测试员",
    meterStart: 0,
    meterEnd: 100,
    tankEnd: 1000,
    delivery: 0,
    cash: 100,
    digital: 200,
    notes: "",
    ...partial
  };
}

async function main() {
  setActivePinia(createPinia());
  let store = useHandoverStore();

  console.log("1) 种子数据：待复核不计入正式账");
  const seedApproved = store.handovers.filter((h) => h.status === "approved");
  const seedPending = store.handovers.filter((h) => h.status === "pending");
  const t0 = store.getLedger().totals;
  const expectedRevenue = seedApproved.reduce((s, h) => s + h.cash + h.digital, 0);
  check("正式总收入只含已复核", Math.abs(t0.officialRevenue - expectedRevenue) < 1e-6, { got: t0.officialRevenue, expected: expectedRevenue });
  const pendingRevenue = seedPending.reduce((s, h) => s + h.cash + h.digital, 0);
  check("待复核收入单列", Math.abs(t0.pendingRevenue - pendingRevenue) < 1e-6);
  check("已复核/待复核计数", t0.approvedCount === seedApproved.length && t0.pendingCount === seedPending.length);

  console.log("2) 行级缓存：改现金只重算本行；改罐存/读数则本行+下游重算");
  store.getLedger(); // warm
  const rowsBefore = store.getLedger().rows;
  const target = store.handovers.find((h) => h.handoverId === "s92-04a")!;
  target.cash += 500;
  store._buildLedger();
  const afterCash = new Map(store.getLedger().rows.map((r) => [r.handoverId, r]));
  check("现金变化：本行重算", afterCash.get("s92-04a")!.reused === false);
  check("现金变化：下游罐存锚点未变，保留上次结果", afterCash.get("s92-04b")!.reused === true);
  check("现金变化：其它油品保留", afterCash.get("s95-04a")!.reused === true && afterCash.get("s0-04c")!.reused === true);
  check("现金变化体现在本行收入差异", Math.abs(afterCash.get("s92-04a")!.moneyDiff - (rowsBefore.find((r) => r.handoverId === "s92-04a")!.moneyDiff + 500)) < 1e-9);
  target.cash -= 500;

  // 罐存读数变化：本行账面/差异与下游起始罐存都受影响
  store._buildLedger();
  target.tankEnd -= 300;
  store._buildLedger();
  const afterTank = new Map(store.getLedger().rows.map((r) => [r.handoverId, r]));
  check("罐存变化：本行重算", afterTank.get("s92-04a")!.reused === false);
  check("罐存变化：同油品下一班重算（起始罐存=上一班实测）", afterTank.get("s92-04b")!.reused === false);
  check("罐存变化：再下一班不重算（其起始罐存来自 04b 自己的实测值）", afterTank.get("s92-04c")!.reused === true);
  check("罐存变化：次日早班同样不受影响（每班都有自己的实测读数）", afterTank.get("s92-05a")!.reused === true);
  check("罐存变化：紧邻下游起始罐存跟着变", Math.abs(afterTank.get("s92-04b")!.trialOpen - (rowsBefore.find((r) => r.handoverId === "s92-04b")!.trialOpen - 300)) < 1e-9);
  check("罐存变化：紧邻下游罐存差异跟着变", Math.abs(afterTank.get("s92-04b")!.tankDiff - (rowsBefore.find((r) => r.handoverId === "s92-04b")!.tankDiff + 300)) < 1e-9);
  check("其它油品仍保留上次结果", afterTank.get("s95-04a")!.reused === true && afterTank.get("s0-04c")!.reused === true);

  // 流量计读数变化：销量变了，账面罐存级联影响紧邻下一班
  target.meterEnd -= 120;
  store._buildLedger();
  const afterMeter = new Map(store.getLedger().rows.map((r) => [r.handoverId, r]));
  check("读数变化：本行销量重算", Math.abs(afterMeter.get("s92-04a")!.flow - 3480) < 1e-9);
  check("读数变化：紧邻下一班读数衔接出现差值", (afterMeter.get("s92-04b")!.meterJump ?? 0) !== 0);
  target.meterEnd += 120;
  target.tankEnd += 300;

  console.log("3) 重复补录：相同幂等键只算一次");
  const key = crypto.randomUUID();
  const d1 = draft({ idempotencyKey: key, fuel: "0", date: "2026-10-05", shift: "早班" });
  const r1 = await store.submitDraft(d1);
  const countAfter1 = store.handovers.length;
  const d2 = { ...draft({ idempotencyKey: key, fuel: "0", date: "2026-10-05", shift: "早班" }), handoverId: crypto.randomUUID(), cash: 99999 };
  const r2 = await store.submitDraft(d2);
  check("首次提交 applied", r1.type === "applied");
  check("重复提交识别为 duplicate", r2.type === "applied" && (r2 as any).duplicate === true);
  check("只入了一张单", store.handovers.length === countAfter1);
  const stored = store.handovers.find((h) => h.idempotencyKey === key)!;
  check("重复提交未覆盖原数值", stored.cash === 100);

  console.log("4) 两名值班员同槽位：后到者保留输入并看到冲突，先来者不动");
  const a = draft({ operator: "值班员甲", fuel: "95", date: "2026-10-05", shift: "中班", tankEnd: 5000, cash: 100, digital: 200 });
  const b = draft({ operator: "值班员乙", fuel: "95", date: "2026-10-05", shift: "中班", tankEnd: 4800, cash: 90, digital: 210 });
  await store.submitDraft(a);
  const rb = await store.submitDraft(b);
  check("后到者收到 conflict", rb.type === "conflict");
  check("冲突列表保留后到者完整输入", store.conflicts.length === 1 && store.conflicts[0].incoming.tankEnd === 4800 && store.conflicts[0].operator === "值班员乙");
  const first = store.handovers.find((h) => h.fuel === "95" && h.date === "2026-10-05" && h.shift === "中班")!;
  check("先来者数据未被覆盖", first.tankEnd === 5000 && first.cash === 100 && first.version === 1);

  console.log("5) 冲突裁决：后到者覆盖（版本号递增，冲突关闭）");
  await store.resolveConflict(store.conflicts[0].slot, "force");
  const replaced = store.handovers.find((h) => h.fuel === "95" && h.date === "2026-10-05" && h.shift === "中班")!;
  check("覆盖为后到者数据", replaced.tankEnd === 4800 && replaced.cash === 90);
  check("版本号递增（乐观锁）", replaced.version === 2);
  check("冲突记录关闭", store.conflicts.length === 0);

  console.log("6a) 写入失败（临时区落盘前）：等于什么都没发生，内存/磁盘都无半套，可整张重交");
  store.failPreWrite = 1;
  const dFail = draft({ fuel: "92", date: "2026-10-05", shift: "晚班", tankEnd: 6000, cash: 50, digital: 60 });
  const rFail = await store.submitDraft(dFail);
  check("提交返回 failed 且非耐久", rFail.type === "failed" && rFail.durable === false);
  check("队列为空、单据不可见", store.queue.length === 0 && !store.handovers.some((h) => h.idempotencyKey === dFail.idempotencyKey));
  check("正式总收入未被污染", store.getLedger().totals.officialRevenue === expectedRevenue);
  check("磁盘快照干净、无 tmp 残留", JSON.parse(storage.getItem("dfwlfront-7-ledger-v2")!).queue.length === 0 && !storage.keys().includes("dfwlfront-7-ledger-v2:tmp"));
  const rRetry = await store.submitDraft({ ...dFail, handoverId: crypto.randomUUID() });
  check("重试成功入账", rRetry.type === "applied");

  console.log("6b) 写入中断（临时区已落盘、入队已耐久、应用未提交）：提升 tmp，从断点继续");
  const dResume = draft({ fuel: "0", date: "2026-10-05", shift: "晚班", tankEnd: 4100, cash: 70, digital: 80 });
  // 在线路径上复现：故障打在应用提交点（入队那步已成功）
  store.failNext = 1;
  const rDurable = await store.submitDraft(dResume);
  check("提交返回 failed 但已耐久", rDurable.type === "failed" && rDurable.durable === true);
  check("操作已在 outbox 等待", store.queue.length === 1 && store.queue[0].kind === "upsert");
  check("单据尚未应用（无半套数字）", !store.handovers.some((h) => h.idempotencyKey === dResume.idempotencyKey));
  check("耐久快照（提升后的正式快照）已含该操作", JSON.parse(storage.getItem("dfwlfront-7-ledger-v2")!).queue.length === 1);
  check("无 tmp 残留", !storage.keys().includes("dfwlfront-7-ledger-v2:tmp"));

  // 续做时存储完全不可用（tmp 也写不成）：操作仍在队列，不留半套
  store.failPreWrite = 1;
  await store.resumeQueue().catch(() => {});
  check("续做遇存储不可用，操作仍在队列", store.queue.length === 1);
  check("单据仍未应用", !store.handovers.some((h) => h.idempotencyKey === dResume.idempotencyKey));

  await store.resumeQueue();
  check("再次从断点继续后队列出清", store.queue.length === 0);
  check("单据完整入账（只有一次）", store.handovers.filter((h) => h.idempotencyKey === dResume.idempotencyKey).length === 1);
  const rIdem = await store.submitDraft({ ...dResume, handoverId: crypto.randomUUID() });
  check("续做后再交仍是幂等去重", (rIdem as any).duplicate === true);
  check("没有出现第二张同槽位单", store.handovers.filter((h) => h.fuel === "0" && h.date === "2026-10-05" && h.shift === "晚班").length === 1);

  console.log("6c) 崩溃在 tmp 已写、正式指针未切换：重启以较新 tmp 为准");
  const dCrash = draft({ fuel: "0", date: "2026-10-05", shift: "中班", tankEnd: 4000, cash: 11, digital: 22 });
  const diskNow = JSON.parse(storage.getItem("dfwlfront-7-ledger-v2")!);
  storage.setItem(
    "dfwlfront-7-ledger-v2:tmp",
    JSON.stringify({
      ...diskNow,
      seq: diskNow.seq + 1,
      handovers: [...store.handovers, { ...dCrash, notes: "", status: "pending", version: 1 }],
      queue: []
    })
  );
  setActivePinia(createPinia());
  const storeCrash = useHandoverStore();
  check("重启时以较新的 tmp 为准继续", storeCrash.handovers.some((h) => h.handoverId === dCrash.handoverId));
  check("tmp 已转正并清理", !storage.keys().includes("dfwlfront-7-ledger-v2:tmp"));

  // 后续复核用例在最新快照对应的 store 上继续
  store = storeCrash;

  console.log("7) 复核通过前销量不入正式账/起始罐存，通过后才并入");
  const pending95 = store.handovers.find((h) => h.fuel === "95" && h.date === "2026-10-05" && h.shift === "中班")!;
  const ledgerBefore = store.getLedger();
  const row95 = ledgerBefore.rows.find((r) => r.handoverId === pending95.handoverId)!;
  check("待复核行无正式起始罐存", row95.officialOpen === null && row95.officialRevenue === null);
  const officialBefore = ledgerBefore.totals.officialRevenue;
  await store.approve(pending95.handoverId);
  const ledgerAfter = store.getLedger();
  const row95b = ledgerAfter.rows.find((r) => r.handoverId === pending95.handoverId)!;
  check("复核后正式起始罐存在锚点链上", row95b.officialOpen !== null);
  const add = pending95.cash + pending95.digital;
  check("正式收入并入该班", Math.abs(ledgerAfter.totals.officialRevenue - (officialBefore + add)) < 1e-6);
  check("待复核收入相应减少", Math.abs(ledgerAfter.totals.pendingRevenue - (ledgerBefore.totals.pendingRevenue - add)) < 1e-6);

  console.log("8) 刷新恢复：模拟重新从 localStorage 引导（含崩溃在 tmp 之后）");
  setActivePinia(createPinia());
  const store3 = useHandoverStore();
  check("重启后数据一致", store3.handovers.length === store.handovers.length);
  check("重启后队列为空", store3.queue.length === 0);
  check("重启后正式收入一致", Math.abs(store3.getLedger().totals.officialRevenue - ledgerAfter.totals.officialRevenue) < 1e-9);

  if (failures) {
    console.error(`\n${failures} 项检查失败`);
    process.exit(1);
  }
  console.log("\n全部检查通过 ✅");
}

main().catch((e) => { console.error(e); process.exit(1); });
