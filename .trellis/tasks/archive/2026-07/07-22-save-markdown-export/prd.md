# 添加保存AI阅读结果导出功能

## Goal

用户可以将 AI 阅读面板中的分析结果（总结、质疑、对话）导出为本地文件，支持 Markdown 和 PDF 两种格式，可选择保存路径。

## Confirmed Facts

- 纯前端应用，无后端。下载通过 Blob 或 File System Access API 实现。
- 4 个 AI Tab：总结(summarize)、概念(explainConcepts)、质疑(critique)、对话(chat)。
- 分析 Tab 的原始 markdown 文本通过 `createStreamingRenderer.getText()` 获取。
- 对话 Tab 的聊天记录以 `[{role, content}]` 格式存储在 `store.messages`。
- 论文元信息（标题、作者）存在于 `store.paper`。
- 无现有保存/导出功能。

## Requirements

### R1: 保存按钮
- 在"总结"、"质疑"、"对话"三个 Tab 的操作区各添加一个"保存"按钮。
- 按钮在内容生成完毕后可用；生成中/无内容时禁用。

### R2: 下载选项对话框
- 点击保存按钮弹出下载选项对话框，包含：
  - **格式选择**：Markdown (.md) / PDF (.pdf)，单选切换
  - **文件名编辑**：预填 `{论文标题}_{类型}_{日期}.{扩展名}`，可修改
  - 切换格式时自动同步文件扩展名
- 支持 Esc、点击遮罩、取消按钮关闭对话框

### R3: 下载方式
- **直接下载**：Blob 方式触发浏览器下载，文件保存到浏览器默认下载目录
- **选择路径保存**：使用 File System Access API (`showSaveFilePicker`) 弹出系统原生保存对话框，用户可选择保存路径；浏览器不支持时回退到直接下载

### R4: Markdown 文件内容
- **总结/质疑**：论文标题 + 生成时间 + AI 原始输出
- **对话**：论文标题 + 导出时间 + 完整对话记录（User/AI 角色标注）

### R5: PDF 导出
- Markdown 渲染为 HTML（含 KaTeX 数学公式），在新窗口打开并自动触发浏览器打印
- 用户通过浏览器"另存为 PDF"保存，同时可选择保存路径

## Acceptance Criteria

- [x] 总结/质疑/对话 Tab 有内容后，保存按钮可用
- [x] 点击保存弹出下载选项对话框
- [x] 对话框显示 MD/PDF 格式单选，默认 MD
- [x] 对话框显示可编辑的文件名，切换格式时扩展名同步
- [x] "直接下载"按钮触发浏览器下载
- [x] "选择路径保存"按钮弹出系统保存对话框（支持 File System Access API 的浏览器）
- [x] PDF 选项打开打印窗口，排版正确
- [x] Esc/点击遮罩/取消按钮可关闭对话框
- [x] 生成中/无内容时保存按钮禁用

## Out of Scope

- 批量导出
- 导出为 HTML/JSON 等其他格式
- 对话的增量保存或自动保存
