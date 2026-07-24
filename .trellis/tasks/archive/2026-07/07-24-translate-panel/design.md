# Design — 翻译面板：文献中译

> 配套 `prd.md`。本文聚焦技术方案、契约与权衡。执行步骤见 `implement.md`。

## 1. 问题拆解

新增「翻译」本质是**把第五个一次性任务贯通现有七处**：提示词模板 → 上下文装配 → AI 客户端 → 默认值 → 持久化 → 设置 UI → 面板 UI。每一处都已有为 summarize/explainConcepts/critique 写好的并行插槽，translate 只是再插一份。难点不在代码量，而在：

1. **TRANSLATE 提示词**：必须显式约束模型保留公式/代码/引用/结构，否则翻译时极易改写 LaTeX 或漏公式（见 §3）。
2. **类型自洽**：`Task` 联合与 `ui.activeTab` 联合贯穿多文件，新增成员需同步所有 JSDoc，否则 IDE/类型检查不一致。
3. **设置面板的并行块**：`settings.js` 的提示词 tab 是 4 个手写 `.settings-field--prompt` 块（非循环生成），需照葫芦画瓢加第 5 个，并在 `syncFormFromStore` / `save` / `DEFAULT_TEMPLATES` 三处对齐。

## 2. 数据流（复用一次性任务管线，零新增架构）

```
用户在「翻译」tab 点「生成」
  → aiPane.runAnalyze('translate')
       （runAnalyze 的 ternary 增加 translate 分支 → client.translate(signal)）
  → client.translate → runOneShot('translate')
  → context.assemble({ task:'translate', paper, templates })
       非 chat 分支 → [system, 单条 user 触发指令]
       system = GLOBAL_STYLE → 论文全文 → TRANSLATE 模板
  → provider.chat 流式 → createStreamingRenderer 边收边渲染
  → 完成后 savedResults['translate'] = 全文（供保存）
```

与 summarize 唯一的区别：task 字符串 `'translate'` 与对应的 TRANSLATE 模板。`assemble` 的非 chat 分支自动适用，**无需改装配逻辑**。

## 3. TRANSLATE 提示词设计（最关键）

翻译类提示词的最大坑：模型会把 `$E=mc^2$` 里的 `E`「翻译」成中文、或重排公式、或丢掉公式。TRANSLATE 必须用强约束规避：

```
# 当前任务：把论文全文翻译成中文

请把给定论文**完整、忠实地**翻译成简体中文。要求：

## 翻译范围与忠实度
- 逐段翻译正文，保留原文的章节结构与标题层级（原文几级标题，译文就几级）。
- 不得概括、缩写、改写或漏译；不得添加原文没有的内容。
- 译文为完整全文，不是摘要。

## 必须原样保留、不得翻译或改写的内容
- 数学公式：行内 `$...$`、块级 `$$...$$`。公式内部一字不改（变量名、上下标、运算符均保持原文）。
- 代码块（```...```）与行内代码 `...`：原样保留。
- 图/表的编号与标题中的标号（如「图 3」「Table 2」）按中文习惯呈现，但公式记号不变。
- 参考文献引用标记（如 [12]、(Smith et al., 2020)、\cite{...}）原样保留在译文中对应位置。

## 术语处理
- 专业术语首次出现给「中文译名（original term）」；后续重复可用中文。
- 无公认中文译名的术语保留原文，必要时括注说明。

## 格式
- 输出 Markdown；公式一律用 `$...$` / `$$...$$`（不要用 \( \) / \[ \]）。
- 遵守 GLOBAL_STYLE 的全部风格规范。
```

设计要点：
- 「必须原样保留」单独成节、用祈使句 + 举例，降低模型改写概率。
- 明确要求 `$...$` 形式（与 render.js 数学扩展匹配）；即使模型仍偶发输出 `\(\)`，显示层归一化兜底（见 prd Notes）。
- 不再重复 GLOBAL_STYLE 的「慎用比喻/双重解释」全文，只引用「遵守 GLOBAL_STYLE」，避免 system 过长重复。

## 4. 模块改动边界（7 文件，逐处对齐现有并行插槽）

### 4.1 `src/ai/prompts.js`

- 新增 `export const TRANSLATE = \`...\``（§3 全文），放在 `CRITIQUE` 与 `CHAT` 之间或 `CHAT` 之前，保持「一次性任务模板」聚合。
- 文件头注释的模板清单补「TRANSLATE：任务级中文翻译模板」。

### 4.2 `src/ai/context.js`

- import 列表加 `TRANSLATE`。
- `TASK_TEMPLATES` 加 `translate: TRANSLATE`。
- `Task` 联合加 `'translate'`：`'summarize' | 'explainConcepts' | 'critique' | 'translate' | 'chat'`。
- `assemble` 无需改（非 chat 分支 `return [system, user触发指令]` 自动适用 translate）。

### 4.3 `src/ai/client.js`

- 新增 `export function translate(signal) { return runOneShot('translate', signal); }`（镜像 `summarize`，lines 95-97）。
- `getPromptTemplates()` 返回对象加 `translate: settings.promptTranslate`；其 JSDoc 返回类型联合加 `translate`。
- `runOneShot` 的 `task` 参数 JSDoc 联合加 `translate`。

### 4.4 `src/config/defaults.js`

- import 加 `TRANSLATE`。
- `Settings` typedef 加 `@property {string} promptTranslate 翻译论文的提示词模板。`（置于 promptChat 后）。
- `DEFAULT_SETTINGS` 加 `promptTranslate: TRANSLATE,`。

### 4.5 `src/config/storage.js`

- `deepMergeSettings`：在 4 个 `prompt*` 合并行后加 `if (typeof user.promptTranslate === 'string') result.promptTranslate = user.promptTranslate;`
- `migrateFromFlat`：在 4 个 `prompt*` 搬运行后加 `if (typeof old.promptTranslate === 'string') result.promptTranslate = old.promptTranslate;`
- （旧数据本就不会有 promptTranslate，但保持与其它字段一致的搬运模式，防御性。）

### 4.6 `src/ui/settings.js`

- import 加 `TRANSLATE`。
- `DEFAULT_TEMPLATES` 加 `promptTranslate: TRANSLATE`。
- 提示词 tab：在「对话提示词」块后（或「批判质疑」与「对话」之间）新增第 5 个 `.settings-field--prompt` 块，`name="promptTranslate"`、`data-target="promptTranslate"`、`data-preview="promptTranslate"`，结构与现有 4 块逐字一致。
- `syncFormFromStore` 加 `setFieldValue('promptTranslate', settings.promptTranslate || DEFAULT_TEMPLATES.promptTranslate);`
- `save`：加 `const promptTranslate = String(fd.get('promptTranslate') || '').trim();`，并加入 `newSettings` 对象。

> 「恢复默认」按钮（事件委托 `.settings-field__reset` + `data-target`）与实时预览（`textarea[data-prompt-textarea]` 事件委托）都是**按 name/data-target 通用**的，无需新增绑定逻辑——新块自动获得这两个能力。`refreshAllPreviews` 用 `querySelectorAll('textarea[data-prompt-textarea]')` 也是通用的，自动覆盖新 textarea。

### 4.7 `src/ui/aiPane.js`

- `TABS` 数组加 `{ id: 'translate', label: '翻译' }`（置于 critique 与 chat 之间，满足 C4）。
- `savedResults` 加 `translate: ''`。
- `TAB_LABEL` 加 `translate: '翻译'`。
- `initAiPane` 的 `.ai-body`：在 critique 的 `renderAnalyzeTab` 与 `renderChatTab()` 之间加 `${renderAnalyzeTab('translate', '翻译', '把论文全文忠实翻译成中文，保留公式/代码/结构与引用标记。')}`。
- `runAnalyze` 的 task ternary（lines 654-659）扩为含 translate 分支：
  ```js
  const iterable =
    task === 'summarize' ? client.summarize(currentController.signal)
    : task === 'explainConcepts' ? client.explainConcepts(currentController.signal)
    : task === 'critique' ? client.critique(currentController.signal)
    : task === 'translate' ? client.translate(currentController.signal)
    : client.critique(currentController.signal); // 理论不可达兜底
  ```
- JSDoc 联合扩到含 `'translate'`：`executeDownload` task 参数（line 165）、`buildAnalyzeMarkdown` task（line 213）、`showDownloadDialog` task（line 289）、`runAnalyze` task（line 629）、`bindAnalyzeButtons` 内两处 cast（lines 603、617）。

### 4.8 `src/state/store.js`

- `ui.activeTab` 联合加 `'translate'`（line 28）。

> 默认值仍是 `'summarize'`（不变），只是联合类型允许 translate。

## 5. 契约不变性

- **装配顺序不变**：system 仍是 `GLOBAL_STYLE → 论文全文 → 任务模板`；translate 不破例。
- **提示词 fallback 链不变**：`settings.promptTranslate`（非空非空白）→ 内置 TRANSLATE → 空串。
- **保存路径不变**：translate 复用 `buildAnalyzeMarkdown`（task='translate' → `TAB_LABEL['翻译']` → 文件名标签「翻译」）与 `executeDownload` 的非 chat 分支。
- **依赖方向不变**：`aiPane → ai/client → ai/context + ai/prompts`；`settings → config/storage + ai/prompts`；无新依赖、无循环。

## 6. 已知限制 / 后续增强

- **超长论文截断**（见 prd Notes）：单次输出 token 上限可能截断译文。本期接受；后续可按 `paper.pages` 或标题分块、多次 runOneShot 续译拼接（会引入分块边界与术语一致性问题，属较大改动）。
- **术语一致性**：一次性翻译内术语通常自洽；若未来分块，需在提示词注入「已确定的术语译名表」。
- **译文不与原文对照**：译文独立显示于面板；原文在中栏。如需左右对照属更大 UI 改动，本期不做。

## 7. 兼容性 / 回滚

- 改动全部是**新增并行插槽**，不修改既有四任务的任何代码路径 → 回归风险低。
- 旧 localStorage 无 `promptTranslate`：`deepMergeSettings` 以 DEFAULT_SETTINGS 为底 → 自动补 `promptTranslate: TRANSLATE`，无迁移负担。
- 回滚：还原 7 文件即移除翻译 tab，localStorage 多出的 `promptTranslate` 字段被 `deepMergeSettings` 安全忽略（不影响其它字段）。

## 8. 反模式（check 时核对）

- ❌ 为 translate 写独立的 `renderTranslateTab` / 独立消息存储 / 改 `assemble` 装配顺序（应复用 `renderAnalyzeTab` + runOneShot）。
- ❌ TRANSLATE 提示词不约束公式/代码/引用保留（模型会改写 LaTeX、漏公式）。
- ❌ 新增 CSS 规则（应复用既有 `.ai-tab`/`.ai-pane__section`）。
- ❌ 只改 `TABS` 不扩 `Task`/`activeTab` 联合与各 JSDoc（类型不自洽）。
- ❌ 设置面板新块漏掉 `data-target`/`data-preview`/`name` 三者之一（导致恢复默认/预览/保存失效）。
- ❌ 把 translate 排在 chat 之后（破坏 C4「一次性 tab 聚拢、chat 最后」）。
