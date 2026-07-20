# Design — 三栏可拖拽调整宽度

> 配套 `prd.md`。本文定技术方案：分隔条 DOM 结构、拖拽事件流、宽度计算、持久化。

## 1. DOM 结构

在 `index.html` 的 `<main class="app-main">` 中，于三个 `.pane` 之间插入两个分隔条：

```html
<main class="app-main">
  <section class="pane pane--pdf" id="pane-pdf">...</section>
  <div class="pane-gutter" data-gutter="0" aria-hidden="true"></div>
  <section class="pane pane--text" id="pane-text">...</section>
  <div class="pane-gutter" data-gutter="1" aria-hidden="true"></div>
  <section class="pane pane--ai" id="pane-ai">...</section>
</main>
```

- `data-gutter` 标识第几条分隔条（0 和 1），也映射到 localStorage 中的 ratio 索引。
- `aria-hidden="true"` 声明为纯装饰性元素，不影响无障碍访问。

## 2. 宽度模型

**放弃 flex 固定比例，改用百分比显式宽度。**

原因：flex 比例在拖拽后难以精准控制（flex-basis 计算受内容影响）。改用 `style.width = 'xx%'` 直接控制。

```css
/* 初始值由 JS 设置，CSS 仅保留 fallback */
.pane {
  flex: 0 0 auto; /* 不再参与 flex 伸缩，宽度由 JS 控制 */
  /* width 由 JS 动态设置 */
}
```

**三栏宽度关系**：
```
width_left + gutter_width + width_mid + gutter_width + width_right = 100%
```

初始比例保持现有视觉比例 1.2:1:1.1 → 换算为百分比约 36% / 30% / 33%（留 ~1% 给分隔条）。

## 3. 拖拽事件流

```
mousedown on gutter
  → 记录起始鼠标 X、两侧 pane 当前宽度
  → 在 document 上绑定 mousemove 和 mouseup
  → body 加 user-select: none + cursor: col-resize

mousemove
  → 计算 deltaX = 当前鼠标X - 起始鼠标X
  → 左栏新宽度 = 左栏起始宽度 + deltaX（百分比换算）
  → 右栏新宽度 = 右栏起始宽度 - deltaX
  → 应用最小宽度约束（每栏 ≥ 200px 或 ≥ 15%）
  → 更新两侧 pane 的 style.width

mouseup
  → 解绑 mousemove / mouseup
  → 恢复 body cursor 和 user-select
  → 持久化当前比例到 localStorage
```

**关键细节**：
- 用 `e.clientX` 获取鼠标位置
- 百分比计算基准：`appMain.clientWidth`（拖拽开始时获取一次，拖拽中复用）
- 事件绑定在 `document` 上（非 gutter 自身），防快速移动时鼠标脱离 gutter
- 使用 `passive: false` 对 touch 事件无需求（仅支持鼠标）

## 4. 最小宽度约束

```js
const MIN_WIDTH_PX = 200;
const MIN_WIDTH_PCT = 15; // 百分比，防极窄窗口时 200px 占比过大

// 应用约束
const minPct = Math.max(MIN_WIDTH_PCT, (MIN_WIDTH_PX / containerWidth) * 100);
if (newLeftPct < minPct) newLeftPct = minPct;
if (newRightPct < minPct) newRightPct = minPct;
```

## 5. 持久化

```js
// localStorage key
const RATIO_KEY = 'aie:pane-ratios';
// 存储格式：三个百分比数字的数组，如 [36, 30, 33]（已扣除 gutter 宽度）
// 加载时与默认值合并，防旧数据缺失
const DEFAULT_RATIOS = [36, 30, 33];
```

`storage.js` 新增两个函数：`loadPaneRatios()` / `savePaneRatios(ratios)`，模式与现有 `loadSettings` / `saveSettings` 一致。

## 6. 实现模块

新增文件 `src/ui/paneResize.js`，导出 `initPaneResize()`：

```
main.js 在初始化阶段调用 initPaneResize()
  → 插入 gutter DOM
  → 加载 ratios（localStorage 或默认）
  → 给各 pane 设初始 width
  → 绑定 gutter 的 mousedown 事件
```

不修改 `store.js`（pane 宽度不属于应用状态，不需要跨模块通知），不修改 `ai/`、`pdf/` 层的任何文件。

## 7. 响应式

```css
@media (max-width: 960px) {
  .pane-gutter { display: none; }
  .pane { width: 100% !important; flex: 1 1 auto; }
}
```

窄屏时不初始化/不禁用拖拽逻辑（由 CSS 负责隐藏和重置宽度，JS 中的 mousedown 仍可触发但无视觉效果——通过检测 `window.innerWidth > 960` 做守卫）。

## 8. 边缘情况

| 场景 | 处理 |
|---|---|
| 拖拽中鼠标移出浏览器窗口 | `mousemove` 在 `document` 上，出窗口后无事件，松手在外部 → `mouseup` 不触发 → 下次 mousemove 进入时仍然绑定 → 加 `mouseleave` 兜底或 `mouseup` 在 `window` 监听。实际：`document` 的 mouseup 在外部松手也会触发（浏览器行为）。 |
| 双击重置 | `dblclick` 事件在 gutter 上，恢复 `DEFAULT_RATIOS`，写入 localStorage，更新 pane width。 |
| PDF 未加载时拖拽 | 不影响，拖拽仅改布局，与内容无关。 |
| 极窄窗口（<600px） | 响应式断点 960px 已覆盖，窄屏堆叠、gutter 隐藏。 |
| gutter 被 CSS 覆盖 | `!important` 仅在响应式断点使用，不影响宽屏。 |

## 9. 不做

- 不引入第三方拖拽库（如 split.js）。
- 不做动画/过渡。
- 不存储到 store（仅 localStorage + 直接 DOM 操作）。
- 不支持触摸拖拽（移动端非目标场景，三栏布局本就不适合手机）。
