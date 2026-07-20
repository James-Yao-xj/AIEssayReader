# Implement — AI 论文阅读插件

> 配套 `prd.md` + `design.md`。按"先打地基、再竖墙、最后装修"的顺序，每步可独立验证。

## 实现顺序

### Step 0 — 工程骨架（最高风险优先验证）
- [x] `package.json`（vite, vite-plugin-singlefile, pdfjs-dist, marked, katex）
- [x] `vite.config.js`（singlefile + worker ES + 大 assetsInlineLimit）
- [x] `index.html` 三栏空骨架 + 拖拽落区占位
- [x] `src/main.js`、`src/styles.css` 基础布局
- [x] **验证里程碑 M0**：`npm run build` 出单 HTML；`npm run dev` 能打开三栏空页。✅
- [x] **风险验证（关键）**：用 pdf.js 加载真实论文 PDF（Attention Is All You Need），确认**渲染 + 文本提取**在 dev 与 build 后单 HTML 下都工作；worker 内联成功（`?worker&inline` → Blob → Worker），无需降级。✅

### Step 1 — PDF 层（`src/pdf/`）
- [x] `extract.js`：`extractText(file) -> { meta, fullText, pages }`，按页保留结构。
- [x] `render.js`：`renderPdf(file, container)`，左栏滚动渲染（IntersectionObserver 懒加载）。
- [x] **验证 M1**：拖入 PDF，左栏出原版、中栏出文本。真实论文测试：15 页，第 1 页正确提取标题与作者。✅

### Step 2 — 状态与配置（`src/state/`, `src/config/`）
- [x] `store.js`：极简 pub/sub store（paper / settings / messages / ui）。
- [x] `storage.js` + `defaults.js`：localStorage 读写、默认值。
- [x] `settings.js` UI：modal 填写 Base URL/Key/模型/温度，持久化，Key 不回显明文。
- [x] **验证 M2**：设置 modal 打开/保存/刷新后保留；未填 Key 时顶栏红色徽标提示。✅

### Step 3 — AI 层（`src/ai/`）
- [x] `provider.js`：接口定义（JSDoc）。
- [x] `openai.js`：`fetch` + SSE 手工解析流式，`async *chat` yield token 片段；错误（401/网络/非 200）抛带语义的错。
- [x] `prompts.js`：GLOBAL_STYLE（含用户两条硬要求）+ 四套中文任务模板。
- [x] `context.js`：`assemble({task, paper, messages, recentN})`；token 估算 + 滑窗（recentN 轮配对 + 100k 字符硬上限）。
- [x] `client.js`：`summarize/explainConcepts/critique/chat` 高层方法，chat 入栈/出栈时序正确。
- [x] **验证 M3**：代码自检通过 design.md §5 契约；GLOBAL_STYLE 含用户两条；build 干净。✅（真实 API 端到端待用户自行填入 Key 后验证。）

### Step 4 — 右栏 AI 面板（`src/ui/aiPane.js`, `render.js`）
- [x] `render.js`：marked + KaTeX 数学扩展（marked.use），**流式节流渲染**（setTimeout 80ms 去重，autoScroll 不抢用户滚动）。
- [x] `aiPane.js`：tab（总结/概念/质疑）+ 对话区；按钮接 client.*；流式逐字显示；AbortController 停止；busy 态同步。
- [x] 对话：输入→入 store.messages→滑窗→流式回复；Enter/Shift+Enter/输入法合成正确处理。
- [x] **验证 M4**：KaTeX CSS + 字体已内联进单 HTML（确认 data:font/woff2）；AI 面板代码自洽；真实 API 端到端待用户验证。✅

### Step 5 — 中栏增强 + 联动
- [x] `textPane.js`：选中文本弹"追问"→通过 store.ui.quickAsk 通知 aiPane 自动切换 tab 并发送；定位浮层按钮 + 窗口边界修正。
- [x] 错误提示打磨：client.js 已有语义错误（未填 Key/未加载论文/API 401/404/429/5xx/网络错）；AI 面板捕获后展示在错误区；AbortError → "已停止"；非 PDF → 状态条提示。
- [x] **验证 M5**：textPane 代码自洽；错误路径均有覆盖。✅（中栏追问联动 UI 交互待用户在浏览器中手动验证。）

### Step 6 — 收尾
- [x] README 写使用说明（含 file:// 限制、CORS 提示、API 配置指南、已知限制）。
- [x] **提示词自定义（2026-07-20 新增）**：设置面板新增"提示词模板"标签页，用户可编辑 4 个任务模板（综述/概念/批判/对话），支持"恢复默认"。GLOBAL_STYLE 不可编辑。涉及：`defaults.js`、`storage.js`、`context.js`、`client.js`、`settings.js`、`styles.css`。
- [ ] 全量回归验收清单（见 prd.md Acceptance Criteria）。
- [ ] **验证 M6**：清空环境，按 README 从零走一遍。

## 风险点 / 回滚
- **pdf.js worker 内联**：**【已解决 2026-07-20】** 用 Vite `?worker&inline` → Blob URL → `new Worker(blob,{type:'module'})` 方案 A 成功。
- **流式渲染性能**：✅ marked 数学扩展一次性渲染 + KaTeX throwOnError:false + setTimeout 80ms 节流去重。若仍卡可退化为"结束后 KaTeX"。
- **standardFontDataUrl 警告（次要）**：拉丁论文不受影响，CJK 可能有字形缺失。README 已说明。
