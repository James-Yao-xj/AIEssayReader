# Implement — PDF Ctrl+滚轮独立缩放

> 配套 `design.md`。按顺序执行，每步含验证。改动集中在 `src/pdf/render.js`（主）、`src/styles.css`（微调）、`src/main.js`（标注，基本不改）。

## 执行清单

### Step 1 — render.js：倍率模型重构（renderPageInto）

- 顶部加常量：`PAD_PX = 16`、`MIN_ZOOM = 0.5`、`MAX_ZOOM = 3.0`、`ZOOM_STEP = 1.15`。
- `renderPdf` 内：`let userZoom = 1.0;`；`const renderedZoom = new Map();`（替换 `const rendered = new Set();`）。
- `renderPageInto(holder)`：
  - 幂等条件：`const z = renderedZoom.get(num); if (z === userZoom) return;`
  - `const baseVp = page.getViewport({ scale: 1 }); const contentW = Math.max(1, container.clientWidth - 2*PAD_PX); const fitScale = contentW / baseVp.width; const vp = page.getViewport({ scale: fitScale * userZoom });`
  - `holder.replaceChildren();`（清旧 canvas）后建 canvas；`canvas.width/height = round(vp.w/h)`；`canvas.style.width = vp.width+'px'; canvas.style.maxWidth = 'none';`
  - 渲染成功后 `renderedZoom.set(num, userZoom);`（放 try 内 render 之后；失败不写，便于重试）。
  - 保留 `holder.style.minHeight` 占位逻辑（未渲染时）。
- **验证**：暂不接 wheel，`npm run dev` 拖入 PDF，确认默认显示与现状一致（适应栏宽、懒加载照常），无报错。

### Step 2 — render.js：可见页判定 + applyZoom

- 新增 `isHolderVisible(holder)`：用 `holder.getBoundingClientRect()` 与 `container.getBoundingClientRect()` 判交叠（含 IO 的 400px 提前量近似即可，或直接视口相交）。
- 新增 `async function applyZoom(nextZoom, anchorEv)`：
  - clamp `nextZoom` 到 `[MIN_ZOOM, MAX_ZOOM]`；`|nextZoom-1|<0.02` 时 snap 1.0。
  - 若 `nextZoom === userZoom` 直接 return。
  - 记录锚点（§3.3）：`anchoredHolder = anchorEv ? anchorEv.target.closest?.('.pdf-page-holder') : null`；若取到 canvas 则算 `f`、`viewportY`。
  - `userZoom = nextZoom;`
  - 对所有 holder：`if (isHolderVisible(h)) void renderPageInto(h)`；`await Promise.all(...)` 等可见页重渲染完。
  - 锚点重算：取 `anchoredHolder` 重排后 canvas 的 `getBoundingClientRect()`，按 §3.3 公式设 `container.scrollTop`（clamp ≥0）。无锚点则跳过。
- **验证**：console 里拿不到闭包；留到 Step 4 接 wheel 后统一手测。

### Step 3 — render.js：wheel 监听 + 节流 + cleanup

- 新增 `onWheel(e)`：
  - `if (!e.ctrlKey && !e.metaKey) return;`（非 Ctrl 放行，不 preventDefault）。
  - `e.preventDefault();`
  - `const dir = e.deltaY < 0 ? +1 : -1;`（deltaY<0=上滚=放大；触控板 pinch 同样走 ctrl+wheel）。
  - `const target = userZoom * (dir>0 ? ZOOM_STEP : 1/ZOOM_STEP);`
  - leading+trailing 节流（80ms）：首个立即 `applyZoom(target, e)` 并设 timer；窗口内后续只更新 `pendingTarget`+`pendingAnchor=e`；trailing 时 `applyZoom(clamp(pendingTarget), pendingAnchor)`。
- `container.addEventListener('wheel', onWheel, { passive: false });`
- `cleanup()`：先 `container.removeEventListener('wheel', onWheel);` 再原 IO/pdf.destroy；清 trailing timer。
- 返回 handle 增加：`setZoom(z){ void applyZoom(clamp(z), null); }`、`getZoom(){ return userZoom; }`。
- **验证**：见 Step 5。

### Step 4 — main.js：handle 类型标注（基本不改代码）

- `currentPdfHandle` 的 JSDoc 补 `setZoom/getZoom`（可选）。
- 确认无需在 main.js 绑 wheel（已在 render.js 内随生命周期绑定/解绑）。
- **验证**：`npm run dev` 无报错；切 PDF 时旧监听解绑（控制台无泄漏告警）。

### Step 5 — styles.css：确认 max-width 兼容

- `.pane--pdf canvas` 的 `max-width:100%` **保留**（作降级兜底）；实际由行内 `maxWidth:none` 覆盖。无需新增规则。
- 自检：放大后 canvas 行内 `maxWidth:none` 生效 → 超出栏宽 → `.pane__scroll` 的 `overflow:auto` 出滚动条。
- **验证（浏览器手测，对照 AC）**：
  - AC1：悬停 PDF `Ctrl+滚轮` 上滚放大、下滚缩小；浏览器整页缩放比例不变。
  - AC2：缩放时中栏/右栏/顶栏/窗口大小不变。
  - AC3：放大后文字锐利（非发虚）。
  - AC4：连续缩放，光标处内容大致留在光标下。
  - AC5：放大超栏宽 → 出现横向滚动条可拖动。
  - AC6：不按 Ctrl 滚轮 → 正常纵向滚动，整页不缩放。
  - AC7：到上下限继续同向滚 → 无报错/不溢出。
  - AC9：最小化/恢复 PDF、拖拽栏宽、暗色切换后缩放仍可用。
  - AC10：窄屏（≤960px）缩放仍生效。

### Step 6 — 构建 + 全量回归

- `npm run build` 通过、无控制台报错（AC12）。
- 浏览器打开 `dist/index.html` 复查关键路径：拖入渲染、文本提取、选中追问、AI 面板、设置、主题、版面最小化/拖拽（AC11）。
- 切换/重拖 PDF 确认缩放重置（AC8）。

## 验证命令

```bash
npm run dev      # 开发预览，手测各 AC
npm run build    # 构建必须通过（AC12）
```

（项目无 lint/test 脚本，质量校验以 `build` + 浏览器手测为准。）

## 回滚点

- Step 1–3 全在 `render.js`；如缩放有问题，还原该文件即恢复旧行为。
- 缩放不持久化，刷新即重置——天然安全回退。
- main.js/styles.css 改动极小，独立可回退。

## Review Gates

- Step 1 后：默认显示（userZoom=1）与现状逐像素接近，懒加载不受影响。
- Step 3 后（接入 wheel）：非 Ctrl 滚轮行为不变；Ctrl 滚轮整页不再被浏览器缩放。
- Step 5/6 后：逐条核对 AC1–AC12。
