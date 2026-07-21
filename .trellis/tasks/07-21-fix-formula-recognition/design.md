# Design: 修复PDF公式识别乱码并支持LaTeX渲染

## Architecture Overview

```
PDF File
  → extractText() [extract.js]           ← 改动 1：算法改进
    → pdf.js getTextContent()
    → textContentToString() [NEW ALGO]
  → {pages: [{pageNum, text}]}
  → renderText() [textPane.js]           ← 改动 2：走 marked+KaTeX
    → renderMarkdown() [render.js]
  → DOM（含 KaTeX 渲染的数学公式）
```

## 1. 文本提取算法改进 (`src/pdf/extract.js`)

### 1.1 当前算法

```
for each text item:
  if |Y - lastY| > 2px → new line
  else → append to cur
  if hasEOL → new line
```

缺陷：固定 2px 阈值不随字号缩放，上下标、分式等全部误拆行。

### 1.2 新算法：字号感知行分组 + X 排序

**Phase 1 — 行分组**：

用 item 的 `height`（字号）替代固定阈值：
- `lineHeight = item.height || 12`（默认 12px）
- `ΔY > 0.5 * lineHeight` → 真换行（新逻辑行）
- `ΔY ≤ 0.5 * lineHeight` → 同行（上下标/符号位移）
- `hasEOL` 仍然强制换行

**Phase 2 — 同行内 X 排序**：

每行内的 items 按 `transform[4]`（X 坐标）升序排列，保证阅读顺序。

**Phase 3 — 拼接**：

按 X 间距决定是否插入空格：
- 相邻 item 的 X 间距 > 平均字符宽 → 插空格
- 否则直接拼接

### 1.3 降级策略

| 条件 | 行为 |
|------|------|
| item.height 不可用 | 回退 `lineHeight = 12` |
| item.transform 不可用 | 保留旧行为（EPS=2） |
| items 为空 | 返回空字符串 |

### 1.4 伪代码

```js
function textContentToString(textContent) {
  // Phase 1: group items into lines by Y + height
  const lineGroups = [];
  let curGroup = [], lastY = null, lastH = null;
  
  for (const item of items) {
    const y = item.transform?.[5];
    const h = item.height || lastH || 12;
    const threshold = h * 0.5;
    
    if (lastY !== null && Math.abs(y - lastY) > threshold) {
      lineGroups.push(curGroup);
      curGroup = [];
    }
    curGroup.push(item);
    
    if (item.hasEOL) {
      lineGroups.push(curGroup);
      curGroup = [];
      lastY = null;
    } else {
      lastY = y;
      lastH = h;
    }
  }
  if (curGroup.length) lineGroups.push(curGroup);
  
  // Phase 2: sort each line by X, then join
  return lineGroups
    .map(group => group.sort((a, b) => 
      (a.transform?.[4] || 0) - (b.transform?.[4] || 0)
    ))
    .map(group => joinWithSpacing(group))
    .join('\n')
    ...; // cleanup
}
```

## 2. 中栏 KaTeX 渲染 (`src/ui/textPane.js`)

### 2.1 改动点

`renderText()` 中，原来用 `el('div', ..., p.text)` 创建 text node → 改为调用 `renderMarkdown(el, p.text)`。

### 2.2 兼容性

| 关注点 | 结论 |
|--------|------|
| 追问（文本选中） | `window.getSelection().toString()` 在 KaTeX 渲染的 DOM 上仍正确返回可见文本 |
| 空文本 | `renderMarkdown` 传入空字符串输出空 `<p>`，CSS 已有 `.pane__empty` 处理 |
| 大文本 | marked+KaTeX 同步渲染，单页文本量通常 < 50KB，性能无问题 |
| 构建 | KaTeX CSS/字体已在 `render.js` 中 import，无需额外处理 |

### 2.3 实现

```js
// textPane.js
import { renderMarkdown } from './render.js';

// 在 renderText() 中：
const bodyEl = el('div', { class: 'text-page__body' });
renderMarkdown(bodyEl, p.text || '（无文本）');
```

## 3. 不变部分

- `src/pdf/render.js` — 左栏 canvas，零改动
- `src/ai/*` — AI 层，零改动
- `src/ui/render.js` — 只暴露 API，内部不改
- `src/state/store.js` — store 形状不变
- `src/main.js` — 调用方式不变
- `src/ui/aiPane.js` — 零改动
- `src/ui/paneResize.js` — 零改动
- `src/ui/settings.js` — 零改动

## 4. 风险与缓解

| 风险 | 概率 | 缓解 |
|------|------|------|
| 字号感知算法对多栏 PDF 仍不完美 | 中 | 多栏不在 scope；如需支持可后续加 X 聚类 |
| KaTeX 渲染大段文本性能 | 低 | 单页文本 < 50KB，同步 marked+KaTeX 毫秒级 |
| 追问选中 KaTeX 元素时文本异常 | 低 | KaTeX 渲染的 DOM 中 `.textContent` 包含完整文本 |
