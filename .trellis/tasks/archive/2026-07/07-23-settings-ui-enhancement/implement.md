# Implement — 设置界面 UI 美化

按顺序执行；每步后跑对应验证。改动集中在 `src/ui/settings.js` 与 `src/styles.css`。

## 前置验证（动手前）

- [ ] 确认当前任务：`python ./.trellis/scripts/task.py current` = `07-23-settings-ui-enhancement`。
- [ ] `npm run dev` 可正常启动、设置面板能打开（建立改动前基线）。

## Step 1 — 去掉设置面板内 Emoji（最小改动，先落地）

- [ ] settings.js:66 legend `📷 文本识别模型` → `文本识别模型`
- [ ] settings.js:95 legend `📖 文本阅读模型` → `文本阅读模型`
- [ ] settings.js:124 legend `🎨 显示设置` → `显示设置`
- [ ] 验证：`grep -nP "[\x{1F000}-\x{1FAFF}]" src/ui/settings.js` 无输出。

## Step 2 — 重构"基本设置"tab DOM 结构

- [ ] 在 settings.js 把原 `data-tab-content="basic"` 内的两组模型 fieldset 替换为：
  - `.settings-basic` 容器（含 `.settings-basic__scrim`、`.settings-basic__list`、`.settings-basic__drawer`）。
  - `.settings-basic__list` 内放两张 `.settings-card`（识别 / 阅读）+ 原"显示设置"fieldset。
  - `.settings-basic__drawer` 内放两组 `data-model-fields` fieldset（识别 / 阅读）。
- [ ] **逐字段核对**：把原识别/阅读 fieldset 的 4 个 input 原样搬入 `data-model-fields`，
      name 属性（`recognition.baseUrl` 等）**一字不改**。
- [ ] 抽屉 header 的 `data-drawer-title`、关闭按钮 `data-close-drawer`、scrim、打开按钮
      `data-open-drawer="<model>"` 的 data 属性按 design.md §3 命名。

## Step 3 — 抽屉交互逻辑（settings.js）

- [ ] 新增 `openDrawer(model)`：切换两组 `data-model-fields` 显隐；设标题；加 `is-drawer-open`
      class；`aria-hidden=false`；聚焦首字段。
- [ ] 新增 `closeDrawer()`：移除 class、`aria-hidden=true`。
- [ ] 事件委托（沿用现有 modal 级监听风格）：
  - 点 `data-open-drawer` → `openDrawer(model)`
  - 点 `data-close-drawer` 或点 `.settings-basic__scrim` → `closeDrawer()`
- [ ] 修改现有 Esc keydown：抽屉打开时 Esc 只 `closeDrawer()` 并 `return`，不再关整个面板；
      抽屉关闭时维持原行为（关面板）。
- [ ] `openSettings()` 末尾调用 `closeDrawer()`（保证每次打开是卡片态）+ `renderSummaryCards()`。

## Step 4 — 摘要卡片渲染（settings.js）

- [ ] 新增 `renderSummaryCards()`：读 `getState().settings`，填 `data-card-model` /
      `data-card-status`；已配置→成功色文案，未配置→警示色文案。
- [ ] 在 `openSettings()`（syncFormFromStore 之后）调用一次。
- [ ] `save()` 成功后 store 已更新；下次 openSettings 自动刷新（满足 AC"保存后摘要刷新"）。

## Step 5 — 样式（styles.css）

- [ ] 新增 `.settings-basic` / `.settings-basic__list` / `.settings-basic__scrim` /
      `.settings-basic__drawer` / `.settings-basic__drawer-inner` / `-header` / `-body` /
      `-actions` / `.settings-card*` 样式（按 design.md §6）。
- [ ] `.settings-basic__list` 抽屉打开时 `padding-right:52%`；抽屉 `translateX` 过渡 .25s。
- [ ] `@media (prefers-reduced-motion: reduce)` 下 transition 置 0。
- [ ] 深色模式：在现有 `[data-theme="dark"]` 区块补 `.settings-card`、抽屉、状态色、scrim 覆盖。

## 验证（Quality Gate）

- [ ] **字段 name 未漂移**：`grep -nE 'name="(recognition|reading)\.' src/ui/settings.js`
      应仍含 `baseUrl/apiKey/model/temperature` 各两组。
- [ ] **Emoji 清除**：`grep -nP "[\x{1F000}-\x{1FAFF}]" src/ui/settings.js` 无输出。
- [ ] **构建**：`npm run build`（或 dev）无报错。
- [ ] **手动冒烟（浅色 + 深色）**：
  - 打开设置 → 基本设置显示两张卡片，不再平铺字段。
  - 点"配置" → 抽屉从右滑入，标题正确，4 字段可见可填。
  - 填写并"保存" → 设置关闭；再开 → 卡片显示新模型名 + Key 状态。
  - Esc（抽屉开）只关抽屉；Esc（抽屉关）关面板。
  - 点 scrim 关抽屉；点 modal 遮罩关面板。
  - 提示词模板 tab 仍正常。
  - 深色模式下卡片/抽屉/状态色均可读。

## 回滚点

- 若抽屉交互引入回归，可临时在 `openSettings()` 不调用 `openDrawer`，卡片态仍可用。
- 字段 name 漂移是最危险点 —— Step 5 验证项必须通过。
