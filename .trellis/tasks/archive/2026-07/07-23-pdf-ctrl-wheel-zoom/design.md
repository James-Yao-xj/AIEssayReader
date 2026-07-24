# Design — PDF Ctrl+滚轮独立缩放

> 配套 `prd.md`。本文聚焦技术方案、契约与权衡。执行步骤见 `implement.md`。

## 1. 问题拆解

三个互相耦合的子问题：

1. **拦截**：在 PDF 栏上 `Ctrl+滚轮` 时 `preventDefault`，阻止浏览器整页缩放；非 `Ctrl` 滚轮放行。
2. **缩放显示**：把 PDF 页面真正放大/缩小，且放大后文字清晰。难点是现有 `max-width:100%` 会把放大位图压回栏宽。
3. **锚点**：缩放时让光标指向的内容留在光标下，避免跳屏。

## 2. 关键难点：为什么不能「只改 scale 重渲染」

现状：`page.getViewport({ scale: 1.5 })` → canvas 位图宽 ≈ 918px；CSS `.pane--pdf canvas { max-width:100%; height:auto }` 把它等比压到栏宽（≈658px）显示。

若直接把 scale 改成 3.0 重渲染（位图 1836px），CSS 的 `max-width:100%` 仍把它压回 658px → **视觉尺寸不变，缩放失效**。

若取消 `max-width` 让位图 1:1 显示，默认（scale 1.5 → 918px）就超过栏宽 → 默认出现横向滚动，改变了现有「适应栏宽」的体验。

## 3. 选定方案：以「适应栏宽」为 1× 基准的重渲染 + 显式显示宽度

### 3.1 倍率模型

引入 `userZoom`（用户缩放倍率，默认 1.0 = 适应栏宽）。每页渲染时：

```
contentW = 容器内容宽（clientWidth - 左右 padding，约 clientWidth - 32）
W0       = page.getViewport({ scale: 1 }).width        // PDF 原生逻辑宽
fitScale = contentW / W0                                 // 刚好填满栏宽的倍率
renderScale = fitScale * userZoom                        // 实际渲染倍率
vp = page.getViewport({ scale: renderScale })
canvas.width  = round(vp.width)      // 位图宽 = 显示宽（1:1，锐利）
canvas.height = round(vp.height)
canvas.style.width  = vp.width + 'px'   // 显式显示宽
canvas.style.maxWidth = 'none'          // 解除 100% 上限，允许超出栏宽
// height 沿用 CSS height:auto（按宽高比自动）
```

- `userZoom=1`：显示宽 = contentW → 等价现状「适应栏宽」，无横向滚动。**默认体验不变**。
- `userZoom=2`：显示宽 = 2·contentW → 超出栏宽，容器 `overflow:auto` 产生横向滚动条；位图宽 = 显示宽，1:1 锐利。
- 位图宽始终等于显示宽（不预先 ×devicePixelRatio），内存随 userZoom 线性增长，故用 `MAX_ZOOM` 上限封顶。

> 权衡：未乘 devicePixelRatio，在 Retina 上 1:1 比「位图×dpr 再缩放」略软，但放大时位图本身就按 userZoom 增大，已足够锐利；且避免高 zoom×大 dpr 的内存爆炸。MVP 不引入 dpr（列为后续增强）。

### 3.2 懒加载协同：按「当前 zoom 是否已渲染」驱动

现有 `rendered: Set<pageNum>` 记录「是否渲染过」。但缩放后已渲染页需要重渲染，单一 Set 不够。改为 **per-page 记录上次渲染时的 userZoom**：

```
const renderedZoom = new Map();   // pageNum -> 渲染时的 userZoom
```

`renderPageInto(holder)` 渲染条件：`!renderedZoom.has(num) || renderedZoom.get(num) !== userZoom`。渲染成功后写 `renderedZoom.set(num, userZoom)`。

- IntersectionObserver 回调照旧调 `renderPageInto`：可见页若 zoom 不匹配就重渲染，匹配则跳过（幂等）。
- 缩放时：先更新 `userZoom`，再对**当前可见页**主动调 `renderPageInto` 立即重渲染（即时反馈 + 锚点）；**非可见页不清空、不立即重渲染**，其旧 canvas 保留（高度不变 → 不影响锚点 offsetTop），等滚动进入视口时由 IO 按 `userZoom` 补渲染。

这样避免「缩放即全量重渲染」的性能爆炸，同时保证锚点计算所需的上方位移稳定。

### 3.3 锚点（向光标处缩放）

wheel 事件里记录锚点，重渲染可见页后重算 scrollTop：

```
// 记录（重渲染前）
anchoredHolder = (e.target).closest('.pdf-page-holder')
anchoredCanvas = anchoredHolder.querySelector('canvas')
canvasRect = anchoredCanvas.getBoundingClientRect()
f = clamp((e.clientY - canvasRect.top) / canvasRect.height, 0, 1)  // 光标在该页内的纵向比例
viewportY = e.clientY - container.getBoundingClientRect().top        // 光标在容器视口内的 y

// 更新 userZoom + 重渲染可见页（await）

// 重算（重渲染后）
newH = anchoredCanvas.getBoundingClientRect().height   // 锚定页重排后真实显示高
holderTopInScroll = anchoredHolder.getBoundingClientRect().top
                   - container.getBoundingClientRect().top + container.scrollTop
container.scrollTop = holderTopInScroll + f * newH - viewportY
```

要点：
- 用「重排后的真实 `getBoundingClientRect`」算 `holderTopInScroll`，自动吸收「可见区上方位页也被重渲染导致的高度变化」，无需枚举哪些页重渲染过。
- 上方**非可见**页保留旧 canvas（高度不变），其位移贡献稳定 → 锚点准。
- 横向同理可选锚点；MVP 仅做纵向锚点（横向滚动条手动拖），纵向是主阅读方向。
- 找不到 `anchoredHolder`（光标在 padding/间隙）→ 跳过锚点，保持当前 scrollTop（可接受的降级）。

### 3.4 节流：leading + trailing

连续 `Ctrl+滚轮` 会高频触发。用 leading+trailing 节流（≈80ms）：

- 首个事件立即应用（leading），响应跟手；
- 80ms 窗口内的后续事件合并，窗口末尾按最终 `userZoom` 补一次（trailing），避免逐 tick 全量重渲染可见页。
- 每个 tick 都 `preventDefault`（只要 `ctrlKey`），即便节流未触发渲染也要拦默认缩放。
- 锚点事件取窗口内最后一次 wheel 的坐标。

### 3.5 上下限与归一

- `MIN_ZOOM = 0.5`，`MAX_ZOOM = 3.0`（位图宽上限 ≈ 3·contentW，单页内存可控）。
- `ZOOM_STEP = 1.15`（每 tick ≈ ×1.15，约 5 tick 到 2×）。
- 计算后若 `userZoom` 落在已 clamp 的边界且方向仍向外 → no-op（但仍 preventDefault）。
- 接近 1.0（如 |z-1|<0.02）时 snap 到 1.0，方便回到精确「适应栏宽」。

## 4. 模块改动边界

### 4.1 `src/pdf/render.js`（主改动）

- 新增模块级常量：`MIN_ZOOM / MAX_ZOOM / ZOOM_STEP / PAD_PX`（PAD_PX=16，对应 `.pane__scroll` 左右 padding）。
- `renderPdf(file, container)` 内：
  - `let userZoom = 1.0;`
  - `const renderedZoom = new Map();`（替换原 `rendered: Set`）。
  - `renderPageInto(holder)`：改用 §3.1 倍率模型（量 contentW、算 fitScale、显式设 style.width/maxWidth），幂等条件改为 zoom 不匹配才渲染；先 `holder.replaceChildren()` 清旧 canvas 再插新。
  - 新增 `applyZoom(nextZoom, anchorEv)`：clamp/snap → 若变化则更新 userZoom、对可见页 `renderPageInto`（await）、按 §3.3 设 scrollTop。
  - 新增 `onWheel(e)`：`ctrlKey||metaKey` 守卫 → `preventDefault` → 算目标 zoom → leading+trailing 节流调 `applyZoom`。
  - `container.addEventListener('wheel', onWheel, { passive: false })`（必须非 passive 才能 preventDefault）。
  - `cleanup()`：`removeEventListener` + 原 IO/pdf.destroy。
  - 返回 handle 增加 `setZoom(z)` / `getZoom()`（供 main.js 未来接 UI 控件 / 测试；wheel 已在内部绑定，main.js 无需感知）。
- 量 contentW：`container.clientWidth - 2 * PAD_PX`（clientWidth 含 padding）。响应式下 CSS padding 变 12px 会略有偏差，可接受（IO 补渲染时按当时 contentW 重算）；列为已知小限制。

### 4.2 `src/main.js`（极小改动）

- 仅类型上：`currentPdfHandle` 的 JSDoc 标注新增 `setZoom/getZoom`（可选），实际代码无需改动——wheel 监听已在 render.js 内部随生命周期绑定/解绑。
- 即「main.js 不感知缩放」（满足 C7）。若 PR 想给个重置入口可不动。

### 4.3 `src/styles.css`（小改动）

- `.pane--pdf canvas`：保留 `height:auto`，但 `max-width:100%` 由 JS 行内 `maxWidth:none` 覆盖（行内优先级高于样式表，无需删 CSS 规则；保留规则可作降级兜底）。
- 无需新增 BEM 类（不引入 `.pane__scroll--zoomed` 之类，全用行内 style 控制，减少状态耦合）。
- 暗色/窄屏：canvas 在窄屏下宽度仍由行内 px 控制，`overflow:auto` 天然支持滚动，无需额外规则。

## 5. 数据流

```
用户 Ctrl+滚轮（悬浮在 #pdf-scroll 上）
  → container 上的 wheel 监听（passive:false）
  → preventDefault（阻止整页缩放）
  → 算 nextZoom = clamp(userZoom × step^dir)
  → leading+trailing 节流
  → applyZoom(nextZoom, e)
       记录锚点 → userZoom 更新 → renderPageInto(可见页)（按 fitScale×userZoom 重绘位图 + 显式宽度）
       → await → 按 getBoundingClientRect 重算 scrollTop
  → 非可见页：renderedZoom 仍记旧 zoom → 滚动进入视口时 IO 触发 renderPageInto → 自动按新 userZoom 补渲染
```

## 6. 兼容性 / 回滚

- 切换 PDF：`renderPdf` 重建闭包，`userZoom` 重置 1.0、新 wheel 监听绑定、旧的随 cleanup 解绑。无跨文件泄漏。
- 最小化 PDF 栏：容器被 `display:none`（`.pane--minimized > :not(.pane__header)`）→ 不收 wheel；恢复后照常。
- 窄屏：PDF 栏纵向堆叠仍可滚动，wheel 监听在 `#pdf-scroll` 上照常生效（C5）。
- 回滚：改动集中在 `render.js` + 少量 CSS/main；还原 `render.js` 即恢复旧行为。缩放不持久化，刷新即重置。

## 7. 已知限制（写入 PRD Notes / 后续增强）

- 未乘 devicePixelRatio：Retina 上 1:1 略软（放大时已够锐利）。
- 拖拽改变栏宽后，已渲染页不会自动按新栏宽 refit（仍是旧 contentW 渲的位图）；用户再次缩放或滚动触发 IO 补渲染时会按新 contentW 重算。可后续加 pane resize 监听触发可见页 refit。
- 横向无光标锚点（仅纵向）。
- 缩放倍率不持久化（按 C2 设计）。

## 8. 反模式（check 时核对）

- ❌ wheel 监听用默认 passive（无法 preventDefault，整页仍被缩放）。
- ❌ 非 Ctrl 也 preventDefault（破坏普通滚动）。
- ❌ 只改 renderScale 不动 CSS max-width（放大被压回栏宽，缩放失效）。
- ❌ 缩放即清空所有页 / 全量重渲染（性能爆炸 + 锚点 offsetTop 失稳）。
- ❌ 用 CSS transform 放大 canvas（transform 不撑布局 → 无滚动条、被裁切；且位图不足时发虚）。
- ❌ 把 wheel 监听绑在 `window`/`document`（影响其它栏；应绑 `#pdf-scroll`）。
- ❌ 缩放逻辑泄漏到 main.js（违反 C7 单向依赖与封装）。
