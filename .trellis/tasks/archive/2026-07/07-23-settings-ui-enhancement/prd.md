# 设置界面 UI 美化：删除 Emoji + 模型配置收起为滑入面板

## Goal

美化"设置"界面的视觉与交互体验：去掉装饰性 Emoji，并把占空间最多的"模型 API Key 配置"
从平铺式 fieldset 改为"收起态摘要卡片 + 点击配置按钮后从右侧滑入完整配置面板"的形式，
让默认打开设置时的界面更清爽、焦点更集中。

## Confirmed Facts（来自代码）

- 设置面板入口：顶栏 `btn-settings` → `openSettings()`（main.js:452），点未配置徽标也会打开（main.js:467）。
- 当前面板是居中 modal（960px，`settings-modal__panel`），两个 tab：基本设置 / 提示词模板。
- 设置面板内含 Emoji 的位置（settings.js）：
  - `📷 文本识别模型`（settings.js:66）
  - `📖 文本阅读模型`（settings.js:95）
  - `🎨 显示设置`（settings.js:124）
- 每个 fieldset（识别 / 阅读）含 4 个字段：Base URL / API Key / 模型 / 温度；显示设置 fieldset 含字号。
- API Key 永不回显明文，已配置时占位提示"已配置（留空则不修改）"。
- 深色模式已用 `[data-theme="dark"]` 整体覆盖（styles.css:1195+），新面板需同步支持深色模式。
- 其它 Emoji（不在设置面板内）：顶栏 `⚙ 设置` / `☀️🌙` 主题（index.html:25-26, main.js:430）、
  对话气泡 `🧑 你` / `🤖 AI`（aiPane.js:250）、关闭符 `✕`（textPane.js:229）。

## Requirements

### R1 删除 Emoji（范围：仅设置面板内）
- 移除 settings.js 三个 legend 的装饰性 Emoji：`📷 文本识别模型`、`📖 文本阅读模型`、`🎨 显示设置`。
- 面板外 Emoji（顶栏 `⚙ 设置` / `☀️🌙`、对话气泡 `🧑🤖`、`✕`）**不动**。

### R2 模型配置收起为"摘要卡片 + 右侧滑入面板"
- 默认打开设置时，识别模型 / 阅读模型 不再平铺 4 个字段，而是显示一张摘要卡片：
  标题 + 模型名 + API Key 配置状态 + 一个"配置"按钮。
- 点击"配置"按钮 → **设置 modal 内部右侧**滑入完整配置面板（含 Base URL / API Key / 模型 / 温度），
  左侧仍可见摘要卡片列表（modal 内右侧分栏形态）。
- 滑入面板用 transform translateX 过渡；同时支持浅色 / 深色模式。
- 关闭滑入面板（返回按钮 / Esc / 点遮罩）回到摘要卡片列表。
- 保存逻辑沿用现状（两组 apiKey 各自"留空则保留原值"的合并语义不变）。
- "显示设置"（字号）保持简单内联 fieldset（仅去 Emoji），不进入滑入面板。

## Resolved Decisions（已确认）
- Emoji 范围 = 仅设置面板内（用户确认）。
- 滑入形态 = modal 内右侧分栏（用户确认）。
- 摘要卡片 = 显示模型名 + Key 配置状态（用户确认）。

## Acceptance Criteria

- [ ] 设置面板内不再出现 `📷` `📖` `🎨` 等装饰性 Emoji。
- [ ] 打开设置 → 基本设置 tab，识别/阅读模型以摘要卡片呈现，不再平铺展示 Base URL/API Key/模型/温度。
- [ ] 点击卡片上的"配置"按钮，配置面板从右侧滑入，动画顺滑。
- [ ] 滑入面板内可填写并保存模型配置；保存后摘要卡片的状态摘要同步刷新。
- [ ] Esc / 点遮罩 / 关闭按钮 可关闭滑入面板。
- [ ] 浅色与深色模式下，卡片与滑入面板均可读、无错位。
- [ ] 提示词模板 tab 行为不受影响。

## Out of Scope（除非明确确认）

- 提示词模板 tab 的结构改动。
- 后端 / store / storage 层逻辑改动（除同步刷新摘要所需）。
- 移动端响应式（当前为桌面优先三栏布局）。

## Open Questions

（已全部解决，见 Resolved Decisions）
