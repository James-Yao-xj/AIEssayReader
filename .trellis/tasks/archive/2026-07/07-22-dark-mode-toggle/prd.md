# 增加白天/黑夜模式切换功能

## Goal

在顶部导航栏添加白天/黑夜模式切换按钮，用户可一键切换界面主题。夜间模式背景变为深灰色，所有 UI 元素相应调整以保证可读性。

## Confirmed Facts

- 纯前端 Vite 单页应用，原生 JS，无框架。
- 所有颜色硬编码在 `src/styles.css` 中（无 CSS 变量体系，仅 `--reader-font-size` 一个变量）。
- 无现有主题/暗色模式基础设施。
- 顶部导航栏 (`index.html` `<header class="app-header">`) 已有设置按钮，切换按钮放在其左侧。
- 设置持久化在 `localStorage` 的 `aie:settings` key；主题偏好使用独立 key `aie:theme`（UI 层概念，不混入 Settings 数据模型）。
- 应用入口为 `src/main.js`，主样式为 `src/styles.css`。

## Requirements

### R1: 切换按钮
- 在顶部导航栏添加一个主题切换按钮，位于设置按钮（`#btn-settings`）左侧。
- 白天模式显示 ☀️ 图标，黑夜模式显示 🌙 图标。
- 点击切换主题，即时生效，无动画延迟。

### R2: 白天模式（默认）
- 保持现有配色方案完全不变。
- 首次访问无 localStorage 记录时，默认使用白天模式。

### R3: 黑夜模式
- 背景色（`<html>`/`<body>`）变为深灰色 `#1a1a2e`。
- `.app-header` 背景变深色，文字变浅色。
- `.pane` 三栏面板背景变深色（`#16213e` / `#1a1a2e`），`.pane--ai` 变 `#0f0f23`。
- `.app-header__btn`、设置弹窗、输入框、textarea、dropzone 内层等白色/浅色背景元素改为深色调。
- 文字颜色变为浅色系（`#e0e0e0` / `#c0c0c0`），保证对比度。
- `.chat-bubble--assistant` 气泡背景变深色。
- 代码块 `.md-body code`、引用块 `.md-body blockquote`、表格 `.md-body th` 背景改为深色。
- `.ai-error` 错误提示背景适配。
- 边框/分割线（`#e3e6eb` / `#d0d7de`）改为 `#2a2a4a` / `#3a3a5a`。
- `.pane--pdf` PDF 渲染区保持深色背景（本身已是 `#525659`，可微调）。
- `.status-bar` 状态条保持深色背景（本身已是 `rgba(33,37,41,0.92)`，可微调）。
- `.settings-modal__tabs` 和 `.ai-tabs` Tab 栏背景改为深色。

### R4: 主题持久化
- 主题值保存到 `localStorage` key `aie:theme`，值为 `"light"` | `"dark"`。
- 页面加载时读取该值，设置 `<html data-theme="...">`。
- 无存储记录时默认 `"light"`。
- 在 `<head>` 中放置内联阻塞脚本读取 localStorage 并设置 `data-theme`，避免深色主题刷新时闪白。

### R5: 实现方式
- CSS 使用 `[data-theme="dark"]` 属性选择器覆写颜色，不引入 CSS 变量重构。
- JS 切换逻辑：点击按钮 → 更新 `data-theme` 属性 → 写入 `localStorage`。
- 不引入任何第三方依赖。

## Acceptance Criteria

- [x] 顶部栏出现主题切换按钮（☀️/🌙），位于设置按钮左侧
- [x] 默认白天模式，外观与当前完全一致
- [x] 点击按钮切换到黑夜模式，背景变为深灰色，所有 UI 颜色适配
- [x] 黑夜模式下文字清晰可读，对比度合格
- [x] 再次点击切回白天模式
- [x] 刷新页面后主题偏好保持
- [x] 黑夜模式下 PDF 渲染区和文本提取区内容正常显示
- [x] 首次访问（无 localStorage）默认白天模式，刷新无闪白

## Out of Scope

- 跟随系统 `prefers-color-scheme` 自动切换
- 自定义颜色主题
- 定时自动切换
- 过渡动画
