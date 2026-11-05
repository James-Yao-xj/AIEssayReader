/** Build bounded model input and report the context sent with each request. */
import { GLOBAL_STYLE, SUMMARIZE, EXPLAIN_CONCEPTS, CRITIQUE, TRANSLATE, CHAT } from './prompts.js';

export const SUMMARIZE_THRESHOLD = 12;
const TASK_TEMPLATES = { summarize: SUMMARIZE, explainConcepts: EXPLAIN_CONCEPTS,
  critique: CRITIQUE, translate: TRANSLATE, chat: CHAT };
const DEFAULT_BUDGET = 24_000;
// Retain these legacy limits for callers that inspect the old character cap.
export const LIMITS = { MAX_TOTAL_CHARS: 100_000, CHARS_PER_TOKEN: 3 };
let lastRetrievedIndices = [];

/** Estimate tokens conservatively. This is not a model-specific tokenizer. */
export function estimateTokens(text) {
  let ascii = 0;
  let other = 0;
  for (const character of text || '') {
    if (character.codePointAt(0) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 3) + other * 2;
}

/** Include role and message framing in the estimated request size. */
export function countMessagesTokens(messages) {
  return 2 + messages.reduce((total, message) => total + 6 + estimateTokens(message.content), 0);
}

/** Return a complete Unicode prefix that fits an estimated token allowance. */
export function trimToTokenBudget(text, maxTokens) {
  let ascii = 0;
  let other = 0;
  let end = 0;
  for (const character of text) {
    if (character.codePointAt(0) < 128) ascii++;
    else other++;
    if (Math.ceil(ascii / 3) + other * 2 > maxTokens) break;
    end += character.length;
  }
  return text.slice(0, end);
}

/** Split long paragraphs without cutting Unicode characters. */
function paperChunks(text) {
  return text.split(/\n\s*\n/).filter((part) => part.trim()).flatMap((part) => {
    const chunks = [];
    let offset = 0;
    while (offset < part.length) {
      const chunk = trimToTokenBudget(part.slice(offset), 600);
      chunks.push(chunk);
      offset += chunk.length;
    }
    return chunks;
  });
}

/** Return stable page-local citation chunks in reading order. */
export function chunkPaper(paper) {
  const pages = paper?.pages?.length ? paper.pages : [{ pageNum: 1, text: paper?.fullText || '' }];
  return pages.flatMap((page, index) => paperChunks(page.text).map((text, chunk) => ({
    id: `p${page.pageNum || index + 1}-c${chunk + 1}`, pageNum: page.pageNum || index + 1, text,
  })));
}

/** Resolve an exact citation against the current document, including old turns. */
export function resolveCitation(paper, id) {
  return chunkPaper(paper).find(chunk => chunk.id === id) || null;
}

/** Build the system message with the global style before the task template. */
function buildSystem(paperText, template, summary) {
  const parts = [GLOBAL_STYLE,
    '以下是论文内容，作为回答的依据。引用必须使用实际载入片段的 [pN-cM] 标识，不得编造标识或引用未载入内容。',
    paperText || '（本轮未载入论文片段。）', template];
  if (summary) parts.push('# 已压缩的对话摘要\n' + summary);
  return parts.join('\n\n---\n\n');
}

/**
 * Plan one request without changing shared state.
 *
 * Args:
 *   args: Task, paper, history, templates, summary and estimated input budget.
 *     summarizedUpTo is an exclusive index into the complete history array.
 *     budgetTokens includes a ten percent reserve for estimation uncertainty.
 *
 * Returns:
 *   Messages, coverage statistics and indices into the bounded paper chunks.
 *
 * Throws:
 *   Error: A complete question, template or full-paper task cannot fit.
 */
export function planContext({ task, paper, messages = [], recentN = 8, templates,
  conversationSummary, retrievedChunkIndices = [], summarizedUpTo = 0,
  pendingSummary, budgetTokens = DEFAULT_BUDGET }) {
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) {
    throw new Error('上下文预算无效，请在设置中填写正数。');
  }
  const limit = Math.floor(budgetTokens * 0.9);
  const custom = templates?.[task];
  const template = typeof custom === 'string' && custom.trim() ? custom.trim() : TASK_TEMPLATES[task];
  if (!template) throw new Error('未知的 AI 任务。');
  const evidence = chunkPaper(paper);
  const chunks = evidence.map(chunk => `[${chunk.id}]\n${chunk.text}`);
  const text = chunks.join('\n\n');
  const summary = task === 'chat' && conversationSummary
    ? trimToTokenBudget(conversationSummary.trim(), Math.min(1200, Math.floor(limit * 0.1))) : '';
  const system = (content) => ({ role: 'system', content: buildSystem(content, template, summary) });
  const finish = (selectedMessages, indices) => ({
    messages: selectedMessages,
    stats: { estimatedTokens: countMessagesTokens(selectedMessages), budgetTokens,
      paperChunks: indices.length, totalPaperChunks: chunks.length,
      historyMessages: task === 'chat' ? selectedMessages.length - 1 : 0,
      omittedMessages: task === 'chat' ? messages.length - (selectedMessages.length - 1) : 0 },
    retrievedIndices: indices,
    evidence: indices.map(index => evidence[index]),
  });

  // Full-paper tasks must never silently change into partial-paper tasks.
  if (task !== 'chat') {
    const request = [system(text), { role: 'user', content: '请按照任务说明处理给定论文，用中文输出。' }];
    if (countMessagesTokens(request) > limit) {
      throw new Error('论文全文或提示词超过上下文预算。请提高设置中的上下文预算（须在模型支持范围内），或改用对话提问检索相关片段。');
    }
    return finish(request, chunks.map((_, index) => index));
  }

  // Reserve the complete current question before history or paper selection.
  const latest = messages.at(-1);
  const current = latest ? [latest] : [];
  if (countMessagesTokens([system('')]) > limit) {
    throw new Error('提示词超过上下文预算，请缩短自定义提示词或提高预算后重试。');
  }
  const fixedCost = countMessagesTokens([system(''), ...current]);
  if (fixedCost > limit) {
    throw new Error('当前提问过长，超过上下文预算，请缩短提问或提高预算后重试。');
  }
  const summaryEnd = summary && Number.isFinite(summarizedUpTo)
    ? Math.min(Math.max(0, Math.floor(summarizedUpTo)), Math.max(0, messages.length - 1)) : 0;
  const unsummarized = messages.slice(summaryEnd, latest ? -1 : undefined)
    .map((message, index) => pendingSummary?.messageIndex === summaryEnd + index
      ? { ...message, content: message.content.slice(pendingSummary.offset) } : message)
    .filter(message => message.content && (message.role !== 'assistant' || !message.status || message.status === 'complete'));
  const recentLimit = Math.max(0, Math.floor(recentN) * 2 - current.length);
  let history = recentLimit ? unsummarized.slice(-recentLimit) : [];
  const historyBudget = Math.floor((limit - fixedCost) * 0.4);
  while (history.length && (countMessagesTokens(history) - 2 > historyBudget || history[0].role === 'assistant')) {
    history = history.slice(1);
  }
  const turns = [...history, ...current];
  const full = [system(text), ...turns];
  if (countMessagesTokens(full) <= limit) return finish(full, chunks.map((_, index) => index));

  // Select whole bounded chunks. Head, tail and scored evidence share one cap.
  const keywords = extractKeywords(`${latest?.content || ''}\n${summary}`);
  const previous = new Set(retrievedChunkIndices);
  const scored = chunks.map((chunk, index) => {
    const lower = chunk.toLowerCase();
    let score = keywords.reduce((sum, word) => sum + (lower.split(word).length - 1), 0);
    if (score && previous.has(index)) score += 3;
    return { index, score };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const priority = [...new Set([
    ...chunks.slice(0, 5).map((_, index) => index),
    ...chunks.slice(-3).map((_, index, tail) => chunks.length - tail.length + index),
    ...scored.map(({ index }) => index),
  ])];
  const selected = [];
  const selectionText = (indices) => indices.slice().sort((a, b) => a - b).map((index) => chunks[index]).join('\n\n');
  // The notice is budgeted before any chunks are admitted.
  const notice = '[本轮仅载入部分论文片段；未载入内容不代表论文中不存在。]';
  // Summed fragment costs overestimate joined text. Tokenize each chunk once.
  let paperAllowance = limit - countMessagesTokens([system(''), ...turns]) - estimateTokens(notice) - 4;
  const costs = chunks.map((chunk) => estimateTokens(chunk) + 2);
  for (const index of priority) {
    if (costs[index] > paperAllowance) continue;
    selected.push(index);
    paperAllowance -= costs[index];
  }
  const selectedText = selectionText(selected);
  const request = [system(selectedText ? selectedText + '\n\n' + notice : ''), ...turns];
  if (countMessagesTokens(request) > limit) throw new Error('上下文预算不足，请提高预算后重试。');
  return finish(request, selected.sort((a, b) => a - b));
}

/** Compatibility wrapper for callers that need only the messages array. */
export function assemble(args) {
  lastRetrievedIndices = [];
  const plan = planContext(args);
  lastRetrievedIndices = plan.retrievedIndices;
  return plan.messages;
}

/** Read and clear retrieval indices from the compatibility wrapper. */
export function getLastRetrievedIndices() {
  const result = lastRetrievedIndices;
  lastRetrievedIndices = [];
  return result;
}

function extractKeywords(text) {
  const terms = [];

  // Use character pairs for Chinese query terms.
  const cnSegs = text.match(/[一-鿿]{2,}/g) || [];
  for (const seg of cnSegs) {
    for (let i = 0; i <= seg.length - 2; i++) {
      terms.push(seg.slice(i, i + 2));
    }
  }

  // Remove common English words from query terms.
  const STOP = new Set([
    'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have',
    'were', 'their', 'what', 'when', 'which', 'about', 'than', 'them',
    'also', 'into', 'more', 'some', 'such', 'only', 'other', 'over',
    'very', 'your', 'are', 'was', 'its', 'not', 'can', 'all', 'has',
    'been', 'will', 'would', 'could', 'should', 'may', 'but', 'our',
  ]);
  const enWords = text.match(/[a-zA-Z]{3,}/g) || [];
  for (const w of enWords) {
    if (!STOP.has(w.toLowerCase())) {
      terms.push(w.toLowerCase());
    }
  }

  return [...new Set(terms)].slice(0, 20);
}
