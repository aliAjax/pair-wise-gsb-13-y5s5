<script setup lang="ts">
import { computed } from "vue";
import { useLedgerStore } from "../store";

const store = useLedgerStore();
const items = computed(() => store.outbox);

const STATE_TEXT: Record<string, string> = {
  queued: "排队等待",
  sending: "写入中…",
  conflict: "冲突待处理",
  done: "已完成",
  failed: "失败·可续传"
};

function actionText(a: string): string {
  return a === "submit" ? "交接单" : a === "approve" ? "复核通过" : "驳回";
}
</script>

<template>
  <section class="panel outbox-panel">
    <div class="panel-head">
      <h2>断网箱 · 写入断点</h2>
      <span v-if="items.length" class="chip chip-off">{{ items.filter((i) => i.state !== 'done').length }} 笔待续传</span>
    </div>
    <p class="muted">
      每次写入先落 WAL 预写日志再落库；断网或中途失败的单子存在这里，网络恢复后从断点继续，重复补录只计一次。
    </p>

    <div v-if="items.length === 0" class="empty small">断网箱为空，所有写入均已落库</div>
    <ul v-else class="outbox-list">
      <li v-for="i in items" :key="i.txnId" class="outbox-item" :class="`st-${i.state}`">
        <div>
          <strong>{{ actionText(i.action) }} {{ i.natKey }}</strong>
          <span class="outbox-state">{{ STATE_TEXT[i.state] }}</span>
          <button
            v-if="i.state === 'conflict'"
            type="button"
            class="link-btn reopen-link"
            @click="store.reopenConflict(i.txnId)"
          >
            处理冲突
          </button>
        </div>
        <div class="outbox-meta">
          <span>尝试 {{ i.attempts }} 次</span>
          <span v-if="i.lastError" class="outbox-err">{{ i.lastError }}</span>
        </div>
      </li>
    </ul>

    <button v-if="store.pendingOutbox.length" type="button" :disabled="store.sendingCount > 0" @click="store.flush()">
      立即续传
    </button>
  </section>
</template>
