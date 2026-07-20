# Design — AI 论文阅读插件

> 配套 `prd.md`。本文是技术设计，定架构、模块边界、数据流、契约、关键取舍。

## 1. 技术选型

| 关注点 | 选型 | 理由 |
|---|---|---|
| 构建 | Vite 5 + `vite-plugin-singlefile` | 产出单个自包含 `dist/index.html`，CSS/JS/worker 全内联 |
| 框架 | **原生 ES Modules，无前端框架** | 单 HTML 体积优先；状态简单，框架是过度工程 |
| PDF 渲染+提取 | `pdfjs-dist` v4 | 同一个库既渲染原版（左栏）又提取文本（中栏），不引两套 |
| Markdown | `marked` | 流式友好的 MD→HTML |
| 公式 | `katex` | 仅右栏；字体惰性加载 |
| 存储 | `localStorage`（JSON） | 设置项持久化 |
| AI 协议 | OpenAI 兼容 `/v1/chat/completions`（SSE 流式） | 用户自填 Base URL + Key |

**关键技术约束**：`pdfjs-dist` 的 worker 必须能在单 HTML 内联后正常工作 → 用 `worker: { format: 'es' }` + `viteSingleFile` 的 `assetsInlineLimit` 大值把 worker 也内联（或用 `pdfjs-dist` 的 `?worker&inline` 形式）。这是**最高风险点**，实现期需优先验证。

## 2. 目录结构

```
AIEssayReader/
├── index.html                 # Vite 入口 HTML（三栏骨架 + 拖拽区）
├── package.json
├── vite.config.js             # singlefile 内联配置
├── src/
│   ├── main.js                # 入口：装配各模块、绑定全局事件
│   ├── styles.css             # 全局样式（三栏布局、各面板）
│   ├── pdf/
│   │   ├── extract.js         # 文本提取（getTextContent），保留页/段结构
│   │   └── render.js          # 原版渲染（pdf.js viewer 简化版，左栏）
│   ├── ai/
│   │   ├── provider.js        # provider 抽象接口：{ chat(messages, opts) -> AsyncIterable<string> }
│   │   ├── openai.js          # OpenAI 兼容实现（fetch + SSE 解析流式）
│   │   ├── client.js          # 高层：summarize/explainConcepts/critique/chat，封装上下文装配
│   │   └── prompts.js         # 全局风格指令(GLOBAL_STYLE) + 四任务中文模板
│   ├── state/
│   │   ├── store.js           # 极简 store：{ paper, settings, messages, get/set/subscribe }
│   │   └── context.js         # 滑窗裁剪：装配 [system+论文, ...recentN轮]
│   ├── ui/
│   │   ├── layout.js          # 三栏布局、拖拽落区
│   │   ├── dropzone.js        # 拖拽 + 文件选择
│   │   ├── pdfPane.js         # 左栏
│   │   ├── textPane.js        # 中栏（选中文本→追问）
│   │   ├── aiPane.js          # 右栏：tab（总结/概念/质疑）+ 对话
│   │   ├── settings.js        # 设置面板（modal）
│   │   └── render.js          # Markdown + KaTeX 渲染（流式节流）
│   └── config/
│       ├── storage.js         # localStorage 读写 + 默认值
│       └── defaults.js        # 默认 Base URL 示例、模型示例、温度等
└── .trellis/                  # （已存在）
```

## 3. 模块边界与依赖方向

依赖严格单向，避免循环：

```
main.js
  └─> ui/*  ──> state/store.js ──> ai/client.js ──> ai/openai.js (provider)
                                     │                   │
                                     └─> ai/context.js   └─> ai/provider.js (接口)
                                     └─> ai/prompts.js
ui/*  ──> pdf/extract.js, pdf/render.js
ui/*  ──> ui/render.js (MD+KaTeX)
所有 ──> config/storage.js, config/defaults.js
```

- `provider.js` 只定义接口；`openai.js` 实现它。新增 Anthropic 等只需加一个实现文件。
- `client.js` 是 UI 唯一调用 AI 的入口；UI 不直接碰 fetch。
- `context.js` 集中处理滑窗，`client.js` 调它装配 messages。
- `store.js` 是唯一状态源；UI 订阅它渲染。

## 4. 数据流（典型路径）

**加载论文**：
```
dropzone 收到 PDF → main 触发 → pdf/extract.js + pdf/render.js 并行
  → 写入 store.paper { meta, pages: [{text, items}], raw }
  → store 通知 → pdfPane/textPane 重渲染
```

**点"总结"**：
```
aiPane 按钮 → client.summarize()
  → context.assemble({ task: 'summarize' })  // system=论文全文+总结模板
  → openai.chat(messages, { stream:true })    // AsyncIterable<string>
  → render.js 边收边节流渲染到"总结"tab      // KaTeX 在流结束后/分块渲染
```

**对话**：
```
aiPane 输入 → client.chat(userText)
  → 把 userText 入 store.messages
  → context.assemble({ task:'chat' })  // system=论文全文, 历史=滑窗后最近N轮
  → openai.chat stream → 渲染 assistant 消息
```

**中栏选中文本追问**：
```
textPane 选中 → 弹"追问"按钮 → client.chat(`关于这段：\n<引用>\n我的问题是…`)
```

## 5. 关键契约

### provider 接口（`ai/provider.js`）
```js
// 所有 provider 实现这个形状
createProvider({ baseUrl, apiKey, model, temperature })
  -> {
       // 流式：yield 每个 token 片段（字符串）
       async *chat(messages, { signal }) -> AsyncIterable<string>,
       // 可选非流式（一次性返回全文）
       async chatOnce(messages, { signal }) -> string,
     }
```

### store 形状（`state/store.js`）
```js
{
  paper: null | {
    name, meta: { title?, authors?, nPages },
    fullText,                 // 拼接全文，注入 AI 上下文用
    pages: [{ pageNum, text }],
  },
  settings: { baseUrl, apiKey, model, temperature },
  messages: [                 // 对话历史（仅 chat 用）
    { role:'user'|'assistant', content }
  ],
  ui: { activeTab, busy }
}
```

### context 装配（`ai/context.js`）
```js
// 输入任务类型，输出 OpenAI messages 数组
assemble({ task, paper, messages, recentN=8 })
  -> [
       { role:'system', content: <GLOBAL_STYLE + 论文全文 + 任务模板> },
       ...recentN 轮 messages,    // 超出 recentN 的旧轮被裁剪
     ]
```
注意：`summarize/概念/质疑` 这类一次性任务不走 `messages` 历史，只发 system+单条 user 指令；只有 `chat` 才累积历史并滑窗。

**提示词分层**（`prompts.js` 导出两层）：
- `GLOBAL_STYLE` —— **平台级**，强制前置到 system 最前，用户不可改。承载输出质量约束：
  1. 非必要不使用比喻句；若使用，须再三考量比方是否恰当、是否会造成误导。
  2. 解释专业术语时，同时给出**官方专业定义**（严谨）与**生动、简明扼要的通俗解释**（易懂）。
- `SUMMARIZE / EXPLAIN_CONCEPTS / CRITIQUE / CHAT` —— **任务级**模板，后期可开放用户自定义。
- 装配顺序固定为 `GLOBAL_STYLE → 论文全文 → 任务模板`：即便用户改写任务模板，全局风格仍生效。

## 6. 关键取舍与风险

1. **pdf.js worker 内联进单 HTML（高风险）**：必须用 ES worker + `assetsInlineLimit` 大值或 `?worker&inline`。**实现第一步就验证**：能不能在单 HTML 下成功渲染+提取。失败则降级为 `disableWorker`（主线程跑，慢但能用）。
2. **流式渲染性能**：marked+KaTeX 不能每 token 全量重渲染。策略：流式过程中以纯文本/轻量 MD 增量 append，KaTeX 与重排放在节流（~80ms）或流结束后。`render.js` 统一封装这个逻辑。
3. **滑窗裁剪阈值**：`recentN` 默认 8 轮；同时按 token 估算（每千字符≈当量）设硬上限，避免论文本身就很长时叠加历史爆上下文。超限时丢最旧轮，保留 system（含论文）。
4. **CORS**：浏览器直连第三方 OpenAI 兼容端点，多数提供商（OpenAI/DeepSeek/OpenRouter）支持 CORS；部分自建 vLLM 可能需要用户侧配 CORS。文档里说明，不强行解决。
5. **Key 安全**：存 localStorage 明文（本地工具可接受），但 UI 永不回显明文、不外传除目标 Base URL 外的任何地方。
6. **无框架的代价**：手写 DOM 更新。用极简 `subscribe + 渲染函数`模式，状态简单时可接受；若后续功能膨胀再评估引入 Preact。

## 7. 不做（明确排除，避免 scope creep）

- 不做多 provider 并存切换 UI（接口预留，MVP 只暴露 OpenAI 兼容配置项）。
- 不做向量检索/RAG。
- 不做 PDF 标注/编辑/导出。
- 不做用户系统/云同步。

## 8. 兼容性 / 迁移

- 全新项目，无迁移。浏览器目标：最近两年的 Chrome/Edge/Firefox（需 ES modules + top-level await + 可选 `File System Access`）。
- `dist/index.html` 通过 `file://` 协议直接打开需验证：pdf.js worker、fetch 到 AI 端点（https）在 file:// 下是否受限——若有问题，文档提示用本地静态服务器（`npm run preview` 或任意静态服务器）。
