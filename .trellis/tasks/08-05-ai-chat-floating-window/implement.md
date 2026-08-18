# Implement: AI 对话悬浮窗

## 执行顺序

### Phase 1: 基础设施

- [ ] **1.1** 创建 `src/utils/download.js`，从 `aiPane.js` 提取共用工具函数：
  - `makeFilename(paperTitle, tag)` → 生成合法文件名
  - `downloadFile(content, filename, mimeType)` → Blob 下载
  - `saveViaFileSystemAPI(content, filename, mimeType)` → File System Access API
  - `escapeHtml(str)` → HTML 转义
  - 验证：aiPane.js 中分析 tab 的保存功能正常（引用新路径）

- [ ] **1.2** 扩展 `src/state/store.js`：
  - 在 State 类型中添加 `chatWindow: { open, x, y, width, height }`
  - 在初始 state 中添加默认值：`{ open: false, x: null, y: null, width: 420, height: 500 }`
  - 更新 JSDoc 类型注释
  - `activeTab` 类型移除 `'chat'`

- [ ] **1.3** 扩展 `src/config/storage.js`：
  - 添加 `loadChatWindowState()` — 从 `aie:chat-window` 读取，异常回退默认值
  - 添加 `saveChatWindowState(state)` — 写入 `aie:chat-window`
  - 默认值：`{ x: null, y: null, width: 420, height: 500 }`

### Phase 2: 悬浮窗核心

- [ ] **2.1** 创建 `src/ui/chatWindow.js` — DOM 创建：
  - `initChatWindow()` 函数（幂等）
  - 创建 `#chat-window` 元素（fixed 定位），append 到 `document.body`
  - 创建 `#chat-float-btn` 浮动恢复按钮
  - 内部包含：标题栏 + 消息列表 + 状态栏 + 输入框 + 发送/停止/保存按钮
  - 标题栏结构：标题文本 | 最小化按钮 + 关闭按钮
  - 8 个 resize handles
  - 使用文本标签，不使用 emoji

- [ ] **2.2** 拖拽移动：
  - 标题栏 `mousedown` → 记录起始位置
  - `document mousemove` → 更新 top/left
  - `document mouseup` → 保存到 store + localStorage
  - 边界约束：窗口不超出视口（至少保留一部分可见）
  - body userSelect + cursor 在拖拽期间锁定

- [ ] **2.3** 缩放：
  - 8 个 handle 的 `mousedown` → 确定拖拽的边/角
  - `document mousemove` → 根据 handle 类型计算新位置/尺寸
  - `document mouseup` → 保存到 store + localStorage
  - 最小尺寸约束：300×300px
  - 各 handle 相应光标样式

- [ ] **2.4** 最小化/关闭：
  - 最小化按钮 → 隐藏窗口，显示浮动恢复按钮
  - 关闭按钮 → 同最小化
  - 浮动按钮 `click` → 恢复窗口（位置/尺寸不变）
  - 两者行为一致（PRD R10 确认）

- [ ] **2.5** Chat 功能迁移：
  - `sendChat()` — 从 aiPane.js 复制，引用改为 chatRoot
  - `renderChatList()` — 同上，export 供外部调用
  - `appendChatBubble()` / `scrollChatToBottom()` — 内部函数
  - `syncChatSaveButton()` / `syncChatStatus()` — 引用 chatRoot
  - Streaming 集成（import `createStreamingRenderer`）
  - AbortController 管理（`currentController`）
  - Enter 发送 / Shift+Enter 换行 / 输入法 composition 保护

- [ ] **2.6** 下载对话框：
  - 从 aiPane.js 迁移 `showDownloadDialog('chat')`
  - 使用从 `download.js` import 的工具函数
  - 对话框 overlay append 到 document.body

- [ ] **2.7** Store 订阅：
  - 订阅 `messages` 变化 → 重新渲染消息列表
  - 订阅 `chatStatus` → 更新状态栏
  - 订阅 `quickAsk` + `chatWindow.open` → 填入文本并自动发送

- [ ] **2.8** 位置/尺寸持久化：
  - 窗口打开时从 localStorage 读取位置/尺寸
  - 拖拽/缩放结束时保存
  - `x`/`y` 为 null 时计算默认位置（右下角 24px 边距）

- [ ] **2.9** Export API：
  - `initChatWindow()` — 初始化（幂等）
  - `openChatWindow()` — 打开窗口（被 aiPane 的 Chat 按钮调用）
  - `closeChatWindow()` — 关闭窗口
  - `renderChatList()` — 重渲染消息列表（被 aiPane 的 refreshAfterRestore 调用）
  - `syncChatSaveButton()` — 同步保存按钮状态（被 aiPane 调用）

### Phase 3: 集成修改

- [ ] **3.1** 修改 `src/ui/aiPane.js`：
  - TABS 数组移除 `{ id: 'chat', label: '对话' }`
  - 移除 `renderChatTab()` 调用和函数定义
  - 移除 `bindChat()` 调用和函数定义
  - 移除 `sendChat()` / `appendChatBubble()` / `scrollChatToBottom()` 函数
  - 移除 `showDownloadDialog()` / `closeDownloadDialog()` 函数（已迁移）
  - 移除 `makeFilename()` / `downloadFile()` / `saveViaFileSystemAPI()` / `escapeHtml()`（已迁移到 download.js）
  - 在 tab 栏末尾添加 `<button class="ai-tab ai-tab--chat-float" type="button">Chat</button>`
  - Chat 按钮 `click` → 调用 `openChatWindow()`
  - Import 从 download.js 引入工具函数
  - Import 从 chatWindow.js 引入 `openChatWindow`, `renderChatList`, `syncChatSaveButton`
  - `refreshAfterRestore()` 中 `renderChatList()` 和 `syncChatSaveButton()` 改为调用 chatWindow 的版本
  - 移除 initAiPane 中的 quickAsk 订阅（该逻辑移至 chatWindow.js）

- [ ] **3.2** 修改 `src/ui/textPane.js`：
  - "追问"按钮 click handler：`setState` 改为设置 `chatWindow.open = true` 而非 `activeTab = 'chat'`
  - 保留 `quickAsk` 设置逻辑
  - 注意：使用 spread 保持 chatWindow 其他字段不变

- [ ] **3.3** 修改 `src/main.js`：
  - Import `initChatWindow` from chatWindow.js
  - 在初始化阶段调用 `initChatWindow()`（在 `initAiPane()` / `initTextPane()` 之后）

- [ ] **3.4** 检查 `src/ui/archiveDialog.js`：
  - 确认 `refreshAfterRestore()` 调用链路正常
  - 确认 `getSavedResults()` / `setSavedResults()` 不受影响

### Phase 4: 样式

- [ ] **4.1** 在 `src/styles.css` 添加悬浮窗样式：
  - `.chat-window` — fixed 定位，flex column，圆角，阴影，背景
  - `.chat-window__titlebar` — flex row，cursor move，padding，背景色
  - `.chat-window__controls` — 最小化/关闭按钮样式
  - `.chat-window__body` — flex:1，overflow auto，复用在 ai-pane 中的 chat 内部样式
  - `.chat-window__resize` — 8 个方向的触控区域（4px 宽/高），各方向光标
  - 拖拽中 body 状态：`user-select: none`

- [ ] **4.2** 浮动恢复按钮样式：
  - `.chat-float-btn` — fixed 右下角，圆角矩形/circle，阴影
  - hover 效果

- [ ] **4.3** AI 面板 Chat 按钮样式：
  - `.ai-tab--chat-float` — 与现有 `.ai-tab` 样式一致，略微视觉区分（如右边框分隔）

### Phase 5: 响应式

- [ ] **5.1** Bottom sheet 模式（≤960px）：
  - 使用 `matchMedia('(max-width: 960px)')` 监听
  - 激活时：窗口变为底部固定，全宽，圆角顶部，高度 45vh
  - 标题栏保留（顶部拖拽调高度），resize handles 隐藏
  - 拖拽标题栏仅调整高度：min 30vh ~ max 80vh
  - 浮动恢复按钮在 bottom sheet 模式下隐藏
  - 退出 bottom sheet 时恢复悬浮窗模式和保存的位置/尺寸

- [ ] **5.2** 过渡动画：
  - 悬浮窗 ↔ bottom sheet 切换时添加短暂过渡（可选，降低优先级）

### Phase 6: 验证

- [ ] **6.1** 功能验证：
  - `npm run dev` → 确认应用正常启动
  - 点击 AI 面板 "Chat" 按钮 → 悬浮窗出现在右下角
  - 发送消息 → streaming 正常显示
  - 拖拽标题栏 → 窗口可移动
  - 拖拽边缘/角落 → 窗口可缩放
  - 最小化 → 窗口消失，浮动按钮出现
  - 点击浮动按钮 → 窗口恢复
  - 关闭 → 同最小化
  - 刷新页面 → 窗口位置/尺寸恢复，窗口默认关闭
  - "追问" → 选中文本后点击，悬浮窗打开并自动发送

- [ ] **6.2** 兼容验证：
  - AI 面板 4 个分析 tab（总结/概念/质疑/翻译）正常生成和保存
  - Settings modal 正常打开/关闭，不被悬浮窗遮挡
  - 存档功能正常
  - 三栏拖拽调整宽度正常

- [ ] **6.3** 窄屏验证：
  - 缩窄浏览器到 ≤960px → 悬浮窗变为 bottom sheet
  - Bottom sheet 可上下拖拽调高度
  - 拉宽到 >960px → 恢复悬浮窗

- [ ] **6.4** 边界情况：
  - 无 API key 时 chat 发送 → 显示错误，不崩溃
  - 无 paper 时 chat 发送 → 显示错误，不崩溃
  - 快速连续点击 Chat 按钮 → 不创建多个窗口
  - 拖拽时鼠标移出视口 → 正确处理

## 风险点

- `aiPane.js` 约 880 行，chat 相关约 200 行，提取时注意不要误删分析 tab 逻辑
- `showDownloadDialog` 迁移后需确保所有引用路径正确
- `refreshAfterRestore` 调用链涉及 archiveDialog → aiPane → chatWindow
- 悬浮窗 z-index 需低于 settings modal (10001) 和 archive dialog (10003)

## 回滚点

- 每个 Phase 完成后 commit，出错可 revert
- Phase 2 完成后是主要回滚点（核心功能完成，集成前验证）
