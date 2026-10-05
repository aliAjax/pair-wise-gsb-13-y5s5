import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { PRODUCTS, chainCompare, natKeyOf, uid } from "./domain";
import { reconcile, type ReconcileCache } from "./engine/reconcile";
import { server } from "./engine/server";
import { peerInput, seedRecords } from "./engine/seed";
import type {
  AuditEvent,
  ConflictInfo,
  Handover,
  HandoverInput,
  Notice,
  OutboxItem
} from "./types";

const OUTBOX_KEY = "dfwl7:outbox";
const CACHE_KEY = "dfwl7:reconcile-cache";
const DB_KEY = "dfwl7:server-db";
const APPLIED_STORAGE = "dfwl7:applied-txn";

function loadOutbox(): OutboxItem[] {
  try {
    const raw = localStorage.getItem(OUTBOX_KEY);
    return raw ? (JSON.parse(raw) as OutboxItem[]) : [];
  } catch {
    return [];
  }
}

export const useLedgerStore = defineStore("ledger", () => {
  const records = ref<Handover[]>([]);
  const cache = ref<ReconcileCache>({});
  const outbox = ref<OutboxItem[]>(loadOutbox());
  const online = ref(true);
  const conflict = ref<ConflictInfo | null>(null);
  const editingNatKey = ref<string | null>(null);
  const notices = ref<Notice[]>([]);
  const audit = ref<AuditEvent[]>([]);
  const booted = ref(false);
  const lastRecomputed = ref<string[]>([]);
  /** 编辑/冲突处理后要回填表单的输入；表单组件 watch 它 */
  const formFill = ref<{ token: number; input: HandoverInput; natKey: string | null; baseVersion: number } | null>(
    null
  );

  // ---------- 派生：增量重算 ----------
  const result = computed(() => reconcile(records.value, cache.value, PRODUCTS));
  const orderedRecords = computed<Handover[]>(() => {
    return [...result.value.byNatKey.values()].sort(chainCompare);
  });
  const derivedMap = computed(() => new Map(result.value.derived.map((d) => [d.id, d])));
  const totals = computed(() => {
    const t = result.value.totals;
    t.conflictCount = conflict.value ? 1 : 0;
    return t;
  });

  // 列表先标待复核：待复核/驳回排前面，再按罐存链顺序
  const listedRecords = computed<Handover[]>(() => {
    const rank = (s: Handover["status"]) => (s === "approved" ? 1 : 0);
    return [...orderedRecords.value].sort(
      (a, b) => rank(a.status) - rank(b.status) || chainCompare(a, b)
    );
  });

  const pendingOutbox = computed(() =>
    outbox.value.filter((i) => i.state === "queued" || i.state === "failed" || i.state === "conflict")
  );
  const sendingCount = computed(() => outbox.value.filter((i) => i.state === "sending").length);

  function derivedOf(id: string) {
    return derivedMap.value.get(id);
  }

  // ---------- 通知 / 审计 ----------
  function notify(kind: Notice["kind"], text: string): void {
    notices.value.unshift({ id: uid("n"), kind, text });
    notices.value = notices.value.slice(0, 4);
    setTimeout(() => {
      notices.value = notices.value.filter((n) => n.text !== text);
    }, 6000);
  }

  function log(kind: AuditEvent["kind"], text: string): void {
    audit.value.unshift({ id: uid("a"), time: new Date().toLocaleTimeString("zh-CN"), text, kind });
    audit.value = audit.value.slice(0, 30);
  }

  // ---------- 持久化 ----------
  function persistOutbox(): void {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox.value));
  }

  function refresh(recomputedLog = true): void {
    const prevIds = new Set(Object.keys(cache.value));
    const serverRecords = server.snapshot();
    // 离线影子单（local-xxx）：若同 natKey 的服务端记录已落库则丢弃影子，
    // 否则（仍离线）保留本地影子参与待复核展示，但不进入通过口径
    const serverKeys = new Set(serverRecords.map((r) => r.natKey));
    records.value = [
      ...serverRecords,
      ...records.value.filter((r) => r.id.startsWith("local-") && !serverKeys.has(r.natKey))
    ];
    const r = reconcile(records.value, cache.value, PRODUCTS);
    cache.value = r.cache;
    lastRecomputed.value = r.recomputedIds;
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache.value));
    if (recomputedLog && r.recomputedIds.length) {
      const names = r.recomputedIds
        .map((id) => records.value.find((x) => x.id === id))
        .filter(Boolean)
        .map((x) => `${x!.date} ${x!.shift}`)
        .join("、");
      const reused = prevIds.size ? `${r.derived.length - r.recomputedIds.length} 个班次保留上次结果` : "";
      log("info", `重算 ${r.recomputedIds.length} 个班次（${names}）；${reused}`);
    }
  }

  // ---------- 启动：服务端 WAL 恢复 + 客户端断网箱续传 ----------
  async function init(): Promise<void> {
    if (booted.value) return;
    booted.value = true;

    let cacheRaw: ReconcileCache = {};
    try {
      cacheRaw = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}") as ReconcileCache;
    } catch {
      cacheRaw = {};
    }

    if (!localStorage.getItem(DB_KEY)) {
      log("info", "首次使用：载入演示账期 2026-10-03 至 10-05");
    }
    const recovered = await server.bootstrap();
    cache.value = cacheRaw;
    records.value = server.snapshot();
    // 首次（无缓存）全量建账
    const first = reconcile(records.value, cache.value, PRODUCTS);
    cache.value = first.cache;
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache.value));

    if (recovered.resumed && recovered.wal) {
      const w = recovered.wal;
      log("success", `断点续传完成：${w.action === "submit" ? "补录" : w.action === "approve" ? "复核通过" : "驳回"} ${w.natKey} 已落库`);
      notify("success", "上次写入已从断点继续完成，没有留下半套数字");
      refresh(false);
    }

    // outbox 中上次正在发送/失败的条目：回到排队，稍后自动续传
    let resumed = false;
    outbox.value = outbox.value.map((i) =>
      i.state === "sending" ? ((resumed = true), { ...i, state: "failed", lastError: "页面中断，等待续传" }) : i
    );
    if (resumed) log("warn", "断网箱中有未完成写入，将自动从断点继续");
    persistOutbox();
    if (outbox.value.length) setTimeout(flush, 800);

    window.addEventListener("storage", onStorage);
  }

  function onStorage(e: StorageEvent): void {
    if (e.key === DB_KEY) {
      refresh(false);
      log("info", "检测到另一标签页的写入，已刷新复核账");
    }
  }

  // ---------- 提交交接单（在线直发 / 断网入箱） ----------
  async function submitInput(input: HandoverInput, force = false): Promise<void> {
    const natKey = natKeyOf(input.date, input.shift);
    const existing = records.value.find((r) => r.natKey === natKey);
    const baseVersion = existing?.version ?? 0;
    const item: OutboxItem = {
      txnId: uid("txn"),
      action: "submit",
      natKey,
      input,
      baseVersion,
      force,
      state: "queued",
      attempts: 0,
      lastError: "",
      createdAt: new Date().toISOString()
    };

    // 离线补录：先入断网箱（本地立即可见为待复核），联网后从断点续传
    if (!online.value) {
      outbox.value.unshift(item);
      persistOutbox();
      log(input.source === "backfill" ? "warn" : "info", `${input.source === "backfill" ? "断网补录" : "离线录入"} ${natKey} 已入断网箱`);
      notify("warn", `当前离线：${natKey} 已存入断网箱，联网后自动续传`);
      // 乐观展示：本地生成一条待复核影子记录（id 与 txnId 关联，落库后替换）
      optimisticRecord(item);
      return;
    }

    await processItem(item);
  }

  /** 离线时本地先立一条“待复核”影子单，联网落库后由服务端记录替换 */
  function optimisticRecord(item: OutboxItem): void {
    const input = item.input!;
    const shadow: Handover = {
      id: `local-${item.txnId}`,
      natKey: item.natKey,
      date: input.date,
      shift: input.shift,
      operator: input.operator,
      cash: input.cash,
      digital: input.digital,
      lines: input.lines,
      notes: input.notes,
      status: "pending",
      source: input.source,
      version: item.baseVersion,
      createdAt: item.createdAt,
      updatedAt: item.createdAt,
      firstSubmitId: item.txnId
    };
    const idx = records.value.findIndex((r) => r.natKey === item.natKey);
    if (idx >= 0) records.value[idx] = shadow;
    else records.value = [shadow, ...records.value];
    refresh(false);
  }

  async function review(natKey: string, action: "approve" | "reject"): Promise<void> {
    const existing = records.value.find((r) => r.natKey === natKey);
    if (!existing) return;
    const item: OutboxItem = {
      txnId: uid("txn"),
      action,
      natKey,
      baseVersion: existing.version,
      force: false,
      state: "queued",
      attempts: 0,
      lastError: "",
      createdAt: new Date().toISOString()
    };
    if (!online.value) {
      outbox.value.unshift(item);
      persistOutbox();
      notify("warn", `当前离线：${action === "approve" ? "复核通过" : "驳回"} ${natKey} 已入断网箱`);
      return;
    }
    await processItem(item);
  }

  // ---------- 断网箱处理：失败从断点继续，不留下半套数字 ----------
  async function processItem(item: OutboxItem): Promise<void> {
    const slot = outbox.value.find((i) => i.txnId === item.txnId);
    const live = slot ?? item;
    live.state = "sending";
    live.attempts += 1;
    live.lastError = "";
    if (slot) persistOutbox();

    try {
      let res;
      if (live.action === "submit") {
        res = await server.submit(live.txnId, live.input!, live.baseVersion, live.force);
      } else {
        res = await server.review(live.txnId, live.natKey, live.action);
      }

      if (res.ok) {
        if (slot) {
          slot.state = "done";
          persistOutbox();
          setTimeout(() => {
            outbox.value = outbox.value.filter((i) => i.txnId !== live.txnId);
            persistOutbox();
          }, 1200);
        }
        refresh();
        log("success", `${live.action === "submit" ? "交接单已写入" : live.action === "approve" ? "复核通过" : "已驳回"}：${live.natKey}${res.duplicate ? "（重复补录，只计一次）" : ""}`);
        if (res.duplicate) notify("info", `${live.natKey} 是重复补录，系统只计了一次`);
        else notify("success", `${live.natKey} 写入成功`);
        if (conflict.value?.txnId === live.txnId) conflict.value = null;
        if (editingNatKey.value === live.natKey && live.action === "submit") editingNatKey.value = null;
        return;
      }

      if (res.error === "conflict") {
        // 后到者保留输入：无论在线还是断网箱路径，都把条目（含原始输入）持久化，
        // 刷新页面或稍后处理都不会丢；未选择前不参与自动续传
        live.state = "conflict";
        live.lastError = "两名值班员提交了同一交接单";
        if (!outbox.value.some((i) => i.txnId === live.txnId)) outbox.value.unshift(live);
        persistOutbox();
        // 列表立刻反映先到者已落库的版本
        refresh(false);
        conflict.value = {
          txnId: live.txnId,
          natKey: live.natKey,
          server: res.server!,
          incoming: live.input!,
          baseVersion: live.baseVersion
        };
        log("warn", `并发冲突：${live.natKey} 已被先提交，后到者输入已保留`);
        notify("error", `${live.natKey} 存在并发冲突，请选择保留哪一份`);
        return;
      }

      // offline
      live.state = "failed";
      live.lastError = "网络不可用";
      if (!outbox.value.some((i) => i.txnId === live.txnId)) {
        outbox.value.unshift(live);
        if (live.action === "submit") optimisticRecord(live);
      }
      persistOutbox();
      notify("warn", `${live.natKey} 写入失败，已存入断网箱，将从断点继续`);
    } catch (err) {
      // WAL 已落盘：崩溃模拟。条目留在断网箱，恢复后续传
      live.state = "failed";
      live.lastError = err instanceof Error ? err.message : "写入中断";
      if (!outbox.value.some((i) => i.txnId === live.txnId)) outbox.value.unshift(live);
      persistOutbox();
      log("error", `${live.natKey} 写入中断，WAL 已保存：${live.lastError}`);
      notify("error", `${live.natKey} 写入中断：已保留断点，恢复网络后续传`);
    }
  }

  async function flush(): Promise<void> {
    if (sendingCount.value > 0) return;
    // 断点恢复：服务端若有 WAL 先应用
    if (server.hasPendingWal()) {
      const rec = server.recover();
      if (rec.resumed) {
        log("success", `服务端断点续传完成：${rec.wal?.natKey ?? ""}`);
        refresh(false);
      }
    }
    const due = outbox.value.filter((i) => i.state === "queued" || i.state === "failed");
    for (const item of due) {
      if (!online.value) break;
      await processItem(item);
    }
  }

  // ---------- 冲突处理（后到者决定） ----------
  /** 保留我的输入：带 force 重提，版本按先到者当前版本 */
  async function keepMine(c: ConflictInfo): Promise<void> {
    const slot = outbox.value.find((i) => i.txnId === c.txnId);
    const target = slot ?? {
      txnId: c.txnId,
      action: "submit" as const,
      natKey: c.natKey,
      input: c.incoming,
      baseVersion: c.server.version,
      force: true,
      state: "queued" as const,
      attempts: 0,
      lastError: "",
      createdAt: new Date().toISOString()
    };
    target.baseVersion = c.server.version;
    target.force = true;
    if (slot) {
      slot.baseVersion = c.server.version;
      slot.force = true;
      slot.state = "queued";
      slot.lastError = "";
      persistOutbox();
    } else {
      outbox.value.unshift(target);
      persistOutbox();
    }
    conflict.value = null;
    log("info", `后到者选择保留自己的输入，覆盖 ${c.natKey}`);
    if (online.value) await flush();
  }

  /** 采用先到者：丢弃本地输入，用服务端数据回填表单供查看 */
  async function keepServer(c: ConflictInfo): Promise<void> {
    const s = c.server;
    formFill.value = {
      token: Date.now(),
      natKey: s.natKey,
      baseVersion: s.version,
      input: {
        date: s.date,
        shift: s.shift,
        operator: s.operator,
        cash: s.cash,
        digital: s.digital,
        lines: JSON.parse(JSON.stringify(s.lines)),
        notes: s.notes,
        source: s.source
      }
    };
    outbox.value = outbox.value.filter((i) => i.txnId !== c.txnId);
    persistOutbox();
    conflict.value = null;
    editingNatKey.value = c.natKey;
    log("info", `后到者放弃自己的输入，采用先到者版本 ${c.natKey}`);
    notify("info", `已采用先提交的 ${c.natKey}`);
    refresh(false);
  }

  function dismissConflict(): void {
    const c = conflict.value;
    conflict.value = null;
    if (c) {
      const slot = outbox.value.find((i) => i.txnId === c.txnId);
      if (slot) {
        // 保留 conflict 态：输入不丢，也不会被自动续传；可在断网箱中重新唤起
        slot.state = "conflict";
        slot.lastError = "冲突待值班员处理";
        persistOutbox();
      }
    }
  }

  /** 从断网箱重新打开一条未决冲突 */
  function reopenConflict(txnId: string): void {
    const slot = outbox.value.find((i) => i.txnId === txnId && i.action === "submit");
    if (!slot || !slot.input) return;
    const serverRecord = records.value.find((r) => r.natKey === slot.natKey);
    if (!serverRecord) {
      notify("error", "服务端记录不存在，无法对比");
      return;
    }
    conflict.value = {
      txnId,
      natKey: slot.natKey,
      server: serverRecord,
      incoming: slot.input,
      baseVersion: slot.baseVersion
    };
  }

  // ---------- 编辑 ----------
  function startEdit(natKey: string): void {
    const r = records.value.find((x) => x.natKey === natKey);
    if (!r) return;
    editingNatKey.value = natKey;
    formFill.value = {
      token: Date.now(),
      natKey,
      baseVersion: r.version,
      input: {
        date: r.date,
        shift: r.shift,
        operator: r.operator,
        cash: r.cash,
        digital: r.digital,
        lines: JSON.parse(JSON.stringify(r.lines)),
        notes: r.notes,
        source: r.source
      }
    };
  }

  function cancelEdit(): void {
    editingNatKey.value = null;
    formFill.value = null;
  }

  // ---------- 演示控制 ----------
  function setOnline(v: boolean): void {
    online.value = v;
    server.setOnline(v);
    log(v ? "success" : "warn", v ? "网络已恢复，开始续传断网箱" : "模拟断网：交接单将进入断网箱");
    if (v) setTimeout(flush, 300);
  }

  function setCrashNext(v: boolean): void {
    server.setCrashNext(v);
    if (v) log("warn", "已开启：下一次写入将在落库前中断（WAL 断点演示）");
  }

  /** 模拟另一名值班员对同一班次抢先提交（制造并发冲突） */
  async function simulatePeer(input: HandoverInput): Promise<void> {
    const saved = await server.peerCommit(peerInput(input));
    refresh(false);
    log("warn", `另一名值班员 ${saved.operator} 已先提交 ${saved.natKey}`);
    notify("warn", `同事 ${saved.operator} 已抢先提交该班次，你提交时将看到冲突`);
  }

  function resetAll(): void {
    localStorage.removeItem(DB_KEY);
    localStorage.removeItem("dfwl7:server-wal");
    localStorage.removeItem(APPLIED_STORAGE);
    localStorage.removeItem(OUTBOX_KEY);
    localStorage.removeItem(CACHE_KEY);
    records.value = seedRecords();
    cache.value = {};
    outbox.value = [];
    conflict.value = null;
    editingNatKey.value = null;
    const first = reconcile(records.value, {}, PRODUCTS);
    cache.value = first.cache;
    log("info", "已重置为演示数据");
    notify("info", "数据已重置");
  }

  return {
    // state
    records,
    outbox,
    online,
    conflict,
    notices,
    audit,
    editingNatKey,
    formFill,
    lastRecomputed,
    // getters
    orderedRecords,
    listedRecords,
    totals,
    pendingOutbox,
    sendingCount,
    derivedOf,
    // actions
    init,
    refresh,
    submitInput,
    review,
    flush,
    keepMine,
    keepServer,
    dismissConflict,
    reopenConflict,
    startEdit,
    cancelEdit,
    setOnline,
    setCrashNext,
    simulatePeer,
    resetAll,
    notify,
    log
  };
});
