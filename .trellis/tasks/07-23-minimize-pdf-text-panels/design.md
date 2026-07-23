# Design — 原文PDF与文字提取版面最小化

> 配套 `prd.md`。技术设计：边界、布局算法、DOM/CSS 契约、与 `paneResize.js` 的协调、响应式与暗色。

## 1. 总体方案

新增一个独立模块 `src/ui/paneCollapse.js`，负责最小化/恢复与栏宽重分配。它**读取** `storage.js` 的 `loadPaneRatios()` 作为「基准比例」（始终 fresh，因为 `paneResize.js` 每次拖拽结束都会保存），**只写行内 `style.width`**（瞬态，不持久化最小化状态）。`paneResize.js` 增加一处守卫：分隔条在被禁用时不响应拖拽/双击。

为什么单独成模块而不是塞进 `paneResize.js`：最小化是独立用户能力，逻辑量足够；但两者共享「栏宽」这一关注点，因此通过「`paneCollapse` 读 storage、写行内宽度；`paneResize` 仅在分隔条上加禁用判断」的**单向依赖**解耦，不引入共享可变状态。

## 2. 涉及文件

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `index.html` | 新增结构 | 给 `#pane-pdf`、`#pane-text` 各加一个 `.pane__header`（标题 + 「－」按钮）|
| `src/ui/paneCollapse.js` | **新增** | 最小化/恢复 + 栏宽重分配 + 响应式守卫 |
| `src/ui/paneResize.js` | 小改 | mousedown / dblclick 增加「分隔条禁用则跳过」判断 |
| `src/main.js` | 小改 | 调用 `initPaneCollapse()`；PDF 空态点击选文件的监听忽略来自 header 的点击 |
| `src/styles.css` | 新增样式 | `.pane__header`、`.pane--minimized`、竖条纵向排版、`.pane-gutter--disabled`、窄屏隐藏按钮、暗色覆盖 |

## 3. DOM 契约（index.html）

`#pane-pdf` 与 `#pane-text` 顶部各插入（作为 pane 第一个子元素）：

```html
<div class="pane__header">
  <span class="pane__title">原文 PDF</span>
  <button class="pane__min-btn" type="button" data-pane="pdf"
          title="最小化该版面" aria-label="最小化原文 PDF">－</button>
</div>
```

- `data-pane` 取值 `pdf` / `text`，供 JS 识别。
- 标题文案：PDF 栏用「原文 PDF」，文字栏用「文字提取」。
- header 是 `.pane`（flex column）的第一个 flex item，`flex: 0 0 auto`；其后的空态/滚动区 `flex: 1`，不破坏现有竖向布局。

AI 栏（`#pane-ai`）不加 header（超出范围）。

## 4. 布局算法（paneCollapse.applyLayout）

核心：最小化的栏给固定像素宽，其余栏按基准比例瓜分剩余像素，再换算回 `%` 写入行内 `style.width`。始终用 `%` 作为唯一布局模型，与 `paneResize.js` 一致。

常量：
- `COLLAPSED_W = 36`（最小化竖条像素宽）
- `GUTTER_W = 6`（每根分隔条，共 2 根，与 `styles.css` 一致）

```
base = loadPaneRatios()            // [pdf, text, ai]，始终读最新
containerW = appMain.clientWidth
minimized = 内存中的 Set（仅可能含 'pdf' | 'text'，ai 不可最小化）

nMin = minimized.size
fixedW = nMin * COLLAPSED_W + 2 * GUTTER_W
freeW = max(0, containerW - fixedW)

非最小化栏索引集 N（ai 永远在 N 内）
baseSum = sum(base[i] for i in N)，为 0 则取 1 防除零

对每个 pane i：
  若 i 是 pdf/text 且 minimized 含之：
    style.width = COLLAPSED_W + 'px'
    classList.add('pane--minimized')
  否则：
    wPx = (base[i] / baseSum) * freeW
    style.width = (wPx / containerW * 100) + '%'
    classList.remove('pane--minimized')

分隔条：若有任意栏最小化 → 所有分隔条加 .pane-gutter--disabled；否则移除。
```

非最小化栏宽度之和 = freeW，加固定部分 = containerW，恰好填满（取模舍入误差在 flex 下可忽略）。

## 5. 交互与事件

`initPaneCollapse()`（幂等，由 `main.js` 在 `initPaneResize()` 之后调用）：

1. 绑定每个 `.pane__min-btn` 的 click：
   - `e.stopPropagation()`（避免冒泡到 `#pane-pdf` 的「点空态选文件」监听）。
   - `togglePane(data-pane)`。
2. 绑定每个 header 的 click：仅当所在 pane 处于 `.pane--minimized` 时 → `restorePane(key)`（实现「点竖条本身恢复」，R4）。header click 不 stopPropagation（让 PDF 的文件选择监听能判断来源），但通过下面 main.js 的守卫避免误触。
3. `togglePane(key)`：宽屏守卫（`innerWidth <= 960` 直接 return）→ 在 Set 中增/删 → `applyLayout()`。
4. `restorePane(key)`：从 Set 删除 → `applyLayout()`。
5. `window.resize`（防抖 120ms）：若 `innerWidth <= 960` 且当前有最小化栏 → 清空 Set + `applyLayout()`（自动恢复，满足 AC8）；否则若有最小化栏 → `applyLayout()`（重算以适应新容器宽）。

按钮文案：展开态显示「－」，最小化态显示「＋」（CSS 用 `.pane--minimized .pane__min-btn` 控制 `::after`/文本，或在 JS 里切换 `textContent`）。实现取 JS 切换 `textContent`，简单直接。

`main.js` 现有监听（约 382 行）：
```js
panePdf.addEventListener('click', (e) => {
  if (!currentPdfHandle) openFilePicker();
});
```
改为：
```js
panePdf.addEventListener('click', (e) => {
  if (e.target.closest('.pane__header')) return;   // header 交互不触发选文件
  if (panePdf.classList.contains('pane--minimized')) return; // 最小化态交给恢复逻辑
  if (!currentPdfHandle) openFilePicker();
});
```

## 6. 与 paneResize.js 的协调

`paneResize.js` 的 `bindGutter` 中 mousedown 与 dblclick 各加一行守卫：
```js
if (gutterEl.classList.contains('pane-gutter--disabled')) return;
```
（放在现有 `if (window.innerWidth <= BREAKPOINT) return;` 附近。）

这样最小化期间分隔条完全不响应；`paneCollapse.applyLayout` 已经把栏宽写成正确值，`paneResize` 的拖拽/双击在禁用态不会覆盖。全部恢复后，分隔条重新可拖，且 `style.width` 已是基准比例，拖拽数学（按 `%` 计算）依旧正确。

## 7. CSS 契约（styles.css，BEM）

展开态 header（水平）：
```css
.pane__header {
  flex: 0 0 auto;
  display: flex; align-items: center; justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  font-size: 12px; font-weight: 600;
  background: rgba(0,0,0,0.03);
  border-bottom: 1px solid #e3e6eb;
  user-select: none;
}
.pane__title { /* 颜色随 pane */ }
.pane__min-btn {
  width: 22px; height: 22px; line-height: 1;
  border: none; border-radius: 4px; cursor: pointer;
  background: transparent; color: inherit; font-size: 14px;
}
.pane__min-btn:hover { background: rgba(0,0,0,0.08); }
```

PDF 栏深底特殊处理（`.pane--pdf .pane__header` 用浅色文字 + 半透明深底），文字栏用常规。

最小化态（竖条，纵向）：
```css
.pane--minimized { cursor: pointer; }
.pane--minimized > :not(.pane__header) { display: none; }   /* 隐藏空态/滚动区 */
.pane--minimized .pane__header {
  writing-mode: vertical-rl;        /* 标题纵向 */
  flex: 1 1 auto; height: 100%;
  border-bottom: none; border-right: 1px solid #e3e6eb;
  padding: 10px 4px; justify-content: flex-start;
}
.pane--minimized .pane__title { writing-mode: vertical-rl; }
```

分隔条禁用：
```css
.pane-gutter--disabled { cursor: default; background: #eef0f3; }
.pane-gutter--disabled:hover { background: #eef0f3; }   /* 不高亮 */
```

窄屏（并入现有 `@media (max-width:960px)`）：
```css
.pane__min-btn { display: none; }
.pane--minimized > :not(.pane__header) { display: flex; } /* 最小化态在窄屏不应隐藏内容；JS 已保证窄屏不进入最小化，此处为兜底 */
```

暗色（`[data-theme="dark"]`）：为 `.pane__header`、`.pane__min-btn:hover`、`.pane-gutter--disabled` 补一套深色变量覆盖，沿用文件已有的暗色区块风格。

## 8. 边界与风险

- **行内宽度被 CSS `!important` 覆盖**：窄屏媒体查询里 `.pane { width: 100% !important; }` 会覆盖行内 `style.width`，正是我们想要的（窄屏忽略最小化的像素宽）。但 `.pane--minimized` 类若残留会导致内容被 `display:none`。已用「窄屏自动恢复全部」+「窄屏不进入最小化」双保险规避。
- **比例丢失**：最小化不写 `aie:pane-ratios`，刷新后 `loadPaneRatios()` 返回用户最后拖拽保存的比例，三栏正常展开（满足 AC7）。最小化期间用户无法拖拽（分隔条禁用），故不会把「重分配后的临时比例」误存。
- **容器宽度为 0**：`applyLayout` 在 `containerW` 为 0 时直接 return（初始化时序保护）。
- **`loadPaneRatios` 异常**：已自带兜底返回默认比例，`applyLayout` 无需额外处理。
- **PDF 空态点击选文件**：见 §5 守卫，header 与最小化态点击不再误开文件选择器。

## 9. 不做（Out of Scope）

- AI 栏最小化 / header。
- 最小化状态持久化。
- 最小化/恢复动画（如需后续单独加 transition，当前先功能正确）。
- 拖拽分隔条在最小化期间仍可调整（明确暂停，见 C3）。
