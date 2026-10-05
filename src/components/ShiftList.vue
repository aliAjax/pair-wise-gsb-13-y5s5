<script setup lang="ts">
import { computed } from "vue";
import { PAYMENT_TOLERANCE, PRODUCTS, VOLUME_TOLERANCE, liters, money } from "../domain";
import { useLedgerStore } from "../store";
import { STATUS_TEXT, type Handover } from "../types";

const store = useLedgerStore();
const pendingFirst = computed(() => store.listedRecords);
const recomputing = computed(() => new Set(store.lastRecomputed));

function dOf(r: Handover) {
  return store.derivedOf(r.id);
}

function lineOf(r: Handover, code: string) {
  return r.lines.find((l) => l.code === code) ?? null;
}

function baseEndFor(r: Handover, code: string): number | null {
  const d = dOf(r);
  return d?.lines.find((l) => l.code === code)?.baselineEnd ?? null;
}

function isNextInChain(r: Handover): boolean {
  return store.totals.nextApproveId === r.id;
}

function pumpSalesOf(r: Handover, code: string): number {
  const l = lineOf(r, code);
  return l ? l.pumpEnd - l.pumpStart : 0;
}

function tankSalesOf(r: Handover, code: string): number {
  const l = lineOf(r, code);
  return l ? l.tankStart + l.delivery - l.tankEnd : 0;
}

function lineVariance(r: Handover, code: string): number {
  return dOf(r)?.lines.find((l) => l.code === code)?.volumeVariance ?? 0;
}

function statusClass(s: Handover["status"]) {
  return `status status-${s}`;
}

function recordClass(r: Handover): Record<string, boolean> {
  return {
    "record-pending": r.status !== "approved",
    "record-recomputed": recomputing.value.has(r.id),
    "record-local": r.id.startsWith("local-")
  };
}

function volCls(v: number) {
  return Math.abs(v) > VOLUME_TOLERANCE ? "var-bad" : "var-ok";
}
function payCls(v: number) {
  return Math.abs(v) > PAYMENT_TOLERANCE ? "var-bad" : "var-ok";
}

async function approve(r: Handover) {
  await store.review(r.natKey, "approve");
}
async function reject(r: Handover) {
  await store.review(r.natKey, "reject");
}
</script>

<template>
  <section class="list-panel">
    <div class="toolbar">
      <h2>复核账 · 班次列表</h2>
      <div class="legend">
        <span><i class="dot dot-pending" />待复核优先</span>
        <span><i class="dot dot-recompute" />本次重算</span>
        <span><i class="dot dot-cached" />保留上次结果</span>
      </div>
    </div>

    <div class="record-grid">
      <div v-if="pendingFirst.length === 0" class="empty">暂无交接单</div>

      <article
        v-for="r in pendingFirst"
        :key="r.id"
        class="record"
        :class="recordClass(r)"
      >
        <div class="record-head">
          <div>
            <p class="record-title">{{ r.date }} {{ r.shift }}</p>
            <p class="record-sub">
              值班员 {{ r.operator }}
              <span class="src-tag" :class="r.source === 'backfill' ? 'src-backfill' : 'src-online'">
                {{ r.source === "backfill" ? "断网补录" : "在线录入" }}
              </span>
              <span v-if="r.id.startsWith('local-')" class="src-tag src-local">本地待同步</span>
            </p>
          </div>
          <span :class="statusClass(r.status)">{{ STATUS_TEXT[r.status] }}</span>
        </div>

        <div v-if="dOf(r)" class="derived-strip">
          <div class="d-item">
            <span>当班收入</span>
            <strong>{{ money(dOf(r)!.revenue) }}</strong>
          </div>
          <div class="d-item">
            <span>泵码销量</span>
            <strong>{{ liters(dOf(r)!.pumpSalesTotal) }}</strong>
          </div>
          <div class="d-item">
            <span>罐存销量</span>
            <strong>{{ liters(dOf(r)!.tankSalesTotal) }}</strong>
          </div>
          <div class="d-item">
            <span>量罐差异</span>
            <strong :class="volCls(dOf(r)!.volumeVariance)">
              {{ dOf(r)!.volumeVariance > 0 ? "+" : "" }}{{ liters(dOf(r)!.volumeVariance) }}
            </strong>
          </div>
          <div class="d-item">
            <span>收款差异</span>
            <strong :class="payCls(dOf(r)!.paymentVariance)">
              {{ dOf(r)!.paymentVariance > 0 ? "+" : "" }}{{ money(dOf(r)!.paymentVariance) }}
            </strong>
          </div>
        </div>

        <div class="chain-note">
          <span class="cash-line">现金 {{ money(r.cash) }} ＋ 电子 {{ money(r.digital) }}</span>
          <span v-if="dOf(r)?.chainBroken" class="chain-broken">
            ⚠ 上游班次未通过，起始罐存暂不接续
          </span>
          <span v-else-if="dOf(r)?.baselineId" class="chain-ok">
            起始罐存已接续上一通过班次
          </span>
          <span v-else class="chain-ok">罐存链首张</span>
        </div>

        <div class="lines-table">
          <div class="lines-head">
            <span>油品</span><span>泵码销量</span><span>罐存销量</span>
            <span>应接续起始罐存</span><span>本班结束</span><span>配送</span><span>差异</span>
          </div>
          <div v-for="p in PRODUCTS" :key="p.code" class="lines-row">
            <span>{{ p.name }}</span>
            <span>{{ liters(pumpSalesOf(r, p.code)) }}</span>
            <span>{{ liters(tankSalesOf(r, p.code)) }}</span>
            <span :class="{ 'cell-broken': dOf(r)?.chainBroken }">
              {{ baseEndFor(r, p.code) === null ? (dOf(r)?.chainBroken ? "待复核" : "—") : liters(baseEndFor(r, p.code)!) }}
            </span>
            <span>{{ liters(lineOf(r, p.code)?.tankEnd ?? 0) }}</span>
            <span>{{ liters(lineOf(r, p.code)?.delivery ?? 0) }}</span>
            <span :class="volCls(lineVariance(r, p.code))">
              {{ lineVariance(r, p.code) > 0 ? "+" : "" }}{{ liters(lineVariance(r, p.code)) }}
            </span>
          </div>
        </div>

        <p v-if="r.notes" class="note">{{ r.notes }}</p>

        <div class="recalc-flag">
          <span v-if="recomputing.has(r.id)" class="flag flag-recompute">↻ 收入与差异已重算</span>
          <span v-else-if="dOf(r)" class="flag flag-cached">= 保留上次结果</span>
          <span class="version">v{{ r.version }}</span>
        </div>

        <div class="actions">
          <button
            type="button"
            :disabled="r.status === 'approved' || !isNextInChain(r) || store.sendingCount > 0"
            @click="approve(r)"
          >
            {{ r.status === "rejected" ? "重新复核通过" : "复核通过" }}
          </button>
          <button
            type="button"
            class="secondary"
            :disabled="r.status === 'rejected' || store.sendingCount > 0"
            @click="reject(r)"
          >
            驳回
          </button>
          <button type="button" class="secondary" @click="store.startEdit(r.natKey)">修订</button>
        </div>
        <p v-if="r.status !== 'approved' && !isNextInChain(r)" class="guard-hint">
          前序班次尚未通过：本班通过后销量才会计入总收入与起始罐存，请先复核前一班。
        </p>
      </article>
    </div>
  </section>
</template>
