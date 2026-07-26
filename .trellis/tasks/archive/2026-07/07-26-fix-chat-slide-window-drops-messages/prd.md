# 修复对话时用户消息被 slideWindow 丢弃的 bug

## Goal

修复 `src/ai/context.js` 中 `assemble()` + `slideWindow()` 的字符预算机制：当论文全文过长导致 system prompt 占满 `MAX_TOTAL_CHARS` 预算时，用户消息被静默丢弃，AI 收不到任何用户提问。

## Requirements

- **R1**: 对话模式下，至少保留最近一条用户消息不被丢弃，无论论文多长。
- **R2**: 不应无限制放大 `MAX_TOTAL_CHARS`（那只是推迟问题）；需要在 system prompt 与 messages 之间做合理分配——当论文过长时，优先截断论文文本而非丢弃消息。
- **R3**: 其他一次性任务（summarize / explainConcepts / critique / translate）不依赖 messages 历史，不受影响。
- **R4**: 修改范围限定在 `src/ai/context.js`，不改动 UI 层或 provider 层。

## Acceptance Criteria

- [ ] 加载一篇超过 10 万字符的论文全文，进入对话面板发送"你好，请用中文总结这篇论文的第一段"，AI 能正常回复（不会无响应或回复无关内容）。
- [ ] 加载短论文时对话行为与修复前一致（无回归）。
- [ ] 一次性任务（总结/概念解释/批判/翻译）行为不变。
- [ ] `slideWindow` 在预算不足时至少保留最后一条消息（当前用户提问）。

## Notes

- 根因：`budget = Math.max(0, MAX_TOTAL_CHARS - systemContent.length)` → 论文长时 budget=0 → 所有消息被 `slideWindow` 丢弃。
- 轻量 bug fix，PRD-only。
