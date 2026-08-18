# AI对话改为悬浮窗口

## Goal

将 AI 对话从右侧面板的 Tab 中独立出来，改为可拖拽、可缩放的悬浮窗口，使用户可以在不切换 Tab 的情况下随时查看 PDF/文本并对话。

## Confirmed Facts（代码库确认）

- 项目是纯 JavaScript SPA，无框架，无 UI 组件库
- 当前三栏布局：PDF（左）| Text（中）| AI面板（右）
- AI 面板有 5 个 Tab：summarize、explainConcepts、critique、translate、chat
- Chat 当前是 AI 面板中的一个 Tab，通过 `store.ui.activeTab` 切换
- 现有 "追问" 功能：文本选区后出现浮动按钮，点击后切换至 chat tab 并发送消息
- 无现成悬浮窗组件，但项目中有 fixed 遮罩层模式（Settings、Download、Archive）
- 状态管理在 `src/state/store.js`，消息存储在 `store.messages`
- Chat 核心实现在 `src/ui/aiPane.js`（~880行），其余 AI 功能共享同一文件

## Requirements

### 范围
- **R1**: 仅 Chat Tab 独立为悬浮窗，其余 4 个 Tab（summarize、explainConcepts、critique、translate）保留在右侧 AI 面板

### 交互行为
- **R2**: 支持通过标题栏拖拽移动悬浮窗位置
- **R3**: 支持通过边缘/角落拖拽调整悬浮窗大小
- **R4**: 支持最小化——窗口收起为一个浮动小按钮，点击按钮恢复窗口
- **R5**: 位置和尺寸持久化到 localStorage，刷新后恢复（默认：右下角，约 420×500px）

### 打开/唤出方式
- **R6**: AI 面板 Tab 栏中保留"Chat"按钮（文本标签，不使用 emoji），点击唤起/恢复悬浮窗
- **R7**: 最小化时显示浮动小按钮，点击恢复窗口
- **R8**: "追问"功能适配悬浮窗——选中文本后点击"追问"，自动唤起悬浮窗并发送选中文本

### 窗口控制
- **R9**: 标题栏包含：标题文本、最小化按钮、关闭按钮
- **R10**: 关闭按钮隐藏窗口（消息不丢失），关闭后可通过 AI 面板的"Chat"按钮重新打开

## Acceptance Criteria

- [ ] 右侧 AI 面板不再包含 Chat Tab，只有 4 个分析 Tab
- [ ] 点击 AI 面板中的"Chat"按钮，悬浮聊天窗出现在视口右下角（默认 420×500px）
- [ ] 拖拽标题栏可移动悬浮窗，释放后位置保留
- [ ] 拖拽边缘/角落可调整大小，有最小尺寸限制
- [ ] 最小化后窗口收起为浮动小按钮，点击按钮恢复窗口（位置/大小不变）
- [ ] 关闭后窗口隐藏，消息不丢失，再次点击"Chat"按钮恢复
- [ ] 刷新页面后，悬浮窗恢复上次的位置和大小
- [ ] 文本选区"追问"功能正常工作，唤起悬浮窗并自动发送
- [ ] 悬浮窗不遮挡 AI 面板中的其他功能使用

## Open Questions

- [x] 窄屏（≤960px）：悬浮窗变为底部固定栏，宽度撑满，高度约 40-50%，可上下拖拽调整高度
- [x] 关闭与最小化行为一致：都隐藏窗口并显示浮动小按钮，消息不丢失

## Notes

- Complex task — 需要 design.md + implement.md
