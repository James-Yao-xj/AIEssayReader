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
 * - Validate the model endpoint and paper before each request.
 * ========================================================= */

import { getState, setState } from '../state/store.js';
import { createProvider } from './openai.js';
import { planContext, SUMMARIZE_THRESHOLD, countMessagesTokens, trimToTokenBudget } from './context.js';
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
  const plan = planRequest({ task, paper, messages: [], templates: getPromptTemplates() });
  updateChatStatus(plan.stats, task);
  yield* provider.chat(plan.messages, { signal });
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
  signal?.throwIfAborted();
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
  const provider = makeProvider({ requirePaper: true });
  const plan = planRequest({
    task: 'chat',
    paper,
    messages: messagesWithUser,
    templates: getPromptTemplates(),
    conversationSummary: conversationSummary?.text || null,
    summarizedUpTo: conversationSummary?.summarizedUpTo || 0,
    retrievedChunkIndices,
  });

  setState({ messages: messagesWithUser });

  setState({ retrievedChunkIndices: plan.retrievedIndices });
  updateChatStatus(plan.stats, 'chat');

  let assistantText = '';
  let completed = false;
  try {
    for await (const chunk of provider.chat(plan.messages, { signal })) {
      signal?.throwIfAborted();
      if (getState().paper !== paper || getState().messages !== messagesWithUser) return;
      assistantText += chunk;
      yield chunk;
    }
    signal?.throwIfAborted();
    completed = true;
  } finally {
    // Remove failed turns so a retry does not duplicate the question.
    if (!completed && getState().paper === paper && getState().messages === messagesWithUser) {
      setState({ messages, retrievedChunkIndices });
    }
  }

  if (getState().paper !== paper || getState().messages !== messagesWithUser) return;

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
    const compressionNote = await maybeSummarize(signal);
    if (getState().paper !== paper || signal?.aborted) return;

    // 更新状态栏指示
    updateChatStatus(plan.stats, 'chat', compressionNote);
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
async function maybeSummarize(signal) {
  const { paper, messages, conversationSummary } = getState();
  const overflowEnd = Math.max(0, messages.length - SUMMARIZE_THRESHOLD);
  const prevUpTo = Math.max(0, Math.min(messages.length, Math.floor((conversationSummary?.summarizedUpTo || 0) / 2) * 2));
  if (overflowEnd <= prevUpTo) return '';

  // One bounded batch per turn limits request cost. Advance only whole pairs.
  const budget = Math.min(8000, Math.floor(getBudgetTokens() * 0.9));
  const previous = trimToTokenBudget(conversationSummary?.text || '', 1200);
  const batch = [];
  let end = prevUpTo;
  const buildMessages = (items) => [
    { role: 'system', content: SUMMARIZE_CONVERSATION },
    { role: 'user', content: `已有对话摘要：\n${previous}\n\n请合并以下完整对话，输出更新摘要：\n${formatMessagesForSummary(items)}` },
  ];
  while (end + 2 <= overflowEnd) {
    const pair = messages.slice(end, end + 2);
    if (pair[0].role !== 'user' || pair[1].role !== 'assistant') break;
    const candidate = [...batch, ...pair];
    if (countMessagesTokens(buildMessages(candidate)) > budget) break;
    batch.push(...pair);
    end += 2;
  }
  if (!batch.length) return '摘要暂缓：旧对话单轮超过压缩预算';

  try {
    const provider = makeProvider({ requirePaper: false });
    const result = await provider.chatOnce(buildMessages(batch), { stream: false, signal });
    const text = trimToTokenBudget(result.trim(), 1200);
    if (text && !signal?.aborted && getState().paper === paper && getState().messages === messages) {
      setState({ conversationSummary: { text, summarizedUpTo: end } });
    }
    return end < overflowEnd ? '摘要分批处理中' : '';
  } catch (err) {
    console.warn('[Summarize] Conversation compression failed:', err);
    return '摘要失败：本轮仅使用预算内历史';
  }
}

/** Return the configured estimated input limit for text requests. */
function getBudgetTokens() {
  return getState().settings.reading.contextTokens ?? 24000;
}

/** Plan a request before mutating history, and report admission errors. */
function planRequest(args) {
  try {
    return planContext({ ...args, budgetTokens: getBudgetTokens() });
  } catch (err) {
    setState({ chatStatus: { text: `上下文未发送：${err.message}` } });
    throw err;
  }
}

/** Show coverage of the actual request, rather than accumulated retrievals. */
function updateChatStatus(stats, task, note = '') {
  const labels = { chat: '对话', summarize: '总结', explainConcepts: '概念', critique: '质疑', translate: '翻译' };
  const parts = [
    `${labels[task]}：估算 ${stats.estimatedTokens}/${stats.budgetTokens} tokens`,
    `论文 ${stats.paperChunks}/${stats.totalPaperChunks} 段`,
    `发送 ${stats.historyMessages} 条对话`,
  ];
  if (stats.omittedMessages) parts.push(`省略 ${stats.omittedMessages} 条原始历史`);
  if (note) parts.push(note);
  setState({ chatStatus: { text: parts.join(' | ') } });
}
