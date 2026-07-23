# Design — 设置界面 UI 美化

## 1. 目标与约束

把"基本设置"里的两组模型配置（识别 / 阅读）从平铺 fieldset 改为"摘要卡片 + 点击配置
后 modal 内右侧滑入面板"，并去掉设置面板内的装饰性 Emoji。约束：

- **不改对外 API**：`initSettings()` / `openSettings()` / `closeSettings()` 签名不变，main.js 无需改动。
- **不改数据层**：store / storage.js / `saveSettings` / collectModelConfig / 校验逻辑一律不动。
- **不改表单字段 name**：`recognition.baseUrl` / `recognition.apiKey` / `recognition.model` /
  `recognition.temperature` / `reading.*` / `fontSize` 等保持原样，保证 `save()` 收集逻辑不变。
- **深色模式**：新增类必须配 `[data-theme="dark"]` 覆盖，与现有模式一致。

## 2. 影响面（文件）

| 文件 | 改动 |
|------|------|
| `src/ui/settings.js` | 重构"基本设置"tab 的 HTML 结构（卡片 + 滑入面板）；新增打开/关闭抽屉、刷新摘要卡片逻辑；去掉 3 个 Emoji。 |
| `src/styles.css` | 新增 `.settings-basic`、`.settings-card`、`.settings-drawer` 等样式 + 深色模式覆盖。 |
| `src/main.js` | **不动**。 |
| `src/config/*`、`src/state/*` | **不动**。 |

## 3. 新 DOM 结构（基本设置 tab）

只改 `data-tab-content="basic"` 这一区。两个模型组的**字段继续留在同一 `<form>` 内**，
抽屉只是"显隐某一组"的视图层，因此全局 `保存` 仍能收集到两组字段值。

```
<div class="settings-basic">                      <!-- position: relative; overflow: hidden -->
  <div class="settings-basic__list">               <!-- 卡片列表（默认全宽） -->
    <div class="settings-card" data-model-card="recognition">
      <div class="settings-card__head">
        <span class="settings-card__title">文本识别模型</span>
        <span class="settings-card__status" data-card-status="recognition">未配置</span>
      </div>
      <div class="settings-card__meta">模型：<span data-card-model="recognition">—</span></div>
      <button type="button" class="settings-card__config" data-open-drawer="recognition">配置</button>
    </div>
    <div class="settings-card" data-model-card="reading"> ... 同上 ... </div>

    <!-- 显示设置：保持简单内联 fieldset，仅去 Emoji -->
    <fieldset class="settings-fieldset settings-fieldset--display">
      <legend>显示设置</legend>           <!-- 去掉 🎨 -->
      ... 字号 input（原样） ...
    </fieldset>
  </div>

  <div class="settings-basic__drawer" aria-hidden="true">
    <div class="settings-basic__drawer-inner">
      <div class="settings-basic__drawer-header">
        <button type="button" data-close-drawer aria-label="返回">←</button>
        <span data-drawer-title>配置：文本识别模型</span>
        <span></span>
      </div>
      <div class="settings-basic__drawer-body">
        <!-- 两组字段都渲染在 DOM 里，按当前抽屉只显示一组 -->
        <fieldset class="settings-fieldset settings-drawer-group" data-model-fields="recognition"> ... 4 字段 ... </fieldset>
        <fieldset class="settings-fieldset settings-drawer-group" data-model-fields="reading" hidden> ... 4 字段 ... </fieldset>
      </div>
      <div class="settings-basic__drawer-actions">
        <button type="button" data-close-drawer>← 返回</button>
        <button type="submit" class="primary">保存</button>
      </div>
    </div>
  </div>
</div>
```

要点：
- 两个模型组的 4 个字段（含 name 属性）从原"基本设置"平铺区**搬进** `data-model-fields`
  fieldset；name 属性一字不改。
- "显示设置"fieldset 留在卡片列表里，去 Emoji。
- 抽屉的"保存"是 `type="submit"`，属同一 `<form>`，点击即触发现有 `save()`（保存两组 + 关闭 modal）。

## 4. 交互与状态

- **打开抽屉**：点 `data-open-drawer="<model>"` →
  1. 切换 `data-model-fields` 显隐（只显示对应模型组）。
  2. 设置 `data-drawer-title` 文案。
  3. 给 `.settings-basic` 加 class `is-drawer-open` → CSS 触发滑入。
  4. `aria-hidden=false`，聚焦首字段。
- **关闭抽屉**：点 `data-close-drawer` / Esc / 点 `.settings-basic` 内空白 scrim → 移除
  `is-drawer-open`，`aria-hidden=true`。**不丢弃**已填值（字段仍在 form 内）。
- **Esc 优先级**：抽屉打开时 Esc 只关抽屉；抽屉关闭时 Esc 关整个设置（沿用现有逻辑）。需在
  现有 keydown 监听里加判断。
- **点遮罩关闭**：现有 modal 级遮罩（`data-close`）仍关整个面板；抽屉的 scrim 是 `.settings-basic`
  内的独立遮罩层，只关抽屉。
- **保存语义不变**：抽屉里的"保存"= 表单 submit = 现有 `save()`；两组 apiKey 各自"留空保留原值"。

## 5. 摘要卡片数据流

- 新增 `renderSummaryCards()`：读 `getState().settings`，设置每张卡：
  - `data-card-model="<model>"` → `settings[model].model || '未设置'`
  - `data-card-status="<model>"` → `settings[model].apiKey ? '✓ 已配置' : '未配置'`
- 调用时机：`openSettings()`（syncFormFromStore 之后）。
- 颜色编码：未配置用警示色（橙/红文字或小圆点），已配置用成功色。深浅模式各一套。

## 6. 关键 CSS 方案

```
.settings-basic        { position: relative; min-height: 320px; overflow: hidden; }
.settings-basic__list  { display:flex; flex-direction:column; gap:12px;
                         transition: padding-right .25s ease; }
/* 抽屉打开时把列表内容挤到左半，避免 [配置] 按钮被抽屉盖住 */
.settings-basic.is-drawer-open .settings-basic__list { padding-right: 52%; }

/* scrim：抽屉打开时盖在列表上的半透明遮罩，点击关抽屉 */
.settings-basic__scrim { position:absolute; inset:0; background: rgba(0,0,0,.25);
                         opacity:0; pointer-events:none; transition: opacity .25s; }
.settings-basic.is-drawer-open .settings-basic__scrim { opacity:1; pointer-events:auto; }

.settings-basic__drawer { position:absolute; top:0; right:0; bottom:0; width:52%;
                          transform: translateX(100%); transition: transform .25s ease;
                          z-index:2; /* 盖在 list 与 scrim 之上 */ }
.settings-basic.is-drawer-open .settings-basic__drawer { transform: translateX(0); }
```

- 抽屉用 `transform` 滑动（GPU 友好，不触发 reflow）；列表用 `padding-right` 过渡（单元素，
  可接受）。两者时长一致（.25s）保证视觉同步。
- `prefers-reduced-motion: reduce` 下把 transition 置 0（无障碍，低成本）。
- 深色模式：`.settings-card`、`.settings-basic__drawer-inner`、状态色、scrim 透明度均需
  `[data-theme="dark"]` 覆盖，集中写在现有深色模式区块附近。

## 7. 兼容性 / 回滚

- 纯前端 UI 改动，无存储格式 / store shape 变化；老 localStorage 数据完全兼容。
- 回滚：还原 `src/ui/settings.js` 与 `src/styles.css` 两文件即可，无迁移成本。
- 风险点：字段 name 漂移会导致 `save()` 收不到值 —— 实现时必须逐字段核对 name 与现有
  `collectModelConfig` 一致（见 implement.md 验证项）。

## 8. 不做（Out of Scope）

- 提示词模板 tab 结构、移动端响应式、顶栏/对话 Emoji、给抽屉加独立保存分支逻辑。
