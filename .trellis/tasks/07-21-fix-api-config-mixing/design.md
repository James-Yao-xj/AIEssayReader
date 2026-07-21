# Design v2: API 配置混用 — 运行时诊断与修复

## 用户确认的现象

- 设置 UI 中为"文本识别模型"(recognition) 和"文本阅读模型"(reading) 填写了**不同的 API Key/模型名**
- AI 视觉识别（OCR）实际调用时使用了 **reading 的配置**，recognition 配置未生效
- 即：两边都走的 reading

## 静态代码审查结论（v2 确认）

代码路由在源码层面正确：
- `vision.js:80-96` → `settings.recognition.*` → `createProvider(recognition.*)`
- `client.js:43-68` → `settings.reading.*` → `createProvider(reading.*)`

不存在跨组引用。问题必然在**运行时数据流**：store 中 `recognition` 和 `reading` 的值在运行时实际相同。

## 根因假设（需运行时验证）

最可能的根因：**save 流程中 recognition 和 reading 的值被意外合并/覆盖**。

候选场景：
1. `saveSettings()` 的 deepMergeSettings 有 bug 导致 reading 覆盖 recognition
2. `collectModelConfig()` 从 form 读到了错误的字段值
3. `syncFormFromStore()` 开表单时将 reading 值误填入 recognition 字段
4. 旧版迁移残留 + 用户未注意到两组仍有相同值

## 修复方案 v2：全链路运行时诊断

在数据流的每个关键节点插入 `console.warn` 级别的日志（warn 级别确保不被过滤）：

### 1. storage.js `loadSettings()` — 启动时打印完整 config
```
[Config:Load] recognition={model, baseUrl, keyLen} reading={model, baseUrl, keyLen}
```

### 2. settings.js `syncFormFromStore()` — 开设置面板时打印
```
[Config:Sync] store.recognition={...} store.reading={...}
```

### 3. settings.js `save()` — 保存时打印收集到的值
```
[Config:Save] recognition={...} reading={...}
```

### 4. vision.js `extractWithVision()` — OCR 调用前打印
```
[Config:Use] SOURCE=recognition, model=xxx, baseUrl=xxx
```

### 5. client.js `makeProvider()` — 阅读调用前打印
```
[Config:Use] SOURCE=reading, model=xxx, baseUrl=xxx
```

### 6. openai.js `createOpenAIProvider()` — 增强日志加上 source 标识

## 影响范围

| 文件 | 改动 | 风险 |
|---|---|---|
| `src/config/storage.js` | 加载时打印 config | 低 |
| `src/ui/settings.js` | sync + save 时打印 | 低 |
| `src/pdf/vision.js` | 调用前打印 | 低 |
| `src/ai/client.js` | 调用前打印 | 低 |
| `src/ai/openai.js` | 增强日志 | 低 |

全部都是 `console.warn` 日志，不改变任何业务逻辑。等用户反馈日志后定位根因，再做代码修复。
