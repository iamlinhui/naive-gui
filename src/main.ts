import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";

const app = createApp(App).use(createPinia());

/**
 * 全局渲染错误兜底。
 * 关键:一旦注册 errorHandler,Vue(dev 模式)就不会在组件渲染异常时把错误
 * 二次抛出——否则 flushJobs 会中途终止、同一轮队列里排在后面的组件更新被
 * 全部跳过,表现为整个界面"点不动"。(prod 不二抛,但该崩溃仍会毁掉子树渲染,
 * 所以真正的修复在 ServerForm 的 auth 访问器;此处保证余树永远存活 + 可见提示。)
 * 提示条用纯 DOM 注入,不依赖主渲染树,主树即使部分失效也可见。
 */
app.config.errorHandler = (err, _instance, info) => {
  console.error("[ui-error]", info, err);
  try {
    let el = document.getElementById("ui-fatal");
    if (!el) {
      el = document.createElement("div");
      el.id = "ui-fatal";
      el.style.cssText =
        "position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:99999;" +
        "background:#d03050;color:#fff;padding:7px 16px;border-radius:6px;" +
        "font:12px/1.6 system-ui,sans-serif;max-width:80vw;box-shadow:0 4px 16px rgba(0,0,0,.3)";
      document.body.appendChild(el);
    }
    el.textContent = `界面异常:${err instanceof Error ? err.message : String(err)}`;
    window.setTimeout(() => el?.remove(), 6000);
  } catch {
    /* DOM 兜底自身失败则静默 */
  }
};

app.mount("#app");