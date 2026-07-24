# Implement — 翻译面板：文献中译

> 配套 `design.md`。改动是「把第五个一次性任务贯通七处并行插槽」，按数据流自底向上执行（提示词 → 装配 → 客户端 → 默认值 → 持久化 → 设置 UI → 面板 UI → 类型）。每步含验证。零新增 CSS、零新增依赖。

## 执行清单

### Step 1 — prompts.js：新增 TRANSLATE 模板

- 在 `CRITIQUE` 与 `CHAT` 之间新增 `export const TRANSLATE = \`...\``，内容取 design §3 全文（强约束：逐段忠实翻译、公式/代码/引用原样保留、术语「中文（原文）」、输出 `$...$`/`$$...$$`、遵守 GLOBAL_STYLE）。
- 文件头注释（lines 5-11 区）的模板清单补「TRANSLATE：任务级中文翻译模板」。
- **验证**：`npm run build` 通过；无语法错。

### Step 2 — context.js：注册 translate 任务

- import 列表（lines 15-21）加 `TRANSLATE`。
- `TASK_TEMPLATES`（line 33-38）加 `translate: TRANSLATE,`。
- `Task` 联合（line 41）改为 `'summarize' | 'explainConcepts' | 'critique' | 'translate' | 'chat'`。
- 不改 `assemble`（非 chat 分支自动适用）。
- **验证**：`npm run build` 通过。

### Step 3 — client.js：新增 translate 流式入口

- 镜像 `summarize`（lines 95-97），在 `critique` 后新增：
  ```js
  export function translate(signal) {
    return runOneShot('translate', signal);
  }
  ```
- `getPromptTemplates()`（line 29-34）返回对象加 `translate: settings.promptTranslate,`；其 JSDoc 返回类型联合（line 25）加 `translate`。
- `runOneShot` 的 `task` 参数 JSDoc（line 79）联合加 `translate`。
- 文件头注释（line 8）的导出清单加 translate。
- **验证**：`npm run build` 通过。

### Step 4 — defaults.js：默认提示词

- import（lines 9-14）加 `TRANSLATE`。
- `Settings` typedef（lines 26-34）加 `@property {string} promptTranslate 翻译论文的提示词模板。`（promptChat 后）。
- `DEFAULT_SETTINGS`（lines 57-60 区）加 `promptTranslate: TRANSLATE,`。
- **验证**：`npm run build` 通过。

### Step 5 — storage.js：持久化对齐

- `deepMergeSettings`（line 187 后）加：`if (typeof user.promptTranslate === 'string') result.promptTranslate = user.promptTranslate;`
- `migrateFromFlat`（line 224 后）加：`if (typeof old.promptTranslate === 'string') result.promptTranslate = old.promptTranslate;`
- **验证**：`npm run build` 通过。

### Step 6 — settings.js：第 5 个提示词编辑块

- import（lines 21-26）加 `TRANSLATE`。
- `DEFAULT_TEMPLATES`（line 30-35）加 `promptTranslate: TRANSLATE,`。
- 提示词 tab（line 240 「对话提示词」块之后）新增第 5 个 `.settings-field--prompt` 块，结构与现有 4 块逐字一致，关键字段：
  - `<span class="settings-field__label">翻译提示词</span>`
  - `<textarea name="promptTranslate" rows="12" spellcheck="false" data-prompt-textarea></textarea>`
  - `<button type="button" class="settings-field__reset" data-target="promptTranslate">恢复默认</button>`
  - `<div class="settings-field__preview-content md-body" data-preview="promptTranslate"></div>`
- `syncFormFromStore`（line 406 后）加：`setFieldValue('promptTranslate', settings.promptTranslate || DEFAULT_TEMPLATES.promptTranslate);`
- `save()`：在 line 627 后加 `const promptTranslate = String(fd.get('promptTranslate') || '').trim();`，并在 `newSettings`（line 673-681）加 `promptTranslate,`。
- **验证**：`npm run dev` → 打开设置 → 提示词 tab 出现「翻译提示词」块；编辑后预览实时更新；点「恢复默认」回填 TRANSLATE；保存后重开设置值仍在。

### Step 7 — aiPane.js：注册「翻译」tab

- `TABS`（line 23-28）在 critique 与 chat 之间加 `{ id: 'translate', label: '翻译' },`。
- `savedResults`（line 37-41）加 `translate: '',`。
- `TAB_LABEL`（line 44-49）加 `translate: '翻译',`。
- `initAiPane` 的 `.ai-body`（line 442 critique 块与 line 443 chat 块之间）加：
  `${renderAnalyzeTab('translate', '翻译', '把论文全文忠实翻译成中文，保留公式/代码/结构与引用标记。')}`
- `runAnalyze` 的 task ternary（lines 654-659）加 translate 分支（见 design §4.7）。
- JSDoc 联合扩到含 `'translate'`：`executeDownload`（line 165）、`buildAnalyzeMarkdown`（line 213）、`showDownloadDialog`（line 289）、`runAnalyze`（line 629）、`bindAnalyzeButtons` 两处 cast（lines 603、617）。
- **验证**：`npm run dev` → 右栏出现第五个 tab「翻译」，五 tab 同行均分；点「生成」流式出译文。

### Step 8 — store.js：扩 activeTab 联合

- `ui.activeTab` 联合（line 28）改为 `'summarize' | 'explainConcepts' | 'critique' | 'translate' | 'chat'`。默认值不变（仍 `'summarize'`）。
- **验证**：`npm run build` 通过。

### Step 9 — 构建 + 全量回归（对照 AC）

- `npm run build` 通过、无控制台报错（AC11）。
- `npm run dev` 浏览器手测：
  - AC1：五 tab 同行均分，默认「总结」。
  - AC2：「翻译」生成流式、停止按钮、禁用态。
  - AC3：译文保留标题层级与段落、无概括。
  - AC4：公式 `$...$`/`$$...$$`、代码块、引用标记原样保留且 KaTeX 正常渲染。
  - AC5：术语「中文（原文）」。
  - AC6：保存 → .md/.pdf 导出，文件名含标题与「翻译」。
  - AC7：未填 Key/未加载论文/API 错 → tab 内报错；停止能中断。
  - AC8：设置「翻译提示词」可编辑/恢复默认/预览/持久化。
  - AC9：既有四 tab 与设置其余字段不受影响。
  - AC10：暗色模式 + 窄屏（≤960px）正常。

## 验证命令

```bash
npm run dev      # 开发预览，手测各 AC
npm run build    # 构建必须通过（AC11）
```

（项目无 lint/test 脚本，质量校验以 `build` + 浏览器手测为准。）

## 回滚点

- 全部为新增并行插槽，不修改既有四任务代码路径。
- 任一步出问题可单独回退该文件；还原 7 文件即彻底移除翻译 tab。
- localStorage 多出的 `promptTranslate` 被安全忽略，不影响其它字段。

## Review Gates

- Step 1-5 后（AI 层 + 配置层）：`npm run build` 通过；translate 已贯通 prompts→context→client→defaults→storage。
- Step 6 后：设置面板第 5 块功能完整（编辑/恢复默认/预览/保存）。
- Step 7-8 后：tab 出现、生成可流式、类型自洽。
- Step 9 后：逐条核对 AC1-AC11。
