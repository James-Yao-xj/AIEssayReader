# Implement — 三栏可拖拽调整宽度

> 配套 `prd.md` + `design.md`。按顺序执行，每步可独立验证。

## 实现顺序

### Step 1 — 新建 `src/ui/paneResize.js`
- [x] 实现 `initPaneResize()` 函数
  - 在 `index.html` 的 `.app-main` 中插入两个 `.pane-gutter` 元素
  - 从 localStorage 加载比例（`loadPaneRatios()`），无则用默认 `[36, 30, 33]`
  - 给三个 `.pane` 设初始 `style.width = 'xx%'`
- [x] 实现 `bindGutter(gutterEl, leftPane, rightPane, ratioIndex)` 拖拽绑定
  - mousedown：记录起始位置 + 两侧 pane 当前宽度百分比，document 绑定 mousemove/mouseup
  - mousemove：计算 delta，应用最小宽度约束（200px / 15%），更新两侧 pane width
  - mouseup：解绑事件，恢复样式，持久化
- [x] 实现双击重置逻辑
- [x] 实现 `savePaneRatios()` / `loadPaneRatios()` 持久化函数
- [x] **验证 M1**：`npm run build` 通过，新模块可被 main.js 引用

### Step 2 — 集成到 main.js + 调整 HTML/CSS
- [x] `index.html`：在三个 pane 之间插入 gutter div
- [x] `main.js`：调用 `initPaneResize()`
- [x] `styles.css`：添加 `.pane-gutter` 样式（宽度、hover/active 态、cursor）、响应式隐藏、pane 改为 `flex: 0 0 auto`
- [x] **验证 M2**：浏览器中两条分隔条可见，hover 变蓝 + 光标变 col-resize

### Step 3 — 端到端验证
- [x] 拖拽分隔条，两侧栏实时调整，第三栏不受影响
- [x] 拖到最小宽度（200px）时停止缩小
- [x] 双击重置为默认比例
- [x] 刷新页面，比例保持
- [x] 窄屏（≤960px）分隔条隐藏
- [x] **验证 M3**：`npm run build` 产出单 HTML；全功能 walkthrough

## 风险点 / 回滚

- **百分比宽度 vs flex 冲突**：pane 改为 `flex: 0 0 auto` 后，依赖 flex 伸缩的其他布局可能受影响。回滚：如果三栏不再等分视口，检查 `.app-main` 是否仍为 `display: flex`，pane 是否设了正确的 width 百分比。
- **窄屏 gutter 隐藏后 pane 宽度**：用 `!important` 覆盖 JS 设置的 inline width，确保堆叠布局不受影响。
- **分隔条宽度占用**：约 4~6px，两条合计 ~10px，在百分比计算中需减去。如果影响较大（极窄窗口），可设 gutter 为 `position: absolute` 浮于 pane 接缝之上，不占布局空间。
