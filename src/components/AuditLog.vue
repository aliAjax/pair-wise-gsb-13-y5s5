<script setup lang="ts">
import { useLedgerStore } from "../store";

const store = useLedgerStore();
</script>

<template>
  <section class="panel audit-panel">
    <div class="panel-head">
      <h2>记账流水</h2>
      <button type="button" class="secondary small-btn" @click="store.resetAll()">重置演示数据</button>
    </div>
    <ul v-if="store.audit.length" class="audit-list">
      <li v-for="e in store.audit" :key="e.id" :class="`audit-${e.kind}`">
        <span class="audit-time">{{ e.time }}</span>
        <span>{{ e.text }}</span>
      </li>
    </ul>
    <p v-else class="muted">操作与重算事件会显示在这里。</p>
  </section>
</template>
