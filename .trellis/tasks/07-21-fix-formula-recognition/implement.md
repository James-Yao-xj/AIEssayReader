# Implement: 修复PDF公式识别乱码并支持LaTeX渲染

## Checklist

### Step 1: 改进文本提取算法

- [x] 1.1 重写 `src/pdf/extract.js` 的 `textContentToString()`：
  - 用 `item.height` 计算动态阈值 `0.5 * lineHeight`
  - 同行 items 按 `transform[4]`（X 坐标）排序
  - 根据 X 间距智能插入空格
  - 保留 `hasEOL` 强制换行逻辑
  - 保留 NUL 清理和尾部空白规范化的后处理
- [x] 1.2 添加降级：`height` 不可用时回退 `lineHeight = 12`

### Step 2: 中栏 KaTeX 渲染

- [x] 2.1 `src/ui/textPane.js` 中导入 `renderMarkdown` 从 `./render.js`
- [x] 2.2 `renderText()` 中，`text-page__body` 的内容改用 `renderMarkdown(el, text)` 替代纯文本

### Step 3: 验证

- [x] 3.1 `npm run build` 构建成功
- [ ] 3.2 找一份含公式的 PDF，验证提取后公式不再跳行
- [ ] 3.3 验证中栏追问（选中文本 → "追问"按钮）功能正常
- [ ] 3.4 验证纯文本 PDF 表现不退化

## 改动文件清单

| 文件 | 改动类型 | 风险 |
|------|----------|------|
| `src/pdf/extract.js` | 重写核心算法 | 中 |
| `src/ui/textPane.js` | 小幅改动（导入 + 渲染调用替换） | 低 |

## 回滚点

- Step 1 完成后可独立验证（先 `npm run dev` 测试提取效果）
- Step 2 是纯增量改动，出问题不影响 Step 1 的效果
- 两个 step 均为 `src/` 下改动，`git checkout -- <file>` 即可回滚
