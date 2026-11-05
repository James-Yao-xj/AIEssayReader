# AI 论文阅读插件

拖入 PDF 论文，AI 帮你阅读：**全文总结** · **关键概念解释** · **批判性质疑** · **自由对话问答**。

三栏布局：左栏 PDF 原版渲染 · 中栏可选中文本（选中文段一键追问） · 右栏 AI 面板。

## 快速开始

需要 Node.js 22.22.2+（22 LTS）、24.15.0+（24 LTS）或 26+。

验证命令：`npm test`（回归测试）、`npm run build`（单 HTML 构建）、`npm audit`（依赖漏洞）。

```bash
# 1. 安装依赖（仅首次）
npm install

# 2. 构建单 HTML
npm run build

# 3. 启动预览（推荐）
npm run preview
# 浏览器自动打开 → 拖入 PDF → 开始使用
```

> **⚠️ 不要直接双击 `dist/index.html`**——浏览器在 `file://` 协议下会拦截 AI 接口的 fetch 请求。用 `npm run preview` 启动本地 HTTP 服务器即可正常使用。

| 命令 | 用途 |
|---|---|
| `npm run dev` | 开发模式，改代码热更新 |
| `npm run build` | 产出 `dist/index.html` |
| `npm run preview` | 预览 dist 产物（正常使用入口） |

## 使用说明

1. **填 API 设置**：点击右上角 ⚙ 设置按钮，填写：
   - **Base URL**：OpenAI 兼容接口根地址。
     - OpenAI：`https://api.openai.com/v1`
     - DeepSeek：`https://api.deepseek.com/v1`
     - OpenRouter：`https://openrouter.ai/api/v1`
     - Ollama 本地：`http://localhost:11434/v1`
     - 其他兼容端点同理。
   - **API Key**：你的 API 密钥（仅存浏览器 localStorage，不回显明文，不外传）。
   - **模型名**：如 `gpt-4o-mini`、`deepseek-chat`、`qwen2.5` 等。
   - **温度**：推荐 0.3（结构化分析更稳定）。
2. **拖入 PDF**（或 Ctrl/Cmd+O 选择文件）。
3. **右栏点击"总结/概念/质疑"**，结果流式输出。
4. **对话 tab**：基于论文自由提问。中栏选中文本后会自动浮出"追问"按钮。

## 技术栈

- **构建**：Vite 7 + `vite-plugin-singlefile` → 单 HTML
- **PDF**：pdf.js（`?worker&inline` 全内联）
- **Markdown**：marked（含 KaTeX 数学扩展）
- **公式**：KaTeX（仅 AI 输出栏，字体惰性内联）
- **AI**：OpenAI 兼容协议（fetch + SSE 流式手工解析）
- **存储**：localStorage（设置持久化）
- **UI**：原生 ES Modules，无框架

## 已知限制

- **CORS**：部分自建 AI 服务（vLLM / Ollama）默认不允许浏览器跨域请求，需在服务端配 CORS 头或使用代理。
- **`file://` 协议**：双击 `dist/index.html` 时，浏览器可能限制 `file://` 下的 fetch 请求。建议用 `npm run preview` 做本地静态服务。
- **扫描件 PDF**：无文本层的纯扫描 PDF 需要在中栏使用 AI 视觉识别，并配置支持图片输入的识别模型。
- **超长论文**：对话会检索相关段落并压缩历史；全文分析仍受字符预算和模型上下文窗口限制，可能截断。
- **`standardFontDataUrl` 警告**：pdf.js 对极少数内嵌字体（CJK）渲染 canvas 时可能缺字形，属于 pdf.js 已知问题，拉丁论文不受影响。
