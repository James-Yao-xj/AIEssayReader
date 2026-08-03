/* =========================================================
 * src/ai/context.js
 *
 * 上下文装配（design.md §5 context 装配）：
 * - 装配顺序固定：GLOBAL_STYLE → 论文全文 → 任务模板（拼成单条 system）
 * - summarize/explainConcepts/critique：不走 messages 历史，
 *   只 [system, 单条 user 触发指令]
 * - chat：[system, ...最近 recentN 轮 messages]，滑窗裁剪：
 *   ① 默认最近 recentN*2 条（user+assistant 成对）
 *   ② 总字符数硬上限 MAX_TOTAL_CHARS，超限时继续丢最旧，保留 system
 *
 * token 估算：粗略按 chars/4，仅用于日志与决策，不发送给 API。
 * ========================================================= */

import {
  GLOBAL_STYLE,
  SUMMARIZE,
  EXPLAIN_CONCEPTS,
  CRITIQUE,
  TRANSLATE,
  CHAT,
} from './prompts.js';

/**
 * 总字符硬上限（system + messages 一并算）。
 * 100k 字符 ≈ 25k tokens，对 32k 上下文模型仍有余量。
 */
const MAX_TOTAL_CHARS = 100_000;

/**
 * 对话模式下，至少为 messages 保留的字符预算。
 * 确保论文再长也不会把用户消息挤掉。
 * 4000 字符 ≈ 1000 tokens，足够容纳一轮完整问答。
 */
const MIN_MESSAGE_BUDGET = 4_000;

/** 对话摘要压缩阈值：当 messages 超过此数量时，触发摘要压缩（默认 6 轮 × 2 = 12 条）。 */
export const SUMMARIZE_THRESHOLD = 12;

/**
 * 检索模式下论文内容的最大字符预算。
 * 占 MAX_TOTAL_CHARS 的 50%，保证 Message Windowing 有 40% 的独立空间。
 */
const RELEVANT_PAPER_MAX_CHARS = Math.floor(MAX_TOTAL_CHARS * 0.5);

/** 论文检索阈值：超过此长度的论文触发按需检索。与检索预算一致——能全量装入就不检索。 */
const PAPER_RETRIEVAL_THRESHOLD = RELEVANT_PAPER_MAX_CHARS;

/** 粗略 token 估算：英文 ~4 字符/token，中文偏多，这里统一按 4 估。 */
const CHARS_PER_TOKEN = 4;

/** @type {Record<string, string>} */
const TASK_TEMPLATES = {
  summarize: SUMMARIZE,
  explainConcepts: EXPLAIN_CONCEPTS,
  critique: CRITIQUE,
  translate: TRANSLATE,
  chat: CHAT,
};

/**
 * @typedef {'summarize' | 'explainConcepts' | 'critique' | 'translate' | 'chat'} Task
 */

/**
 * 装配 OpenAI messages 数组。
 *
 * 可通过 templates 参数传入自定义提示词（来自用户设置），为空/未传时回退到内置默认模板。
 *
 * @param {{
 *   task: Task,
 *   paper?: { fullText?: string } | null,
 *   messages?: Array<{ role: 'user' | 'assistant', content: string }>,
 *   recentN?: number,
 *   templates?: Partial<Record<Task, string>>,
 *   conversationSummary?: string | null,
 *   retrievedChunkIndices?: number[],
 * }} args
 * @returns {Array<{ role: 'system' | 'user', content: string }>}
 */
export function assemble({ task, paper, messages = [], recentN = 8, templates, conversationSummary, retrievedChunkIndices }) {
  // 自定义模板优先；仅空白视为"未提供"，回退到内置默认。
  const raw = templates?.[task];
  const taskTemplate =
    typeof raw === 'string' && raw.trim() ? raw.trim() : (TASK_TEMPLATES[task] || '');
  let paperText = paper?.fullText || '';

  // 对话模式 + 长论文：按用户提问检索最相关段落，而非塞入全文
  if (task === 'chat' && paperText.length > PAPER_RETRIEVAL_THRESHOLD && messages.length > 0) {
    const lastUser = lastUserMessage(messages);
    if (lastUser) {
      // 从当前提问 + 已有对话摘要中联合提取关键词，保持检索的上下文连贯性
      const summaryCtx = conversationSummary?.trim() || null;
      paperText = retrieveRelevantContent(paperText, lastUser, RELEVANT_PAPER_MAX_CHARS, retrievedChunkIndices || [], summaryCtx);
    }
  }

  let systemContent = buildSystem({ paperText, taskTemplate });

  if (task === 'chat') {
    // 注入对话历史摘要（如果存在）到 system 内容中，
    // 为 LLM 提供被滑窗裁剪掉的旧对话上下文。
    const summaryBlock = conversationSummary?.trim()
      ? '\n\n---\n\n# 对话历史摘要（已压缩）\n以下是此前对话的摘要，供你了解对话背景。其中提到的论文内容仍可参考：\n' +
        conversationSummary.trim()
      : '';

    if (summaryBlock) {
      systemContent += summaryBlock;
    }

    // 当论文过长挤占消息预算时，截断论文文本以保证对话空间
    if (systemContent.length > MAX_TOTAL_CHARS - MIN_MESSAGE_BUDGET) {
      // 计算非论文部分的开销（GLOBAL_STYLE + 引导语 + 分隔符 + taskTemplate + 摘要）
      const overhead = systemContent.length - paperText.length;
      const maxPaperChars = Math.max(0, MAX_TOTAL_CHARS - MIN_MESSAGE_BUDGET - overhead);
      const truncatedPaper =
        paperText.slice(0, maxPaperChars) +
        '\n\n[论文过长，已截断尾部以保留对话空间。若需讨论后半部分，请在左侧目录跳转到对应章节后重新追问。]';
      systemContent = buildSystem({ paperText: truncatedPaper, taskTemplate });
      // 截断后重新注入摘要，确保摘要不丢失
      if (summaryBlock) {
        systemContent += summaryBlock;
      }
    }
    const budget = Math.max(0, MAX_TOTAL_CHARS - systemContent.length);
    const recent = slideWindow(messages, recentN, budget);
    return [{ role: 'system', content: systemContent }, ...recent];
  }

  // 一次性任务：system + 一条 user 触发指令（OpenAI 要求至少 1 条 user）
  return [
    { role: 'system', content: systemContent },
    {
      role: 'user',
      content: '请按照上述任务说明，针对给定论文开始处理，用中文输出。',
    },
  ];
}

/**
 * 拼接 system：GLOBAL_STYLE → 论文全文 → 任务模板。
 * 即便用户后期改写任务模板，全局风格仍前置、不受影响。
 *
 * @param {{ paperText: string, taskTemplate: string }} args
 */
function buildSystem({ paperText, taskTemplate }) {
  /** @type {string[]} */
  const parts = [];
  parts.push(GLOBAL_STYLE);

  parts.push(
    '以下是论文内容，作为你后续回答的唯一依据。若论文为空，请直接告知用户"未加载论文"。',
  );
  if (paperText) {
    parts.push(paperText);
  } else {
    parts.push('（论文内容为空——用户可能尚未加载 PDF。）');
  }

  if (taskTemplate) {
    parts.push(taskTemplate);
  }

  return parts.join('\n\n---\n\n');
}

/**
 * 滑窗：取最近 recentN 轮（user+assistant 配对，即 recentN*2 条）；
 * 若总字符仍超 budget，则继续从最旧丢弃，保留尽可能多的近期对话。
 *
 * @param {Array<{ role: 'user' | 'assistant', content: string }>} messages
 * @param {number} recentN
 * @param {number} budget 字符预算（system 已扣减后剩余）
 * @returns {Array<{ role: 'user' | 'assistant', content: string }>}
 */
function slideWindow(messages, recentN, budget) {
  if (messages.length === 0) return [];

  const maxPairs = Math.max(0, Math.floor(recentN));
  const maxMessages = maxPairs * 2;
  // 从末尾取最多 maxMessages 条；同时尽量按 user/assistant 配对边界裁剪，
  // 避免把孤立的 assistant 留在窗口最前。
  let start = messages.length - maxMessages;
  if (start < 0) start = 0;
  // 若 start 落在 assistant 上（即第一条留下的是 assistant），向后推一格
  if (start > 0 && messages[start] && messages[start].role === 'assistant') {
    start += 1;
  }
  /** @type {typeof messages} */
  let picked = messages.slice(start);

  // 字符预算裁剪：从最旧开始丢弃，但至少保留最后一条消息（当前用户提问）
  let total = picked.reduce((s, m) => s + (m.content?.length || 0), 0);
  while (picked.length > 1 && total > budget) {
    const removed = picked.shift();
    if (!removed) break;
    total -= removed.content?.length || 0;
  }
  return picked;
}

// =========================================================
// 论文按需检索（长论文对话模式用）
// =========================================================

/** 上一次检索选中的段落索引（模块级变量，供 client.js 通过 getLastRetrievedIndices() 读取）。 */
let _lastRetrievedIndices = [];

/**
 * 返回上一次检索选中的段落索引，调用后清空。
 * 由 client.js 在 assemble() 之后调用，将索引写入 store 供下一轮累积使用。
 * @returns {number[]}
 */
export function getLastRetrievedIndices() {
  const idx = _lastRetrievedIndices;
  _lastRetrievedIndices = [];
  return idx;
}

/**
 * 取消息列表中最后一条 user 消息内容。
 * @param {Array<{ role: string, content: string }>} messages
 * @returns {string | null}
 */
function lastUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content;
  }
  return null;
}

/**
 * 从用户提问中提取检索关键词。
 * 中文用字符二元组，英文用 3+ 字母单词（过滤停用词）。
 * @param {string} text
 * @returns {string[]}
 */
function extractKeywords(text) {
  const terms = [];

  // 中文：2 字以上的连续汉字片段 → 滑窗取二元组
  const cnSegs = text.match(/[一-鿿]{2,}/g) || [];
  for (const seg of cnSegs) {
    for (let i = 0; i <= seg.length - 2; i++) {
      terms.push(seg.slice(i, i + 2));
    }
  }

  // 英文：3+ 字母单词，过滤停用词
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

/**
 * 根据用户提问从论文中检索最相关段落。
 *
 * 策略：
 *   ① 始终保留头部 5 段（摘要/引言）和尾部 3 段（结论），提供全局视野
 *   ② 对剩余段落做关键词匹配打分，高分优先入选
 *   ③ 按原文顺序拼接，末尾附提示告知用户检索情况
 *
 * @param {string} paperText 论文全文
 * @param {string} question 用户提问
 * @param {number} maxChars 论文部分最大字符数
 * @param {number[]} [boostIndices] 前几轮已检索的段落索引，获得加分（累积模式）
 * @param {string | null} [summaryCtx] 对话摘要文本，作为额外关键词来源（保持检索连贯）
 * @returns {string} 检索后的论文片段
 */
function retrieveRelevantContent(paperText, question, maxChars, boostIndices, summaryCtx) {
  // 按段落边界切分
  const chunks = paperText.split(/\n\s*\n/).filter((c) => c.trim().length > 30);
  if (chunks.length === 0) return paperText.slice(0, maxChars);

  // 从当前提问 + 对话摘要中联合提取关键词（摘要提供上下文锚点）
  const keywordSource = summaryCtx ? `${question}\n${summaryCtx}` : question;
  const keywords = extractKeywords(keywordSource);
  const boostSet = new Set(boostIndices || []);

  // 始终保留：头部（摘要/引言上下文）+ 尾部（结论/讨论）
  const HEAD_COUNT = 5;
  const TAIL_COUNT = 3;
  const always = new Set();
  for (let i = 0; i < Math.min(HEAD_COUNT, chunks.length); i++) always.add(i);
  for (let i = Math.max(0, chunks.length - TAIL_COUNT); i < chunks.length; i++) always.add(i);

  const selected = new Set(always);
  let totalChars = 0;
  for (const i of always) totalChars += chunks[i].length;

  // 对非保留段落按关键词匹配度打分（累积模式：前几轮检索过的段落额外加分）
  if (keywords.length > 0) {
    const scored = chunks
      .map((chunk, i) => {
        if (always.has(i)) return { index: i, score: -1 };
        let score = 0;
        const lower = chunk.toLowerCase();
        for (const kw of keywords) {
          const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp(escaped, 'gi');
          const matches = lower.match(re);
          if (matches) score += matches.length;
        }
        // 累积模式：前几轮已检索的段落 +3 分（≈3 次关键词命中），使其更不容易被挤出
        if (score > 0 && boostSet.has(i)) {
          score += 3;
        }
        return { index: i, score };
      })
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score);

    for (const { index } of scored) {
      const len = chunks[index].length;
      if (totalChars + len > maxChars) break;
      selected.add(index);
      totalChars += len;
    }
  }

  // 记录本次选中的段落索引，供下一轮累积
  _lastRetrievedIndices = [...selected];

  // 按原文顺序拼接
  const result = [...selected]
    .sort((a, b) => a - b)
    .map((i) => chunks[i])
    .join('\n\n');

  const skipped = chunks.length - selected.size;
  const notice =
    skipped > 0
      ? `\n\n[论文共 ${chunks.length} 段，已根据你的提问自动检索最相关的 ${selected.size} 段（跳过 ${skipped} 段）。若需讨论未载入的章节，请在左侧目录跳转到对应位置后选中文字再追问。]`
      : '';

  return result + notice;
}

/**
 * 粗略 token 估算（仅用于日志/调试，不参与请求）。
 * @param {string} text
 */
export function estimateTokens(text) {
  return Math.ceil((text || '').length / CHARS_PER_TOKEN);
}

/** 暴露常量给测试/调试用 */
export const LIMITS = {
  MAX_TOTAL_CHARS,
  CHARS_PER_TOKEN,
};
