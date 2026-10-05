import { createServer } from "vite";
import { renderToString } from "vue/server-renderer";
import { createSSRApp } from "vue";
import { createPinia } from "pinia";
import ElementPlus, { ID_INJECTION_KEY } from "element-plus";

// SSR 冒烟：localStorage 垫片 + 全新 pinia 引导，验证页面无渲染期异常。
// 注：el-table 单元格内容只在客户端渲染，故此处只校验表格外的结构与文案。
(globalThis as any).localStorage = new (class {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
})();

const vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
try {
  const { default: App } = await vite.ssrLoadModule("/src/App.vue");
  const app = createSSRApp(App);
  app.use(createPinia());
  app.use(ElementPlus);
  app.provide(ID_INJECTION_KEY, { prefix: 1024, current: 0 });
  const html = await renderToString(app);
  const checks: [string, boolean][] = [
    ["待复核标签", html.includes("待复核")],
    ["正式总收入", html.includes("正式总收入")],
    ["无断点时不显示续做横幅", !html.includes("从断点继续")],
    ["正式起始罐存列头", html.includes("正式起始罐存")],
    ["油品卡片", html.includes("92#汽油")],
    ["补录表单", html.includes("断网补录交接单")],
    ["幂等键提示", html.includes("幂等键")],
    ["规则说明", html.includes("受影响班次重算")]
  ];
  let bad = 0;
  for (const [name, ok] of checks) {
    console.log(ok ? `  ✓ ${name}` : `  ✗ ${name}`);
    if (!ok) bad++;
  }
  process.exit(bad ? 1 : 0);
} finally {
  await vite.close();
}
