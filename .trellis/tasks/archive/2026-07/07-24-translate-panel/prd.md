# 翻译面板：文献中译

## Goal

在右栏 AI 面板新增一个与「总结 / 概念 / 质疑 / 对话」并列的第五个 tab——「翻译」。
点击「生成」后，把当前加载的论文全文翻译成中文，流式显示在面板内，并可像其它分析 tab 一样保存为 Markdown / PDF。

## Background

- 右栏四 tab 全部定义在 `src/ui/aiPane.js`：一个 `TABS` 数组驱动 tab 按钮，三个一次性分析 tab（总结/概念/质疑）共用工厂 `renderAnalyzeTab(id,label,desc)`，对话 tab 独立。
- 一次性任务的数据流：`aiPane.runAnalyze` → `client.<task>()` → `client.runOneShot(task)` → `context.assemble({task})` → `provider.chat` 流式。`assemble` 对非 chat 任务返回 `[system, 单条 user 触发指令]`，system = `GLOBAL_STYLE → 论文全文 → 任务模板`。
- 提示词分层：`prompts.js` 内置 `GLOBAL_STYLE`（不可改）+ 4 个任务模板（用户可在设置面板「提示词模板」tab 自定义，存 `settings.promptXxx`，空串回退内置默认）。
- 用户已选定交互形态：**整篇一次性翻译**（复用总结/概念/质疑的一次性生成模式，架构最省力）。

## Requirements

### 功能需求

- R1 右栏出现第五个 tab「翻译」，与现有四 tab 并列、同一行排布；默认不激活（首次进入仍是「总结」）。
- R2 在「翻译」tab 点「生成」→ 对当前论文全文做中文翻译，结果流式显示在面板结果区；流式期间禁用「生成」、显示「停止」。
- R3 翻译是**忠实的全文翻译**：保留原文的章节结构/标题层级（Markdown 标题对应原文标题），逐段翻译正文，不得缩写、概括或漏译。
- R4 **公式 / 代码 / 引用记号保持原样**：LaTeX 数学（`$...$` / `$$...$$`）、代码块、图表编号、引用标记（如 `[12]`、`\cite{}`）一律不翻译、不改写，原样保留在译文中对应位置。
- R5 专业术语首次出现时给出「中文（original term）」形式，与 `GLOBAL_STYLE` 第 3 条一致；后续可只用中文。
- R6 翻译结果可保存：点「保存」弹出与其它分析 tab 相同的下载对话框（.md / .pdf、文件名、直接下载 / 选择路径），导出内容含译文与论文标题。
- R7 与现有交互一致：未配置 reading 模型 / 未加载论文 / API 出错 / 用户点停止 → 在「翻译」tab 内清晰报错或停止，绝不静默。
- R8 「翻译」的提示词模板可在设置面板「提示词模板」tab 编辑、恢复默认（与现有 4 个模板同等待遇）；空串回退内置默认。

### 约束

- C1 **复用一次性任务模式**：翻译走 `runOneShot('translate')`，不引入对话历史、不新建消息存储，不改 `assemble` 的装配顺序。
- C2 沿用项目约定（见 `.trellis/spec/frontend/project-patterns.md`）：原生 ES Modules、BEM 类名、单 `styles.css`、`[data-theme="dark"]` 暗色覆盖、JSDoc、不引入新依赖、模块单向依赖（`ai/` 只依赖 `state/store`）。
- C3 **零新增 CSS**：翻译 tab 复用 `renderAnalyzeTab` 与既有 `.ai-tab` / `.ai-pane__section` / `.ai-result` 样式；`.ai-tabs` 用 `flex:1 1 0`，第五个 tab 自动均分，无需新规则。
- C4 tab 顺序：一次性任务 tab 聚在一起，chat 留最后 → 「总结 / 概念 / 质疑 / 翻译 / 对话」。
- C5 不破坏既有四 tab 与设置面板（含提示词模板编辑、API Key 不回显明文等）的任何行为。
- C6 `Task` 联合类型、`Settings` typedef、`ui.activeTab` 联合、各处 JSDoc 一并扩到 `translate` / `promptTranslate`，保持类型自洽。

## Acceptance Criteria

- [ ] AC1 右栏出现第五个 tab「翻译」，五 tab 同行均分排布；首次进入仍默认「总结」。
- [ ] AC2 「翻译」tab 点「生成」→ 中文译文流式出现；流式中「生成」禁用、「停止」可见。
- [ ] AC3 译文保留原文标题层级与段落结构，逐段翻译、无概括/漏译。
- [ ] AC4 译文中 LaTeX 公式（`$...$`/`$$...$$`）、代码块、图表编号、引用标记原样保留、未被翻译或改写；公式能被面板正常渲染（KaTeX）。
- [ ] AC5 专业术语首次出现为「中文（原文）」形式。
- [ ] AC6 「保存」弹出下载对话框，选 .md / .pdf 均能导出含译文的文件，文件名含论文标题与「翻译」标签。
- [ ] AC7 未填 Key / 未加载论文 / API 错时，「翻译」tab 内显示清晰中文错误；点「停止」能中断流式。
- [ ] AC8 设置面板「提示词模板」tab 出现「翻译提示词」可编辑块，支持改写、恢复默认、实时预览；保存后下次「翻译」生效；留空回退内置默认。
- [ ] AC9 既有四 tab（总结/概念/质疑/对话）行为完全不变；设置面板其余字段（模型配置、字号、其它 4 个提示词）不受影响。
- [ ] AC10 暗色模式下「翻译」tab 样式正常；窄屏（≤960px）下面板仍可用。
- [ ] AC11 `npm run build` 通过，无控制台报错。

## Notes

- **已知限制（接受）**：整篇一次性翻译受模型单次最大输出 token 限制，超长论文（如 20+ 页）译文可能被截断；流式渲染会显示已返回部分。本期不做分块/续译（用户已确认选最简形态）。后续可按章节分块翻译再拼接。
- 关键技术点（design.md 详述）：`translate` 作为新的 `Task` 贯穿 prompts → context → client → defaults → storage → settings → aiPane 七处；TRANSLATE 提示词需显式约束「公式/代码/引用原样保留」，否则模型易改写数学或漏公式。
- 既有 `render.js` 的 LaTeX 定界符归一化（`\(\)`/`\[\]` → `$`/`$$`）在显示层兜底，译文即使含 `\(\)` 也能正确渲染；但提示词仍要求模型用 `$` 形式输出，双保险。
