/* =========================================================
 * src/ai/client.js
 *
 * 高层 AI 入口：UI 唯一调用 AI 的门面（design.md §3）。
 *
 * - 从 store 取 settings + paper + messages
 * - 调 context.assemble + provider（默认 openai.js）
 * - 暴露：summarize() / explainConcepts() / critique() / translate() / chat(userText)
 *   前四者返回一次性任务的 AsyncIterable<string>（流式）；
 *   chat 同样流式，且：
 *     ① 流式开始前把 userText 入 store.messages
 *     ② 流式结束后把 assistant 全文入 store.messages
 * - 未配置 reading.apiKey 或未加载论文 → 抛带语义的 Error（由 UI 捕获提示）
 * ========================================================= */

import { getState, setState } from '../state/store.js';
import { createProvider } from './openai.js';
import { assemble, SUMMARIZE_THRESHOLD, getLastRetrievedIndices } from './context.js';
import { SUMMARIZE_CONVERSATION } from './prompts.js';

/**
 * 从 store.settings 读取用户自定义提示词，构建与 context.assemble() 兼容的
 * templates 映射。若用户未自定义某字段（空串/undefined），assemble() 会回退
 * 到 prompts.js 内置默认模板。
 *
 * @returns {Partial<Record<'summarize' | 'explainConcepts' | 'critique' | 'translate' | 'chat', string>>}
 */
function getPromptTemplates() {
  const { settings } = getState();
  return {
    summarize: settings.promptSummarize,
    explainConcepts: settings.promptExplainConcepts,
    critique: settings.promptCritique,
    translate: settings.promptTranslate,
    chat: settings.promptChat,
  };
}

/**
 * 取 provider。每次调用前都重新读 store.settings，保证用户改完设置立即生效。
 * 同时做必要的前置校验，抛带语义的错。
 * 从 settings.reading 读取文本阅读模型配置（baseUrl / apiKey / model / temperature）。
 * @param {{ requirePaper?: boolean }} [opts]
 */
function makeProvider(opts) {
  const { requirePaper = true } = opts || {};
  const { settings, paper } = getState();
  const { reading } = settings;

  if (!reading?.apiKey || !reading.apiKey.trim()) {
    throw new Error(
      '未配置文本阅读模型的 API Key。请点击右上角"设置"按钮，在"文本阅读模型"区域填写 Base URL 与 API Key 后重试。',
    );
  }
  if (!reading?.baseUrl || !reading.baseUrl.trim()) {
    throw new Error('未配置文本阅读模型的 Base URL，请在设置面板的"文本阅读模型"区域填写。');
  }
  if (!reading?.model || !reading.model.trim()) {
    throw new Error('未配置文本阅读模型的模型名，请在设置面板的"文本阅读模型"区域填写。');
  }
  if (requirePaper && (!paper || !paper.fullText)) {
    throw new Error('尚未加载论文。请先拖入一个 PDF 文件。');
  }

  console.warn('[Config:Use] SOURCE=reading (text AI)', {
    model: reading.model,
    baseUrl: reading.baseUrl,
    keyLen: reading.apiKey?.length || 0,
  });

  return createProvider({
    baseUrl: reading.baseUrl,
    apiKey: reading.apiKey,
    model: reading.model,
    temperature: reading.temperature,
  });
}

/**
 * 通用一次性任务流式入口。
 * @param {'summarize' | 'explainConcepts' | 'critique' | 'translate'} task
 * @param {AbortSignal} [signal]
 * @returns {AsyncIterable<string>}
 */
async function* runOneShot(task, signal) {
  const { paper } = getState();
  const provider = makeProvider({ requirePaper: true });
  const messages = assemble({ task, paper, messages: [], templates: getPromptTemplates() });
  yield* provider.chat(messages, { signal });
}

/**
 * 总结论文（流式）。
 * @param {AbortSignal} [signal]
 * @returns {AsyncIterable<string>}
 */
export function summarize(signal) {
  return runOneShot('summarize', signal);
}

/**
 * 解释关键概念（流式）。
 * @param {AbortSignal} [signal]
 * @returns {AsyncIterable<string>}
 */
export function explainConcepts(signal) {
  return runOneShot('explainConcepts', signal);
}

/**
 * 批判性质疑（流式）。
 * @param {AbortSignal} [signal]
 * @returns {AsyncIterable<string>}
 */
export function critique(signal) {
  return runOneShot('critique', signal);
}

/**
 * 把论文全文翻译成中文（流式）。
 * @param {AbortSignal} [signal]
 * @returns {AsyncIterable<string>}
 */
export function translate(signal) {
  return runOneShot('translate', signal);
}

/**
 * 基于论文的多轮对话（流式）。
 * - 流开始前：把 userText 入 store.messages
 * - 流结束后：把 assistant 全文入 store.messages
 * - 中途抛错（取消、网络、API 错）：不入 assistant 消息，让用户重试。
 *
 * @param {string} userText
 * @param {AbortSignal} [signal]
 * @returns {AsyncIterable<string>}
 */
export async function* chat(userText, signal) {
  const text = String(userText || '').trim();
  if (!text) {
    throw new Error('对话内容为空。');
  }

  // 前置校验（在写入 store 之前）
  makeProvider({ requirePaper: true });

  const { paper, messages, conversationSummary, retrievedChunkIndices } = getState();
  const messagesWithUser = [
    ...messages,
    { role: /** @type {const} */ ('user'), content: text },
  ];
  setState({ messages: messagesWithUser });

  const provider = makeProvider({ requirePaper: true });
  const assembled = assemble({
    task: 'chat',
    paper,
    messages: messagesWithUser,
    templates: getPromptTemplates(),
    conversationSummary: conversationSummary?.text || null,
    retrievedChunkIndices,
  });

  // 累积模式：保存本轮检索选中的段落索引，供下一轮加分使用
  const newRetrievedIndices = getLastRetrievedIndices();
  if (newRetrievedIndices.length > 0) {
    // 合并去重：将新旧索引合并（不覆盖 store，在 setState 中原子更新）
    const merged = [...new Set([...retrievedChunkIndices, ...newRetrievedIndices])];
    setState({ retrievedChunkIndices: merged });
  }

  let assistantText = '';
  try {
    for await (const chunk of provider.chat(assembled, { signal })) {
      assistantText += chunk;
      yield chunk;
    }
  } catch (err) {
    // 流式中断/出错：不把残缺 assistant 文本入 store，让 UI 自行重试
    throw err;
  }

  // 成功结束：把完整 assistant 回复入 store
  if (assistantText) {
    const latest = getState().messages;
    setState({
      messages: [
        ...latest,
        { role: /** @type {const} */ ('assistant'), content: assistantText },
      ],
    });

    // 对话溢出时触发摘要压缩（阻塞等待，保证下次发送时摘要已就绪）
    await maybeSummarize();

    // 更新状态栏指示
    updateChatStatus();
  }
}

// =========================================================
// 对话摘要压缩
// =========================================================

/**
 * 将消息列表格式化为可读文本，供摘要 LLM 使用。
 * @param {Array<{ role: string, content: string }>} msgs
 * @returns {string}
 */
function formatMessagesForSummary(msgs) {
  return msgs
    .map((m) => {
      const label = m.role === 'user' ? '🧑 用户' : '🤖 AI';
      return `### ${label}\n${(m.content || '').trim()}`;
    })
    .join('\n\n');
}

/**
 * 检查并触发对话摘要压缩。
 * 当 store.messages 超过 SUMMARIZE_THRESHOLD 时，对溢出消息生成摘要，
 * 合并已有摘要后存入 store.conversationSummary。
 *
 * 增量模式：只压缩"上次已压缩位置"之后的新溢出消息，避免重复发送。
 * 摘要生成失败不抛错——下次发送时退化为无摘要模式（旧消息被滑窗丢弃）。
 *
 * @returns {Promise<void>}
 */
async function maybeSummarize() {
  const { messages, conversationSummary } = getState();

  if (messages.length <= SUMMARIZE_THRESHOLD) return;

  // 已压缩到的位置（无摘要时为 0）
  const prevUpTo = conversationSummary?.summarizedUpTo ?? 0;
  // 当前应压缩到的最远位置：总消息数 - 阈值（保证窗口内保留 SUMMARIZE_THRESHOLD 条完整消息）
  const overflowEnd = messages.length - SUMMARIZE_THRESHOLD;

  // 没有新增溢出消息，无需压缩
  if (overflowEnd <= prevUpTo) return;

  const newOverflow = messages.slice(prevUpTo, overflowEnd);
  if (newOverflow.length === 0) return;

  const prevSummary = conversationSummary?.text || '';
  const summaryPrompt = prevSummary
    ? `已有对话摘要：\n${prevSummary}\n\n请将以下新增对话合并到摘要中，输出一份完整的更新摘要：\n\n${formatMessagesForSummary(newOverflow)}`
    : `请为以下对话生成摘要：\n\n${formatMessagesForSummary(newOverflow)}`;

  try {
    const provider = makeProvider({ requirePaper: false });
    const newSummary = await provider.chatOnce(
      [
        { role: 'system', content: SUMMARIZE_CONVERSATION },
        { role: 'user', content: summaryPrompt },
      ],
      { stream: false },
    );

    const trimmed = (newSummary || '').trim();
    if (trimmed) {
      setState({
        conversationSummary: {
          text: trimmed,
          summarizedUpTo: overflowEnd,
        },
      });
    }
  } catch (err) {
    // 非致命：摘要失败时下次发送退化为普通滑窗（旧消息被丢弃）
    console.warn('[Summarize] 对话摘要生成失败，下次将退化为无摘要模式：', err);
  }
}

/**
 * 更新 chatStatus 状态栏文本，供 UI 展示三层上下文管理状态。
 */
function updateChatStatus() {
  const { retrievedChunkIndices, conversationSummary } = getState();
  const parts = [];

  if (retrievedChunkIndices.length > 0) {
    parts.push(`检索: ${retrievedChunkIndices.length} 段论文已加载`);
  }

  if (conversationSummary && conversationSummary.summarizedUpTo > 0) {
    parts.push(`摘要: ${conversationSummary.summarizedUpTo} 条消息已压缩`);
  }

  setState({
    chatStatus: parts.length > 0 ? { text: parts.join(' | ') } : null,
  });
}
