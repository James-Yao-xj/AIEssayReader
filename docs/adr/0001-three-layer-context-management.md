# 0001: Three-layer context management for chat mode

Chat mode sends a system message (paper content + task template) plus conversation history to the LLM. For long papers and multi-turn conversations, this exceeds the model's context window. We chose a three-layer architecture — Paper Retrieval, Conversation Compression, and Message Windowing — that compresses different parts of the context at different rates, rather than naively truncating.

**Rejected alternative**: loading the full paper every turn and relying on the sliding window alone. This would cause the paper to be truncated at the tail, or leave no budget for conversation history.

**Rejected alternative**: using an external embedding model and vector store for RAG. This would require additional infrastructure, dependencies, and cost. Keyword-based retrieval is simpler, works offline, and is adequate for academic papers with clear terminology.

See `CONTEXT.md` for the glossary of terms and `src/ai/context.js` + `src/ai/client.js` for the implementation.
