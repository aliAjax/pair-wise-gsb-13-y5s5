<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useHandoverStore, type HandoverDraft } from "./store/handoverStore";
import { STATUS_LABEL, type LedgerRow, type ShiftName } from "./domain/types";

const store = useHandoverStore();

onMounted(() => store.initCrossTabSync());

// ---------- 复核账（ledgerVersion 建立响应依赖，行级缓存放引擎内部） ----------
const ledger = computed(() => {
  void store.ledgerVersion;
  return store.getLedger();
});
const totals = computed(() => ledger.value.totals);
const perFuel = computed(() => Object.values(ledger.value.perFuel));

// ---------- 筛选 ----------
const filterFuel = ref("全部");
const filterStatus = ref<"all" | "pending" | "approved">("all");
const rows = computed<LedgerRow[]>(() =>
  ledger.value.rows.filter((r) => {
    if (filterFuel.value !== "全部" && r.fuel !== filterFuel.value) return false;
    if (filterStatus.value !== "all" && r.status !== filterStatus.value) return false;
    return true;
  })
);

// ---------- 补录表单 ----------
function newIdemKey() {
  return `HO-${crypto.randomUUID().slice(0, 8)}`;
}

const operator = ref("值班员甲");
const form = reactive({
  fuel: "92",
  date: "2026-10-05",
  shift: "中班" as ShiftName,
  meterStart: 133720,
  meterEnd: 137000,
  tankEnd: 8925,
  delivery: 0,
  cash: 7400,
  digital: 17600,
  notes: ""
});
const idemKey = ref(newIdemKey());

const dateStr = computed(() => form.date);

const SHIFT_RANK: Record<ShiftName, number> = { 早班: 0, 中班: 1, 晚班: 2 };

/** 同油品最近一张更早交接单的交班读数：作为接班读数的衔接建议 */
const suggestedMeterStart = computed(() => {
  const before = store.handovers
    .filter(
      (h) =>
        h.fuel === form.fuel &&
        `${h.date}-${String(SHIFT_RANK[h.shift]).padStart(2, "0")}` <
          `${dateStr.value}-${String(SHIFT_RANK[form.shift]).padStart(2, "0")}`
    )
    .sort(
      (a, b) =>
        b.date.localeCompare(a.date) || SHIFT_RANK[b.shift] - SHIFT_RANK[a.shift]
    );
  return before[0]?.meterEnd ?? null;
});

const submitting = ref(false);

function resetForm(keepSlot = false) {
  idemKey.value = newIdemKey();
  form.meterEnd = 0;
  form.tankEnd = 0;
  form.delivery = 0;
  form.cash = 0;
  form.digital = 0;
  form.notes = "";
  if (!keepSlot) {
    form.meterStart = suggestedMeterStart.value ?? 0;
  }
}

async function submit() {
  if (!dateStr.value) return ElMessage.warning("请选择交接日期");
  if (form.meterEnd < form.meterStart) return ElMessage.warning("交班读数不能小于接班读数");
  if (form.tankEnd < 0) return ElMessage.warning("罐存读数不能为负");

  const draft: HandoverDraft = {
    handoverId: crypto.randomUUID(),
    idempotencyKey: idemKey.value,
    operator: operator.value || "未署名值班员",
    fuel: form.fuel,
    date: dateStr.value,
    shift: form.shift,
    meterStart: Number(form.meterStart),
    meterEnd: Number(form.meterEnd),
    tankEnd: Number(form.tankEnd),
    delivery: Number(form.delivery),
    cash: Number(form.cash),
    digital: Number(form.digital),
    notes: form.notes
  };

  submitting.value = true;
  try {
    const r = await store.submitDraft(draft);
    if (r.type === "applied") {
      if (r.duplicate) {
        ElMessage.warning("该交接单已补录过（幂等键相同），重复补录只算一次");
      } else {
        ElMessage.success("交接单已入账，标记为待复核");
        resetForm();
      }
    } else if (r.type === "conflict") {
      ElMessage.error("同一时段已有交接单：你的输入已保留，请在下方冲突列表裁决");
      // 后到者的输入保留在表单中，不被清空
    } else {
      ElMessage.error(
        r.durable
          ? `写入中断：${r.error}。数据已留在断点，请点「从断点继续」，不要重复提交`
          : `写入失败：${r.error}。本次未落盘，可直接重试`
      );
    }
  } catch (e) {
    ElMessage.error(`提交失败：${(e as Error).message}。数据未丢，可重试或从断点继续`);
  } finally {
    submitting.value = false;
  }
}

// ---------- 冲突裁决（后到者保留输入并看到冲突） ----------
async function resolve(slot: string, action: "force" | "discard") {
  try {
    if (action === "force") {
      await ElMessageBox.confirm(
        "将用后到值班员的数据覆盖先来的交接单（先来版本号保留在版本链上），确认覆盖？",
        "冲突裁决",
        { type: "warning", confirmButtonText: "覆盖", cancelButtonText: "取消" }
      );
    }
    await store.resolveConflict(slot, action);
    ElMessage.success(action === "force" ? "已用后到者数据入账" : "已保留先来的交接单");
    if (action === "force") resetForm();
  } catch (e) {
    if (e === "cancel") return;
    ElMessage.error(`裁决写入失败：${(e as Error).message}，可从断点继续`);
  }
}

// ---------- 复核通过 ----------
async function approve(row: LedgerRow) {
  try {
    await ElMessageBox.confirm(
      `复核通过后，${row.date} ${row.shift} ${row.fuelName} 的销量 ${fmt(row.flow)}L 才计入正式收入与起始罐存，确认？`,
      "复核确认",
      { type: "info", confirmButtonText: "复核通过", cancelButtonText: "再看看" }
    );
    const r = await store.approve(row.handoverId);
    if (r.type === "failed") {
      ElMessage.error(
        r.durable
          ? `写入中断：${r.error}。请点「从断点继续」`
          : `写入失败：${r.error}。可重试`
      );
    } else ElMessage.success("已复核，销量与收入并入正式账");
  } catch (e) {
    if (e === "cancel") return;
    ElMessage.error((e as Error).message);
  }
}

// ---------- 断点续传 / 故障注入 ----------
const resuming = ref(false);
async function resume() {
  resuming.value = true;
  try {
    await store.resumeQueue();
    ElMessage.success("断点操作已全部补做完成");
  } catch (e) {
    ElMessage.error(`仍有操作未完成：${(e as Error).message}，请再次从断点继续`);
  } finally {
    resuming.value = false;
  }
}

function injectFailure() {
  store.failNext += 1;
  ElMessage.info("已注入：下一次写入将在「临时区已落盘、正式账未切换」时失败（走断点继续）");
}

function injectStorageDown() {
  store.failPreWrite += 1;
  ElMessage.info("已注入：下一次写入在临时区落盘前失败（本次等于未发生，可直接重试）");
}

// ---------- 展示辅助 ----------
const fmt = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : Math.abs(n) < 1e-9 ? "0" : n.toLocaleString("zh-CN");
const yuan = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `¥${n.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;
const diffClass = (n: number | null) =>
  n === null ? "" : Math.abs(n) < 1e-6 ? "ok" : "bad";

const queueText = computed(() =>
  store.queue
    .map((q) =>
      q.kind === "approve"
        ? `复核通过 ${q.targetId?.slice(-4)}`
        : `${q.kind === "replace" ? "冲突覆盖" : "补录入账"} ${q.draft?.date} ${q.draft?.shift} ${q.draft?.fuel}#`
    )
    .join("；")
);
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业 · 交接复核账</p>
          <h1>加油站班次交接 · 罐存复核账</h1>
          <p class="subtitle">
            交接单与罐存读数串成两条账：工作账连续推算、正式账只计已复核班次。
            断网补录凭幂等键只算一次；现金、电子支付或罐存读数变化时仅受影响班次重算，其他班次保留上次结果。
          </p>
        </div>
        <div class="stack">
          <span class="tag">Vue3</span>
          <span class="tag">TypeScript</span>
          <span class="tag">Element Plus</span>
          <span class="tag">Pinia</span>
        </div>
      </header>

      <!-- 断点 / 写入失败横幅 -->
      <el-alert
        v-if="store.queue.length || store.lastError"
        class="banner"
        type="error"
        :closable="false"
        show-icon
      >
        <template #title>
          有 {{ store.queue.length }} 笔操作停在写入断点：{{ queueText || store.lastError }}
          <el-button size="small" type="primary" :loading="resuming" @click="resume">
            从断点继续
          </el-button>
        </template>
      </el-alert>

      <!-- 正式账指标 -->
      <section class="metrics">
        <article class="metric">
          <span>正式总收入（仅已复核）</span>
          <strong>{{ yuan(totals.officialRevenue) }}</strong>
          <em>待复核 {{ yuan(totals.pendingRevenue) }} 暂不计入</em>
        </article>
        <article class="metric">
          <span>正式总销量（仅已复核）</span>
          <strong>{{ fmt(totals.officialFlow) }} L</strong>
          <em>待复核 {{ fmt(totals.pendingFlow) }} L 暂不计入</em>
        </article>
        <article class="metric">
          <span>已复核 / 待复核班次</span>
          <strong>{{ totals.approvedCount }} / {{ totals.pendingCount }}</strong>
          <em>列表先标待复核，站长复核后并入</em>
        </article>
        <article class="metric">
          <span>待裁决冲突</span>
          <strong :class="{ bad: store.conflicts.length }">{{ store.conflicts.length }}</strong>
          <em>同槽位重复提交时保留后到者输入</em>
        </article>
      </section>

      <section class="workspace">
        <!-- 补录表单 -->
        <form class="panel" @submit.prevent="submit">
          <div class="panel-head">
            <h2>断网补录交接单</h2>
            <div class="demo-tools">
              <el-button size="small" @click="injectFailure">模拟写入中断（有断点）</el-button>
              <el-button size="small" @click="injectStorageDown">模拟存储不可用</el-button>
            </div>
          </div>

          <div class="form-grid">
            <label>
              值班员
              <el-input v-model="operator" placeholder="值班员姓名" />
            </label>
            <label>
              油品
              <el-select v-model="form.fuel" style="width: 100%">
                <el-option v-for="c in store.configs" :key="c.code" :label="c.name" :value="c.code" />
              </el-select>
            </label>
            <label>
              交接日期
              <el-date-picker
                v-model="form.date"
                type="date"
                value-format="YYYY-MM-DD"
                format="YYYY-MM-DD"
                style="width: 100%"
              />
            </label>
            <label>
              班次
              <el-select v-model="form.shift" style="width: 100%">
                <el-option label="早班" value="早班" />
                <el-option label="中班" value="中班" />
                <el-option label="晚班" value="晚班" />
              </el-select>
            </label>
            <label>
              接班流量计读数 L
              <el-input-number v-model="form.meterStart" :min="0" controls-position="right" style="width: 100%" />
              <small v-if="suggestedMeterStart !== null && suggestedMeterStart !== form.meterStart">
                衔接建议：{{ fmt(suggestedMeterStart) }}
              </small>
            </label>
            <label>
              交班流量计读数 L
              <el-input-number v-model="form.meterEnd" :min="0" controls-position="right" style="width: 100%" />
            </label>
            <label>
              交班实测罐存 L
              <el-input-number v-model="form.tankEnd" :min="0" controls-position="right" style="width: 100%" />
            </label>
            <label>
              本班入库 L
              <el-input-number v-model="form.delivery" :min="0" controls-position="right" style="width: 100%" />
            </label>
            <label>
              现金收入（元）
              <el-input-number v-model="form.cash" :min="0" controls-position="right" style="width: 100%" />
            </label>
            <label>
              电子支付（元）
              <el-input-number v-model="form.digital" :min="0" controls-position="right" style="width: 100%" />
            </label>
            <label class="wide">
              备注
              <el-input v-model="form.notes" type="textarea" :rows="2" placeholder="断网说明、现场情况" />
            </label>
          </div>

          <div class="form-foot">
            <span class="idem">幂等键：{{ idemKey }}（重复提交只算一次）</span>
            <div>
              <el-button @click="idemKey = newIdemKey()">换一张新单</el-button>
              <el-button type="primary" native-type="submit" :loading="submitting">保存交接（待复核）</el-button>
            </div>
          </div>
        </form>

        <!-- 冲突面板 -->
        <section class="panel conflict-panel" v-if="store.conflicts.length">
          <h2>交接冲突（{{ store.conflicts.length }}）— 后到者输入已保留</h2>
          <el-table :data="store.conflicts" border size="small">
            <el-table-column label="时段" width="180">
              <template #default="{ row }">
                {{ row.existing.date }} {{ row.existing.shift }}<br />
                {{ row.existing.fuel }}# 油品
              </template>
            </el-table-column>
            <el-table-column label="先来者（已入账 v{{ row.existing.version }}）">
              <template #default="{ row }">
                罐存 {{ fmt(row.existing.tankEnd) }} / 现金 {{ fmt(row.existing.cash) }} /
                电子 {{ fmt(row.existing.digital) }} / 读数 {{ fmt(row.existing.meterStart) }}→{{ fmt(row.existing.meterEnd) }}
              </template>
            </el-table-column>
            <el-table-column :label="`后到者：${row.operator}`">
              <template #default="{ row }">
                罐存 {{ fmt(row.incoming.tankEnd) }} / 现金 {{ fmt(row.incoming.cash) }} /
                电子 {{ fmt(row.incoming.digital) }} / 读数 {{ fmt(row.incoming.meterStart) }}→{{ fmt(row.incoming.meterEnd) }}
              </template>
            </el-table-column>
            <el-table-column label="裁决" width="200">
              <template #default="{ row }">
                <el-button size="small" type="danger" @click="resolve(row.slot, 'force')">后到者覆盖</el-button>
                <el-button size="small" @click="resolve(row.slot, 'discard')">后到者放弃</el-button>
              </template>
            </el-table-column>
          </el-table>
        </section>
      </section>

      <!-- 各油品罐存：正式账 vs 工作账 -->
      <section class="fuel-cards">
        <article v-for="f in perFuel" :key="f.code" class="fuel-card">
          <h3>{{ f.name }}</h3>
          <div class="fuel-grid">
            <div>
              <p>正式账当前罐存</p>
              <strong>{{ fmt(f.officialTank) }} L</strong>
            </div>
            <div>
              <p>工作账当前罐存</p>
              <strong class="pending-text">{{ fmt(f.trialTank) }} L</strong>
            </div>
            <div>
              <p>已复核销量 / 收入</p>
              <strong>{{ fmt(f.officialFlow) }}L · {{ yuan(f.officialRevenue) }}</strong>
            </div>
            <div>
              <p>待复核销量 / 收入</p>
              <strong class="pending-text">{{ fmt(f.pendingFlow) }}L · {{ yuan(f.pendingRevenue) }}</strong>
            </div>
          </div>
        </article>
      </section>

      <!-- 复核账列表 -->
      <section class="list-panel panel">
        <div class="toolbar">
          <h2>复核账明细（列表先标待复核）</h2>
          <div class="filters">
            <el-select v-model="filterFuel" size="small" style="width: 130px">
              <el-option label="全部油品" value="全部" />
              <el-option v-for="c in store.configs" :key="c.code" :label="c.name" :value="c.code" />
            </el-select>
            <el-radio-group v-model="filterStatus" size="small">
              <el-radio-button label="all">全部</el-radio-button>
              <el-radio-button label="pending">待复核</el-radio-button>
              <el-radio-button label="approved">已复核</el-radio-button>
            </el-radio-group>
          </div>
        </div>

        <el-table :data="rows" border size="small" :row-class-name="({ row }) => `row-${row.status}`">
          <el-table-column label="状态" width="86">
            <template #default="{ row }">
              <el-tag :type="row.status === 'approved' ? 'success' : 'warning'" size="small">
                {{ STATUS_LABEL[row.status as "pending" | "approved"] }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="date" label="日期" width="110" />
          <el-table-column prop="shift" label="班次" width="70" />
          <el-table-column label="油品" width="90">
            <template #default="{ row }">{{ row.fuelName }}</template>
          </el-table-column>
          <el-table-column label="销量 L" width="90">
            <template #default="{ row }">{{ fmt(row.flow) }}</template>
          </el-table-column>
          <el-table-column label="起始罐存(工作)" width="110">
            <template #default="{ row }">{{ fmt(row.trialOpen) }}</template>
          </el-table-column>
          <el-table-column label="入库" width="80">
            <template #default="{ row }">{{ fmt(row.delivery) }}</template>
          </el-table-column>
          <el-table-column label="账面罐存" width="100">
            <template #default="{ row }">{{ fmt(row.bookClose) }}</template>
          </el-table-column>
          <el-table-column label="实测罐存" width="100">
            <template #default="{ row }">{{ fmt(row.tankEnd) }}</template>
          </el-table-column>
          <el-table-column label="罐存差异" width="100">
            <template #default="{ row }">
              <span :class="diffClass(row.tankDiff)">{{ fmt(row.tankDiff) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="现金" width="90">
            <template #default="{ row }">{{ fmt(row.cash) }}</template>
          </el-table-column>
          <el-table-column label="电子支付" width="95">
            <template #default="{ row }">{{ fmt(row.digital) }}</template>
          </el-table-column>
          <el-table-column label="实收" width="100">
            <template #default="{ row }">{{ yuan(row.revenue) }}</template>
          </el-table-column>
          <el-table-column label="收入差异" width="100">
            <template #default="{ row }">
              <span :class="diffClass(row.moneyDiff)">{{ fmt(row.moneyDiff) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="正式起始罐存" width="110">
            <template #default="{ row }">
              <span v-if="row.officialOpen === null" class="pending-text">待复核 —</span>
              {{ row.officialOpen !== null ? fmt(row.officialOpen) : "" }}
            </template>
          </el-table-column>
          <el-table-column label="读数衔接" width="100">
            <template #default="{ row }">
              <el-tooltip v-if="row.meterJump" :content="`接班读数与上一班交班读数相差 ${row.meterJump}L`">
                <span class="bad">{{ fmt(row.meterJump) }}</span>
              </el-tooltip>
              <span v-else class="ok">衔接正常</span>
            </template>
          </el-table-column>
          <el-table-column label="计算" width="104">
            <template #default="{ row }">
              <el-tag size="small" :type="row.reused ? 'info' : 'danger'">
                {{ row.reused ? "保留上次结果" : "本次重算" }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="106" fixed="right">
            <template #default="{ row }">
              <el-button
                v-if="row.status === 'pending'"
                size="small"
                type="success"
                @click="approve(row)"
              >复核通过</el-button>
              <span v-else class="ok">v{{ row.version }}</span>
            </template>
          </el-table-column>
        </el-table>
        <p class="ledger-note">
          规则：现金/电子支付/罐存读数变化时，仅其所在班次及下游受影响班次重算，其余行显示「保留上次结果」；
          待复核班次的销量不计入正式总收入，也不作为正式起始罐存传递。
        </p>
      </section>
    </div>
  </main>
</template>

<style scoped>
.banner { margin-bottom: 16px; }
.banner :deep(.el-alert__title) { display: flex; align-items: center; gap: 12px; }
.metric em { display: block; margin-top: 6px; font-style: normal; font-size: 12px; color: #8a93a5; }
.panel-head { display: flex; justify-content: space-between; align-items: center; }
.demo-tools { display: flex; gap: 8px; }
.form-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px 14px;
  margin: 14px 0;
}
.form-grid label.wide { grid-column: span 2; }
.form-grid small { color: #b07d00; font-size: 12px; }
.form-foot { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.idem { font-size: 12px; color: #8a93a5; font-family: monospace; }
.conflict-panel { margin-top: 18px; }
.fuel-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin: 18px 0; }
.fuel-card { background: #fff; border: 1px solid #dfe6f0; border-radius: 12px; padding: 16px 18px; }
.fuel-card h3 { margin: 0 0 12px; font-size: 16px; }
.fuel-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.fuel-grid p { margin: 0 0 4px; color: #8a93a5; font-size: 12px; }
.fuel-grid strong { font-size: 14px; }
.pending-text { color: #b07d00; }
.bad { color: #c84b31; font-weight: 700; }
.ok { color: #1f9c63; }
.toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.filters { display: flex; gap: 10px; }
.ledger-note { margin: 12px 2px 0; color: #8a93a5; font-size: 13px; }
:deep(.row-pending) { background: #fff9ec !important; }
</style>
