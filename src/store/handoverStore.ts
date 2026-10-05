// 交接单仓储：幂等去重、乐观锁冲突、outbox 断点续传、原子提交
//
// 提交链路（两次独立持久化，保证不留下半套数字）：
//   1) 入队：把操作写入 outbox 并落盘；这一步失败等于没发生，可整张单重交；
//   2) 应用：在同一份快照里完成「改数据 + 标记操作完成」，通过 tmp -> 指针提交
//      原子切换；这一步失败则内存状态不变、操作留在队列，刷新或点「从断点继续」
//      后重做（upsert 幂等，重复补录只算一次）。

import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { buildLedger } from "../domain/ledger";
import {
  type FuelConfig,
  type HandoverInput,
  type LedgerResult,
  type ReviewStatus
} from "../domain/types";

export interface HandoverDraft {
  handoverId: string;
  idempotencyKey: string;
  operator: string;
  fuel: string;
  date: string;
  shift: HandoverInput["shift"];
  meterStart: number;
  meterEnd: number;
  tankEnd: number;
  delivery: number;
  cash: number;
  digital: number;
  notes?: string;
}

export interface ConflictRecord {
  slot: string; // 油品|日期|班次
  /** 后到的值班员：其输入原样保留，覆盖/放弃由其本人决定 */
  operator: string;
  existing: HandoverInput;
  incoming: HandoverDraft;
  at: number;
}

export interface OutboxOp {
  opId: string;
  kind: "upsert" | "replace" | "approve";
  createdAt: number;
  attempts: number;
  /** replace/upsert 携带整单，approve 携带 handoverId */
  draft?: HandoverDraft;
  targetId?: string;
}

interface Snapshot {
  version: 1;
  seq: number;
  handovers: HandoverInput[];
  conflicts: ConflictRecord[];
  queue: OutboxOp[];
}

const SNAP_KEY = "dfwlfront-7-ledger-v2";
const TMP_KEY = SNAP_KEY + ":tmp";

export const FUEL_CONFIGS: FuelConfig[] = [
  { code: "92", name: "92#汽油", price: 7.62, baseMeter: 120000, baseTank: 18000 },
  { code: "95", name: "95#汽油", price: 8.15, baseMeter: 80000, baseTank: 12000 },
  { code: "0", name: "0#柴油", price: 7.28, baseMeter: 60000, baseTank: 15000 }
];

export function slotKey(fuel: string, date: string, shift: string): string {
  return `${fuel}|${date}|${shift}`;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function seed(): Snapshot {
  // 10-04 三班均已复核；10-05 早班待复核（列表先标待复核，暂不计入正式账）
  const mk = (
    id: string,
    fuel: string,
    date: string,
    shift: HandoverInput["shift"],
    meterStart: number,
    meterEnd: number,
    tankEnd: number,
    delivery: number,
    cash: number,
    digital: number,
    status: ReviewStatus,
    notes = ""
  ): HandoverInput => ({
    handoverId: id,
    idempotencyKey: `seed-${id}`,
    fuel,
    date,
    shift,
    meterStart,
    meterEnd,
    tankEnd,
    delivery,
    cash,
    digital,
    notes,
    status,
    version: 1
  });

  return {
    version: 1,
    seq: 1,
    queue: [],
    conflicts: [],
    handovers: [
      mk("s92-04a", "92", "2026-10-04", "早班", 120000, 123600, 14380, 0, 8200, 19240, "approved", "账实一致"),
      mk("s92-04b", "92", "2026-10-04", "中班", 123600, 127050, 18900, 8000, 7600, 18700, "approved", "油品入库8000L"),
      mk("s92-04c", "92", "2026-10-04", "晚班", 127050, 130180, 15795, 0, 7100, 16780, "approved"),
      mk("s92-05a", "92", "2026-10-05", "早班", 130180, 133720, 12230, 0, 7900, 19100, "pending", "断网补录，待站长复核"),

      mk("s95-04a", "95", "2026-10-04", "早班", 80000, 82100, 9900, 0, 5900, 11150, "approved"),
      mk("s95-04b", "95", "2026-10-04", "中班", 82100, 84350, 7660, 0, 6200, 12080, "approved"),
      mk("s95-04c", "95", "2026-10-04", "晚班", 84350, 86200, 5800, 0, 5200, 9820, "approved"),
      mk("s95-05a", "95", "2026-10-05", "早班", 86200, 88420, 3565, 0, 5600, 12500, "pending", "补录待复核"),

      mk("s0-04a", "0", "2026-10-04", "早班", 60000, 62800, 12220, 0, 6800, 13560, "approved"),
      mk("s0-04b", "0", "2026-10-04", "中班", 62800, 65100, 9905, 0, 5400, 11300, "approved"),
      mk("s0-04c", "0", "2026-10-04", "晚班", 65100, 67600, 7405, 0, 6100, 12080, "approved")
    ]
  };
}

function parseSnapshot(raw: string | null): Snapshot | null {
  if (!raw) return null;
  try {
    const snap = JSON.parse(raw) as Snapshot;
    if (!snap || snap.version !== 1 || !Array.isArray(snap.handovers)) return null;
    return snap;
  } catch {
    return null;
  }
}

/** 启动时恢复：tmp 比正式快照新，说明上次在提交点之后崩溃 —— 以 tmp 为准继续 */
function recoverSnapshot(): Snapshot {
  const main = parseSnapshot(localStorage.getItem(SNAP_KEY));
  const tmp = parseSnapshot(localStorage.getItem(TMP_KEY));
  if (tmp && (!main || tmp.seq >= main.seq)) {
    localStorage.setItem(SNAP_KEY, JSON.stringify(tmp));
    localStorage.removeItem(TMP_KEY);
    return tmp;
  }
  if (main) {
    localStorage.removeItem(TMP_KEY);
    return main;
  }
  const fresh = seed();
  localStorage.setItem(SNAP_KEY, JSON.stringify(fresh));
  return fresh;
}

function draftToInput(draft: HandoverDraft, status: ReviewStatus, version: number): HandoverInput {
  const { handoverId, idempotencyKey, operator: _operator, ...fields } = draft;
  return { handoverId, idempotencyKey, ...fields, status, version, notes: draft.notes ?? "" };
}

/** 纯函数：把一个 outbox 操作应用到快照（不碰存储，便于原子提交与重试） */
function applyOp(snap: Snapshot, op: OutboxOp): Snapshot {
  const handovers = snap.handovers.map((h) => ({ ...h }));
  let conflicts = snap.conflicts.map((c) => ({ ...c }));
  let replacedSlot: string | null = null;

  if (op.kind === "approve" && op.targetId) {
    const target = handovers.find((h) => h.handoverId === op.targetId);
    if (target && target.status !== "approved") {
      target.status = "approved";
      target.version += 1;
    }
  } else if (op.draft) {
    const d = op.draft;
    const idx = handovers.findIndex((h) => h.handoverId === d.handoverId);
    const slot = slotKey(d.fuel, d.date, d.shift);
    const slotIdx = handovers.findIndex(
      (h) => slotKey(h.fuel, h.date, h.shift) === slot
    );
    if (op.kind === "replace") {
      if (slotIdx >= 0) {
        const prev = handovers[slotIdx];
        handovers[slotIdx] = draftToInput(d, prev.status, prev.version + 1);
      } else if (idx >= 0) {
        handovers[idx] = draftToInput(d, "pending", 1);
      } else {
        handovers.push(draftToInput(d, "pending", 1));
      }
      replacedSlot = slot;
    } else if (idx >= 0) {
      // upsert 幂等：同 handoverId 已存在则保持原值（重复补录只算一次）
    } else {
      handovers.push(draftToInput(d, "pending", 1));
    }
  }

  // 替换落账后，该槽位的待裁决冲突随之关闭（断点重做时同样生效）
  if (replacedSlot) {
    conflicts = conflicts.filter((c) => c.slot !== replacedSlot);
  }

  return { ...snap, handovers, conflicts };
}

export type SubmitOutcome =
  | { type: "applied"; duplicate?: boolean }
  | { type: "conflict"; slot: string }
  | { type: "failed"; error: string; durable: boolean };

export const useHandoverStore = defineStore("handover", () => {
  const initial = recoverSnapshot();
  const handovers = ref<HandoverInput[]>(initial.handovers);
  const conflicts = ref<ConflictRecord[]>(initial.conflicts);
  const queue = ref<OutboxOp[]>(initial.queue);
  const seq = ref(initial.seq);
  const writing = ref(false);
  const lastError = ref("");

  /** 故障注入：剩余 N 次提交在「tmp 已写、正式指针未切」时失败，模拟断网写库失败 */
  const failNext = ref(0);
  /** 故障注入：剩余 N 次提交在 tmp 写入之前失败，模拟存储整体不可用 */
  const failPreWrite = ref(0);
  const configs = FUEL_CONFIGS;

  let ledger: LedgerResult = buildLedger(handovers.value, configs);
  const ledgerVersion = ref(0);
  const getLedger = () => ledger;
  const bump = () => {
    ledger = buildLedger(handovers.value, configs, ledger.cache);
    ledgerVersion.value += 1;
  };
  bump();

  function currentSnapshot(): Snapshot {
    return {
      version: 1,
      seq: seq.value,
      handovers: handovers.value,
      conflicts: conflicts.value,
      queue: queue.value
    };
  }

  /**
   * 提交失败后与磁盘重新对齐，保证内存里没有半套数字：
   * - tmp 已完整落盘：与「崩溃在提交点之后」同语义，提升为正式快照（该步骤视为已完成）；
   * - tmp 没写成（存储在写入前就不可用）：回退到上一份正式快照，等于这一步没做。
   * 返回 true 表示提升了 tmp。
   */
  function reconcileFromStorage(): boolean {
    const tmp = parseSnapshot(localStorage.getItem(TMP_KEY));
    const snap = tmp ?? parseSnapshot(localStorage.getItem(SNAP_KEY)) ?? seed();
    if (tmp) {
      localStorage.setItem(SNAP_KEY, JSON.stringify(tmp));
      localStorage.removeItem(TMP_KEY);
    } else {
      localStorage.removeItem(TMP_KEY);
    }
    seq.value = snap.seq;
    handovers.value = snap.handovers;
    conflicts.value = snap.conflicts;
    queue.value = snap.queue;
    bump();
    return !!tmp;
  }

  /** tmp -> 正式指针 的原子切换；失败点可注入 */
  async function commitSnapshot(next: Snapshot) {
    // 故障注入：存储在写入前就不可用（隐私模式/配额耗尽），tmp 也写不成
    if (failPreWrite.value > 0) {
      failPreWrite.value -= 1;
      throw new Error("写入失败（模拟存储不可用）：临时区未能落盘，本次操作等于未发生");
    }
    const payload = JSON.stringify(next);
    localStorage.setItem(TMP_KEY, payload); // 断点：临时区已落盘
    await delay(120);
    if (failNext.value > 0) {
      failNext.value -= 1;
      throw new Error("写入失败（模拟断网/存储不可用）：临时区已保存，正式账未切换");
    }
    localStorage.setItem(SNAP_KEY, payload); // 提交点
    localStorage.removeItem(TMP_KEY);
  }

  async function commit(next: Snapshot): Promise<void> {
    writing.value = true;
    try {
      await commitSnapshot(next);
      seq.value = next.seq;
      handovers.value = next.handovers;
      conflicts.value = next.conflicts;
      queue.value = next.queue;
      lastError.value = "";
      bump();
    } catch (e) {
      // tmp 已落盘则提升（该步视为完成）；否则回退到上一份正式快照
      const promoted = reconcileFromStorage();
      throw Object.assign(e as Error, { promoted });
    } finally {
      writing.value = false;
    }
  }

  /** 步骤 1：操作耐久入队（入队失败 = 什么都没发生，可整张重交） */
  async function enqueue(op: Omit<OutboxOp, "attempts" | "createdAt">) {
    const full: OutboxOp = { ...op, attempts: 0, createdAt: Date.now() };
    const next: Snapshot = {
      ...currentSnapshot(),
      seq: seq.value + 1,
      queue: [...queue.value, full]
    };
    await commit(next);
    return full;
  }

  /** 步骤 2：应用队首操作并在同一快照里出队（原子，不留半套数字） */
  async function processOne(op: OutboxOp) {
    const base = currentSnapshot();
    const applied = applyOp(base, op);
    const next: Snapshot = {
      ...applied,
      seq: base.seq + 1,
      queue: base.queue.filter((q) => q.opId !== op.opId)
    };
    await commit(next);
  }

  /** 从断点继续：依次重做仍在队列中的操作（幂等，重复重做不出两遍数） */
  async function resumeQueue() {
    for (const op of [...queue.value]) {
      await processOne({ ...op, attempts: op.attempts + 1 });
    }
  }

  async function runOp(op: Omit<OutboxOp, "attempts" | "createdAt">) {
    let full: OutboxOp;
    try {
      full = await enqueue(op);
    } catch (e) {
      // 入队 tmp 已落盘并提升 → 操作在 outbox，等待「从断点继续」；
      // tmp 没写成 → 本次等于未发生，可整张重交。
      const promoted = (e as Error & { promoted?: boolean }).promoted ?? false;
      lastError.value = (e as Error).message;
      return { type: "failed" as const, error: (e as Error).message, durable: promoted };
    }
    try {
      await processOne(full);
      return { type: "applied" as const };
    } catch (e) {
      // 应用 tmp 已落盘并提升：数据已完整应用、操作已出队，实质成功；
      // tmp 没写成：操作还在 outbox，等「从断点继续」。
      const promoted = (e as Error & { promoted?: boolean }).promoted ?? false;
      const durable = queue.value.some((q) => q.opId === full.opId);
      lastError.value = (e as Error).message;
      if (promoted || !durable) {
        bump();
        return { type: "applied" as const };
      }
      return { type: "failed" as const, error: (e as Error).message, durable: true };
    }
  }

  function findByIdempotency(key: string) {
    return handovers.value.find((h) => h.idempotencyKey === key);
  }

  /**
   * 提交交接单。
   * - 幂等键相同：重复补录只算一次；
   * - 同槽位（油品+日期+班次）已有单且键不同：后到者输入保留为冲突，不覆盖前单。
   */
  async function submitDraft(draft: HandoverDraft): Promise<SubmitOutcome> {
    if (findByIdempotency(draft.idempotencyKey)) {
      return { type: "applied", duplicate: true };
    }
    const slot = slotKey(draft.fuel, draft.date, draft.shift);
    const existing = handovers.value.find(
      (h) => slotKey(h.fuel, h.date, h.shift) === slot
    );
    if (existing) {
      // 保留后到者输入；若同一后到者连续提交，更新其待裁决草稿
      const others = conflicts.value.filter((c) => c.slot !== slot);
      const next: Snapshot = {
        ...currentSnapshot(),
        seq: seq.value + 1,
        conflicts: [...others, { slot, operator: draft.operator, existing, incoming: draft, at: Date.now() }]
      };
      await commit(next);
      return { type: "conflict", slot };
    }
    const r = await runOp({ opId: crypto.randomUUID(), kind: "upsert", draft });
    return r.type === "failed"
      ? { type: "failed", error: r.error, durable: r.durable }
      : { type: "applied" };
  }

  /** 冲突裁决：后到者覆盖（前单进历史版本）或放弃自己的输入 */
  async function resolveConflict(slot: string, action: "force" | "discard") {
    const conflict = conflicts.value.find((c) => c.slot === slot);
    if (!conflict) return;
    if (action === "discard") {
      const next: Snapshot = {
        ...currentSnapshot(),
        seq: seq.value + 1,
        conflicts: conflicts.value.filter((c) => c.slot !== slot)
      };
      await commit(next);
      return;
    }
    // force：替换操作走标准 outbox 两步（入队耐久 -> 原子应用），
    // 冲突记录在 applyOp 里随替换一并清除，断点重做不会留下半套状态。
    const r = await runOp({ opId: crypto.randomUUID(), kind: "replace", draft: conflict.incoming });
    if (r.type === "failed") {
      lastError.value = r.error;
    }
  }

  async function approve(id: string) {
    return runOp({ opId: crypto.randomUUID(), kind: "approve", targetId: id });
  }

  /** 多标签页同步：另一标签页落盘后，本页重装载并重建（行缓存自然失效/命中） */
  function initCrossTabSync() {
    window.addEventListener("storage", (e) => {
      if (e.key !== SNAP_KEY && e.key !== TMP_KEY) return;
      const snap = recoverSnapshot();
      seq.value = snap.seq;
      handovers.value = snap.handovers;
      conflicts.value = snap.conflicts;
      queue.value = snap.queue;
      bump();
    });
  }

  return {
    configs,
    handovers,
    conflicts,
    queue,
    seq,
    writing,
    lastError,
    failNext,
    failPreWrite,
    ledgerVersion,
    getLedger,
    submitDraft,
    resolveConflict,
    approve,
    resumeQueue,
    initCrossTabSync,
    slotKey,
    // 测试/演示辅助
    _applyOp: applyOp,
    _buildLedger: () => {
      bump();
    },
    pendingCount: computed(() => queue.value.length)
  };
});
