# CONTEXT — AIEssayReader

## Paper Retrieval（论文检索）
根据用户当前提问的关键词，从论文全文中提取最相关的段落，替代全量加载。仅对长论文（超过总预算 50%）且在对话模式下触发。一次性任务（总结/翻译/概念/批判）始终使用全文。

**预算**：占总上下文预算的 50%（`MAX_TOTAL_CHARS × 0.5`）。始终保留论文头部 5 段（摘要/引言）和尾部 3 段（结论），剩余空间按关键词匹配度填充。

**累积模式**：每轮检索后，选中的段落索引被记录到 `retrievedChunkIndices`。下一轮检索时，这些"已讨论"段落获得 +3 分加成——既保持对新提问的响应能力，又避免上下文频繁漂移。加载新论文时索引自动重置。

**与 Conversation Compression 联动**：检索时不仅从当前提问提取关键词，也同时从对话摘要中提取。摘要中的术语（如"梯度下降"、"收敛性"）作为锚点，引导检索锁定之前讨论过的章节，即使当前提问很短（如"那参数怎么调？"）也不会跑偏。

见：`src/ai/context.js` — `retrieveRelevantContent()`

## Conversation Compression（对话压缩）
当对话消息超过阈值（12 条），将溢出的旧消息通过 LLM 合并为一段 ≤300 字的摘要，注入 system 消息。增量模式：每次只压缩新增溢出消息，合并到已有摘要。失败不阻塞主流程。

**约束**：摘要中禁止引用论文具体章节号、页码或公式编号——Paper Retrieval 可能在后续对话中载入不同的论文段落，导致引用失效。

见：`src/ai/client.js` — `maybeSummarize()`

## Message Windowing（消息开窗）
限制发送给 LLM 的消息数量（最近 8 轮 = 16 条）和字符总量。超出轮次或字符预算时从最旧端丢弃，始终至少保留最后一条用户消息（最少 4,000 字符）。

**预算**：占总上下文预算的 40%，即扣除 system 开销后的剩余空间。与 Conversation Compression 协同——被开窗丢弃的消息已通过摘要保留关键信息。

见：`src/ai/context.js` — `slideWindow()`

---

## Budget Hierarchy（预算层级）

三层上下文压缩的预算分配优先级（从高到低）：

| 优先级 | 机制 | 预算占比 | 说明 |
|--------|------|---------|------|
| 0 | 模板开销 | 固定（~3,000 字符） | GLOBAL_STYLE + 引导语 + CHAT 模板，不参与动态分配 |
| 1 | Message Windowing | 40% | 对话质量优先——用户最近的提问和回答必须完整保留 |
| 2 | Paper Retrieval | 50% | 论文上下文——根据提问动态检索相关段落 |
| 3 | Conversation Compression | 剩余 | 摘要通常 ≤300 字，占用可忽略 |

## State Reset（状态重置）
加载新论文时，以下累积状态必须同步清空（见 `src/main.js`）：
- `messages` — 旧论文的对话历史对新论文无意义
- `conversationSummary` — 同上
- `retrievedChunkIndices` — 旧论文的段落索引不可用于新论文
- `chatStatus` — 派生状态，自动清空

例外：存档恢复（`src/archive/manager.js`）保留 `messages`（存档的目的就是保存对话），但清空 `conversationSummary`、`retrievedChunkIndices`、`chatStatus`（论文全文不可恢复）。
