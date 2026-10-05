<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import HandoverForm from "./components/HandoverForm.vue";
import ShiftList from "./components/ShiftList.vue";
import ConflictPanel from "./components/ConflictPanel.vue";
import OutboxPanel from "./components/OutboxPanel.vue";
import AuditLog from "./components/AuditLog.vue";
import { liters, money } from "./domain";
import { useLedgerStore } from "./store";

const store = useLedgerStore();
const crashNext = ref(false);

onMounted(() => store.init());

const statusBuckets = computed(() => {
  const pending = store.records.filter((r) => r.status === "pending").length;
  const rejected = store.records.filter((r) => r.status === "rejected").length;
  const approved = store.records.filter((r) => r.status === "approved").length;
  return { pending, rejected, approved, total: store.records.length };
});

const maxBucket = computed(() => Math.max(1, statusBuckets.value.pending, statusBuckets.value.rejected, statusBuckets.value.approved));

const chartRows = computed(() => [
  { key: "pending", label: "待复核", value: statusBuckets.value.pending },
  { key: "rejected", label: "复核驳回", value: statusBuckets.value.rejected },
  { key: "approved", label: "复核通过", value: statusBuckets.value.approved }
]);

function toggleOnline() {
  store.setOnline(!store.online);
}
function toggleCrash() {
  crashNext.value = !crashNext.value;
  store.setCrashNext(crashNext.value);
}

const noticeClass: Record<string, string> = {
  info: "nt-info",
  success: "nt-success",
  warn: "nt-warn",
  error: "nt-error"
};
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业 · 交接单 × 罐存 复核账</p>
          <h1>加油站班次交接复核</h1>
          <p class="subtitle">
            断网补录与罐存读数接成一本复核账：重复补录只计一次，现金/电子支付或读数变化时只重算受影响班次，
            通过前列表标待复核，销量暂不计入总收入与起始罐存。
          </p>
        </div>
        <div class="sim-controls">
          <button type="button" :class="store.online ? 'sim-ok' : 'sim-off'" @click="toggleOnline">
            {{ store.online ? "🟢 网络正常" : "🔴 模拟断网" }}
          </button>
          <button type="button" class="secondary" :class="{ 'sim-armed': crashNext }" @click="toggleCrash">
            {{ crashNext ? "💥 下次写入将中断" : "⏱ 开启写入中断模拟" }}
          </button>
        </div>
      </header>

      <div class="notice-stack">
        <transition-group name="nt">
          <div v-for="n in store.notices" :key="n.id" class="notice" :class="noticeClass[n.kind]">
            {{ n.text }}
          </div>
        </transition-group>
      </div>

      <section class="metrics">
        <article class="metric metric-primary">
          <span>累计总收入（仅复核通过班次）</span>
          <strong>{{ money(store.totals.revenue) }}</strong>
          <em>待复核班次的收入暂不计入</em>
        </article>
        <article class="metric">
          <span>通过销量（计入起始罐存链）</span>
          <strong>{{ liters(store.totals.approvedSales) }}</strong>
          <em>{{ store.totals.approvedCount }} 个班次已通过</em>
        </article>
        <article class="metric">
          <span>待复核 / 驳回</span>
          <strong>{{ statusBuckets.pending }} / {{ statusBuckets.rejected }}</strong>
          <em>列表已按待复核优先排序</em>
        </article>
        <article class="metric">
          <span>断网箱与冲突</span>
          <strong>{{ store.pendingOutbox.length }} / {{ store.totals.conflictCount }}</strong>
          <em>待续传笔数 / 未决冲突</em>
        </article>
      </section>

      <section class="workspace">
        <div class="side-col">
          <HandoverForm />
          <OutboxPanel />
          <AuditLog />
        </div>
        <ShiftList />
      </section>

      <section class="status-chart panel">
        <h2>班次状态分布</h2>
        <div class="bar" v-for="cfg in chartRows" :key="cfg.key">
          <span>{{ cfg.label }}</span>
          <div class="bar-track">
            <div class="bar-fill" :class="`fill-${cfg.key}`" :style="{ width: `${(cfg.value / maxBucket) * 100}%` }" />
          </div>
          <strong>{{ cfg.value }}</strong>
        </div>
      </section>
    </div>

    <ConflictPanel />
  </main>
</template>
