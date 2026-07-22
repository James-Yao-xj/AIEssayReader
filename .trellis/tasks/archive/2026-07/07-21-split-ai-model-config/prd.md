# 拆分 AI 模型配置：文本识别与阅读独立模型

## 背景

当前系统使用单一模型配置（`baseUrl`、`apiKey`、`model`、`temperature`）同时服务于两个 AI 任务：

1. **文本识别（Vision/OCR）**：逐页渲染 PDF 为图片，调 vision 模型转写为含 LaTeX 的结构化文本。对视觉能力要求高，temperature 固定为 0，非流式。
2. **文本阅读（总结/解释/批判/对话）**：对已提取的论文全文做分析、总结、多轮对话。对推理能力要求高，temperature 0.3，流式输出。

一个模型的局限：识别需要视觉模型（如 `gpt-4o`），阅读用推理模型（如 `claude-sonnet-4-6`）效果更好；两个任务可能调用不同厂商；成本/速度期望也不同。

## 需求

### R1 — 配置结构拆分

将 AI 设置拆为两个独立配置组，每组各含 4 项：

- **文本识别配置（`recognition`）**：`baseUrl`、`apiKey`、`model`、`temperature`
- **文本阅读配置（`reading`）**：`baseUrl`、`apiKey`、`model`、`temperature`

两组完全独立，可分别填写不同厂商、不同密钥、不同模型。

### R2 — 旧数据迁移

旧版扁平 `aie:settings` JSON（`{baseUrl, apiKey, model, temperature, promptSummarize, ...}`）在加载时自动迁移：旧版四个字段的值**同时**填入 recognition 和 reading 两组，即升级后两个任务初始使用同一模型，用户之后可按需改为不同模型。

### R3 — 设置面板 UI

"基本设置"标签页拆为两个区域：

- **文本识别模型**：baseUrl、apiKey、model、temperature 四个输入框。说明文字："用于 AI 视觉识别，将 PDF 页面转为文字。需支持图片输入的视觉模型。"
- **文本阅读模型**：baseUrl、apiKey、model、temperature 四个输入框。说明文字："用于论文总结、概念解释、批判分析和对话。需强推理能力的模型。"

每个 apiKey 独立判断"已配置（留空则不修改）"占位逻辑。提示词模板标签页不变。

### R4 — 消费者适配

- `src/pdf/vision.js`：从 `settings.recognition` 读取配置（仍 temperature=0、非流式）
- `src/ai/client.js`：从 `settings.reading` 读取配置（仍流式、使用用户温度）

## 验收标准

- [ ] AC1: 用户分别在两个配置组填入不同 API 配置，保存后各自生效
- [ ] AC2: 旧版用户打开应用，原有配置自动填充到两组，行为不退化
- [ ] AC3: 仅填识别配置、阅读留空 → 识别正常，阅读给出明确"未配置"提示
- [ ] AC4: 仅填阅读配置、识别留空 → 阅读正常，识别给出明确"未配置"提示
- [ ] AC5: 两组 apiKey 均不回显明文，各自独立判断占位提示
- [ ] AC6: 提示词模板标签页功能不受影响
- [ ] AC7: 保存后关闭重新打开，数据完整保留

## 非目标

- 不引入多 provider 体系（Anthropic 等）—— 仍只用 OpenAI 兼容协议
- 不改变 AI 功能行为逻辑（识别仍串行逐页，阅读仍流式）
- 不改变提示词模板结构和功能
