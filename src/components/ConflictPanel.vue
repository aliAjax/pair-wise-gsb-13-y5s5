<script setup lang="ts">
import { PRODUCTS, liters, money } from "../domain";
import { useLedgerStore } from "../store";

const store = useLedgerStore();

function diffNum(a: number, b: number): boolean {
  return Math.abs(a - b) > 0.001;
}
</script>

<template>
  <div v-if="store.conflict" class="conflict-mask" @click.self="store.dismissConflict()">
    <div class="conflict-dialog panel">
      <h2>⚠ 提交冲突：{{ store.conflict.natKey }}</h2>
      <p class="conflict-intro">
        另一名值班员已先提交这张交接单。你的输入已完整保留，请选择保留哪一份：
      </p>

      <div class="conflict-cols">
        <div class="conflict-col">
          <h3>先到者（服务端当前）</h3>
          <p class="conflict-who">{{ store.conflict.server.operator }} · v{{ store.conflict.server.version }}</p>
          <ul>
            <li :class="{ diff: diffNum(store.conflict.server.cash, store.conflict.incoming.cash) }">
              现金：<strong>{{ money(store.conflict.server.cash) }}</strong>
            </li>
            <li :class="{ diff: diffNum(store.conflict.server.digital, store.conflict.incoming.digital) }">
              电子支付：<strong>{{ money(store.conflict.server.digital) }}</strong>
            </li>
            <li
              v-for="p in PRODUCTS"
              :key="p.code"
              :class="{
                diff:
                  diffNum(
                    store.conflict.server.lines.find((l) => l.code === p.code)?.tankEnd ?? 0,
                    store.conflict.incoming.lines.find((l) => l.code === p.code)?.tankEnd ?? 0
                  ) ||
                  diffNum(
                    store.conflict.server.lines.find((l) => l.code === p.code)?.pumpEnd ?? 0,
                    store.conflict.incoming.lines.find((l) => l.code === p.code)?.pumpEnd ?? 0
                  )
              }"
            >
              {{ p.name }} 结束罐存：
              <strong>{{ liters(store.conflict.server.lines.find((l) => l.code === p.code)?.tankEnd ?? 0) }}</strong>
            </li>
          </ul>
          <button type="button" class="secondary" @click="store.keepServer(store.conflict!)">
            采用这一份（放弃我的输入）
          </button>
        </div>

        <div class="conflict-col conflict-mine">
          <h3>后到者（你的输入，已保留）</h3>
          <p class="conflict-who">{{ store.conflict.incoming.operator }}</p>
          <ul>
            <li :class="{ diff: diffNum(store.conflict.incoming.cash, store.conflict.server.cash) }">
              现金：<strong>{{ money(store.conflict.incoming.cash) }}</strong>
            </li>
            <li :class="{ diff: diffNum(store.conflict.incoming.digital, store.conflict.server.digital) }">
              电子支付：<strong>{{ money(store.conflict.incoming.digital) }}</strong>
            </li>
            <li
              v-for="p in PRODUCTS"
              :key="p.code"
              :class="{
                diff:
                  diffNum(
                    store.conflict.incoming.lines.find((l) => l.code === p.code)?.tankEnd ?? 0,
                    store.conflict.server.lines.find((l) => l.code === p.code)?.tankEnd ?? 0
                  ) ||
                  diffNum(
                    store.conflict.incoming.lines.find((l) => l.code === p.code)?.pumpEnd ?? 0,
                    store.conflict.server.lines.find((l) => l.code === p.code)?.pumpEnd ?? 0
                  )
              }"
            >
              {{ p.name }} 结束罐存：
              <strong>{{ liters(store.conflict.incoming.lines.find((l) => l.code === p.code)?.tankEnd ?? 0) }}</strong>
            </li>
          </ul>
          <button type="button" @click="store.keepMine(store.conflict!)">
            保留我的输入并覆盖
          </button>
        </div>
      </div>

      <p class="conflict-foot">
        覆盖会把版本对齐到先到者当前版本（v{{ store.conflict.server.version }}）后原子提交，不会出现两边各写一半。
      </p>
    </div>
  </div>
</template>
