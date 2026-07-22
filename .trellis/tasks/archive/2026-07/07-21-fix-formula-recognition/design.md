# Design: 修复PDF公式识别 — AI 视觉识别方案

## Architecture Overview

```
PDF File
  ├─> [默认] extractText()         → pdf.js 文本提取（快速，毫秒级）
  │       → store.paper
  │       → textPane: marked+KaTeX
  │
  └─> [用户点击"AI 识别"] extractWithVision()
          → renderPageToImage()     → canvas.toDataURL('image/png')
          → callVisionAPI(image)    → OpenAI /v1/chat/completions (vision)
          → 逐页累积结果
          → store.paper（替换）
          → textPane: renderMarkdown() [KaTeX 渲染 LaTeX]
```

## 1. 新增模块: `src/pdf/vision.js`

### 1.1 接口

```js
export async function extractWithVision(file, { signal, onProgress }) {
  // 返回与 extractText() 相同结构: { meta, fullText, pages }
}
```

### 1.2 流程

```
Phase 1: 渲染所有页面为图片
  - 复用 pdf.js render (scale=2.0, 保证文字清晰)
  - canvas.toBlob('image/png') → base64 data URL

Phase 2: 逐页调用 vision API
  - POST /v1/chat/completions
  - messages: [{role:"user", content:[text, image_url]}]
  - 串行（避免 API 限流）
  - signal 支持取消
  - onProgress(current, total) 通知进度

Phase 3: 拼接结果
  - 组装 { meta, fullText, pages }
```

### 1.3 Vision Prompt

```
请精确识别此页面的全部文本内容。要求：
1. 数学公式用 LaTeX 格式输出（行内 $...$，块级 $$...$$）
2. 保留原文的段落结构
3. 表格保留 Markdown 表格格式
4. 不要添加原文没有的内容，不要总结或评论
5. 用中文输出正文（如果原文是中文），英文部分保持原文
```

### 1.4 降级与错误处理

| 情况 | 处理 |
|------|------|
| API Key 未配置 | 抛出明确错误："请先在设置中配置 API Key" |
| 单页失败 | 记录错误页在结果中标注，继续下一页 |
| 用户取消 | signal.aborted → 保留已识别页 |
| 超时 | 单页超时 60s，失败后继续下一页 |

## 2. 修改: `src/ai/openai.js`

新增 vision 消息构建：

```js
export function buildVisionMessage(prompt, imageBase64) {
  return {
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
    ],
  };
}
```

`chat()` 方法已支持 content 为数组格式（OpenAI 协议原生兼容），只需调用方传入正确结构。

## 3. 修改: `src/ui/textPane.js`

在文本中栏头部添加"AI 识别"按钮：

```html
<div class="text-meta">
  <span>《论文标题》</span>
  <button class="ai-btn ai-btn--primary" id="btn-vision-extract">
    AI 识别
  </button>
</div>
```

- 进度显示：按钮变灰 + 文字变为 "识别中 3/10…"
- 取消按钮：进度旁出现"取消"
- 完成后：按钮恢复，文本自动刷新

## 4. 修改: `src/main.js`

- 加载 PDF 后注入"AI 识别"按钮
- 绑定按钮事件 → 调用 `extractWithVision()`
- 结果更新 `store.paper` 和 textPane

## 5. 数据流

```
用户点击"AI 识别"
  → main.js: loadPdfVision(file)
    → vision.extractWithVision(file, {signal, onProgress})
      → renderPageAsImage(page) × N
      → for each page image:
          → openai.chat([buildVisionMessage(prompt, image)], {signal})
          → accumulate results
    → setState({ paper: newPaper })
    → textPane.renderText(newResult)
```

## 6. 不变部分

- `src/pdf/extract.js` — pdf.js 快速提取，零改动
- `src/pdf/render.js` — 左栏 canvas 渲染，零改动
- `src/ui/render.js` — marked+KaTeX 管线，零改动
- `src/ai/context.js` — 上下文装配，零改动
- `src/ai/prompts.js` — 提示词模板，零改动
- `src/state/store.js` — store 形状复用 Paper 类型
- `src/ui/aiPane.js` — 零改动
- `src/ui/paneResize.js` — 零改动
- `src/ui/settings.js` — 零改动

## 7. 风险与缓解

| 风险 | 概率 | 缓解 |
|------|------|------|
| Vision 模型不支持（如 DeepSeek） | 中 | 检测模型是否支持 vision；不支持时按钮给出提示 |
| 大 PDF（>50页）token 消耗大 | 中 | 显示预估消耗，用户确认后再开始 |
| 单页图片太大 | 低 | scale=2.0 约 1500×2000px，在 vision 模型上下文内 |
| API 调用慢 | 高 | 进度条 + 取消按钮，用户预期明确 |
