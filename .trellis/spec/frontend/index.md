# Frontend Development Guidelines

> AI 论文阅读插件 · Vite 单 HTML · 原生 ES Modules · 无框架

## Tech Stack

- **构建**：Vite 5 + `vite-plugin-singlefile` → 产出单个自包含 `dist/index.html`
- **语言**：JavaScript（ES Modules），无 TypeScript，无框架
- **PDF**：pdfjs-dist v4（`?worker&inline` 方案内联 worker）
- **Markdown + 公式**：marked（含自定义数学扩展）+ KaTeX（CSS + woff2 字体通过 `assetsInlineLimit` 内联）
- **样式**：手写 CSS（三栏 flex 布局，960px 断点响应式堆叠）
- **AI 协议**：OpenAI 兼容 `/v1/chat/completions`（fetch + 手工 SSE 解析）
- **存储**：localStorage（JSON，设置项持久化）
- **状态**：极简 pub/sub store（`src/state/store.js`）

## Documentation Files

| File | Description | Priority |
|---|---|---|
| [project-patterns.md](./project-patterns.md) | 本项目核心模式：worker 内联、SSE、store、KaTeX、滑窗、流式节流 | **Must Read** |
| [css-design.md](./css-design.md) | CSS 组织、三栏布局、响应式断点 | Reference |
| [code-quality.md](../shared/code-quality.md) | 代码质量标准（跨层共享） | Reference |
| [git-conventions.md](../shared/git-conventions.md) | Git 提交规范 | Reference |

## Architecture Overview

```
main.js (入口：装配全局事件、初始化各面板)
  ├─> ui/aiPane.js     ←→ state/store.js ←→ ai/client.js → ai/openai.js (SSE)
  │                                              → ai/context.js (滑窗)
  │                                              → ai/prompts.js (GLOBAL_STYLE + 任务模板)
  ├─> ui/render.js     (marked + KaTeX 流式节流)
  ├─> ui/settings.js   ←→ config/storage.js (localStorage)
  ├─> ui/textPane.js   (中栏文本 + 选中追问，通过 store.ui.quickAsk 解耦)
  ├─> pdf/extract.js   (pdf.js 文本提取 + worker 配置)
  └─> pdf/render.js    (pdf.js 原版渲染，IntersectionObserver 懒加载)
```

**依赖方向单向**：ui → state/store → ai/client → ai/openai + ai/context + ai/prompts；ui → pdf/；ui → config/。

## Getting Started

1. Read [project-patterns.md](./project-patterns.md) — 核心实现模式
2. `npm run dev` 开发、`npm run build` 产单 HTML
3. 新功能遵循同等风格：原生 JS、中文注释、ESM、pub/sub store 做模块间通信
