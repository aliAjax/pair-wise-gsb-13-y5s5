import { natKeyOf, uid } from "../domain";
import { seedRecords } from "./seed";
import type {
  Handover,
  HandoverInput,
  SaveResult,
  WalActionType,
  WalEntry
} from "../types";

/**
 * 模拟服务端（localStorage 持久化，异步延迟模拟网络）。
 * 提供的一致性保证：
 *  1. 原子提交：先写 WAL（预写日志），再落库，最后删除 WAL；
 *     若在中间失败/刷新，下次调用 recover() 时从 WAL 断点继续，不会留下半套数字。
 *  2. 幂等：同一 txnId 的重复补录只生效一次，重复请求返回当前记录。
 *  3. 乐观锁：baseVersion 与服务端版本不一致且未强制覆盖时返回 conflict，
 *     后到者的输入原样带回 UI，由值班员选择保留谁。
 */

const DB_KEY = "dfwl7:server-db";
const WAL_KEY = "dfwl7:server-wal";
const APPLIED_KEY = "dfwl7:applied-txn";
const LATENCY_MS = 420;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

class MockServer {
  private records: Handover[] = [];
  private applied = new Set<string>();
  online = true;
  /** 下次提交在 WAL 落盘后、落库完成前“崩溃”，用于演示断点续传 */
  crashNextCommit = false;

  async bootstrap(): Promise<{ resumed: boolean; wal?: WalEntry }> {
    const raw = localStorage.getItem(DB_KEY);
    this.records = raw ? (JSON.parse(raw) as Handover[]) : seedRecords();
    const applied = localStorage.getItem(APPLIED_KEY);
    this.applied = new Set(applied ? (JSON.parse(applied) as string[]) : []);
    this.persistDb();
    // 启动即恢复上次未完成的写入
    return this.recover();
  }

  snapshot(): Handover[] {
    return clone(this.records);
  }

  setOnline(v: boolean): void {
    this.online = v;
  }

  setCrashNext(v: boolean): void {
    this.crashNextCommit = v;
  }

  findByNatKey(natKey: string): Handover | undefined {
    return this.records.find((r) => r.natKey === natKey);
  }

  /** 模拟“另一名值班员”在同一班次抢先提交成功（不经 outbox，立即成功） */
  async peerCommit(input: HandoverInput): Promise<Handover> {
    await this.delay(150);
    const natKey = natKeyOf(input.date, input.shift);
    const now = new Date().toISOString();
    const existing = this.findByNatKey(natKey);
    let saved: Handover;
    if (existing) {
      saved = {
        ...clone(existing),
        operator: input.operator,
        cash: input.cash,
        digital: input.digital,
        lines: clone(input.lines),
        notes: input.notes,
        source: input.source,
        version: existing.version + 1,
        updatedAt: now
      };
      this.records = this.records.map((r) => (r.id === existing.id ? saved : r));
    } else {
      saved = this.mkRecord(input, now, uid("peer-txn"));
      this.records = [saved, ...this.records];
    }
    this.persistDb();
    return clone(saved);
  }

  async submit(txnId: string, input: HandoverInput, baseVersion: number, force: boolean): Promise<SaveResult> {
    const natKey = natKeyOf(input.date, input.shift);
    if (!this.online) return { ok: false, error: "offline" };
    await this.delay(LATENCY_MS);

    // 若上一次写入在落库前中断，先从断点继续，绝不让新提交覆盖半套数字
    this.recover();

    // 同一事务重试：幂等返回，不重复算
    if (this.applied.has(txnId)) {
      const current = this.findByNatKey(natKey);
      return current ? { ok: true, record: clone(current), duplicate: true } : { ok: false, error: "offline" };
    }

    const existing = this.findByNatKey(natKey);
    if (existing && !force && existing.version !== baseVersion) {
      // 两名值班员同时提交同一交接单：后到者收到冲突，输入保留在本地
      return { ok: false, error: "conflict", server: clone(existing) };
    }

    return this.commit<SaveResult>(
      {
        txnId,
        action: "submit",
        natKey,
        input: clone(input),
        baseVersion,
        force,
        createdAt: new Date().toISOString()
      },
      () => {
        const now = new Date().toISOString();
        let saved: Handover;
        if (existing) {
          const numbersChanged =
            existing.cash !== input.cash ||
            existing.digital !== input.digital ||
            JSON.stringify(existing.lines) !== JSON.stringify(input.lines);
          saved = {
            ...clone(existing),
            operator: input.operator,
            cash: input.cash,
            digital: input.digital,
            lines: clone(input.lines),
            notes: input.notes,
            source: input.source,
            version: existing.version + 1,
            // 数字被动过的已复核单，退回待复核重新走账；备注修改不影响账目
            status: numbersChanged && existing.status === "approved" ? "pending" : existing.status,
            updatedAt: now
          };
          this.records = this.records.map((r) => (r.id === existing.id ? saved : r));
        } else {
          saved = this.mkRecord(input, now, txnId);
          this.records = [saved, ...this.records];
        }
        return { ok: true as const, record: clone(saved), duplicate: false };
      }
    );
  }

  async review(txnId: string, natKey: string, action: "approve" | "reject"): Promise<SaveResult> {
    if (!this.online) return { ok: false, error: "offline" };
    await this.delay(LATENCY_MS);

    // 同样先完成断点恢复
    this.recover();

    if (this.applied.has(txnId)) {
      const current = this.findByNatKey(natKey);
      return current ? { ok: true, record: clone(current), duplicate: true } : { ok: false, error: "offline" };
    }
    const existing = this.findByNatKey(natKey);
    if (!existing) return { ok: false, error: "offline" };

    return this.commit<SaveResult>(
      {
        txnId,
        action,
        natKey,
        baseVersion: existing.version,
        force: false,
        createdAt: new Date().toISOString()
      },
      () => {
        const now = new Date().toISOString();
        const saved: Handover = {
          ...clone(existing!),
          status: action === "approve" ? "approved" : "rejected",
          version: existing!.version + 1,
          updatedAt: now
        };
        this.records = this.records.map((r) => (r.natKey === natKey ? saved : r));
        return { ok: true as const, record: clone(saved), duplicate: false };
      }
    );
  }

  // ---------- 内部：WAL 原子提交与断点恢复 ----------

  private commit<T extends SaveResult>(wal: WalEntry, apply: () => T): T {
    // 阶段1：预写日志（先于数据落盘）
    localStorage.setItem(WAL_KEY, JSON.stringify(wal));

    if (this.crashNextCommit) {
      this.crashNextCommit = false;
      // 模拟此刻断电/断网：WAL 已在、库未改完。下次 recover() 从断点继续
      throw new Error("模拟写入中断：WAL 已保存，等待断点续传");
    }

    // 阶段2：恢复时也要走的应用逻辑（幂等）
    const result = this.applyWal(wal);

    // 阶段3：标记已应用并清除 WAL
    this.applied.add(wal.txnId);
    const applied = [...this.applied].slice(-500);
    localStorage.setItem(APPLIED_KEY, JSON.stringify(applied));
    localStorage.removeItem(WAL_KEY);

    return result as T;
  }

  private applyWal(wal: WalEntry): SaveResult {
    if (wal.action === "submit" && wal.input) {
      const input = wal.input;
      const existing = this.findByNatKey(wal.natKey);
      // 重放幂等：版本已越过本 WAL 的基版本，说明上次落库已完成，直接返回当前记录
      if (existing && existing.version > wal.baseVersion) {
        return { ok: true, record: clone(existing), duplicate: true };
      }
      const now = new Date().toISOString();
      let saved: Handover;
      if (existing) {
        const numbersChanged =
          existing.cash !== input.cash ||
          existing.digital !== input.digital ||
          JSON.stringify(existing.lines) !== JSON.stringify(input.lines);
        saved = {
          ...clone(existing),
          operator: input.operator,
          cash: input.cash,
          digital: input.digital,
          lines: clone(input.lines),
          notes: input.notes,
          source: input.source,
          version: existing.version + 1,
          status: numbersChanged && existing.status === "approved" ? "pending" : existing.status,
          updatedAt: now
        };
        this.records = this.records.map((r) => (r.id === existing.id ? saved : r));
      } else {
        saved = this.mkRecord(input, now, wal.txnId);
        this.records = [saved, ...this.records];
      }
      this.persistDb();
      return { ok: true, record: clone(saved), duplicate: false };
    }

    const existing = this.findByNatKey(wal.natKey);
    if (!existing) return { ok: false, error: "offline" };
    const intended = wal.action === "approve" ? "approved" : "rejected";
    // 重放幂等：状态已翻转且版本已推进
    if (existing.status === intended && existing.version > wal.baseVersion) {
      return { ok: true, record: clone(existing), duplicate: true };
    }
    const saved: Handover = {
      ...clone(existing),
      status: intended,
      version: existing.version + 1,
      updatedAt: new Date().toISOString()
    };
    this.records = this.records.map((r) => (r.natKey === wal.natKey ? saved : r));
    this.persistDb();
    return { ok: true, record: clone(saved), duplicate: false };
  }

  /** 启动/每次调用前恢复未完成的写入（断点继续，幂等） */
  recover(): { resumed: boolean; wal?: WalEntry } {
    const raw = localStorage.getItem(WAL_KEY);
    if (!raw) return { resumed: false };
    const wal = JSON.parse(raw) as WalEntry;
    if (this.applied.has(wal.txnId)) {
      localStorage.removeItem(WAL_KEY);
      return { resumed: true, wal };
    }
    this.applyWal(wal);
    this.applied.add(wal.txnId);
    const applied = [...this.applied].slice(-500);
    localStorage.setItem(APPLIED_KEY, JSON.stringify(applied));
    localStorage.removeItem(WAL_KEY);
    return { resumed: true, wal };
  }

  hasPendingWal(): boolean {
    return !!localStorage.getItem(WAL_KEY);
  }

  private mkRecord(input: HandoverInput, now: string, txnId: string): Handover {
    return {
      id: uid("rec"),
      natKey: natKeyOf(input.date, input.shift),
      date: input.date,
      shift: input.shift,
      operator: input.operator,
      cash: input.cash,
      digital: input.digital,
      lines: clone(input.lines),
      notes: input.notes,
      status: "pending",
      source: input.source,
      version: 1,
      createdAt: now,
      updatedAt: now,
      firstSubmitId: txnId
    };
  }

  private persistDb(): void {
    localStorage.setItem(DB_KEY, JSON.stringify(this.records));
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const server = new MockServer();
