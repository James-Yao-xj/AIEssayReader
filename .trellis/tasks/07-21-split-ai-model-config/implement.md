# Implement: 拆分 AI 模型配置

## 执行顺序

按依赖关系从上到下，每步完成后自检通过再进入下一步。

### Step 1: 修改 `src/config/defaults.js` — 数据模型

- [ ] 新增 `ModelConfig` JSDoc typedef
- [ ] 更新 `Settings` typedef：移除顶层 `baseUrl/apiKey/model/temperature`，新增 `recognition` 和 `reading`（均为 `ModelConfig`）
- [ ] 更新 `DEFAULT_SETTINGS`：拆为 `recognition: {...}` 和 `reading: {...}`，各自用相同默认值
- [ ] 保持 `promptSummarize/ExplainConcepts/Critique/Chat` 不变
- **验证**：文件能正常 import，无语法错误

### Step 2: 修改 `src/config/storage.js` — 存储与迁移

- [ ] `pickKnownFields()` 支持嵌套结构：提取 `recognition.{baseUrl,apiKey,model,temperature}` 和 `reading.{baseUrl,apiKey,model,temperature}`
- [ ] `loadSettings()` 增加迁移检测：如果 `parsed` 顶层有 `baseUrl` 且无 `recognition`，执行迁移（旧值复制到两组）
- [ ] 合并 DEFAULT_SETTINGS 时正确处理嵌套对象（深合并 recognition/reading 子字段）
- [ ] 静默写回 localStorage 持久化迁移结果
- **验证**：控制台手动构造旧格式 → 调 `loadSettings()` → 返回新格式，两组值一致

### Step 3: 修改 `src/ai/client.js` — 阅读消费者

- [ ] `makeProvider()` 从 `settings.reading` 取值
- [ ] 校验提示改为"文本阅读模型"相关措辞
- **验证**：仅配阅读配置 → summarize 正常流式输出

### Step 4: 修改 `src/pdf/vision.js` — 识别消费者

- [ ] provider 创建从 `settings.recognition` 取值
- [ ] 校验提示改为"文本识别模型"相关措辞
- [ ] temperature 保持硬编码 0
- **验证**：仅配识别配置 → AI 视觉识别正常逐页运行

### Step 5: 修改 `src/ui/settings.js` — 设置面板 UI

- [ ] 更新 HTML 模板：基本设置标签页拆为两个 fieldset/区域（识别 + 阅读），每个包含 baseUrl/apiKey/model/temperature 四个输入框
- [ ] 字段命名：`name="recognition.baseUrl"` 等，用点分隔前缀
- [ ] 更新 `syncFormFromStore()`：从嵌套结构分别读取两组字段值
- [ ] 更新 `save()`：收集两组嵌套字段，组装新的 Settings 结构；校验逻辑放宽——不强制 baseUrl/model 非空（允许只配一组）
- [ ] 两组 apiKey 各自独立判断"已配置（留空则不修改）"
- **验证**：打开设置 → 两组独立显示 → 分别填入不同值 → 保存 → 重新打开 → 数据完整

### Step 6: 端到端集成验证

- [ ] 两组填不同配置 → 各自功能正常
- [ ] 仅配识别 → 识别正常，阅读提示未配置
- [ ] 仅配阅读 → 阅读正常，识别提示未配置
- [ ] 旧版数据迁移：构造旧格式 localStorage → 加载 → 两组都填了旧值
- [ ] 提示词模板编辑/预览/恢复默认不受影响
