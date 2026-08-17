# 论文相关文献检索（找相关论文）

## Goal

在浏览器 App 中新增「找相关论文」功能：基于当前加载的论文（自动预填标题，可编辑），调用 Semantic Scholar API 检索相关/相似文献，结果展示在 AI 面板的新 Tab 中，帮助用户扩展阅读列表、了解研究现状。

## Confirmed Facts（代码库确认）

- 纯浏览器 SPA，无后端；Vite + `vite-plugin-singlefile` → 单 HTML 产物
- 设置存 localStorage（key `aie:settings`），模型配置分 `recognition` / `reading` 两组；密钥明文本地存、UI 不回显
- 现有 provider 抽象只面向 OpenAI 兼容协议（`src/ai/openai.js`）；Semantic Scholar / GitHub 是全新外部数据源，需新增模块
- 当前加载论文的元信息在 `store.paper.meta`（`title` / `authors` / `nPages`），来自 PDF 内嵌 metadata，**可能缺失或不准确**
- AI 面板（`src/ui/aiPane.js` ~880 行）现有 5 个 Tab：summarize / explainConcepts / critique / translate / chat
- 顶栏已有 设置 / 主题 / 存档 按钮（`src/main.js` 装配）
- 项目内无任何 Semantic Scholar / GitHub 相关代码
- 现有 modal 模式（Settings / Archive / Download）与 Tab 模式（AI 面板）均可复用

## Requirements

### 功能范围（已决）

- **R1 — 开源代码徽标（折中）**：不做"只报告有代码论文"的硬过滤。每条 S2 结果做一次轻量 GitHub 校验（仓库名匹配标题中的驼峰方法名，不做 README 引用校验），命中则显示「有代码」徽标，未命中照常展示。
- **R2 — 目标论文输入**：AI 面板新 Tab 内有一个搜索框；加载论文后自动预填 `paper.meta.title`（无标题则留空），用户可编辑后再点检索。
- **R3 — 检索范围**：官方相似推荐（recommendations）+ 引用网络（references 参考文献 + citations 被引论文）三区展示；不做主题关键词补充检索。
- **R4 — UI 入口**：AI 面板新增「相关论文」Tab，与现有分析 Tab 并列。

### 行为细节

- **R5**：输入支持论文标题（主路径）；对 DOI / arXiv / S2 paperId / S2 URL 做简单识别并直接解析（其余走 `/paper/search`）。
- **R6**：每条结果展示：标题（可点开 S2 外链）、作者、年份、期刊、被引数、摘要（截断）、「有代码」徽标（命中时）。
- **R7**：未加载论文也能手动输入检索；检索中显示 loading；无结果 / 限流 / 网络错误给出友好提示。
- **R8**：S2 API Key 为可选设置项（新增 `settings.s2ApiKey`），不填则用匿名配额；GitHub 校验用匿名搜索（限流 10/min，按结果数量控制）。
- **R9**：前端采用 Hallmark 设计规范（组件级应用，见 design.md §12）——保留既有设计系统（配色/字体/间距），对新增组件执行 8 态、`:focus-visible`、对比度、`prefers-reduced-motion`、禁斜体标题等纪律。

## Acceptance Criteria

- [ ] AI 面板出现「相关论文」Tab，点击切换显示检索视图（搜索框 + 结果区）
- [ ] 加载论文后，搜索框自动填入 PDF 标题（无标题则空，用户可手动输入）
- [ ] 输入标题点「检索」后，结果分三区：相似推荐 / 参考文献 / 被引论文
- [ ] 每条结果含标题（可点开外链）、作者、年份、期刊、被引数、摘要、代码徽标
- [ ] 对含驼峰方法名的论文标题，GitHub 命中时显示「有代码」徽标，未命中不显示（不因此过滤结果）
- [ ] 未加载论文时仍可手动输入并检索
- [ ] 检索中显示 loading 状态；无结果 / 限流 / 网络错误有可读提示，不抛未捕获异常
- [ ] 切换回其他 Tab 或加载新论文，检索视图状态正确复位（清空结果/输入）

## Out of Scope

- 主题关键词补充检索（第三路）
- GitHub README 引用 arXiv ID 的高置信校验（信号 A）
- 结果缓存 / 持久化、导出报告文件
- 后端 / 代理服务（保持纯浏览器架构）

## Open Questions

（均已决，无遗留阻塞项）

## Notes

- Complex task — 需要 design.md + implement.md
- 前端启用 Hallmark 设计规范（组件级），不改写既有设计系统，仅约束新增组件样式
- 与在办任务 `08-05-ai-chat-floating-window` 交互：两者都改 `src/ui/aiPane.js` 的 Tab 栏（前者把 chat 移出为悬浮窗，本任务新增一个 Tab）。实现时需注意合并顺序，避免冲突；本任务新增 Tab 是纯增量，不依赖前者完成。
