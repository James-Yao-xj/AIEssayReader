# Implement v2: 全链路运行时诊断

## 目标

在数据流的每个关键节点插入 `console.warn` 日志，完整追踪 settings 从 localStorage → store → form → save → store → provider → API call 的全过程。

## 步骤

### 1. `src/config/storage.js` — loadSettings 时打印
在 `loadSettings()` 返回前添加：
```js
console.warn('[Config:Load]', {
  recognition: { model: result.recognition?.model, baseUrl: result.recognition?.baseUrl, keyLen: result.recognition?.apiKey?.length || 0 },
  reading: { model: result.reading?.model, baseUrl: result.reading?.baseUrl, keyLen: result.reading?.apiKey?.length || 0 },
});
```

### 2. `src/ui/settings.js` — syncFormFromStore 时打印
```js
console.warn('[Config:Sync] store → form', {
  recognition: { model: rec.model, baseUrl: rec.baseUrl, keyLen: rec.apiKey?.length || 0 },
  reading: { model: rd.model, baseUrl: rd.baseUrl, keyLen: rd.apiKey?.length || 0 },
});
```

### 3. `src/ui/settings.js` — save 时打印
在 `collectModelConfig` 调用后、`saveSettings` 调用前打印两组收集到的值。

### 4. `src/pdf/vision.js` — extractWithVision 调用前打印
```js
console.warn('[Config:Use] SOURCE=recognition', { model: recognition.model, baseUrl: recognition.baseUrl, keyLen: recognition.apiKey?.length || 0 });
```

### 5. `src/ai/client.js` — makeProvider 调用时打印
```js
console.warn('[Config:Use] SOURCE=reading', { model: reading.model, baseUrl: reading.baseUrl, keyLen: reading.apiKey?.length || 0 });
```

### 6. 验证
- `npm run build` 通过
- 提交代码
- 请用户刷新页面后打开控制台，触发操作，分享完整日志
