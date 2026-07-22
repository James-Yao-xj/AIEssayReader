# Design: 拆分 AI 模型配置

## 1. 数据结构

### 新 Settings 结构

```js
{
  // 文本识别模型配置
  recognition: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.3,
  },
  // 文本阅读模型配置
  reading: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.3,
  },
  // 提示词模板（顶层不变）
  promptSummarize: '...',
  promptExplainConcepts: '...',
  promptCritique: '...',
  promptChat: '...',
}
```

两个嵌套对象的字段相同（`baseUrl`, `apiKey`, `model`, `temperature`），类型一致。

### 向后兼容：扁平 → 嵌套迁移

`loadSettings()` 检测旧版格式：如果 `parsed` 顶层存在 `baseUrl` 字段（旧版扁平结构），则执行迁移：

```
recognition = { baseUrl: old.baseUrl, apiKey: old.apiKey, model: old.model, temperature: old.temperature }
reading     = { baseUrl: old.baseUrl, apiKey: old.apiKey, model: old.model, temperature: old.temperature }
```

如果已是新结构（顶层有 `recognition` 或 `reading` 嵌套对象），直接合并默认值。迁移后的数据写回 localStorage（下次读直接走新格式）。

### 类型定义更新

`defaults.js` 中新增 `ModelConfig` typedef，`Settings` 的 `baseUrl/apiKey/model/temperature` 替换为 `recognition` 和 `reading`。

```js
/**
 * @typedef {Object} ModelConfig
 * @property {string} baseUrl
 * @property {string} apiKey
 * @property {string} model
 * @property {number} temperature
 */

/**
 * @typedef {Object} Settings
 * @property {ModelConfig} recognition
 * @property {ModelConfig} reading
 * @property {string} promptSummarize
 * @property {string} promptExplainConcepts
 * @property {string} promptCritique
 * @property {string} promptChat
 */
```

## 2. 文件变更清单

| 文件 | 变更性质 | 说明 |
|------|----------|------|
| `src/config/defaults.js` | 修改 | 拆分 DEFAULT_SETTINGS，新增 ModelConfig typedef |
| `src/config/storage.js` | 修改 | `pickKnownFields` 支持嵌套，`loadSettings` 加迁移逻辑 |
| `src/ui/settings.js` | 修改 | 基本设置标签页拆为两个区域，`syncFormFromStore`/`save` 适配嵌套结构 |
| `src/ai/client.js` | 修改 | `makeProvider` 从 `settings.reading` 取值 |
| `src/pdf/vision.js` | 修改 | provider 创建从 `settings.recognition` 取值，校验提示区分来源 |

## 3. 迁移策略（storage.js）

```js
function migrateFromFlat(parsed) {
  // 检测旧版：顶层有 baseUrl 且没有 recognition/reading
  if (typeof parsed.baseUrl === 'string' && !parsed.recognition && !parsed.reading) {
    const old = pickKnownFields_flat(parsed);  // 旧版字段提取
    return {
      recognition: { baseUrl: old.baseUrl, apiKey: old.apiKey, model: old.model, temperature: old.temperature },
      reading:     { baseUrl: old.baseUrl, apiKey: old.apiKey, model: old.model, temperature: old.temperature },
      // 提示词也一起搬
      promptSummarize: old.promptSummarize,
      promptExplainConcepts: old.promptExplainConcepts,
      promptCritique: old.promptCritique,
      promptChat: old.promptChat,
    };
  }
  return null; // 已是新格式
}
```

迁移在 `loadSettings()` 中执行。迁移后的对象合并 `DEFAULT_SETTINGS`，然后写回 localStorage（静默，失败不阻塞）。

## 4. 设置面板 UI 设计

### Tab "基本设置" 布局

```
┌─────────────────────────────────────────────────┐
│  文本识别模型                                     │
│  用于 AI 视觉识别，将 PDF 页面转为文字。             │
│  需支持图片输入的视觉模型。                         │
│  ┌─────────────────────────────────────────────┐ │
│  │ Base URL  [                          ]     │ │
│  │ API Key   [                          ]     │ │
│  │ 模型       [                          ]     │ │
│  │ 温度       [                          ]     │ │
│  └─────────────────────────────────────────────┘ │
│                                                   │
│  文本阅读模型                                     │
│  用于论文总结、概念解释、批判分析和对话。             │
│  需强推理能力的模型。                              │
│  ┌─────────────────────────────────────────────┐ │
│  │ Base URL  [                          ]     │ │
│  │ API Key   [                          ]     │ │
│  │ 模型       [                          ]     │ │
│  │ 温度       [                          ]     │ │
│  └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

### 字段命名约定

表单字段名使用点分隔前缀区分组别：
- `recognition.baseUrl`、`recognition.apiKey`、`recognition.model`、`recognition.temperature`
- `reading.baseUrl`、`reading.apiKey`、`reading.model`、`reading.temperature`

### 校验逻辑

保存时：
- 识别组和阅读组各自独立校验 baseUrl 和 model 非空
- apiKey 留空保留原值（各自独立判断）
- temperature 校验范围 0~2
- 允许仅填一组：如果识别组 baseUrl 或 model 为空 → 提示但不阻止保存（允许用户只配阅读不配识别，或反之）

实际上保存时两组都做完整校验，但**不强制两组都填**——用户可能只用其中一个功能。所以保存时不校验非空，只在**使用时**（vision.js / client.js）做校验并报错。

改进方案：保存时不做 baseUrl/model 非空校验（移除 required 校验），改用 UI 提示"留空将无法使用对应功能"。保持 apiKey 的特殊逻辑和 temperature 范围校验。

## 5. 消费者适配

### vision.js

```js
const { recognition } = settings;
if (!recognition?.apiKey?.trim()) throw new Error('请先在设置中配置文本识别模型的 API Key');
if (!recognition?.baseUrl?.trim()) throw new Error('请先在设置中配置文本识别模型的 Base URL');
if (!recognition?.model?.trim()) throw new Error('请先在设置中配置文本识别模型的模型名');

const provider = createProvider({
  baseUrl: recognition.baseUrl,
  apiKey: recognition.apiKey,
  model: recognition.model,
  temperature: 0, // OCR 始终 0
});
```

### client.js

```js
const { reading } = settings;
if (!reading?.apiKey?.trim()) throw new Error('未配置文本阅读模型的 API Key...');
if (!reading?.baseUrl?.trim()) throw new Error('未配置文本阅读模型的 Base URL...');
if (!reading?.model?.trim()) throw new Error('未配置文本阅读模型的模型名...');

return createProvider({
  baseUrl: reading.baseUrl,
  apiKey: reading.apiKey,
  model: reading.model,
  temperature: reading.temperature,
});
```

## 6. 风险与回滚

- **风险**：旧版数据迁移逻辑有 bug 导致用户配置丢失 → 迁移后保留旧格式写回之前做深拷贝备份（实际上不会丢——旧值已被读入内存，写回是新对象）
- **回滚**：如出问题，用户可手动在浏览器 devtools 删除 `aie:settings` key 重配
- **兼容性**：迁移一次后写回新格式，旧版代码读到会丢失 recognition/reading → 不做降级支持（这是纯前端应用，无服务端部署，无回滚需求）
