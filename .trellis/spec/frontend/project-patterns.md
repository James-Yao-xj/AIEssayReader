# Project Patterns — AI 论文阅读插件

> 核心实现模式。新增功能或修改现有模块时必须遵循。

---

## 1. pdf.js Worker 内联（单 HTML 关键）

### 问题

`vite-plugin-singlefile` 打包后无外部文件，pdf.js worker 必须内联进单 HTML。

### 方案

使用 Vite 的 `?worker&inline` 把 worker 编译为 Blob URL：

```js
// src/pdf/extract.js
import * as pdfjsLib from 'pdfjs-dist';
import PdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&inline';
pdfjsLib.GlobalWorkerOptions.workerPort = new PdfjsWorker();
export { pdfjsLib };
```

render.js 从 extract.js 复用已配置的 pdfjsLib，不再重复创建 worker。

### 验证

build 后 dist/index.html 中搜索 `new Worker(blob,{type:"module"})` 确认内联。grep 命中 `URL.createObjectURL(new Blob` 即确认。

### 错误做法

- ❌ `workerSrc = 'pdfjs-dist/build/pdf.worker.mjs'`（单 HTML 无外部路径）
- ❌ render.js 和 extract.js 各自创建独立 worker（浪费内存）
- ❌ `disableWorker: true`（主线程跑，论文>10页会卡死 UI）

---

## 2. AI Provider 与 SSE 流式解析

### 接口契约

```js
// provider.js — 接口定义（JSDoc）
createProvider({baseUrl, apiKey, model, temperature}) -> {
  async *chat(messages, {signal}) -> AsyncIterable<string>,  // 流式
  async chatOnce(messages, {signal}) -> string,              // 非流式
}
```

### SSE 解析要点（openai.js）

- 端点：`baseUrl.replace(/\/+$/, '') + '/chat/completions'`
- 用 `fetch` + `AbortSignal`，不需第三方 SSE 库
- **手工按行解析**：`data:` 前缀匹配、`line.slice(5).trimStart()` 兼容 `data: `/`data:{"..."}`/`data:\t` 变体
- `data: [DONE]` 终止流
- 每 chunk 取 `choices[0].delta.content`
- `JSON.parse` 失败静默跳过该行（不抛、不中断流）
- `reader.releaseLock()` 在 finally 块

### 错误矩阵

| 条件 | 错误消息格式 |
|---|---|
| fetch 网络失败 | `无法连接到 AI 服务（网络错误）：<details>` |
| AbortError | 透传给调用方（由 UI 转为 "已停止。"） |
| HTTP 401/403 | `API Key 无效或未授权（HTTP {status}）` |
| HTTP 404 | `接口路径不存在（HTTP 404）。请检查 Base URL…` |
| HTTP 429 | `请求被限流（HTTP 429）` |
| HTTP 5xx | `AI 服务端错误（HTTP {status}）` |
| 其他非 2xx | `AI 服务返回错误（HTTP {status}）` |

---

## 3. Store 模式

### 形状

```js
{
  paper: null | { name, meta:{title?,authors?,nPages}, fullText, pages:[{pageNum,text}] },
  settings: { baseUrl, apiKey, model, temperature },
  messages: [{ role:'user'|'assistant', content }],
  ui: { activeTab, busy: boolean, quickAsk: string|null },
}
```

### 操作

- `getState()`：返回当前快照（只读引用，不要直接改字段）
- `setState(partial)`：浅合并顶层字段，触发所有 subscriber
- `subscribe(fn)`：返回取消订阅函数。subscriber 抛出不影响其他 subscriber

### 关键约定

- 修改数组/对象字段时传**新引用**（`setState({messages: [...old, new]})`）
- subscriber 内**可调用 setState**（递归 notify，但需有 guard 防死循环）
- `ui.quickAsk` 用作跨模块解耦桥：textPane 写入 → aiPane subscriber 消费 → 立即置 null

### 错误做法

- ❌ `getState().paper.fullText = '...'`（静默绕过 subscriber）
- ❌ 在 subscriber 中无 guard 地 setState（死循环风险）

---

## 4. AI 上下文装配与提示词分层

### 装配顺序（固定，不可变）

```
system = GLOBAL_STYLE + "\n---\n" + 论文全文 + "\n---\n" + 任务模板
```

GLOBAL_STYLE 始终前置，即使用户自定义了任务模板也不会受影响。

### 提示词分层

```js
// prompts.js — 内置默认模板（始终存在，fallback 用）
export const GLOBAL_STYLE = "…";  // 平台级，用户不可改。含慎用比喻 + 术语双重解释
export const SUMMARIZE = "…";     // 任务级默认模板
export const EXPLAIN_CONCEPTS = "…";
export const CRITIQUE = "…";
export const CHAT = "…";
```

GLOBAL_STYLE 必须包含：① 非必要不用比喻 / 用时考量是否恰当/误导；② 术语解释同时给出官方定义 + 通俗解释。

### 用户自定义模板（2026-07-20 已实现）

用户可在设置面板"提示词模板"标签页中编辑 4 个任务模板。数据流：

```
settings.js (textarea 编辑)
  → saveSettings() → localStorage (aie:settings.promptSummarize 等)
  → loadSettings() → store.settings.promptSummarize 等
  → client.js getPromptTemplates() → {summarize, explainConcepts, critique, chat}
  → context.js assemble({templates}) → taskTemplate = custom || built-in fallback
```

**关键约定：**

1. **fallback 链**：`context.js` 中的 `assemble()` 按三层优先级选择模板：
   ```
   settings.promptXxx (非空非空白) → prompts.js 内置默认模板 → 空串
   ```
   实现：`typeof raw === 'string' && raw.trim() ? raw.trim() : TASK_TEMPLATES[task] || ''`

2. **默认值来源**：`defaults.js` 中 `DEFAULT_SETTINGS.promptSummarize` 等字段 import 自 `prompts.js`，保证首次使用/重置后就是内置模板。

3. **持久化**：`storage.js` 的 `pickKnownFields()` 识别 4 个 `prompt*` 字段（string 类型）；旧数据缺失字段由 `loadSettings()` 中的 `...DEFAULT_SETTINGS` spread 补齐。

4. **"恢复默认"按钮**：settings.js 中从 `prompts.js` import `DEFAULT_TEMPLATES` 映射，点击后用内置模板填充对应 textarea。

5. **空白处理**：保存时 `.trim()` 后再存；空文本/纯空白 → 存为 `""` → `getPromptTemplates()` 中 falsy → `assemble()` 回退到内置默认。

6. **GLOBAL_STYLE 永远不可编辑**：设置面板"提示词模板"tab 顶部仅展示一句声明；`buildSystem()` 始终 `parts.push(GLOBAL_STYLE)` 在最前面。

### Settings 字段（更新后）

```js
// store.settings 新增 4 个字段
{
  baseUrl, apiKey, model, temperature,  // 原有
  promptSummarize,                       // 用户自定义"综述"模板（空串 = 用内置默认）
  promptExplainConcepts,                 // 用户自定义"概念解释"模板
  promptCritique,                        // 用户自定义"批判质疑"模板
  promptChat,                            // 用户自定义"对话"模板
}
```

### 滑窗规则（context.js）

- `summarize/explainConcepts/critique`：只发 `[system, 单条user触发指令]`，不走 messages 历史
- `chat`：system + 最近 `recentN*2` 条消息（user/assistant 成对），避开 assistant 孤儿
- 字符预算：`MAX_TOTAL_CHARS=100k`，超预算继续从最旧丢，始终保留 system
- 新建任务不要改装配顺序；自定义提示词走任务模板层，不碰 GLOBAL_STYLE

### 错误做法

- ❌ 直接修改 `prompts.js` 中的模板来"自定义"（应通过设置面板编辑）
- ❌ 用户自定义模板中尝试覆盖 GLOBAL_STYLE 的规则（GLOBAL_STYLE 始终前置，用户改不了）
- ❌ 保存纯空白提示词不 trim（会导致 `"   "` 被当作有效自定义模板发送给 AI）

---

## 5. 流式渲染 + KaTeX

### Markdown 渲染

```js
// render.js
import { marked } from 'marked';
import katex from 'katex';
import 'katex/dist/katex.min.css';  // Vite 内联 → 单 HTML
```

**用 marked.use 数学扩展**一次性渲染（比遍历 DOM 节点替换更高效）：

```js
marked.use({ extensions: [blockMathExt, inlineMathExt] });
// 每个扩展的 renderer 调 katex.renderToString(latex, {throwOnError:false, displayMode})
```

### 流式节流

```js
const renderer = createStreamingRenderer(element, { intervalMs: 80 });
// push(chunk) → 累积 buffer，有 pending timer 时不重复排
// finalize() → 清 timer，最后一次完整渲染 + 滚到底
```

策略：最多 80ms 一次重渲染（≈12.5 次/秒），远低于 token 粒度。KaTeX 在每次 flush 时和 marked 一起跑（数学扩展已合并到 marked.parse 中）。

### 错误做法

- ❌ 每 token 都 `katex.renderToString` + `innerHTML = ...`（CPU 卡死）
- ❌ 遍历 DOM 正则匹配 `$...$` 做替换（正确做法是用 marked 扩展在 parse 阶段处理）

---

## 6. 跨模块解耦：quickAsk 桥接

textPane（中栏选中追问）和 aiPane（对话 tab）通过 store.ui.quickAsk 解耦：

```
选中文本 → 浮出"追问"按钮 → 点击
  → setState({ ui: { activeTab:'chat', quickAsk: selectedPrompt } })
  → aiPane subscriber 检测 quickAsk && activeTab=='chat'
    → 置 null（防重入）→ 填入输入框 → 自动发送
```

新增类似跨模块功能时，用 store 字段做桥，不要直接 import 对方模块的内部函数。

---

## 7. 文件结构约定

```
src/
├── main.js               入口：全局事件 + 初始化各面板
├── styles.css            全部样式（单文件，按注释分区）
├── pdf/                  PDF 相关（不依赖 ui/ 或 ai/）
├── ai/                   AI 层（不依赖 ui/，只依赖 state/store）
│   ├── provider.js      接口定义
│   ├── openai.js        实现
│   ├── prompts.js       提示词
│   ├── context.js       上下文装配 + 滑窗
│   └── client.js        高层入口（UI 唯一调用 AI 的入口）
├── state/
│   └── store.js         pub/sub store
├── config/
│   ├── defaults.js      默认值
│   └── storage.js       localStorage 读写
├── ui/
│   ├── aiPane.js        右栏 AI 面板
│   ├── render.js        Markdown + KaTeX 渲染
│   ├── settings.js      设置面板 modal
│   └── textPane.js      中栏文本 + 追问联动
└── utils/
    └── errors.js        跨模块共享工具
```

- 模块间 import 必须严格单向，不可循环
- 公共工具放 `src/utils/`
- 一个文件只做一件事；导出函数名清晰、JSDoc 标注类型

---

## 8. 样式约定

- 单文件 `src/styles.css`，按注释分区（顶部条 / 三栏 / 面板 / 表单 / 响应式 / …）
- Class naming：BEM 浅层（如 `.pane__scroll`、`.ai-tab--active`）
- 主色：`#0d6efd`（蓝）、背景 `#f5f6f8`、边框 `#e3e6eb`
- 三栏用 `flex: 1.2 / 1 / 1.1` 比例，`min-width: 0` 防止内容撑破
- 窄屏 960px 断点 → `flex-direction: column` 堆叠
- PDF 左栏背景 `#525659`（深色模拟阅读器）；AI 右栏 `#fafbfc`
- KaTeX 公式块：`overflow-x: auto`（防长公式撑爆布局）
