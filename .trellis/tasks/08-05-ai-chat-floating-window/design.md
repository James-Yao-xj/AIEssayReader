# Design: AI 对话悬浮窗

## 1. 架构概览

```
main.js
  ├── chatWindow.js  [NEW]      —— 悬浮聊天窗（独立于三栏布局）
  │   ├── DOM: 悬浮窗 + 浮动恢复按钮
  │   ├── Drag: 标题栏拖拽移动
  │   ├── Resize: 8 方向边缘拖拽缩放
  │   ├── Chat: sendChat / renderChatList / streaming
  │   ├── Persist: localStorage 读写位置/尺寸
  │   └── Responsive: matchMedia → bottom sheet 模式
  │
  ├── aiPane.js       [MODIFIED] —— 移除 chat tab，保留 4 个分析 tab
  │   └── "Chat" 按钮 → chatWindow.openChatWindow()
  │
  ├── textPane.js     [MODIFIED] —— "追问"改为唤起悬浮窗
  │
  ├── store.js        [MODIFIED] —— ui.chatWindow 状态
  └── storage.js      [MODIFIED] —— 悬浮窗位置/尺寸持久化
```

**原则**：悬浮窗完全独立于三栏布局，`position: fixed`，不受 pane resize/collapse 影响。

## 2. 状态设计

### 2.1 Store 扩展

```js
// store.js State 类型
ui: {
  activeTab: 'summarize' | 'explainConcepts' | 'critique' | 'translate',  // 移除 'chat'
  busy: boolean,
  quickAsk: string | null,
  chatWindow: {
    open: boolean,   // 悬浮窗是否可见
    x: number | null,  // viewport left (null = 默认右下角)
    y: number | null,  // viewport top
    width: number,     // px, 默认 420
    height: number,    // px, 默认 500
  },
}
```

### 2.2 状态机

```
                 click "Chat" in tab bar
                 or click floating button
  ┌────────┐ ────────────────────────────> ┌──────────┐
  │ CLOSED │                                │  OPEN    │
  │ (float │ <──────────────────────────── │ (window  │
  │  btn   │   click minimize / close       │ visible) │
  │ shown) │                                └──────────┘
  └────────┘
      ↑
      └── 初始状态（首次加载）
      
  悬浮按钮显示条件：!chatWindow.open（关闭时始终显示）
```

- 关闭/最小化行为一致：隐藏窗口 + 显示浮动按钮
- 消息保存在 `store.messages`，关闭不丢失
- 位置/尺寸实时持久化到 localStorage

### 2.3 localStorage

Key: `aie:chat-window`
```json
{
  "x": null,      // null = 默认（计算右下角）
  "y": null,
  "width": 420,
  "height": 500
}
```

- `open` 不持久化（每次加载默认关闭）
- `x`/`y` 为 null 时使用默认逻辑：`right: 24px; bottom: 24px`
- 任何读取异常 → 回退默认值，不抛错

## 3. DOM 结构

### 3.1 悬浮窗

```html
<div id="chat-window" class="chat-window" style="left: Xpx; top: Ypx; width: Wpx; height: Hpx;">
  <!-- 标题栏（拖拽 handle） -->
  <div class="chat-window__titlebar" data-chat-drag-handle>
    <span class="chat-window__title">Chat</span>
    <div class="chat-window__controls">
      <button class="chat-window__btn chat-window__btn--minimize" title="最小化">_</button>
      <button class="chat-window__btn chat-window__btn--close" title="关闭">x</button>
    </div>
  </div>

  <!-- 消息区 + 输入区（复用现有 .chat-list / .chat-composer 结构） -->
  <div class="chat-window__body">
    <div class="chat-status" data-chat-status hidden></div>
    <div class="chat-list" data-chat-list></div>
    <div class="chat-composer">
      <textarea class="chat-input" data-chat-input rows="2"
        placeholder="基于当前论文提问...（Enter 发送 / Shift+Enter 换行）"></textarea>
      <div class="chat-composer__actions">
        <button class="ai-btn ai-btn--ghost" data-action="save-chat" disabled>保存对话</button>
        <button class="ai-btn ai-btn--ghost" data-action="stop" hidden>停止</button>
        <button class="ai-btn ai-btn--primary" data-action="send">发送</button>
      </div>
    </div>
  </div>

  <!-- 8 方向 resize handles -->
  <div class="chat-window__resize chat-window__resize--n"  data-resize="n"></div>
  <div class="chat-window__resize chat-window__resize--s"  data-resize="s"></div>
  <div class="chat-window__resize chat-window__resize--e"  data-resize="e"></div>
  <div class="chat-window__resize chat-window__resize--w"  data-resize="w"></div>
  <div class="chat-window__resize chat-window__resize--ne" data-resize="ne"></div>
  <div class="chat-window__resize chat-window__resize--nw" data-resize="nw"></div>
  <div class="chat-window__resize chat-window__resize--se" data-resize="se"></div>
  <div class="chat-window__resize chat-window__resize--sw" data-resize="sw"></div>
</div>
```

### 3.2 浮动恢复按钮

```html
<button id="chat-float-btn" class="chat-float-btn" hidden>Chat</button>
```

- `position: fixed; right: 24px; bottom: 24px`
- 圆形或药丸形按钮
- 显示/隐藏由 JS 控制（`chatWindow.open` 为 false 时显示）

## 4. 交互实现

### 4.1 拖拽移动（参考 `paneResize.js` 模式）

```
titlebar mousedown
  → 记录 startX/Y, windowStartLeft/Top
  → document mousemove: left = windowStartLeft + (e.clientX - startX), top = ...
    - 约束: left ∈ [0, viewportW - MIN_WIDTH], top ∈ [0, viewportH - MIN_HEIGHT]
    - CSS cursor: 'move', body userSelect: 'none'
  → document mouseup: 保存到 store + localStorage
```

### 4.2 缩放（参考 `paneResize.js` 模式）

8 个 resize handle，每个对应不同的边/角：
```
mousedown on handle
  → 记录 startX/Y, 以及被拖拽的是哪些边
  → document mousemove: 根据 handle 类型计算新的 left/top/width/height
    例如 handle 'se' (右下角):
      width += deltaX, height += deltaY（只变尺寸，位置不变）
    例如 handle 'n' (上边):
      top += deltaY, height -= deltaY
    例如 handle 'nw' (左上角):
      left += deltaX, width -= deltaX, top += deltaY, height -= deltaY
  → 约束: width >= MIN_WIDTH (300px), height >= MIN_HEIGHT (300px)
  → CSS cursor: 对应方向的 resize 光标
  → document mouseup: 保存到 store + localStorage
```

各 handle 的光标和逻辑：

| Handle | Cursor | 影响属性 |
|--------|--------|---------|
| n | n-resize | top, height |
| s | s-resize | height |
| e | e-resize | width |
| w | w-resize | left, width |
| ne | ne-resize | top, width, height |
| nw | nw-resize | left, top, width, height |
| se | se-resize | width, height |
| sw | sw-resize | left, width, height |

### 4.3 窄屏 Bottom Sheet（≤960px）

通过 `matchMedia('(max-width: 960px)')` 监听：

**激活条件**：视口宽度 ≤ 960px
**行为**：
- `.chat-window` 切换为 `.chat-window--bottom-sheet` 类
- CSS: `position: fixed; left: 0; right: 0; bottom: 0; height: 45vh; width: 100%; border-radius: 12px 12px 0 0;`
- 标题栏顶部中央添加拖拽手柄条（visual indicator）
- 拖拽标题栏仅调整高度（上下方向），最小 30vh，最大 80vh
- 隐藏 resize handles（仅保留顶部拖拽）
- 浮动按钮始终隐藏（bottom sheet 模式下不用浮动按钮）

**退出 bottom sheet**：窗口变宽 > 960px 时恢复悬浮窗模式，位置/尺寸从 store 读取。

### 4.4 最小尺寸约束

- 悬浮窗模式：`MIN_WIDTH = 300px`, `MIN_HEIGHT = 300px`
- Bottom sheet 模式：`MIN_HEIGHT = 30vh`, `MAX_HEIGHT = 80vh`

## 5. Chat 功能迁移

从 `aiPane.js` 迁移到 `chatWindow.js` 的函数：

| 函数 | 迁移方式 |
|------|---------|
| `renderChatTab()` | 改为创建完整悬浮窗 DOM |
| `bindChat()` | 移到 `initChatWindow()` 中 |
| `sendChat()` | 直接迁移，所有 `root` 引用改为 `chatRoot` |
| `renderChatList()` | 直接迁移，export 供 aiPane 调用 |
| `appendChatBubble()` | 直接迁移 |
| `scrollChatToBottom()` | 直接迁移 |
| `syncChatSaveButton()` | 直接迁移 |
| `syncChatStatus()` | 直接迁移 |
| `showDownloadDialog()` | 移到 chatWindow.js（它创建独立 overlay，不依赖父容器） |
| Chat 相关 store 订阅 | 移到 chatWindow.js 的 init 中 |

保留在 `aiPane.js` 的共用工具函数：
- `makeFilename()` → 提取到 `src/utils/download.js`（新建）
- `downloadFile()` → 同上
- `saveViaFileSystemAPI()` → 同上
- `escapeHtml()` → 同上

## 6. 追问适配

**`textPane.js` 修改**：
```js
// 旧:
setState({ ui: { ...getState().ui, activeTab: 'chat', quickAsk: prompts[0] } });

// 新:
setState({
  ui: { ...getState().ui, chatWindow: { ...getState().ui.chatWindow, open: true }, quickAsk: prompts[0] },
});
```

**`chatWindow.js` 订阅**：
```js
subscribe((s) => {
  if (s.ui.quickAsk && s.ui.chatWindow.open && !s.ui.busy) {
    const text = s.ui.quickAsk;
    setState({ ui: { ...getState().ui, quickAsk: null } });
    // 填入 input 并自动发送
    input.value = text;
    void sendChat();
  }
});
```

## 7. 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/ui/chatWindow.js` | **NEW** | 悬浮窗全部逻辑 |
| `src/utils/download.js` | **NEW** | 提取下载工具函数 |
| `src/ui/aiPane.js` | MODIFY | 移除 chat tab，添加"Chat"按钮 |
| `src/ui/textPane.js` | MODIFY | 追问适配悬浮窗 |
| `src/state/store.js` | MODIFY | 添加 chatWindow 状态 |
| `src/config/storage.js` | MODIFY | 添加 chatWindow 持久化 |
| `src/styles.css` | MODIFY | 悬浮窗样式 |
| `src/main.js` | MODIFY | 初始化 chatWindow |
| `index.html` | MODIFY | 可能需要移除 chat 相关的初始占位（如有）|

## 8. 兼容性

- **存档功能**：`getSavedResults()` / `setSavedResults()` 不包含 chat（chat 本身无 savedResults），`refreshAfterRestore()` 中的 `renderChatList()` 和 `syncChatSaveButton()` 改为从 chatWindow.js import
- **Pane resize/collapse**：悬浮窗不受影响（fixed 定位独立于三栏 flex 布局）
- **Settings modal**：悬浮窗 z-index 低于 settings modal（10001），不被遮挡但也不遮挡设置
- **Download dialog**：悬浮窗内的下载对话框在悬浮窗上方（z-index: chatWindow + 1 ~= 9999）
- **Archive dialog**：保持最高 z-index 10003

## 9. Z-Index 层次

```
10003 — Archive dialog
10002 — Download dialog (from chatWindow)
10001 — Settings modal
 9999 — Chat floating window
 9998 — Chat floating restore button
  ——— 正常内容 ———
    0 — 三栏布局
```

## 10. CSS 要点

### 悬浮窗
```css
.chat-window {
  position: fixed;
  z-index: 9999;
  min-width: 300px;
  min-height: 300px;
  border-radius: 8px;
  box-shadow: 0 4px 24px rgba(0,0,0,0.15);
  background: #fff;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
```

### 标题栏
```css
.chat-window__titlebar {
  cursor: move;
  user-select: none;
  padding: 8px 12px;
  background: #f5f5f5;
  border-bottom: 1px solid #e0e0e0;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
```

### Resize handles
```css
.chat-window__resize {
  position: absolute;
  z-index: 1;
}
.chat-window__resize--n  { top: 0; left: 4px; right: 4px; height: 4px; cursor: n-resize; }
.chat-window__resize--s  { bottom: 0; left: 4px; right: 4px; height: 4px; cursor: s-resize; }
/* ... 每个 handle 4px 宽的触控区域 */
```

### Bottom sheet 模式
```css
@media (max-width: 960px) {
  .chat-window--bottom-sheet {
    left: 0 !important;
    right: 0 !important;
    top: auto !important;
    bottom: 0 !important;
    width: 100% !important;
    height: 45vh;
    border-radius: 12px 12px 0 0;
  }
}
```

### 浮动按钮
```css
.chat-float-btn {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 9998;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  /* ... */
}
```
