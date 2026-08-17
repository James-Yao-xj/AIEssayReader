# Design: 论文相关文献检索

## 1. 架构概览

```
aiPane.js  [MODIFIED] —— 新增「相关论文」Tab + 搜索框 + 结果渲染
  └── relatedPapers.js  [NEW] —— 编排：解析输入 → S2 三路检索 → 代码徽标
        ├── semanticScholar.js  [NEW] —— Semantic Scholar REST 客户端
        └── github.js           [NEW] —— GitHub 仓库搜索（轻量代码徽标）

settings.js [MODIFIED] —— 新增可选 S2 API Key 字段
defaults.js / storage.js [MODIFIED] —— settings.s2ApiKey 持久化
styles.css  [MODIFIED] —— 相关论文结果样式
```

**原则**：纯浏览器架构不变，不引入后端/代理。Semantic Scholar 与 GitHub 均直接由浏览器 fetch 调用（两者均返回 `Access-Control-Allow-Origin: *`，已实测确认）。

## 2. 设置扩展

`settings.s2ApiKey`：可选字符串，默认空。空 → S2 匿名配额（极紧，易 429）；填了 → 走 `x-api-key` 头，配额大幅提升。

- `defaults.js` 顶层新增 `s2ApiKey: ''`
- `storage.js` `deepMergeSettings()` 新增：`if (typeof user.s2ApiKey === 'string') result.s2ApiKey = user.s2ApiKey`
- `settings.js` 基本设置页新增一个内联 fieldset「论文检索（可选）」：S2 API Key 输入框（不回显明文，逻辑同现有 apiKey 字段）

GitHub 用匿名搜索（10 请求/分钟），不新增 token 设置。

## 3. 外部 API 契约

### 3.1 Semantic Scholar（base `https://api.semanticscholar.org/graph/v1`）

请求头：配置了 key 时 `x-api-key: <s2ApiKey>`。

通用论文字段串（查询时用 `fields=`）：
`title,abstract,year,authors,venue,citationCount,externalIds,openAccessPdf,url`

| 用途 | 端点 | 响应关键路径 |
|------|------|------|
| 解析标题 | `GET /paper/search?query=<q>&fields=…&limit=1` | `.data[0]` |
| 按 paperId | `GET /paper/<paperId>?fields=…` | 根对象 |
| 按 DOI | `GET /paper/DOI:<doi>?fields=…` | 根对象 |
| 按 arXiv | `GET /paper/arXiv:<id>?fields=…` | 根对象 |
| 相似推荐 | `GET /paper/<id>/recommendations?fields=…&limit=10` | `.recommendedPapers[]` |
| 参考文献 | `GET /paper/<id>/references?fields=…&limit=10` | `.data[].citedPaper` |
| 被引论文 | `GET /paper/<id>/citations?fields=…&limit=10` | `.data[].citingPaper` |

统一归一化为 `Paper` 形状：
```js
{ paperId, title, abstract, year, authors:[{name}], venue,
  citationCount, externalIds:{DOI,ArXiv}, openAccessPdf:{url}, url }
```
`url` 兜底为 `https://www.semanticscholar.org/paper/<paperId>`。

### 3.2 GitHub 搜索（`https://api.github.com/search/repositories`）

`GET /search/repositories?q=<methodName>+in:name&per_page=5`，匿名，头 `Accept: application/vnd.github+json`。响应 `.items[].full_name`（如 `Eku127/DualMap`）。

## 4. 输入解析

`resolveInput(raw)` 返回 `{ type, value }`：

| 模式（按顺序） | type | value | 端点 |
|------|------|------|------|
| `https://…semanticscholar.org/paper/<40hex>` | `paperId` | 40hex | `/paper/<id>` |
| `^[0-9a-f]{40}$` | `paperId` | 原串 | `/paper/<id>` |
| `doi.org/…` 或 `^10.\d{4,9}/…` | `doi` | DOI 串 | `/paper/DOI:<doi>` |
| `arxiv.org/abs/…` 或 `^(\d{4}\.\d{4,5})(v\d+)?$` 或 `arxiv:…` | `arxiv` | 编号 | `/paper/arXiv:<id>` |
| 其余 | `title` | 原串 | `/paper/search` |

## 5. 编排流程 `searchRelated(input, { signal })`

```
1. resolveInput → 用对应端点解析目标论文 paperId（失败→抛"未找到匹配论文"）
2. 串行 + 退避依次拉取：recommendations / references / citations
   （S2 限流紧：每次间隔 ~1.2s，遇 429 指数退避重试 ≤3 次）
3. 返回 { target, recommendations, references, citations }（各为 Paper[]）
4. UI 立即渲染三区结果（不等待代码徽标）
5. 后台异步执行代码徽标（见 §6），增量回填「有代码」徽标
```

取消：`signal` 透传到每次 fetch；`AbortError` 向上抛由 UI 处理。

## 6. 代码徽标（轻量 GitHub 校验）

**方法名提取**（借鉴 skill 信号 B，不做信号 A 的 README 引用校验）：
- 标题按空白/标点分词；取形如「驼峰复合词」的 token：首字母大写、含内部大写、含小写、长度 4~30、非全大写缩写、不在停用词表（`Vision/Offline/Think/GPT/VLN/CLIP/YOLO/…` 等通用词与已知缩写）。
- 取第一个命中 token 作为候选方法名；无候选则该项跳过（不显示徽标）。

**GitHub 校验**：`q=<methodName> in:name`，若某仓库 `full_name` 去掉 owner 前缀后与 methodName 大小写不敏感相等或包含 → 命中，记录 `{ repo, stars }`。

**限流边界（关键）**：匿名 10 请求/分钟。因此每次检索**最多校验 10 篇**（recommendations 优先，其次 references、citations），请求间隔 ~6.5s，总耗时约 1 分钟；命中/未命中/超限都**不阻塞主结果**，徽标异步逐个出现。未纳入校验的论文不显示徽标（绝不因此过滤）。

## 7. UI 结构

`TABS` 数组新增 `{ id: 'related', label: '相关论文' }`。`ai-body` 内新增：

```html
<section class="ai-pane__section" data-section="related" hidden>
  <div class="ai-section__head"><div class="ai-section__title">相关论文</div></div>
  <div class="related-search">
    <input class="related-search__input" data-related-input
      placeholder="论文标题 / DOI / arXiv / URL…">
    <button class="ai-btn ai-btn--primary" data-action="related-search">检索</button>
  </div>
  <div class="ai-error" data-error hidden></div>
  <div class="related-status" data-related-status hidden></div>
  <div class="related-results" data-related-results>
    <div class="ai-placeholder">加载论文后自动填入标题，或手动输入后点「检索」。</div>
  </div>
</section>
```

结果按三区分组渲染：
```
## ⭐ 相似推荐
## 🔗 参考文献（前人工作）
## 📖 被引论文（后续工作）
```
每条：`**标题**`（外链 S2/DOI/arXiv）→ `作者 · 年份 · 期刊 · 被引 N` → `摘要（截断 ~200 字）` → `[有代码]` 徽标（命中时）。

## 8. 状态与交互

- **预填**：`subscribe` 监听 `paper` 变化——`paper.name` 变化时，把输入框设为 `paper.meta.title || ''` 并清空结果区（与 loadPdf 的 `setState` 天然对齐）。用户手动清空后不强制回填（仅 paper 切换时回填）。
- **busy**：检索期间置 `ui.busy`，禁用「检索」按钮与 Tab 切换（复用现有 `syncBusy`/`bindTabs` 的 busy 拦截）。代码徽标后台阶段**不**占用 busy（结果已可用）。
- **加载新论文 / 切回 Tab**：结果区随 paper 切换清空；Tab 切换本身不清空（保留本 session 结果）。

## 9. 错误处理

| 情形 | 处理 |
|------|------|
| S2 429（退避后仍失败） | 「Semantic Scholar 限流，请稍后重试或在设置中配置 S2 API Key」 |
| fetch 抛 TypeError（网络/CORS） | 「无法访问 Semantic Scholar（网络或跨域限制）」 |
| S2 401/403 | 「S2 API Key 无效，请检查设置」 |
| 解析不到目标论文 | 「未找到匹配论文，请核对标题/DOI/arXiv」 |
| 某分组无结果 | 该组显示「（无结果）」，不视为错误 |
| GitHub 403/429 | 静默跳过徽标，不影响主结果 |
| 用户取消 | AbortError → 显示「已停止」 |

## 10. 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/related/semanticScholar.js` | NEW | S2 客户端 + 退避 + 归一化 |
| `src/related/github.js` | NEW | 方法名提取 + 仓库搜索 |
| `src/related/relatedPapers.js` | NEW | 解析输入 + 编排 + 徽标调度 |
| `src/config/defaults.js` | MODIFY | 新增 `s2ApiKey` |
| `src/config/storage.js` | MODIFY | 深合并 `s2ApiKey` |
| `src/ui/settings.js` | MODIFY | 新增 S2 Key 字段（基本设置） |
| `src/ui/aiPane.js` | MODIFY | 新增 Tab + section + 绑定 |
| `src/styles.css` | MODIFY | 结果列表/徽标样式 |

## 11. 兼容性

- **存档**：相关论文结果**不纳入存档**（`getSavedResults`/`setSavedResults` 不改；`refreshAfterRestore` 的 4 个分析 task 循环不受影响）。
- **与 `08-05-ai-chat-floating-window` 交互**：两者都改 `aiPane.js` 的 `TABS`。本任务纯增量（加一个 tab + section），与前者「移除 chat tab、加 Chat 按钮」正交；合入时注意 `TABS` 数组与 `ai-body` 模板的合并即可，无逻辑耦合。
- **busy 语义**：复用现有 `ui.busy`，代码徽标后台阶段不置 busy，避免干扰其他分析 Tab。

## 12. Hallmark 设计规范（前端 · 组件级）

**范围**：只约束本任务新增的组件（`.related-search` 输入框、`.related-results` 结果列表、`.related-item` 条目、`.related-badge` 徽标、Tab）。既有 2400 行样式 **append-only**，不改写既有设计系统。

**保留既有系统**：字体栈、hex 语义色（主色 `#0d6efd`、暗色 `#4a9eff`、灰阶、success/warning/error）、间距习惯、light/dark 主题变量结构。

**引入的纪律**（只作用于新组件）：
1. **8 态交互**：搜索输入框与「检索」按钮覆盖 default / hover / `:focus-visible` / `:active` / disabled / loading（检索中）/ error（失败提示）/ success（有结果）——其中 loading 用 `data-state` 属性驱动按钮文案「检索中…」；error/success 由 `.related-status` / `.ai-error` 承载。
2. **`:focus-visible`**：新组件统一用 `:focus-visible`（非 `:focus`）出可见焦点环，≥3:1 对比度，环即时出现（不做过渡动画）。
3. **对比度**：正文 ≥4.5:1、次要文字 ≥3:1；徽标/状态色在 light+dark 两主题下均达标。
4. **`prefers-reduced-motion: reduce`**：新组件的 loading/徽标出现动画在该偏好下坍缩为 ≤150ms opacity 交叉淡入（或直接 none）。
5. **禁斜体标题**：结果标题、分组标题一律 roman；强调用字重/颜色，不用斜体。
6. **诚实文案**：摘要只展示 API 真实返回值并截断（标「…」），不编造被引数/年份/期刊；无数据字段显示「—」而非假数字。

**token 决策**：新组件样式块顶部新增一段 `:root` 语义 CSS 变量（`--rel-accent`/`--rel-muted`/`--rel-border`/`--rel-surface`/`--rel-success` 等），值取自既有 hex 色板，新组件内一律引用变量、不内联裸 hex——作为该文件逐步 token 化的起点，不回头改既有规则。dark 主题下用 `[data-theme="dark"]` 覆盖这些变量。

**Hallmark stamp**：新 CSS 块首行注释 `/* Hallmark · scope: component · genre: utilitarian · tone: technical · theme: inherited */`。
