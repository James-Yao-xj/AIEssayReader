# Implement: 论文相关文献检索

实现顺序自底向上：配置 → 数据层 → 编排 → UI → 样式 → 验证。

## 1. 配置层（settings.s2ApiKey）

- [ ] `src/config/defaults.js`：`DEFAULT_SETTINGS` 顶层加 `s2ApiKey: ''`（紧跟 `fontSize` 之后，加注释）
- [ ] `src/config/storage.js`：`deepMergeSettings()` 加一行合并 `s2ApiKey`

## 2. 数据层

### `src/related/semanticScholar.js`（NEW）

- [ ] 常量：`S2_BASE`、`PAPER_FIELDS` 串
- [ ] `fetchJson(path, { signal, retries=3 })`：拼 URL、加 `x-api-key`（若 settings.s2ApiKey 非空）、`AbortSignal` 透传、非 2xx 抛语义 Error、`res.json()`；429 时指数退避重试（`2^n * 1200ms`），退避期间监听 `signal.aborted`
- [ ] `resolveInput(raw)` → `{ type, value }`（按 design §4 顺序）
- [ ] `resolvePaper(input, signal)` → 目标 `Paper`（按 type 选端点）
- [ ] `getRecommendations(id, signal)` / `getReferences(id, signal)` / `getCitations(id, signal)` → `Paper[]`（各自取对应响应路径）
- [ ] `normalizePaper(raw)` → 统一形状（title/authors/venue/year/citationCount/abstract/externalIds/url 兜底）

### `src/related/github.js`（NEW）

- [ ] `extractMethodName(title)` → 驼峰复合词候选或 null（含停用词表 + 长度 4~30 + 非全大写）
- [ ] `findRepo(methodName, signal)` → `{ repo, stars } | null`（`q=<name> in:name&per_page=5`，大小写不敏感匹配；403/429/网络错返回 null 不抛）

### `src/related/relatedPapers.js`（NEW）

- [ ] `searchRelated(input, { signal, onBadge })`：`resolvePaper` → 串行拉三路（间隔 ~1.2s）→ 返回 `{ target, recommendations, references, citations }`
- [ ] `computeBadges(papers, { signal, onBadge, maxChecks=10 })`：按 recommendations→references→citations 顺序取 ≤10 篇，间隔 ~6.5s 调 `findRepo`，命中即 `onBadge(paperId, repo)`

## 3. 设置 UI

- [ ] `src/ui/settings.js`：基本设置内联新增 fieldset「论文检索（可选）」+ `name="s2ApiKey"` 输入框（type=password，占位「已配置（留空则不修改）」逻辑复用 `syncApiKeyField`）；`syncFormFromStore` 同步、`save()` 收集（留空保留原值）

## 4. AI 面板 UI

- [ ] `src/ui/aiPane.js`：
  - `TABS` 加 `{ id: 'related', label: '相关论文' }`
  - `ai-body` 模板加 `renderRelatedTab()`
  - `bindRelated()`：检索按钮 → 读输入 → `searchRelated` → 渲染三区；错误入 `[data-error]`
  - `subscribe` 内监听 `paper` 变化 → 预填输入 + 清空结果
  - `syncBusy()` 覆盖 `[data-action="related-search"]` 禁用态

## 5. 样式（Hallmark · 组件级）

- [ ] `src/styles.css` 追加（不改既有规则）：
  - 新组件块首行 Hallmark stamp 注释
  - `:root` 语义变量（`--rel-*`，值取自既有 hex 色板）+ `[data-theme="dark"]` 覆盖
  - `.related-search`（输入框 + 检索按钮）、`.related-results`（三区分组）、`.related-item`（标题外链/作者/年份/期刊/被引/摘要/徽标）、`.related-badge`
- [ ] 8 态：输入框与按钮覆盖 default/hover/`:focus-visible`/`:active`/disabled/loading(`data-state`)/error/success
- [ ] 焦点环用 `:focus-visible` 且对比度 ≥3:1，不做环出现动画
- [ ] `prefers-reduced-motion: reduce` 下 loading/徽标动画坍缩为 ≤150ms opacity 或 none
- [ ] 标题/分组标题一律 roman（无斜体）；摘要真实截断（标「…」），缺失字段显示「—」
- [ ] light + dark 双主题自检对比度

## 6. 验证

- [ ] `npm run build` 成功（单 HTML 产物，无外部文件引用告警）
- [ ] `npm run preview` 手动验证：
  1. 拖入 PDF → AI 面板出现「相关论文」Tab，输入框已预填标题
  2. 点「检索」→ loading → 三区结果渲染（相似推荐/参考文献/被引论文）
  3. 每条含标题（可点开外链）、作者·年份·期刊·被引、摘要、徽标
  4. 未加载论文时手动输入标题/DOI/arXiv 仍可检索
  5. 断网 / 未配 S2 key 触发限流 → 友好错误，不抛未捕获异常
  6. 含驼峰方法名标题的论文，GitHub 命中时显示「有代码」徽标（异步出现）
  7. 切换 Tab / 加载新论文，结果区状态正确

## 回滚点

- 纯增量改动，无数据迁移。回滚 = `git checkout -- src/related src/config/defaults.js src/config/storage.js src/ui/settings.js src/ui/aiPane.js src/styles.css`
- 若 GitHub 徽标限流问题突出，可临时 `computeBadges` 直接 return（不查 GitHub），主功能不受影响

## 风险文件

- `src/ui/aiPane.js`：与在办任务 `08-05-ai-chat-floating-window` 同改 `TABS`/`ai-body`，合入时注意模板合并
- `src/related/semanticScholar.js`：S2 限流退避逻辑，是易出 bug 点（退避期间需响应 AbortSignal）
