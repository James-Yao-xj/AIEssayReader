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
  settings: {
    recognition: { baseUrl, apiKey, model, temperature },  // 文本识别模型（vision.js 消费）
    reading:     { baseUrl, apiKey, model, temperature },  // 文本阅读模型（client.js 消费）
    promptSummarize, promptExplainConcepts, promptCritique, promptTranslate, promptChat,  // 提示词模板
  },
  messages: [{ role:'user'|'assistant', content }],
  ui: { activeTab, busy: boolean, quickAsk: string|null },
}
```

> **历史**：2026-07-21 前 settings 是扁平结构 `{baseUrl, apiKey, model, temperature}`。拆分为 recognition/reading 两个独立 `ModelConfig` 组，各自可配置不同厂商/密钥/模型。旧数据由 `storage.js` 的 `migrateFromFlat()` 自动迁移——旧值同时复制到两组。

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

### Settings 字段（2026-07-21：拆分为识别/阅读两组）

```js
// store.settings — 两组独立模型配置 + 4 个提示词模板
{
  recognition: { baseUrl, apiKey, model, temperature },  // 文本识别模型（vision.js 消费）
  reading:     { baseUrl, apiKey, model, temperature },  // 文本阅读模型（client.js 消费）
  promptSummarize,        // 用户自定义"综述"模板（空串 = 用内置默认）
  promptExplainConcepts,  // 用户自定义"概念解释"模板
  promptCritique,         // 用户自定义"批判质疑"模板
  promptChat,             // 用户自定义"对话"模板
}
```

> **迁移**：旧版扁平格式 `{baseUrl, apiKey, model, temperature, prompt*}` 由 `storage.js` 的 `loadSettings()` 自动检测并迁移。检测条件：顶层存在 `baseUrl` 且无 `recognition`/`reading` 嵌套对象。迁移时旧值同时复制到两组，结果静默写回 localStorage。迁移后两组初始相同，用户可按需改为不同模型。

### 旧数据迁移模式（storage.js）

localStorage 数据结构变更时，在 `loadSettings()` 中实现检测 + 迁移 + 静默写回：

```js
// 检测旧格式：顶层有 baseUrl 且无 recognition/reading 嵌套
if (typeof parsed.baseUrl === 'string' && !parsed.recognition && !parsed.reading) {
  return migrateFromFlat(parsed);
}

function migrateFromFlat(old) {
  const result = deepCopyDefaults(); // 以默认值为底
  // 旧值同时复制到两组
  ['recognition', 'reading'].forEach((group) => {
    if (typeof old.baseUrl === 'string')     result[group].baseUrl = old.baseUrl;
    if (typeof old.apiKey === 'string')      result[group].apiKey = old.apiKey;
    if (typeof old.model === 'string')       result[group].model = old.model;
    if (typeof old.temperature === 'number' && Number.isFinite(old.temperature))
      result[group].temperature = old.temperature;
  });
  // 提示词也一起搬
  ['promptSummarize','promptExplainConcepts','promptCritique','promptChat'].forEach((k) => {
    if (typeof old[k] === 'string') result[k] = old[k];
  });
  // 静默写回（失败不阻塞——内存中结果仍可用）
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(result)); } catch {}
  return result;
}
```

迁移要点：
- **只迁移一次**：检测旧格式 → 合并 → 写回新格式 → 下次读取直接走新格式分支
- **深合并**：嵌套对象（recognition/reading）做子字段级合并，不会因用户存了一个字段而丢失其他默认字段
- **静默失败**：写回 localStorage 失败不抛错（隐私模式/配额超限），内存中的迁移结果仍然可用
- **以默认值为底**：`deepCopyDefaults()` 保证新字段有默认值，只覆盖用户实际填过的字段

### 滑窗规则（context.js）

- `summarize/explainConcepts/critique/translate`：只发 `[system, 单条user触发指令]`，不走 messages 历史
- `chat`：system + 最近 `recentN*2` 条消息（user/assistant 成对），避开 assistant 孤儿
- 字符预算：`MAX_TOTAL_CHARS=100k`，超预算继续从最旧丢，始终保留 system
- 新建任务不要改装配顺序；自定义提示词走任务模板层，不碰 GLOBAL_STYLE

### 翻译类提示词约束（TRANSLATE 的关键陷阱）

新增「整篇翻译」是一次性任务模式的又一实例（`runOneShot('translate')`，复用 `assemble` 非 chat 分支）。真正易错的是**提示词本身**：翻译时模型倾向把 `$E=mc^2$` 里的变量「翻译」成中文、重排公式、或漏掉公式。TRANSLATE 提示词必须用强约束规避：

- **单独成节、祈使句 + 举例**列明「原样保留、不得翻译改写」：数学公式（行内 `$...$`、块级 `$$...$$`，公式内部一字不改）、代码块/行内代码、图表编号标号、参考文献引用标记（`[12]`、`(Author, year)`、`\cite{...}`）。
- 明确要求**输出用 `$` 形式**（不要 `\(\)`/`\[\]`），与 render.js 数学扩展匹配；显示层 `normalizeLatexDelimiters` 兜底作双保险。
- 翻译是**忠实全文**：逐段翻译、保留标题层级、不得概括/缩写/漏译。

> 已知限制：整篇一次性翻译受模型单次最大输出 token 限制，超长论文（20+ 页）译文可能被截断；分块续译需处理术语一致性与块边界，属更大改动。

### 新增一次性任务的并行插槽清单

新增一个一次性任务（如 translate）需贯通七处并行插槽，**零新增 CSS、零新增依赖**，且不修改既有任务的任何代码路径：

1. `ai/prompts.js`：`export const <TEMPLATE>`；文件头模板清单补一行。
2. `ai/context.js`：import + `TASK_TEMPLATES[task]` + `Task` 联合。`assemble()` 无需改（非 chat 分支自动适用）。
3. `ai/client.js`：`export function <task>(signal){ return runOneShot('<task>', signal); }` + `getPromptTemplates()` 返回项 + 相关 JSDoc。
4. `config/defaults.js`：import + `Settings` typedef `prompt<Task>` + `DEFAULT_SETTINGS`。
5. `config/storage.js`：`deepMergeSettings` + `migrateFromFlat` 各加一行 per-field 合并。
6. `ui/settings.js`：`DEFAULT_TEMPLATES` + 第 N 个 `.settings-field--prompt` 块（须含 `name`/`data-prompt-textarea`/`data-target`/`data-preview` 四者，靠现有按 name 的事件委托自动获得恢复默认/预览/保存，无需新增绑定）+ `syncFormFromStore` + `save()` 收集与 `newSettings`。
7. `ui/aiPane.js`：`TABS`（一次性 tab 聚拢、chat 留最后）+ `savedResults` + `TAB_LABEL` + `renderAnalyzeTab` 调用 + `runAnalyze` ternary 新增分支 + 各处 `Task` JSDoc/cast。
8. `state/store.js`：`ui.activeTab` 联合扩成员（默认值不变）。

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

### 定界符归一化（关键陷阱）

marked 数学扩展**只识别 `$`（行内）与 `$$`（块级）**，但很多模型（Claude / DeepSeek / Qwen / GLM 等 OpenAI 兼容模型）即便提示词要求用 `$`，仍经常输出 `\(x^2\)` / `\[E=mc^2\]`。这些会原样当文本显示，表现为「对话/分析里公式不渲染」。

`render.js` 的 `toHtml` 在 `marked.parse` **之前**调 `normalizeLatexDelimiters`，把 `\( ... \)` → `$ ... $`、`\[ ... \]` → 独占行的 `$$ ... $$`：

```js
function normalizeLatexDelimiters(md) {
  // 块级：两侧强制 \n\n 成独占行（满足块级扩展的行首要求）
  md = md.replace(/\\\[(.+?)\\\]/gs, (_, body) => `\n\n$$${body.trim()}$$\n\n`);
  // 行内：非贪婪，不跨行
  md = md.replace(/\\\((.+?)\\\)/g, (_, body) => `$${body}$`);
  return md;
}
```

为什么在字符串层做、而不是写 marked 扩展去识别 `\(\)`：marked 会先把 `\(` 当转义字符吃掉，tokenizer 阶段拿不到原始 `\(`；字符串层替换最可靠。块级归一化时强制换行，是为了避开块级扩展「必须行首单独成行」的要求——模型常把 `$$x$$` 写在段落中间导致匹配失败。

### 错误做法

- ❌ 每 token 都 `katex.renderToString` + `innerHTML = ...`（CPU 卡死）
- ❌ 遍历 DOM 正则匹配 `$...$` 做替换（正确做法是用 marked 扩展在 parse 阶段处理）
- ❌ 假设模型一定遵守提示词里「用 `$` 输出公式」的要求（必须归一化 `\( \)` / `\[ \]`，否则大量模型输出不渲染）

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

## 7. 三栏拖拽调整宽度（paneResize.js）

### 宽度模型

放弃 CSS flex 固定比例，改用 JS 控制的百分比宽度：

```js
// 默认比例（PDF/文本/AI），总和 ~99%，留 ~1% 给 gutter
const DEFAULT_RATIOS = [36, 30, 33];
```

每个 `.pane` 设 `flex: 0 0 auto` + `style.width = 'xx%'`。两条 6px 的 `.pane-gutter` 占据剩余空间。

### 拖拽事件流

```
mousedown on gutter (e.button === 0)
  → 记录 startX、两侧 pane 当前 width%、container.clientWidth
  → document 绑定 mousemove + mouseup
  → body: userSelect=none, cursor=col-resize
  → gutter 加 .pane-gutter--dragging

mousemove
  → deltaPct = (e.clientX - startX) / containerWidth * 100
  → leftPct = leftStart + deltaPct; rightPct = rightStart - deltaPct
  → 约束: both >= max(15%, 200px / containerWidth * 100)
  → 约束后保持 total = leftStart + rightStart（另一边吸收差值）
  → 更新两侧 pane.style.width

mouseup
  → 解绑 document 事件，恢复 body 样式，移除 dragging class
  → savePaneRatios(ratios) 持久化到 localStorage
```

### 持久化

```js
// storage.js
const RATIO_KEY = 'aie:pane-ratios';
loadPaneRatios()   // → [36, 30, 33]（默认 fallback）
savePaneRatios(ratios) // → boolean
```

与 `aie:settings` 分离，互不干扰。加载时验证：必须是长度为 3 的数组，每项为正有限数。

### 响应式

窄屏 `@media (max-width: 960px)`：
- `.pane-gutter { display: none; }`
- `.pane { width: 100% !important; flex: 1 1 auto; }`
- JS 中 `mousedown` / `dblclick` 守卫 `window.innerWidth <= 960` 不响应

### 错误做法

- ❌ 用 flex 比例做拖拽目标（flex-basis 受内容影响，不准）
- ❌ 事件绑在 gutter 自身上（鼠标快速移动会脱离元素）
- ❌ 不 guard `e.button !== 0`（右键/中键误触发拖拽）
- ❌ 拖拽中频繁读 `container.clientWidth`（窗口 resize 时不变，拖拽开始时读一次即可）

### 协作：最小化期间精确禁用分隔条

「原文 PDF」「文字提取」两栏支持最小化（`src/ui/paneCollapse.js`）。最小化时**只禁用紧邻最小化竖条的分隔条**（拖它无意义，竖条宽度固定），其余分隔条照常可拖，以便用户调整剩余两栏占比：

- 布局 `[pdf] gutter[0] [text] gutter[1] [ai]`，分隔条 `i` 左右栏索引为 `i` / `i+1`。
- paneCollapse 给「左栏或右栏处于最小化」的分隔条加 `.pane-gutter--disabled`。
- `paneResize.js` 的 `mousedown` / `dblclick` 各加一句守卫跳过禁用分隔条：

```js
if (gutterEl.classList.contains('pane-gutter--disabled')) return;
```

### 协作：持久化感知最小化（防基准比例污染）

最小化栏的行内宽度是固定像素（`36px`），不是百分比。`mouseup` 持久化时若直接 `parseFloat` 三栏，会把 `36px` 当 `36%` 存进 `aie:pane-ratios`，污染基准比例且恢复后总和溢出容器。因此 `paneResize.readCurrentRatios` 改为最小化感知：

- 最小化栏 → 取基准 `loadPaneRatios()[i]`（保留其展开后的绝对占比）。
- 非最小化栏 → 取当前百分比。
- 归一化：最小化栏保持基准绝对值，仅缩放非最小化栏使三栏总和回到 `DEFAULT_RATIOS` 总和（约 99）。

效果：拖拽剩余两栏后恢复被最小化栏，用户的占比调整按相对比例保留，且三栏仍填满容器。

---

## 8. 版面最小化（paneCollapse.js）

### 关注点分离

最小化与拖拽共享「栏宽」这一关注点，但通过**单向依赖**解耦、不引入共享可变状态：

- `paneCollapse` **读** `storage.loadPaneRatios()` 作基准比例（paneResize 每次拖拽结束都会 `savePaneRatios`，始终 fresh）；
- `paneCollapse` **只写**行内 `style.width`（瞬态，不持久化最小化状态）；
- `paneCollapse` 给分隔条加 `.pane-gutter--disabled`，`paneResize` 据此跳过拖拽。

### 布局算法（百分比仍是唯一模型）

最小化的栏写固定像素宽（`COLLAPSED_W = 36`），其余栏按基准比例瓜分剩余像素，再换算回 `%`：

```
fixedW = minimized.size * 36 + 2 * 6(两条 gutter)
freeW  = containerW - fixedW
baseSumNonMin = Σ base[i] for 非最小化栏 i   （为 0 则取 1 防除零）
非最小化栏 i:  width% = (base[i] / baseSumNonMin) * freeW / containerW * 100
最小化栏:      width = 36px
```

非最小化栏宽度之和 = freeW，加固定部分恰填满容器。

### DOM/CSS 契约

- 每个 pane 第一个子元素是 `.pane__header`（`.pane__title` + `.pane__min-btn[data-pane]`）。
- 最小化态：pane 加 `.pane--minimized`；CSS 用 `.pane--minimized > :not(.pane__header) { display:none }` 仅留标题栏，标题栏 `writing-mode: vertical-rl` 转纵向，形成竖条。
- 点竖条（标题栏）恢复：header click 仅当所在 pane 处于 `.pane--minimized` 时 restore。
- 「－/＋」文案在 JS 切换 `textContent`（不用纯 CSS，因为按钮既要点又要换提示）。

### 不持久化 + 响应式

- 最小化状态只存模块内 `Set`（运行期），刷新后 `loadPaneRatios()` 返回用户最后拖拽的比例，三栏正常展开。
- 窄屏（≤960px）：resize 守卫 `minimized.size === 0 时直接 return`（让百分比自然伸缩）；窄屏 `@media` 用 `!important` 的 `width:100%` 覆盖行内宽度，`.pane__min-btn { display:none }` 隐藏按钮；跨断点时 `minimized.clear()` 自动恢复全部展开。

### 错误做法

- ❌ 最小化状态持久化（刷新后突兀地只剩竖条）——明确只存内存。
- ❌ 最小化时把所有分隔条都禁用（剩余两栏无法调整占比）——应只禁紧邻竖条的分隔条。
- ❌ 持久化时对最小化栏 `parseFloat('36px')` 当百分比（污染基准比例、恢复后溢出）——`readCurrentRatios` 须最小化感知并归一化。
- ❌ 最小化栏用百分比而非固定像素（剩余栏无法精确瓜分）。
- ❌ PDF 空态点击监听不守卫 `.pane__header`（点「－」会误开文件选择器）。

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
│   ├── paneResize.js    三栏拖拽调整宽度
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
- 三栏默认比例 36% / 30% / 33%，由 `paneResize.js` 初始化时设置 `style.width`；`flex: 0 0 auto` 防止内容撑破
- 分隔条（`.pane-gutter`）：6px 宽，`col-resize` 光标，hover 变蓝（`#0d6efd`），拖拽中加深（`#0b5ed7`）
- 窄屏 960px 断点 → `flex-direction: column` 堆叠，gutter 隐藏，pane 宽度重置
- PDF 左栏背景 `#525659`（深色模拟阅读器）；AI 右栏 `#fafbfc`
- KaTeX 公式块：`overflow-x: auto`（防长公式撑爆布局）

---

## 9. PDF 原版渲染：懒加载 + Ctrl+滚轮局部缩放（render.js）

### 倍率模型（关键：不能"只改 scale"）

canvas 默认 CSS 是 `.pane--pdf canvas { max-width:100%; height:auto }`（适应栏宽）。若只把 pdf.js 的 renderScale 调大，位图虽变大但被 `max-width:100%` 压回栏宽 → **视觉尺寸不变，缩放失效**；若直接取消 max-width，默认（未缩放）就会超出栏宽。

解法：以「适应栏宽」为 1× 基准，按 `userZoom` 重渲染并**显式设定显示宽度**：

```js
const baseVp   = page.getViewport({ scale: 1 });
const contentW = Math.max(1, container.clientWidth - 2 * PAD_PX); // PAD_PX=16 对齐 .pane__scroll padding
const fitScale = contentW / baseVp.width;        // 刚好填满栏宽的倍率
const viewport = page.getViewport({ scale: fitScale * userZoom });
canvas.width  = Math.round(viewport.width);      // 位图宽 = 显示宽（1:1，文字锐利）
canvas.height = Math.round(viewport.height);
canvas.style.width    = viewport.width + 'px';   // 显式显示宽
canvas.style.maxWidth = 'none';                  // 行内覆盖 CSS 的 max-width:100%
```

- `userZoom=1`：显示宽 = contentW → 等价「适应栏宽」，默认体验不变。
- `userZoom>1`：显示宽 > contentW → 超出栏宽，`.pane__scroll { overflow:auto }` 出滚动条。
- CSS 的 `max-width:100%` **保留**作降级兜底（行内 `maxWidth:none` 优先级更高，无需删 CSS 规则）。

### 可重渲染的懒加载（renderedZoom Map）

单一 `rendered: Set` 不够（缩放后已渲染页需重渲染）。改用 **per-page 记录上次渲染时的 userZoom**：

```js
const renderedZoom = new Map(); // pageNum -> 渲染时的 userZoom
if (renderedZoom.get(num) === zoom) return;       // 幂等：zoom 不匹配才渲染
// ...await page.render...
if (userZoom === zoom) renderedZoom.set(num, zoom); // 仅当 userZoom 仍是本次目标时才标记
```

- 「仅当 `userZoom === zoom` 才写」防止 `await page.render()` 期间 userZoom 再变导致 **stale 写入**（否则旧 zoom 被记下，后续跳过本应发生的重渲染）。
- IO 回调照旧调 renderPageInto：可见页 zoom 不匹配就重渲染，匹配则跳过。

### 局部 Ctrl+滚轮缩放（防浏览器整页缩放）

```js
container.addEventListener('wheel', onWheel, { passive: false }); // 必须非 passive 才能 preventDefault
const onWheel = (e) => {
  if (!e.ctrlKey && !e.metaKey) return; // 非 Ctrl 放行，保留普通滚动（绝不 preventDefault）
  e.preventDefault();                    // 每个 Ctrl tick 都 preventDefault（即便节流未触发渲染）
  // nextZoom = clamp(userZoom × step^dir)；leading+trailing 节流（≈80ms）调 applyZoom
};
```

- 监听绑在 **container（`#pdf-scroll` 滚动容器）**，绝不绑 `window`/`document`（否则影响其它栏）。
- 缩放逻辑全部封装在 render.js 内（`cleanup` 一并 `removeEventListener` + 清 trailing timer）；main.js 只消费返回 handle 的 `setZoom/getZoom`——满足 `pdf/` 不依赖 `ui/`。
- 切换 PDF 时 main.js 先调旧 handle 的 `cleanup()` 再建新闭包（userZoom 重置 1.0、新监听绑定），无跨文件泄漏。

### 向光标处缩放（锚点）

```js
// 重渲染【前】记录
f = clamp((e.clientY - canvasRect.top) / canvasRect.height, 0, 1); // 光标在锚定页内的纵向比例
viewportY = e.clientY - container.getBoundingClientRect().top;       // 光标在容器视口内的 y
// 更新 userZoom → await 重渲染【可见页】→ 重算 scrollTop（用重排后真实 getBoundingClientRect）
holderTopInScroll = anchoredHolder.getBoundingClientRect().top - containerRect.top + container.scrollTop;
container.scrollTop = max(0, holderTopInScroll + f * newH - viewportY);
```

- **非可见页不即时重渲染**（保留旧 canvas → 高度不变 → 上方位移稳定 → 锚点准），等滚动进入视口由 IO 按当前 userZoom 补渲染。
- 用重排后真实 `getBoundingClientRect` 算 `holderTopInScroll`，自动吸收「上方可见页也被重渲染导致的高度变化」，无需枚举哪些页重渲染过。
- 找不到锚定页（光标在 padding/间隙）→ 跳过锚点、保持当前 scrollTop（可接受的降级，不抛错）。

### 错误做法

- ❌ wheel 监听用默认 passive（无法 preventDefault，整页仍被浏览器缩放）。
- ❌ 非 Ctrl 也 preventDefault（破坏普通滚动与可访问性）。
- ❌ 只改 renderScale 不动 CSS max-width（放大被压回栏宽，缩放失效）。
- ❌ 用 CSS transform 缩放 canvas（不撑布局 → 无滚动条、被裁切；位图不足时发虚）。
- ❌ 缩放即清空/全量重渲染所有页（性能爆炸 + 锚点 offsetTop 失稳）。
- ❌ 把 wheel 监听绑 `window`/`document`（影响其它栏）；或缩放逻辑泄漏到 main.js（违反单向依赖）。
