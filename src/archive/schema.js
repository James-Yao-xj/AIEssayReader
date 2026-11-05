const TASKS = ['summarize', 'explainConcepts', 'critique', 'translate'];
const STATUSES = ['complete', 'interrupted', 'failed', 'generating'];
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = () => { throw new Error('文件格式不正确：存档字段类型无效。'); };

/** Validate a versioned archive and copy only supported application data. */
export function parseArchive(data) {
  if (!isObject(data) || (!data.title && !data.paperMeta && !data.paper)) fail();
  if (data.schemaVersion !== undefined && ![1, 2].includes(data.schemaVersion)) fail();
  if (data.title !== undefined && typeof data.title !== 'string') fail();
  const source = data.paper;
  if (source !== undefined && source !== null && !isObject(source)) fail();
  const meta = source?.meta ?? data.paperMeta ?? {};
  if (!isObject(meta)) fail();
  for (const key of ['name', 'title', 'fingerprint']) {
    if (meta[key] !== undefined && typeof meta[key] !== 'string') fail();
  }
  if (meta.nPages !== undefined && (!Number.isInteger(meta.nPages) || meta.nPages < 0)) fail();
  if (meta.authors !== undefined && (!Array.isArray(meta.authors) || !meta.authors.every((v) => typeof v === 'string'))) fail();
  const paperMeta = { name: source?.name ?? meta.name ?? '', title: meta.title, authors: meta.authors, nPages: meta.nPages ?? 0 };
  if (typeof paperMeta.name !== 'string') fail();
  const fullText = source?.fullText ?? '';
  const pages = source?.pages ?? [];
  const fingerprint = source?.fingerprint ?? meta.fingerprint;
  if (typeof fullText !== 'string' || (fingerprint !== undefined && typeof fingerprint !== 'string')) fail();
  if (!Array.isArray(pages) || !pages.every((page) => isObject(page) && Number.isInteger(page.pageNum) && page.pageNum > 0 && typeof page.text === 'string' && (page.error === undefined || typeof page.error === 'string'))) fail();
  if (source?.failedPages !== undefined && (!Array.isArray(source.failedPages) || !source.failedPages.every((page) => Number.isInteger(page) && page > 0))) fail();
  const messages = data.messages ?? [];
  if (!Array.isArray(messages) || !messages.every((m) => isObject(m) && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')) fail();
  const results = data.savedResults ?? {};
  const statuses = data.resultStatuses ?? {};
  if (!isObject(results) || !Object.values(results).every((v) => typeof v === 'string')) fail();
  if (!isObject(statuses) || !Object.values(statuses).every((v) => STATUSES.includes(v))) fail();
  if (data.createdAt !== undefined && (typeof data.createdAt !== 'string' || !Number.isFinite(Date.parse(data.createdAt)))) fail();
  const savedResults = {};
  const resultStatuses = {};
  for (const key of TASKS) {
    if (Object.hasOwn(results, key)) savedResults[key] = results[key];
    if (Object.hasOwn(statuses, key)) resultStatuses[key] = statuses[key];
  }
  let conversationSummary = null;
  if (data.conversationSummary != null) {
    const summary = data.conversationSummary;
    if (!isObject(summary) || typeof summary.text !== 'string' || !Number.isInteger(summary.summarizedUpTo) || summary.summarizedUpTo < 0 || summary.summarizedUpTo > messages.length) fail();
    conversationSummary = { text: summary.text, summarizedUpTo: summary.summarizedUpTo };
    if (summary.pending !== undefined) {
      const pending = summary.pending;
      if (!isObject(pending) || !Number.isInteger(pending.messageIndex) || !Number.isInteger(pending.offset) || pending.messageIndex < summary.summarizedUpTo || pending.messageIndex >= messages.length || pending.offset < 0 || pending.offset > messages[pending.messageIndex].content.length) fail();
      conversationSummary.pending = { messageIndex: pending.messageIndex, offset: pending.offset };
    }
  }
  let segmentedTask = null;
  if (data.segmentedTask != null) {
    const progress = data.segmentedTask;
    if (!isObject(progress) || !TASKS.includes(progress.task) || !STATUSES.includes(progress.status) || !['parts', 'reduce', 'synthesis'].includes(progress.stage)) fail();
    for (const key of ['id', 'paperKey', 'configKey', 'result']) if (typeof progress[key] !== 'string') fail();
    if (!Number.isInteger(progress.total) || progress.total < 1 || !Number.isInteger(progress.nextIndex) || progress.nextIndex < 0 || progress.nextIndex > progress.total || !Array.isArray(progress.outputs) || !progress.outputs.every((value) => typeof value === 'string') || progress.outputs.length !== progress.nextIndex) fail();
    for (const key of ['reduceInputs', 'reduceOutputs']) {
      if (progress[key] !== undefined && (!Array.isArray(progress[key]) || !progress[key].every((value) => typeof value === 'string'))) fail();
    }
    for (const key of ['reduceIndex', 'reduceLevel']) {
      if (progress[key] !== undefined && (!Number.isInteger(progress[key]) || progress[key] < 0)) fail();
    }
    if ((progress.reduceLevel ?? 0) > 3 || (progress.reduceOutputs?.length ?? 0) !== (progress.reduceIndex ?? 0)) fail();
    if (progress.error !== undefined && typeof progress.error !== 'string') fail();
    segmentedTask = Object.fromEntries(['id', 'task', 'paperKey', 'configKey', 'nextIndex', 'outputs', 'status', 'stage', 'result', 'total', 'error', 'reduceInputs', 'reduceOutputs', 'reduceIndex', 'reduceLevel'].filter((key) => progress[key] !== undefined).map((key) => [key, structuredClone(progress[key])]));
  }
  return {
    schemaVersion: 2,
    title: data.title || meta.title || '导入的存档',
    paperMeta,
    paper: { name: paperMeta.name, meta: { title: meta.title, authors: meta.authors, nPages: paperMeta.nPages }, fullText,
      pages: pages.map(({ pageNum, text, error }) => ({ pageNum, text, ...(error === undefined ? {} : { error }) })), ...(source?.failedPages === undefined ? {} : { failedPages: [...source.failedPages] }), ...(fingerprint === undefined ? {} : { fingerprint }) },
    messages: messages.map((message) => {
      const result = { role: message.role, content: message.content };
      if (message.status !== undefined) {
        if (!STATUSES.includes(message.status)) fail();
        result.status = message.status;
      }
      for (const key of ['id', 'error', 'createdAt']) {
        if (message[key] !== undefined) {
          if (typeof message[key] !== 'string') fail();
          result[key] = message[key];
        }
      }
      return result;
    }),
    savedResults, resultStatuses, conversationSummary,
    segmentedTask,
    createdAt: data.createdAt ?? new Date().toISOString(),
  };
}
