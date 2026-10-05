<script setup lang="ts">
import { reactive, ref, watch } from "vue";
import {
  OPERATORS,
  PRODUCTS,
  SHIFTS,
  blankInput,
  validateInput
} from "../domain";
import { useLedgerStore } from "../store";
import type { HandoverInput } from "../types";

const store = useLedgerStore();

const form = reactive<HandoverInput>(blankInput());
const error = ref("");
const saving = ref(false);

watch(
  () => store.formFill?.token,
  (token) => {
    if (!token || !store.formFill) return;
    const src = store.formFill.input;
    Object.assign(form, {
      date: src.date,
      shift: src.shift,
      operator: src.operator,
      cash: src.cash,
      digital: src.digital,
      lines: JSON.parse(JSON.stringify(src.lines)),
      notes: src.notes,
      source: src.source
    });
  }
);

function line(code: string) {
  return form.lines.find((l) => l.code === code)!;
}

async function save(force = false) {
  error.value = validateInput(form) ?? "";
  if (error.value) return;
  const payload: HandoverInput = JSON.parse(JSON.stringify({ ...form }));
  saving.value = true;
  try {
    await store.submitInput(payload, force);
    if (!store.conflict) {
      Object.assign(form, blankInput());
      store.cancelEdit();
    }
  } finally {
    saving.value = false;
  }
}

async function simulatePeer() {
  error.value = validateInput(form) ?? "";
  if (error.value) return;
  await store.simulatePeer(JSON.parse(JSON.stringify({ ...form })));
}

function cancel() {
  Object.assign(form, blankInput());
  store.cancelEdit();
}

const isEditing = () => store.editingNatKey !== null;
</script>

<template>
  <form class="panel form-panel" @submit.prevent="save(false)">
    <div class="panel-head">
      <h2>{{ isEditing() ? "修订交接单" : "补录交接单" }}</h2>
      <span class="chip" :class="store.online ? 'chip-ok' : 'chip-off'">
        {{ store.online ? "在线直发" : "断网补录·入箱" }}
      </span>
    </div>
    <p v-if="isEditing()" class="edit-banner">
      正在修订 {{ store.editingNatKey }}：已复核单若现金/电子支付或读数变化，会退回待复核并只重算受影响班次。
      <button type="button" class="link-btn" @click="cancel">取消修订</button>
    </p>

    <div class="form-grid">
      <div class="row-2">
        <label>
          交接日期
          <input v-model="form.date" type="date" required />
        </label>
        <label>
          班次
          <select v-model="form.shift">
            <option v-for="s in SHIFTS" :key="s" :value="s">{{ s }}</option>
          </select>
        </label>
      </div>
      <div class="row-2">
        <label>
          值班员
          <select v-model="form.operator">
            <option v-for="o in OPERATORS" :key="o" :value="o">{{ o }}</option>
          </select>
        </label>
        <label>
          录入方式
          <select v-model="form.source">
            <option value="online">在线录入</option>
            <option value="backfill">断网补录（早班同步）</option>
          </select>
        </label>
      </div>

      <div class="row-2">
        <label>
          现金收入（元）
          <input v-model.number="form.cash" type="number" min="0" step="0.01" />
        </label>
        <label>
          电子支付（元）
          <input v-model.number="form.digital" type="number" min="0" step="0.01" />
        </label>
      </div>

      <div v-for="p in PRODUCTS" :key="p.code" class="tank-block">
        <div class="tank-block-head">
          <strong>{{ p.name }}</strong>
          <span>指导价 ¥{{ p.price.toFixed(2) }}/L</span>
        </div>
        <div class="tank-inputs">
          <label>
            泵码起
            <input v-model.number="line(p.code).pumpStart" type="number" min="0" />
          </label>
          <label>
            泵码止
            <input v-model.number="line(p.code).pumpEnd" type="number" min="0" />
          </label>
          <label>
            起始罐存
            <input v-model.number="line(p.code).tankStart" type="number" min="0" step="0.1" />
          </label>
          <label>
            结束罐存
            <input v-model.number="line(p.code).tankEnd" type="number" min="0" step="0.1" />
          </label>
          <label>
            配送入库
            <input v-model.number="line(p.code).delivery" type="number" min="0" step="0.1" />
          </label>
        </div>
      </div>

      <label>
        备注
        <textarea v-model="form.notes" placeholder="现场说明、断网原因、异常描述" />
      </label>

      <p v-if="error" class="form-error">{{ error }}</p>

      <div class="form-actions">
        <button type="submit" :disabled="saving">
          {{ saving ? "写入中…" : isEditing() ? "提交修订" : "保存交接" }}
        </button>
        <button type="button" class="secondary" :disabled="saving" @click="simulatePeer">
          模拟同事先提交
        </button>
        <button v-if="isEditing()" type="button" class="secondary" @click="cancel">取消</button>
      </div>
      <p class="form-hint">
        提示：先点“模拟同事先提交”再保存，可演示两名值班员同时提交同一交接单时后到者看到冲突。
      </p>
    </div>
  </form>
</template>
