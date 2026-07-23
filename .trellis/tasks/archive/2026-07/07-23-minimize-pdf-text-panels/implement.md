# Implement — 原文PDF与文字提取版面最小化

> 配套 `design.md`。按顺序执行，每步含验证。回滚点：每个文件独立提交粒度。

## 执行清单

### Step 1 — index.html：加 header 结构
- 在 `#pane-pdf` 内、`[data-empty]` 之前插入 `.pane__header`（标题「原文 PDF」+ 按钮 `data-pane="pdf"`）。
- 在 `#pane-text` 内、`[data-empty]` 之前插入 `.pane__header`（标题「文字提取」+ 按钮 `data-pane="text"`）。
- **验证**：`npm run dev` 打开页面，两栏顶部出现标题与「－」按钮（未加样式前可能朴素，无报错即可）。

### Step 2 — styles.css：展开态 header + 暗色
- 新增 `.pane__header` / `.pane__title` / `.pane__min-btn` / `.pane__min-btn:hover`（按 design §7）。
- `.pane--pdf .pane__header` 深底浅字变体。
- `[data-theme="dark"]` 下 header / 按钮 hover 覆盖。
- **验证**：宽屏下 header 排版正常，亮/暗主题切换无破样。

### Step 3 — src/ui/paneCollapse.js：核心模块（新增）
实现（按 design §4 §5）：
- 常量 `COLLAPSED_W=36`、`GUTTER_W=6`、`BREAKPOINT=960`。
- 模块级 `const minimized = new Set()`（仅 'pdf'|'text'）。
- `applyLayout()`：读 `loadPaneRatios()`、重分配、写行内 `style.width`、切换 `.pane--minimized`、切换所有 `.pane-gutter--disabled`。窄屏/`containerW===0` 早退。
- `togglePane(key)`、`restorePane(key)`：宽屏守卫 + 改 Set + `applyLayout()`；同步按钮 `textContent`（－/＋）。
- `initPaneCollapse()`：绑定 `.pane__min-btn` click（stopPropagation + toggle）、header click（最小化态 restore）、`window.resize`（防抖 120ms：窄屏且有最小化 → 清空+apply；宽屏且有最小化 → apply）。幂等。
- JSDoc 注释，与项目风格一致。
- **验证**：暂未接入 main.js，先用浏览器 console 手动 `import` 调用 `initPaneCollapse()` 不可行（模块），故本步验证留到 Step 5 接入后统一验证。

### Step 4 — paneResize.js + main.js：协调与接入
- `paneResize.js`：`bindGutter` 的 mousedown 与 dblclick 各加 `if (gutterEl.classList.contains('pane-gutter--disabled')) return;`。
- `main.js`：
  - import `{ initPaneCollapse } from './ui/paneCollapse.js'`。
  - 在 `initPaneResize()` 之后调用 `initPaneCollapse()`。
  - 修改 `panePdf` 的 click 监听（约 382 行）：忽略 `.pane__header` 来源、忽略最小化态。
- **验证**：见 Step 5。

### Step 5 — styles.css：最小化竖条态 + 分隔条禁用 + 窄屏
- `.pane--minimized`、`.pane--minimized .pane__header`（纵向 writing-mode）、隐藏非 header 子元素。
- `.pane-gutter--disabled` / `:hover`。
- 窄屏 `@media`：隐藏 `.pane__min-btn`。
- 暗色覆盖竖条/禁用分隔条。
- **验证（浏览器手测，对照 AC）**：
  - AC1/AC2/AC3：分别最小化 PDF、文字，竖条出现、其余栏加宽。
  - AC4：两栏同时最小化，AI 占满。
  - AC5：点竖条恢复，比例回到原值。
  - AC6：最小化态拖分隔条无反应。
  - AC8：拖窗口到 ≤960px，「－」消失、自动恢复展开。
  - AC9：暗色下竖条/按钮可读。
  - AC10：拖入 PDF 渲染、文本提取、选中追问、AI 面板、设置、主题切换均正常；点 header 不误开文件选择器。
  - AC7：刷新页面三栏正常展开。

### Step 6 — 构建 + 全量回归
- `npm run build` 通过、无控制台报错。
- 浏览器打开 `dist/index.html`（或 dev）复查关键路径。

## 验证命令

```bash
npm run dev      # 开发预览，手测各 AC
npm run build    # 构建必须通过（AC11）
```

（项目无 lint/test 脚本，质量校验以 `build` + 浏览器手测为准。）

## 回滚点

- 每个文件改动独立；如某步出问题，回退该文件即可。
- 最小化状态不持久化，刷新即恢复——天然的安全回退。

## Review Gates

- 接入前（Step 3 完成后）：自检 `applyLayout` 数学与非最小化路径不改变默认三栏表现。
- Step 5 完成后：逐条核对 AC1–AC11。
