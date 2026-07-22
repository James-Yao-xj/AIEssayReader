# 字体大小可配置

## Goal

用户可以在设置面板中调整阅读区域的字体大小，修改即时生效并持久化到 localStorage。

## Confirmed Facts (from code inspection)

- 当前字体大小全为 CSS 硬编码：
  - `.text-page__body`（中栏文本阅读区）：`font-size: 13px`
  - `.ai-result`（AI 结果展示区）：`font-size: 13px`
  - `.chat-bubble`（AI 对话气泡）：`font-size: 13px`
  - `.md-body` 内部使用 `em` 相对单位（如 `h1: 1.25em`），会跟随父级字号自适应
- 设置系统已有完整的 deep-merge + localStorage 持久化（`storage.js`）
- 设置面板有"基本设置"和"提示词模板"两个标签页
- store 使用 pub/sub 模式，settings 变化时通知所有订阅者
- 无现有外观/字号相关设置项

## Design Decision

采用 **CSS 自定义属性（CSS variables）**方案：
- 在 `document.documentElement` 设置 `--reader-font-size` 变量
- CSS 中 `.text-page__body`、`.ai-result`、`.chat-bubble` 引用该变量
- 默认值 `14px`，范围 `12px ~ 24px`，步长 `1px`
- 设置在"基本设置"标签页底部，以新的 "显示" fieldset 呈现
- UI 控件：`<input type="number" min="12" max="24" step="1">`，与现有温度输入框风格一致

## Scope Decision

- ✅ 影响：`.text-page__body`、`.ai-result`、`.chat-bubble`（阅读内容本体）
- ❌ 不影响：`.text-meta`（论文元信息标题）、`.text-page__head`（页号标签）——这些是辅助 UI 元素，保持固定小号
- ❌ 不影响：设置面板自身字号

## Requirements

- R1: 在"基本设置"标签页中新增"显示设置"区域，包含字体大小调节控件
- R2: 字体大小值持久化到 localStorage（与现有 settings 合并存储，字段名 `fontSize`）
- R3: 字体大小修改保存后即时应用到页面相关区域
- R4: 页面加载时从 localStorage 恢复用户设定的字体大小

## Acceptance Criteria

- [ ] 设置面板"基本设置"中可见字号设置项，包含一个 number input（12~24, step=1, default=14）
- [ ] 修改字号并保存后，中栏文本区、AI 结果区、对话气泡的字号同步变化
- [ ] 刷新页面后字号设置保持不丢失
- [ ] 范围 12~24px，步长 1px，默认 14px
- [ ] 设置面板自身字号不受影响

## Out of Scope

- 中栏元信息/页号字号
- 设置面板自身字号
- 字体家族/行高/对比度等其他外观设置
