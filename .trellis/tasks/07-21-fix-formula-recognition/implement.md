# Implement: AI 视觉识别方案

## Checklist

### Step 1: Vision 提取模块

- [ ] 1.1 新建 `src/pdf/vision.js`：
  - `renderPageToImage(page, scale=2.0)` → data URL
  - `extractWithVision(file, {signal, onProgress})` → `{meta, fullText, pages}`
  - Vision prompt（中文，要求 LaTeX 输出）
  - 单页失败不阻塞其余页
  - signal.aborted 时抛错停止

### Step 2: OpenAI vision 支持

- [ ] 2.1 `src/ai/openai.js`：新增 `buildVisionMessage(prompt, imageBase64)`
- [ ] 2.2 确保 `chat()` 方法支持 content 数组格式

### Step 3: 文本中栏 UI

- [ ] 3.1 `src/ui/textPane.js`：`renderText()` 中在元信息栏添加"AI 识别"按钮
- [ ] 3.2 添加进度显示/取消功能
- [ ] 3.3 暴露 `onVisionExtract` 回调注册给 main.js

### Step 4: 主线装配

- [ ] 4.1 `src/main.js`：绑定"AI 识别"按钮事件
- [ ] 4.2 调用 `extractWithVision()`，处理进度、取消、结果写入 store
- [ ] 4.3 成功后 `renderText()` 刷新中栏

### Step 5: 验证

- [ ] 5.1 `npm run build` 构建成功
- [ ] 5.2 API 未配置时按钮给出提示
- [ ] 5.3 含公式 PDF 识别后 LaTeX 正确渲染
- [ ] 5.4 进度显示 + 取消功能正常

## 改动文件清单

| 文件 | 改动类型 | 风险 |
|------|----------|------|
| `src/pdf/vision.js` | **新建** | 中 |
| `src/ai/openai.js` | 小幅改动（新增工具函数） | 低 |
| `src/ui/textPane.js` | 小幅改动（新增按钮+进度） | 低 |
| `src/main.js` | 小幅改动（绑定事件） | 低 |
