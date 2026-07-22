# PRD: 排查修复文本识别/文本阅读 API 配置混用

## Goal

确保"文本识别模型"和"文本阅读模型"两组独立配置在各自的 API 调用中被正确使用，互不干扰。

## 问题描述

用户反馈：在设置面板中为"文本识别模型"（recognition）和"文本阅读模型"（reading）分别配置了**不同的 API Key 和模型名**后，**AI 视觉识别（OCR）实际调用时也使用了 reading 配置**，即两边都在用文本阅读模型的 API Key/模型名，recognition 配置未被生效。

## 已确认事实

- 静态代码审查：`vision.js:80-96` 使用 `settings.recognition.*`，`client.js:43-68` 使用 `settings.reading.*`，路由代码**逻辑正确**
- 用户实际操作：在设置 UI 中为两组分别填写了不同的 API Key，保存后触发 OCR → 观察到的仍是 reading 的配置
- 这意味着问题不在代码路由，而在**运行时数据流**：或者 store 中两组值实际相同，或者 save 流程有 bug 导致 recognition 的值被 reading 覆盖

## 背景

`07-21-split-ai-model-config` 将单一模型配置拆为独立的两组：
- `settings.recognition` — PDF 视觉 OCR，由 `src/pdf/vision.js` 使用
- `settings.reading` — 总结/解释/批判/对话，由 `src/ai/client.js` 使用

## 初步代码审查发现

### 代码路由层面（理论正确，需实地验证）

| 调用方 | 配置来源 | 位置 |
|---|---|---|
| `extractWithVision()` | `settings.recognition.*` | `src/pdf/vision.js:80-96` |
| `summarize()` / `explainConcepts()` / `critique()` / `chat()` | `settings.reading.*` | `src/ai/client.js:43-68` |

### 已识别的风险点

1. **store 状态 vs localStorage 不一致风险**（`src/ui/settings.js:491-496`）
   `save()` 中 `saveSettings()` 做了 deep-merge 后写 localStorage，但 `setState()` 使用未 merge 的 `newSettings`。正常情况下两者一致，但若 deep-merge 补充了默认值，store 中会缺少这些字段。

2. **旧版迁移后两组完全相同**（`src/config/storage.js:172-207`）
   扁平格式迁移时 `baseUrl`/`apiKey`/`model`/`temperature` 同时复制到 `recognition` 和 `reading`。用户若只改一组、另一组保留旧值，可能产生"混用"错觉。

3. **API Key 留空保留原值**（`src/ui/settings.js:461-479`）
   `apiKey` 输入框永远不回显明文。若两组 Key 曾相同，修改一组时另一组 Key 也保留了旧值，外观上看不出差异。

4. **`extractWithVision()` 不传 temperature**（`src/pdf/vision.js:96`）
   OCR 硬编码 `temperature: 0`，但设置面板中 recognition 的 temperature 字段仍然存在。用户可能误解该字段会影响 OCR 行为。

## Requirements

- 所有消费者必须始终从对应的配置组取值，禁止回退到另一组
- 设置保存后 store 与 localStorage 必须完全一致
- 两组 API Key 各自独立，一组留空不影响另一组
- 排查是否存在跨组引用的代码路径

## Acceptance Criteria

- [ ] 为 `recognition` 和 `reading` 分别配置**不同**模型名后，在浏览器 Network 面板验证请求 body 中的 `model` 字段与实际设置一致
- [ ] PDF 视觉识别请求：`model` = `settings.recognition.model`
- [ ] 论文总结/概念解释/批判/对话请求：`model` = `settings.reading.model`
- [ ] 两组 API Key 各自独立：留空任一组不影响该组的已有 Key
- [ ] 保存设置后 store 与 localStorage 内容完全一致
- [ ] 从旧版迁移后，两组配置可独立修改、互不干扰
